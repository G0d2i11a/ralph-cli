const test = require('node:test');
const assert = require('node:assert/strict');

const {
  adjustManagerStatusForFinalizerLease,
  deriveAttention,
  findFreshFinalizerLease,
  resolveNextAction,
  summarizeTask,
} = require('../dist/commands/queue.js');

function createTask(overrides = {}) {
  return {
    id: 'task',
    prdPath: '/tmp/prd.json',
    status: 'failed',
    startTime: 100,
    completedUS: [],
    worktree: '/tmp/worktree',
    logPath: '/tmp/agent.log',
    agent: 'codex',
    repoPath: '/tmp/repo',
    loopCount: 0,
    consecutiveNoProgress: 0,
    consecutiveErrors: 0,
    lastProgressTime: 100,
    lastFilesChanged: 0,
    ...overrides,
  };
}

test('queue attention labels stopped merge repair distinctly', () => {
  const task = createTask({
    status: 'failed',
    autoRecoveryKind: 'merge_repair',
    lastError: 'merge repair saw the same unresolved conflicts',
    lastErrorRetryable: true,
    mergeRepairDisplayStatus: 'stopped',
    mergeRepairRecoveryStoppedAt: 200,
    mergeRepairRecoveryStopReason: 'merge_repair_same_unresolved_state',
    mergeConflictFiles: ['apps/api/src/service.ts'],
  });

  const attention = deriveAttention(task);

  assert.equal(attention.needed, true);
  assert.equal(attention.reason, 'merge_repair_stopped');
  assert.match(resolveNextAction(task), /manual merge repair required/);
});

test('queue attention labels integration sync conflicts distinctly', () => {
  const task = createTask({
    status: 'failed',
    autoRecoveryKind: 'merge_repair',
    lastError: 'Integration branch sync failed with conflicts: docs/TODO.md',
    lastErrorRetryable: true,
    mergeRepairDisplayStatus: 'stopped',
    mergeRepairRecoveryStoppedAt: 200,
    mergeRepairRecoveryStopReason: 'merge_repair_integration_sync_conflict',
    mergeConflictFiles: ['docs/TODO.md'],
    mergeConflictPhase: 'integration_sync',
  });

  const attention = deriveAttention(task);

  assert.equal(attention.needed, true);
  assert.equal(attention.reason, 'integration_sync_conflict');
  assert.match(resolveNextAction(task), /integration branch sync conflict/);
});

test('queue attention labels nonretryable story incomplete distinctly', () => {
  const task = createTask({
    status: 'failed',
    autoRecoveryKind: 'stagnant',
    lastErrorKind: 'story_incomplete',
    lastErrorRetryable: false,
  });

  const attention = deriveAttention(task);

  assert.equal(attention.needed, true);
  assert.equal(attention.reason, 'story_incomplete');
  assert.match(resolveNextAction(task), /repair or reset incomplete stories/);
});

test('queue does not mark active auto recovery as attention', () => {
  const task = createTask({
    status: 'failed',
    autoRecoveryKind: 'transient',
    autoRecoveryNextEligibleAt: Date.now() + 60_000,
    lastErrorRetryable: true,
  });

  const attention = deriveAttention(task);

  assert.equal(attention.needed, false);
  assert.match(resolveNextAction(task), /auto-recovery cooldown/);
});

test('queue summary explains coordination owner and overlapping conflict surface', () => {
  const coordinationConflicts = [{
    taskId: 'observed-owner',
    overlapKinds: ['write_surface'],
    overlappingDomains: [],
    overlappingPaths: ['packages/contracts/src/index.ts'],
  }];
  const pendingState = {
    reason: 'coordination',
    dependencies: [],
    blockers: ['observed-owner'],
    coordinationReason: 'Earlier overlapping task(s) must integrate first: observed-owner (paths: packages/contracts/src/index.ts)',
    coordinationConflicts,
    integrationLane: 'main',
    maxConcurrent: 3,
    running: 1,
  };
  const summary = summarizeTask(createTask({
    id: 'blocked-task',
    status: 'pending',
  }), pendingState, false, true);

  assert.equal(summary.reason, 'coordination');
  assert.equal(summary.coordination.owner, 'observed-owner');
  assert.equal(summary.coordination.phase, 'start');
  assert.equal(summary.coordination.lane, 'main');
  assert.equal(summary.coordination.reason, pendingState.coordinationReason);
  assert.deepEqual(summary.coordination.conflicts, coordinationConflicts);
  assert.deepEqual(summary.coordinationConflicts, coordinationConflicts);
  assert.match(summary.nextAction, /observed-owner/);
  assert.match(summary.nextAction, /packages\/contracts\/src\/index\.ts/);
});

test('queue coordination next action stays bounded for human output', () => {
  const coordinationConflicts = [
    {
      taskId: 'owner-a',
      overlapKinds: ['write_surface'],
      overlappingDomains: [],
      overlappingPaths: ['packages/contracts/src/index.ts'],
    },
    {
      taskId: 'owner-b',
      overlapKinds: ['write_surface'],
      overlappingDomains: [],
      overlappingPaths: ['apps/web/src/view.ts'],
    },
    {
      taskId: 'owner-c',
      overlapKinds: ['write_surface'],
      overlappingDomains: [],
      overlappingPaths: ['docs/guide.md'],
    },
  ];
  const nextAction = resolveNextAction(createTask({
    id: 'blocked-task',
    status: 'pending',
  }), {
    reason: 'coordination',
    dependencies: [],
    blockers: coordinationConflicts.map((conflict) => conflict.taskId),
    coordinationConflicts,
    integrationLane: 'main',
    maxConcurrent: 3,
    running: 1,
  });

  assert.match(nextAction, /owner-a/);
  assert.match(nextAction, /owner-b/);
  assert.match(nextAction, /\+1 more/);
  assert.doesNotMatch(nextAction, /owner-c/);
});

test('queue suppresses stale manager heartbeat display while finalizer lease is fresh', () => {
  const now = Date.now();
  const task = createTask({
    id: 'finalizing-task',
    status: 'finalizing',
    leaseOwner: 'finalizer:123',
    leaseHeartbeatAt: now - 1000,
    leaseExpiresAt: now + 60_000,
  });
  const manager = {
    ralphHome: '/tmp/ralph',
    statePath: '/tmp/ralph/manager/state.json',
    lockDir: '/tmp/ralph/manager.lock',
    state: null,
    stateExists: true,
    processRunning: true,
    active: true,
    heartbeatStale: true,
    staleAfterMs: 5000,
    codeDriftDetected: false,
    message: 'manager process 123 is running but heartbeat is stale',
  };

  const lease = findFreshFinalizerLease([task], now);
  const adjusted = adjustManagerStatusForFinalizerLease(manager, lease);

  assert.equal(adjusted.heartbeatStale, false);
  assert.equal(adjusted.heartbeatStaleSuppressed, true);
  assert.equal(adjusted.heartbeatStaleSuppressedReason, 'active_finalizer_lease');
  assert.equal(adjusted.finalizerLease.taskId, 'finalizing-task');
});

test('queue keeps stale manager heartbeat when finalizer lease is expired', () => {
  const now = Date.now();
  const task = createTask({
    id: 'finalizing-task',
    status: 'finalizing',
    leaseOwner: 'finalizer:123',
    leaseHeartbeatAt: now - 60_000,
    leaseExpiresAt: now - 1,
  });
  const manager = {
    ralphHome: '/tmp/ralph',
    statePath: '/tmp/ralph/manager/state.json',
    lockDir: '/tmp/ralph/manager.lock',
    state: null,
    stateExists: true,
    processRunning: true,
    active: true,
    heartbeatStale: true,
    staleAfterMs: 5000,
    codeDriftDetected: false,
    message: 'manager process 123 is running but heartbeat is stale',
  };

  const lease = findFreshFinalizerLease([task], now);
  const adjusted = adjustManagerStatusForFinalizerLease(manager, lease);

  assert.equal(lease, undefined);
  assert.equal(adjusted.heartbeatStale, true);
  assert.equal(adjusted.heartbeatStaleSuppressed, undefined);
});
