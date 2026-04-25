import { StateManager } from './core/state';
import { AgentRunner, AgentType, resolveAgentBackend, resolveConfiguredBackend } from './core/agent';
import { appendTaskEvent } from './core/events';
import { ConfigManager } from './config/manager';
import { bootstrapWorktreeDeps } from './core/bootstrap';
import { finalizeTask, markTaskReadyToFinalize } from './core/scheduler';
import {
  detectCompletionSignals,
  detectCurrentWorktreeEvidence,
  hasObjectiveProgressEvidence,
  shouldTreatNonZeroExitAsSuccess,
} from './core/soft-success';
import { createWorkerLeaseUpdate, startWorkerLeaseHeartbeat } from './core/worker-heartbeat';
import { detectStagnation, loadTaskPRD, saveTaskPRD } from './utils/helpers';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { StoryProgress, StoryStatus, Task } from './types/task';

async function runWorker(taskId: string) {
  console.log(`[Worker] Starting worker for task ${taskId}`);

  const stateManager = new StateManager();
  const configManager = new ConfigManager();
  const task = await stateManager.loadTask(taskId);

  if (!task) {
    console.error(`[Worker] Task ${taskId} not found`);
    process.exit(1);
  }

  console.log(`[Worker] Task loaded: ${task.id}`);
  console.log(`[Worker] PRD path: ${task.prdPath}`);
  console.log(`[Worker] Worktree: ${task.worktree}`);
  console.log(`[Worker] Agent: ${task.agent}`);

  const backend = task.backend
    ? resolveAgentBackend(task.backend)
    : resolveConfiguredBackend(configManager);

  if (task.backend !== backend) {
    task.backend = backend;
    await stateManager.updateTask(task.id, { backend });
  }

  console.log(`[Worker] Backend: ${backend}`);
  const runner = new AgentRunner();
  let shuttingDown = false;
  const handleTerminationSignal = (signal: 'SIGINT' | 'SIGTERM') => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`[Worker] Received ${signal}, stopping active agent...`);
    runner.stop();

    const exitCode = signal === 'SIGINT' ? 130 : 143;
    process.exitCode = exitCode;
    const exitTimer = setTimeout(() => process.exit(exitCode), 0);
    exitTimer.unref?.();
  };
  const onSigint = () => handleTerminationSignal('SIGINT');
  const onSigterm = () => handleTerminationSignal('SIGTERM');

  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  try {
    if (task.worktree) {
      bootstrapWorktreeDeps(task.worktree, {
        repoPath: task.repoPath,
        logPath: task.logPath,
      });
    }

    console.log(`[Worker] Parsing PRD from ${task.prdPath}`);
    const prd = loadTaskPRD(task);
    console.log(`[Worker] PRD parsed: ${prd.title}`);
    console.log(`[Worker] User stories: ${prd.userStories.length}`);
    const maxStoryAttempts = resolveMaxStoryAttempts(configManager);

    for (const us of prd.userStories) {
      if (task.completedUS.includes(us.id)) {
        console.log(`[Worker] Skipping completed User Story: ${us.id}`);
        continue;
      }

      let storyPassed = false;
      let lastStoryError = getStoryProgress(task, us.id)?.lastError;

      while (!storyPassed && getStoryAttempts(task, us.id) < maxStoryAttempts) {
        const previousStoryProgress = getStoryProgress(task, us.id);
        task.currentUS = us.id;
        const storyStartedAt = Date.now();
        const attempt = getStoryAttempts(task, us.id) + 1;
        task.storyProgress = upsertStoryProgress(task, us.id, {
          status: 'in_progress',
          attempts: attempt,
          historyMessage: `Started attempt ${attempt}`,
          updatedAt: storyStartedAt,
        });
        await stateManager.updateTask(task.id, {
          currentUS: us.id,
          storyProgress: task.storyProgress,
          ...createWorkerLeaseUpdate(configManager),
        });

        console.log(`Running User Story: ${us.id} - ${us.title} (attempt ${attempt}/${maxStoryAttempts})`);
        appendTaskEvent(task, {
          type: 'story_attempt_started',
          storyId: us.id,
          message: `Started ${us.id} attempt ${attempt}/${maxStoryAttempts}`,
          data: { attempt, maxStoryAttempts },
        });

        const baselineState = captureProgressBaseline(task.worktree);
        const storyForAttempt = lastStoryError
          ? {
              ...us,
              description: `${us.description}\n\nRepair context from Ralph: ${lastStoryError}`,
            }
          : us;

        const heartbeat = startWorkerLeaseHeartbeat(task.id, stateManager, configManager, { logger: console });
        const result = await runner.runUserStory(
          storyForAttempt,
          task.worktree,
          task.agent as AgentType,
          task.logPath,
          backend,
          {
            sessionId: task.sessionId,
            threadId: task.threadId,
          }
        ).finally(() => heartbeat.stop());

        let continuationStateChanged = false;
        if (result.sessionId && result.sessionId !== task.sessionId) {
          task.sessionId = result.sessionId;
          continuationStateChanged = true;
        }
        if (result.threadId && result.threadId !== task.threadId) {
          task.threadId = result.threadId;
          continuationStateChanged = true;
        }
        if (continuationStateChanged) {
          await stateManager.updateTask(task.id, {
            sessionId: task.sessionId,
            threadId: task.threadId,
            ...createWorkerLeaseUpdate(configManager),
          });
        }

        let progressDetected = detectProgress(
          task.worktree,
          task.logPath,
          baselineState
        );
        let hasObjectiveEvidence = hasObjectiveProgressEvidence(progressDetected);
        const reusedRepairProgress = !hasObjectiveEvidence
          ? reuseExistingStoryEvidenceForRepair({
              task,
              storyId: us.id,
              previousStoryProgress,
              lastStoryError,
              resultSuccess: result.success,
              output: result.output,
            })
          : null;

        if (reusedRepairProgress) {
          progressDetected = reusedRepairProgress;
          hasObjectiveEvidence = true;
        }

        task.loopCount++;
        task.lastFilesChanged = progressDetected.filesChanged;

        if (hasObjectiveEvidence) {
          task.consecutiveNoProgress = 0;
          task.lastProgressTime = Date.now();
          console.log(`[Worker] Progress detected: ${progressDetected.reason}`);
        } else {
          task.consecutiveNoProgress++;
          console.log(`[Worker] No progress detected (consecutive: ${task.consecutiveNoProgress})`);
        }

        if (!result.success) {
          task.consecutiveErrors++;
          task.lastError = result.output.slice(-500);
        } else {
          task.consecutiveErrors = 0;
          task.lastError = undefined;
        }

        await stateManager.updateTask(task.id, {
          loopCount: task.loopCount,
          lastFilesChanged: task.lastFilesChanged,
          consecutiveNoProgress: task.consecutiveNoProgress,
          consecutiveErrors: task.consecutiveErrors,
          lastProgressTime: task.lastProgressTime,
          lastError: task.lastError,
          storyProgress: task.storyProgress,
          ...createWorkerLeaseUpdate(configManager),
        });

        const configuredStagnationTimeoutSeconds = Number(configManager.get('runner.stagnationTimeout'));
        const stagnationCheck = detectStagnation(task, {
          timeoutMs: Number.isFinite(configuredStagnationTimeoutSeconds) && configuredStagnationTimeoutSeconds > 0
            ? configuredStagnationTimeoutSeconds * 1000
            : undefined,
        });
        if (stagnationCheck.isStagnant) {
          console.error(`Stagnation detected: ${stagnationCheck.reason}`);
          await finalizeTask(task, 'stagnant', { stateManager });
          process.exit(1);
        }

        if (!result.success) {
          const softSuccess = shouldTreatNonZeroExitAsSuccess({
            output: result.output,
            progress: progressDetected,
          });

          if (softSuccess.shouldTreatAsSuccess) {
            console.log(`[Worker] Treating non-zero exit as soft success: ${softSuccess.reason}`);
            task.consecutiveErrors = 0;
            task.lastError = undefined;
            await stateManager.updateTask(task.id, {
              consecutiveErrors: task.consecutiveErrors,
              lastError: task.lastError,
              ...createWorkerLeaseUpdate(configManager),
            });
          } else {
            lastStoryError = result.output.slice(-500);
            const hasAttemptsLeft = attempt < maxStoryAttempts;
            task.storyProgress = upsertStoryProgress(task, us.id, {
              status: hasAttemptsLeft ? 'needs_repair' : 'failed',
              lastError: lastStoryError,
              historyMessage: lastStoryError,
              updatedAt: Date.now(),
            });
            await stateManager.updateTask(task.id, {
              storyProgress: task.storyProgress,
              lastError: lastStoryError,
              ...createWorkerLeaseUpdate(configManager),
            });

            if (hasAttemptsLeft) {
              appendTaskEvent(task, {
                type: 'story_attempt_needs_repair',
                storyId: us.id,
                message: lastStoryError,
                data: { attempt },
              });
              console.log(`[Worker] Retrying User Story ${us.id} after failed attempt`);
              continue;
            }

            appendTaskEvent(task, {
              type: 'story_failed',
              storyId: us.id,
              status: 'failed',
              message: lastStoryError,
              data: { attempt },
            });
            console.error(`Failed to complete User Story: ${us.id}`);
            await finalizeTask(task, 'failed', { stateManager });
            process.exit(1);
          }
        }

        if (!hasObjectiveEvidence) {
          lastStoryError = `Agent reported success for ${us.id}, but Ralph found no objective diff or commit evidence`;
          console.error(lastStoryError);
          const hasAttemptsLeft = attempt < maxStoryAttempts;
          task.lastError = lastStoryError;
          task.storyProgress = upsertStoryProgress(task, us.id, {
            status: hasAttemptsLeft ? 'needs_repair' : 'failed',
            lastError: lastStoryError,
            historyMessage: lastStoryError,
            updatedAt: Date.now(),
          });
          await stateManager.updateTask(task.id, {
            lastError: lastStoryError,
            storyProgress: task.storyProgress,
            ...createWorkerLeaseUpdate(configManager),
          });

          if (hasAttemptsLeft) {
            appendTaskEvent(task, {
              type: 'story_attempt_needs_repair',
              storyId: us.id,
              message: lastStoryError,
              data: { attempt },
            });
            console.log(`[Worker] Retrying User Story ${us.id} after missing objective evidence`);
            continue;
          }

          appendTaskEvent(task, {
            type: 'story_failed',
            storyId: us.id,
            status: 'failed',
            message: lastStoryError,
            data: { attempt },
          });
          await finalizeTask(task, 'failed', { stateManager });
          process.exit(1);
        }

        if (!task.completedUS.includes(us.id)) {
          task.completedUS.push(us.id);
        }
        us.passes = true;
        task.storyProgress = upsertStoryProgress(task, us.id, {
          status: 'passed',
          lastEvidence: progressDetected.reason,
          lastError: undefined,
          historyMessage: progressDetected.reason,
          updatedAt: Date.now(),
        });
        saveTaskPRD(task, prd);
        await stateManager.updateTask(task.id, {
          completedUS: task.completedUS,
          storyProgress: task.storyProgress,
          ...createWorkerLeaseUpdate(configManager),
        });
        appendTaskEvent(task, {
          type: 'story_passed',
          storyId: us.id,
          message: progressDetected.reason,
          data: {
            filesChanged: progressDetected.filesChanged,
            newCommits: progressDetected.newCommits,
            reusedExistingEvidence: Boolean(reusedRepairProgress),
          },
        });
        storyPassed = true;
      }
    }

    await markTaskReadyToFinalize(task, { stateManager });

    console.log(`Task ${taskId} implementation complete; awaiting finalizer`);
  } catch (error) {
    if (shuttingDown) {
      return;
    }

    console.error(`[Worker] Worker error: ${error}`);
    if (error instanceof Error) {
      console.error(`[Worker] Error stack: ${error.stack}`);
    }
    await finalizeTask(task, 'failed', { stateManager });
    process.exit(1);
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}

interface ProgressBaseline {
  commitSHA: string;
  commitCount: number;
  workingTreeFiles: number;
  worktreeSignature: string;
  logSize: number;
}

export function captureProgressBaseline(worktreePath: string): ProgressBaseline {
  return {
    commitSHA: getLatestCommitSHA(worktreePath),
    commitCount: getCommitCount(worktreePath),
    workingTreeFiles: getChangedFilesCount(worktreePath),
    worktreeSignature: getWorktreeDiffSignature(worktreePath),
    logSize: 0,
  };
}

interface ProgressResult {
  hasProgress: boolean;
  reason: string;
  filesChanged: number;
  newCommits: number;
}

function resolveMaxStoryAttempts(configManager: ConfigManager): number {
  const rawValue = Number(configManager.get('runner.maxStoryAttempts'));

  if (!Number.isFinite(rawValue) || rawValue < 1) {
    return 2;
  }

  return Math.floor(rawValue);
}

function getStoryAttempts(task: Task, storyId: string): number {
  return task.storyProgress?.find((story) => story.id === storyId)?.attempts ?? 0;
}

function getStoryProgress(task: Task, storyId: string): StoryProgress | undefined {
  return task.storyProgress?.find((story) => story.id === storyId);
}

function isFinalizerRepairAttempt(task: Pick<Task, 'finalizerAttempts' | 'mergeRepairAttempts' | 'mergeError'>, lastStoryError?: string): boolean {
  return Boolean(
    (task.finalizerAttempts ?? 0) > 0
    || (task.mergeRepairAttempts ?? 0) > 0
    || task.mergeError
    || /quality gate|finalizer|merge repair/i.test(lastStoryError || '')
  );
}

function reuseExistingStoryEvidenceForRepair(input: {
  task: Pick<Task, 'worktree' | 'baseCommitSha' | 'finalizerAttempts' | 'mergeRepairAttempts' | 'mergeError'>;
  storyId: string;
  previousStoryProgress?: Pick<StoryProgress, 'lastEvidence'>;
  lastStoryError?: string;
  resultSuccess: boolean;
  output: string;
}): ProgressResult | null {
  if (!input.resultSuccess || !input.previousStoryProgress?.lastEvidence) {
    return null;
  }

  if (!isFinalizerRepairAttempt(input.task, input.lastStoryError)) {
    return null;
  }

  const completionSignals = detectCompletionSignals(input.output);
  if (!completionSignals.hasValidationSignal) {
    return null;
  }

  const currentEvidence = detectCurrentWorktreeEvidence({
    worktreePath: input.task.worktree,
    baseCommitSha: input.task.baseCommitSha,
  });

  if (!currentEvidence.hasProgress) {
    return null;
  }

  return {
    hasProgress: true,
    reason: `Existing worktree evidence retained from prior ${input.storyId} pass; ${currentEvidence.reason}`,
    filesChanged: currentEvidence.filesChanged,
    newCommits: currentEvidence.newCommits,
  };
}

function upsertStoryProgress(
  task: Task,
  storyId: string,
  updates: Partial<StoryProgress> & { status: StoryStatus; updatedAt: number; historyMessage?: string }
): StoryProgress[] {
  const existingProgress = task.storyProgress || [];
  const existingStory = existingProgress.find((story) => story.id === storyId);
  const attempt = updates.attempts ?? existingStory?.attempts ?? 0;
  const history = [
    ...(existingStory?.history || []),
    {
      attempt,
      status: updates.status,
      message: updates.historyMessage || updates.lastError,
      evidence: updates.lastEvidence,
      updatedAt: updates.updatedAt,
    },
  ];
  const nextStory: StoryProgress = {
    id: storyId,
    status: updates.status,
    attempts: attempt,
    history,
    lastEvidence: updates.lastEvidence ?? existingStory?.lastEvidence,
    lastError: updates.lastError,
    updatedAt: updates.updatedAt,
  };

  if (!existingStory) {
    return [...existingProgress, nextStory];
  }

  return existingProgress.map((story) => story.id === storyId ? nextStory : story);
}

export function detectProgress(
  worktreePath: string,
  logPath: string,
  baseline: ProgressBaseline
): ProgressResult {
  const currentCommitCount = getCommitCount(worktreePath);
  const newCommits = currentCommitCount - baseline.commitCount;

  if (newCommits > 0) {
    return {
      hasProgress: true,
      reason: `${newCommits} new commit(s)`,
      filesChanged: 0,
      newCommits
    };
  }

  const currentCommitSHA = getLatestCommitSHA(worktreePath);
  if (currentCommitSHA && baseline.commitSHA && currentCommitSHA !== baseline.commitSHA) {
    return {
      hasProgress: true,
      reason: 'HEAD commit changed',
      filesChanged: 0,
      newCommits: 0,
    };
  }

  const currentFiles = getChangedFilesCount(worktreePath);
  const filesChanged = Math.abs(currentFiles - baseline.workingTreeFiles);

  if (filesChanged > 0) {
    return {
      hasProgress: true,
      reason: `${filesChanged} file(s) changed in working tree`,
      filesChanged,
      newCommits: 0
    };
  }

  const currentWorktreeSignature = getWorktreeDiffSignature(worktreePath);
  if (currentWorktreeSignature && currentWorktreeSignature !== baseline.worktreeSignature) {
    return {
      hasProgress: true,
      reason: 'working tree diff content changed',
      filesChanged: currentFiles,
      newCommits: 0,
    };
  }

  const hasSuccessMessage = checkAgentLogForSuccess(logPath);

  if (hasSuccessMessage) {
    return {
      hasProgress: false,
      reason: 'Agent reported success in log, but no objective file or commit evidence was found',
      filesChanged: 0,
      newCommits: 0
    };
  }

  return {
    hasProgress: false,
    reason: 'No commits, no file changes, no success messages',
    filesChanged: 0,
    newCommits: 0
  };
}

export function getWorktreeDiffSignature(worktreePath: string): string {
  try {
    const hash = createHash('sha256');
    hash.update(runGit(worktreePath, 'status --porcelain=v1 -z'));
    hash.update('\0diff\0');
    hash.update(runGit(worktreePath, 'diff --binary HEAD --'));

    const untrackedFiles = runGit(worktreePath, 'ls-files --others --exclude-standard -z')
      .split('\0')
      .filter(Boolean)
      .sort();

    for (const relativePath of untrackedFiles) {
      const absolutePath = path.join(worktreePath, relativePath);
      hash.update('\0untracked\0');
      hash.update(relativePath);
      try {
        const stats = fs.statSync(absolutePath);
        if (stats.isFile()) {
          hash.update(fs.readFileSync(absolutePath));
        }
      } catch {
        hash.update('\0missing\0');
      }
    }

    return hash.digest('hex');
  } catch {
    return '';
  }
}

function runGit(worktreePath: string, args: string): string {
  return execSync(`git ${args}`, {
    cwd: worktreePath,
    encoding: 'utf-8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

function getLatestCommitSHA(worktreePath: string): string {
  try {
    const sha = execSync('git rev-parse HEAD', {
      cwd: worktreePath,
      encoding: 'utf-8'
    });
    return sha.trim();
  } catch {
    return '';
  }
}

function getCommitCount(worktreePath: string): number {
  try {
    const count = execSync('git rev-list --count HEAD', {
      cwd: worktreePath,
      encoding: 'utf-8'
    });
    return parseInt(count.trim(), 10);
  } catch {
    return 0;
  }
}

function getChangedFilesCount(worktreePath: string): number {
  try {
    const output = execSync('git status --porcelain', {
      cwd: worktreePath,
      encoding: 'utf-8'
    });
    return output.trim().split('\n').filter((line: string) => line.length > 0).length;
  } catch {
    return 0;
  }
}

function checkAgentLogForSuccess(logPath: string): boolean {
  try {
    if (!fs.existsSync(logPath)) {
      return false;
    }

    const stats = fs.statSync(logPath);
    const readSize = Math.min(250 * 1024, stats.size);
    const buffer = Buffer.alloc(readSize);

    const fd = fs.openSync(logPath, 'r');
    fs.readSync(fd, buffer, 0, readSize, Math.max(0, stats.size - readSize));
    fs.closeSync(fd);

    const logTail = buffer.toString('utf-8');
    if (detectCompletionSignals(logTail).matchedSignals.length > 0) {
      return true;
    }
    const successPatterns = [
      /user story.*completed/i,
      /successfully.*implemented/i,
      /all.*tests.*pass/i,
      /implementation.*complete/i,
      /task.*done/i,
      /✓.*success/i,
      /✅/
    ];

    return successPatterns.some((pattern) => pattern.test(logTail));
  } catch {
    return false;
  }
}

if (require.main === module) {
  const taskId = process.argv[2];
  if (!taskId) {
    console.error('Task ID required');
    process.exit(1);
  }

  runWorker(taskId);
}
