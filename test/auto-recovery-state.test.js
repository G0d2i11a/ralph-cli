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

test('evaluateAutoRecovery honors dedicated story repair stopped fields', () => {
  const result = evaluateAutoRecovery(createTask({
    autoRecoveryKind: 'story_repair',
    storyRepairRecoveryStoppedAt: 100,
    storyRepairRecoveryStopReason: 'story repair budget exhausted',
  }), 200);

  assert.equal(result.active, false);
  assert.equal(result.kind, 'story_repair');
  assert.equal(result.stoppedAt, 100);
  assert.equal(result.stopReason, 'story repair budget exhausted');
  assert.equal(result.staleInvalidReason, 'typed_recovery_stopped');
});

test('evaluateAutoRecovery honors dedicated agent-context stopped fields', () => {
  const result = evaluateAutoRecovery(createTask({
    autoRecoveryKind: 'agent_context',
    agentContextRecoveryStoppedAt: 100,
    agentContextRecoveryStopReason: 'agent_context_budget_exhausted',
  }), 200);

  assert.equal(result.active, false);
  assert.equal(result.kind, 'agent_context');
  assert.equal(result.stoppedAt, 100);
  assert.equal(result.stopReason, 'agent_context_budget_exhausted');
  assert.equal(result.staleInvalidReason, 'typed_recovery_stopped');
});

test('evaluateAutoRecovery treats autonomy repair as active recovery', () => {
  const result = evaluateAutoRecovery(createTask({
    status: 'failed_finalize',
    autoRecoveryKind: undefined,
    autonomyRepairKind: 'baseline_exhaustion',
    lastErrorRetryable: false,
  }), 200);

  assert.equal(result.active, true);
  assert.equal(result.kind, 'baseline_exhaustion');
  assert.equal(result.reason, 'autonomy_repair');
});

test('evaluateAutoRecovery suppresses stale recovery residue while a task is actively running', () => {
  const result = evaluateAutoRecovery(createTask({
    status: 'running',
    autoRecoveryKind: 'stagnant',
    autoRecoveryLastReason: 'Automatically requeued after stagnation timeout',
  }), 200);

  assert.equal(result.active, false);
  assert.equal(result.kind, 'stagnant');
  assert.equal(result.staleInvalidReason, 'task_running_not_waiting_for_recovery');
});

test('evaluateAutoRecovery suppresses stale recovery residue during finalizer execution', () => {
  const result = evaluateAutoRecovery(createTask({
    status: 'finalizing',
    autoRecoveryKind: 'finalize_repair',
  }), 200);

  assert.equal(result.active, false);
  assert.equal(result.kind, 'finalize_repair');
  assert.equal(result.staleInvalidReason, 'task_finalizing_not_waiting_for_recovery');
});

test('evaluateAutoRecovery honors autonomy repair cooldown', () => {
  const result = evaluateAutoRecovery(createTask({
    autoRecoveryKind: undefined,
    autonomyRepairKind: 'baseline_exhaustion',
    autonomyRepairNextEligibleAt: 300,
  }), 200);

  assert.equal(result.active, true);
  assert.equal(result.kind, 'baseline_exhaustion');
  assert.equal(result.reason, 'cooldown');
});

test('evaluateAutoRecovery honors autonomy repair stopped fields', () => {
  const result = evaluateAutoRecovery(createTask({
    autoRecoveryKind: undefined,
    autonomyRepairKind: 'baseline_exhaustion',
    autonomyRepairStoppedAt: 100,
    autonomyRepairStopReason: 'autonomy_repair_hard_cap_reached',
  }), 200);

  assert.equal(result.active, false);
  assert.equal(result.kind, 'baseline_exhaustion');
  assert.equal(result.stoppedAt, 100);
  assert.equal(result.stopReason, 'autonomy_repair_hard_cap_reached');
});
