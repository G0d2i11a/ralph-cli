const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAutoRecoveryState,
  buildDeliveryState,
  buildValidationEvidenceSummary,
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

test('validation evidence summary covers passed, failed, timed-out, and skipped gates', () => {
  const summary = buildValidationEvidenceSummary({
    validationEvidence: {
      schemaVersion: 1,
      source: 'finalizer',
      taskId: 'evidence-task',
      generatedAt: 1_700_000_000_000,
      configuredGates: ['typecheck', 'test', 'lint'],
      summary: {
        total: 4,
        passed: 1,
        failed: 2,
        skipped: 1,
        classifications: {
          passed: 1,
          typescript_diagnostics: 1,
          quality_gate_timeout: 1,
          skipped: 1,
        },
      },
      runs: [
        {
          phase: 'quality_gate',
          requestedGate: 'typecheck',
          gate: 'typecheck',
          status: 'passed',
          classification: 'passed',
          packageLabel: 'app',
          command: 'npm run typecheck',
          exitCode: 0,
          durationMs: 15,
          stdoutSummary: { byteLength: 11, lineCount: 1, truncated: false, excerpt: 'ok' },
        },
        {
          phase: 'quality_gate',
          requestedGate: 'typecheck',
          gate: 'typecheck',
          status: 'failed',
          classification: 'typescript_diagnostics',
          packageLabel: 'app',
          command: 'npm run typecheck',
          exitCode: 2,
          durationMs: 25,
          diagnosticCount: 3,
          stderrSummary: { byteLength: 100, lineCount: 5, truncated: true, excerpt: 'TS2322' },
        },
        {
          phase: 'quality_gate',
          requestedGate: 'test',
          gate: 'test',
          status: 'failed',
          classification: 'quality_gate_timeout',
          packageLabel: 'app',
          command: 'npm test',
          durationMs: 10_000,
          timedOut: true,
        },
        {
          phase: 'quality_gate',
          requestedGate: 'lint',
          gate: 'lint',
          status: 'skipped',
          classification: 'skipped',
          packageLabel: 'app',
          reason: 'script "lint" is not defined for app',
        },
      ],
    },
  });

  assert.equal(summary.generatedAt, new Date(1_700_000_000_000).toISOString());
  assert.equal(summary.total, 4);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 2);
  assert.equal(summary.skipped, 1);
  assert.deepEqual(summary.configuredGates, ['typecheck', 'test', 'lint']);
  assert.deepEqual(summary.gates.map((gate) => gate.status), ['passed', 'failed', 'failed', 'skipped']);
  assert.equal(summary.gates[0].stdoutSummary, undefined);
  assert.equal(summary.gates[1].diagnosticCount, 3);
  assert.equal(summary.gates[2].timedOut, true);
  assert.equal(summary.gates[3].reason, 'script "lint" is not defined for app');
});

test('validation evidence summary can fall back to repair context snapshot', () => {
  const validationEvidenceSummary = {
    generatedAt: new Date(123).toISOString(),
    configuredGates: ['test'],
    total: 1,
    passed: 0,
    failed: 1,
    skipped: 0,
    classifications: { quality_gate_timeout: 1 },
    gates: [
      {
        phase: 'quality_gate',
        requestedGate: 'test',
        gate: 'test',
        status: 'failed',
        classification: 'quality_gate_timeout',
        timedOut: true,
      },
    ],
  };

  const summary = buildValidationEvidenceSummary({
    repairContext: {
      mode: 'finalize',
      storyId: 'US-001',
      createdAt: 1,
      reason: 'retry',
      validationEvidenceSummary,
    },
  });

  assert.deepEqual(summary, validationEvidenceSummary);
});
