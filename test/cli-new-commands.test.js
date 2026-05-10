const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');

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

function hashFile(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('queue command reports active queue state', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-home-'));

  try {
    const taskDir = path.join(homeDir, '.ralph', 'tasks', 'pending-task');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: 'pending-task',
      prdPath: '/tmp/prd.json',
      prdId: 'pending-prd',
      prdDependencies: [],
      status: 'pending',
      startTime: Date.now(),
      completedUS: [],
      worktree: '',
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['queue'], { HOME: homeDir });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.schemaVersion, 2);
    assert.equal(output.tasks.length, 1);
    assert.equal(output.tasks[0].id, 'pending-task');
    assert.equal(output.tasks[0].queueState.phase, 'queued');
    assert.equal(output.tasks[0].queueState.detail, 'waiting_for_slot');
    assert.equal(output.tasks[0].nextAction, 'start when a concurrency slot is available');
    assert.equal(output.repoCount, 1);
    assert.equal(output.mixedRepos, false);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue command does not count running tasks with stale recovery residue as active recovery', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-running-recovery-residue-home-'));

  try {
    const taskDir = path.join(homeDir, '.ralph', 'tasks', 'running-task');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: 'running-task',
      prdPath: '/tmp/prd.json',
      prdId: 'running-prd',
      prdDependencies: [],
      status: 'running',
      startTime: Date.now(),
      completedUS: [],
      worktree: '/tmp/running-task',
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      autoRecoveryKind: 'stagnant',
      autoRecoveryTotalRequeues: 14,
      autoRecoveryLastReason: 'Automatically requeued after stagnation timeout',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['queue'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const task = output.tasks[0];

    assert.equal(result.status, 0, result.stderr);
    assert.equal(task.queueState.phase, 'running');
    assert.equal(task.queueState.detail, 'worker_running');
    assert.equal(task.autoRecovery.active, false);
    assert.equal(task.autoRecovery.kind, 'stagnant');
    assert.equal(task.autoRecovery.staleInvalidReason, 'task_running_not_waiting_for_recovery');
    assert.equal(task.queueState.recovery.active, false);
    assert.equal(output.summary.running, 1);
    assert.equal(output.summary.autoRecoveryActive, 0);
    assert.equal(output.summary.recoveryActive, 0);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue command reports coordination blockers for overlapping pending tasks', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-coordination-home-'));

  try {
    const firstTaskDir = path.join(homeDir, '.ralph', 'tasks', 'first-task');
    const secondTaskDir = path.join(homeDir, '.ralph', 'tasks', 'second-task');
    fs.mkdirSync(firstTaskDir, { recursive: true });
    fs.mkdirSync(secondTaskDir, { recursive: true });

    fs.writeFileSync(path.join(firstTaskDir, 'state.json'), JSON.stringify({
      id: 'first-task',
      prdPath: '/tmp/first.json',
      prdId: 'first-prd',
      prdDependencies: [],
      status: 'pending',
      startTime: 100,
      enqueuedAt: 100,
      completedUS: [],
      worktree: '',
      logPath: path.join(firstTaskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      declaredConflictDomains: ['contracts-index'],
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 0,
    }, null, 2));
    fs.writeFileSync(path.join(secondTaskDir, 'state.json'), JSON.stringify({
      id: 'second-task',
      prdPath: '/tmp/second.json',
      prdId: 'second-prd',
      prdDependencies: [],
      status: 'pending',
      startTime: 200,
      enqueuedAt: 200,
      completedUS: [],
      worktree: '',
      logPath: path.join(secondTaskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      declaredConflictDomains: ['contracts-index'],
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 200,
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['queue'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const secondTask = output.tasks.find((task) => task.id === 'second-task');

    assert.equal(result.status, 0, result.stderr);
    assert.equal(secondTask.reason, 'coordination');
    assert.deepEqual(secondTask.blockers, ['first-task']);
    assert.match(secondTask.nextAction, /earlier overlapping task/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue command marks pending tasks blocked by failed dependencies as queue actions', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-failed-dep-home-'));

  try {
    const depTaskDir = path.join(homeDir, '.ralph', 'tasks', 'failed-dependency');
    const childTaskDir = path.join(homeDir, '.ralph', 'tasks', 'blocked-child');
    fs.mkdirSync(depTaskDir, { recursive: true });
    fs.mkdirSync(childTaskDir, { recursive: true });

    fs.writeFileSync(path.join(depTaskDir, 'state.json'), JSON.stringify({
      id: 'failed-dependency',
      prdPath: '/tmp/dep.json',
      prdId: 'dep-prd',
      prdDependencies: [],
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001'],
      worktree: '/tmp/dep',
      logPath: path.join(depTaskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      lastError: 'dependency story did not pass',
      lastErrorKind: 'story_incomplete',
      lastErrorRetryable: false,
      autoRecoveryKind: 'stagnant',
      autoRecoveryLastReason: 'stale recovery residue',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 0,
    }, null, 2));
    fs.writeFileSync(path.join(childTaskDir, 'state.json'), JSON.stringify({
      id: 'blocked-child',
      prdPath: '/tmp/child.json',
      prdId: 'child-prd',
      prdDependencies: ['dep-prd'],
      status: 'pending',
      startTime: 200,
      completedUS: [],
      worktree: '',
      logPath: path.join(childTaskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 200,
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['queue'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const childTask = output.tasks.find((task) => task.id === 'blocked-child');
    const failedTask = output.tasks.find((task) => task.id === 'failed-dependency');
    const childAction = output.actions.find((task) => task.id === 'blocked-child');

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.schemaVersion, 2);
    assert.equal(output.actions.length, 1);
    assert.equal(output.summary.recovering, 1);
    assert.equal(output.summary.autoRecoveryActive, 0);
    assert.equal(failedTask.queueState.phase, 'recovering');
    assert.equal(failedTask.queueState.detail, 'auto_repairing_story');
    assert.equal(failedTask.autoRecovery.active, false);
    assert.equal(failedTask.autoRecovery.staleInvalidReason, 'semantic_story_incomplete_is_not_auto_recovering');
    assert.equal(childTask.reason, 'dependencies');
    assert.deepEqual(childTask.failedDependencies, ['dep-prd']);
    assert.deepEqual(childTask.recoveringDependencies, []);
    assert.equal(childTask.queueState.phase, 'blocked');
    assert.equal(childTask.queueState.detail, 'blocked_by_dependency');
    assert.equal(childTask.queueState.reason, 'blocked_failed_dependency');
    assert.match(childTask.nextAction, /blocked by failed dependencies: dep-prd/);
    assert.deepEqual(childAction.blockers, ['dep-prd']);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue command marks pending tasks blocked by failed coordination owners as queue actions', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-failed-coordination-home-'));

  try {
    const failedOwnerDir = path.join(homeDir, '.ralph', 'tasks', 'failed-owner');
    const laterTaskDir = path.join(homeDir, '.ralph', 'tasks', 'later-task');
    fs.mkdirSync(failedOwnerDir, { recursive: true });
    fs.mkdirSync(laterTaskDir, { recursive: true });

    fs.writeFileSync(path.join(failedOwnerDir, 'state.json'), JSON.stringify({
      id: 'failed-owner',
      prdPath: '/tmp/owner.json',
      prdId: 'owner-prd',
      prdDependencies: [],
      status: 'failed',
      startTime: 100,
      enqueuedAt: 100,
      completedUS: ['US-001'],
      worktree: '/tmp/owner',
      logPath: path.join(failedOwnerDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      declaredWriteSurface: ['packages/contracts/src/index.ts'],
      observedWriteSurface: ['packages/contracts/src/index.ts'],
      mergeConflictFiles: ['packages/contracts/src/index.ts'],
      repairContext: {
        mode: 'merge',
        storyId: 'US-003',
        createdAt: 123,
        reason: 'Merge repair required by Ralph.',
      },
      lastError: 'merge repair did not converge',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 0,
    }, null, 2));
    fs.writeFileSync(path.join(laterTaskDir, 'state.json'), JSON.stringify({
      id: 'later-task',
      prdPath: '/tmp/later.json',
      prdId: 'later-prd',
      prdDependencies: [],
      status: 'pending',
      startTime: 200,
      enqueuedAt: 200,
      completedUS: [],
      worktree: '',
      logPath: path.join(laterTaskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      declaredWriteSurface: ['packages/contracts/src/index.ts'],
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 200,
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['queue'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const laterTask = output.tasks.find((task) => task.id === 'later-task');
    const laterAction = output.actions.find((task) => task.id === 'later-task');

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.actions.length, 2);
    assert.equal(laterTask.reason, 'coordination');
    assert.deepEqual(laterTask.blockers, ['failed-owner']);
    assert.deepEqual(laterTask.failedBlockers, ['failed-owner']);
    assert.equal(laterTask.queueState.phase, 'blocked');
    assert.equal(laterTask.queueState.detail, 'blocked_by_coordination');
    assert.equal(laterTask.queueState.reason, 'blocked_failed_coordination');
    assert.match(laterTask.nextAction, /blocked by failed overlapping task/);
    assert.deepEqual(laterAction.blockers, ['failed-owner']);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue command honors the global --home option', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-global-home-'));
  const customHome = path.join(homeDir, 'custom-ralph-home');

  try {
    const taskDir = path.join(customHome, 'tasks', 'pending-task');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: 'pending-task',
      prdPath: '/tmp/prd.json',
      prdId: 'pending-prd',
      prdDependencies: [],
      status: 'pending',
      startTime: Date.now(),
      completedUS: [],
      worktree: '',
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['--home', customHome, 'queue'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.ralphHome, customHome);
    assert.equal(output.tasks.length, 1);
    assert.equal(output.tasks[0].id, 'pending-task');
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue command includes completed tasks that still block integration', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-completed-blocker-home-'));

  try {
    const taskDir = path.join(homeDir, '.ralph', 'tasks', 'completed-blocker');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: 'completed-blocker',
      prdPath: '/tmp/prd.json',
      prdId: 'completed-prd',
      prdDependencies: [],
      status: 'completed',
      startTime: Date.now(),
      completedUS: ['US-001'],
      worktree: '',
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      integrationStatus: 'not_started',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['queue'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.tasks.length, 1);
    assert.equal(output.tasks[0].id, 'completed-blocker');
    assert.equal(output.tasks[0].status, 'completed');
    assert.equal(output.repoCount, 1);
    assert.deepEqual(output.repoPaths, ['/tmp/repo']);
    assert.match(output.tasks[0].nextAction, /manager should integrate this completed task/i);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue command reports completed integrated tasks with deferred target sync as delivery pending', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-deferred-target-sync-home-'));

  try {
    const taskDir = path.join(homeDir, '.ralph', 'tasks', 'completed-deferred-sync');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: 'completed-deferred-sync',
      prdPath: '/tmp/prd.json',
      prdId: 'completed-deferred-prd',
      prdDependencies: [],
      status: 'completed',
      startTime: Date.now(),
      completedUS: ['US-001'],
      worktree: '/tmp/worktree',
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      integrationStatus: 'integrated',
      integratedAt: Date.now(),
      integrationCommitSha: 'abc123',
      targetSyncStatus: 'deferred_dirty_checkout',
      targetSyncDeferredReason: 'sync deferred because main has local edits',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['queue'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.tasks.length, 1);
    assert.equal(output.tasks[0].id, 'completed-deferred-sync');
    assert.equal(output.tasks[0].queueState.phase, 'blocked');
    assert.equal(output.tasks[0].queueState.detail, 'blocked_by_environment');
    assert.equal(output.tasks[0].queueState.reason, 'target_sync_deferred_dirty_checkout');
    assert.match(output.tasks[0].nextAction, /retry if target sync is enabled/);
    assert.equal(output.summary.delivery.completedPendingTargetSync, 1);
    assert.equal(output.summary.delivery.completedTargetSyncFailed, 0);
    assert.equal(output.actions[0].reason, 'target_sync_deferred_dirty_checkout');
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue command marks target sync failures as environment blocks', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-failed-target-sync-home-'));

  try {
    const taskDir = path.join(homeDir, '.ralph', 'tasks', 'completed-failed-sync');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: 'completed-failed-sync',
      prdPath: '/tmp/prd.json',
      prdId: 'completed-failed-prd',
      prdDependencies: [],
      status: 'completed',
      startTime: Date.now(),
      completedUS: ['US-001'],
      worktree: '/tmp/worktree',
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      integrationStatus: 'integrated',
      integratedAt: Date.now(),
      integrationCommitSha: 'abc123',
      targetSyncStatus: 'failed',
      targetSyncDeferredReason: 'target branch is not a fast-forward',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['queue', '--compact'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.tasks.length, 1);
    assert.equal(output.tasks[0].queueState.phase, 'blocked');
    assert.equal(output.tasks[0].queueState.detail, 'blocked_by_environment');
    assert.equal(output.tasks[0].queueState.reason, 'target_sync_failed');
    assert.equal(output.summary.delivery.completedTargetSyncFailed, 1);
    assert.match(output.tasks[0].nextAction, /target branch was not updated/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue command reports capacity and queued blocker buckets', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-capacity-home-'));

  try {
    fs.mkdirSync(path.join(homeDir, '.ralph'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.ralph', 'config.json'), JSON.stringify({
      runner: {
        maxConcurrent: 2,
      },
    }, null, 2));

    const runningTaskDir = path.join(homeDir, '.ralph', 'tasks', 'running-task');
    const queuedTaskDir = path.join(homeDir, '.ralph', 'tasks', 'queued-task');
    const blockedTaskDir = path.join(homeDir, '.ralph', 'tasks', 'blocked-task');
    fs.mkdirSync(runningTaskDir, { recursive: true });
    fs.mkdirSync(queuedTaskDir, { recursive: true });
    fs.mkdirSync(blockedTaskDir, { recursive: true });

    fs.writeFileSync(path.join(runningTaskDir, 'state.json'), JSON.stringify({
      id: 'running-task',
      prdPath: '/tmp/running.json',
      prdId: 'running-prd',
      prdDependencies: [],
      status: 'running',
      pid: process.pid,
      startTime: 1,
      completedUS: [],
      currentUS: 'US-001',
      worktree: '/tmp/running',
      logPath: path.join(runningTaskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 1,
      lastFilesChanged: 0,
    }, null, 2));
    fs.writeFileSync(path.join(queuedTaskDir, 'state.json'), JSON.stringify({
      id: 'queued-task',
      prdPath: '/tmp/queued.json',
      prdId: 'queued-prd',
      prdDependencies: [],
      status: 'pending',
      startTime: 2,
      completedUS: [],
      worktree: '',
      logPath: path.join(queuedTaskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 2,
      lastFilesChanged: 0,
    }, null, 2));
    fs.writeFileSync(path.join(blockedTaskDir, 'state.json'), JSON.stringify({
      id: 'blocked-task',
      prdPath: '/tmp/blocked.json',
      prdId: 'blocked-prd',
      prdDependencies: ['missing-prd'],
      status: 'pending',
      startTime: 3,
      completedUS: [],
      worktree: '',
      logPath: path.join(blockedTaskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 3,
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['queue'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(output.summary.capacity, {
      maxConcurrent: 2,
      running: 1,
      available: 1,
      queuedRunnable: 1,
      queuedBlockedByDependencies: 1,
      queuedBlockedByCoordination: 0,
    });
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue command reports repo paths for auto-recovering failed tasks', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-recovering-failed-home-'));

  try {
    const taskDir = path.join(homeDir, '.ralph', 'tasks', 'recovering-failed');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: 'recovering-failed',
      prdPath: '/tmp/prd.json',
      prdId: 'recovering-prd',
      prdDependencies: [],
      status: 'failed',
      startTime: Date.now(),
      completedUS: [],
      worktree: '/tmp/worktree',
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/recovering-repo',
      autoRecoveryKind: 'transient',
      autoRecoveryNextEligibleAt: Date.now() + 60_000,
      lastErrorRetryable: true,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['queue'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.tasks.length, 1);
    assert.equal(output.tasks[0].id, 'recovering-failed');
    assert.equal(output.tasks[0].queueState.phase, 'recovering');
    assert.equal(output.tasks[0].queueState.detail, 'retrying_transient');
    assert.equal(output.repoCount, 1);
    assert.deepEqual(output.repoPaths, ['/tmp/recovering-repo']);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue command includes manager state and aggregate summary in one snapshot', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-manager-summary-home-'));
  const managerDir = path.join(homeDir, '.ralph', 'manager');

  try {
    fs.mkdirSync(managerDir, { recursive: true });
    fs.writeFileSync(path.join(managerDir, 'state.json'), JSON.stringify({
      pid: process.pid,
      status: 'running',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      pollIntervalMs: 10000,
      autoIngestEnabled: false,
      repo: '/tmp/repo',
      agent: 'codex',
      backend: 'cli',
      hostname: 'test-host',
      argv: ['ralph', 'manager'],
    }, null, 2));

    const runningTaskDir = path.join(homeDir, '.ralph', 'tasks', 'running-task');
    fs.mkdirSync(runningTaskDir, { recursive: true });
    fs.writeFileSync(path.join(runningTaskDir, 'state.json'), JSON.stringify({
      id: 'running-task',
      prdPath: '/tmp/a.json',
      prdId: 'running-prd',
      status: 'running',
      pid: process.pid,
      startTime: Date.now(),
      completedUS: [],
      currentUS: 'US-001',
      worktree: '/tmp/a',
      logPath: path.join(runningTaskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/repo-a',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['queue'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.manager.active, true);
    assert.equal(output.manager.state.pid, process.pid);
    assert.equal(output.summary.totalActive, 1);
    assert.equal(output.summary.byStatus.running, 1);
    assert.ok(Array.isArray(output.actions));
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue command reports not-ingested and changed PRD inventory', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-prd-inventory-home-'));
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-prd-inventory-watch-'));

  try {
    const changedPrdPath = path.join(watchDir, 'ez4ielts-changed.json');
    const notIngestedPrdPath = path.join(watchDir, 'ez4ielts-new.json');
    fs.writeFileSync(changedPrdPath, JSON.stringify({
      id: 'changed-prd',
      title: 'Changed PRD',
      description: 'changed since enqueue',
      userStories: [],
    }, null, 2));
    fs.writeFileSync(notIngestedPrdPath, JSON.stringify({
      id: 'new-prd',
      title: 'New PRD',
      description: 'not ingested',
      userStories: [],
    }, null, 2));

    fs.mkdirSync(path.join(homeDir, '.ralph'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.ralph', 'config.json'), JSON.stringify({
      ingestion: {
        ez4ielts: {
          enabled: true,
          watchDir,
          pattern: 'ez4ielts-*.json',
        },
      },
    }, null, 2));

    const taskDir = path.join(homeDir, '.ralph', 'tasks', 'changed-task');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: 'changed-task',
      prdPath: changedPrdPath,
      prdId: 'changed-prd',
      prdTitle: 'Changed PRD',
      prdSourceHash: `${hashFile(changedPrdPath)}-old`,
      prdDependencies: [],
      status: 'completed',
      startTime: Date.now(),
      completedUS: ['US-001'],
      worktree: '/tmp/worktree',
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      integrationStatus: 'integrated',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['queue'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const statuses = Object.fromEntries(output.prdInventory.items.map((item) => [path.basename(item.path), item.status]));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.ingestion.configuredEnabled, true);
    assert.equal(output.ingestion.watchDir, watchDir);
    assert.equal(output.ingestion.notIngestedCount, 1);
    assert.equal(output.ingestion.changedSinceIngestedCount, 1);
    assert.equal(output.prdInventory.enabled, true);
    assert.equal(output.prdInventory.totalFiles, 2);
    assert.equal(statuses['ez4ielts-changed.json'], 'changed_since_ingested');
    assert.equal(statuses['ez4ielts-new.json'], 'not_ingested');
    assert.match(output.ingestion.nextAction, /changed PRD files/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test('queue command compact mode trims heavy task payload fields', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-compact-home-'));

  try {
    const taskDir = path.join(homeDir, '.ralph', 'tasks', 'compact-task');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: 'compact-task',
      prdId: 'compact-prd',
      prdTitle: 'Compact Queue Payload',
      prdPath: '/tmp/compact.json',
      status: 'ready_to_finalize',
      startTime: Date.now(),
      updatedAt: Date.now(),
      currentUS: 'US-001',
      completedUS: ['US-000'],
      storyProgress: [
        {
          id: 'US-001',
          status: 'in_progress',
          attempts: 2,
          updatedAt: Date.now(),
          history: [
            {
              attempt: 1,
              status: 'failed',
              message: 'first try',
              evidence: 'verbose details',
              updatedAt: Date.now(),
            },
          ],
          lastEvidence: 'long evidence',
          lastError: 'long error',
        },
      ],
      repairContext: {
        mode: 'finalize',
        storyId: 'US-001',
        createdAt: Date.now(),
        reason: 'very long reason that should be stripped from compact mode',
      },
      worktree: '/tmp/worktree',
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      coordinationStatus: 'blocked_observed_overlap',
      coordinationPhase: 'finalize',
      coordinationBlockers: ['task-a'],
      coordinationReason: 'shared writes',
      integrationLane: 'main',
      declaredWriteSurface: ['packages/app/src'],
      declaredConflictDomains: ['contracts'],
      observedWriteSurface: ['packages/app/src/index.ts'],
      observedPackageSurface: ['packages/app'],
      surfaceCapturedAt: Date.now(),
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 1,
    }, null, 2));

    const result = runCli(['queue', '--compact'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const task = output.tasks[0];

    assert.equal(result.status, 0, result.stderr);
    assert.equal(task.prdTitle, 'Compact Queue Payload');
    assert.equal(task.worktree, '/tmp/worktree');
    assert.equal(task.completedUS, 1);
    assert.deepEqual(task.storyProgress, [{
      id: 'US-001',
      status: 'in_progress',
      attempts: 2,
      updatedAt: task.storyProgress[0].updatedAt,
    }]);
    assert.deepEqual(task.repairContext, {
      mode: 'finalize',
      storyId: 'US-001',
      createdAt: task.repairContext.createdAt,
    });
    assert.equal(task.integrationStatus, 'not_started');
    assert.equal(task.coordination.status, 'blocked_observed_overlap');
    assert.equal(task.coordination.reason, 'shared writes');
    assert.deepEqual(task.coordination.blockers, ['task-a']);
    assert.equal(task.coordination.observedWriteSurface, undefined);
    assert.equal(task.coordination.declaredConflictDomains, undefined);
    assert.equal(task.storyProgress[0].history, undefined);
    assert.equal(task.repairContext.reason, undefined);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue command suppresses action items for auto-recovering merge repairs already resolved for finalize', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-resolved-merge-repair-home-'));

  try {
    const taskDir = path.join(homeDir, '.ralph', 'tasks', 'resolved-repair-task');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: 'resolved-repair-task',
      prdPath: '/tmp/prd.json',
      prdId: 'resolved-prd',
      status: 'failed_finalize',
      startTime: Date.now(),
      completedUS: ['US-001'],
      worktree: '/tmp/worktree',
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      integrationStatus: 'blocked_conflict',
      autoRecoveryKind: 'merge_repair',
      mergeRepairDisplayStatus: 'resolved_pending_finalize',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['queue'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.actions.length, 0);
    assert.equal(output.tasks.length, 1);
    assert.equal(output.tasks[0].queueState.phase, 'finalizing');
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue command includes recent integrated tasks within the configured window', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-recent-completed-home-'));

  try {
    const now = Date.now();
    const recentTaskDir = path.join(homeDir, '.ralph', 'tasks', 'recent-completed');
    const oldTaskDir = path.join(homeDir, '.ralph', 'tasks', 'old-completed');
    fs.mkdirSync(recentTaskDir, { recursive: true });
    fs.mkdirSync(oldTaskDir, { recursive: true });
    fs.writeFileSync(path.join(recentTaskDir, 'state.json'), JSON.stringify({
      id: 'recent-completed',
      prdPath: '/tmp/recent.json',
      prdId: 'recent-prd',
      status: 'completed',
      startTime: now - 10_000,
      completedUS: ['US-001'],
      worktree: '/tmp/recent',
      logPath: path.join(recentTaskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      integrationStatus: 'integrated',
      updatedAt: now - 5_000,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: now - 5_000,
      lastFilesChanged: 1,
    }, null, 2));
    fs.writeFileSync(path.join(oldTaskDir, 'state.json'), JSON.stringify({
      id: 'old-completed',
      prdPath: '/tmp/old.json',
      prdId: 'old-prd',
      status: 'completed',
      startTime: now - 100_000,
      completedUS: ['US-001'],
      worktree: '/tmp/old',
      logPath: path.join(oldTaskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      integrationStatus: 'integrated',
      updatedAt: now - 50_000,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: now - 50_000,
      lastFilesChanged: 1,
    }, null, 2));

    const result = runCli([
      'queue',
      '--recent-completed-window-seconds',
      '10',
      '--recent-completed-limit',
      '3',
    ], { HOME: homeDir });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.summary.recentCompletedCount, 1);
    assert.equal(output.summary.totalCompletedCount, 2);
    assert.equal(output.recentCompleted.length, 1);
    assert.equal(output.recentCompleted[0].id, 'recent-completed');
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('doctor warns when overlap backlog exists but unattended integration is disabled', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-liveness-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-liveness-repo-'));

  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
    fs.mkdirSync(path.join(homeDir, '.ralph', 'tasks', 'completed-blocker'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.ralph', 'tasks', 'completed-blocker', 'state.json'), JSON.stringify({
      id: 'completed-blocker',
      prdPath: '/tmp/prd.json',
      status: 'completed',
      startTime: Date.now(),
      completedUS: ['US-001'],
      worktree: '',
      logPath: path.join(homeDir, '.ralph', 'tasks', 'completed-blocker', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      integrationStatus: 'not_started',
      coordinationStatus: 'blocked_observed_overlap',
      coordinationBlockers: ['older-task'],
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 0,
    }, null, 2));
    fs.mkdirSync(path.join(homeDir, '.ralph'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.ralph', 'config.json'), JSON.stringify({
      autoMerge: false,
      merge: {
        autoIntegrate: false,
        useIntegrationWorktree: true,
      },
    }, null, 2));

    const result = runCli(['doctor', '--repo', repoDir], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const livenessCheck = output.checks.find((check) => check.name === 'config.integration-liveness');

    assert.equal(result.status, 1);
    assert.equal(livenessCheck.ok, false);
    assert.match(livenessCheck.message, /completed tasks can stall unattended progress/i);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('doctor command returns preflight JSON', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-repo-'));

  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
    const result = runCli(['doctor', '--repo', repoDir], { HOME: homeDir });
    const output = JSON.parse(result.stdout);

    assert.equal(output.repoPath, repoDir);
    assert.equal(output.backend, 'cli');
    assert.ok(Array.isArray(output.checks));
    assert.ok(output.checks.some((check) => check.name === 'repo'));
    assert.ok(output.checks.some((check) => check.name === 'manager'));
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('manager-status command reports persisted manager heartbeat', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-manager-status-home-'));
  const managerDir = path.join(homeDir, '.ralph', 'manager');

  try {
    fs.mkdirSync(managerDir, { recursive: true });
    fs.writeFileSync(path.join(managerDir, 'state.json'), JSON.stringify({
      pid: process.pid,
      status: 'running',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      pollIntervalMs: 10000,
      autoIngestEnabled: false,
      repo: '/tmp/repo',
      agent: 'codex',
      backend: 'cli',
      hostname: 'test-host',
      argv: ['ralph', 'manager'],
    }, null, 2));
    const taskDirA = path.join(homeDir, '.ralph', 'tasks', 'task-a');
    const taskDirB = path.join(homeDir, '.ralph', 'tasks', 'task-b');
    fs.mkdirSync(taskDirA, { recursive: true });
    fs.mkdirSync(taskDirB, { recursive: true });
    fs.writeFileSync(path.join(taskDirA, 'state.json'), JSON.stringify({
      id: 'task-a',
      prdPath: '/tmp/a.json',
      prdId: 'task-a',
      status: 'running',
      startTime: 1,
      completedUS: [],
      worktree: '/tmp/a',
      logPath: path.join(taskDirA, 'agent.log'),
      agent: 'codex',
      repoPath: '/repo-a',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 1,
      lastFilesChanged: 0,
    }, null, 2));
    fs.writeFileSync(path.join(taskDirB, 'state.json'), JSON.stringify({
      id: 'task-b',
      prdPath: '/tmp/b.json',
      prdId: 'task-b',
      status: 'pending',
      startTime: 2,
      completedUS: [],
      worktree: '',
      logPath: path.join(taskDirB, 'agent.log'),
      agent: 'codex',
      repoPath: '/repo-b',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 2,
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['manager-status'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.ok, true);
    assert.equal(output.active, true);
    assert.equal(output.state.agent, 'codex');
    assert.equal(output.state.backend, 'cli');
    assert.equal(output.mixedRepos, true);
    assert.equal(output.repoCount, 2);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('manager-status command marks outdated manager code as not ok', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-manager-status-drift-home-'));
  const managerDir = path.join(homeDir, '.ralph', 'manager');
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-manager-status-drift-repo-'));
  const distDir = path.join(repoDir, 'dist');
  const entryPath = path.join(distDir, 'cli.js');
  const dependencyPath = path.join(distDir, 'core', 'finalize-repair-policy.js');

  try {
    fs.mkdirSync(managerDir, { recursive: true });
    fs.mkdirSync(path.dirname(dependencyPath), { recursive: true });
    fs.writeFileSync(entryPath, 'console.log("entry");\n');
    fs.writeFileSync(dependencyPath, 'console.log("dep");\n');
    fs.utimesSync(entryPath, 1, 1);
    fs.utimesSync(dependencyPath, 5, 5);
    fs.writeFileSync(path.join(managerDir, 'state.json'), JSON.stringify({
      pid: process.pid,
      status: 'running',
      startedAt: 2000,
      updatedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      pollIntervalMs: 10000,
      autoIngestEnabled: false,
      repo: '/tmp/repo',
      agent: 'codex',
      backend: 'cli',
      hostname: 'test-host',
      argv: ['node', entryPath, 'manager'],
    }, null, 2));

    const result = runCli(['manager-status'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.ok, false);
    assert.equal(output.codeDriftDetected, true);
    assert.equal(output.managerCodeLatestPath, dependencyPath);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('doctor command reports mixed active repos in the Ralph home', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-mixed-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-mixed-repo-'));

  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
    const taskDirA = path.join(homeDir, '.ralph', 'tasks', 'task-a');
    const taskDirB = path.join(homeDir, '.ralph', 'tasks', 'task-b');
    fs.mkdirSync(taskDirA, { recursive: true });
    fs.mkdirSync(taskDirB, { recursive: true });
    fs.writeFileSync(path.join(taskDirA, 'state.json'), JSON.stringify({
      id: 'task-a',
      prdPath: '/tmp/a.json',
      prdId: 'task-a',
      status: 'running',
      startTime: 1,
      completedUS: [],
      worktree: '/tmp/a',
      logPath: path.join(taskDirA, 'agent.log'),
      agent: 'codex',
      repoPath: '/repo-a',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 1,
      lastFilesChanged: 0,
    }, null, 2));
    fs.writeFileSync(path.join(taskDirB, 'state.json'), JSON.stringify({
      id: 'task-b',
      prdPath: '/tmp/b.json',
      prdId: 'task-b',
      status: 'pending',
      startTime: 2,
      completedUS: [],
      worktree: '',
      logPath: path.join(taskDirB, 'agent.log'),
      agent: 'codex',
      repoPath: '/repo-b',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 2,
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['doctor', '--repo', repoDir], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const repoCheck = output.checks.find((check) => check.name === 'ralph.home.repos');

    assert.equal(result.status, 1, result.stderr);
    assert.equal(output.mixedRepos, true);
    assert.equal(output.repoCount, 2);
    assert.equal(repoCheck.ok, false);
    assert.match(repoCheck.message, /multiple repos/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('doctor command fails when the Ralph home is already active for a different repo', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-foreign-home-'));
  const repoA = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-foreign-a-'));
  const repoB = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-foreign-b-'));

  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoA, stdio: 'ignore' });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoB, stdio: 'ignore' });
    const taskDir = path.join(homeDir, '.ralph', 'tasks', 'task-a');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: 'task-a',
      prdPath: path.join(repoA, 'a.json'),
      prdId: 'task-a',
      status: 'running',
      startTime: 1,
      completedUS: [],
      worktree: path.join(repoA, '.ralph-worktrees', 'task-a'),
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: repoA,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 1,
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['doctor', '--repo', repoB], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const repoCheck = output.checks.find((check) => check.name === 'ralph.home.repos');

    assert.equal(result.status, 1, result.stderr);
    assert.equal(output.mixedRepos, false);
    assert.equal(output.repoCount, 1);
    assert.equal(repoCheck.ok, false);
    assert.match(repoCheck.message, /different repo/i);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoA, { recursive: true, force: true });
    fs.rmSync(repoB, { recursive: true, force: true });
  }
});

test('manager command refuses to start when the Ralph home mixes active repos', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-manager-mixed-home-'));

  try {
    const taskDirA = path.join(homeDir, '.ralph', 'tasks', 'task-a');
    const taskDirB = path.join(homeDir, '.ralph', 'tasks', 'task-b');
    fs.mkdirSync(taskDirA, { recursive: true });
    fs.mkdirSync(taskDirB, { recursive: true });
    fs.writeFileSync(path.join(taskDirA, 'state.json'), JSON.stringify({
      id: 'task-a',
      prdPath: '/tmp/a.json',
      prdId: 'task-a',
      status: 'running',
      startTime: 1,
      completedUS: [],
      worktree: '/tmp/a',
      logPath: path.join(taskDirA, 'agent.log'),
      agent: 'codex',
      repoPath: '/repo-a',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 1,
      lastFilesChanged: 0,
    }, null, 2));
    fs.writeFileSync(path.join(taskDirB, 'state.json'), JSON.stringify({
      id: 'task-b',
      prdPath: '/tmp/b.json',
      prdId: 'task-b',
      status: 'pending',
      startTime: 2,
      completedUS: [],
      worktree: '',
      logPath: path.join(taskDirB, 'agent.log'),
      agent: 'codex',
      repoPath: '/repo-b',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 2,
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['manager', '--repo', '/repo-a'], { HOME: homeDir });
    const output = JSON.parse(result.stderr);

    assert.equal(result.status, 1);
    assert.match(output.error, /active tasks from multiple repos/i);
    assert.match(output.error, /--allow-mixed-home/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('doctor command fails when manager code is older than current dist on disk', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-drift-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-drift-repo-'));
  const managerDir = path.join(homeDir, '.ralph', 'manager');
  const distDir = path.join(repoDir, 'dist');
  const entryPath = path.join(distDir, 'cli.js');
  const dependencyPath = path.join(distDir, 'core', 'dependency-watcher.js');

  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
    fs.mkdirSync(managerDir, { recursive: true });
    fs.mkdirSync(path.dirname(dependencyPath), { recursive: true });
    fs.writeFileSync(entryPath, 'console.log("entry");\n');
    fs.writeFileSync(dependencyPath, 'console.log("dep");\n');
    fs.utimesSync(entryPath, 1, 1);
    fs.utimesSync(dependencyPath, 5, 5);
    fs.writeFileSync(path.join(managerDir, 'state.json'), JSON.stringify({
      pid: process.pid,
      status: 'running',
      startedAt: 2000,
      updatedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      pollIntervalMs: 10000,
      autoIngestEnabled: false,
      repo: repoDir,
      agent: 'codex',
      backend: 'cli',
      hostname: 'test-host',
      argv: ['node', entryPath, 'manager'],
    }, null, 2));

    const result = runCli(['doctor', '--repo', repoDir], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const managerCheck = output.checks.find((check) => check.name === 'manager');

    assert.equal(result.status, 1);
    assert.equal(output.ok, false);
    assert.equal(output.manager.codeDriftDetected, true);
    assert.match(managerCheck.message, /older than current code on disk/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('finalize command keeps task ready_to_finalize when blocked by an earlier overlapping task', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalize-coordination-home-'));

  try {
    const taskDirA = path.join(homeDir, '.ralph', 'tasks', 'task-a');
    const taskDirB = path.join(homeDir, '.ralph', 'tasks', 'task-b');
    fs.mkdirSync(taskDirA, { recursive: true });
    fs.mkdirSync(taskDirB, { recursive: true });

    fs.writeFileSync(path.join(taskDirA, 'state.json'), JSON.stringify({
      id: 'task-a',
      prdPath: '/tmp/a.json',
      prdId: 'task-a',
      status: 'ready_to_finalize',
      startTime: 100,
      enqueuedAt: 100,
      completedUS: ['US-001'],
      observedWriteSurface: ['packages/contracts/src/index.ts'],
      worktree: '',
      logPath: path.join(taskDirA, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
    }, null, 2));
    fs.writeFileSync(path.join(taskDirB, 'state.json'), JSON.stringify({
      id: 'task-b',
      prdPath: '/tmp/b.json',
      prdId: 'task-b',
      status: 'ready_to_finalize',
      startTime: 200,
      enqueuedAt: 200,
      completedUS: ['US-001'],
      observedWriteSurface: ['packages/contracts/src/index.ts'],
      worktree: '',
      logPath: path.join(taskDirB, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 200,
      lastFilesChanged: 1,
    }, null, 2));

    const result = runCli(['finalize', 'task-b'], { HOME: homeDir });
    const output = JSON.parse(result.stderr);
    const state = JSON.parse(fs.readFileSync(path.join(taskDirB, 'state.json'), 'utf-8'));

    assert.equal(result.status, 1);
    assert.equal(output.blocked, true);
    assert.deepEqual(output.blockers, ['task-a']);
    assert.equal(state.status, 'ready_to_finalize');
    assert.equal(state.coordinationStatus, 'blocked_observed_overlap');
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('merge command blocks completed task when an earlier overlapping task is not yet integrated', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-merge-coordination-home-'));

  try {
    const taskDirA = path.join(homeDir, '.ralph', 'tasks', 'task-a');
    const taskDirB = path.join(homeDir, '.ralph', 'tasks', 'task-b');
    fs.mkdirSync(taskDirA, { recursive: true });
    fs.mkdirSync(taskDirB, { recursive: true });

    fs.writeFileSync(path.join(taskDirA, 'state.json'), JSON.stringify({
      id: 'task-a',
      prdPath: '/tmp/a.json',
      prdId: 'task-a',
      status: 'completed',
      startTime: 100,
      enqueuedAt: 100,
      completedUS: ['US-001'],
      observedWriteSurface: ['packages/contracts/src/index.ts'],
      worktree: '',
      logPath: path.join(taskDirA, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
    }, null, 2));
    fs.writeFileSync(path.join(taskDirB, 'state.json'), JSON.stringify({
      id: 'task-b',
      prdPath: '/tmp/b.json',
      prdId: 'task-b',
      status: 'completed',
      startTime: 200,
      enqueuedAt: 200,
      completedUS: ['US-001'],
      observedWriteSurface: ['packages/contracts/src/index.ts'],
      worktree: '',
      logPath: path.join(taskDirB, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 200,
      lastFilesChanged: 1,
    }, null, 2));

    const result = runCli(['merge', 'task-b'], { HOME: homeDir });
    const output = JSON.parse(result.stderr.trim().split('\n').pop());
    const state = JSON.parse(fs.readFileSync(path.join(taskDirB, 'state.json'), 'utf-8'));

    assert.equal(result.status, 1);
    assert.equal(output.blocked, true);
    assert.deepEqual(output.blockers, ['task-a']);
    assert.equal(state.status, 'completed');
    assert.equal(state.coordinationStatus, 'blocked_observed_overlap');
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('manager-install dry-run resolves launchd manager config without writing plist', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-manager-install-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-manager-install-repo-'));
  const plistPath = path.join(homeDir, 'LaunchAgents', 'com.test.ralph.manager.plist');

  try {
    const result = runCli([
      'manager-install',
      '--dry-run',
      '--label',
      'com.test.ralph.manager',
      '--plist',
      plistPath,
      '--repo',
      repoDir,
      '--interval',
      '12345',
      '--auto-ingest-ez4ielts',
      '--ingest-existing-ez4ielts',
    ], { HOME: homeDir });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.dryRun, true);
    assert.equal(output.loaded, false);
    assert.equal(output.label, 'com.test.ralph.manager');
    assert.equal(output.plistPath, plistPath);
    assert.equal(output.workingDirectory, repoDir);
    assert.deepEqual(output.managerArgs.slice(0, 5), [
      'manager',
      '--interval',
      '12345',
      '--repo',
      repoDir,
    ]);
    assert.ok(output.managerArgs.includes('--auto-ingest-ez4ielts'));
    assert.ok(output.managerArgs.includes('--ingest-existing-ez4ielts'));
    assert.equal(fs.existsSync(plistPath), false);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('manager-install defaults to a home-specific label and log paths for custom Ralph homes', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-manager-install-custom-home-'));
  const customHome = path.join(homeDir, 'custom-ralph-home');
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-manager-install-custom-repo-'));

  try {
    const result = runCli([
      '--home',
      customHome,
      'manager-install',
      '--dry-run',
      '--repo',
      repoDir,
      '--disable-auto-ingest-ez4ielts',
    ], { HOME: homeDir });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.ralphHome, customHome);
    assert.match(output.label, /^com\.ralph\.manager\.[0-9a-f]{8}$/);
    assert.equal(output.stdoutPath, path.join(customHome, 'logs', 'manager.out.log'));
    assert.equal(output.stderrPath, path.join(customHome, 'logs', 'manager.err.log'));
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('doctor command respects configured codex CLI path', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-path-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-path-repo-'));
  const fakeCodex = path.join(homeDir, 'bin', 'fake-codex');

  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
    fs.mkdirSync(path.dirname(fakeCodex), { recursive: true });
    fs.writeFileSync(fakeCodex, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(fakeCodex, 0o755);
    fs.mkdirSync(path.join(homeDir, '.ralph'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.ralph', 'config.json'), JSON.stringify({
      agent: {
        path: fakeCodex,
      },
    }));

    const result = runCli(['doctor', '--repo', repoDir], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const codexCheck = output.checks.find((check) => check.name === 'codex');

    assert.equal(result.status, 0, result.stderr);
    assert.equal(codexCheck.ok, true);
    assert.match(codexCheck.message, /fake-codex is available/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('doctor command treats dirty repos as ok with integration worktree mode', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-integration-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-integration-repo-'));
  const fakeCodex = path.join(homeDir, 'bin', 'fake-codex');

  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Ralph Test'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'ralph@example.com'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repoDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(repoDir, 'dirty.txt'), 'dirty\n');

    fs.mkdirSync(path.dirname(fakeCodex), { recursive: true });
    fs.writeFileSync(fakeCodex, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(fakeCodex, 0o755);
    fs.mkdirSync(path.join(homeDir, '.ralph'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.ralph', 'config.json'), JSON.stringify({
      agent: {
        path: fakeCodex,
      },
      merge: {
        useIntegrationWorktree: true,
      },
    }));

    const result = runCli(['doctor', '--repo', repoDir], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const cleanCheck = output.checks.find((check) => check.name === 'repo.clean');

    assert.equal(result.status, 0, result.stderr);
    assert.equal(cleanCheck.ok, true);
    assert.match(cleanCheck.message, /integration worktree mode/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('cleanup command dry-runs old terminal worktrees', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-cleanup-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-cleanup-repo-'));
  const worktreePath = path.join(repoDir, '.ralph-worktrees', 'completed-task');

  try {
    fs.mkdirSync(worktreePath, { recursive: true });
    const taskDir = path.join(homeDir, '.ralph', 'tasks', 'completed-task');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: 'completed-task',
      prdPath: '/tmp/prd.json',
      status: 'completed',
      startTime: 1,
      endTime: 1,
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 1,
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['cleanup', '--older-than-hours', '0', '--dry-run'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.dryRun, true);
    assert.equal(output.candidates.length, 1);
    assert.equal(output.candidates[0].removed, false);
    assert.equal(fs.existsSync(worktreePath), true);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
