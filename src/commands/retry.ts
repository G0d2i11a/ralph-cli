import { StateManager } from '../core/state';
import { TaskScheduler } from '../core/scheduler';

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

    // Only allow retry for failed or stagnant tasks
    if (previousStatus !== 'failed' && previousStatus !== 'stagnant') {
      console.error(JSON.stringify({
        error: `Cannot retry task with status '${previousStatus}'. Only 'failed' or 'stagnant' tasks can be retried.`,
        taskId,
        currentStatus: previousStatus
      }));
      process.exit(1);
    }

    // Reset stagnation counters
    task.loopCount = 0;
    task.consecutiveNoProgress = 0;
    task.consecutiveErrors = 0;
    task.lastProgressTime = Date.now();
    task.lastError = undefined;
    task.status = 'pending';
    task.endTime = undefined;
    task.pid = undefined;
    task.currentUS = undefined;
    // sessionId is preserved for continuation

    await stateManager.saveTask(task);
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
      worktree: latestTask.worktree,
      logPath: latestTask.logPath
    }));
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    }));
    process.exit(1);
  }
}
