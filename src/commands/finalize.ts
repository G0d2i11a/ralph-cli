import { ConfigManager } from '../config/manager';
import { finalizeTaskOutput } from '../core/finalizer';
import { appendTaskEvent } from '../core/events';
import { withTaskFinalizeLock } from '../core/locks';
import { mergeBranch, MergeStrategy } from '../core/merge';
import { StateManager } from '../core/state';
import { TaskScheduler } from '../core/scheduler';

function resolveMergeStrategy(value: unknown): MergeStrategy {
  return value === 'ours' || value === 'theirs' || value === 'manual'
    ? value
    : 'manual';
}

function resolveMergeTargetBranch(value: unknown): string {
  if (typeof value !== 'string') {
    return 'main';
  }

  const trimmed = value.trim();
  return trimmed || 'main';
}

function resolveFinalizerLeaseTimeoutMs(value: unknown): number {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return 30 * 60 * 1000;
  }

  return numericValue * 1000;
}

export async function finalizeCommand(taskId: string): Promise<void> {
  const stateManager = new StateManager();
  const scheduler = new TaskScheduler({ stateManager });
  const configManager = new ConfigManager();

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
      appendTaskEvent(task, {
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

      let mergeUpdates = {};
      if (Boolean(configManager.get('autoMerge'))) {
        const targetBranch = resolveMergeTargetBranch(configManager.get('merge.targetBranch'));
        const strategy = resolveMergeStrategy(configManager.get('merge.strategy'));
        const pullLatest = configManager.get('merge.pullLatest') !== false;
        const configuredIntegrationDir = configManager.get('merge.integrationWorktreeDir');
        const mergeResult = await mergeBranch(latestTask, targetBranch, strategy, {
          pullLatest,
          useIntegrationWorktree: configManager.get('merge.useIntegrationWorktree') !== false,
          integrationWorktreeDir: typeof configuredIntegrationDir === 'string' && configuredIntegrationDir.trim()
            ? configuredIntegrationDir.trim()
            : undefined,
          syncTargetBranch: configManager.get('merge.syncTargetBranch') !== false,
        });

        if (!mergeResult.success) {
          throw new Error(mergeResult.message);
        }

        mergeUpdates = {
          mergedAt: Date.now(),
          integratedAt: Date.now(),
          mergeCommitSha: mergeResult.commitSha,
          integrationCommitSha: mergeResult.commitSha,
          integrationBranch: mergeResult.integrationBranch,
          integrationWorktree: mergeResult.integrationWorktree,
          mergeTargetBranch: targetBranch,
          mergeStrategy: strategy,
          mergeMessage: mergeResult.message,
          mergeError: undefined,
          targetSyncedAt: mergeResult.targetSynced ? Date.now() : undefined,
          targetSyncDeferredReason: mergeResult.targetSynced === false ? mergeResult.targetSyncMessage : undefined,
        };
      }

      await stateManager.updateTask(taskId, {
        status: 'completed',
        endTime: Date.now(),
        finalizerCommitMessage: result.commitMessage,
        finalizerCommittedAt,
        leaseOwner: undefined,
        leaseHeartbeatAt: undefined,
        leaseExpiresAt: undefined,
        ...mergeUpdates,
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

      return {
        success: true,
        taskId,
        status: 'completed',
        committed: result.committed,
        commitMessage: result.commitMessage,
        message: result.message,
        ...mergeUpdates,
      };
    });

    await scheduler.schedulePendingTasks();

    console.log(JSON.stringify(output));
  } catch (error) {
    const latestTask = await stateManager.loadTask(taskId).catch(() => null);
    const finalizerAttempts = (latestTask?.finalizerAttempts ?? 0) + 1;
    await stateManager.updateTask(taskId, {
      status: 'failed_finalize',
      endTime: Date.now(),
      lastError: error instanceof Error ? error.message : String(error),
      mergeError: error instanceof Error ? error.message : String(error),
      finalizerAttempts,
      pid: undefined,
      currentUS: undefined,
      leaseOwner: undefined,
      leaseHeartbeatAt: undefined,
      leaseExpiresAt: undefined,
    }).catch(() => undefined);
    if (latestTask) {
      appendTaskEvent(latestTask, {
        type: 'finalizer_failed',
        status: 'failed_finalize',
        message: error instanceof Error ? error.message : String(error),
        data: { finalizerAttempts },
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
