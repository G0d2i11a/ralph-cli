import { StateManager } from './core/state';
import { AgentRunner, AgentType, resolveAgentBackend, resolveConfiguredBackend } from './core/agent';
import { appendTaskEvent } from './core/events';
import { ConfigManager } from './config/manager';
import { bootstrapWorktreeDeps } from './core/bootstrap';
import { buildStoryExecutionPayload } from './core/repair-context';
import { finalizeTask, markTaskReadyToFinalize } from './core/scheduler';
import { resolveIntegrationPolicy } from './core/integration-policy';
import { probeTaskWorktreeMergeability } from './core/merge';
import {
  buildMergeRepairProof,
  deriveMergeRepairDisplayStatus,
} from './core/merge-task-updates';
import {
  detectCompletionSignals,
  detectCurrentWorktreeEvidence,
  hasObjectiveProgressEvidence,
  reuseTaskLevelEvidenceForStorySuccess,
  shouldTreatNonZeroExitAsSuccess,
} from './core/soft-success';
import { createWorkerLeaseUpdate, startWorkerLeaseHeartbeat } from './core/worker-heartbeat';
import { classifyAgentFailureOutput, ErrorClassification } from './core/error-classifier';
import {
  evaluateTaskStoryCompletion,
  formatStoryCompletionInvariantMessage,
} from './core/story-completion';
import { detectStagnation, loadTaskPRD, saveTaskPRD } from './utils/helpers';
import { StoryProgress, StoryStatus, Task } from './types/task';
import {
  captureProgressBaseline,
  detectProgress,
  ProgressResult,
} from './core/worktree-progress';

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
    const maxTransientRetries = resolveMaxTransientRetries(configManager);

    for (const us of prd.userStories) {
      if (task.completedUS.includes(us.id)) {
        console.log(`[Worker] Skipping completed User Story: ${us.id}`);
        continue;
      }

      let storyPassed = false;
      let lastStoryError = getStoryProgress(task, us.id)?.lastError;
      let transientRetryCountForStory = 0;

      while (!storyPassed && getStoryAttempts(task, us.id) < maxStoryAttempts) {
        const latestTaskState = await stateManager.loadTask(task.id);
        if (latestTaskState) {
          task.repairContext = latestTaskState.repairContext;
          task.finalizerFailure = latestTaskState.finalizerFailure;
          task.mergeConflictFiles = latestTaskState.mergeConflictFiles;
          task.observedWriteSurface = latestTaskState.observedWriteSurface;
          task.observedPackageSurface = latestTaskState.observedPackageSurface;
          task.postFinalizeMergeProbeRequired = latestTaskState.postFinalizeMergeProbeRequired;
          task.autoRecoveryKind = latestTaskState.autoRecoveryKind;
          task.autoRecoveryTotalRequeues = latestTaskState.autoRecoveryTotalRequeues;
          task.autoRecoveryHardCap = latestTaskState.autoRecoveryHardCap;
          task.autoRecoveryLastRequeuedAt = latestTaskState.autoRecoveryLastRequeuedAt;
          task.autoRecoveryNextEligibleAt = latestTaskState.autoRecoveryNextEligibleAt;
          task.autoRecoveryStoppedAt = latestTaskState.autoRecoveryStoppedAt;
          task.autoRecoveryStopReason = latestTaskState.autoRecoveryStopReason;
          task.autoRecoveryLastReason = latestTaskState.autoRecoveryLastReason;
          task.transientRecoveryStartedAt = latestTaskState.transientRecoveryStartedAt;
          task.transientRecoveryDeadlineAt = latestTaskState.transientRecoveryDeadlineAt;
          task.transientRecoveryTotalRequeues = latestTaskState.transientRecoveryTotalRequeues;
          task.transientRecoveryConsecutiveSameSignature = latestTaskState.transientRecoveryConsecutiveSameSignature;
          task.transientRecoveryLastFailureKind = latestTaskState.transientRecoveryLastFailureKind;
          task.transientRecoveryLastFailureClass = latestTaskState.transientRecoveryLastFailureClass;
          task.transientRecoveryLastFailureSignature = latestTaskState.transientRecoveryLastFailureSignature;
          task.transientRecoveryLastDelayMs = latestTaskState.transientRecoveryLastDelayMs;
          task.transientRecoveryNextEligibleAt = latestTaskState.transientRecoveryNextEligibleAt;
          task.transientRecoveryStoppedAt = latestTaskState.transientRecoveryStoppedAt;
          task.transientRecoveryStopReason = latestTaskState.transientRecoveryStopReason;
          task.transientRecoveryLastRequeuedStoryId = latestTaskState.transientRecoveryLastRequeuedStoryId;
          task.transientRecoveryLastHadObjectiveProgress = latestTaskState.transientRecoveryLastHadObjectiveProgress;
          task.mergeRepairRecoveryStartedAt = latestTaskState.mergeRepairRecoveryStartedAt;
          task.mergeRepairRecoveryDeadlineAt = latestTaskState.mergeRepairRecoveryDeadlineAt;
          task.mergeRepairRecoveryTotalRequeues = latestTaskState.mergeRepairRecoveryTotalRequeues;
          task.mergeRepairRecoveryConsecutiveNoProgress = latestTaskState.mergeRepairRecoveryConsecutiveNoProgress;
          task.mergeRepairRecoveryLastObservationSignature = latestTaskState.mergeRepairRecoveryLastObservationSignature;
          task.mergeRepairRecoveryLastConflictSignature = latestTaskState.mergeRepairRecoveryLastConflictSignature;
          task.mergeRepairRecoveryLastProbeMessage = latestTaskState.mergeRepairRecoveryLastProbeMessage;
          task.mergeRepairRecoveryLastProgressReason = latestTaskState.mergeRepairRecoveryLastProgressReason;
          task.mergeRepairRecoveryStoppedAt = latestTaskState.mergeRepairRecoveryStoppedAt;
          task.mergeRepairRecoveryStopReason = latestTaskState.mergeRepairRecoveryStopReason;
          task.mergeRepairDisplayStatus = latestTaskState.mergeRepairDisplayStatus;
          task.mergeRepairProof = latestTaskState.mergeRepairProof;
        }
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
          lastErrorKind: undefined,
          lastErrorClass: undefined,
          lastErrorRetryable: undefined,
          ...(task.repairContext?.mode === 'merge'
            ? {
                mergeRepairRecoveryStoppedAt: undefined,
                mergeRepairRecoveryStopReason: undefined,
                autoRecoveryStoppedAt: undefined,
                autoRecoveryStopReason: undefined,
              }
            : {}),
          transientRetryLastDelayMs: undefined,
          transientRetryBudget: maxTransientRetries,
          ...createWorkerLeaseUpdate(configManager),
        });

        console.log(`Running User Story: ${us.id} - ${us.title} (attempt ${attempt}/${maxStoryAttempts})`);
        appendTaskEvent(task, {
          type: 'story_attempt_started',
          storyId: us.id,
          message: `Started ${us.id} attempt ${attempt}/${maxStoryAttempts}`,
          data: { attempt, maxStoryAttempts },
        });

        let result;
        let progressDetected: ProgressResult;
        let hasObjectiveEvidence = false;
        let reusedRepairProgress: ProgressResult | null = null;
        let reusedTaskLevelProgress: ProgressResult | null = null;
        let failureClassification: ErrorClassification | undefined;
        let mergeRepairVerification:
          | Awaited<ReturnType<typeof verifyMergeRepairReadiness>>
          | undefined;

        while (true) {
          const baselineState = captureProgressBaseline(task.worktree);
          const storyForAttempt = buildStoryExecutionPayload(task, us, lastStoryError);
          const isMergeRepairAttempt = task.repairContext?.mode === 'merge';

          const heartbeat = startWorkerLeaseHeartbeat(task.id, stateManager, configManager, { logger: console });
          result = await runner.runUserStory(
            storyForAttempt,
            task.worktree,
            task.agent as AgentType,
            task.logPath,
            backend,
            {
              sessionId: task.sessionId,
              threadId: task.threadId,
              threadStoryId: task.threadStoryId,
              storyId: us.id,
            }
          ).finally(() => heartbeat.stop());

          let continuationStateChanged = false;
          if (result.sessionId && result.sessionId !== task.sessionId) {
            task.sessionId = result.sessionId;
            continuationStateChanged = true;
          }
          if (result.threadId && (result.threadId !== task.threadId || task.threadStoryId !== us.id)) {
            task.threadId = result.threadId;
            task.threadStoryId = us.id;
            continuationStateChanged = true;
          }
          if (continuationStateChanged) {
            await stateManager.updateTask(task.id, {
              sessionId: task.sessionId,
              threadId: task.threadId,
              threadStoryId: task.threadStoryId,
              ...createWorkerLeaseUpdate(configManager),
            });
          }

          progressDetected = detectProgress(
            task.worktree,
            task.logPath,
            baselineState
          );
          hasObjectiveEvidence = hasObjectiveProgressEvidence(progressDetected);
          reusedRepairProgress = !hasObjectiveEvidence && !isMergeRepairAttempt
            ? reuseExistingStoryEvidenceForRepair({
                task,
                storyId: us.id,
                previousStoryProgress,
                lastStoryError,
                resultSuccess: result.success,
                output: result.output,
              })
            : null;
          reusedTaskLevelProgress = !hasObjectiveEvidence && result.success && !isMergeRepairAttempt
            ? reuseTaskLevelEvidenceForStorySuccess({
                output: result.output,
                worktreePath: task.worktree,
                baseCommitSha: task.baseCommitSha,
                storyId: us.id,
              })
            : null;

          if (reusedRepairProgress) {
            progressDetected = reusedRepairProgress;
            hasObjectiveEvidence = true;
          } else if (reusedTaskLevelProgress) {
            progressDetected = reusedTaskLevelProgress;
            hasObjectiveEvidence = true;
          }

          failureClassification = !result.success
            ? classifyAgentFailureOutput(result.output)
            : undefined;

          if (
            failureClassification?.explicit
            && failureClassification.retryable
            && !hasObjectiveEvidence
          ) {
            const nextTransientRetryCount = transientRetryCountForStory + 1;

            if (nextTransientRetryCount > maxTransientRetries) {
              lastStoryError = `Transient retry budget exhausted for ${us.id}: ${failureClassification.message}`;
              task.lastError = lastStoryError;
              task.lastErrorKind = failureClassification.kind;
              task.lastErrorClass = failureClassification.class;
              task.lastErrorRetryable = true;
              task.lastErrorObservedAt = Date.now();
              task.lastErrorSignature = failureClassification.signature;
              task.lastErrorHadObjectiveProgress = false;
              task.transientRetryCount = transientRetryCountForStory;
              task.transientRetryBudget = maxTransientRetries;
              task.storyProgress = upsertStoryProgress(task, us.id, {
                status: 'failed',
                lastError: lastStoryError,
                historyMessage: lastStoryError,
                updatedAt: Date.now(),
              });
              await stateManager.updateTask(task.id, {
                lastError: lastStoryError,
                lastErrorKind: task.lastErrorKind,
                lastErrorClass: task.lastErrorClass,
                lastErrorRetryable: task.lastErrorRetryable,
                lastErrorObservedAt: task.lastErrorObservedAt,
                lastErrorSignature: task.lastErrorSignature,
                lastErrorHadObjectiveProgress: task.lastErrorHadObjectiveProgress,
                transientRetryCount: task.transientRetryCount,
                transientRetryBudget: task.transientRetryBudget,
                storyProgress: task.storyProgress,
                ...createWorkerLeaseUpdate(configManager),
              });
              appendTaskEvent(task, {
                type: 'story_failed',
                storyId: us.id,
                status: 'failed',
                message: lastStoryError,
                data: {
                  attempt,
                  errorKind: failureClassification.kind,
                  transientRetryCount: transientRetryCountForStory,
                },
              });
              await finalizeTask(task, 'failed', { stateManager });
              process.exit(1);
            }

            transientRetryCountForStory = nextTransientRetryCount;
            const delayMs = resolveTransientRetryDelayMs(
              transientRetryCountForStory,
              configManager,
            );
            lastStoryError = result.output.slice(-500);
            task.lastError = lastStoryError;
            task.lastErrorKind = failureClassification.kind;
            task.lastErrorClass = failureClassification.class;
            task.lastErrorRetryable = true;
            task.lastErrorObservedAt = Date.now();
            task.lastErrorSignature = failureClassification.signature;
            task.lastErrorHadObjectiveProgress = false;
            task.transientRetryCount = transientRetryCountForStory;
            task.transientRetryBudget = maxTransientRetries;
            task.transientRetryLastDelayMs = delayMs;
            await stateManager.updateTask(task.id, {
              lastError: task.lastError,
              lastErrorKind: task.lastErrorKind,
              lastErrorClass: task.lastErrorClass,
              lastErrorRetryable: task.lastErrorRetryable,
              lastErrorObservedAt: task.lastErrorObservedAt,
              lastErrorSignature: task.lastErrorSignature,
              lastErrorHadObjectiveProgress: task.lastErrorHadObjectiveProgress,
              transientRetryCount: task.transientRetryCount,
              transientRetryBudget: task.transientRetryBudget,
              transientRetryLastDelayMs: task.transientRetryLastDelayMs,
              ...createWorkerLeaseUpdate(configManager),
            });
            appendTaskEvent(task, {
              type: 'story_attempt_needs_repair',
              storyId: us.id,
              message: `Transient agent/backend failure (${failureClassification.kind}); retrying in ${Math.round(delayMs / 1000)}s`,
              data: {
                attempt,
                errorKind: failureClassification.kind,
                transientRetryCount: transientRetryCountForStory,
                transientRetryBudget: maxTransientRetries,
                delayMs,
              },
            });
            console.log(
              `[Worker] Transient failure for ${us.id} (${failureClassification.kind}), retrying in ${delayMs}ms (${transientRetryCountForStory}/${maxTransientRetries})`
            );
            await sleep(delayMs);
            continue;
          }

          break;
        }

        const isMergeRepairAttempt = task.repairContext?.mode === 'merge';

        if (isMergeRepairAttempt) {
          mergeRepairVerification = await verifyMergeRepairReadiness(task, configManager);
        }

        const softSuccess = !result.success
          ? shouldTreatNonZeroExitAsSuccess({
              output: result.output,
              progress: progressDetected,
            })
          : undefined;
        const effectiveSuccess = result.success
          || Boolean(softSuccess?.shouldTreatAsSuccess)
          || Boolean(isMergeRepairAttempt && mergeRepairVerification?.ok);

        const hasCompletionEvidence = hasObjectiveEvidence || Boolean(mergeRepairVerification?.ok);

        task.loopCount++;
        task.lastFilesChanged = progressDetected.filesChanged;

        if (hasCompletionEvidence) {
          task.consecutiveNoProgress = 0;
          task.lastProgressTime = Date.now();
          console.log(`[Worker] Progress detected: ${mergeRepairVerification?.ok ? mergeRepairVerification.message : progressDetected.reason}`);
        } else {
          task.consecutiveNoProgress++;
          console.log(`[Worker] No progress detected (consecutive: ${task.consecutiveNoProgress})`);
        }

        if (!effectiveSuccess && !result.success) {
          task.consecutiveErrors++;
          task.lastError = result.output.slice(-500);
          task.lastErrorKind = failureClassification?.kind;
          task.lastErrorClass = failureClassification?.class;
          task.lastErrorRetryable = failureClassification?.retryable;
          task.lastErrorObservedAt = Date.now();
          task.lastErrorSignature = failureClassification?.signature
            || normalizeErrorSignature(task.lastError);
          task.lastErrorHadObjectiveProgress = hasObjectiveEvidence;
        } else {
          task.consecutiveErrors = 0;
          task.lastError = undefined;
          task.lastErrorKind = undefined;
          task.lastErrorClass = undefined;
          task.lastErrorRetryable = undefined;
          task.lastErrorObservedAt = undefined;
          task.lastErrorSignature = undefined;
          task.lastErrorHadObjectiveProgress = undefined;
          task.transientRetryCount = 0;
          task.transientRetryLastDelayMs = undefined;
        }

        await stateManager.updateTask(task.id, {
          loopCount: task.loopCount,
          lastFilesChanged: task.lastFilesChanged,
          consecutiveNoProgress: task.consecutiveNoProgress,
          consecutiveErrors: task.consecutiveErrors,
          lastProgressTime: task.lastProgressTime,
          lastError: task.lastError,
          lastErrorKind: task.lastErrorKind,
          lastErrorClass: task.lastErrorClass,
          lastErrorRetryable: task.lastErrorRetryable,
          lastErrorObservedAt: task.lastErrorObservedAt,
          lastErrorSignature: task.lastErrorSignature,
          lastErrorHadObjectiveProgress: task.lastErrorHadObjectiveProgress,
          transientRetryCount: task.transientRetryCount,
          transientRetryBudget: maxTransientRetries,
          transientRetryLastDelayMs: task.transientRetryLastDelayMs,
          storyProgress: task.storyProgress,
          ...createWorkerLeaseUpdate(configManager),
        });

        const configuredStagnationTimeoutSeconds = Number(configManager.get('runner.stagnationTimeout'));
        const stagnationCheck = failureClassification?.explicit
          ? { isStagnant: false }
          : detectStagnation(task, {
              timeoutMs: Number.isFinite(configuredStagnationTimeoutSeconds) && configuredStagnationTimeoutSeconds > 0
                ? configuredStagnationTimeoutSeconds * 1000
                : undefined,
            });
        if (stagnationCheck.isStagnant) {
          const stagnationMessage = stagnationCheck.reason || 'Stagnation detected';
          task.lastError = stagnationMessage;
          task.lastErrorKind = 'stagnation';
          task.lastErrorClass = 'stagnation';
          task.lastErrorRetryable = false;
          task.lastErrorObservedAt = Date.now();
          await stateManager.updateTask(task.id, {
            lastError: task.lastError,
            lastErrorKind: task.lastErrorKind,
            lastErrorClass: task.lastErrorClass,
            lastErrorRetryable: task.lastErrorRetryable,
            lastErrorObservedAt: task.lastErrorObservedAt,
            ...createWorkerLeaseUpdate(configManager),
          });
          console.error(`Stagnation detected: ${stagnationMessage}`);
          await finalizeTask(task, 'stagnant', { stateManager });
          process.exit(1);
        }

        if (!effectiveSuccess && !result.success) {
          if (softSuccess?.shouldTreatAsSuccess) {
            console.log(`[Worker] Treating non-zero exit as soft success: ${softSuccess.reason}`);
            task.consecutiveErrors = 0;
            task.lastError = undefined;
            task.lastErrorKind = undefined;
            task.lastErrorClass = undefined;
            task.lastErrorRetryable = undefined;
            task.lastErrorObservedAt = undefined;
            task.lastErrorSignature = undefined;
            task.lastErrorHadObjectiveProgress = undefined;
            task.transientRetryCount = 0;
            task.transientRetryLastDelayMs = undefined;
            await stateManager.updateTask(task.id, {
              consecutiveErrors: task.consecutiveErrors,
              lastError: task.lastError,
              lastErrorKind: task.lastErrorKind,
              lastErrorClass: task.lastErrorClass,
              lastErrorRetryable: task.lastErrorRetryable,
              lastErrorObservedAt: task.lastErrorObservedAt,
              lastErrorSignature: task.lastErrorSignature,
              lastErrorHadObjectiveProgress: task.lastErrorHadObjectiveProgress,
              transientRetryCount: task.transientRetryCount,
              transientRetryLastDelayMs: task.transientRetryLastDelayMs,
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
        } else if (!result.success && softSuccess?.shouldTreatAsSuccess) {
          console.log(`[Worker] Treating non-zero exit as soft success: ${softSuccess.reason}`);
        } else if (!result.success && isMergeRepairAttempt && mergeRepairVerification?.ok) {
          console.log(`[Worker] Treating merge repair non-zero exit as success: ${mergeRepairVerification.message}`);
        }

        const storyCompletionDecision = resolveStoryCompletionDecision({
          storyId: us.id,
          isMergeRepairAttempt,
          hasObjectiveEvidence,
          progressReason: progressDetected.reason,
          mergeRepairVerification,
        });

        if (!storyCompletionDecision.accepted) {
          lastStoryError = storyCompletionDecision.message;
          console.error(lastStoryError);
          const hasAttemptsLeft = attempt < maxStoryAttempts;
          task.lastError = lastStoryError;
          if (isMergeRepairAttempt) {
            const observedAt = Date.now();
            task.mergeError = mergeRepairVerification?.probeResult?.message ?? lastStoryError;
            task.mergeConflictFiles = mergeRepairVerification?.probeResult?.conflictFiles;
            task.mergeConflictPhase = mergeRepairVerification?.probeResult?.failurePhase;
            task.mergeConflictAt = mergeRepairVerification?.probeResult?.conflictFiles?.length
              ? observedAt
              : undefined;
            task.integrationBranch = mergeRepairVerification?.probeResult?.integrationBranch ?? task.integrationBranch;
            task.integrationWorktree = mergeRepairVerification?.probeResult?.integrationWorktree ?? task.integrationWorktree;
            task.postFinalizeMergeProbeRequired = true;
            task.mergeRepairDisplayStatus = mergeRepairVerification?.probeResult
              ? deriveMergeRepairDisplayStatus(mergeRepairVerification.probeResult)
              : 'unresolved';
            task.mergeRepairProof = mergeRepairVerification?.probeResult
              ? buildMergeRepairProof(mergeRepairVerification.probeResult, observedAt)
              : undefined;
            task.lastErrorKind = 'merge_conflict';
            task.lastErrorClass = 'merge_conflict';
            task.lastErrorRetryable = true;
            task.lastErrorObservedAt = observedAt;
            task.lastErrorSignature = buildMergeRepairErrorSignature(task.mergeConflictFiles, task.mergeError || lastStoryError);
            task.lastErrorHadObjectiveProgress = hasObjectiveEvidence;
          }
          task.storyProgress = upsertStoryProgress(task, us.id, {
            status: hasAttemptsLeft ? 'needs_repair' : 'failed',
            lastError: lastStoryError,
            historyMessage: lastStoryError,
            updatedAt: Date.now(),
          });
          await stateManager.updateTask(task.id, {
            lastError: lastStoryError,
            mergeError: task.mergeError,
            mergeConflictFiles: task.mergeConflictFiles,
            mergeConflictPhase: task.mergeConflictPhase,
            mergeConflictAt: task.mergeConflictAt,
            integrationBranch: task.integrationBranch,
            integrationWorktree: task.integrationWorktree,
            postFinalizeMergeProbeRequired: task.postFinalizeMergeProbeRequired,
            mergeRepairDisplayStatus: task.mergeRepairDisplayStatus,
            mergeRepairProof: task.mergeRepairProof,
            lastErrorKind: task.lastErrorKind,
            lastErrorClass: task.lastErrorClass,
            lastErrorRetryable: task.lastErrorRetryable,
            lastErrorObservedAt: task.lastErrorObservedAt,
            lastErrorSignature: task.lastErrorSignature,
            lastErrorHadObjectiveProgress: task.lastErrorHadObjectiveProgress,
            storyProgress: task.storyProgress,
            ...createWorkerLeaseUpdate(configManager),
          });

          if (hasAttemptsLeft) {
            appendTaskEvent(task, {
              type: 'story_attempt_needs_repair',
              storyId: us.id,
              message: lastStoryError,
              data: {
                attempt,
                exactMergeability: isMergeRepairAttempt ? mergeRepairVerification?.ok === true : undefined,
                conflictFiles: task.mergeConflictFiles,
              },
            });
            console.log(isMergeRepairAttempt
              ? `[Worker] Retrying merge repair for ${us.id} after exact mergeability probe failure`
              : `[Worker] Retrying User Story ${us.id} after missing objective evidence`);
            continue;
          }

          appendTaskEvent(task, {
            type: 'story_failed',
            storyId: us.id,
            status: 'failed',
            message: lastStoryError,
            data: {
              attempt,
              exactMergeability: isMergeRepairAttempt ? mergeRepairVerification?.ok === true : undefined,
              conflictFiles: task.mergeConflictFiles,
            },
          });
          await finalizeTask(task, 'failed', { stateManager });
          process.exit(1);
        }

        if (!task.completedUS.includes(us.id)) {
          task.completedUS.push(us.id);
        }
        us.passes = true;
          const passedStoryMessage = storyCompletionDecision.message;
          task.storyProgress = upsertStoryProgress(task, us.id, {
            status: 'passed',
            lastEvidence: passedStoryMessage,
            lastError: undefined,
            historyMessage: passedStoryMessage,
            updatedAt: Date.now(),
          });
          task.transientRetryCount = 0;
          task.transientRetryLastDelayMs = undefined;
          task.mergeError = undefined;
          task.mergeConflictFiles = undefined;
          task.mergeConflictPhase = undefined;
          task.mergeConflictAt = undefined;
          task.autoRecoveryKind = undefined;
          task.autoRecoveryNextEligibleAt = undefined;
          task.autoRecoveryStoppedAt = undefined;
          task.autoRecoveryStopReason = undefined;
          task.autoRecoveryLastReason = undefined;
          task.transientRecoveryNextEligibleAt = undefined;
          task.transientRecoveryStoppedAt = undefined;
          task.transientRecoveryStopReason = undefined;
          task.transientRecoveryLastDelayMs = undefined;
          task.mergeRepairDisplayStatus = mergeRepairVerification?.probeResult
            ? deriveMergeRepairDisplayStatus(mergeRepairVerification.probeResult)
            : undefined;
          task.mergeRepairProof = mergeRepairVerification?.probeResult
            ? buildMergeRepairProof(mergeRepairVerification.probeResult)
            : undefined;
          task.postFinalizeMergeProbeRequired = storyCompletionDecision.exactMergeabilityVerified
            ? true
            : task.postFinalizeMergeProbeRequired;
          task.repairContext = undefined;
          saveTaskPRD(task, prd);
          await stateManager.updateTask(task.id, {
            completedUS: task.completedUS,
            storyProgress: task.storyProgress,
            transientRetryCount: task.transientRetryCount,
            transientRetryLastDelayMs: task.transientRetryLastDelayMs,
            mergeError: undefined,
            mergeConflictFiles: undefined,
            mergeConflictPhase: undefined,
            mergeConflictAt: undefined,
            autoRecoveryKind: task.autoRecoveryKind,
            autoRecoveryNextEligibleAt: task.autoRecoveryNextEligibleAt,
            autoRecoveryStoppedAt: task.autoRecoveryStoppedAt,
            autoRecoveryStopReason: task.autoRecoveryStopReason,
            autoRecoveryLastReason: task.autoRecoveryLastReason,
            transientRecoveryNextEligibleAt: task.transientRecoveryNextEligibleAt,
            transientRecoveryStoppedAt: task.transientRecoveryStoppedAt,
            transientRecoveryStopReason: task.transientRecoveryStopReason,
            transientRecoveryLastDelayMs: task.transientRecoveryLastDelayMs,
            mergeRepairDisplayStatus: task.mergeRepairDisplayStatus,
            mergeRepairProof: task.mergeRepairProof,
            postFinalizeMergeProbeRequired: task.postFinalizeMergeProbeRequired,
            repairContext: undefined,
            ...createWorkerLeaseUpdate(configManager),
          });
        appendTaskEvent(task, {
          type: 'story_passed',
          storyId: us.id,
          message: passedStoryMessage,
          data: {
            filesChanged: progressDetected.filesChanged,
            newCommits: progressDetected.newCommits,
            reusedExistingEvidence: Boolean(reusedRepairProgress || reusedTaskLevelProgress),
            reusedExistingEvidenceScope: reusedRepairProgress
              ? 'repair'
              : reusedTaskLevelProgress
                ? 'task_base'
                : undefined,
            exactMergeabilityVerified: storyCompletionDecision.exactMergeabilityVerified,
          },
        });
        storyPassed = true;
      }

      if (!storyPassed) {
        const storyProgress = getStoryProgress(task, us.id);
        const attempts = getStoryAttempts(task, us.id);
        const exhaustedMessage = `User story ${us.id} exhausted ${attempts}/${maxStoryAttempts} attempts without reaching passed status (last status: ${storyProgress?.status || 'pending'})`;
        task.lastError = exhaustedMessage;
        task.lastErrorKind = 'story_incomplete';
        task.lastErrorClass = 'semantic';
        task.lastErrorRetryable = false;
        task.lastErrorObservedAt = Date.now();
        task.autoRecoveryNextEligibleAt = undefined;
        task.autoRecoveryStoppedAt = task.lastErrorObservedAt;
        task.autoRecoveryStopReason = 'story_incomplete';
        task.autoRecoveryLastReason = exhaustedMessage;
        task.storyProgress = upsertStoryProgress(task, us.id, {
          status: 'failed',
          attempts,
          lastError: exhaustedMessage,
          historyMessage: exhaustedMessage,
          updatedAt: task.lastErrorObservedAt,
        });
        await stateManager.updateTask(task.id, {
          storyProgress: task.storyProgress,
          lastError: task.lastError,
          lastErrorKind: task.lastErrorKind,
          lastErrorClass: task.lastErrorClass,
          lastErrorRetryable: task.lastErrorRetryable,
          lastErrorObservedAt: task.lastErrorObservedAt,
          autoRecoveryNextEligibleAt: task.autoRecoveryNextEligibleAt,
          autoRecoveryStoppedAt: task.autoRecoveryStoppedAt,
          autoRecoveryStopReason: task.autoRecoveryStopReason,
          autoRecoveryLastReason: task.autoRecoveryLastReason,
          ...createWorkerLeaseUpdate(configManager),
        });
        appendTaskEvent(task, {
          type: 'story_failed',
          storyId: us.id,
          status: 'failed',
          message: exhaustedMessage,
          data: { attempts, maxStoryAttempts },
        });
        await finalizeTask(task, 'failed', { stateManager });
        process.exit(1);
      }
    }

    const completionSummary = evaluateTaskStoryCompletion(
      task,
      prd.userStories.map((story) => story.id),
    );
    if (!completionSummary.allStoriesPassed) {
      const invariantMessage = formatStoryCompletionInvariantMessage(task.id, 'finalize', completionSummary);
      task.lastError = invariantMessage;
      task.lastErrorKind = 'story_incomplete';
      task.lastErrorClass = 'semantic';
      task.lastErrorRetryable = false;
      task.lastErrorObservedAt = Date.now();
      task.autoRecoveryNextEligibleAt = undefined;
      task.autoRecoveryStoppedAt = task.lastErrorObservedAt;
      task.autoRecoveryStopReason = 'story_incomplete';
      task.autoRecoveryLastReason = invariantMessage;
      await stateManager.updateTask(task.id, {
        lastError: task.lastError,
        lastErrorKind: task.lastErrorKind,
        lastErrorClass: task.lastErrorClass,
        lastErrorRetryable: task.lastErrorRetryable,
        lastErrorObservedAt: task.lastErrorObservedAt,
        autoRecoveryNextEligibleAt: task.autoRecoveryNextEligibleAt,
        autoRecoveryStoppedAt: task.autoRecoveryStoppedAt,
        autoRecoveryStopReason: task.autoRecoveryStopReason,
        autoRecoveryLastReason: task.autoRecoveryLastReason,
        ...createWorkerLeaseUpdate(configManager),
      });
      await finalizeTask(task, 'failed', { stateManager });
      process.exit(1);
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

function resolveMaxStoryAttempts(configManager: ConfigManager): number {
  const rawValue = Number(configManager.get('runner.maxStoryAttempts'));

  if (!Number.isFinite(rawValue) || rawValue < 1) {
    return 2;
  }

  return Math.floor(rawValue);
}

function resolveMaxTransientRetries(configManager: ConfigManager): number {
  const rawValue = Number(configManager.get('runner.maxTransientRetriesPerStory'));

  if (!Number.isFinite(rawValue) || rawValue < 0) {
    return 3;
  }

  return Math.floor(rawValue);
}

function resolveTransientRetryDelayMs(retryCount: number, configManager: ConfigManager): number {
  const rawBaseSeconds = Number(configManager.get('runner.transientRetryBaseDelaySeconds'));
  const rawMaxSeconds = Number(configManager.get('runner.transientRetryMaxDelaySeconds'));
  const baseSeconds = Number.isFinite(rawBaseSeconds) && rawBaseSeconds > 0
    ? rawBaseSeconds
    : 15;
  const maxSeconds = Number.isFinite(rawMaxSeconds) && rawMaxSeconds > 0
    ? rawMaxSeconds
    : 180;
  const exponent = Math.max(retryCount - 1, 0);
  const jitterRatio = 0.8 + (Math.random() * 0.4);
  const computedMs = Math.min(baseSeconds * (2 ** exponent), maxSeconds) * 1000;

  return Math.max(1000, Math.round(computedMs * jitterRatio));
}

function normalizeErrorSignature(message?: string): string | undefined {
  const normalized = (message || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);

  return normalized || undefined;
}

function buildMergeRepairErrorSignature(conflictFiles?: string[], message?: string): string {
  if (conflictFiles?.length) {
    return [...new Set(conflictFiles)].sort().join('\n');
  }

  return normalizeErrorSignature(message) || 'merge_conflict';
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function getStoryAttempts(task: Task, storyId: string): number {
  return task.storyProgress?.find((story) => story.id === storyId)?.attempts ?? 0;
}

function getStoryProgress(task: Task, storyId: string): StoryProgress | undefined {
  return task.storyProgress?.find((story) => story.id === storyId);
}

function isFinalizerRepairAttempt(
  task: Pick<Task, 'finalizerAttempts' | 'mergeRepairAttempts' | 'mergeError' | 'repairContext'>,
  lastStoryError?: string,
): boolean {
  return Boolean(
    task.repairContext
    || 
    (task.finalizerAttempts ?? 0) > 0
    || (task.mergeRepairAttempts ?? 0) > 0
    || task.mergeError
    || /quality gate|finalizer|merge repair/i.test(lastStoryError || '')
  );
}

function reuseExistingStoryEvidenceForRepair(input: {
  task: Pick<Task, 'worktree' | 'baseCommitSha' | 'finalizerAttempts' | 'mergeRepairAttempts' | 'mergeError' | 'repairContext'>;
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
    headChanged: currentEvidence.headChanged,
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

function resolveStoryCompletionDecision(input: {
  storyId: string;
  isMergeRepairAttempt: boolean;
  hasObjectiveEvidence: boolean;
  progressReason: string;
  mergeRepairVerification?: {
    ok: boolean;
    message: string;
  };
}): {
  accepted: boolean;
  message: string;
  exactMergeabilityVerified: boolean;
} {
  if (input.isMergeRepairAttempt) {
    if (!input.mergeRepairVerification?.ok) {
      return {
        accepted: false,
        message: input.mergeRepairVerification?.message
          || `Merge repair for ${input.storyId} did not pass the exact mergeability probe`,
        exactMergeabilityVerified: false,
      };
    }

    return {
      accepted: true,
      message: input.hasObjectiveEvidence
        ? `${input.progressReason}; ${input.mergeRepairVerification.message}`
        : input.mergeRepairVerification.message,
      exactMergeabilityVerified: true,
    };
  }

  if (!input.hasObjectiveEvidence) {
    return {
      accepted: false,
      message: `Agent reported success for ${input.storyId}, but Ralph found no objective diff or commit evidence`,
      exactMergeabilityVerified: false,
    };
  }

  return {
    accepted: true,
    message: input.progressReason,
    exactMergeabilityVerified: false,
  };
}

async function verifyMergeRepairReadiness(
  task: Task,
  configManager: Pick<ConfigManager, 'get'>,
  probeMergeability: typeof probeTaskWorktreeMergeability = probeTaskWorktreeMergeability,
): Promise<{
  ok: boolean;
  message: string;
  probeResult?: Awaited<ReturnType<typeof probeTaskWorktreeMergeability>>;
}> {
  const integrationPolicy = resolveIntegrationPolicy(configManager);

  try {
    const probeResult = await probeMergeability(task, integrationPolicy.targetBranch, {
      pullLatest: integrationPolicy.pullLatest,
      integrationWorktreeDir: integrationPolicy.integrationWorktreeDir,
      syncTargetBranch: false,
    });

    if (probeResult.alreadyIntegrated) {
      return {
        ok: true,
        message: `Exact mergeability probe reports ${task.id} is already integrated in ${probeResult.integrationBranch}`,
        probeResult,
      };
    }

    if (probeResult.mergeable) {
      return {
        ok: true,
        message: probeResult.sourceKind === 'resolved_pending_merge'
          || probeResult.worktreeMergeState?.kind === 'resolved_pending_commit'
          ? `Exact mergeability probe passed; task worktree is a resolved pending merge awaiting finalizer commit against ${probeResult.integrationBranch}`
          : `Exact mergeability probe passed against ${probeResult.integrationBranch}`,
        probeResult,
      };
    }

    const conflictSuffix = probeResult.conflictFiles?.length
      ? ` Conflict files: ${probeResult.conflictFiles.join(', ')}.`
      : '';

    return {
      ok: false,
      message: `Exact mergeability probe still fails against ${probeResult.integrationBranch}.${conflictSuffix} ${probeResult.message}`.trim(),
      probeResult,
    };
  } catch (error) {
    return {
      ok: false,
      message: `Exact mergeability probe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export {
  captureProgressBaseline,
  detectProgress,
  getChangedFilesCount,
  getCommitCount,
  getLatestCommitSHA,
  getWorktreeDiffSignature,
} from './core/worktree-progress';

export {
  verifyMergeRepairReadiness,
  resolveStoryCompletionDecision,
  evaluateTaskStoryCompletion,
  formatStoryCompletionInvariantMessage,
};

if (require.main === module) {
  const taskId = process.argv[2];
  if (!taskId) {
    console.error('Task ID required');
    process.exit(1);
  }

  runWorker(taskId);
}
