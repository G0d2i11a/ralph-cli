import { StateManager } from '../core/state';
import { finalizeTask } from '../core/scheduler';
import { isProcessRunning } from '../utils/helpers';

function signalTaskProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    const processError = error as NodeJS.ErrnoException;
    if (processError.code !== 'ESRCH' && processError.code !== 'EPERM' && processError.code !== 'EINVAL') {
      throw processError;
    }
  }

  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    const processError = error as NodeJS.ErrnoException;
    if (processError.code === 'ESRCH') {
      return false;
    }

    throw processError;
  }
}

export async function stopCommand(taskId: string): Promise<void> {
  try {
    const stateManager = new StateManager();
    const task = await stateManager.loadTask(taskId);
    
    if (!task) {
      console.error(JSON.stringify({ error: `Task ${taskId} not found` }));
      process.exit(1);
    }
    
    if (!task.pid) {
      console.error(JSON.stringify({ error: 'No PID found for task' }));
      process.exit(1);
    }
    
    if (!isProcessRunning(task.pid)) {
      console.log(JSON.stringify({ 
        message: 'Process already stopped',
        taskId 
      }));
      await finalizeTask(task, 'failed', { stateManager });
      return;
    }
    
    // Send SIGTERM
    try {
      signalTaskProcess(task.pid, 'SIGTERM');
      
      // Wait a bit and check if it stopped
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      if (isProcessRunning(task.pid)) {
        // Force kill if still running
        signalTaskProcess(task.pid, 'SIGKILL');
      }
      
      await finalizeTask(task, 'failed', { stateManager });
      
      console.log(JSON.stringify({
        message: 'Task stopped',
        taskId
      }));
      
    } catch (error) {
      console.error(JSON.stringify({
        error: `Failed to stop process: ${error}`
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
