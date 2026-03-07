import { StateManager } from '../core/state';

export async function resetStagnationCommand(taskId: string) {
  const stateManager = new StateManager();

  try {
    const task = await stateManager.loadTask(taskId);
    if (!task) {
      console.error(JSON.stringify({ error: `Task ${taskId} not found` }));
      process.exit(1);
    }

    // Reset stagnation counters
    task.loopCount = 0;
    task.consecutiveNoProgress = 0;
    task.consecutiveErrors = 0;
    task.lastProgressTime = Date.now();

    await stateManager.saveTask(task);

    console.log(JSON.stringify({
      success: true,
      taskId,
      message: 'Stagnation counters reset'
    }));
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    }));
    process.exit(1);
  }
}
