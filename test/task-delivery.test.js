const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAutoRecoveryState,
  buildDeliveryState,
  deriveTaskDeliveryStatus,
  resolveTaskIntegrationStatus,
} = require('../dist/core/task-delivery.js');

test('delivery status infers integrated from legacy integration markers', () => {
  const delivery = deriveTaskDeliveryStatus({
    integrationStatus: undefined,
    integratedAt: undefined,
    integrationCommitSha: 'abc123',
    mergedAt: undefined,
    mergeCommitSha: undefined,
  });

  assert.equal(delivery.integrationStatus, 'integrated');
  assert.equal(delivery.source, 'marker');
  assert.equal(delivery.hasIntegrationMarker, true);
  assert.equal(delivery.inconsistent, false);
  assert.equal(resolveTaskIntegrationStatus({
    integrationStatus: undefined,
    integratedAt: undefined,
    integrationCommitSha: 'abc123',
  }), 'integrated');
});

test('delivery status surfaces inconsistent explicit failure with integration marker', () => {
  const delivery = buildDeliveryState({
    integrationStatus: 'failed',
    integratedAt: undefined,
    integrationCommitSha: undefined,
    integrationBranch: 'ralph/integration/main',
    integrationWorktree: '/tmp/integration',
    mergedAt: undefined,
    targetSyncedAt: undefined,
    targetSyncStatus: undefined,
    targetSyncDeferredReason: undefined,
    mergeTargetBranch: 'main',
    mergeStrategy: 'manual',
    mergeCommitSha: 'abc123',
    mergeMessage: 'merge failed after commit marker was written',
    mergeError: 'probe failed',
  });

  assert.equal(delivery.integrationStatus, 'failed');
  assert.equal(delivery.integrationStatusSource, 'explicit');
  assert.equal(delivery.hasIntegrationMarker, true);
  assert.equal(delivery.integrationInconsistent, true);
});

test('auto recovery state suppresses stale recovery on integrated completed tasks', () => {
  const recovery = buildAutoRecoveryState({
    status: 'completed',
    integrationStatus: 'integrated',
    integratedAt: 100,
    autoRecoveryKind: 'baseline_repair',
    autoRecoveryLastReason: 'Waiting for baseline repair task old-repair',
  });

  assert.equal(recovery.active, false);
  assert.equal(recovery.kind, 'baseline_repair');
  assert.equal(recovery.staleInvalidReason, 'completed_integrated_task');
});

test('auto recovery state suppresses stale recovery while task is running', () => {
  const recovery = buildAutoRecoveryState({
    status: 'running',
    autoRecoveryKind: 'stagnant',
    autoRecoveryTotalRequeues: 14,
    autoRecoveryLastReason: 'Automatically requeued after stagnation timeout',
  });

  assert.equal(recovery.active, false);
  assert.equal(recovery.kind, 'stagnant');
  assert.equal(recovery.totalRequeues, 14);
  assert.equal(recovery.staleInvalidReason, 'task_running_not_waiting_for_recovery');
});

test('auto recovery state exposes autonomy repair as active recovery', () => {
  const recovery = buildAutoRecoveryState({
    status: 'failed_finalize',
    autoRecoveryKind: undefined,
    autonomyRepairKind: 'baseline_exhaustion',
    autonomyRepairStartedAt: 10,
    autonomyRepairDeadlineAt: 1000,
    autonomyRepairTotalRequeues: 1,
    autonomyRepairLastSignature: 'test|apps/web|quality_gate_failure',
    autonomyRepairLastProgressReason: 'reclassifying current finalizer failure',
    autonomyRepairLastRequeuedAt: 20,
    autonomyRepairLastReason: 'Baseline repair exhausted; reclassifying',
    lastErrorKind: 'quality_gate_failure',
    lastErrorRetryable: false,
  });

  assert.equal(recovery.active, true);
  assert.equal(recovery.kind, 'baseline_exhaustion');
  assert.equal(recovery.reason, 'autonomy_repair');
  assert.equal(recovery.totalRequeues, 1);
  assert.equal(recovery.autonomyRepair.kind, 'baseline_exhaustion');
  assert.equal(recovery.autonomyRepair.startedAt, new Date(10).toISOString());
});

test('auto recovery state preserves recovery for blocked completed integration', () => {
  const recovery = buildAutoRecoveryState({
    status: 'completed',
    integrationStatus: 'blocked_conflict',
    autoRecoveryKind: 'merge_repair',
    autoRecoveryLastReason: 'Merge repair can resolve integration conflicts',
  });

  assert.equal(recovery.active, true);
  assert.equal(recovery.kind, 'merge_repair');
});

test('auto recovery state exposes typed stopped fields at top level', () => {
  const recovery = buildAutoRecoveryState({
    autoRecoveryKind: 'merge_repair',
    autoRecoveryTotalRequeues: 1,
    autoRecoveryHardCap: 3,
    autoRecoveryLastRequeuedAt: undefined,
    autoRecoveryNextEligibleAt: undefined,
    autoRecoveryStoppedAt: undefined,
    autoRecoveryStopReason: undefined,
    autoRecoveryLastReason: 'merge repair',
    status: 'failed',
    lastErrorKind: 'merge_conflict',
    lastErrorRetryable: true,
    failedBlockerRecoveryStartedAt: undefined,
    failedBlockerRecoveryDeadlineAt: undefined,
    failedBlockerRecoveryTotalRequeues: undefined,
    failedBlockerRecoveryLastSignature: undefined,
    failedBlockerRecoveryStoppedAt: undefined,
    failedBlockerRecoveryStopReason: undefined,
    failedBlockerRecoveryDemandTaskIds: undefined,
    transientRecoveryStartedAt: undefined,
    transientRecoveryDeadlineAt: undefined,
    transientRecoveryTotalRequeues: undefined,
    transientRecoveryConsecutiveSameSignature: undefined,
    transientRecoveryLastFailureKind: undefined,
    transientRecoveryLastFailureClass: undefined,
    transientRecoveryLastFailureSignature: undefined,
    transientRecoveryLastDelayMs: undefined,
    transientRecoveryNextEligibleAt: undefined,
    transientRecoveryStoppedAt: undefined,
    transientRecoveryStopReason: undefined,
    mergeRepairRecoveryStartedAt: 10,
    mergeRepairRecoveryDeadlineAt: 20,
    mergeRepairRecoveryTotalRequeues: 1,
    mergeRepairRecoveryConsecutiveNoProgress: 2,
    mergeRepairRecoveryLastConflictSignature: 'conflict',
    mergeRepairRecoveryLastProbeMessage: 'same unresolved state',
    mergeRepairRecoveryLastProgressReason: undefined,
    mergeRepairRecoveryStoppedAt: 100,
    mergeRepairRecoveryStopReason: 'same unresolved state',
    finalizeRepairStoppedAt: undefined,
    finalizeRepairStopReason: undefined,
  });

  assert.equal(recovery.active, false);
  assert.equal(recovery.stoppedAt, new Date(100).toISOString());
  assert.equal(recovery.stopReason, 'same unresolved state');
  assert.equal(recovery.mergeRepair.stoppedAt, new Date(100).toISOString());
});
