const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DependencyWatcher } = require('../dist/core/dependency-watcher.js');

class FakeStateManager {
  constructor(tasks = []) {
    this.tasks = new Map(tasks.map((task) => [task.id, { ...task }]));
  }

  async loadTask(taskId) {
    const task = this.tasks.get(taskId);
    return task ? { ...task } : null;
  }

  async listTasks(statusFilter) {
    const tasks = [...this.tasks.values()]
      .filter((task) => !statusFilter || task.status === statusFilter)
      .map((task) => ({ ...task }));

    return tasks.sort((a, b) => b.startTime - a.startTime);
  }

  async updateTask(taskId, updates) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    this.tasks.set(taskId, { ...task, ...updates });
  }
}

function git(cwd, args) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function createConfigManager(overrides = {}) {
  const values = {
    'runner.pollInterval': 10,
    'runner.maxTransientRecoveryRequeues': 5,
    'runner.transientRecoveryBaseDelaySeconds': 1,
    'runner.transientRecoveryMaxDelaySeconds': 5,
    'runner.transientRecoveryDeadlineSeconds': 3600,
    'runner.maxTransientRecoverySameSignature': 3,
    'runner.autoRecoveryHardCap': 20,
    'runner.autoRemediateFailedBlockers': true,
    'runner.maxFailedBlockerStoryRequeues': 1,
    'runner.failedBlockerRecoveryDeadlineSeconds': 3600,
    'runner.failedBlockerRecoveryHardCap': 2,
    'ingestion.ez4ielts.enabled': false,
    'autoMerge': false,
    'autoMergeDelay': 0,
    'merge.targetBranch': 'main',
    'merge.strategy': 'manual',
    'merge.pullLatest': true,
    'merge.integrationWorktreeDir': '.ralph-integration',
    'finalizer.repairPolicy': 'progress',
    'finalizer.maxRepairAttempts': 1,
    'finalizer.maxNoProgressRepairRounds': 2,
    'finalizer.repairDeadlineSeconds': 7200,
    'finalizer.repairHardCap': 20,
    ...overrides,
  };

  return {
    get(key) {
      return values[key];
    },
  };
}

function queuedPendingState() {
  return {
    reason: 'queued',
    dependencies: [],
    blockers: [],
    maxConcurrent: 3,
    running: 0,
  };
}

function createFailedBlockerWatcher(stateManager, pendingStates, configOverrides = {}) {
  return new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager(configOverrides),
      scheduler: {
        describePendingTask: async (task) => pendingStates[task.id] || queuedPendingState(),
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
    }
  );
}

test('dependency watcher auto-remediates failed story dependency blockers once', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-dependency',
      prdPath: '/tmp/dep.json',
      prdId: 'dep-prd',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'failed', attempts: 2, lastError: 'incomplete', updatedAt: 1 },
      ],
      worktree: '/tmp/dep-worktree',
      logPath: '/tmp/dep-agent.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'US-002 failed',
      lastErrorKind: 'story_incomplete',
      lastErrorObservedAt: 100,
    },
    {
      id: 'blocked-child',
      prdPath: '/tmp/child.json',
      prdId: 'child-prd',
      status: 'pending',
      startTime: 200,
      completedUS: [],
      worktree: '',
      logPath: '/tmp/child-agent.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 200,
      lastFilesChanged: 0,
    },
  ]);
  const watcher = createFailedBlockerWatcher(stateManager, {
    'blocked-child': {
      reason: 'dependencies',
      dependencies: ['dep-prd'],
      dependencyBlockers: [{
        prdId: 'dep-prd',
        taskId: 'failed-dependency',
        kind: 'task_failed',
        reason: 'US-002 failed',
        attentionRequired: true,
      }],
      failedDependencies: ['dep-prd'],
      blockers: [],
      maxConcurrent: 3,
      running: 0,
    },
  });

  await watcher.recoverFailedBlockers();

  const task = stateManager.tasks.get('failed-dependency');
  assert.equal(task.status, 'pending');
  assert.deepEqual(task.completedUS, ['US-001']);
  assert.equal(task.storyProgress[0].status, 'passed');
  assert.equal(task.storyProgress[0].attempts, 1);
  assert.equal(task.storyProgress[1].status, 'pending');
  assert.equal(task.storyProgress[1].attempts, 0);
  assert.equal(task.autoRecoveryKind, 'story_repair');
  assert.equal(task.failedBlockerRecoveryTotalRequeues, 1);
  assert.deepEqual(task.failedBlockerRecoveryDemandTaskIds, ['blocked-child']);
  assert.equal(task.lastError, undefined);
});

test('dependency watcher auto-remediates failed story coordination blockers once', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-owner',
      prdPath: '/tmp/owner.json',
      prdId: 'owner-prd',
      status: 'failed',
      startTime: 100,
      completedUS: [],
      storyProgress: [
        { id: 'US-001', status: 'failed', attempts: 2, lastError: 'incomplete', updatedAt: 1 },
      ],
      worktree: '/tmp/owner-worktree',
      logPath: '/tmp/owner-agent.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'US-001 failed',
      lastErrorKind: 'story_incomplete',
      lastErrorObservedAt: 100,
    },
    {
      id: 'later-task',
      prdPath: '/tmp/later.json',
      prdId: 'later-prd',
      status: 'pending',
      startTime: 200,
      completedUS: [],
      worktree: '',
      logPath: '/tmp/later-agent.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 200,
      lastFilesChanged: 0,
    },
  ]);
  const watcher = createFailedBlockerWatcher(stateManager, {
    'later-task': {
      reason: 'coordination',
      dependencies: [],
      blockers: ['failed-owner'],
      failedBlockers: ['failed-owner'],
      maxConcurrent: 3,
      running: 0,
    },
  });

  await watcher.recoverFailedBlockers();

  const task = stateManager.tasks.get('failed-owner');
  assert.equal(task.status, 'pending');
  assert.equal(task.storyProgress[0].status, 'pending');
  assert.equal(task.failedBlockerRecoveryTotalRequeues, 1);
  assert.deepEqual(task.failedBlockerRecoveryDemandTaskIds, ['later-task']);
});

test('dependency watcher leaves failed blocker attention after story repair budget is exhausted', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-dependency',
      prdPath: '/tmp/dep.json',
      prdId: 'dep-prd',
      status: 'failed',
      startTime: 100,
      completedUS: [],
      storyProgress: [
        { id: 'US-001', status: 'failed', attempts: 2, lastError: 'incomplete', updatedAt: 1 },
      ],
      worktree: '/tmp/dep-worktree',
      logPath: '/tmp/dep-agent.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'US-001 failed',
      lastErrorKind: 'story_incomplete',
      failedBlockerRecoveryTotalRequeues: 1,
    },
    {
      id: 'blocked-child',
      prdPath: '/tmp/child.json',
      prdId: 'child-prd',
      status: 'pending',
      startTime: 200,
      completedUS: [],
      worktree: '',
      logPath: '/tmp/child-agent.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 200,
      lastFilesChanged: 0,
    },
  ]);
  const watcher = createFailedBlockerWatcher(stateManager, {
    'blocked-child': {
      reason: 'dependencies',
      dependencies: ['dep-prd'],
      dependencyBlockers: [{
        prdId: 'dep-prd',
        taskId: 'failed-dependency',
        kind: 'task_failed',
        reason: 'US-001 failed',
        attentionRequired: true,
      }],
      failedDependencies: ['dep-prd'],
      blockers: [],
      maxConcurrent: 3,
      running: 0,
    },
  });

  await watcher.recoverFailedBlockers();

  const task = stateManager.tasks.get('failed-dependency');
  assert.equal(task.status, 'failed');
  assert.equal(task.failedBlockerRecoveryTotalRequeues, 1);
  assert.equal(task.failedBlockerRecoveryStopReason, 'failed_blocker_story_budget_exhausted');
  assert.equal(task.autoRecoveryStopReason, 'failed_blocker_story_budget_exhausted');
  assert.ok(task.failedBlockerRecoveryStoppedAt);
});

test('dependency watcher does not count prior generic auto-recovery against failed blocker story repair', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-dependency',
      prdPath: '/tmp/dep.json',
      prdId: 'dep-prd',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-002'],
      storyProgress: [
        { id: 'US-001', status: 'failed', attempts: 2, lastError: 'incomplete', updatedAt: 1 },
        { id: 'US-002', status: 'passed', attempts: 1, updatedAt: 1 },
      ],
      worktree: '/tmp/dep-worktree',
      logPath: '/tmp/dep-agent.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'US-001 failed',
      lastErrorKind: 'story_incomplete',
      autoRecoveryTotalRequeues: 2,
    },
    {
      id: 'blocked-child',
      prdPath: '/tmp/child.json',
      prdId: 'child-prd',
      status: 'pending',
      startTime: 200,
      completedUS: [],
      worktree: '',
      logPath: '/tmp/child-agent.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 200,
      lastFilesChanged: 0,
    },
  ]);
  const watcher = createFailedBlockerWatcher(stateManager, {
    'blocked-child': {
      reason: 'dependencies',
      dependencies: ['dep-prd'],
      dependencyBlockers: [{
        prdId: 'dep-prd',
        taskId: 'failed-dependency',
        kind: 'task_failed',
        reason: 'US-001 failed',
        attentionRequired: true,
      }],
      failedDependencies: ['dep-prd'],
      blockers: [],
      maxConcurrent: 3,
      running: 0,
    },
  });

  await watcher.recoverFailedBlockers();

  const task = stateManager.tasks.get('failed-dependency');
  assert.equal(task.status, 'pending');
  assert.equal(task.failedBlockerRecoveryTotalRequeues, 1);
  assert.equal(task.autoRecoveryTotalRequeues, 3);
  assert.equal(task.failedBlockerRecoveryStopReason, undefined);
});

test('dependency watcher refuses failed blocker story reset with integration markers', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-dependency',
      prdPath: '/tmp/dep.json',
      prdId: 'dep-prd',
      status: 'failed',
      startTime: 100,
      completedUS: [],
      storyProgress: [
        { id: 'US-001', status: 'failed', attempts: 2, lastError: 'incomplete', updatedAt: 1 },
      ],
      worktree: '/tmp/dep-worktree',
      logPath: '/tmp/dep-agent.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'US-001 failed',
      lastErrorKind: 'story_incomplete',
      integratedAt: 123,
    },
    {
      id: 'blocked-child',
      prdPath: '/tmp/child.json',
      prdId: 'child-prd',
      status: 'pending',
      startTime: 200,
      completedUS: [],
      worktree: '',
      logPath: '/tmp/child-agent.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 200,
      lastFilesChanged: 0,
    },
  ]);
  const watcher = createFailedBlockerWatcher(stateManager, {
    'blocked-child': {
      reason: 'dependencies',
      dependencies: ['dep-prd'],
      dependencyBlockers: [{
        prdId: 'dep-prd',
        taskId: 'failed-dependency',
        kind: 'task_failed',
        reason: 'US-001 failed',
        attentionRequired: true,
      }],
      failedDependencies: ['dep-prd'],
      blockers: [],
      maxConcurrent: 3,
      running: 0,
    },
  });

  await watcher.recoverFailedBlockers();

  const task = stateManager.tasks.get('failed-dependency');
  assert.equal(task.status, 'failed');
  assert.equal(task.storyProgress[0].status, 'failed');
  assert.equal(task.failedBlockerRecoveryStopReason, 'failed_blocker_unsafe_integrated_marker');
});

test('dependency watcher does not reset merge repair deadline exhausted blockers', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-merge-repair',
      prdPath: '/tmp/dep.json',
      prdId: 'dep-prd',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'needs_repair', attempts: 2, lastError: 'conflict', updatedAt: 1 },
      ],
      worktree: '/tmp/dep-worktree',
      logPath: '/tmp/dep-agent.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Worker merge repair deadline exhausted',
      lastErrorKind: 'merge_conflict',
      mergeRepairRecoveryStopReason: 'merge_repair_deadline_exhausted',
    },
    {
      id: 'blocked-child',
      prdPath: '/tmp/child.json',
      prdId: 'child-prd',
      status: 'pending',
      startTime: 200,
      completedUS: [],
      worktree: '',
      logPath: '/tmp/child-agent.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 200,
      lastFilesChanged: 0,
    },
  ]);
  const watcher = createFailedBlockerWatcher(stateManager, {
    'blocked-child': {
      reason: 'dependencies',
      dependencies: ['dep-prd'],
      dependencyBlockers: [{
        prdId: 'dep-prd',
        taskId: 'failed-merge-repair',
        kind: 'task_failed',
        reason: 'deadline exhausted',
        attentionRequired: true,
      }],
      failedDependencies: ['dep-prd'],
      blockers: [],
      maxConcurrent: 3,
      running: 0,
    },
  });

  await watcher.recoverFailedBlockers();

  const task = stateManager.tasks.get('failed-merge-repair');
  assert.equal(task.status, 'failed');
  assert.equal(task.storyProgress[0].status, 'needs_repair');
  assert.equal(task.failedBlockerRecoveryTotalRequeues, undefined);
  assert.equal(task.failedBlockerRecoveryStopReason, undefined);
});

test('dependency watcher recovers soft-failed tasks into finalize flow', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-soft-failed-'));
  const logPath = path.join(tempDir, 'agent.log');
  fs.writeFileSync(logPath, `
**Done**
- Reworked the exception layer

**Validation**
- 8 suites, 233 tests passed

Suggested commit message: refactor(api): replace raw service errors with domain exceptions
`);

  const stateManager = new FakeStateManager([
    {
      id: 'soft-failed',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001', 'US-002'],
      worktree: '/repo/.ralph-worktrees/soft-failed',
      logPath,
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 0,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 12,
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager(),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
      finalizer: () => ({
        success: true,
        committed: true,
        message: 'Committed task changes successfully',
        commitMessage: 'feat: recovered finalize',
      }),
    }
  );

  await watcher.recoverSoftFailedTasks();
  assert.equal(stateManager.tasks.get('soft-failed').status, 'ready_to_finalize');

  await watcher.finalizeReadyTasks();
  const task = stateManager.tasks.get('soft-failed');
  assert.equal(task.status, 'completed');
  assert.equal(task.finalizerCommitMessage, 'feat: recovered finalize');
});

test('dependency watcher recovers failed repair task when current worktree evidence still exists', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-failed-repair-recovery-'));
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-failed-repair-log-'));
  const logPath = path.join(taskDir, 'agent.log');

  try {
    git(repoDir, ['init']);
    git(repoDir, ['config', 'user.email', 'test@example.com']);
    git(repoDir, ['config', 'user.name', 'Test User']);

    const filePath = path.join(repoDir, 'tracked.txt');
    fs.writeFileSync(filePath, 'base\n');
    git(repoDir, ['add', 'tracked.txt']);
    git(repoDir, ['commit', '-m', 'initial']);

    const baseCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();

    fs.writeFileSync(filePath, 'repaired implementation still present\n');
    fs.writeFileSync(logPath, `
**Result**
The worktree now enforces the topology approval boundaries in code and tests.

**Verification**
\`npm test\` at the repo root passed.

Suggested commit message: feat: recover failed finalize repair
`);

    const stateManager = new FakeStateManager([
      {
        id: 'failed-repair-recovery',
        prdPath: '/tmp/prd.json',
        status: 'failed',
        startTime: 100,
        completedUS: ['US-001', 'US-002'],
        storyProgress: [
          { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
          { id: 'US-002', status: 'passed', attempts: 1, updatedAt: 1 },
          {
            id: 'US-003',
            status: 'failed',
            attempts: 2,
            lastEvidence: '3 file(s) changed in working tree',
            lastError: 'Agent reported success for US-003, but Ralph found no objective diff or commit evidence',
            updatedAt: 1,
          },
        ],
        worktree: repoDir,
        logPath,
        agent: 'codex',
        repoPath: '/repo',
        baseCommitSha,
        loopCount: 2,
        consecutiveNoProgress: 1,
        consecutiveErrors: 0,
        lastProgressTime: 100,
        lastFilesChanged: 0,
        lastError: 'Agent reported success for US-003, but Ralph found no objective diff or commit evidence',
      },
    ]);

    const watcher = new DependencyWatcher(
      {},
      {
        stateManager,
        configManager: createConfigManager(),
        scheduler: {
          schedulePendingTasks: async () => [],
        },
        sleep: async () => undefined,
        logger: { log() {}, error() {} },
      }
    );

    await watcher.recoverSoftFailedTasks();
    const task = stateManager.tasks.get('failed-repair-recovery');
    assert.equal(task.status, 'ready_to_finalize');
    assert.deepEqual(task.completedUS, ['US-001', 'US-002', 'US-003']);
    assert.equal(task.storyProgress[2].status, 'passed');
    assert.equal(task.lastError, undefined);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test('dependency watcher does not recover failed repair task when current worktree evidence is gone', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-failed-repair-clean-'));
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-failed-repair-clean-log-'));
  const logPath = path.join(taskDir, 'agent.log');

  try {
    git(repoDir, ['init']);
    git(repoDir, ['config', 'user.email', 'test@example.com']);
    git(repoDir, ['config', 'user.name', 'Test User']);

    const filePath = path.join(repoDir, 'tracked.txt');
    fs.writeFileSync(filePath, 'base\n');
    git(repoDir, ['add', 'tracked.txt']);
    git(repoDir, ['commit', '-m', 'initial']);

    const baseCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();

    fs.writeFileSync(logPath, `
**Result**
The worktree now enforces the topology approval boundaries in code and tests.

**Verification**
\`npm test\` at the repo root passed.

Suggested commit message: feat: recover failed finalize repair
`);

    const stateManager = new FakeStateManager([
      {
        id: 'failed-repair-clean',
        prdPath: '/tmp/prd.json',
        status: 'failed',
        startTime: 100,
        completedUS: ['US-001', 'US-002'],
        storyProgress: [
          { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
          { id: 'US-002', status: 'passed', attempts: 1, updatedAt: 1 },
          {
            id: 'US-003',
            status: 'failed',
            attempts: 2,
            lastEvidence: '3 file(s) changed in working tree',
            lastError: 'Agent reported success for US-003, but Ralph found no objective diff or commit evidence',
            updatedAt: 1,
          },
        ],
        worktree: repoDir,
        logPath,
        agent: 'codex',
        repoPath: '/repo',
        baseCommitSha,
        loopCount: 2,
        consecutiveNoProgress: 1,
        consecutiveErrors: 0,
        lastProgressTime: 100,
        lastFilesChanged: 0,
        lastError: 'Agent reported success for US-003, but Ralph found no objective diff or commit evidence',
      },
    ]);

    const watcher = new DependencyWatcher(
      {},
      {
        stateManager,
        configManager: createConfigManager(),
        scheduler: {
          schedulePendingTasks: async () => [],
        },
        sleep: async () => undefined,
        logger: { log() {}, error() {} },
      }
    );

    await watcher.recoverSoftFailedTasks();
    const task = stateManager.tasks.get('failed-repair-clean');
    assert.equal(task.status, 'failed');
    assert.deepEqual(task.completedUS, ['US-001', 'US-002']);
    assert.equal(task.storyProgress[2].status, 'failed');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test('dependency watcher recovers failed repair task without prior story evidence when retained task evidence still exists', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-failed-repair-retained-'));
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-failed-repair-retained-log-'));
  const logPath = path.join(taskDir, 'agent.log');

  try {
    git(repoDir, ['init']);
    git(repoDir, ['config', 'user.email', 'test@example.com']);
    git(repoDir, ['config', 'user.name', 'Test User']);

    const filePath = path.join(repoDir, 'tracked.txt');
    fs.writeFileSync(filePath, 'base\n');
    git(repoDir, ['add', 'tracked.txt']);
    git(repoDir, ['commit', '-m', 'initial']);

    const baseCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();

    fs.writeFileSync(filePath, 'review drill intake retained in worktree\n');
    fs.writeFileSync(logPath, `
**Done**
- Wired the selection actions into review/drill intake.

**Validation**
- Passed targeted tests

Suggested commit message: feat: retain task-level evidence for selection action loop
`);

    const stateManager = new FakeStateManager([
      {
        id: 'failed-repair-retained-evidence',
        prdPath: '/tmp/prd.json',
        status: 'failed',
        startTime: 100,
        completedUS: ['US-001', 'US-002', 'US-003'],
        storyProgress: [
          { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
          { id: 'US-002', status: 'passed', attempts: 1, updatedAt: 1 },
          { id: 'US-003', status: 'passed', attempts: 2, updatedAt: 1 },
          {
            id: 'US-004',
            status: 'failed',
            attempts: 2,
            lastError: 'Agent reported success for US-004, but Ralph found no objective diff or commit evidence',
            updatedAt: 1,
          },
        ],
        worktree: repoDir,
        logPath,
        agent: 'codex',
        repoPath: '/repo',
        baseCommitSha,
        loopCount: 6,
        consecutiveNoProgress: 2,
        consecutiveErrors: 0,
        lastProgressTime: 100,
        lastFilesChanged: 0,
        lastError: 'Agent reported success for US-004, but Ralph found no objective diff or commit evidence',
      },
    ]);

    const watcher = new DependencyWatcher(
      {},
      {
        stateManager,
        configManager: createConfigManager(),
        scheduler: {
          schedulePendingTasks: async () => [],
        },
        sleep: async () => undefined,
        logger: { log() {}, error() {} },
      }
    );

    await watcher.recoverSoftFailedTasks();
    const task = stateManager.tasks.get('failed-repair-retained-evidence');
    assert.equal(task.status, 'ready_to_finalize');
    assert.deepEqual(task.completedUS, ['US-001', 'US-002', 'US-003', 'US-004']);
    assert.equal(task.storyProgress[3].status, 'passed');
    assert.equal(task.lastError, undefined);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test('dependency watcher does not soft-recover merge repair failures without an exact worktree mergeability pass', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-soft-failed-merge-proof-repo-'));
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-soft-failed-merge-proof-log-'));
  const logPath = path.join(taskDir, 'agent.log');
  fs.writeFileSync(logPath, `
**Done**
- Resolved the merge markers in the temp integration sandbox

**Validation**
- Targeted tests passed
`);

  try {
    git(repoDir, ['init']);
    git(repoDir, ['config', 'user.email', 'test@example.com']);
    git(repoDir, ['config', 'user.name', 'Test User']);

    const filePath = path.join(repoDir, 'tracked.txt');
    fs.writeFileSync(filePath, 'base\n');
    git(repoDir, ['add', 'tracked.txt']);
    git(repoDir, ['commit', '-m', 'initial']);

    const baseCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();

    fs.writeFileSync(filePath, 'merge repair still present in task worktree\n');

    const stateManager = new FakeStateManager([
      {
        id: 'soft-failed-merge-proof',
        prdPath: '/tmp/prd.json',
        status: 'failed',
        startTime: 100,
        completedUS: ['US-001'],
        storyProgress: [
          { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
          {
            id: 'US-002',
            status: 'failed',
            attempts: 2,
            lastEvidence: 'Retained task-level worktree evidence',
            lastError: 'Agent reported success for US-002, but Ralph found no objective diff or commit evidence',
            updatedAt: 1,
          },
        ],
        worktree: repoDir,
        logPath,
        agent: 'codex',
        repoPath: '/repo',
        baseCommitSha,
        loopCount: 2,
        consecutiveNoProgress: 0,
        consecutiveErrors: 1,
        lastProgressTime: 100,
        lastFilesChanged: 2,
        repairContext: {
          mode: 'merge',
          storyId: 'US-002',
          createdAt: 10,
          reason: 'Merge repair required by Ralph.',
        },
        postFinalizeMergeProbeRequired: true,
      },
    ]);

    const watcher = new DependencyWatcher(
      {},
      {
        stateManager,
        configManager: createConfigManager(),
        scheduler: {
          schedulePendingTasks: async () => [],
        },
        sleep: async () => undefined,
        logger: { log() {}, error() {} },
        probeWorktreeMergeability: async () => ({
          mergeable: false,
          alreadyIntegrated: false,
          message: 'Merge conflicts detected: docs/TODO.md',
          conflictFiles: ['docs/TODO.md'],
          integrationBranch: 'ralph/integration/main',
          integrationWorktree: '/tmp/integration',
        }),
      }
    );

    await watcher.recoverSoftFailedTasks();
    const task = stateManager.tasks.get('soft-failed-merge-proof');
    assert.equal(task.status, 'failed');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test('dependency watcher soft-recovers merge repair failures only after exact worktree mergeability passes', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-soft-failed-merge-proof-pass-repo-'));
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-soft-failed-merge-proof-pass-log-'));
  const logPath = path.join(taskDir, 'agent.log');
  fs.writeFileSync(logPath, `
**Done**
- Reconciled the merge repair on the task worktree

**Validation**
- Targeted tests passed
`);

  try {
    git(repoDir, ['init']);
    git(repoDir, ['config', 'user.email', 'test@example.com']);
    git(repoDir, ['config', 'user.name', 'Test User']);

    const filePath = path.join(repoDir, 'tracked.txt');
    fs.writeFileSync(filePath, 'base\n');
    git(repoDir, ['add', 'tracked.txt']);
    git(repoDir, ['commit', '-m', 'initial']);

    const baseCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();

    fs.writeFileSync(filePath, 'merge repair retained in task worktree\n');

    const stateManager = new FakeStateManager([
      {
        id: 'soft-failed-merge-proof-pass',
        prdPath: '/tmp/prd.json',
        status: 'failed',
        startTime: 100,
        completedUS: ['US-001'],
        storyProgress: [
          { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
          {
            id: 'US-002',
            status: 'failed',
            attempts: 2,
            lastEvidence: 'Retained task-level worktree evidence',
            lastError: 'Agent reported success for US-002, but Ralph found no objective diff or commit evidence',
            updatedAt: 1,
          },
        ],
        worktree: repoDir,
        logPath,
        agent: 'codex',
        repoPath: '/repo',
        baseCommitSha,
        loopCount: 2,
        consecutiveNoProgress: 0,
        consecutiveErrors: 1,
        lastProgressTime: 100,
        lastFilesChanged: 2,
        repairContext: {
          mode: 'merge',
          storyId: 'US-002',
          createdAt: 10,
          reason: 'Merge repair required by Ralph.',
        },
        postFinalizeMergeProbeRequired: true,
      },
    ]);

    const watcher = new DependencyWatcher(
      {},
      {
        stateManager,
        configManager: createConfigManager(),
        scheduler: {
          schedulePendingTasks: async () => [],
        },
        sleep: async () => undefined,
        logger: { log() {}, error() {} },
        probeWorktreeMergeability: async () => ({
          mergeable: true,
          alreadyIntegrated: false,
          message: 'ralph/task can merge cleanly',
          integrationBranch: 'ralph/integration/main',
          integrationWorktree: '/tmp/integration',
        }),
      }
    );

    await watcher.recoverSoftFailedTasks();
    const task = stateManager.tasks.get('soft-failed-merge-proof-pass');
    assert.equal(task.status, 'ready_to_finalize');
    assert.equal(task.postFinalizeMergeProbeRequired, true);
    assert.equal(task.mergeConflictFiles, undefined);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test('dependency watcher requeues failed worker merge-repair tasks when the exact probe still fails', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-worker-merge-repair',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'failed', attempts: 2, lastError: 'Exact mergeability probe still fails', updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/failed-worker-merge-repair',
      logPath: '/tmp/failed-worker-merge-repair.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 4,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Exact mergeability probe still fails against ralph/integration/main',
      repairContext: {
        mode: 'merge',
        storyId: 'US-002',
        createdAt: Date.now(),
        reason: 'Merge repair required by Ralph.',
      },
      mergeError: 'Merge conflicts detected: docs/TODO.md',
      mergeConflictFiles: ['docs/TODO.md'],
      postFinalizeMergeProbeRequired: true,
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager(),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
      probeWorktreeMergeability: async () => ({
        mergeable: false,
        alreadyIntegrated: false,
        message: 'Merge conflicts detected: docs/TODO.md',
        conflictFiles: ['docs/TODO.md'],
        integrationBranch: 'ralph/integration/main',
        integrationWorktree: '/tmp/integration',
      }),
    },
  );

  await watcher.recoverFailedWorkerMergeRepairTasks();
  const task = stateManager.tasks.get('failed-worker-merge-repair');
  assert.equal(task.status, 'pending');
  assert.equal(task.repairContext.mode, 'merge');
  assert.equal(task.repairContext.storyId, 'US-002');
  assert.equal(task.storyProgress[1].status, 'needs_repair');
  assert.equal(task.storyProgress[1].attempts, 0);
  assert.equal(task.mergeRepairRecoveryTotalRequeues, 1);
  assert.equal(task.autoRecoveryKind, 'merge_repair');
  assert.equal(task.autoRecoveryTotalRequeues, 1);
  assert.equal(task.postFinalizeMergeProbeRequired, true);
});

test('dependency watcher recovers failed worker merge-repair tasks into finalize when the exact probe passes', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-worker-merge-pass',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'failed', attempts: 2, lastError: 'Exact mergeability probe still fails', updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/failed-worker-merge-pass',
      logPath: '/tmp/failed-worker-merge-pass.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 4,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Exact mergeability probe still fails against ralph/integration/main',
      repairContext: {
        mode: 'merge',
        storyId: 'US-002',
        createdAt: Date.now(),
        reason: 'Merge repair required by Ralph.',
      },
      mergeError: 'Merge conflicts detected: docs/TODO.md',
      mergeConflictFiles: ['docs/TODO.md'],
      postFinalizeMergeProbeRequired: true,
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager(),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
      probeWorktreeMergeability: async () => ({
        mergeable: true,
        alreadyIntegrated: false,
        message: 'ralph/task can merge cleanly',
        integrationBranch: 'ralph/integration/main',
        integrationWorktree: '/tmp/integration',
      }),
    },
  );

  await watcher.recoverFailedWorkerMergeRepairTasks();
  const task = stateManager.tasks.get('failed-worker-merge-pass');
  assert.equal(task.status, 'ready_to_finalize');
  assert.deepEqual(task.completedUS, ['US-001', 'US-002']);
  assert.equal(task.storyProgress[1].status, 'passed');
  assert.equal(task.repairContext, undefined);
  assert.equal(task.mergeConflictFiles, undefined);
  assert.equal(task.postFinalizeMergeProbeRequired, true);
});

test('dependency watcher gives legacy merge-repair failures a fresh recovery window before stopping', async () => {
  const staleRepairCreatedAt = Date.now() - (3 * 60 * 60 * 1000);
  const stateManager = new FakeStateManager([
    {
      id: 'failed-worker-merge-legacy-window',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'failed', attempts: 2, lastError: 'Exact mergeability probe still fails', updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/failed-worker-merge-legacy-window',
      logPath: '/tmp/failed-worker-merge-legacy-window.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 4,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Exact mergeability probe still fails against ralph/integration/main',
      repairContext: {
        mode: 'merge',
        storyId: 'US-002',
        createdAt: staleRepairCreatedAt,
        reason: 'Merge repair required by Ralph.',
      },
      mergeError: 'Merge conflicts detected: docs/TODO.md',
      mergeConflictFiles: ['docs/TODO.md'],
      postFinalizeMergeProbeRequired: true,
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager(),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
      probeWorktreeMergeability: async () => ({
        mergeable: false,
        alreadyIntegrated: false,
        message: 'Merge conflicts detected: docs/TODO.md',
        conflictFiles: ['docs/TODO.md'],
        integrationBranch: 'ralph/integration/main',
        integrationWorktree: '/tmp/integration',
      }),
    },
  );

  await watcher.recoverFailedWorkerMergeRepairTasks();
  const task = stateManager.tasks.get('failed-worker-merge-legacy-window');
  assert.equal(task.status, 'pending');
  assert.equal(task.mergeRepairRecoveryStopReason, undefined);
  assert.ok(task.mergeRepairRecoveryStartedAt >= staleRepairCreatedAt + (2 * 60 * 60 * 1000));
  assert.ok(task.mergeRepairRecoveryDeadlineAt > Date.now());
});

test('dependency watcher backfills legacy transient failures and schedules bounded recovery', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-transient-legacy',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: [],
      storyProgress: [
        { id: 'US-001', status: 'failed', attempts: 2, lastError: 'high demand', updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/failed-transient-legacy',
      logPath: '/tmp/failed-transient-legacy.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 2,
      consecutiveErrors: 2,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'ERROR: Reconnecting... 1/5\nERROR: We are currently experiencing high demand, which may cause temporary errors.',
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager(),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
    },
  );

  await watcher.recoverFailedTransientTasks();
  const task = stateManager.tasks.get('failed-transient-legacy');
  assert.equal(task.status, 'failed');
  assert.equal(task.lastErrorKind, 'backend_high_demand');
  assert.equal(task.lastErrorClass, 'transient_backend');
  assert.equal(task.lastErrorRetryable, true);
  assert.equal(task.autoRecoveryKind, 'transient');
  assert.ok(task.transientRecoveryNextEligibleAt > Date.now());
});

test('dependency watcher requeues transient failures after cooldown while preserving merge repair context', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-transient-requeue',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'failed', attempts: 2, lastError: 'transport reconnecting', updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/failed-transient-requeue',
      logPath: '/tmp/failed-transient-requeue.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 2,
      consecutiveErrors: 2,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Connection lost while streaming output, reconnecting now.',
      lastErrorKind: 'transport_reconnecting',
      lastErrorClass: 'transport',
      lastErrorRetryable: true,
      lastErrorSignature: 'transport_reconnecting',
      lastErrorHadObjectiveProgress: false,
      repairContext: {
        mode: 'merge',
        storyId: 'US-002',
        createdAt: 10,
        reason: 'Merge repair required by Ralph.',
      },
      transientRecoveryStartedAt: Date.now() - 5000,
      transientRecoveryDeadlineAt: Date.now() + 60000,
      transientRecoveryTotalRequeues: 0,
      transientRecoveryConsecutiveSameSignature: 1,
      transientRecoveryLastFailureKind: 'transport_reconnecting',
      transientRecoveryLastFailureClass: 'transport',
      transientRecoveryLastFailureSignature: 'transport_reconnecting',
      transientRecoveryNextEligibleAt: Date.now() - 1000,
      autoRecoveryKind: 'transient',
      autoRecoveryTotalRequeues: 0,
      autoRecoveryHardCap: 20,
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager(),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
    },
  );

  await watcher.recoverFailedTransientTasks();
  const task = stateManager.tasks.get('failed-transient-requeue');
  assert.equal(task.status, 'pending');
  assert.equal(task.storyProgress[1].status, 'pending');
  assert.equal(task.storyProgress[1].attempts, 0);
  assert.equal(task.repairContext.mode, 'merge');
  assert.equal(task.transientRecoveryTotalRequeues, 1);
  assert.equal(task.autoRecoveryTotalRequeues, 1);
  assert.equal(task.transientRetryCount, 0);
});

test('dependency watcher still requeues retryable transient failures when the failed attempt had objective progress', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-transient-progress-requeue',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        {
          id: 'US-002',
          status: 'failed',
          attempts: 2,
          lastEvidence: 'working tree diff content changed',
          lastError: 'transport reconnecting',
          updatedAt: 1,
        },
      ],
      worktree: '/repo/.ralph-worktrees/failed-transient-progress-requeue',
      logPath: '/tmp/failed-transient-progress-requeue.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 0,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      lastError: 'Connection lost while streaming output, reconnecting now.',
      lastErrorKind: 'transport_reconnecting',
      lastErrorClass: 'transport',
      lastErrorRetryable: true,
      lastErrorSignature: 'transport_reconnecting',
      lastErrorHadObjectiveProgress: true,
      repairContext: {
        mode: 'merge',
        storyId: 'US-002',
        createdAt: 10,
        reason: 'Merge repair required by Ralph.',
      },
      transientRecoveryStartedAt: Date.now() - 5000,
      transientRecoveryDeadlineAt: Date.now() + 60000,
      transientRecoveryTotalRequeues: 0,
      transientRecoveryConsecutiveSameSignature: 1,
      transientRecoveryLastFailureKind: 'transport_reconnecting',
      transientRecoveryLastFailureClass: 'transport',
      transientRecoveryLastFailureSignature: 'transport_reconnecting',
      transientRecoveryNextEligibleAt: Date.now() - 1000,
      autoRecoveryKind: 'stagnant',
      autoRecoveryTotalRequeues: 2,
      autoRecoveryHardCap: 20,
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager(),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
    },
  );

  await watcher.recoverFailedTransientTasks();
  const task = stateManager.tasks.get('failed-transient-progress-requeue');
  assert.equal(task.status, 'pending');
  assert.equal(task.storyProgress[1].status, 'pending');
  assert.equal(task.storyProgress[1].attempts, 0);
  assert.equal(task.repairContext.mode, 'merge');
  assert.equal(task.transientRecoveryTotalRequeues, 1);
  assert.equal(task.autoRecoveryKind, 'transient');
  assert.equal(task.autoRecoveryTotalRequeues, 3);
  assert.equal(task.lastErrorHadObjectiveProgress, true);
});

test('dependency watcher stops repeated same-signature transient failures', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-transient-stop',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: [],
      storyProgress: [
        { id: 'US-001', status: 'failed', attempts: 2, lastError: 'high demand', updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/failed-transient-stop',
      logPath: '/tmp/failed-transient-stop.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 2,
      consecutiveErrors: 2,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'The backend is under high demand and temporarily errors right now.',
      lastErrorKind: 'backend_high_demand',
      lastErrorClass: 'transient_backend',
      lastErrorRetryable: true,
      lastErrorSignature: 'backend_high_demand',
      lastErrorHadObjectiveProgress: false,
      transientRecoveryStartedAt: Date.now() - 5000,
      transientRecoveryDeadlineAt: Date.now() + 60000,
      transientRecoveryTotalRequeues: 1,
      transientRecoveryConsecutiveSameSignature: 2,
      transientRecoveryLastFailureKind: 'backend_high_demand',
      transientRecoveryLastFailureClass: 'transient_backend',
      transientRecoveryLastFailureSignature: 'backend_high_demand',
      autoRecoveryKind: 'transient',
      autoRecoveryTotalRequeues: 1,
      autoRecoveryHardCap: 20,
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager(),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
    },
  );

  await watcher.recoverFailedTransientTasks();
  const task = stateManager.tasks.get('failed-transient-stop');
  assert.equal(task.status, 'failed');
  assert.equal(task.transientRecoveryStopReason, 'transient_same_signature_no_progress');
  assert.ok(task.transientRecoveryStoppedAt);
});

test('dependency watcher requeues stagnant merge-repair tasks without dropping repair context', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'stagnant-merge-repair',
      prdPath: '/tmp/prd.json',
      status: 'stagnant',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'in_progress', attempts: 2, updatedAt: 2 },
      ],
      worktree: '/repo/.ralph-worktrees/stagnant-merge-repair',
      logPath: '/tmp/stagnant-merge-repair.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 8,
      consecutiveNoProgress: 3,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Running worker made no progress for 1802s; task was marked stagnant for retry',
      lastErrorKind: 'stagnation',
      lastErrorClass: 'stagnation',
      lastErrorRetryable: false,
      lastErrorObservedAt: 200,
      repairContext: {
        mode: 'merge',
        storyId: 'US-002',
        createdAt: 50,
        reason: 'Merge repair required by Ralph.',
      },
      integrationStatus: 'blocked_conflict',
      mergeError: 'Merge conflicts detected: src/conflict.ts',
      mergeConflictFiles: ['src/conflict.ts'],
      mergeRepairAttempts: 2,
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager(),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
    },
  );

  await watcher.recoverStagnantTasks();
  const task = stateManager.tasks.get('stagnant-merge-repair');
  assert.equal(task.status, 'pending');
  assert.equal(task.currentUS, undefined);
  assert.equal(task.storyProgress[1].status, 'needs_repair');
  assert.equal(task.storyProgress[1].attempts, 0);
  assert.equal(task.repairContext.mode, 'merge');
  assert.equal(task.repairContext.storyId, 'US-002');
  assert.equal(task.integrationStatus, 'blocked_conflict');
  assert.equal(task.mergeError, 'Merge conflicts detected: src/conflict.ts');
  assert.deepEqual(task.mergeConflictFiles, ['src/conflict.ts']);
  assert.equal(task.autoRecoveryKind, 'stagnant');
  assert.equal(task.autoRecoveryTotalRequeues, 1);
  assert.equal(task.autoRecoveryHardCap, 20);
  assert.equal(task.lastError, undefined);
  assert.equal(task.loopCount, 0);
  assert.equal(task.consecutiveNoProgress, 0);
});

test('dependency watcher removes rewound stagnant story from completedUS', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'stagnant-passed-story',
      prdPath: '/tmp/prd.json',
      status: 'stagnant',
      startTime: 100,
      currentUS: 'US-003',
      completedUS: ['US-001', 'US-002', 'US-003'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'passed', attempts: 1, updatedAt: 2 },
        { id: 'US-003', status: 'passed', attempts: 1, updatedAt: 3 },
      ],
      worktree: '/repo/.ralph-worktrees/stagnant-passed-story',
      logPath: '/tmp/stagnant-passed-story.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 8,
      consecutiveNoProgress: 3,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Running worker made no progress for 1802s; task was marked stagnant for retry',
      lastErrorKind: 'stagnation',
      lastErrorClass: 'stagnation',
      lastErrorRetryable: false,
      lastErrorObservedAt: 200,
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager(),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
    },
  );

  await watcher.recoverStagnantTasks();
  const task = stateManager.tasks.get('stagnant-passed-story');
  assert.equal(task.status, 'pending');
  assert.deepEqual(task.completedUS, ['US-001', 'US-002']);
  assert.equal(task.storyProgress[2].status, 'pending');
  assert.equal(task.storyProgress[2].attempts, 0);
});

test('dependency watcher refreshes merge-repair recovery state after stagnant auto-requeue', async () => {
  const staleStartedAt = Date.now() - (3 * 60 * 60 * 1000);
  const staleDeadlineAt = staleStartedAt + 60_000;
  const stateManager = new FakeStateManager([
    {
      id: 'stagnant-merge-repair-refresh-window',
      prdPath: '/tmp/prd.json',
      status: 'stagnant',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'in_progress', attempts: 2, updatedAt: 2 },
      ],
      worktree: '/repo/.ralph-worktrees/stagnant-merge-repair-refresh-window',
      logPath: '/tmp/stagnant-merge-repair-refresh-window.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 8,
      consecutiveNoProgress: 3,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Running worker made no progress for 1802s; task was marked stagnant for retry',
      lastErrorKind: 'stagnation',
      lastErrorClass: 'stagnation',
      lastErrorRetryable: false,
      lastErrorObservedAt: 200,
      repairContext: {
        mode: 'merge',
        storyId: 'US-002',
        createdAt: staleStartedAt,
        reason: 'Merge repair required by Ralph.',
      },
      integrationStatus: 'blocked_conflict',
      mergeError: 'Merge conflicts detected: src/conflict.ts',
      mergeConflictFiles: ['src/conflict.ts'],
      mergeRepairAttempts: 2,
      mergeRepairRecoveryStartedAt: staleStartedAt,
      mergeRepairRecoveryDeadlineAt: staleDeadlineAt,
      mergeRepairRecoveryTotalRequeues: 2,
      mergeRepairRecoveryConsecutiveNoProgress: 1,
      mergeRepairRecoveryLastConflictSignature: 'src/conflict.ts',
      mergeRepairRecoveryLastProbeMessage: 'Merge conflicts detected: src/conflict.ts',
      mergeRepairRecoveryLastProgressReason: 'Initialized worker merge-repair recovery tracking',
      mergeRepairRecoveryStoppedAt: staleDeadlineAt,
      mergeRepairRecoveryStopReason: 'merge_repair_deadline_exhausted',
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager(),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
      probeWorktreeMergeability: async () => ({
        mergeable: false,
        alreadyIntegrated: false,
        message: 'Merge conflicts detected: src/conflict.ts',
        conflictFiles: ['src/conflict.ts'],
        integrationBranch: 'ralph/integration/main',
        integrationWorktree: '/tmp/integration',
      }),
    },
  );

  await watcher.recoverStagnantTasks();

  let task = stateManager.tasks.get('stagnant-merge-repair-refresh-window');
  assert.equal(task.status, 'pending');
  assert.equal(task.repairContext.mode, 'merge');
  assert.equal(task.repairContext.storyId, 'US-002');
  assert.equal(task.mergeRepairRecoveryStartedAt, undefined);
  assert.equal(task.mergeRepairRecoveryDeadlineAt, undefined);
  assert.equal(task.mergeRepairRecoveryTotalRequeues, undefined);
  assert.equal(task.mergeRepairRecoveryConsecutiveNoProgress, undefined);
  assert.equal(task.mergeRepairRecoveryStoppedAt, undefined);
  assert.equal(task.mergeRepairRecoveryStopReason, undefined);

  stateManager.tasks.set(task.id, {
    ...task,
    status: 'failed',
    storyProgress: [
      { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
      { id: 'US-002', status: 'needs_repair', attempts: 2, updatedAt: Date.now(), lastError: 'merge failed' },
    ],
    lastError: 'Exact mergeability probe still fails against ralph/integration/main',
    lastErrorKind: 'merge_conflict',
    lastErrorClass: 'merge_conflict',
    lastErrorRetryable: true,
    lastErrorObservedAt: Date.now(),
    lastErrorSignature: 'src/conflict.ts',
  });

  await watcher.recoverFailedWorkerMergeRepairTasks();
  task = stateManager.tasks.get('stagnant-merge-repair-refresh-window');
  assert.equal(task.status, 'pending');
  assert.equal(task.mergeRepairRecoveryStopReason, undefined);
  assert.ok(task.mergeRepairRecoveryStartedAt >= task.repairContext.createdAt);
  assert.ok(task.mergeRepairRecoveryDeadlineAt > Date.now());
});

test('dependency watcher stops failed merge repair when the unresolved worktree observation repeats', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-worker-merge-stop-same-state',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'failed', attempts: 2, lastError: 'merge failed', updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/failed-worker-merge-stop-same-state',
      logPath: '/tmp/failed-worker-merge-stop-same-state.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 4,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Exact mergeability probe still fails against ralph/integration/main',
      lastErrorObservedAt: Date.now() - 1000,
      repairContext: {
        mode: 'merge',
        storyId: 'US-002',
        createdAt: Date.now() - 10_000,
        reason: 'Merge repair required by Ralph.',
      },
      mergeError: 'Merge conflicts detected: docs/TODO.md',
      mergeConflictFiles: ['docs/TODO.md'],
      postFinalizeMergeProbeRequired: true,
      mergeRepairRecoveryStartedAt: Date.now() - 5_000,
      mergeRepairRecoveryDeadlineAt: Date.now() + 60_000,
      mergeRepairRecoveryConsecutiveNoProgress: 1,
      mergeRepairRecoveryLastConflictSignature: 'docs/TODO.md',
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager(),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
      probeWorktreeMergeability: async () => ({
        mergeable: false,
        alreadyIntegrated: false,
        message: 'Merge conflicts detected: docs/TODO.md',
        conflictFiles: ['docs/TODO.md'],
        integrationBranch: 'ralph/integration/main',
        integrationWorktree: '/tmp/integration',
        sourceKind: 'worktree_snapshot',
        worktreeMergeState: {
          kind: 'unresolved',
          usesGitLocal: true,
          gitDir: '/repo/.ralph-worktrees/failed-worker-merge-stop-same-state/.git-local',
          headSha: 'abc123',
          mergeParents: ['def456'],
          unmergedFiles: ['docs/TODO.md'],
          changedFiles: ['docs/TODO.md'],
          statusPorcelain: 'UU docs/TODO.md',
          statusSignature: 'same-state',
        },
      }),
    },
  );

  await watcher.recoverFailedWorkerMergeRepairTasks();
  const task = stateManager.tasks.get('failed-worker-merge-stop-same-state');
  assert.equal(task.status, 'failed');
  assert.equal(task.mergeRepairRecoveryStopReason, 'merge_repair_same_unresolved_state');
  assert.equal(task.mergeRepairDisplayStatus, 'stopped');
});

test('dependency watcher refuses worker merge repair recovery when another story is incomplete', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-worker-merge-incomplete-story',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-002'],
      storyProgress: [
        { id: 'US-001', status: 'failed', attempts: 2, lastError: 'story failed', updatedAt: 1 },
        { id: 'US-002', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-003', status: 'needs_repair', attempts: 2, lastError: 'merge failed', updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/failed-worker-merge-incomplete-story',
      logPath: '/tmp/failed-worker-merge-incomplete-story.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 4,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Exact mergeability probe still fails against ralph/integration/main',
      lastErrorObservedAt: Date.now() - 1000,
      repairContext: {
        mode: 'merge',
        storyId: 'US-003',
        createdAt: Date.now() - 10_000,
        reason: 'Merge repair required by Ralph.',
      },
      mergeError: 'Merge conflicts detected: docs/TODO.md',
      mergeConflictFiles: ['docs/TODO.md'],
      postFinalizeMergeProbeRequired: true,
      mergeRepairRecoveryStartedAt: Date.now() - 5_000,
      mergeRepairRecoveryDeadlineAt: Date.now() + 60_000,
      mergeRepairRecoveryConsecutiveNoProgress: 1,
      mergeRepairRecoveryLastConflictSignature: 'docs/TODO.md',
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager(),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
      probeWorktreeMergeability: async () => ({
        mergeable: true,
        alreadyIntegrated: false,
        message: 'ralph/task (worktree snapshot) can merge cleanly into ralph/integration/main',
        conflictFiles: [],
        integrationBranch: 'ralph/integration/main',
        integrationWorktree: '/tmp/integration',
        sourceKind: 'worktree_snapshot',
        worktreeMergeState: {
          kind: 'none',
          usesGitLocal: false,
          gitDir: '/repo/.git/worktrees/task',
          headSha: 'abc123',
          mergeParents: [],
          unmergedFiles: [],
          changedFiles: ['docs/TODO.md'],
          statusPorcelain: 'M docs/TODO.md',
          statusSignature: 'ready-proof',
        },
      }),
    },
  );

  await watcher.recoverFailedWorkerMergeRepairTasks();
  const task = stateManager.tasks.get('failed-worker-merge-incomplete-story');
  assert.equal(task.status, 'failed');
  assert.deepEqual(task.completedUS, ['US-002', 'US-003']);
  assert.equal(task.storyProgress.find((story) => story.id === 'US-003').status, 'passed');
  assert.equal(task.integrationStatus, 'failed');
  assert.equal(task.lastErrorKind, 'story_incomplete');
  assert.match(task.lastError, /cannot finalize/);
  assert.match(task.lastError, /US-001:failed:2/);
});

test('dependency watcher ignores stale merge repair residue for ordinary failed stories', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'stale-merge-residue',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-002', 'US-003'],
      storyProgress: [
        { id: 'US-001', status: 'failed', attempts: 2, lastError: 'story failed', updatedAt: 1 },
        { id: 'US-002', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-003', status: 'passed', attempts: 1, updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/stale-merge-residue',
      logPath: '/tmp/stale-merge-residue.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 4,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Task cannot integrate: 1/3 stories are incomplete',
      lastErrorKind: 'story_incomplete',
      lastErrorClass: 'semantic',
      mergeRepairAttempts: 2,
      mergeRepairProof: {
        observedAt: Date.now(),
        sourceKind: 'worktree_snapshot',
        message: 'stale proof',
        integrationBranch: 'ralph/integration/main',
      },
    },
  ]);
  let probeCalls = 0;

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager(),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
      probeWorktreeMergeability: async () => {
        probeCalls += 1;
        throw new Error('probe should not run');
      },
    },
  );

  await watcher.recoverFailedWorkerMergeRepairTasks();
  const task = stateManager.tasks.get('stale-merge-residue');
  assert.equal(task.status, 'failed');
  assert.deepEqual(task.completedUS, ['US-002', 'US-003']);
  assert.equal(task.storyProgress.find((story) => story.id === 'US-001').status, 'failed');
  assert.equal(probeCalls, 0);
});

test('dependency watcher promotes completed blocked_conflict tasks to ready_to_finalize when the task worktree now passes the exact probe', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'completed-blocked-conflict-worktree-proof',
      prdPath: '/tmp/prd.json',
      status: 'completed',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/completed-blocked-conflict-worktree-proof',
      logPath: '/tmp/completed-blocked-conflict-worktree-proof.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 4,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      integrationStatus: 'blocked_conflict',
      mergeError: 'Merge conflicts detected: docs/TODO.md',
      mergeConflictFiles: ['docs/TODO.md'],
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager(),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
      probeWorktreeMergeability: async () => ({
        mergeable: true,
        alreadyIntegrated: false,
        message: 'ralph/task (worktree snapshot) can merge cleanly into ralph/integration/main',
        integrationBranch: 'ralph/integration/main',
        integrationWorktree: '/tmp/integration',
        sourceKind: 'worktree_snapshot',
        worktreeMergeState: {
          kind: 'none',
          usesGitLocal: false,
          gitDir: '/repo/.git/worktrees/task',
          headSha: 'abc123',
          mergeParents: [],
          unmergedFiles: [],
          changedFiles: ['docs/TODO.md'],
          statusPorcelain: 'M docs/TODO.md',
          statusSignature: 'ready-proof',
        },
      }),
    },
  );

  await watcher.recoverCompletedConflictTasks();
  const task = stateManager.tasks.get('completed-blocked-conflict-worktree-proof');
  assert.equal(task.status, 'ready_to_finalize');
  assert.equal(task.postFinalizeMergeProbeRequired, true);
  assert.equal(task.mergeError, undefined);
  assert.equal(task.mergeRepairDisplayStatus, 'probe_mergeable');
  assert.equal(task.mergeRepairProof.integrationBranch, 'ralph/integration/main');
});

test('dependency watcher stops stagnant auto-recovery at the hard cap', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'stagnant-hard-cap',
      prdPath: '/tmp/prd.json',
      status: 'stagnant',
      startTime: 100,
      completedUS: [],
      storyProgress: [
        { id: 'US-001', status: 'in_progress', attempts: 4, updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/stagnant-hard-cap',
      logPath: '/tmp/stagnant-hard-cap.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 8,
      consecutiveNoProgress: 3,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Running worker made no progress for 1802s; task was marked stagnant for retry',
      autoRecoveryTotalRequeues: 20,
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager(),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
    },
  );

  await watcher.recoverStagnantTasks();
  const task = stateManager.tasks.get('stagnant-hard-cap');
  assert.equal(task.status, 'stagnant');
  assert.equal(task.autoRecoveryKind, 'stagnant');
  assert.equal(task.autoRecoveryStopReason, 'stagnation_auto_recovery_hard_cap_reached');
  assert.ok(task.autoRecoveryStoppedAt);
});
