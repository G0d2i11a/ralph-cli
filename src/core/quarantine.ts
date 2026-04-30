import { Task, TaskQuarantineExitKind } from '../types/task';

export function isQuarantineOwnershipReleased(task: Pick<
  Task,
  | 'quarantineExitKind'
  | 'quarantineReleasedAt'
>): boolean {
  return Boolean(task.quarantineExitKind && task.quarantineReleasedAt);
}

export function buildQuarantineReleaseUpdates(
  exitKind: TaskQuarantineExitKind,
  reason: string,
  releasedAt: number = Date.now(),
  transferredTo?: string,
): Partial<Task> {
  return {
    quarantineExitKind: exitKind,
    quarantineReleasedAt: releasedAt,
    quarantineReleaseReason: reason,
    quarantineTransferredTo: transferredTo,
  };
}

export function clearQuarantineReleaseUpdates(): Partial<Task> {
  return {
    quarantineExitKind: undefined,
    quarantineReleasedAt: undefined,
    quarantineReleaseReason: undefined,
    quarantineTransferredTo: undefined,
  };
}

export function buildQuarantineQueueState(task: Pick<
  Task,
  | 'quarantineExitKind'
  | 'quarantineReleasedAt'
  | 'quarantineReleaseReason'
  | 'quarantineTransferredTo'
>) {
  if (!isQuarantineOwnershipReleased(task)) {
    return undefined;
  }

  return {
    released: true,
    exitKind: task.quarantineExitKind,
    releasedAt: task.quarantineReleasedAt
      ? new Date(task.quarantineReleasedAt).toISOString()
      : undefined,
    reason: task.quarantineReleaseReason,
    transferredTo: task.quarantineTransferredTo,
  };
}

export function formatQuarantineReleaseReason(task: Pick<
  Task,
  | 'quarantineExitKind'
  | 'quarantineReleaseReason'
  | 'quarantineTransferredTo'
>): string {
  const exitLabel = task.quarantineExitKind === 'stop'
    ? 'stop'
    : task.quarantineExitKind === 'demote'
      ? 'demotion'
      : task.quarantineExitKind === 'already_integrated'
        ? 'already-integrated proof'
        : task.quarantineExitKind === 'exact_mergeability'
          ? 'exact mergeability proof'
          : 'explicit action';
  const transferLabel = task.quarantineTransferredTo
    ? `; ownership transferred to ${task.quarantineTransferredTo}`
    : '';
  const reasonLabel = task.quarantineReleaseReason
    ? `: ${task.quarantineReleaseReason}`
    : '';

  return `merge-repair quarantine released by ${exitLabel}${transferLabel}${reasonLabel}`;
}
