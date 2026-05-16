import { StateManager } from '../core/state';
import { buildQuarantineReleaseUpdates } from '../core/quarantine';
import { hasHotConflictReservation } from '../core/task-coordination';

export async function demoteCommand(
  taskId: string,
  options: { reason?: string; to?: string } = {},
): Promise<void> {
  try {
    const stateManager = new StateManager();
    const task = await stateManager.loadTask(taskId);

    if (!task) {
      console.error(JSON.stringify({ error: `Task ${taskId} not found` }));
      process.exit(1);
    }

    const reason = options.reason?.trim() || 'Merge-repair quarantine demoted by operator';
    const quarantineReleased = hasHotConflictReservation(task);
    const updates = quarantineReleased
      ? buildQuarantineReleaseUpdates('demote', reason, Date.now(), options.to)
      : {};

    if (quarantineReleased) {
      await stateManager.updateTask(taskId, updates);
    }

    console.log(JSON.stringify({
      taskId,
      quarantineReleased,
      reason,
      transferredTo: options.to,
    }));
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exit(1);
  }
}
