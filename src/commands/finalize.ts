import { ConfigManager } from '../config/manager';
import { finalizeTaskOutput } from '../core/finalizer';
import { appendTaskEvent } from '../core/events';
import { isQualityGateFailure } from '../core/finalize-failure-classifier';
import {
  resolveIntegrationPolicy,
  shouldAttemptAutomaticIntegration,
} from '../core/integration-policy';
import { withIntegrationLaneLock, withTaskFinalizeLock } from '../core/locks';
import { mergeBranch, probeTaskWorktreeMergeability } from '../core/merge';
import {
  buildMergeFailureUpdates,
  createMergeFailureError,
  formatDestructiveAutoResolveError,
  getTaskUpdatesFromError,
  isDestructiveMergeStrategy,
} from '../core/merge-policy';
import { buildSuccessfulMergeTaskUpdates } from '../core/merge-task-updates';
import {
  buildStoryCompletionInvariantFailureUpdates,
  evaluateTaskStoryCompletion,
  formatStoryCompletionInvariantMessage,
} from '../core/story-completion';
import {
  evaluateFinalizeRepairFailure,
  resolveFinalizeRepairConfig,
} from '../core/finalize-repair-policy';
import { buildTaskRepairContext } from '../core/repair-context';
import {
  createCoordinationBlockedError,
  findCoordinationBlockers,
  isCoordinationBlockedError,
  resolveTaskIntegrationLane,
} from '../core/task-coordination';
import { StateManager } from '../core/state';
import { TaskScheduler } from '../core/scheduler';
import { Task } from '../types/task';

function resolveFinalizerLeaseTimeoutMs(value: unknown): number {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return 30 * 60 * 1000;
  }

  return numericValue * 1000;
}

function hasMergeConflictFiles(input: { mergeConflictFiles?: string[] } | undefined): boolean {
  return Boolean(input?.mergeConflictFiles?.length);
}

function requiresPostFinalizeMergeProbe(task: Pick<Task, 'postFinalizeMergeProbeRequired' | 'repairContext' | 'mergeRepairAttempts' | 'mergeConflictFiles' | 'mergeError'>): boolean {
  return task.postFinalizeMergeProbeRequired === true
    || task.repairContext?.mode === 'merge'
    || Boolean(task.mergeRepairAttempts && task.mergeRepairAttempts > 0)
    || Boolean(task.mergeConflictFiles?.length)
    || /Merge conflicts detected/i.test(task.mergeError || '');
}

function selectRepairStoryId(
  task: Pick<Task, 'completedUS' | 'storyProgress'>,
  mergeConflict: boolean,
): string | undefined {
  if (mergeConflict) {
    const needsRepairStory = (task.storyProgress || [])
      .slice()
      .reverse()
      .find((story) => story.status === 'needs_repair');
    if (needsRepairStory) {
      return needsRepairStory.id;
    }
  }

  return task.completedUS[task.completedUS.length - 1]
    || task.storyProgress?.[task.storyProgress.length - 1]?.id;
}

export async function finalizeCommand(taskId: string): Promise<void> {
  const stateManager = new StateManager();
  const scheduler = new TaskScheduler({ stateManager });
  const configManager = new ConfigManager();
  const integrationPolicy = resolveIntegrationPolicy(configManager);

  try {
    const output = await withTaskFinalizeLock(taskId, async () => {
      const task = await stateManager.loadTask(taskId);
      if (!task) {
        console.error(JSON.stringify({ error: `Task ${taskId} not found` }));
        process.exit(1);
      }

      if (task.status !== 'ready_to_finalize' && task.status !== 'failed_finalize') {
        console.error(JSON.stringify({
          error: `Task ${taskId} is not ready to finalize (status: ${task.status})`,
        }));
        process.exit(1);
      }

      const targetBranch = integrationPolicy.targetBranch;
      const integrationLane = resolveTaskIntegrationLane(task, targetBranch);

      return withIntegrationLaneLock(task.repoPath, integrationLane, async () => {
        const reloadedTask = await stateManager.loadTask(taskId);
        if (!reloadedTask) {
          throw new Error(`Task ${taskId} not found before entering integration lane`);
        }

        const coordinationState = findCoordinationBlockers(
          reloadedTask,
          await stateManager.listTasks(),
          'finalize',
          { targetBranch },
        );
        await stateManager.updateTask(taskId, {
          integrationLane,
          ...coordinationState.taskUpdates,
        });
        if (coordinationState.blocked) {
          appendTaskEvent(reloadedTask, {
            type: 'coordination_blocked',
            status: reloadedTask.status,
            message: coordinationState.reason,
            data: {
              phase: coordinationState.phase,
              blockers: coordinationState.blockers,
              lane: coordinationState.lane,
            },
          });
          throw createCoordinationBlockedError(coordinationState);
        }

        const storyCompletion = evaluateTaskStoryCompletion(reloadedTask);
        if (!storyCompletion.allStoriesPassed) {
          const observedAt = Date.now();
          const message = formatStoryCompletionInvariantMessage(reloadedTask.id, 'finalize', storyCompletion);
          await stateManager.updateTask(taskId, {
            status: 'failed',
            endTime: observedAt,
            pid: undefined,
            currentUS: undefined,
            leaseOwner: undefined,
            leaseHeartbeatAt: undefined,
            leaseExpiresAt: undefined,
            ...buildStoryCompletionInvariantFailureUpdates(message, observedAt),
          });
          appendTaskEvent(reloadedTask, {
            type: 'story_completion_invariant_failed',
            status: 'failed',
            message,
            data: {
              phase: 'finalize',
              incompleteStories: storyCompletion.incompleteStories,
            },
          });
          return {
            success: false,
            taskId,
            status: 'failed',
            error: message,
          };
        }

        const finalizingAt = Date.now();
        const leaseTimeoutMs = resolveFinalizerLeaseTimeoutMs(
          configManager.get('finalizer.leaseTimeout') ?? configManager.get('finalizer.qualityGateTimeout')
        );

        await stateManager.updateTask(taskId, {
          status: 'finalizing',
          pid: undefined,
          currentUS: undefined,
          endTime: undefined,
          leaseOwner: `finalizer:${process.pid}`,
          leaseHeartbeatAt: finalizingAt,
          leaseExpiresAt: finalizingAt + leaseTimeoutMs,
        });
        appendTaskEvent(reloadedTask, {
          type: 'finalizer_started',
          status: 'finalizing',
          message: 'Restricted finalizer started',
        });

        const latestTask = await stateManager.loadTask(taskId);
        if (!latestTask) {
          throw new Error(`Task ${taskId} not found after entering finalizing state`);
        }

        const result = finalizeTaskOutput(latestTask);
        const finalizerCommittedAt = result.committed ? Date.now() : undefined;

        if (requiresPostFinalizeMergeProbe(latestTask)) {
          const mergeProbeResult = await probeTaskWorktreeMergeability(latestTask, targetBranch, {
            pullLatest: integrationPolicy.pullLatest,
            integrationWorktreeDir: integrationPolicy.integrationWorktreeDir,
            syncTargetBranch: false,
          });

          if (!mergeProbeResult.alreadyIntegrated && !mergeProbeResult.mergeable) {
            const mergeFailureResult = {
              success: false,
              hasConflicts: Boolean(mergeProbeResult.conflictFiles?.length),
              message: mergeProbeResult.message,
              conflictFiles: mergeProbeResult.conflictFiles,
              integrationBranch: mergeProbeResult.integrationBranch,
              integrationWorktree: mergeProbeResult.integrationWorktree,
              sourceBranch: `ralph/${latestTask.id}`,
              targetBranch: latestTask.integrationBranch || `ralph/integration/${integrationLane}`,
              baseCommitSha: latestTask.baseCommitSha,
            };

            throw createMergeFailureError(
              mergeFailureResult,
              buildMergeFailureUpdates(mergeFailureResult, targetBranch, integrationPolicy.strategy),
            );
          }
        }

        await stateManager.updateTask(taskId, {
          status: 'completed',
          endTime: Date.now(),
          finalizerCommitMessage: result.commitMessage,
          finalizerCommitSha: result.commitSha,
          finalizerCommittedAt,
          finalizerFailure: undefined,
          repairContext: undefined,
          finalizeRepairStartedAt: undefined,
          finalizeRepairDeadlineAt: undefined,
          finalizeRepairLastFailureSnapshot: undefined,
          finalizeRepairLastProgressAt: undefined,
          finalizeRepairLastProgressReason: undefined,
          finalizeRepairConsecutiveNoProgress: 0,
          finalizeRepairTotalRequeues: 0,
          finalizeRepairStoppedAt: undefined,
          finalizeRepairStopReason: undefined,
          lastError: undefined,
          lastErrorKind: undefined,
          lastErrorClass: undefined,
          lastErrorRetryable: undefined,
          lastErrorObservedAt: undefined,
          mergeError: undefined,
          mergeConflictFiles: undefined,
          mergeConflictAt: undefined,
          postFinalizeMergeProbeRequired: undefined,
          leaseOwner: undefined,
          leaseHeartbeatAt: undefined,
          leaseExpiresAt: undefined,
          integrationLane,
          ...coordinationState.taskUpdates,
        });
        appendTaskEvent(latestTask, {
          type: 'finalizer_completed',
          status: 'completed',
          message: result.message,
          data: {
            committed: result.committed,
            commitSha: result.commitSha,
            commitMessage: result.commitMessage,
          },
        });

        let mergeUpdates = {};
        let integrationFailure;
        if (shouldAttemptAutomaticIntegration(integrationPolicy)) {
          try {
            if (
              isDestructiveMergeStrategy(integrationPolicy.strategy)
              && !integrationPolicy.allowDestructiveAutoResolve
            ) {
              throw new Error(formatDestructiveAutoResolveError(integrationPolicy.strategy));
            }

            appendTaskEvent(latestTask, {
              type: 'merge_started',
              message: `Merging into ${targetBranch} (${integrationPolicy.strategy})`,
              data: { targetBranch, strategy: integrationPolicy.strategy },
            });

            const mergeResult = await mergeBranch(latestTask, targetBranch, integrationPolicy.strategy, {
              pullLatest: integrationPolicy.pullLatest,
              useIntegrationWorktree: integrationPolicy.useIntegrationWorktree,
              integrationWorktreeDir: integrationPolicy.integrationWorktreeDir,
              syncTargetBranch: integrationPolicy.syncTargetBranch,
            });

            if (!mergeResult.success) {
              const failureUpdates = buildMergeFailureUpdates(
                mergeResult,
                targetBranch,
                integrationPolicy.strategy,
              );
              await stateManager.updateTask(taskId, failureUpdates);
              appendTaskEvent(latestTask, {
                type: 'merge_failed',
                message: mergeResult.message,
                data: {
                  targetBranch,
                  strategy: integrationPolicy.strategy,
                  hasConflicts: mergeResult.hasConflicts,
                  conflictFiles: mergeResult.conflictFiles,
                },
              });
              integrationFailure = {
                success: false,
                taskId,
                status: 'completed',
                integrationLane,
                blocked: mergeResult.hasConflicts,
                error: mergeResult.message,
                delivery: failureUpdates,
              };
            } else {
              mergeUpdates = buildSuccessfulMergeTaskUpdates(
                mergeResult,
                targetBranch,
                integrationPolicy.strategy,
              );
              await stateManager.updateTask(taskId, mergeUpdates);
              appendTaskEvent(latestTask, {
                type: 'merge_completed',
                message: mergeResult.message,
                data: {
                  targetBranch,
                  strategy: integrationPolicy.strategy,
                  commitSha: mergeResult.commitSha,
                },
              });
            }
          } catch (error) {
            const failureMessage = error instanceof Error ? error.message : String(error);
            const failureUpdates = {
              mergeTargetBranch: targetBranch,
              mergeStrategy: integrationPolicy.strategy,
              mergeMessage: undefined,
              mergeError: failureMessage,
              mergeConflictFiles: undefined,
              mergeConflictAt: undefined,
              integrationStatus: 'failed' as const,
              targetSyncStatus: 'not_requested' as const,
              targetSyncDeferredReason: undefined,
              coordinationStatus: undefined,
              coordinationPhase: undefined,
              coordinationBlockers: undefined,
              coordinationReason: undefined,
            };
            await stateManager.updateTask(taskId, failureUpdates);
            appendTaskEvent(latestTask, {
              type: 'merge_failed',
              message: failureMessage,
              data: {
                targetBranch,
                strategy: integrationPolicy.strategy,
                hasConflicts: false,
              },
            });
            integrationFailure = {
              success: false,
              taskId,
              status: 'completed',
              integrationLane,
              blocked: false,
              error: failureMessage,
              delivery: failureUpdates,
            };
          }
        }

        const successOutput = {
          success: true,
          taskId,
          status: 'completed',
          committed: result.committed,
          commitMessage: result.commitMessage,
          message: result.message,
          integrationLane,
          ...mergeUpdates,
        };

        return integrationFailure ?? successOutput;
      });
    });

    await scheduler.schedulePendingTasks();

    console.log(JSON.stringify(output));
    if (!output.success) {
      process.exitCode = 1;
    }
  } catch (error) {
    if (isCoordinationBlockedError(error)) {
      console.error(JSON.stringify({
        success: false,
        taskId,
        blocked: true,
        blockers: error.blockerTaskIds,
        phase: error.coordination?.phase,
        lane: error.coordination?.lane,
        error: error.message,
      }));
      process.exit(1);
    }

    const latestTask = await stateManager.loadTask(taskId).catch(() => null);
    const finalizerAttempts = (latestTask?.finalizerAttempts ?? 0) + 1;
    const failureUpdates = getTaskUpdatesFromError(error);
    const finalizerFailure = isQualityGateFailure(error) ? error.details : undefined;
    const failureMessage = error instanceof Error ? error.message : String(error);
    const observedAt = Date.now();
    const repairConfig = resolveFinalizeRepairConfig(configManager);
    const repairFailureState = latestTask
      ? evaluateFinalizeRepairFailure({
          ...latestTask,
          lastError: failureMessage,
          mergeError: failureMessage,
          finalizerFailure,
          ...failureUpdates,
        }, repairConfig, observedAt)
      : undefined;
    const mergeConflict = hasMergeConflictFiles(failureUpdates)
      || hasMergeConflictFiles(latestTask ?? undefined);
    const repairStoryId = latestTask
      ? selectRepairStoryId(latestTask, mergeConflict)
      : undefined;
    const repairContext = repairStoryId
      ? buildTaskRepairContext({
          storyId: repairStoryId,
          mode: mergeConflict ? 'merge' : 'finalize',
          reason: failureMessage,
          createdAt: observedAt,
        })
      : undefined;
    await stateManager.updateTask(taskId, {
      status: 'failed_finalize',
      endTime: observedAt,
      lastError: failureMessage,
      lastErrorKind: finalizerFailure
        ? 'quality_gate_failure'
        : failureUpdates.mergeConflictFiles?.length
          ? 'merge_conflict'
          : 'finalizer_failed',
      lastErrorClass: finalizerFailure
        ? 'quality_gate'
        : failureUpdates.mergeConflictFiles?.length
          ? 'merge_conflict'
          : 'unknown',
      lastErrorRetryable: false,
      lastErrorObservedAt: observedAt,
      mergeError: failureMessage,
      finalizerAttempts,
      finalizerFailure,
      repairContext,
      postFinalizeMergeProbeRequired: failureUpdates.postFinalizeMergeProbeRequired
        ?? latestTask?.postFinalizeMergeProbeRequired,
      pid: undefined,
      currentUS: undefined,
      leaseOwner: undefined,
      leaseHeartbeatAt: undefined,
      leaseExpiresAt: undefined,
      ...(repairFailureState
        ? {
            finalizeRepairStartedAt: repairFailureState.startedAt,
            finalizeRepairDeadlineAt: repairFailureState.deadlineAt,
            finalizeRepairLastFailureSnapshot: repairFailureState.snapshot,
            finalizeRepairLastProgressAt: repairFailureState.lastProgressAt,
            finalizeRepairLastProgressReason: repairFailureState.lastProgressReason,
            finalizeRepairConsecutiveNoProgress: repairFailureState.consecutiveNoProgress,
          }
        : {}),
      ...failureUpdates,
    }).catch(() => undefined);
    if (latestTask) {
      appendTaskEvent(latestTask, {
        type: 'finalizer_failed',
        status: 'failed_finalize',
        message: failureMessage,
        data: {
          finalizerAttempts,
          repairPolicy: repairConfig.repairPolicy,
          repairMode: repairContext?.mode,
          repairStoryId,
          consecutiveNoProgress: repairFailureState?.consecutiveNoProgress,
          progressReason: repairFailureState?.lastProgressReason,
          finalizerFailureClass: finalizerFailure?.class,
          finalizerFailureGate: finalizerFailure?.gate,
          finalizerFailurePackage: finalizerFailure?.packageLabel,
          diagnosticCount: finalizerFailure?.diagnosticCount,
          conflictFiles: failureUpdates.mergeConflictFiles,
        },
      });
    }

    console.error(JSON.stringify({
      success: false,
      taskId,
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exit(1);
  }
}
