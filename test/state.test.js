const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { StateManager } = require('../dist/core/state.js');

function createTask(overrides = {}) {
  const now = 1_000;
  return {
    id: 'state-task',
    prdPath: '/tmp/prd.json',
    status: 'pending',
    startTime: now,
    completedUS: [],
    worktree: '',
    logPath: '/tmp/agent.log',
    agent: 'codex',
    repoPath: '/tmp/repo',
    loopCount: 0,
    consecutiveNoProgress: 0,
    consecutiveErrors: 0,
    lastProgressTime: now,
    lastFilesChanged: 0,
    ...overrides,
  };
}

test('StateManager rejects stale full-object writes and accepts patch updates', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-state-revision-'));
  const previousHome = process.env.HOME;
  const previousRalphHome = process.env.RALPH_HOME;

  try {
    process.env.HOME = homeDir;
    delete process.env.RALPH_HOME;
    const stateManager = new StateManager();

    const originalTask = createTask();
    await stateManager.saveTask(originalTask);
    const firstSnapshot = await stateManager.loadTask(originalTask.id);

    await stateManager.updateTask(originalTask.id, {
      status: 'running',
      pid: 1234,
    });

    await assert.rejects(
      () => stateManager.saveTask({
        ...firstSnapshot,
        currentUS: 'US-001',
      }),
      /Stale task write rejected/
    );

    await stateManager.updateTask(originalTask.id, {
      currentUS: 'US-001',
    });

    const latestTask = await stateManager.loadTask(originalTask.id);
    assert.equal(latestTask.status, 'running');
    assert.equal(latestTask.pid, 1234);
    assert.equal(latestTask.currentUS, 'US-001');
    assert.equal(latestTask.revision, 3);
  } finally {
    process.env.HOME = previousHome;
    if (previousRalphHome === undefined) {
      delete process.env.RALPH_HOME;
    } else {
      process.env.RALPH_HOME = previousRalphHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('StateManager isolates task storage by RALPH_HOME', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-state-home-'));
  const customHomeA = path.join(homeDir, 'ralph-a');
  const customHomeB = path.join(homeDir, 'ralph-b');
  const previousHome = process.env.HOME;
  const previousRalphHome = process.env.RALPH_HOME;

  try {
    process.env.HOME = homeDir;
    process.env.RALPH_HOME = customHomeA;
    const stateManagerA = new StateManager();
    await stateManagerA.saveTask(createTask({ id: 'task-a' }));

    process.env.RALPH_HOME = customHomeB;
    const stateManagerB = new StateManager();

    assert.equal((await stateManagerA.listTasks()).length, 1);
    assert.equal((await stateManagerB.listTasks()).length, 0);
    assert.equal(fs.existsSync(path.join(customHomeA, 'tasks', 'task-a', 'state.json')), true);
    assert.equal(fs.existsSync(path.join(customHomeB, 'tasks', 'task-a', 'state.json')), false);
  } finally {
    process.env.HOME = previousHome;
    if (previousRalphHome === undefined) {
      delete process.env.RALPH_HOME;
    } else {
      process.env.RALPH_HOME = previousRalphHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('StateManager strips removed operator-needed fields on read and write', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-state-removed-fields-'));
  const previousHome = process.env.HOME;
  const previousRalphHome = process.env.RALPH_HOME;

  try {
    process.env.HOME = homeDir;
    delete process.env.RALPH_HOME;
    const stateManager = new StateManager();
    const task = createTask({
      id: 'removed-fields-task',
      attention: { needed: true, reason: 'old operator bucket' },
      humanAttention: true,
      recoverableAttention: false,
      attentionReason: 'old reason',
      attentionRepairKind: 'baseline_exhaustion',
      attentionRepairTotalRequeues: 2,
      autonomyRepairKind: 'baseline_exhaustion',
      autonomyRepairTotalRequeues: 2,
    });
    const taskDir = path.join(homeDir, '.ralph', 'tasks', task.id);
    const statePath = path.join(taskDir, 'state.json');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(task, null, 2));

    const loadedTask = await stateManager.loadTask(task.id);
    assert.equal(Object.hasOwn(loadedTask, 'attention'), false);
    assert.equal(Object.hasOwn(loadedTask, 'humanAttention'), false);
    assert.equal(Object.hasOwn(loadedTask, 'recoverableAttention'), false);
    assert.equal(Object.hasOwn(loadedTask, 'attentionReason'), false);
    assert.equal(Object.hasOwn(loadedTask, 'attentionRepairKind'), false);
    assert.equal(Object.hasOwn(loadedTask, 'attentionRepairTotalRequeues'), false);
    assert.equal(loadedTask.autonomyRepairKind, 'baseline_exhaustion');
    assert.equal(loadedTask.autonomyRepairTotalRequeues, 2);

    await stateManager.updateTask(task.id, { status: 'running' });
    const persistedTask = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(Object.hasOwn(persistedTask, 'attention'), false);
    assert.equal(Object.hasOwn(persistedTask, 'humanAttention'), false);
    assert.equal(Object.hasOwn(persistedTask, 'recoverableAttention'), false);
    assert.equal(Object.hasOwn(persistedTask, 'attentionReason'), false);
    assert.equal(Object.hasOwn(persistedTask, 'attentionRepairKind'), false);
    assert.equal(Object.hasOwn(persistedTask, 'attentionRepairTotalRequeues'), false);
    assert.equal(persistedTask.autonomyRepairKind, 'baseline_exhaustion');
    assert.equal(persistedTask.autonomyRepairTotalRequeues, 2);
  } finally {
    process.env.HOME = previousHome;
    if (previousRalphHome === undefined) {
      delete process.env.RALPH_HOME;
    } else {
      process.env.RALPH_HOME = previousRalphHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('StateManager updateTaskIf refuses stale conditional updates', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-state-conditional-'));
  const previousHome = process.env.HOME;
  const previousRalphHome = process.env.RALPH_HOME;

  try {
    process.env.HOME = homeDir;
    delete process.env.RALPH_HOME;
    const stateManager = new StateManager();
    await stateManager.saveTask(createTask({
      id: 'conditional-task',
      status: 'running',
      pid: 1234,
      leaseOwner: 'worker:1234',
    }));

    await stateManager.updateTask('conditional-task', {
      status: 'ready_to_finalize',
      pid: undefined,
      leaseOwner: undefined,
    });

    const result = await stateManager.updateTaskIf(
      'conditional-task',
      (task) => task.status === 'running' && task.pid === 1234,
      {
        status: 'stagnant',
        lastError: 'stale recovery write',
      },
    );

    const latestTask = await stateManager.loadTask('conditional-task');
    assert.equal(result.updated, false);
    assert.equal(latestTask.status, 'ready_to_finalize');
    assert.equal(latestTask.lastError, undefined);
  } finally {
    process.env.HOME = previousHome;
    if (previousRalphHome === undefined) {
      delete process.env.RALPH_HOME;
    } else {
      process.env.RALPH_HOME = previousRalphHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
