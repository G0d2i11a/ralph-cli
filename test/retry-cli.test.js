const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runCli(args, env = {}) {
  return spawnSync('node', ['dist/cli.js', ...args], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...env,
    },
  });
}

test('retry resets failed_finalize tasks and exhausted story attempts', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-retry-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-retry-repo-'));
  const taskId = 'failed-finalize-task';
  const taskDir = path.join(homeDir, '.ralph', 'tasks', taskId);
  const prdPath = path.join(repoDir, 'prd.json');

  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(prdPath, JSON.stringify({
      id: 'retry-prd',
      title: 'Retry PRD',
      description: 'retry',
      dependencies: ['missing-prd'],
      userStories: [
        { id: 'US-001', title: 'One', description: 'one', acceptanceCriteria: ['done'] },
        { id: 'US-002', title: 'Two', description: 'two', acceptanceCriteria: ['done'] },
        { id: 'US-003', title: 'Three', description: 'three', acceptanceCriteria: ['done'] },
      ],
    }, null, 2));
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: taskId,
      prdPath,
      prdId: 'retry-prd',
      prdDependencies: ['missing-prd'],
      status: 'failed_finalize',
      startTime: Date.now(),
      endTime: Date.now(),
      completedUS: ['US-001', 'US-002'],
      worktree: path.join(repoDir, '.ralph-worktrees', taskId),
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      loopCount: 5,
      consecutiveNoProgress: 2,
      consecutiveErrors: 1,
      lastProgressTime: 1,
      lastFilesChanged: 1,
      finalizerCommitSha: 'abc123',
      finalizerCommitMessage: 'feat: finalize old attempt',
      finalizerCommittedAt: 30,
      postFinalizeMergeProbeRequired: true,
      finalizerAttempts: 2,
      repairContext: {
        mode: 'finalize',
        storyId: 'US-003',
        createdAt: 9,
        reason: 'Quality gate failed',
      },
      integratedAt: 40,
      integrationStatus: 'blocked_conflict',
      integrationCommitSha: 'def456',
      integrationBranch: 'ralph/integration/main',
      integrationWorktree: '/tmp/integration',
      targetSyncedAt: 50,
      targetSyncStatus: 'failed',
      targetSyncDeferredReason: 'main sync deferred',
      mergedAt: 60,
      mergeCommitSha: '789abc',
      mergeTargetBranch: 'main',
      mergeStrategy: 'manual',
      mergeMessage: 'merge old attempt',
      mergeError: 'quality gate failed',
      lastErrorKind: 'backend_high_demand',
      lastErrorClass: 'transient_backend',
      lastErrorRetryable: true,
      lastErrorObservedAt: 25,
      transientRetryCount: 2,
      transientRetryBudget: 3,
      transientRetryLastDelayMs: 15000,
      finalizeRepairStartedAt: 10,
      finalizeRepairDeadlineAt: 20,
      finalizeRepairLastFailureSnapshot: {
        headSha: 'abc123',
        commitsAheadOfBase: 1,
        changedFiles: 1,
        worktreeDiffSignature: 'sig-1',
        failureKind: 'quality_gate',
        failureSignature: 'quality gate failed',
        capturedAt: 10,
      },
      finalizeRepairLastProgressAt: 11,
      finalizeRepairLastProgressReason: 'HEAD changed',
      finalizeRepairConsecutiveNoProgress: 1,
      finalizeRepairTotalRequeues: 3,
      finalizeRepairStoppedAt: 12,
      finalizeRepairStopReason: 'repair_no_progress',
      storyProgress: [
        { id: 'US-001', status: 'failed', attempts: 2, lastError: 'network failed', updatedAt: 1 },
        { id: 'US-002', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-003', status: 'needs_repair', attempts: 2, lastError: 'test failed', updatedAt: 1 },
      ],
    }, null, 2));

    const result = runCli(['retry', taskId], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf-8'));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.previousStatus, 'failed_finalize');
    assert.equal(output.currentStatus, 'pending');
    assert.deepEqual(output.resetStoryIds, ['US-001', 'US-003']);
    assert.deepEqual(state.completedUS, ['US-002']);
    assert.equal(state.finalizerCommitSha, undefined);
    assert.equal(state.finalizerCommitMessage, undefined);
    assert.equal(state.finalizerCommittedAt, undefined);
    assert.equal(state.finalizerAttempts, 0);
    assert.equal(state.repairContext, undefined);
    assert.equal(state.postFinalizeMergeProbeRequired, true);
    assert.equal(state.integratedAt, undefined);
    assert.equal(state.integrationStatus, 'not_started');
    assert.equal(state.integrationCommitSha, undefined);
    assert.equal(state.integrationBranch, undefined);
    assert.equal(state.integrationWorktree, undefined);
    assert.equal(state.targetSyncedAt, undefined);
    assert.equal(state.targetSyncStatus, 'not_requested');
    assert.equal(state.targetSyncDeferredReason, undefined);
    assert.equal(state.mergedAt, undefined);
    assert.equal(state.mergeCommitSha, undefined);
    assert.equal(state.mergeTargetBranch, undefined);
    assert.equal(state.mergeStrategy, undefined);
    assert.equal(state.mergeMessage, undefined);
    assert.equal(state.mergeError, undefined);
    assert.equal(state.lastErrorKind, undefined);
    assert.equal(state.lastErrorClass, undefined);
    assert.equal(state.lastErrorRetryable, undefined);
    assert.equal(state.lastErrorObservedAt, undefined);
    assert.equal(state.transientRetryCount, 0);
    assert.equal(state.transientRetryBudget, undefined);
    assert.equal(state.transientRetryLastDelayMs, undefined);
    assert.equal(state.finalizeRepairStartedAt, undefined);
    assert.equal(state.finalizeRepairDeadlineAt, undefined);
    assert.equal(state.finalizeRepairLastFailureSnapshot, undefined);
    assert.equal(state.finalizeRepairLastProgressAt, undefined);
    assert.equal(state.finalizeRepairLastProgressReason, undefined);
    assert.equal(state.finalizeRepairConsecutiveNoProgress, 0);
    assert.equal(state.finalizeRepairTotalRequeues, 0);
    assert.equal(state.finalizeRepairStoppedAt, undefined);
    assert.equal(state.finalizeRepairStopReason, undefined);
    assert.equal(state.storyProgress[0].status, 'pending');
    assert.equal(state.storyProgress[0].attempts, 0);
    assert.equal(state.storyProgress[2].status, 'pending');
    assert.equal(state.storyProgress[2].attempts, 0);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('retry clears auto-recovery and repair residue for plain failed tasks', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-retry-failed-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-retry-failed-repo-'));
  const taskId = 'failed-retry-task';
  const taskDir = path.join(homeDir, '.ralph', 'tasks', taskId);
  const prdPath = path.join(repoDir, 'prd.json');

  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(prdPath, JSON.stringify({
      id: 'retry-failed-prd',
      title: 'Retry Failed PRD',
      description: 'retry failed task',
      dependencies: ['missing-prd'],
      userStories: [
        { id: 'US-001', title: 'One', description: 'one', acceptanceCriteria: ['done'] },
        { id: 'US-002', title: 'Two', description: 'two', acceptanceCriteria: ['done'] },
      ],
    }, null, 2));
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: taskId,
      prdPath,
      prdId: 'retry-failed-prd',
      prdDependencies: ['missing-prd'],
      status: 'failed',
      startTime: Date.now(),
      endTime: Date.now(),
      completedUS: ['US-001'],
      worktree: path.join(repoDir, '.ralph-worktrees', taskId),
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      integrationStatus: 'not_started',
      integrationBranch: 'ralph/integration/main',
      integrationWorktree: '/tmp/integration',
      mergeError: 'Backend overloaded',
      lastError: 'Backend overloaded',
      lastErrorKind: 'backend_high_demand',
      lastErrorClass: 'transient_backend',
      lastErrorRetryable: true,
      lastErrorObservedAt: 25,
      lastErrorSignature: 'backend_high_demand',
      autoRecoveryKind: 'transient',
      autoRecoveryTotalRequeues: 2,
      autoRecoveryHardCap: 20,
      autoRecoveryStoppedAt: 26,
      autoRecoveryStopReason: 'transient_recovery_exhausted',
      autoRecoveryLastReason: 'Transient recovery budget exhausted',
      storyRepairRecoveryStartedAt: 8,
      storyRepairRecoveryDeadlineAt: 18,
      storyRepairRecoveryTotalRequeues: 1,
      storyRepairRecoveryLastSignature: 'US-002:no_objective_evidence',
      storyRepairRecoveryConsecutiveSameSignature: 1,
      storyRepairRecoveryStoppedAt: 26,
      storyRepairRecoveryStopReason: 'story_repair_budget_exhausted',
      storyRepairRecoveryDemandTaskIds: ['downstream-task'],
      mergeRepairRecoveryStartedAt: 10,
      mergeRepairRecoveryDeadlineAt: 20,
      mergeRepairRecoveryTotalRequeues: 2,
      mergeRepairRecoveryConsecutiveNoProgress: 1,
      mergeRepairRecoveryLastConflictSignature: 'docs/TODO.md',
      mergeRepairRecoveryLastProbeMessage: 'Merge conflicts detected: docs/TODO.md',
      mergeRepairRecoveryLastProgressReason: 'Initialized worker merge-repair recovery tracking',
      mergeRepairRecoveryStoppedAt: 26,
      mergeRepairRecoveryStopReason: 'merge_repair_deadline_exhausted',
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'failed', attempts: 2, lastError: 'merge failed', updatedAt: 1 },
      ],
    }, null, 2));

    const result = runCli(['retry', taskId], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf-8'));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.previousStatus, 'failed');
    assert.equal(output.currentStatus, 'pending');
    assert.deepEqual(output.resetStoryIds, ['US-002']);
    assert.equal(state.repairContext, undefined);
    assert.equal(state.mergeError, undefined);
    assert.equal(state.mergeConflictFiles, undefined);
    assert.equal(state.lastErrorKind, undefined);
    assert.equal(state.lastErrorClass, undefined);
    assert.equal(state.lastErrorRetryable, undefined);
    assert.equal(state.lastErrorObservedAt, undefined);
    assert.equal(state.lastErrorSignature, undefined);
    assert.equal(state.autoRecoveryKind, undefined);
    assert.equal(state.autoRecoveryTotalRequeues, 0);
    assert.equal(state.autoRecoveryStoppedAt, undefined);
    assert.equal(state.autoRecoveryStopReason, undefined);
    assert.equal(state.storyRepairRecoveryStartedAt, undefined);
    assert.equal(state.storyRepairRecoveryDeadlineAt, undefined);
    assert.equal(state.storyRepairRecoveryTotalRequeues, 0);
    assert.equal(state.storyRepairRecoveryLastSignature, undefined);
    assert.equal(state.storyRepairRecoveryConsecutiveSameSignature, 0);
    assert.equal(state.storyRepairRecoveryStoppedAt, undefined);
    assert.equal(state.storyRepairRecoveryStopReason, undefined);
    assert.equal(state.storyRepairRecoveryDemandTaskIds, undefined);
    assert.equal(state.mergeRepairRecoveryStartedAt, undefined);
    assert.equal(state.mergeRepairRecoveryDeadlineAt, undefined);
    assert.equal(state.mergeRepairRecoveryTotalRequeues, 0);
    assert.equal(state.mergeRepairRecoveryStoppedAt, undefined);
    assert.equal(state.mergeRepairRecoveryStopReason, undefined);
    assert.equal(state.storyProgress[1].status, 'pending');
    assert.equal(state.storyProgress[1].attempts, 0);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('retry resets stale in-progress stories on failed story-incomplete tasks', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-retry-story-incomplete-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-retry-story-incomplete-repo-'));
  const taskId = 'failed-story-incomplete-task';
  const taskDir = path.join(homeDir, '.ralph', 'tasks', taskId);
  const prdPath = path.join(repoDir, 'prd.json');

  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(prdPath, JSON.stringify({
      id: 'retry-story-incomplete-prd',
      title: 'Retry Story Incomplete PRD',
      description: 'retry stale in-progress story',
      dependencies: ['missing-prd'],
      userStories: [
        { id: 'US-001', title: 'One', description: 'one', acceptanceCriteria: ['done'] },
        { id: 'US-002', title: 'Two', description: 'two', acceptanceCriteria: ['done'] },
        { id: 'US-003', title: 'Three', description: 'three', acceptanceCriteria: ['done'] },
      ],
    }, null, 2));
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: taskId,
      prdPath,
      prdId: 'retry-story-incomplete-prd',
      prdDependencies: ['missing-prd'],
      status: 'failed',
      startTime: Date.now(),
      endTime: Date.now(),
      completedUS: ['US-001'],
      worktree: path.join(repoDir, '.ralph-worktrees', taskId),
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      integrationStatus: 'failed',
      mergeError: 'Task failed-story-incomplete-task cannot finalize: 1/3 stories are incomplete (US-003:in_progress:2)',
      lastError: 'Task failed-story-incomplete-task cannot finalize: 1/3 stories are incomplete (US-003:in_progress:2)',
      lastErrorKind: 'story_incomplete',
      lastErrorClass: 'semantic',
      lastErrorRetryable: false,
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 1,
      lastFilesChanged: 1,
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-003', status: 'in_progress', attempts: 2, lastError: 'stale worker state', updatedAt: 1 },
      ],
    }, null, 2));

    const result = runCli(['retry', taskId], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf-8'));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.previousStatus, 'failed');
    assert.equal(output.currentStatus, 'pending');
    assert.deepEqual(output.resetStoryIds, ['US-003']);
    assert.deepEqual(state.completedUS, ['US-001']);
    assert.equal(state.storyProgress[2].status, 'pending');
    assert.equal(state.storyProgress[2].attempts, 0);
    assert.equal(state.lastErrorKind, undefined);
    assert.equal(state.mergeError, undefined);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('retry preserves anchored merge repair for failed merge-conflict tasks', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-retry-failed-merge-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-retry-failed-merge-repo-'));
  const taskId = 'failed-merge-repair-task';
  const taskDir = path.join(homeDir, '.ralph', 'tasks', taskId);
  const prdPath = path.join(repoDir, 'prd.json');

  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(prdPath, JSON.stringify({
      id: 'retry-failed-merge-prd',
      title: 'Retry Failed Merge PRD',
      description: 'retry failed merge repair',
      dependencies: ['missing-prd'],
      userStories: [
        { id: 'US-001', title: 'One', description: 'one', acceptanceCriteria: ['done'] },
        { id: 'US-002', title: 'Two', description: 'two', acceptanceCriteria: ['done'] },
      ],
    }, null, 2));
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: taskId,
      prdPath,
      prdId: 'retry-failed-merge-prd',
      prdDependencies: ['missing-prd'],
      status: 'failed',
      startTime: Date.now(),
      endTime: Date.now(),
      completedUS: ['US-001', 'US-002'],
      worktree: path.join(repoDir, '.ralph-worktrees', taskId),
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      intendedMergeTarget: 'main',
      integrationStatus: 'blocked_conflict',
      integrationBranch: 'ralph/integration/main',
      integrationWorktree: '/tmp/integration',
      mergeTargetBranch: 'main',
      mergeStrategy: 'manual',
      mergeError: 'Merge conflicts detected: src/one.ts, src/two.ts',
      mergeConflictFiles: ['src/one.ts', 'src/two.ts'],
      mergeConflictAt: 61,
      mergeRepairAttempts: 4,
      postFinalizeMergeProbeRequired: true,
      repairContext: {
        mode: 'merge',
        storyId: 'US-002',
        createdAt: 9,
        reason: 'Merge repair required by Ralph.',
      },
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'failed', attempts: 2, lastError: 'merge failed', updatedAt: 1 },
      ],
      loopCount: 5,
      consecutiveNoProgress: 2,
      consecutiveErrors: 1,
      lastProgressTime: 1,
      lastFilesChanged: 1,
    }, null, 2));

    const result = runCli(['retry', taskId], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf-8'));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.previousStatus, 'failed');
    assert.equal(output.currentStatus, 'pending');
    assert.deepEqual(output.resetStoryIds, ['US-002']);
    assert.deepEqual(state.completedUS, ['US-001']);
    assert.equal(state.storyProgress[1].status, 'pending');
    assert.equal(state.storyProgress[1].attempts, 0);
    assert.match(state.storyProgress[1].lastError, /Merge repair required by Ralph/);
    assert.deepEqual(state.repairContext, {
      mode: 'merge',
      storyId: 'US-002',
      createdAt: state.repairContext.createdAt,
      reason: state.repairContext.reason,
    });
    assert.match(state.repairContext.reason, /src\/one\.ts, src\/two\.ts/);
    assert.equal(state.integrationStatus, 'not_started');
    assert.equal(state.postFinalizeMergeProbeRequired, true);
    assert.equal(state.mergeError, undefined);
    assert.equal(state.mergeConflictFiles, undefined);
    assert.equal(state.mergeRepairAttempts, 0);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('retry --finalize-only keeps completed stories and restores ready_to_finalize', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-retry-finalize-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-retry-finalize-repo-'));
  const taskId = 'failed-finalize-only-task';
  const taskDir = path.join(homeDir, '.ralph', 'tasks', taskId);
  const prdPath = path.join(repoDir, 'prd.json');

  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(prdPath, JSON.stringify({
      id: 'retry-finalize-prd',
      title: 'Retry Finalize PRD',
      description: 'retry finalize only',
      dependencies: [],
      userStories: [
        { id: 'US-001', title: 'One', description: 'one', acceptanceCriteria: ['done'] },
      ],
    }, null, 2));
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: taskId,
      prdPath,
      prdId: 'retry-finalize-prd',
      prdDependencies: [],
      status: 'failed_finalize',
      startTime: Date.now(),
      endTime: Date.now(),
      completedUS: ['US-001'],
      worktree: path.join(repoDir, '.ralph-worktrees', taskId),
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      loopCount: 5,
      consecutiveNoProgress: 2,
      consecutiveErrors: 1,
      lastProgressTime: 1,
      lastFilesChanged: 1,
      finalizerCommitSha: 'abc123',
      finalizerCommitMessage: 'feat: finalize old attempt',
      finalizerCommittedAt: 30,
      postFinalizeMergeProbeRequired: true,
      finalizerAttempts: 2,
      repairContext: {
        mode: 'merge',
        storyId: 'US-001',
        createdAt: 9,
        reason: 'Merge conflicts detected',
      },
      integratedAt: 40,
      integrationStatus: 'blocked_conflict',
      integrationCommitSha: 'def456',
      integrationBranch: 'ralph/integration/main',
      integrationWorktree: '/tmp/integration',
      targetSyncedAt: 50,
      targetSyncStatus: 'failed',
      targetSyncDeferredReason: 'main sync deferred',
      mergedAt: 60,
      mergeCommitSha: '789abc',
      mergeTargetBranch: 'main',
      mergeStrategy: 'manual',
      mergeMessage: 'merge old attempt',
      mergeError: 'merge conflict',
      mergeConflictFiles: ['docs/TODO.md'],
      mergeConflictAt: 61,
      lastErrorKind: 'merge_conflict',
      lastErrorClass: 'merge_conflict',
      lastErrorRetryable: true,
      lastErrorObservedAt: 25,
      transientRetryCount: 2,
      transientRetryBudget: 3,
      transientRetryLastDelayMs: 15000,
      finalizeRepairStartedAt: 10,
      finalizeRepairDeadlineAt: 20,
      finalizeRepairLastFailureSnapshot: {
        headSha: 'abc123',
        commitsAheadOfBase: 1,
        changedFiles: 1,
        worktreeDiffSignature: 'sig-1',
        failureKind: 'merge_conflict',
        failureSignature: 'merge conflict',
        capturedAt: 10,
      },
      finalizeRepairLastProgressAt: 11,
      finalizeRepairLastProgressReason: 'HEAD changed',
      finalizeRepairConsecutiveNoProgress: 1,
      finalizeRepairTotalRequeues: 3,
      finalizeRepairStoppedAt: 12,
      finalizeRepairStopReason: 'repair_no_progress',
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
      ],
    }, null, 2));

    const result = runCli(['retry', taskId, '--finalize-only'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf-8'));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.previousStatus, 'failed_finalize');
    assert.equal(output.currentStatus, 'ready_to_finalize');
    assert.equal(output.finalizeOnly, true);
    assert.deepEqual(output.resetStoryIds, []);
    assert.deepEqual(state.completedUS, ['US-001']);
    assert.equal(state.storyProgress[0].status, 'passed');
    assert.equal(state.finalizerCommitSha, undefined);
    assert.equal(state.finalizerCommitMessage, undefined);
    assert.equal(state.finalizerCommittedAt, undefined);
    assert.equal(state.finalizerAttempts, 0);
    assert.equal(state.repairContext, undefined);
    assert.equal(state.postFinalizeMergeProbeRequired, true);
    assert.equal(state.integratedAt, undefined);
    assert.equal(state.integrationStatus, 'not_started');
    assert.equal(state.integrationCommitSha, undefined);
    assert.equal(state.integrationBranch, undefined);
    assert.equal(state.integrationWorktree, undefined);
    assert.equal(state.targetSyncedAt, undefined);
    assert.equal(state.targetSyncStatus, 'not_requested');
    assert.equal(state.targetSyncDeferredReason, undefined);
    assert.equal(state.mergedAt, undefined);
    assert.equal(state.mergeCommitSha, undefined);
    assert.equal(state.mergeTargetBranch, undefined);
    assert.equal(state.mergeStrategy, undefined);
    assert.equal(state.mergeMessage, undefined);
    assert.equal(state.mergeError, undefined);
    assert.equal(state.mergeConflictFiles, undefined);
    assert.equal(state.mergeConflictAt, undefined);
    assert.equal(state.lastErrorKind, undefined);
    assert.equal(state.lastErrorClass, undefined);
    assert.equal(state.lastErrorRetryable, undefined);
    assert.equal(state.lastErrorObservedAt, undefined);
    assert.equal(state.transientRetryCount, 0);
    assert.equal(state.transientRetryBudget, undefined);
    assert.equal(state.transientRetryLastDelayMs, undefined);
    assert.equal(state.finalizeRepairStartedAt, undefined);
    assert.equal(state.finalizeRepairDeadlineAt, undefined);
    assert.equal(state.finalizeRepairLastFailureSnapshot, undefined);
    assert.equal(state.finalizeRepairLastProgressAt, undefined);
    assert.equal(state.finalizeRepairLastProgressReason, undefined);
    assert.equal(state.finalizeRepairConsecutiveNoProgress, 0);
    assert.equal(state.finalizeRepairTotalRequeues, 0);
    assert.equal(state.finalizeRepairStoppedAt, undefined);
    assert.equal(state.finalizeRepairStopReason, undefined);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('retry sends failed_finalize merge conflicts back to anchored merge repair instead of rerunning finalizer only', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-retry-merge-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-retry-merge-repo-'));
  const taskId = 'failed-finalize-merge-task';
  const taskDir = path.join(homeDir, '.ralph', 'tasks', taskId);
  const prdPath = path.join(repoDir, 'prd.json');

  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(prdPath, JSON.stringify({
      id: 'retry-merge-prd',
      title: 'Retry Merge PRD',
      description: 'retry merge repair',
      dependencies: ['missing-prd'],
      userStories: [
        { id: 'US-001', title: 'One', description: 'one', acceptanceCriteria: ['done'] },
        { id: 'US-002', title: 'Two', description: 'two', acceptanceCriteria: ['done'] },
        { id: 'US-003', title: 'Three', description: 'three', acceptanceCriteria: ['done'] },
      ],
    }, null, 2));
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: taskId,
      prdPath,
      prdId: 'retry-merge-prd',
      prdDependencies: ['missing-prd'],
      status: 'failed_finalize',
      startTime: Date.now(),
      endTime: Date.now(),
      completedUS: ['US-001', 'US-002', 'US-003'],
      worktree: path.join(repoDir, '.ralph-worktrees', taskId),
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      intendedMergeTarget: 'main',
      loopCount: 5,
      consecutiveNoProgress: 2,
      consecutiveErrors: 1,
      lastProgressTime: 1,
      lastFilesChanged: 1,
      finalizerCommitSha: 'abc123',
      finalizerCommitMessage: 'feat: finalize old attempt',
      finalizerCommittedAt: 30,
      postFinalizeMergeProbeRequired: true,
      finalizerAttempts: 2,
      integrationStatus: 'blocked_conflict',
      integrationBranch: 'ralph/integration/main',
      integrationWorktree: '/tmp/integration',
      mergeTargetBranch: 'main',
      mergeStrategy: 'manual',
      mergeError: 'Merge conflicts detected: src/one.ts, src/two.ts',
      mergeConflictFiles: ['src/one.ts', 'src/two.ts'],
      mergeConflictAt: 61,
      mergeRepairAttempts: 4,
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-003', status: 'passed', attempts: 1, updatedAt: 1 },
      ],
    }, null, 2));

    const result = runCli(['retry', taskId], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf-8'));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.previousStatus, 'failed_finalize');
    assert.equal(output.currentStatus, 'pending');
    assert.deepEqual(output.resetStoryIds, ['US-003']);
    assert.deepEqual(state.completedUS, ['US-001', 'US-002']);
    assert.equal(state.storyProgress[2].status, 'pending');
    assert.equal(state.storyProgress[2].attempts, 0);
    assert.match(state.storyProgress[2].lastError, /Merge repair required by Ralph/);
    assert.deepEqual(state.repairContext, {
      mode: 'merge',
      storyId: 'US-003',
      createdAt: state.repairContext.createdAt,
      reason: state.repairContext.reason,
    });
    assert.match(state.repairContext.reason, /src\/one\.ts, src\/two\.ts/);
    assert.equal(state.integrationStatus, 'not_started');
    assert.equal(state.postFinalizeMergeProbeRequired, true);
    assert.equal(state.mergeError, undefined);
    assert.equal(state.mergeConflictFiles, undefined);
    assert.equal(state.finalizerAttempts, 0);
    assert.equal(state.mergeRepairAttempts, 0);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('retry sends completed blocked_conflict tasks back to anchored merge repair', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-retry-completed-merge-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-retry-completed-merge-repo-'));
  const taskId = 'completed-blocked-conflict-task';
  const taskDir = path.join(homeDir, '.ralph', 'tasks', taskId);
  const prdPath = path.join(repoDir, 'prd.json');

  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(prdPath, JSON.stringify({
      id: 'retry-completed-merge-prd',
      title: 'Retry Completed Merge PRD',
      description: 'retry completed merge repair',
      dependencies: ['missing-prd'],
      userStories: [
        { id: 'US-001', title: 'One', description: 'one', acceptanceCriteria: ['done'] },
        { id: 'US-002', title: 'Two', description: 'two', acceptanceCriteria: ['done'] },
        { id: 'US-003', title: 'Three', description: 'three', acceptanceCriteria: ['done'] },
      ],
    }, null, 2));
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: taskId,
      prdPath,
      prdId: 'retry-completed-merge-prd',
      prdDependencies: ['missing-prd'],
      status: 'completed',
      startTime: Date.now(),
      endTime: Date.now(),
      completedUS: ['US-001', 'US-002', 'US-003'],
      worktree: path.join(repoDir, '.ralph-worktrees', taskId),
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      intendedMergeTarget: 'main',
      loopCount: 5,
      consecutiveNoProgress: 2,
      consecutiveErrors: 1,
      lastProgressTime: 1,
      lastFilesChanged: 1,
      finalizerCommitSha: 'abc123',
      finalizerCommitMessage: 'feat: finalize old attempt',
      finalizerCommittedAt: 30,
      postFinalizeMergeProbeRequired: true,
      finalizerAttempts: 2,
      integrationStatus: 'blocked_conflict',
      integrationBranch: 'ralph/integration/main',
      integrationWorktree: '/tmp/integration',
      mergeTargetBranch: 'main',
      mergeStrategy: 'manual',
      mergeError: 'Merge conflicts detected: src/one.ts, src/two.ts',
      mergeConflictFiles: ['src/one.ts', 'src/two.ts'],
      mergeConflictAt: 61,
      mergeRepairAttempts: 4,
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-003', status: 'in_progress', attempts: 2, updatedAt: 1 },
      ],
    }, null, 2));

    const result = runCli(['retry', taskId], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf-8'));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.previousStatus, 'completed');
    assert.equal(output.currentStatus, 'pending');
    assert.deepEqual(output.resetStoryIds, ['US-003']);
    assert.deepEqual(state.completedUS, ['US-001', 'US-002']);
    assert.equal(state.storyProgress[2].status, 'pending');
    assert.equal(state.storyProgress[2].attempts, 0);
    assert.match(state.storyProgress[2].lastError, /Merge repair required by Ralph/);
    assert.deepEqual(state.repairContext, {
      mode: 'merge',
      storyId: 'US-003',
      createdAt: state.repairContext.createdAt,
      reason: state.repairContext.reason,
    });
    assert.match(state.repairContext.reason, /src\/one\.ts, src\/two\.ts/);
    assert.equal(state.integrationStatus, 'not_started');
    assert.equal(state.postFinalizeMergeProbeRequired, true);
    assert.equal(state.mergeError, undefined);
    assert.equal(state.mergeConflictFiles, undefined);
    assert.equal(state.finalizerAttempts, 0);
    assert.equal(state.mergeRepairAttempts, 0);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('retry preserves anchored merge repair for stagnant blocked_conflict tasks', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-retry-stagnant-merge-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-retry-stagnant-merge-repo-'));
  const taskId = 'stagnant-blocked-conflict-task';
  const taskDir = path.join(homeDir, '.ralph', 'tasks', taskId);
  const prdPath = path.join(repoDir, 'prd.json');

  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(prdPath, JSON.stringify({
      id: 'retry-stagnant-merge-prd',
      title: 'Retry Stagnant Merge PRD',
      description: 'retry stagnant merge repair',
      dependencies: ['missing-prd'],
      userStories: [
        { id: 'US-001', title: 'One', description: 'one', acceptanceCriteria: ['done'] },
        { id: 'US-002', title: 'Two', description: 'two', acceptanceCriteria: ['done'] },
        { id: 'US-003', title: 'Three', description: 'three', acceptanceCriteria: ['done'] },
      ],
    }, null, 2));
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: taskId,
      prdPath,
      prdId: 'retry-stagnant-merge-prd',
      prdDependencies: ['missing-prd'],
      status: 'stagnant',
      startTime: Date.now(),
      endTime: Date.now(),
      completedUS: ['US-001', 'US-002', 'US-003'],
      worktree: path.join(repoDir, '.ralph-worktrees', taskId),
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      intendedMergeTarget: 'main',
      loopCount: 5,
      consecutiveNoProgress: 2,
      consecutiveErrors: 1,
      lastProgressTime: 1,
      lastFilesChanged: 1,
      postFinalizeMergeProbeRequired: true,
      integrationStatus: 'blocked_conflict',
      integrationBranch: 'ralph/integration/main',
      integrationWorktree: '/tmp/integration',
      mergeTargetBranch: 'main',
      mergeStrategy: 'manual',
      mergeError: 'Merge conflicts detected: src/one.ts, src/two.ts',
      mergeConflictFiles: ['src/one.ts', 'src/two.ts'],
      mergeConflictAt: 61,
      mergeRepairAttempts: 4,
      repairContext: {
        mode: 'merge',
        storyId: 'US-003',
        createdAt: 9,
        reason: 'Merge repair required by Ralph.',
      },
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-003', status: 'in_progress', attempts: 2, updatedAt: 1 },
      ],
    }, null, 2));

    const result = runCli(['retry', taskId], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf-8'));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.previousStatus, 'stagnant');
    assert.equal(output.currentStatus, 'pending');
    assert.deepEqual(output.resetStoryIds, ['US-003']);
    assert.deepEqual(state.completedUS, ['US-001', 'US-002']);
    assert.equal(state.storyProgress[2].status, 'pending');
    assert.equal(state.storyProgress[2].attempts, 0);
    assert.match(state.storyProgress[2].lastError, /Merge repair required by Ralph/);
    assert.deepEqual(state.repairContext, {
      mode: 'merge',
      storyId: 'US-003',
      createdAt: state.repairContext.createdAt,
      reason: state.repairContext.reason,
    });
    assert.match(state.repairContext.reason, /src\/one\.ts, src\/two\.ts/);
    assert.equal(state.integrationStatus, 'not_started');
    assert.equal(state.postFinalizeMergeProbeRequired, true);
    assert.equal(state.mergeError, undefined);
    assert.equal(state.mergeConflictFiles, undefined);
    assert.equal(state.mergeRepairAttempts, 0);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
