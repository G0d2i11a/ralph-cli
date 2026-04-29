import { StateManager } from '../core/state';
import { TaskScheduler } from '../core/scheduler';
import { StoryProgress, Task } from '../types/task';
import { buildMergeRepairReason, buildTaskRepairContext } from '../core/repair-context';
import { buildFinalizeRetryReset } from '../core/task-reset';
import {
  evaluateTaskStoryCompletion,
  formatStoryCompletionInvariantMessage,
} from '../core/story-completion';

const RETRYABLE_STATUSES = new Set(['failed', 'stagnant', 'failed_finalize']);
type RetryCommandOptions = { finalizeOnly?: boolean };

function hasMergeConflict(task: Pick<Task, 'mergeConflictFiles' | 'mergeError' | 'lastError'>): boolean {
  if (task.mergeConflictFiles?.length) {
    return true;
  }

  return /merge conflicts detected/i.test(task.mergeError || task.lastError || '');
}

function isCompletedBlockedConflictTask(task: Pick<Task, 'status' | 'integrationStatus' | 'mergeConflictFiles' | 'mergeError' | 'lastError'>): boolean {
  return task.status === 'completed'
    && task.integrationStatus === 'blocked_conflict'
    && hasMergeConflict(task);
}

function selectMergeRepairStoryId(task: Pick<Task, 'storyProgress' | 'completedUS'>): string | undefined {
  const needsRepairStory = task.storyProgress
    ?.slice()
    .reverse()
    .find((story) => story.status === 'needs_repair');

  if (needsRepairStory) {
    return needsRepairStory.id;
  }

  return task.storyProgress?.[task.storyProgress.length - 1]?.id
    || task.completedUS[task.completedUS.length - 1];
}

function resetFailedFinalizeMergeRepair(task: Task): {
  storyProgress: StoryProgress[] | undefined;
  completedUS: string[];
  resetStoryIds: string[];
  repairContext: Task['repairContext'];
} {
  const repairStoryId = selectMergeRepairStoryId(task);
  const updatedAt = Date.now();

  if (!repairStoryId) {
    return {
      storyProgress: task.storyProgress,
      completedUS: task.completedUS,
      resetStoryIds: [],
      repairContext: undefined,
    };
  }

  const repairMessage = buildMergeRepairReason(task);
  const storyProgress = (task.storyProgress || []).map((story) => {
    if (story.id !== repairStoryId) {
      return story;
    }

    return {
      ...story,
      status: 'pending' as const,
      attempts: 0,
      lastError: repairMessage,
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

  return {
    storyProgress,
    completedUS: task.completedUS.filter((storyId) => storyId !== repairStoryId),
    resetStoryIds: [repairStoryId],
    repairContext: buildTaskRepairContext({
      mode: 'merge',
      storyId: repairStoryId,
      reason: repairMessage,
      createdAt: updatedAt,
    }),
  };
}

function resetRetryableStoryProgress(task: Task): {
  storyProgress: StoryProgress[] | undefined;
  completedUS: string[];
  resetStoryIds: string[];
} {
  const resetStoryIds: string[] = [];
  const updatedAt = Date.now();
  const storyProgress = task.storyProgress?.map((story) => {
    if (
      story.status !== 'failed'
      && story.status !== 'needs_repair'
      && story.status !== 'in_progress'
    ) {
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

export async function retryCommand(taskId: string, options: RetryCommandOptions = {}) {
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
    const retryableCompletedConflict = isCompletedBlockedConflictTask(task);

    if (!RETRYABLE_STATUSES.has(previousStatus) && !retryableCompletedConflict) {
      console.error(JSON.stringify({
        error: `Cannot retry task with status '${previousStatus}'. Only 'failed', 'stagnant', 'failed_finalize', or 'completed' tasks blocked by merge conflicts can be retried.`,
        taskId,
        currentStatus: previousStatus
      }));
      process.exit(1);
    }

    if (options.finalizeOnly && previousStatus !== 'failed_finalize') {
      console.error(JSON.stringify({
        error: `Cannot use --finalize-only for task status '${previousStatus}'. Only 'failed_finalize' tasks can be retried this way.`,
        taskId,
        currentStatus: previousStatus,
      }));
      process.exit(1);
    }

    if (options.finalizeOnly) {
      const storyCompletion = evaluateTaskStoryCompletion(task);
      if (!storyCompletion.allStoriesPassed) {
        console.error(JSON.stringify({
          error: formatStoryCompletionInvariantMessage(task.id, 'finalize', storyCompletion),
          taskId,
          currentStatus: previousStatus,
        }));
        process.exit(1);
      }

      await stateManager.updateTask(taskId, {
        status: 'ready_to_finalize',
        endTime: undefined,
        pid: undefined,
        currentUS: undefined,
        leaseOwner: undefined,
        leaseHeartbeatAt: undefined,
        leaseExpiresAt: undefined,
        loopCount: 0,
        consecutiveNoProgress: 0,
        consecutiveErrors: 0,
        lastProgressTime: Date.now(),
        lastError: undefined,
        lastErrorKind: undefined,
        lastErrorClass: undefined,
        lastErrorRetryable: undefined,
        lastErrorObservedAt: undefined,
        lastErrorSignature: undefined,
        lastErrorHadObjectiveProgress: undefined,
        transientRetryCount: 0,
        transientRetryBudget: undefined,
        transientRetryLastDelayMs: undefined,
        ...buildFinalizeRetryReset(),
      });

      const latestTask = await stateManager.loadTask(taskId);
      if (!latestTask) {
        throw new Error(`Task ${taskId} not found after finalize-only retry`);
      }

      console.log(JSON.stringify({
        success: true,
        taskId,
        previousStatus,
        currentStatus: latestTask.status,
        finalizeOnly: true,
        completedUS: latestTask.completedUS.length,
        resetStoryIds: [],
        worktree: latestTask.worktree,
        logPath: latestTask.logPath,
        sessionId: latestTask.sessionId,
        threadId: latestTask.threadId,
      }));
      return;
    }

    const retryFromMergeConflict = (
      previousStatus === 'failed'
      || previousStatus === 'failed_finalize'
      || retryableCompletedConflict
      || previousStatus === 'stagnant'
    ) && hasMergeConflict(task);
    const retryProgress = retryFromMergeConflict
      ? resetFailedFinalizeMergeRepair(task)
      : {
          ...resetRetryableStoryProgress(task),
          repairContext: undefined,
        };
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
      lastErrorKind: undefined,
      lastErrorClass: undefined,
      lastErrorRetryable: undefined,
      lastErrorObservedAt: undefined,
      lastErrorSignature: undefined,
      lastErrorHadObjectiveProgress: undefined,
      transientRetryCount: 0,
      transientRetryBudget: undefined,
      transientRetryLastDelayMs: undefined,
      ...buildFinalizeRetryReset(),
      ...(previousStatus === 'failed_finalize' || retryableCompletedConflict
        ? {
            repairContext: retryProgress.repairContext,
          }
        : {
            repairContext: retryProgress.repairContext,
          }),
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
