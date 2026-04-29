const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  buildCoordinationState,
  captureObservedTaskSurface,
  findCoordinationBlockers,
} = require('../dist/core/task-coordination.js');
const { buildDeliveryState } = require('../dist/core/task-delivery.js');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createTask(overrides = {}) {
  return {
    id: overrides.id || 'task',
    prdId: overrides.prdId || overrides.id || 'task',
    prdPath: overrides.prdPath || '/tmp/prd.json',
    status: overrides.status || 'completed',
    startTime: overrides.startTime || 100,
    enqueuedAt: overrides.enqueuedAt || overrides.startTime || 100,
    completedUS: [],
    worktree: overrides.worktree || '',
    logPath: overrides.logPath || `/tmp/${overrides.id || 'task'}.log`,
    agent: 'codex',
    repoPath: overrides.repoPath || '/repo',
    loopCount: 0,
    consecutiveNoProgress: 0,
    consecutiveErrors: 0,
    lastProgressTime: overrides.startTime || 100,
    lastFilesChanged: 0,
    ...overrides,
  };
}

test('findCoordinationBlockers blocks merge when earlier same-repo task overlaps on observed write surface', () => {
  const earlierTask = createTask({
    id: 'earlier-task',
    status: 'completed',
    integratedAt: undefined,
    observedWriteSurface: ['packages/contracts/src/index.ts'],
    startTime: 100,
    enqueuedAt: 100,
  });
  const laterTask = createTask({
    id: 'later-task',
    status: 'completed',
    observedWriteSurface: ['packages/contracts/src/index.ts'],
    startTime: 200,
    enqueuedAt: 200,
  });

  const result = findCoordinationBlockers(laterTask, [earlierTask, laterTask], 'merge', { targetBranch: 'main' });

  assert.equal(result.blocked, true);
  assert.equal(result.status, 'blocked_observed_overlap');
  assert.deepEqual(result.blockers, ['earlier-task']);
  assert.equal(result.phase, 'merge');
});

test('findCoordinationBlockers does not block across repositories in a shared Ralph home', () => {
  const earlierTask = createTask({
    id: 'repo-a-task',
    status: 'completed',
    observedWriteSurface: ['packages/contracts/src/index.ts'],
    repoPath: '/repo-a',
    startTime: 100,
    enqueuedAt: 100,
  });
  const laterTask = createTask({
    id: 'repo-b-task',
    status: 'completed',
    observedWriteSurface: ['packages/contracts/src/index.ts'],
    repoPath: '/repo-b',
    startTime: 200,
    enqueuedAt: 200,
  });

  const result = findCoordinationBlockers(laterTask, [earlierTask, laterTask], 'merge', { targetBranch: 'main' });

  assert.equal(result.blocked, false);
  assert.deepEqual(result.blockers, []);
});

test('findCoordinationBlockers keeps failed merge-conflict owners blocking later overlap', () => {
  const earlierTask = createTask({
    id: 'failed-owner',
    status: 'failed',
    repairContext: {
      mode: 'merge',
      storyId: 'US-003',
      createdAt: 123,
      reason: 'Merge repair required by Ralph.',
    },
    mergeConflictFiles: ['packages/contracts/src/index.ts'],
    observedWriteSurface: ['packages/contracts/src/index.ts'],
    startTime: 100,
    enqueuedAt: 100,
  });
  const laterTask = createTask({
    id: 'later-task',
    status: 'pending',
    declaredWriteSurface: ['packages/contracts/src/index.ts'],
    startTime: 200,
    enqueuedAt: 200,
  });

  const result = findCoordinationBlockers(laterTask, [earlierTask, laterTask], 'start', { targetBranch: 'main' });

  assert.equal(result.blocked, true);
  assert.equal(result.status, 'blocked_predicted_overlap');
  assert.deepEqual(result.blockers, ['failed-owner']);
  assert.equal(result.phase, 'start');
});

test('findCoordinationBlockers conservatively blocks unknown-surface tasks behind a hot merge-repair owner', () => {
  const earlierTask = createTask({
    id: 'failed-owner',
    status: 'failed',
    repairContext: {
      mode: 'merge',
      storyId: 'US-003',
      createdAt: 123,
      reason: 'Merge repair required by Ralph.',
    },
    mergeConflictFiles: ['packages/contracts/src/index.ts'],
    observedWriteSurface: ['packages/contracts/src/index.ts'],
    startTime: 100,
    enqueuedAt: 100,
  });
  const laterTask = createTask({
    id: 'later-unknown-surface',
    status: 'pending',
    startTime: 200,
    enqueuedAt: 200,
  });

  const result = findCoordinationBlockers(laterTask, [earlierTask, laterTask], 'start', { targetBranch: 'main' });

  assert.equal(result.blocked, true);
  assert.deepEqual(result.blockers, ['failed-owner']);
  assert.deepEqual(result.matches[0].overlappingPaths, ['<unknown-surface-during-hot-merge-repair>']);
});

test('buildDeliveryState infers deferred dirty-checkout sync for legacy tasks without targetSyncStatus', () => {
  const delivery = buildDeliveryState({
    integratedAt: 123,
    integrationStatus: undefined,
    integrationCommitSha: 'abc123',
    integrationBranch: 'ralph/integration/main',
    integrationWorktree: '/tmp/integration',
    targetSyncedAt: undefined,
    targetSyncStatus: undefined,
    targetSyncDeferredReason: 'main sync deferred: checkout /repo has uncommitted changes',
    mergeTargetBranch: 'main',
    mergeStrategy: 'manual',
    mergeCommitSha: 'abc123',
    mergeMessage: 'Integrated branch; main sync deferred: checkout /repo has uncommitted changes',
    mergeError: undefined,
  });

  assert.equal(delivery.integrationStatus, 'integrated');
  assert.equal(delivery.targetSyncStatus, 'deferred_dirty_checkout');
});

test('buildCoordinationState exposes blocker and observed surface details', () => {
  const coordination = buildCoordinationState({
    coordinationStatus: 'blocked_observed_overlap',
    coordinationPhase: 'merge',
    coordinationBlockers: ['task-a'],
    coordinationReason: 'Earlier overlapping task(s) must integrate first: task-a',
    integrationLane: 'main',
    declaredWriteSurface: ['packages/contracts'],
    declaredConflictDomains: ['contracts-index'],
    observedWriteSurface: ['packages/contracts/src/index.ts'],
    observedPackageSurface: ['packages/contracts'],
    surfaceCapturedAt: 123,
  });

  assert.equal(coordination.status, 'blocked_observed_overlap');
  assert.equal(coordination.phase, 'merge');
  assert.deepEqual(coordination.blockers, ['task-a']);
  assert.deepEqual(coordination.observedPackageSurface, ['packages/contracts']);
});

test('captureObservedTaskSurface excludes git-internal paths from the observed write surface', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-coordination-surface-'));

  try {
    git(repoDir, ['init', '-b', 'main']);
    git(repoDir, ['config', 'user.name', 'Ralph Test']);
    git(repoDir, ['config', 'user.email', 'ralph@example.com']);

    fs.mkdirSync(path.join(repoDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'docs', 'TODO.md'), 'base\n');
    git(repoDir, ['add', 'docs/TODO.md']);
    git(repoDir, ['commit', '-m', 'chore: base']);

    const baseCommitSha = git(repoDir, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(repoDir, 'docs', 'TODO.md'), 'base\nchange\n');
    fs.mkdirSync(path.join(repoDir, '.git-local'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, '.git-local', 'MERGE_HEAD'), 'metadata\n');

    const observed = captureObservedTaskSurface({
      worktree: repoDir,
      repoPath: repoDir,
      baseCommitSha,
    });

    assert.deepEqual(observed.observedWriteSurface, ['docs/TODO.md']);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
