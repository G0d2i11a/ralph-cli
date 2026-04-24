const test = require('node:test');
const assert = require('node:assert/strict');

const { detectStagnation } = require('../dist/utils/helpers.js');

test('detectStagnation honors configured timeout windows', () => {
  const task = {
    id: 'task-1',
    prdPath: '/tmp/prd.json',
    status: 'running',
    startTime: 0,
    completedUS: [],
    worktree: '/tmp/worktree',
    logPath: '/tmp/agent.log',
    agent: 'codex',
    repoPath: '/tmp/repo',
    loopCount: 0,
    consecutiveNoProgress: 0,
    consecutiveErrors: 0,
    lastProgressTime: 1_000,
    lastFilesChanged: 0,
  };

  const result = detectStagnation(task, {
    timeoutMs: 5_000,
    now: () => 7_500,
  });

  assert.equal(result.isStagnant, true);
  assert.match(result.reason, /No progress for 6s/);
});

test('detectStagnation does not treat completed story count as stagnation by itself', () => {
  const task = {
    id: 'task-many-stories',
    prdPath: '/tmp/prd.json',
    status: 'running',
    startTime: 0,
    completedUS: Array.from({ length: 12 }, (_, index) => `US-${String(index + 1).padStart(3, '0')}`),
    worktree: '/tmp/worktree',
    logPath: '/tmp/agent.log',
    agent: 'codex',
    repoPath: '/tmp/repo',
    loopCount: 12,
    consecutiveNoProgress: 0,
    consecutiveErrors: 0,
    lastProgressTime: 10_000,
    lastFilesChanged: 2,
  };

  const result = detectStagnation(task, {
    timeoutMs: 60_000,
    now: () => 20_000,
  });

  assert.equal(result.isStagnant, false);
});
