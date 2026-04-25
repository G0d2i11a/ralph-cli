const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

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
    const tasks = [...this.tasks.values()]
      .filter((task) => !statusFilter || task.status === statusFilter)
      .map((task) => ({ ...task }));

    return tasks.sort((a, b) => b.startTime - a.startTime);
  }
}

class NoopScheduler {
  constructor() {
    this.scheduleCalls = 0;
  }

  async schedulePendingTasks() {
    this.scheduleCalls += 1;
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

function createPrdFile(dir, id, dependencies = []) {
  const prdPath = path.join(dir, `${id}.json`);
  fs.writeFileSync(prdPath, JSON.stringify({
    id,
    title: `${id} title`,
    description: '',
    dependencies,
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

test('enqueueTaskFromPrd stores immutable PRD metadata and source hash at intake', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-intake-metadata-'));
  const previousHome = process.env.HOME;

  try {
    process.env.HOME = tempDir;
    const prdPath = createPrdFile(tempDir, 'prd-metadata', ['upstream-prd']);
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
    assert.equal(task.prdId, 'prd-metadata');
    assert.equal(task.prdTitle, 'prd-metadata title');
    assert.deepEqual(task.prdDependencies, ['upstream-prd']);
    assert.equal(typeof task.prdSourceHash, 'string');
    assert.equal(task.prdSourceHash.length, 64);
    assert.equal(task.enqueuedAt, 1_000);
    assert.equal(task.storyProgress[0].status, 'pending');
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('enqueueTaskFromPrd dedupes active tasks by repo and prd id by default', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-intake-dedupe-'));
  const previousHome = process.env.HOME;

  try {
    process.env.HOME = tempDir;
    const prdPath = createPrdFile(tempDir, 'duplicate-prd');
    const stateManager = new FakeStateManager();
    const scheduler = new NoopScheduler();
    const commonOptions = {
      repoPath: tempDir,
      stateManager,
      scheduler,
      configManager: { get: () => undefined },
    };

    const first = await enqueueTaskFromPrd(prdPath, commonOptions);
    const second = await enqueueTaskFromPrd(prdPath, commonOptions);

    assert.equal(first.alreadyExists, false);
    assert.equal(second.alreadyExists, true);
    assert.equal(second.taskId, first.taskId);
    assert.equal((await stateManager.listTasks()).length, 1);
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('enqueueTaskFromPrd records the repo base ref before a queued task starts', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-intake-base-'));
  const previousHome = process.env.HOME;

  try {
    process.env.HOME = tempDir;
    execFileSync('git', ['init', '-b', 'main'], { cwd: tempDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tempDir, 'README.md'), 'base\n');
    execFileSync('git', ['add', 'README.md'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', [
      '-c', 'user.email=ralph@example.com',
      '-c', 'user.name=Ralph Test',
      'commit',
      '-m', 'base',
    ], { cwd: tempDir, stdio: 'ignore' });

    const prdPath = createPrdFile(tempDir, 'base-prd');
    const stateManager = new FakeStateManager();
    const scheduler = new NoopScheduler();

    const result = await enqueueTaskFromPrd(prdPath, {
      repoPath: tempDir,
      stateManager,
      scheduler,
      configManager: { get: () => undefined },
    });

    const task = await stateManager.loadTask(result.taskId);
    assert.equal(task.baseRef, 'main');
    assert.match(task.baseCommitSha, /^[0-9a-f]{40}$/);
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('enqueueTaskFromPrd writes task artifacts under RALPH_HOME', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-intake-home-'));
  const customHome = path.join(tempDir, 'custom-ralph-home');
  const previousHome = process.env.HOME;
  const previousRalphHome = process.env.RALPH_HOME;

  try {
    process.env.HOME = tempDir;
    process.env.RALPH_HOME = customHome;
    const prdPath = createPrdFile(tempDir, 'home-prd');
    const stateManager = new FakeStateManager();
    const scheduler = new NoopScheduler();

    const result = await enqueueTaskFromPrd(prdPath, {
      repoPath: tempDir,
      stateManager,
      scheduler,
      configManager: { get: () => undefined },
    });

    assert.equal(fs.existsSync(path.join(customHome, 'tasks', result.taskId, 'agent.log')), false);
    assert.equal(fs.existsSync(path.join(customHome, 'tasks', result.taskId)), true);
    assert.equal(fs.existsSync(path.join(tempDir, '.ralph', 'tasks', result.taskId)), false);
  } finally {
    process.env.HOME = previousHome;
    if (previousRalphHome === undefined) {
      delete process.env.RALPH_HOME;
    } else {
      process.env.RALPH_HOME = previousRalphHome;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
