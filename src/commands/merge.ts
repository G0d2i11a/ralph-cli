import { StateManager } from '../core/state';
import { mergeBranch, MergeStrategy } from '../core/merge';
import { appendTaskEvent } from '../core/events';
import { buildFailedMergeTaskUpdates, buildSuccessfulMergeTaskUpdates } from '../core/merge-task-updates';
import { withIntegrationLaneLock } from '../core/locks';
import { findCoordinationBlockers, resolveTaskIntegrationLane } from '../core/task-coordination';
import {
  buildStoryCompletionInvariantFailureUpdates,
  evaluateTaskStoryCompletion,
  formatStoryCompletionInvariantMessage,
} from '../core/story-completion';

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

    const storyCompletion = evaluateTaskStoryCompletion(task);
    if (!storyCompletion.allStoriesPassed) {
      const message = formatStoryCompletionInvariantMessage(task.id, 'integrate', storyCompletion);
      await stateManager.updateTask(taskId, buildStoryCompletionInvariantFailureUpdates(message));
      appendTaskEvent(task, {
        type: 'story_completion_invariant_failed',
        status: task.status,
        message,
        data: {
          phase: 'integrate',
          incompleteStories: storyCompletion.incompleteStories,
        },
      });
      console.error(JSON.stringify({
        success: false,
        error: message,
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

    const integrationLane = resolveTaskIntegrationLane(task, targetBranch);
    const result = await withIntegrationLaneLock(task.repoPath, integrationLane, async () => {
      const latestTask = await stateManager.loadTask(taskId);
      if (!latestTask) {
        throw new Error(`Task ${taskId} not found before merge`);
      }

      const coordinationState = findCoordinationBlockers(
        latestTask,
        await stateManager.listTasks(),
        'merge',
        { targetBranch },
      );
      await stateManager.updateTask(taskId, {
        integrationLane,
        ...coordinationState.taskUpdates,
      });
      if (coordinationState.blocked) {
        appendTaskEvent(latestTask, {
          type: 'coordination_blocked',
          status: latestTask.status,
          message: coordinationState.reason,
          data: {
            phase: coordinationState.phase,
            blockers: coordinationState.blockers,
            lane: coordinationState.lane,
          },
        });
        console.error(JSON.stringify({
          success: false,
          blocked: true,
          blockers: coordinationState.blockers,
          phase: coordinationState.phase,
          lane: coordinationState.lane,
          message: coordinationState.reason,
        }));
        process.exit(1);
      }

      return mergeBranch(latestTask, targetBranch, strategy);
    });

    if (result.success) {
      await stateManager.updateTask(taskId, buildSuccessfulMergeTaskUpdates(
        result,
        targetBranch,
        strategy,
      ));
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
      await stateManager.updateTask(taskId, buildFailedMergeTaskUpdates(
        result,
        targetBranch,
        strategy,
      ));
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
