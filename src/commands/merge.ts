import { StateManager } from '../core/state';
import { mergeBranch, MergeStrategy } from '../core/merge';
import { appendTaskEvent } from '../core/events';

export async function mergeCommand(
  taskId: string,
  options: { auto?: boolean; strategy?: string; target?: string }
): Promise<void> {
  try {
    const stateManager = new StateManager();
    const task = await stateManager.loadTask(taskId);

    if (!task) {
      console.error(JSON.stringify({
        error: `Task ${taskId} not found`
      }));
      process.exit(1);
    }

    if (task.status !== 'completed') {
      console.error(JSON.stringify({
        error: `Task ${taskId} is not completed (status: ${task.status})`
      }));
      process.exit(1);
    }

    const strategy = (options.strategy || 'manual') as MergeStrategy;
    const targetBranch = options.target || 'main';

    if (!options.auto && strategy !== 'manual') {
      console.error(JSON.stringify({
        error: 'Auto-resolve strategy requires --auto flag'
      }));
      process.exit(1);
    }

    console.log(JSON.stringify({
      message: `Merging task ${taskId} into ${targetBranch}...`,
      strategy,
      ...(options.auto && strategy !== 'manual'
        ? {
            warning: `${strategy} resolves every conflicted path by choosing one side; use only when that data loss risk is acceptable.`,
          }
        : {}),
    }));
    appendTaskEvent(task, {
      type: 'merge_started',
      message: `Merging into ${targetBranch} (${strategy})`,
      data: { targetBranch, strategy },
    });

    const result = await mergeBranch(task, targetBranch, strategy);

    if (result.success) {
      await stateManager.updateTask(taskId, {
        status: 'completed',
        mergedAt: Date.now(),
        integratedAt: Date.now(),
        mergeCommitSha: result.commitSha,
        integrationCommitSha: result.commitSha,
        integrationBranch: result.integrationBranch,
        integrationWorktree: result.integrationWorktree,
        mergeTargetBranch: targetBranch,
        mergeStrategy: strategy,
        mergeMessage: result.message,
        mergeError: undefined,
        mergeConflictFiles: undefined,
        mergeConflictAt: undefined,
        targetSyncedAt: result.targetSynced ? Date.now() : undefined,
        targetSyncDeferredReason: result.targetSynced === false ? result.targetSyncMessage : undefined,
      });
      appendTaskEvent(task, {
        type: 'merge_completed',
        message: result.message,
        data: { targetBranch, strategy, commitSha: result.commitSha },
      });
      console.log(JSON.stringify({
        success: true,
        message: result.message,
        commitSha: result.commitSha,
      }));
    } else {
      await stateManager.updateTask(taskId, {
        mergeTargetBranch: targetBranch,
        mergeStrategy: strategy,
        mergeError: result.message,
        integrationBranch: result.integrationBranch,
        integrationWorktree: result.integrationWorktree,
        mergeConflictFiles: result.conflictFiles,
        mergeConflictAt: result.hasConflicts ? Date.now() : undefined,
      });
      appendTaskEvent(task, {
        type: 'merge_failed',
        message: result.message,
        data: {
          targetBranch,
          strategy,
          hasConflicts: result.hasConflicts,
          conflictFiles: result.conflictFiles,
        },
      });
      console.error(JSON.stringify({
        success: false,
        hasConflicts: result.hasConflicts,
        conflictFiles: result.conflictFiles,
        message: result.message
      }));
      process.exit(1);
    }

  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    }));
    process.exit(1);
  }
}
