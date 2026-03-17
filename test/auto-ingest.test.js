const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DEFAULT_AGENT, resolveAgentType } = require('../dist/core/agent.js');
const { PrdAutoIngestor } = require('../dist/core/prd-auto-ingest.js');

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
    const tasks = [...this.tasks.values()]
      .filter((task) => !statusFilter || task.status === statusFilter)
      .map((task) => ({ ...task }));

    return tasks.sort((a, b) => b.startTime - a.startTime);
  }

  async getTaskByPrdPath(prdPath) {
    const resolved = path.resolve(prdPath);
    for (const task of this.tasks.values()) {
      if (path.resolve(task.prdPath) === resolved) {
        return { ...task };
      }
    }

    return null;
  }
}

class FakeScheduler {
  constructor(stateManager) {
    this.stateManager = stateManager;
    this.scheduleCalls = 0;
  }

  async schedulePendingTasks() {
    this.scheduleCalls += 1;
    return [];
  }

  async describePendingTask(task) {
    const running = await this.stateManager.listTasks('running');
    return {
      reason: 'queued',
      dependencies: [],
      maxConcurrent: 3,
      running: running.length,
      ...task,
    };
  }
}

function createPrdFile(dir, name, overrides = {}) {
  const filePath = path.join(dir, name);
  const payload = {
    id: overrides.id || path.basename(name, '.json'),
    title: overrides.title || name,
    description: overrides.description || '',
    userStories: overrides.userStories || [],
    dependencies: overrides.dependencies || [],
  };

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}

test('default agent resolves to codex', () => {
  assert.equal(DEFAULT_AGENT, 'codex');
  assert.equal(resolveAgentType(), 'codex');
});

test('PrdAutoIngestor skips backlog, ingests new files once, and ignores later modifications', async () => {
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-auto-ingest-'));
  const backlogPrd = createPrdFile(watchDir, 'ez4ielts-existing.json', { id: 'existing-prd' });
  const newPrd = path.join(watchDir, 'ez4ielts-new.json');
  const signatures = new Map([[backlogPrd, 'existing-v1']]);
  const stateManager = new FakeStateManager();
  const scheduler = new FakeScheduler(stateManager);
  const previousHome = process.env.HOME;
  let now = 0;

  try {
    process.env.HOME = watchDir;

    const ingestor = new PrdAutoIngestor({
      watchDir,
      repoPath: '/repo',
      agent: 'codex',
      settleMs: 1000,
    }, {
      stateManager,
      scheduler,
      now: () => now,
      statSignature: (filePath) => signatures.get(filePath) || 'missing',
    });

    await ingestor.initialize();

    createPrdFile(watchDir, 'ez4ielts-new.json', { id: 'new-prd' });
    signatures.set(newPrd, 'new-v1');

    assert.equal((await ingestor.scan()).length, 0);
    now = 500;
    assert.equal((await ingestor.scan()).length, 0);
    now = 1500;

    const firstResults = await ingestor.scan();
    const tasksAfterFirstIngest = await stateManager.listTasks();

    assert.equal(firstResults.length, 1);
    assert.equal(firstResults[0].action, 'ingested');
    assert.equal(tasksAfterFirstIngest.length, 1);
    assert.equal(path.basename(tasksAfterFirstIngest[0].prdPath), 'ez4ielts-new.json');
    assert.equal(scheduler.scheduleCalls, 1);

    signatures.set(newPrd, 'new-v2');
    now = 3000;
    const secondResults = await ingestor.scan();
    const tasksAfterModification = await stateManager.listTasks();

    assert.equal(secondResults.length, 0);
    assert.equal(tasksAfterModification.length, 1);
    assert.equal(scheduler.scheduleCalls, 1);
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test('PrdAutoIngestor retries invalid JSON only after the file changes', async () => {
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-auto-ingest-invalid-'));
  const invalidPrd = path.join(watchDir, 'ez4ielts-invalid.json');
  const signatures = new Map();
  const stateManager = new FakeStateManager();
  const scheduler = new FakeScheduler(stateManager);
  const previousHome = process.env.HOME;
  let now = 0;

  try {
    process.env.HOME = watchDir;

    const ingestor = new PrdAutoIngestor({
      watchDir,
      repoPath: '/repo',
      agent: 'codex',
      settleMs: 1000,
    }, {
      stateManager,
      scheduler,
      now: () => now,
      statSignature: (filePath) => signatures.get(filePath) || 'missing',
    });

    await ingestor.initialize();

    fs.writeFileSync(invalidPrd, '{"id":');
    signatures.set(invalidPrd, 'invalid-v1');

    await ingestor.scan();
    now = 1500;
    const invalidResults = await ingestor.scan();
    assert.equal(invalidResults.length, 1);
    assert.equal(invalidResults[0].action, 'invalid');
    assert.equal((await stateManager.listTasks()).length, 0);

    now = 3000;
    assert.equal((await ingestor.scan()).length, 0);
    assert.equal((await stateManager.listTasks()).length, 0);

    createPrdFile(watchDir, 'ez4ielts-invalid.json', { id: 'fixed-prd' });
    signatures.set(invalidPrd, 'valid-v2');

    await ingestor.scan();
    now = 4500;
    const validResults = await ingestor.scan();
    const tasks = await stateManager.listTasks();

    assert.equal(validResults.length, 1);
    assert.equal(validResults[0].action, 'ingested');
    assert.equal(tasks.length, 1);
    assert.equal(path.basename(tasks[0].prdPath), 'ez4ielts-invalid.json');
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});
