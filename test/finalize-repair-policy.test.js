const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  captureFinalizeRepairSnapshot,
  decideFinalizeRepairRequeue,
  evaluateFinalizeRepairFailure,
} = require('../dist/core/finalize-repair-policy.js');

function git(cwd, args) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function createRepairConfig(overrides = {}) {
  return {
    repairPolicy: 'progress',
    maxRepairAttempts: 1,
    maxNoProgressRepairRounds: 2,
    repairDeadlineSeconds: 7200,
    repairHardCap: 20,
    ...overrides,
  };
}

test('evaluateFinalizeRepairFailure treats HEAD-only changes between failures as objective progress', () => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalize-repair-progress-'));

  try {
    git(repoPath, ['init']);
    git(repoPath, ['config', 'user.email', 'test@example.com']);
    git(repoPath, ['config', 'user.name', 'Test User']);

    const filePath = path.join(repoPath, 'tracked.txt');
    fs.writeFileSync(filePath, 'base\n');
    git(repoPath, ['add', 'tracked.txt']);
    git(repoPath, ['commit', '-m', 'initial']);

    const baseCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();

    fs.writeFileSync(filePath, 'first repair\n');
    git(repoPath, ['add', 'tracked.txt']);
    git(repoPath, ['commit', '-m', 'repair']);

    const previousSnapshot = captureFinalizeRepairSnapshot({
      worktree: repoPath,
      baseCommitSha,
      lastError: 'Quality gate "test" failed',
    }, 100);

    fs.writeFileSync(filePath, 'amended repair\n');
    git(repoPath, ['add', 'tracked.txt']);
    git(repoPath, ['commit', '--amend', '-m', 'repair amended']);

    const state = evaluateFinalizeRepairFailure({
      worktree: repoPath,
      baseCommitSha,
      lastError: 'Quality gate "test" failed',
      finalizeRepairStartedAt: 50,
      finalizeRepairDeadlineAt: 5000,
      finalizeRepairLastFailureSnapshot: previousSnapshot,
      finalizeRepairLastProgressAt: 80,
      finalizeRepairLastProgressReason: 'older progress',
      finalizeRepairConsecutiveNoProgress: 1,
    }, createRepairConfig(), 200);

    assert.equal(state.consecutiveNoProgress, 0);
    assert.equal(state.lastProgressAt, 200);
    assert.match(state.lastProgressReason, /HEAD changed/i);
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
});

test('evaluateFinalizeRepairFailure increments the no-progress counter when failure snapshot is unchanged', () => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalize-repair-stalled-'));

  try {
    git(repoPath, ['init']);
    git(repoPath, ['config', 'user.email', 'test@example.com']);
    git(repoPath, ['config', 'user.name', 'Test User']);

    const filePath = path.join(repoPath, 'tracked.txt');
    fs.writeFileSync(filePath, 'base\n');
    git(repoPath, ['add', 'tracked.txt']);
    git(repoPath, ['commit', '-m', 'initial']);

    const baseCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();

    fs.writeFileSync(filePath, 'repair\n');
    git(repoPath, ['add', 'tracked.txt']);
    git(repoPath, ['commit', '-m', 'repair']);

    const previousSnapshot = captureFinalizeRepairSnapshot({
      worktree: repoPath,
      baseCommitSha,
      lastError: 'Quality gate "test" failed',
    }, 100);

    const state = evaluateFinalizeRepairFailure({
      worktree: repoPath,
      baseCommitSha,
      lastError: 'Quality gate "test" failed',
      finalizeRepairStartedAt: 50,
      finalizeRepairDeadlineAt: 5000,
      finalizeRepairLastFailureSnapshot: previousSnapshot,
      finalizeRepairLastProgressAt: 80,
      finalizeRepairLastProgressReason: 'older progress',
      finalizeRepairConsecutiveNoProgress: 1,
    }, createRepairConfig(), 200);

    assert.equal(state.consecutiveNoProgress, 2);
    assert.equal(state.lastProgressAt, 80);
    assert.equal(state.lastProgressReason, 'older progress');
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
});

test('decideFinalizeRepairRequeue allows progress mode to continue beyond legacy attempt counts', () => {
  const decision = decideFinalizeRepairRequeue({
    task: {
      finalizerAttempts: 7,
      finalizeRepairStartedAt: Date.now() - 1000,
      finalizeRepairDeadlineAt: Date.now() + 60_000,
      finalizeRepairConsecutiveNoProgress: 0,
      finalizeRepairTotalRequeues: 5,
      finalizeRepairLastProgressReason: 'HEAD changed',
    },
    config: createRepairConfig({
      maxRepairAttempts: 1,
    }),
    mergeConflict: false,
    hasUnrunMergeRepair: false,
  });

  assert.equal(decision.shouldRequeue, true);
  assert.match(decision.reason, /HEAD changed/i);
});
