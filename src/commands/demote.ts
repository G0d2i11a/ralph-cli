import { appendTaskEvent } from '../core/events';
import {
  buildQuarantineReleaseUpdates,
  formatQuarantineReleaseReason,
  isQuarantineOwnershipReleased,
} from '../core/quarantine';
import { TaskScheduler } from '../core/scheduler';
import { StateManager } from '../core/state';
import {
  hasHotConflictReservation,
  isHotConflictQuarantineOwner,
} from '../core/task-coordination';

type DemoteCommandOptions = {
  reason?: string;
  to?: string;
};

export async function demoteCommand(taskId: string, options: DemoteCommandOptions = {}): Promise<void> {
  try {
    const stateManager = new StateManager();
    const task = await stateManager.loadTask(taskId);

    if (!task) {
      console.error(JSON.stringify({ error: `Task ${taskId} not found` }));
      process.exit(1);
    }

    if (!hasHotConflictReservation(task)) {
      console.error(JSON.stringify({
        error: `Task ${taskId} is not holding merge-repair quarantine context`,
        taskId,
        currentStatus: task.status,
      }));
      process.exit(1);
    }

    const reason = options.reason?.trim() || 'Merge-repair quarantine demoted by explicit user request';
    const transferredTo = options.to?.trim() || undefined;

    if (!isHotConflictQuarantineOwner(task) && isQuarantineOwnershipReleased(task)) {
      console.log(JSON.stringify({
        success: true,
        taskId,
        alreadyReleased: true,
        currentStatus: task.status,
        quarantine: {
          exitKind: task.quarantineExitKind,
          releasedAt: task.quarantineReleasedAt,
          reason: task.quarantineReleaseReason,
          transferredTo: task.quarantineTransferredTo,
        },
      }));
      return;
    }

    const releasedAt = Date.now();
    const updates = buildQuarantineReleaseUpdates('demote', reason, releasedAt, transferredTo);
    await stateManager.updateTask(taskId, {
      ...updates,
      autoRecoveryStoppedAt: releasedAt,
      autoRecoveryStopReason: 'merge_repair_quarantine_demoted',
      autoRecoveryLastReason: reason,
      mergeRepairRecoveryStoppedAt: releasedAt,
      mergeRepairRecoveryStopReason: 'merge_repair_quarantine_demoted',
    });

    const latestTask = await stateManager.loadTask(taskId);
    appendTaskEvent(latestTask || task, {
      type: 'merge_repair_quarantine_demoted',
      status: latestTask?.status || task.status,
      message: formatQuarantineReleaseReason({
        ...task,
        ...updates,
      }),
      data: {
        reason,
        transferredTo,
        conflictFiles: task.mergeConflictFiles,
      },
    });

    await new TaskScheduler({ stateManager }).schedulePendingTasks();

    console.log(JSON.stringify({
      success: true,
      taskId,
      previousStatus: task.status,
      currentStatus: latestTask?.status || task.status,
      quarantineReleased: true,
      quarantineReleaseReason: reason,
      transferredTo,
    }));
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exit(1);
  }
}
