import { StateManager } from './core/state';
import { AgentRunner, AgentType, resolveAgentBackend, resolveConfiguredBackend } from './core/agent';
import { ConfigManager } from './config/manager';
import { bootstrapWorktreeDeps } from './core/bootstrap';
import { finalizeTask } from './core/scheduler';
import { shouldTreatNonZeroExitAsSuccess } from './core/soft-success';
import { detectStagnation, loadTaskPRD, saveTaskPRD } from './utils/helpers';
import { execSync } from 'child_process';
import * as fs from 'fs';

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
    await stateManager.saveTask(task);
  }

  console.log(`[Worker] Backend: ${backend}`);

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

    const runner = new AgentRunner();

    for (const us of prd.userStories) {
      if (task.completedUS.includes(us.id)) {
        console.log(`[Worker] Skipping completed User Story: ${us.id}`);
        continue;
      }

      task.currentUS = us.id;
      await stateManager.saveTask(task);

      console.log(`Running User Story: ${us.id} - ${us.title}`);

      const baselineState = captureProgressBaseline(task.worktree);

      const result = await runner.runUserStory(
        us,
        task.worktree,
        task.agent as AgentType,
        task.logPath,
        backend,
        {
          sessionId: task.sessionId,
          threadId: task.threadId,
        }
      );

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
        await stateManager.saveTask(task);
      }

      const progressDetected = detectProgress(
        task.worktree,
        task.logPath,
        baselineState
      );

      task.loopCount++;
      task.lastFilesChanged = progressDetected.filesChanged;

      if (progressDetected.hasProgress) {
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

      await stateManager.saveTask(task);

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
          await stateManager.saveTask(task);
        } else {
          console.error(`Failed to complete User Story: ${us.id}`);
          await finalizeTask(task, 'failed', { stateManager });
          process.exit(1);
        }
      }

      if (!task.completedUS.includes(us.id)) {
        task.completedUS.push(us.id);
      }
      us.passes = true;
      saveTaskPRD(task, prd);
      await stateManager.saveTask(task);
    }

    task.status = 'ready_to_finalize';
    task.currentUS = undefined;
    task.pid = undefined;
    await stateManager.saveTask(task);

    console.log(`Task ${taskId} implementation complete; awaiting finalizer`);
  } catch (error) {
    console.error(`[Worker] Worker error: ${error}`);
    if (error instanceof Error) {
      console.error(`[Worker] Error stack: ${error.stack}`);
    }
    await finalizeTask(task, 'failed', { stateManager });
    process.exit(1);
  }
}

interface ProgressBaseline {
  commitSHA: string;
  commitCount: number;
  workingTreeFiles: number;
  logSize: number;
}

function captureProgressBaseline(worktreePath: string): ProgressBaseline {
  return {
    commitSHA: getLatestCommitSHA(worktreePath),
    commitCount: getCommitCount(worktreePath),
    workingTreeFiles: getChangedFilesCount(worktreePath),
    logSize: 0,
  };
}

interface ProgressResult {
  hasProgress: boolean;
  reason: string;
  filesChanged: number;
  newCommits: number;
}

function detectProgress(
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

  const hasSuccessMessage = checkAgentLogForSuccess(logPath);

  if (hasSuccessMessage) {
    return {
      hasProgress: true,
      reason: 'Agent reported success in log',
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
    const readSize = Math.min(50 * 1024, stats.size);
    const buffer = Buffer.alloc(readSize);

    const fd = fs.openSync(logPath, 'r');
    fs.readSync(fd, buffer, 0, readSize, Math.max(0, stats.size - readSize));
    fs.closeSync(fd);

    const logTail = buffer.toString('utf-8');
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

const taskId = process.argv[2];
if (!taskId) {
  console.error('Task ID required');
  process.exit(1);
}

runWorker(taskId);
