import { StateManager } from '../core/state';
import { TaskStatus } from '../types/task';
import { formatDuration, isProcessRunning } from '../utils/helpers';

export async function listCommand(options: { status?: string }): Promise<void> {
  try {
    const stateManager = new StateManager();
    const statusFilter = options.status as TaskStatus | undefined;
    
    const tasks = await stateManager.listTasks(statusFilter);
    
    const output = tasks.map(task => ({
      id: task.id,
      status: task.status,
      agent: task.agent,
      prdPath: task.prdPath,
      startTime: new Date(task.startTime).toISOString(),
      duration: task.endTime 
        ? formatDuration(task.endTime - task.startTime)
        : formatDuration(Date.now() - task.startTime),
      currentUS: task.currentUS,
      completedUS: task.completedUS.length,
      running: task.pid ? isProcessRunning(task.pid) : false
    }));
    
    console.log(JSON.stringify({ tasks: output }));
    
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    }));
    process.exit(1);
  }
}
