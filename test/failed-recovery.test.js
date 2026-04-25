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

function createConfigManager() {
  const values = {
    'runner.pollInterval': 10,
    'ingestion.ez4ielts.enabled': false,
    'autoMerge': false,
    'autoMergeDelay': 0,
    'merge.targetBranch': 'main',
    'merge.strategy': 'manual',
    'merge.pullLatest': true,
  };

  return {
    get(key) {
      return values[key];
    },
  };
}

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
