import { StateManager } from '../core/state';
import { mergeBranch, MergeStrategy } from '../core/merge';

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
      strategy
    }));
    
    const result = await mergeBranch(task, targetBranch, strategy);
    
    if (result.success) {
      await stateManager.updateTask(taskId, { status: 'completed' });
      console.log(JSON.stringify({
        success: true,
        message: result.message
      }));
    } else {
      console.error(JSON.stringify({
        success: false,
        hasConflicts: result.hasConflicts,
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
