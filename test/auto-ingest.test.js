const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DEFAULT_AGENT, DEFAULT_BACKEND, resolveAgentType, resolveAgentBackend } = require('../dist/core/agent.js');
const { PrdAutoIngestor } = require('../dist/core/prd-auto-ingest.js');

let previousRalphHome;

test.beforeEach(() => {
  previousRalphHome = process.env.RALPH_HOME;
  delete process.env.RALPH_HOME;
});

test.afterEach(() => {
  if (previousRalphHome === undefined) {
    delete process.env.RALPH_HOME;
  } else {
    process.env.RALPH_HOME = previousRalphHome;
  }
});

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
    userStories: overrides.userStories || [
      {
        id: 'US-001',
        title: 'First story',
        description: '',
        acceptanceCriteria: ['Done'],
      },
    ],
    dependencies: overrides.dependencies || [],
  };

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}

function writeMarkdownPrd(filePath, id) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---
id: ${id}
title: ${id} title
dependencies: []
acceptanceCriteria:
  - Done
---

## Notes

Implementation details.
`);
}

function createTrackedTask(overrides = {}) {
  return {
    id: overrides.id || 'task-existing',
    prdPath: overrides.prdPath || '/repo/archive/prd-existing.md',
    prdId: overrides.prdId || 'existing-prd',
    prdTitle: overrides.prdTitle || 'Existing PRD',
    status: overrides.status || 'completed',
    startTime: overrides.startTime || 1,
    completedUS: [],
    worktree: overrides.worktree || '',
    logPath: overrides.logPath || '',
    eventLogPath: overrides.eventLogPath || '',
    agent: overrides.agent || 'codex',
    backend: overrides.backend || 'cli',
    repoPath: overrides.repoPath || '/repo',
    loopCount: 0,
    consecutiveNoProgress: 0,
    consecutiveErrors: 0,
    lastProgressTime: overrides.startTime || 1,
    lastFilesChanged: 0,
  };
}

test('default agent and backend resolve to codex/cli', () => {
  assert.equal(DEFAULT_AGENT, 'codex');
  assert.equal(DEFAULT_BACKEND, 'cli');
  assert.equal(resolveAgentType(), 'codex');
  assert.equal(resolveAgentBackend(), 'cli');
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
      backend: 'sdk-runner',
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
    assert.equal(tasksAfterFirstIngest[0].backend, 'agent-runners');
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

test('PrdAutoIngestor watches repo-relative PRD globs and dedupes by repo and PRD id', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-auto-ingest-glob-repo-'));
  const duplicatePrd = path.join(repoDir, 'tasks', 'prd-shared.md');
  const uniquePrd = path.join(repoDir, 'tasks', 'prd-unique.md');
  const signatures = new Map();
  const stateManager = new FakeStateManager([
    createTrackedTask({
      id: 'task-shared',
      prdPath: path.join(repoDir, 'archive', 'prd-shared.md'),
      prdId: 'shared-prd',
      repoPath: repoDir,
    }),
  ]);
  const scheduler = new FakeScheduler(stateManager);
  const previousHome = process.env.HOME;
  let now = 0;

  try {
    process.env.HOME = repoDir;

    const ingestor = new PrdAutoIngestor({
      glob: 'tasks/prd-*.md',
      repoPath: repoDir,
      agent: 'codex',
      settleMs: 1000,
    }, {
      stateManager,
      scheduler,
      now: () => now,
      statSignature: (filePath) => signatures.get(filePath) || 'missing',
    });

    await ingestor.initialize();

    writeMarkdownPrd(duplicatePrd, 'shared-prd');
    writeMarkdownPrd(uniquePrd, 'unique-prd');
    signatures.set(duplicatePrd, 'duplicate-v1');
    signatures.set(uniquePrd, 'unique-v1');

    assert.equal((await ingestor.scan()).length, 0);
    now = 1500;

    const results = await ingestor.scan();
    const resultsByName = new Map(results.map((result) => [path.basename(result.filePath), result]));
    const tasks = await stateManager.listTasks();

    assert.equal(results.length, 2);
    assert.equal(resultsByName.get('prd-shared.md').action, 'already-tracked');
    assert.equal(resultsByName.get('prd-shared.md').taskId, 'task-shared');
    assert.equal(resultsByName.get('prd-unique.md').action, 'ingested');
    assert.equal(tasks.filter((task) => task.prdId === 'unique-prd').length, 1);
    assert.equal(scheduler.scheduleCalls, 1);
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('PrdAutoIngestor scopes PRD id dedupe to the configured repo', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-auto-ingest-glob-repo-scope-'));
  const otherRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-auto-ingest-glob-other-repo-'));
  const sharedPrd = path.join(repoDir, 'tasks', 'prd-shared.md');
  const signatures = new Map();
  const stateManager = new FakeStateManager([
    createTrackedTask({
      id: 'task-other-repo',
      prdPath: path.join(otherRepoDir, 'tasks', 'prd-shared.md'),
      prdId: 'shared-prd',
      repoPath: otherRepoDir,
    }),
  ]);
  const scheduler = new FakeScheduler(stateManager);
  const previousHome = process.env.HOME;
  let now = 0;

  try {
    process.env.HOME = repoDir;

    const ingestor = new PrdAutoIngestor({
      glob: 'tasks/prd-*.md',
      repoPath: repoDir,
      agent: 'codex',
      settleMs: 1000,
    }, {
      stateManager,
      scheduler,
      now: () => now,
      statSignature: (filePath) => signatures.get(filePath) || 'missing',
    });

    await ingestor.initialize();

    writeMarkdownPrd(sharedPrd, 'shared-prd');
    signatures.set(sharedPrd, 'shared-v1');

    await ingestor.scan();
    now = 1500;
    const results = await ingestor.scan();
    const tasks = await stateManager.listTasks();

    assert.equal(results.length, 1);
    assert.equal(results[0].action, 'ingested');
    assert.equal(tasks.filter((task) => task.prdId === 'shared-prd').length, 2);
    assert.equal(scheduler.scheduleCalls, 1);
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(otherRepoDir, { recursive: true, force: true });
  }
});

test('PrdAutoIngestor skips markdown PRDs marked non-executable', async () => {
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-auto-ingest-non-executable-'));
  const strategyPrd = path.join(watchDir, 'ez4ielts-strategy.md');
  const signatures = new Map();
  const stateManager = new FakeStateManager();
  const scheduler = new FakeScheduler(stateManager);
  const previousHome = process.env.HOME;
  let now = 0;

  try {
    process.env.HOME = watchDir;

    const ingestor = new PrdAutoIngestor({
      watchDir,
      pattern: 'ez4ielts-*.md',
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

    fs.writeFileSync(strategyPrd, `---
id: strategy-prd
title: Strategy PRD
status: planning
priority: P2
executable: false
dependencies: []
---

## Strategy

This document is intentionally not an implementation task.
`);
    signatures.set(strategyPrd, 'strategy-v1');

    await ingestor.scan();
    now = 1500;
    const results = await ingestor.scan();

    assert.equal(results.length, 1);
    assert.equal(results[0].action, 'skipped');
    assert.match(results[0].reason, /marked non-executable/i);
    assert.equal((await stateManager.listTasks()).length, 0);
    assert.equal(scheduler.scheduleCalls, 0);

    now = 3000;
    assert.equal((await ingestor.scan()).length, 0);
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
    assert.equal(tasks[0].backend, 'cli');
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test('PrdAutoIngestor retries invalid markdown after changes and extracts dependencies', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-auto-ingest-markdown-invalid-'));
  const markdownPrd = path.join(repoDir, 'tasks', 'prd-invalid.md');
  const signatures = new Map();
  const stateManager = new FakeStateManager();
  const scheduler = new FakeScheduler(stateManager);
  const previousHome = process.env.HOME;
  let now = 0;

  try {
    process.env.HOME = repoDir;

    const ingestor = new PrdAutoIngestor({
      glob: 'tasks/prd-*.md',
      repoPath: repoDir,
      agent: 'codex',
      settleMs: 1000,
    }, {
      stateManager,
      scheduler,
      now: () => now,
      statSignature: (filePath) => signatures.get(filePath) || 'missing',
    });

    await ingestor.initialize();

    fs.mkdirSync(path.dirname(markdownPrd), { recursive: true });
    fs.writeFileSync(markdownPrd, `---
id: invalid-markdown-prd
title: Invalid Markdown PRD
dependencies: upstream-prd
acceptanceCriteria:
  - Done
---

## Notes

Invalid dependency metadata should block intake.
`);
    signatures.set(markdownPrd, 'invalid-v1');

    await ingestor.scan();
    now = 1500;
    const invalidResults = await ingestor.scan();
    assert.equal(invalidResults.length, 1);
    assert.equal(invalidResults[0].action, 'invalid');
    assert.match(invalidResults[0].error, /field "dependencies" must be an array/i);
    assert.equal((await stateManager.listTasks()).length, 0);

    now = 3000;
    assert.equal((await ingestor.scan()).length, 0);

    fs.writeFileSync(markdownPrd, `---
id: invalid-markdown-prd
title: Invalid Markdown PRD
dependencies:
  - upstream-prd
  - design-prd
acceptanceCriteria:
  - Done
---

## Notes

The metadata is valid now.
`);
    signatures.set(markdownPrd, 'valid-v2');

    await ingestor.scan();
    now = 4500;
    const validResults = await ingestor.scan();
    const tasks = await stateManager.listTasks();

    assert.equal(validResults.length, 1);
    assert.equal(validResults[0].action, 'ingested');
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].prdId, 'invalid-markdown-prd');
    assert.deepEqual(tasks[0].prdDependencies, ['upstream-prd', 'design-prd']);
    assert.equal(scheduler.scheduleCalls, 1);
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('PrdAutoIngestor marks PRDs without explicit title as invalid', async () => {
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-auto-ingest-title-'));
  const untitledPrd = path.join(watchDir, 'ez4ielts-untitled.json');
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

    fs.writeFileSync(untitledPrd, JSON.stringify({
      projectName: 'fallback-project-name',
      description: '',
      userStories: [],
      dependencies: [],
    }, null, 2));
    signatures.set(untitledPrd, 'untitled-v1');

    await ingestor.scan();
    now = 1500;
    const results = await ingestor.scan();

    assert.equal(results.length, 1);
    assert.equal(results[0].action, 'invalid');
    assert.match(results[0].error, /must define a non-empty top-level title/i);
    assert.equal((await stateManager.listTasks()).length, 0);
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});
