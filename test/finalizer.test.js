const test = require('node:test');
const assert = require('node:assert/strict');

const { DependencyWatcher } = require('../dist/core/dependency-watcher.js');

class FakeStateManager {
  constructor(tasks = []) {
    this.tasks = new Map(tasks.map((task) => [task.id, { ...task }]));
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
  assert.equal(started.length, 1);
});
