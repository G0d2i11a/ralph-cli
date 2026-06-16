import { appendTaskEvent } from '../core/events';
import { StateManager } from '../core/state';
import { Task, TaskStatus } from '../types/task';

interface ArchiveOptions {
  reason?: string;
}

const ARCHIVABLE_STATUSES = new Set<TaskStatus>([
  'failed',
  'failed_finalize',
  'stagnant',
]);

export async function archiveCommand(taskId: string, options: ArchiveOptions = {}): Promise<void> {
  const stateManager = new StateManager();

  try {
    const task = await stateManager.loadTask(taskId);
    if (!task) {
      console.error(JSON.stringify({ error: `Task ${taskId} not found` }));
      process.exit(1);
    }

    if (task.status === 'archived') {
      console.log(JSON.stringify({
        success: true,
        taskId,
        previousStatus: 'archived',
        currentStatus: 'archived',
        message: 'Task already archived',
      }));
      return;
    }

    if (!ARCHIVABLE_STATUSES.has(task.status)) {
      console.error(JSON.stringify({
        error: `Cannot archive task with status '${task.status}'. Only failed, failed_finalize, or stagnant tasks can be archived.`,
        taskId,
        currentStatus: task.status,
      }));
      process.exit(1);
    }

    const archivedAt = Date.now();
    const previousStatus = task.status;
    const reason = options.reason?.trim() || 'operator_archived_terminal_task';
    const updates: Partial<Task> = {
      status: 'archived',
      archivedAt,
      archivedReason: reason,
      archivedFromStatus: previousStatus,
      endTime: task.endTime || archivedAt,
      pid: undefined,
      leaseOwner: undefined,
      leaseHeartbeatAt: undefined,
      leaseExpiresAt: undefined,
      autoRecoveryNextEligibleAt: undefined,
      autoRecoveryStoppedAt: archivedAt,
      autoRecoveryStopReason: 'operator_archived',
      autoRecoveryLastReason: reason,
    };

    await stateManager.updateTask(taskId, updates);
    const archivedTask = await stateManager.loadTask(taskId);
    appendTaskEvent(archivedTask || { ...task, ...updates }, {
      type: 'task_archived',
      status: 'archived',
      message: reason,
      data: {
        previousStatus,
      },
    });

    console.log(JSON.stringify({
      success: true,
      taskId,
      previousStatus,
      currentStatus: 'archived',
      archivedAt,
      reason,
    }));
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exit(1);
  }
}
