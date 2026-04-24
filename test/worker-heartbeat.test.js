const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createWorkerLeaseUpdate,
  resolveWorkerLeaseHeartbeatIntervalMs,
  resolveWorkerLeaseTimeoutMs,
} = require('../dist/core/worker-heartbeat.js');

function config(values = {}) {
  return {
    get: (key) => values[key],
  };
}

test('worker lease timeout treats configuration values as seconds', () => {
  assert.equal(resolveWorkerLeaseTimeoutMs(config({ 'runner.leaseTimeout': 1800 })), 1_800_000);
  assert.equal(resolveWorkerLeaseTimeoutMs(config({ 'runner.leaseTimeout': 5 })), 5_000);
  assert.equal(resolveWorkerLeaseTimeoutMs(config({})), 300_000);
});

test('worker heartbeat interval defaults below the lease timeout', () => {
  assert.equal(resolveWorkerLeaseHeartbeatIntervalMs(config({ 'runner.leaseTimeout': 1800 })), 60_000);
  assert.equal(resolveWorkerLeaseHeartbeatIntervalMs(config({ 'runner.leaseTimeout': 15 })), 5_000);
  assert.equal(
    resolveWorkerLeaseHeartbeatIntervalMs(config({ 'runner.leaseHeartbeatInterval': 7 })),
    7_000
  );
});

test('worker lease update records owner, heartbeat, and expiry', () => {
  const before = Date.now();
  const update = createWorkerLeaseUpdate(config({ 'runner.leaseTimeout': 10 }), 12345);
  const after = Date.now();

  assert.equal(update.leaseOwner, 'worker:12345');
  assert.ok(update.leaseHeartbeatAt >= before);
  assert.ok(update.leaseHeartbeatAt <= after);
  assert.equal(update.leaseExpiresAt - update.leaseHeartbeatAt, 10_000);
});
