import { StateManager } from '../core/state';
import * as path from 'path';
import { fork } from 'child_process';

export async function retryCommand(taskId: string) {
  const stateManager = new StateManager();

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
    task.status = 'running';

    await stateManager.saveTask(task);

    // Restart agent worker
    const workerPath = path.join(__dirname, '../worker.js');
    const child = fork(workerPath, [taskId], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();

    // Update task with new PID
    task.pid = child.pid;
    await stateManager.saveTask(task);

    console.log(JSON.stringify({
      success: true,
      taskId,
      previousStatus,
      currentStatus: 'running',
      completedUS: task.completedUS.length,
      worktree: task.worktree,
      logPath: task.logPath
    }));
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    }));
    process.exit(1);
  }
}
