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
