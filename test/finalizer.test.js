const test = require('node:test');
const assert = require('node:assert/strict');

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

function createConfigManager(overrides = {}) {
  const values = {
    'runner.pollInterval': 10,
    'ingestion.ez4ielts.enabled': false,
    'autoMerge': false,
    'autoMergeDelay': 0,
    'merge.targetBranch': 'main',
    'merge.strategy': 'manual',
    'merge.pullLatest': true,
    ...overrides,
  };

  return {
    get(key) {
      return values[key];
    },
  };
}

test('dependency watcher finalizes ready_to_finalize tasks before scheduling pending work', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'finalize-me',
      prdPath: '/tmp/prd.json',
      status: 'ready_to_finalize',
      startTime: 100,
      completedUS: ['US-001'],
      worktree: '/repo/.ralph-worktrees/finalize-me',
      logPath: '/tmp/finalize.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
    },
  ]);

  const started = [];
  const logs = [];
  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager(),
      scheduler: {
        schedulePendingTasks: async () => {
          started.push('scheduled');
          return [];
        },
      },
      sleep: async () => undefined,
      logger: {
        log: (msg) => logs.push(String(msg)),
        error: (msg) => logs.push(`ERR:${String(msg)}`),
      },
      finalizer: () => ({
        success: true,
        committed: true,
        message: 'Committed task changes successfully',
        commitMessage: 'feat: finalize test',
      }),
    }
  );

  watcher.stop = () => {
    watcher.isRunning = false;
  };

  const finalizeReadyTasks = watcher.finalizeReadyTasks?.bind(watcher);
  assert.ok(finalizeReadyTasks, 'finalizeReadyTasks should exist');
  await finalizeReadyTasks();
  await watcher.checkPendingTasks();

  const finalizedTask = stateManager.tasks.get('finalize-me');
  assert.equal(finalizedTask.status, 'completed');
  assert.equal(finalizedTask.finalizerCommitMessage, 'feat: finalize test');
  assert.equal(finalizedTask.mergedAt, undefined);
  assert.equal(started.length, 1);
});

test('dependency watcher auto-merges finalized tasks when enabled', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'auto-merge-me',
      prdPath: '/tmp/prd.json',
      status: 'ready_to_finalize',
      startTime: 100,
      completedUS: ['US-001'],
      worktree: '/repo/.ralph-worktrees/auto-merge-me',
      logPath: '/tmp/auto-merge.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager({
        'autoMerge': true,
        'merge.targetBranch': 'main',
        'merge.strategy': 'manual',
        'merge.pullLatest': false,
      }),
      sleep: async () => undefined,
      logger: console,
      finalizer: () => ({
        success: true,
        committed: true,
        message: 'Committed task changes successfully',
        commitMessage: 'feat: finalize test',
      }),
      mergeTask: async (_task, targetBranch, strategy, options) => {
        assert.equal(targetBranch, 'main');
        assert.equal(strategy, 'manual');
        assert.equal(options.pullLatest, false);
        return {
          success: true,
          hasConflicts: false,
          message: 'Merged into main',
          commitSha: 'abc123',
        };
      },
    }
  );

  await watcher.finalizeReadyTasks();

  const finalizedTask = stateManager.tasks.get('auto-merge-me');
  assert.equal(finalizedTask.status, 'completed');
  assert.equal(finalizedTask.finalizerCommitMessage, 'feat: finalize test');
  assert.equal(finalizedTask.mergeTargetBranch, 'main');
  assert.equal(finalizedTask.mergeStrategy, 'manual');
  assert.equal(finalizedTask.mergeCommitSha, 'abc123');
  assert.equal(finalizedTask.mergeMessage, 'Merged into main');
  assert.ok(typeof finalizedTask.mergedAt === 'number');
});

test('dependency watcher rejects unattended destructive auto-merge strategies', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'unsafe-auto-merge',
      prdPath: '/tmp/prd.json',
      status: 'ready_to_finalize',
      startTime: 100,
      completedUS: ['US-001'],
      worktree: '/repo/.ralph-worktrees/unsafe-auto-merge',
      logPath: '/tmp/unsafe-auto-merge.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
    },
  ]);
  let mergeCalled = false;

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager({
        'autoMerge': true,
        'merge.strategy': 'theirs',
      }),
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
      finalizer: () => ({
        success: true,
        committed: true,
        message: 'Committed task changes successfully',
        commitMessage: 'feat: finalize test',
      }),
      mergeTask: async () => {
        mergeCalled = true;
        throw new Error('should not merge');
      },
    }
  );

  await watcher.finalizeReadyTasks();

  const task = stateManager.tasks.get('unsafe-auto-merge');
  assert.equal(mergeCalled, false);
  assert.equal(task.status, 'failed_finalize');
  assert.match(task.lastError, /Unattended autoMerge with 'theirs' is disabled/);
});

test('dependency watcher marks task failed_finalize when auto-merge fails', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'merge-conflict-task',
      prdPath: '/tmp/prd.json',
      status: 'ready_to_finalize',
      startTime: 100,
      completedUS: ['US-001'],
      worktree: '/repo/.ralph-worktrees/merge-conflict-task',
      logPath: '/tmp/merge-conflict.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager({
        'autoMerge': true,
      }),
      sleep: async () => undefined,
      logger: console,
      finalizer: () => ({
        success: true,
        committed: true,
        message: 'Committed task changes successfully',
        commitMessage: 'feat: finalize test',
      }),
      mergeTask: async () => ({
        success: false,
        hasConflicts: true,
        message: 'Merge conflicts detected: src/app.ts',
        conflictFiles: ['src/app.ts'],
        integrationBranch: 'ralph/integration/main',
        integrationWorktree: '/repo/.ralph-integration/main',
      }),
    }
  );

  await watcher.finalizeReadyTasks();

  const finalizedTask = stateManager.tasks.get('merge-conflict-task');
  assert.equal(finalizedTask.status, 'failed_finalize');
  assert.equal(finalizedTask.finalizerCommitMessage, 'feat: finalize test');
  assert.match(finalizedTask.lastError, /Merge conflicts detected/);
  assert.match(finalizedTask.mergeError, /Merge conflicts detected/);
  assert.deepEqual(finalizedTask.mergeConflictFiles, ['src/app.ts']);
  assert.equal(finalizedTask.integrationBranch, 'ralph/integration/main');
  assert.ok(typeof finalizedTask.mergeConflictAt === 'number');
});

test('dependency watcher routes failed_finalize tasks back to pending repair once', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'repair-finalize-task',
      prdPath: '/tmp/prd.json',
      status: 'failed_finalize',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        {
          id: 'US-001',
          status: 'passed',
          attempts: 1,
          updatedAt: 100,
        },
      ],
      worktree: '/repo/.ralph-worktrees/repair-finalize-task',
      logPath: '/tmp/repair-finalize.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      finalizerAttempts: 1,
      lastError: 'Quality gate "test" failed',
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager({
        'finalizer.maxRepairAttempts': 1,
      }),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
    }
  );

  await watcher.recoverFailedFinalizeTasks();

  const task = stateManager.tasks.get('repair-finalize-task');
  assert.equal(task.status, 'pending');
  assert.deepEqual(task.completedUS, []);
  assert.equal(task.storyProgress[0].status, 'needs_repair');
  assert.match(task.storyProgress[0].lastError, /Quality gate/);
});

test('dependency watcher routes merge conflicts through merge repair context', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'merge-repair-task',
      prdPath: '/tmp/prd.json',
      status: 'failed_finalize',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        {
          id: 'US-001',
          status: 'passed',
          attempts: 1,
          updatedAt: 100,
        },
      ],
      worktree: '/repo/.ralph-worktrees/merge-repair-task',
      logPath: '/tmp/merge-repair.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      finalizerAttempts: 1,
      mergeError: 'Merge conflicts detected: src/app.ts',
      mergeConflictFiles: ['src/app.ts'],
      integrationBranch: 'ralph/integration/main',
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager({
        'finalizer.maxRepairAttempts': 1,
      }),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
    }
  );

  await watcher.recoverFailedFinalizeTasks();

  const task = stateManager.tasks.get('merge-repair-task');
  assert.equal(task.status, 'pending');
  assert.deepEqual(task.completedUS, []);
  assert.equal(task.storyProgress[0].status, 'needs_repair');
  assert.equal(task.storyProgress[0].attempts, 0);
  assert.match(task.storyProgress[0].lastError, /Merge repair required/);
  assert.match(task.storyProgress[0].lastError, /src\/app\.ts/);
  assert.equal(task.mergeRepairAttempts, 1);
});

test('dependency watcher requeues unrun merge repair without consuming another repair attempt', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'unrun-merge-repair-task',
      prdPath: '/tmp/prd.json',
      status: 'failed_finalize',
      startTime: 100,
      completedUS: ['US-000'],
      storyProgress: [
        {
          id: 'US-000',
          status: 'passed',
          attempts: 1,
          updatedAt: 50,
        },
        {
          id: 'US-001',
          status: 'needs_repair',
          attempts: 2,
          lastError: 'Merge repair required by Ralph.',
          updatedAt: 100,
        },
      ],
      worktree: '/repo/.ralph-worktrees/unrun-merge-repair-task',
      logPath: '/tmp/unrun-merge-repair.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      finalizerAttempts: 2,
      mergeRepairAttempts: 1,
      mergeError: 'Merge conflicts detected: src/app.ts',
      mergeConflictFiles: ['src/app.ts'],
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager({
        'finalizer.maxRepairAttempts': 1,
      }),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
    }
  );

  await watcher.recoverFailedFinalizeTasks();

  const task = stateManager.tasks.get('unrun-merge-repair-task');
  assert.equal(task.status, 'pending');
  assert.deepEqual(task.completedUS, ['US-000']);
  assert.equal(task.storyProgress[0].status, 'passed');
  assert.equal(task.storyProgress[1].status, 'needs_repair');
  assert.equal(task.storyProgress[1].attempts, 0);
  assert.equal(task.mergeRepairAttempts, 1);
});
