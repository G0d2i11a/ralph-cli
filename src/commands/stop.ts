import { StateManager } from '../core/state';
import { finalizeTask } from '../core/scheduler';
import { Task } from '../types/task';
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

function buildOperatorStopRecoveryUpdates(task: Task, stoppedAt: number): Partial<Task> {
  const updates: Partial<Task> = {
    autoRecoveryNextEligibleAt: undefined,
    autoRecoveryStoppedAt: stoppedAt,
    autoRecoveryStopReason: 'operator_stopped',
    autoRecoveryLastReason: 'Task was explicitly stopped by operator',
  };

  switch (task.autoRecoveryKind) {
    case 'transient':
      updates.transientRecoveryNextEligibleAt = undefined;
      updates.transientRecoveryStoppedAt = stoppedAt;
      updates.transientRecoveryStopReason = 'operator_stopped';
      break;
    case 'agent_context':
      updates.agentContextRecoveryStoppedAt = stoppedAt;
      updates.agentContextRecoveryStopReason = 'operator_stopped';
      break;
    case 'story_repair':
      updates.storyRepairRecoveryStoppedAt = stoppedAt;
      updates.storyRepairRecoveryStopReason = 'operator_stopped';
      break;
    case 'merge_repair':
      updates.mergeRepairRecoveryStoppedAt = stoppedAt;
      updates.mergeRepairRecoveryStopReason = 'operator_stopped';
      break;
    case 'finalize_repair':
      updates.finalizeRepairStoppedAt = stoppedAt;
      updates.finalizeRepairStopReason = 'operator_stopped';
      break;
    case 'baseline_repair':
      updates.baselineQualityGate = task.baselineQualityGate
        ? {
            ...task.baselineQualityGate,
            stoppedAt,
            stopReason: 'operator_stopped',
            lastUpdatedAt: stoppedAt,
            phase: 'stopped',
          }
        : task.baselineQualityGate;
      break;
  }

  return updates;
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
      if (task.status === 'failed' || task.status === 'stagnant' || task.autoRecoveryKind) {
        const stoppedAt = Date.now();
        const recoveryUpdates = buildOperatorStopRecoveryUpdates(task, stoppedAt);
        await stateManager.updateTask(task.id, recoveryUpdates);
        console.log(JSON.stringify({
          message: 'Task recovery stopped',
          taskId,
        }));
        return;
      }

      console.error(JSON.stringify({ error: 'No PID found for task' }));
      process.exit(1);
    }
    
    if (!isProcessRunning(task.pid)) {
      console.log(JSON.stringify({ 
        message: 'Process already stopped',
        taskId 
      }));
      const stoppedAt = Date.now();
      const recoveryUpdates = buildOperatorStopRecoveryUpdates(task, stoppedAt);
      Object.assign(task, recoveryUpdates);
      await stateManager.updateTask(task.id, recoveryUpdates);
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

      const stoppedAt = Date.now();
      const recoveryUpdates = buildOperatorStopRecoveryUpdates(task, stoppedAt);
      Object.assign(task, recoveryUpdates);
      await stateManager.updateTask(task.id, recoveryUpdates);
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
