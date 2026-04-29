import { StateManager } from '../core/state';
import { finalizeTask, TaskScheduler } from '../core/scheduler';
import { appendTaskEvent } from '../core/events';
import { buildQuarantineReleaseUpdates } from '../core/quarantine';
import { hasHotConflictReservation } from '../core/task-coordination';
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

type StopCommandOptions = { reason?: string };

async function releaseStoppedQuarantine(
  stateManager: StateManager,
  taskId: string,
  reason: string,
): Promise<void> {
  const latestTask = await stateManager.loadTask(taskId);
  if (!latestTask) {
    return;
  }

  await stateManager.updateTask(taskId, buildQuarantineReleaseUpdates('stop', reason));
  const releasedTask = await stateManager.loadTask(taskId);
  appendTaskEvent(releasedTask || latestTask, {
    type: 'merge_repair_quarantine_released',
    status: releasedTask?.status || latestTask.status,
    message: reason,
    data: {
      exitKind: 'stop',
      conflictFiles: latestTask.mergeConflictFiles,
    },
  });

  await new TaskScheduler({ stateManager }).schedulePendingTasks();
}

export async function stopCommand(taskId: string, options: StopCommandOptions = {}): Promise<void> {
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

    const releaseQuarantine = hasHotConflictReservation(task);
    const releaseReason = options.reason?.trim()
      || 'Task stopped by explicit user request';
    
    if (!isProcessRunning(task.pid)) {
      await finalizeTask(task, 'failed', { stateManager });
      if (releaseQuarantine) {
        await releaseStoppedQuarantine(stateManager, taskId, releaseReason);
      }

      console.log(JSON.stringify({ 
        message: 'Process already stopped',
        taskId,
        quarantineReleased: releaseQuarantine,
        quarantineReleaseReason: releaseQuarantine ? releaseReason : undefined,
      }));
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
      if (releaseQuarantine) {
        await releaseStoppedQuarantine(stateManager, taskId, releaseReason);
      }
      
      console.log(JSON.stringify({
        message: 'Task stopped',
        taskId,
        quarantineReleased: releaseQuarantine,
        quarantineReleaseReason: releaseQuarantine ? releaseReason : undefined,
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
