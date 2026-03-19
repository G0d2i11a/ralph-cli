const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
