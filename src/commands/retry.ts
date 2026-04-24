import { StateManager } from '../core/state';
import { TaskScheduler } from '../core/scheduler';
import { StoryProgress, Task } from '../types/task';

const RETRYABLE_STATUSES = new Set(['failed', 'stagnant', 'failed_finalize']);

function resetRetryableStoryProgress(task: Task): {
  storyProgress: StoryProgress[] | undefined;
  completedUS: string[];
  resetStoryIds: string[];
} {
  const resetStoryIds: string[] = [];
  const updatedAt = Date.now();
  const storyProgress = task.storyProgress?.map((story) => {
    if (story.status !== 'failed' && story.status !== 'needs_repair') {
      return story;
    }

    resetStoryIds.push(story.id);
    return {
      ...story,
      status: 'pending' as const,
      attempts: 0,
      updatedAt,
      history: [
        ...(story.history || []),
        {
          attempt: story.attempts,
          status: 'pending' as const,
          message: 'Reset for explicit retry',
          updatedAt,
        },
      ],
    };
  });

  const resetStoryIdSet = new Set(resetStoryIds);
  return {
    storyProgress,
    completedUS: task.completedUS.filter((storyId) => !resetStoryIdSet.has(storyId)),
    resetStoryIds,
  };
}

export async function retryCommand(taskId: string) {
  const stateManager = new StateManager();
  const scheduler = new TaskScheduler({ stateManager });

  try {
    const task = await stateManager.loadTask(taskId);
    if (!task) {
      console.error(JSON.stringify({ error: `Task ${taskId} not found` }));
      process.exit(1);
    }

    const previousStatus = task.status;

    // Only retry terminal failure states. ready_to_finalize/finalizing are handled by manager/finalizer.
    if (!RETRYABLE_STATUSES.has(previousStatus)) {
      console.error(JSON.stringify({
        error: `Cannot retry task with status '${previousStatus}'. Only 'failed', 'stagnant', or 'failed_finalize' tasks can be retried.`,
        taskId,
        currentStatus: previousStatus
      }));
      process.exit(1);
    }

    const retryProgress = resetRetryableStoryProgress(task);
    await stateManager.updateTask(taskId, {
      status: 'pending',
      endTime: undefined,
      pid: undefined,
      currentUS: undefined,
      completedUS: retryProgress.completedUS,
      storyProgress: retryProgress.storyProgress,
      leaseOwner: undefined,
      leaseHeartbeatAt: undefined,
      leaseExpiresAt: undefined,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastError: undefined,
      finalizerAttempts: previousStatus === 'failed_finalize' ? 0 : task.finalizerAttempts,
      mergeError: previousStatus === 'failed_finalize' ? undefined : task.mergeError,
      mergeConflictFiles: previousStatus === 'failed_finalize' ? undefined : task.mergeConflictFiles,
      mergeConflictAt: previousStatus === 'failed_finalize' ? undefined : task.mergeConflictAt,
      mergeRepairAttempts: previousStatus === 'failed_finalize' ? 0 : task.mergeRepairAttempts,
    });
    await scheduler.schedulePendingTasks();

    const latestTask = await stateManager.loadTask(taskId);
    if (!latestTask) {
      throw new Error(`Task ${taskId} not found after retry scheduling`);
    }

    if (latestTask.status !== 'running' && latestTask.status !== 'pending') {
      throw new Error(`Task ${taskId} could not be rescheduled (status: ${latestTask.status})`);
    }

    const pendingState = latestTask.status === 'pending'
      ? await scheduler.describePendingTask(latestTask)
      : null;

    console.log(JSON.stringify({
      success: true,
      taskId,
      previousStatus,
      currentStatus: latestTask.status,
      reason: pendingState?.reason,
      dependencies: pendingState?.dependencies,
      concurrencyLimit: pendingState?.maxConcurrent,
      completedUS: latestTask.completedUS.length,
      resetStoryIds: retryProgress.resetStoryIds,
      worktree: latestTask.worktree,
      logPath: latestTask.logPath,
      sessionId: latestTask.sessionId,
      threadId: latestTask.threadId
    }));
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    }));
    process.exit(1);
  }
}
