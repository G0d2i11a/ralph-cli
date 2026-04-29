import { Task, TaskIntegrationStatus, TaskTargetSyncStatus } from '../types/task';
import { evaluateAutoRecovery } from './auto-recovery-state';

function toIsoTimestamp(value?: number): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}

type TaskIntegrationInput = Pick<Task, 'integrationStatus' | 'integratedAt'>
  & Partial<Pick<Task, 'integrationCommitSha' | 'mergedAt' | 'mergeCommitSha'>>;

export interface DerivedTaskDeliveryStatus {
  integrationStatus: TaskIntegrationStatus;
  hasIntegrationMarker: boolean;
  inconsistent: boolean;
  source: 'explicit' | 'marker' | 'none';
}

export function deriveTaskDeliveryStatus(task: TaskIntegrationInput): DerivedTaskDeliveryStatus {
  const hasIntegrationMarker = Boolean(
    task.integratedAt
    || task.integrationCommitSha
    || task.mergedAt
    || task.mergeCommitSha
  );

  if (task.integrationStatus) {
    return {
      integrationStatus: task.integrationStatus,
      hasIntegrationMarker,
      inconsistent: task.integrationStatus !== 'integrated' && hasIntegrationMarker,
      source: 'explicit',
    };
  }

  return {
    integrationStatus: hasIntegrationMarker ? 'integrated' : 'not_started',
    hasIntegrationMarker,
    inconsistent: false,
    source: hasIntegrationMarker ? 'marker' : 'none',
  };
}

export function resolveTaskIntegrationStatus(
  task: TaskIntegrationInput,
): TaskIntegrationStatus {
  return deriveTaskDeliveryStatus(task).integrationStatus;
}

export function resolveTaskTargetSyncStatus(
  task: Pick<Task, 'targetSyncStatus' | 'targetSyncedAt' | 'targetSyncDeferredReason' | 'mergeMessage'>,
): TaskTargetSyncStatus {
  if (task.targetSyncStatus) {
    return task.targetSyncStatus;
  }

  if (task.targetSyncedAt) {
    return 'synced';
  }

  const deferredReason = task.targetSyncDeferredReason || task.mergeMessage || '';
  if (/sync deferred/i.test(deferredReason)) {
    return 'deferred_dirty_checkout';
  }

  if (/target sync disabled|sync disabled/i.test(deferredReason)) {
    return 'disabled';
  }

  return 'not_requested';
}

export function buildDeliveryState(task: Pick<
  Task,
  | 'integratedAt'
  | 'integrationStatus'
  | 'integrationCommitSha'
  | 'integrationBranch'
  | 'integrationWorktree'
  | 'mergedAt'
  | 'targetSyncedAt'
  | 'targetSyncStatus'
  | 'targetSyncDeferredReason'
  | 'mergeTargetBranch'
  | 'mergeStrategy'
  | 'mergeCommitSha'
  | 'mergeMessage'
  | 'mergeError'
>) {
  const deliveryStatus = deriveTaskDeliveryStatus(task);

  return {
    integrationStatus: deliveryStatus.integrationStatus,
    integrationStatusSource: deliveryStatus.source,
    integrationInconsistent: deliveryStatus.inconsistent,
    hasIntegrationMarker: deliveryStatus.hasIntegrationMarker,
    integratedAt: toIsoTimestamp(task.integratedAt),
    integrationCommitSha: task.integrationCommitSha,
    integrationBranch: task.integrationBranch,
    integrationWorktree: task.integrationWorktree,
    mergedAt: toIsoTimestamp(task.mergedAt),
    targetSyncStatus: resolveTaskTargetSyncStatus(task),
    targetSyncedAt: toIsoTimestamp(task.targetSyncedAt),
    targetSyncDeferredReason: task.targetSyncDeferredReason,
    mergeTargetBranch: task.mergeTargetBranch,
    mergeStrategy: task.mergeStrategy,
    mergeCommitSha: task.mergeCommitSha,
    mergeMessage: task.mergeMessage,
    mergeError: task.mergeError,
  };
}

export function buildTransientRetryState(task: Pick<
  Task,
  | 'transientRetryCount'
  | 'transientRetryBudget'
  | 'transientRetryLastDelayMs'
  | 'lastErrorKind'
  | 'lastErrorClass'
  | 'lastErrorRetryable'
  | 'lastErrorObservedAt'
>) {
  const hasRetryState = task.transientRetryCount !== undefined
    || task.transientRetryBudget !== undefined
    || task.transientRetryLastDelayMs !== undefined
    || task.lastErrorKind !== undefined
    || task.lastErrorClass !== undefined
    || task.lastErrorRetryable !== undefined
    || task.lastErrorObservedAt !== undefined;

  if (!hasRetryState) {
    return undefined;
  }

  return {
    count: task.transientRetryCount ?? 0,
    budget: task.transientRetryBudget,
    lastDelayMs: task.transientRetryLastDelayMs,
    lastErrorKind: task.lastErrorKind,
    lastErrorClass: task.lastErrorClass,
    lastErrorRetryable: task.lastErrorRetryable,
    lastErrorObservedAt: toIsoTimestamp(task.lastErrorObservedAt),
  };
}

export function buildAutoRecoveryState(task: Pick<
  Task,
  | 'autoRecoveryKind'
  | 'autoRecoveryTotalRequeues'
  | 'autoRecoveryHardCap'
  | 'autoRecoveryLastRequeuedAt'
  | 'autoRecoveryNextEligibleAt'
  | 'autoRecoveryStoppedAt'
  | 'autoRecoveryStopReason'
  | 'autoRecoveryLastReason'
  | 'status'
  | 'lastErrorKind'
  | 'lastErrorRetryable'
  | 'failedBlockerRecoveryStartedAt'
  | 'failedBlockerRecoveryDeadlineAt'
  | 'failedBlockerRecoveryTotalRequeues'
  | 'failedBlockerRecoveryLastSignature'
  | 'failedBlockerRecoveryStoppedAt'
  | 'failedBlockerRecoveryStopReason'
  | 'failedBlockerRecoveryDemandTaskIds'
  | 'transientRecoveryStartedAt'
  | 'transientRecoveryDeadlineAt'
  | 'transientRecoveryTotalRequeues'
  | 'transientRecoveryConsecutiveSameSignature'
  | 'transientRecoveryLastFailureKind'
  | 'transientRecoveryLastFailureClass'
  | 'transientRecoveryLastFailureSignature'
  | 'transientRecoveryLastDelayMs'
  | 'transientRecoveryNextEligibleAt'
  | 'transientRecoveryStoppedAt'
  | 'transientRecoveryStopReason'
  | 'mergeRepairRecoveryStartedAt'
  | 'mergeRepairRecoveryDeadlineAt'
  | 'mergeRepairRecoveryTotalRequeues'
  | 'mergeRepairRecoveryConsecutiveNoProgress'
  | 'mergeRepairRecoveryLastConflictSignature'
  | 'mergeRepairRecoveryLastProbeMessage'
  | 'mergeRepairRecoveryLastProgressReason'
  | 'mergeRepairRecoveryStoppedAt'
  | 'mergeRepairRecoveryStopReason'
  | 'finalizeRepairStoppedAt'
  | 'finalizeRepairStopReason'
>) {
  const hasRecoveryState = task.autoRecoveryKind !== undefined
    || task.autoRecoveryNextEligibleAt !== undefined
    || task.autoRecoveryStoppedAt !== undefined
    || task.failedBlockerRecoveryStoppedAt !== undefined
    || task.failedBlockerRecoveryTotalRequeues !== undefined
    || task.transientRecoveryNextEligibleAt !== undefined
    || task.transientRecoveryStoppedAt !== undefined
    || task.mergeRepairRecoveryStoppedAt !== undefined
    || task.mergeRepairRecoveryLastConflictSignature !== undefined;

  if (!hasRecoveryState) {
    return undefined;
  }

  const recoveryEvaluation = evaluateAutoRecovery(task);

  return {
    kind: task.autoRecoveryKind,
    active: recoveryEvaluation.active,
    reason: recoveryEvaluation.reason,
    staleInvalidReason: recoveryEvaluation.staleInvalidReason,
    totalRequeues: task.autoRecoveryTotalRequeues ?? 0,
    hardCap: task.autoRecoveryHardCap,
    lastRequeuedAt: toIsoTimestamp(task.autoRecoveryLastRequeuedAt),
    nextEligibleAt: toIsoTimestamp(task.autoRecoveryNextEligibleAt),
    stoppedAt: toIsoTimestamp(recoveryEvaluation.stoppedAt ?? task.autoRecoveryStoppedAt),
    stopReason: recoveryEvaluation.stopReason ?? task.autoRecoveryStopReason,
    lastReason: task.autoRecoveryLastReason,
    failedBlocker: (
      task.failedBlockerRecoveryStartedAt !== undefined
      || task.failedBlockerRecoveryDeadlineAt !== undefined
      || task.failedBlockerRecoveryTotalRequeues !== undefined
      || task.failedBlockerRecoveryLastSignature !== undefined
      || task.failedBlockerRecoveryStoppedAt !== undefined
    )
      ? {
          startedAt: toIsoTimestamp(task.failedBlockerRecoveryStartedAt),
          deadlineAt: toIsoTimestamp(task.failedBlockerRecoveryDeadlineAt),
          totalRequeues: task.failedBlockerRecoveryTotalRequeues ?? 0,
          lastSignature: task.failedBlockerRecoveryLastSignature,
          stoppedAt: toIsoTimestamp(task.failedBlockerRecoveryStoppedAt),
          stopReason: task.failedBlockerRecoveryStopReason,
          demandTaskIds: task.failedBlockerRecoveryDemandTaskIds,
        }
      : undefined,
    transient: (
      task.transientRecoveryStartedAt !== undefined
      || task.transientRecoveryDeadlineAt !== undefined
      || task.transientRecoveryTotalRequeues !== undefined
      || task.transientRecoveryLastFailureSignature !== undefined
      || task.transientRecoveryNextEligibleAt !== undefined
      || task.transientRecoveryStoppedAt !== undefined
    )
      ? {
          startedAt: toIsoTimestamp(task.transientRecoveryStartedAt),
          deadlineAt: toIsoTimestamp(task.transientRecoveryDeadlineAt),
          totalRequeues: task.transientRecoveryTotalRequeues ?? 0,
          consecutiveSameSignature: task.transientRecoveryConsecutiveSameSignature ?? 0,
          lastFailureKind: task.transientRecoveryLastFailureKind,
          lastFailureClass: task.transientRecoveryLastFailureClass,
          lastFailureSignature: task.transientRecoveryLastFailureSignature,
          lastDelayMs: task.transientRecoveryLastDelayMs,
          nextEligibleAt: toIsoTimestamp(task.transientRecoveryNextEligibleAt),
          stoppedAt: toIsoTimestamp(task.transientRecoveryStoppedAt),
          stopReason: task.transientRecoveryStopReason,
        }
      : undefined,
    mergeRepair: (
      task.mergeRepairRecoveryStartedAt !== undefined
      || task.mergeRepairRecoveryDeadlineAt !== undefined
      || task.mergeRepairRecoveryTotalRequeues !== undefined
      || task.mergeRepairRecoveryLastConflictSignature !== undefined
      || task.mergeRepairRecoveryStoppedAt !== undefined
    )
      ? {
          startedAt: toIsoTimestamp(task.mergeRepairRecoveryStartedAt),
          deadlineAt: toIsoTimestamp(task.mergeRepairRecoveryDeadlineAt),
          totalRequeues: task.mergeRepairRecoveryTotalRequeues ?? 0,
          consecutiveNoProgress: task.mergeRepairRecoveryConsecutiveNoProgress ?? 0,
          lastConflictSignature: task.mergeRepairRecoveryLastConflictSignature,
          lastProbeMessage: task.mergeRepairRecoveryLastProbeMessage,
          lastProgressReason: task.mergeRepairRecoveryLastProgressReason,
          stoppedAt: toIsoTimestamp(task.mergeRepairRecoveryStoppedAt),
          stopReason: task.mergeRepairRecoveryStopReason,
        }
      : undefined,
  };
}
