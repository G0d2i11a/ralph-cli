import { Task, TaskAutoRecoveryKind, TaskAutonomyRepairKind } from '../types/task';
import { isBaselineQualityGateStateCurrent } from './baseline-quality-gate';

export interface AutoRecoveryEvaluation {
  active: boolean;
  kind?: TaskAutoRecoveryKind | TaskAutonomyRepairKind;
  reason?: string;
  stoppedAt?: number;
  stopReason?: string;
  staleInvalidReason?: string;
}

export function resolveTaskRecoveryKind(
  task: Pick<Task, 'autoRecoveryKind' | 'autonomyRepairKind'>,
): TaskAutoRecoveryKind | TaskAutonomyRepairKind | undefined {
  return task.autoRecoveryKind ?? task.autonomyRepairKind;
}

function getTypedStop(
  task: Pick<
    Task,
    | 'autoRecoveryKind'
    | 'autonomyRepairKind'
    | 'failedBlockerRecoveryStoppedAt'
    | 'failedBlockerRecoveryStopReason'
    | 'storyRepairRecoveryStoppedAt'
    | 'storyRepairRecoveryStopReason'
    | 'transientRecoveryStoppedAt'
    | 'transientRecoveryStopReason'
    | 'agentContextRecoveryStoppedAt'
    | 'agentContextRecoveryStopReason'
    | 'mergeRepairRecoveryStoppedAt'
    | 'mergeRepairRecoveryStopReason'
    | 'finalizeRepairStoppedAt'
    | 'finalizeRepairStopReason'
    | 'baselineQualityGate'
    | 'autonomyRepairStoppedAt'
    | 'autonomyRepairStopReason'
  >,
): { stoppedAt?: number; stopReason?: string } {
  switch (task.autoRecoveryKind ?? task.autonomyRepairKind) {
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
    case 'agent_context':
      return {
        stoppedAt: task.agentContextRecoveryStoppedAt,
        stopReason: task.agentContextRecoveryStopReason,
      };
    case 'story_repair':
      return {
        stoppedAt: task.storyRepairRecoveryStoppedAt ?? task.failedBlockerRecoveryStoppedAt,
        stopReason: task.storyRepairRecoveryStopReason ?? task.failedBlockerRecoveryStopReason,
      };
    case 'finalize_repair':
      return {
        stoppedAt: task.finalizeRepairStoppedAt,
        stopReason: task.finalizeRepairStopReason,
      };
    case 'baseline_repair':
      return {
        stoppedAt: task.baselineQualityGate?.stoppedAt,
        stopReason: task.baselineQualityGate?.stopReason,
      };
    default:
      return {
        stoppedAt: task.autonomyRepairStoppedAt,
        stopReason: task.autonomyRepairStopReason,
      };
  }
}

export function evaluateAutoRecovery(
  task: Pick<
    Task,
    | 'status'
    | 'autoRecoveryKind'
    | 'autonomyRepairKind'
    | 'autoRecoveryStoppedAt'
    | 'autoRecoveryStopReason'
    | 'autoRecoveryNextEligibleAt'
    | 'autonomyRepairStoppedAt'
    | 'autonomyRepairStopReason'
    | 'autonomyRepairNextEligibleAt'
    | 'lastErrorKind'
    | 'lastErrorRetryable'
    | 'failedBlockerRecoveryStoppedAt'
    | 'failedBlockerRecoveryStopReason'
    | 'storyRepairRecoveryStoppedAt'
    | 'storyRepairRecoveryStopReason'
    | 'transientRecoveryStoppedAt'
    | 'transientRecoveryStopReason'
    | 'agentContextRecoveryStoppedAt'
    | 'agentContextRecoveryStopReason'
    | 'mergeRepairRecoveryStoppedAt'
    | 'mergeRepairRecoveryStopReason'
    | 'finalizeRepairStoppedAt'
    | 'finalizeRepairStopReason'
    | 'baselineQualityGate'
    | 'repoPath'
    | 'worktree'
    | 'finalizerFailure'
    | 'latestFailure'
  >,
  now = Date.now(),
): AutoRecoveryEvaluation {
  const recoveryKind = resolveTaskRecoveryKind(task);

  if (!recoveryKind) {
    return { active: false };
  }

  if (
    task.status === 'running'
    || task.status === 'ready_to_finalize'
    || task.status === 'finalizing'
  ) {
    return {
      active: false,
      kind: recoveryKind,
      staleInvalidReason: `task_${task.status}_not_waiting_for_recovery`,
    };
  }

  if (
    task.autoRecoveryKind === 'baseline_repair'
    && task.baselineQualityGate
    && !isBaselineQualityGateStateCurrent(task)
  ) {
    return {
      active: false,
      kind: recoveryKind,
      staleInvalidReason: 'stale_baseline_failure_signature',
    };
  }

  const stoppedAt = task.autoRecoveryStoppedAt ?? task.autonomyRepairStoppedAt;
  const stopReason = task.autoRecoveryStopReason ?? task.autonomyRepairStopReason;
  const nextEligibleAt = task.autoRecoveryNextEligibleAt ?? task.autonomyRepairNextEligibleAt;

  if (stoppedAt) {
    return {
      active: false,
      kind: recoveryKind,
      stoppedAt,
      stopReason,
    };
  }

  const typedStop = getTypedStop(task);

  if (typedStop.stoppedAt) {
    return {
      active: false,
      kind: recoveryKind,
      stoppedAt: typedStop.stoppedAt,
      stopReason: typedStop.stopReason,
      staleInvalidReason: 'typed_recovery_stopped',
    };
  }

  if (
    task.autoRecoveryKind
    && task.status === 'failed'
    && task.lastErrorKind === 'story_incomplete'
    && task.lastErrorRetryable === false
  ) {
    return {
      active: false,
      kind: recoveryKind,
      staleInvalidReason: 'semantic_story_incomplete_is_not_auto_recovering',
    };
  }

  if (task.autoRecoveryKind && task.status === 'failed' && task.lastErrorRetryable === false) {
    return {
      active: false,
      kind: recoveryKind,
      staleInvalidReason: 'non_retryable_failed_task',
    };
  }

  if (nextEligibleAt && nextEligibleAt > now) {
    return {
      active: true,
      kind: recoveryKind,
      reason: 'cooldown',
    };
  }

  return {
    active: true,
    kind: recoveryKind,
    reason: !task.autoRecoveryKind && task.autonomyRepairKind ? 'autonomy_repair' : undefined,
  };
}
