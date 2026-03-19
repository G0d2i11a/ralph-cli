import { StateManager } from '../core/state';
import { finalizeTaskOutput } from '../core/finalizer';
import { TaskScheduler } from '../core/scheduler';

export async function finalizeCommand(taskId: string): Promise<void> {
  const stateManager = new StateManager();
  const scheduler = new TaskScheduler({ stateManager });

  try {
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

    await stateManager.updateTask(taskId, {
      status: 'finalizing',
      pid: undefined,
      currentUS: undefined,
      endTime: undefined,
    });

    const latestTask = await stateManager.loadTask(taskId);
    if (!latestTask) {
      throw new Error(`Task ${taskId} not found after entering finalizing state`);
    }

    const result = finalizeTaskOutput(latestTask);

    await stateManager.updateTask(taskId, {
      status: 'completed',
      endTime: Date.now(),
      finalizerCommitMessage: result.commitMessage,
      finalizerCommittedAt: result.committed ? Date.now() : undefined,
    });

    await scheduler.schedulePendingTasks();

    console.log(JSON.stringify({
      success: true,
      taskId,
      status: 'completed',
      committed: result.committed,
      commitMessage: result.commitMessage,
      message: result.message,
    }));
  } catch (error) {
    await stateManager.updateTask(taskId, {
      status: 'failed_finalize',
      endTime: Date.now(),
      lastError: error instanceof Error ? error.message : String(error),
      pid: undefined,
      currentUS: undefined,
    }).catch(() => undefined);

    console.error(JSON.stringify({
      success: false,
      taskId,
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exit(1);
  }
}
