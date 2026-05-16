const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { enqueueTaskFromPrd } = require('../dist/core/task-intake.js');

class FakeStateManager {
  constructor(tasks = []) {
    this.tasks = new Map(tasks.map((task) => [task.id, { ...task }]));
  }

  async saveTask(task) {
    this.tasks.set(task.id, { ...task });
  }

  async loadTask(taskId) {
    const task = this.tasks.get(taskId);
    return task ? { ...task } : null;
  }

  async listTasks(statusFilter) {
    return [...this.tasks.values()]
      .filter((task) => !statusFilter || task.status === statusFilter)
      .map((task) => ({ ...task }));
  }
}

class NoopScheduler {
  async schedulePendingTasks() {
    return [];
  }

  async describePendingTask() {
    return {
      reason: 'queued',
      dependencies: [],
      maxConcurrent: 3,
      running: 0,
    };
  }
}

function createPrdFile(dir, id, dependencies = [], overrides = {}) {
  const prdPath = path.join(dir, `${id.replace(/[:/]/g, '-')}.json`);
  fs.writeFileSync(prdPath, JSON.stringify({
    id,
    title: `${id} title`,
    description: '',
    dependencies,
    ...overrides,
    userStories: [
      {
        id: 'US-001',
        title: 'First story',
        description: '',
        acceptanceCriteria: [],
      },
    ],
  }, null, 2));
  return prdPath;
}

test('enqueueTaskFromPrd stores dependency repair metadata from PRD', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-intake-repair-metadata-'));
  const previousHome = process.env.HOME;

  try {
    process.env.HOME = tempDir;
    const prdPath = createPrdFile(tempDir, 'followup:source-prd:abc123', [], {
      priorityClass: 'dependency_repair',
      repairOf: {
        prdId: 'source-prd',
        taskId: 'source-task',
        reason: 'story_repair_hard_cap_reached',
      },
      releasesDependenciesFor: ['source-prd'],
      schedulerHints: {
        priorityClass: 'dependency_repair',
        effectiveDependencyPrdId: 'source-prd',
        releasesDependenciesFor: ['source-prd'],
      },
    });
    const stateManager = new FakeStateManager();
    const scheduler = new NoopScheduler();

    const result = await enqueueTaskFromPrd(prdPath, {
      repoPath: tempDir,
      stateManager,
      scheduler,
      configManager: { get: () => undefined },
      now: () => 1_000,
    });

    const task = await stateManager.loadTask(result.taskId);
    assert.equal(task.prdId, 'followup:source-prd:abc123');
    assert.equal(task.priorityClass, 'dependency_repair');
    assert.deepEqual(task.repairOf, {
      prdId: 'source-prd',
      taskId: 'source-task',
      reason: 'story_repair_hard_cap_reached',
    });
    assert.deepEqual(task.releasesDependenciesFor, ['source-prd']);
    assert.equal(task.effectiveDependencyPrdId, 'source-prd');
    assert.deepEqual(task.schedulerHints, {
      priorityClass: 'dependency_repair',
      effectiveDependencyPrdId: 'source-prd',
      releasesDependenciesFor: ['source-prd'],
    });
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
