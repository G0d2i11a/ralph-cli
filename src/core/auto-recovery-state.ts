import { Task, TaskAutoRecoveryKind } from '../types/task';

export interface AutoRecoveryEvaluation {
  active: boolean;
  kind?: TaskAutoRecoveryKind;
  reason?: string;
  stoppedAt?: number;
  stopReason?: string;
  staleInvalidReason?: string;
}

function getTypedStop(
  task: Pick<
    Task,
    | 'autoRecoveryKind'
    | 'failedBlockerRecoveryStoppedAt'
    | 'failedBlockerRecoveryStopReason'
    | 'transientRecoveryStoppedAt'
    | 'transientRecoveryStopReason'
    | 'mergeRepairRecoveryStoppedAt'
    | 'mergeRepairRecoveryStopReason'
    | 'finalizeRepairStoppedAt'
    | 'finalizeRepairStopReason'
  >,
): { stoppedAt?: number; stopReason?: string } {
  switch (task.autoRecoveryKind) {
    case 'merge_repair':
      return {
        stoppedAt: task.mergeRepairRecoveryStoppedAt,
        stopReason: task.mergeRepairRecoveryStopReason,
      };
    case 'transient':
      return {
        stoppedAt: task.transientRecoveryStoppedAt,
        stopReason: task.transientRecoveryStopReason,
      };
    case 'story_repair':
      return {
        stoppedAt: task.failedBlockerRecoveryStoppedAt,
        stopReason: task.failedBlockerRecoveryStopReason,
      };
    case 'finalize_repair':
      return {
        stoppedAt: task.finalizeRepairStoppedAt,
        stopReason: task.finalizeRepairStopReason,
      };
    default:
      return {};
  }
}

export function evaluateAutoRecovery(
  task: Pick<
    Task,
    | 'status'
    | 'autoRecoveryKind'
    | 'autoRecoveryStoppedAt'
    | 'autoRecoveryStopReason'
    | 'autoRecoveryNextEligibleAt'
    | 'lastErrorKind'
    | 'lastErrorRetryable'
    | 'failedBlockerRecoveryStoppedAt'
    | 'failedBlockerRecoveryStopReason'
    | 'transientRecoveryStoppedAt'
    | 'transientRecoveryStopReason'
    | 'mergeRepairRecoveryStoppedAt'
    | 'mergeRepairRecoveryStopReason'
    | 'finalizeRepairStoppedAt'
    | 'finalizeRepairStopReason'
  >,
  now = Date.now(),
): AutoRecoveryEvaluation {
  if (!task.autoRecoveryKind) {
    return { active: false };
  }

  if (task.autoRecoveryStoppedAt) {
    return {
      active: false,
      kind: task.autoRecoveryKind,
      stoppedAt: task.autoRecoveryStoppedAt,
      stopReason: task.autoRecoveryStopReason,
    };
  }

  const typedStop = getTypedStop(task);

  if (typedStop.stoppedAt) {
    return {
      active: false,
      kind: task.autoRecoveryKind,
      stoppedAt: typedStop.stoppedAt,
      stopReason: typedStop.stopReason,
      staleInvalidReason: 'typed_recovery_stopped',
    };
  }

  if (task.status === 'failed' && task.lastErrorKind === 'story_incomplete' && task.lastErrorRetryable === false) {
    return {
      active: false,
      kind: task.autoRecoveryKind,
      staleInvalidReason: 'semantic_story_incomplete_is_not_auto_recovering',
    };
  }

  if (task.status === 'failed' && task.lastErrorRetryable === false) {
    return {
      active: false,
      kind: task.autoRecoveryKind,
      staleInvalidReason: 'non_retryable_failed_task',
    };
  }

  if (task.autoRecoveryNextEligibleAt && task.autoRecoveryNextEligibleAt > now) {
    return {
      active: true,
      kind: task.autoRecoveryKind,
      reason: 'cooldown',
    };
  }

  return {
    active: true,
    kind: task.autoRecoveryKind,
  };
}
