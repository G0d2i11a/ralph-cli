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

function createPrdFile(dir, id, dependencies = [], overrides = {}) {
  const prdPath = path.join(dir, `${id}.json`);
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

test('enqueueTaskFromPrd stores declared coordination metadata from PRD', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-intake-coordination-'));
  const previousHome = process.env.HOME;

  try {
    process.env.HOME = tempDir;
    const prdPath = createPrdFile(tempDir, 'prd-coordination', [], {
      writeSurface: ['packages/contracts/', 'scripts/wiki/sync.ts'],
      conflictDomains: ['contracts-index'],
      integrationLane: 'contracts',
    });
    const stateManager = new FakeStateManager();
    const scheduler = new NoopScheduler();

    const result = await enqueueTaskFromPrd(prdPath, {
      repoPath: tempDir,
      stateManager,
      scheduler,
      configManager: { get: () => undefined },
      now: () => 2_000,
    });

    const task = await stateManager.loadTask(result.taskId);
    assert.deepEqual(task.declaredWriteSurface, ['packages/contracts', 'scripts/wiki/sync.ts']);
    assert.deepEqual(task.declaredConflictDomains, ['contracts-index']);
    assert.equal(task.integrationLane, 'contracts');
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

test('enqueueTaskFromPrd rejects a Ralph home that is already active for another repo by default', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-intake-home-guard-'));
  const previousHome = process.env.HOME;
  const repoA = path.join(tempDir, 'repo-a');
  const repoB = path.join(tempDir, 'repo-b');

  try {
    process.env.HOME = tempDir;
    fs.mkdirSync(repoA, { recursive: true });
    fs.mkdirSync(repoB, { recursive: true });
    const prdPath = createPrdFile(repoB, 'foreign-home-prd');
    const stateManager = new FakeStateManager([
      {
        id: 'task-a',
        prdPath: path.join(repoA, 'existing.json'),
        prdId: 'existing',
        status: 'running',
        startTime: 1,
        completedUS: [],
        worktree: path.join(repoA, '.ralph-worktrees', 'task-a'),
        logPath: path.join(tempDir, '.ralph', 'tasks', 'task-a', 'agent.log'),
        agent: 'codex',
        repoPath: repoA,
        loopCount: 0,
        consecutiveNoProgress: 0,
        consecutiveErrors: 0,
        lastProgressTime: 1,
        lastFilesChanged: 0,
      },
    ]);
    const scheduler = new NoopScheduler();

    await assert.rejects(
      enqueueTaskFromPrd(prdPath, {
        repoPath: repoB,
        stateManager,
        scheduler,
        configManager: { get: () => undefined },
      }),
      /already active for .*repo-a.*Refusing to enqueue tasks/i,
    );
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('enqueueTaskFromPrd allows mixed-repo Ralph homes when explicitly overridden', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-intake-home-guard-override-'));
  const previousHome = process.env.HOME;
  const repoA = path.join(tempDir, 'repo-a');
  const repoB = path.join(tempDir, 'repo-b');

  try {
    process.env.HOME = tempDir;
    fs.mkdirSync(repoA, { recursive: true });
    fs.mkdirSync(repoB, { recursive: true });
    const prdPath = createPrdFile(repoB, 'mixed-home-prd');
    const stateManager = new FakeStateManager([
      {
        id: 'task-a',
        prdPath: path.join(repoA, 'existing.json'),
        prdId: 'existing',
        status: 'running',
        startTime: 1,
        completedUS: [],
        worktree: path.join(repoA, '.ralph-worktrees', 'task-a'),
        logPath: path.join(tempDir, '.ralph', 'tasks', 'task-a', 'agent.log'),
        agent: 'codex',
        repoPath: repoA,
        loopCount: 0,
        consecutiveNoProgress: 0,
        consecutiveErrors: 0,
        lastProgressTime: 1,
        lastFilesChanged: 0,
      },
    ]);
    const scheduler = new NoopScheduler();

    const result = await enqueueTaskFromPrd(prdPath, {
      repoPath: repoB,
      allowMixedHome: true,
      stateManager,
      scheduler,
      configManager: { get: () => undefined },
      now: () => 3_000,
    });

    assert.equal(result.alreadyExists, false);
    const task = await stateManager.loadTask(result.taskId);
    assert.equal(task.repoPath, repoB);
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('enqueueTaskFromPrd rejects PRDs without an explicit title', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-intake-title-'));
  const previousHome = process.env.HOME;

  try {
    process.env.HOME = tempDir;
    const prdPath = path.join(tempDir, 'untitled.json');
    fs.writeFileSync(prdPath, JSON.stringify({
      projectName: 'fallback-project-name',
      description: '',
      userStories: [
        {
          id: 'US-001',
          title: 'First story',
          description: '',
          acceptanceCriteria: [],
        },
      ],
    }, null, 2));

    const stateManager = new FakeStateManager();
    const scheduler = new NoopScheduler();

    await assert.rejects(
      enqueueTaskFromPrd(prdPath, {
        repoPath: tempDir,
        stateManager,
        scheduler,
        configManager: { get: () => undefined },
      }),
      /must define a non-empty top-level title/i,
    );
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
