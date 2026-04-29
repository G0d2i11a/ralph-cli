const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveAttention,
  resolveNextAction,
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
