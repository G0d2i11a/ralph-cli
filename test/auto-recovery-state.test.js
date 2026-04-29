const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateAutoRecovery } = require('../dist/core/auto-recovery-state.js');

function createTask(overrides = {}) {
  return {
    status: 'failed',
    autoRecoveryKind: 'transient',
    lastErrorRetryable: true,
    ...overrides,
  };
}

test('evaluateAutoRecovery ignores stale stopped fields from other recovery kinds', () => {
  const result = evaluateAutoRecovery(createTask({
    autoRecoveryKind: 'transient',
    mergeRepairRecoveryStoppedAt: 100,
    mergeRepairRecoveryStopReason: 'old merge repair stopped',
  }), 200);

  assert.equal(result.active, true);
  assert.equal(result.stoppedAt, undefined);
  assert.equal(result.staleInvalidReason, undefined);
});

test('evaluateAutoRecovery honors stopped field for the current recovery kind', () => {
  const result = evaluateAutoRecovery(createTask({
    autoRecoveryKind: 'merge_repair',
    mergeRepairRecoveryStoppedAt: 100,
    mergeRepairRecoveryStopReason: 'same unresolved state',
  }), 200);

  assert.equal(result.active, false);
  assert.equal(result.kind, 'merge_repair');
  assert.equal(result.stoppedAt, 100);
  assert.equal(result.stopReason, 'same unresolved state');
  assert.equal(result.staleInvalidReason, 'typed_recovery_stopped');
});
