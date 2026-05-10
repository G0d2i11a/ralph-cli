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
  | 'autonomyRepairKind'
  | 'autonomyRepairStartedAt'
  | 'autonomyRepairDeadlineAt'
  | 'autonomyRepairTotalRequeues'
  | 'autonomyRepairLastSignature'
  | 'autonomyRepairLastProgressReason'
  | 'autonomyRepairLastRequeuedAt'
  | 'autonomyRepairNextEligibleAt'
  | 'autonomyRepairStoppedAt'
  | 'autonomyRepairStopReason'
  | 'autonomyRepairLastReason'
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
  | 'storyRepairRecoveryStartedAt'
  | 'storyRepairRecoveryDeadlineAt'
  | 'storyRepairRecoveryTotalRequeues'
  | 'storyRepairRecoveryLastSignature'
  | 'storyRepairRecoveryConsecutiveSameSignature'
  | 'storyRepairRecoveryStoppedAt'
  | 'storyRepairRecoveryStopReason'
  | 'storyRepairRecoveryDemandTaskIds'
  | 'transientRecoveryStartedAt'
  | 'transientRecoveryDeadlineAt'
  | 'transientRecoveryTotalRequeues'
  | 'transientRecoveryConsecutiveSameSignature'
  | 'transientRecoveryLastFailureKind'
  | 'transientRecoveryLastFailureClass'
  | 'transientRecoveryLastFailureSignature'
  | 'transientRecoveryLastFailureObservedAt'
  | 'transientRecoveryLastFailureStoryId'
  | 'transientRecoveryLastProgressReason'
  | 'transientRecoveryLastDelayMs'
  | 'transientRecoveryNextEligibleAt'
  | 'transientRecoveryStoppedAt'
  | 'transientRecoveryStopReason'
  | 'transientRecoveryLastHadObjectiveProgress'
  | 'agentContextRecoveryStartedAt'
  | 'agentContextRecoveryDeadlineAt'
  | 'agentContextRecoveryTotalRequeues'
  | 'agentContextRecoveryLastSignature'
  | 'agentContextRecoveryLastRequeuedStoryId'
  | 'agentContextRecoveryStoppedAt'
  | 'agentContextRecoveryStopReason'
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
  | 'baselineQualityGate'
  | 'baselineRepair'
  | 'repoPath'
  | 'worktree'
  | 'finalizerFailure'
  | 'latestFailure'
> & Partial<Pick<
  Task,
  | 'integratedAt'
  | 'integrationStatus'
  | 'integrationCommitSha'
  | 'mergedAt'
  | 'mergeCommitSha'
>>) {
  const hasRecoveryState = task.autoRecoveryKind !== undefined
    || task.autonomyRepairKind !== undefined
    || task.autoRecoveryNextEligibleAt !== undefined
    || task.autoRecoveryStoppedAt !== undefined
    || task.autonomyRepairNextEligibleAt !== undefined
    || task.autonomyRepairStoppedAt !== undefined
    || task.failedBlockerRecoveryStoppedAt !== undefined
    || task.failedBlockerRecoveryTotalRequeues !== undefined
    || task.storyRepairRecoveryStoppedAt !== undefined
    || task.storyRepairRecoveryTotalRequeues !== undefined
    || task.transientRecoveryNextEligibleAt !== undefined
    || task.transientRecoveryStoppedAt !== undefined
    || task.agentContextRecoveryTotalRequeues !== undefined
    || task.agentContextRecoveryLastSignature !== undefined
    || task.agentContextRecoveryStoppedAt !== undefined
    || task.mergeRepairRecoveryStoppedAt !== undefined
    || task.mergeRepairRecoveryLastConflictSignature !== undefined
    || task.baselineQualityGate !== undefined
    || task.baselineRepair !== undefined;

  if (!hasRecoveryState) {
    return undefined;
  }

  const recoveryEvaluation = evaluateAutoRecovery(task);
  const isTerminalIntegratedCompletion = task.status === 'completed'
    && resolveTaskIntegrationStatus(task) === 'integrated';
  const effectiveRecoveryEvaluation = isTerminalIntegratedCompletion
    ? {
        ...recoveryEvaluation,
        active: false,
        staleInvalidReason: recoveryEvaluation.staleInvalidReason
          ?? (recoveryEvaluation.active ? 'completed_integrated_task' : undefined),
      }
    : recoveryEvaluation;

  return {
    kind: task.autoRecoveryKind ?? task.autonomyRepairKind,
    active: effectiveRecoveryEvaluation.active,
    reason: effectiveRecoveryEvaluation.reason,
    staleInvalidReason: effectiveRecoveryEvaluation.staleInvalidReason,
    totalRequeues: task.autoRecoveryTotalRequeues ?? task.autonomyRepairTotalRequeues ?? 0,
    hardCap: task.autoRecoveryHardCap,
    lastRequeuedAt: toIsoTimestamp(task.autoRecoveryLastRequeuedAt ?? task.autonomyRepairLastRequeuedAt),
    nextEligibleAt: toIsoTimestamp(task.autoRecoveryNextEligibleAt ?? task.autonomyRepairNextEligibleAt),
    stoppedAt: toIsoTimestamp(
      effectiveRecoveryEvaluation.stoppedAt
      ?? task.autoRecoveryStoppedAt
      ?? task.autonomyRepairStoppedAt,
    ),
    stopReason: effectiveRecoveryEvaluation.stopReason
      ?? task.autoRecoveryStopReason
      ?? task.autonomyRepairStopReason,
    lastReason: task.autoRecoveryLastReason ?? task.autonomyRepairLastReason,
    autonomyRepair: task.autonomyRepairKind
      ? {
          kind: task.autonomyRepairKind,
          startedAt: toIsoTimestamp(task.autonomyRepairStartedAt),
          deadlineAt: toIsoTimestamp(task.autonomyRepairDeadlineAt),
          totalRequeues: task.autonomyRepairTotalRequeues ?? 0,
          lastSignature: task.autonomyRepairLastSignature,
          lastProgressReason: task.autonomyRepairLastProgressReason,
          lastRequeuedAt: toIsoTimestamp(task.autonomyRepairLastRequeuedAt),
          nextEligibleAt: toIsoTimestamp(task.autonomyRepairNextEligibleAt),
          stoppedAt: toIsoTimestamp(task.autonomyRepairStoppedAt),
          stopReason: task.autonomyRepairStopReason,
          lastReason: task.autonomyRepairLastReason,
        }
      : undefined,
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
    storyRepair: (
      task.storyRepairRecoveryStartedAt !== undefined
      || task.storyRepairRecoveryDeadlineAt !== undefined
      || task.storyRepairRecoveryTotalRequeues !== undefined
      || task.storyRepairRecoveryLastSignature !== undefined
      || task.storyRepairRecoveryStoppedAt !== undefined
    )
      ? {
          startedAt: toIsoTimestamp(task.storyRepairRecoveryStartedAt),
          deadlineAt: toIsoTimestamp(task.storyRepairRecoveryDeadlineAt),
          totalRequeues: task.storyRepairRecoveryTotalRequeues ?? 0,
          consecutiveSameSignature: task.storyRepairRecoveryConsecutiveSameSignature ?? 0,
          lastSignature: task.storyRepairRecoveryLastSignature,
          stoppedAt: toIsoTimestamp(task.storyRepairRecoveryStoppedAt),
          stopReason: task.storyRepairRecoveryStopReason,
          demandTaskIds: task.storyRepairRecoveryDemandTaskIds,
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
          lastFailureObservedAt: toIsoTimestamp(task.transientRecoveryLastFailureObservedAt),
          lastFailureStoryId: task.transientRecoveryLastFailureStoryId,
          lastProgressReason: task.transientRecoveryLastProgressReason,
          lastHadObjectiveProgress: task.transientRecoveryLastHadObjectiveProgress,
          lastDelayMs: task.transientRecoveryLastDelayMs,
          nextEligibleAt: toIsoTimestamp(task.transientRecoveryNextEligibleAt),
          stoppedAt: toIsoTimestamp(task.transientRecoveryStoppedAt),
          stopReason: task.transientRecoveryStopReason,
        }
      : undefined,
    agentContext: (
      task.agentContextRecoveryStartedAt !== undefined
      || task.agentContextRecoveryDeadlineAt !== undefined
      || task.agentContextRecoveryTotalRequeues !== undefined
      || task.agentContextRecoveryLastSignature !== undefined
      || task.agentContextRecoveryStoppedAt !== undefined
    )
      ? {
          startedAt: toIsoTimestamp(task.agentContextRecoveryStartedAt),
          deadlineAt: toIsoTimestamp(task.agentContextRecoveryDeadlineAt),
          totalRequeues: task.agentContextRecoveryTotalRequeues ?? 0,
          lastSignature: task.agentContextRecoveryLastSignature,
          lastRequeuedStoryId: task.agentContextRecoveryLastRequeuedStoryId,
          stoppedAt: toIsoTimestamp(task.agentContextRecoveryStoppedAt),
          stopReason: task.agentContextRecoveryStopReason,
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
    baselineRepair: (
      task.baselineQualityGate !== undefined
      || task.baselineRepair !== undefined
    )
      ? {
          phase: task.baselineQualityGate?.phase,
          rootCause: task.baselineQualityGate?.rootCause ?? task.baselineRepair?.rootCause,
          repairKey: task.baselineQualityGate?.repairKey ?? task.baselineRepair?.repairKey,
          repairTaskId: task.baselineQualityGate?.repairTaskId ?? task.baselineRepair?.repairTaskId,
          repairPrdId: task.baselineRepair?.repairPrdId,
          demandTaskIds: task.baselineQualityGate?.demandTaskIds ?? task.baselineRepair?.demandTaskIds,
          taskFailureSignature: task.baselineQualityGate?.taskFailureSignature,
          baselineFailureSignature: task.baselineQualityGate?.baselineFailureSignature,
          taskEnvRepair: task.baselineQualityGate?.taskEnvRepair,
          baselineEnvRepair: task.baselineQualityGate?.baselineEnvRepair,
          stoppedAt: toIsoTimestamp(task.baselineQualityGate?.stoppedAt),
          stopReason: task.baselineQualityGate?.stopReason,
        }
      : undefined,
  };
}
