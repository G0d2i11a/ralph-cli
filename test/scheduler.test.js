const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const {
  TaskScheduler,
  finalizeTask,
} = require('../dist/core/scheduler.js');

let taskCounter = 0;

function createTask(overrides = {}) {
  const id = overrides.id || `task-${++taskCounter}`;
  const startTime = overrides.startTime || taskCounter * 100;

  return {
    id,
    prdId: overrides.prdId || id,
    prdPath: overrides.prdPath || `/${id}.json`,
    status: 'pending',
    startTime,
    completedUS: [],
    worktree: '',
    logPath: `/logs/${id}.log`,
    agent: 'claude',
    repoPath: '/repo',
    loopCount: 0,
    consecutiveNoProgress: 0,
    consecutiveErrors: 0,
    lastProgressTime: startTime,
    lastFilesChanged: 0,
    ...overrides,
  };
}

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

  async updateTask(taskId, updates) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    this.tasks.set(taskId, {
      ...task,
      ...updates,
    });
  }

  async getTaskByPrdId(prdId) {
    for (const task of this.tasks.values()) {
      if (task.prdId === prdId) {
        return { ...task };
      }
    }

    return null;
  }
}

function createParsePrd(prds) {
  return (prdPath) => {
    const prd = prds[prdPath];
    if (!prd) {
      throw new Error(`Unknown PRD path ${prdPath}`);
    }

    return {
      id: prd.id,
      title: prd.id,
      description: '',
      userStories: [],
      dependencies: prd.dependencies || [],
    };
  };
}

async function dependencyChecker(prd, stateManager) {
  const pending = [];

  for (const depId of prd.dependencies || []) {
    const depTask = await stateManager.getTaskByPrdId(depId);
    if (!depTask || depTask.status !== 'completed') {
      pending.push(depId);
    }
  }

  return {
    satisfied: pending.length === 0,
    pending,
  };
}

function createScheduler(tasks, prds, options = {}) {
  let nextPid = options.initialPid || 4000;
  const stateManager = new FakeStateManager(tasks);
  const worktreeCalls = [];
  const forkCalls = [];
  const lockDir = path.join(
    os.tmpdir(),
    `ralph-scheduler-test-${process.pid}-${Math.random().toString(36).slice(2)}`
  );

  const scheduler = new TaskScheduler({
    stateManager,
    configManager: {
      get: (key) => key === 'runner.maxConcurrent' ? options.maxConcurrent || 1 : undefined,
    },
    worktreeManager: {
      createWorktree: async (_repoPath, taskId) => {
        const worktreePath = `/worktrees/${taskId}`;
        worktreeCalls.push({ taskId, worktreePath });
        return worktreePath;
      },
    },
    bootstrapWorktreeDeps: () => {},
    parsePRD: createParsePrd(prds),
    checkDependencies: dependencyChecker,
    lockDir,
    forkProcess: (_modulePath, args) => {
      forkCalls.push(args[0]);
      return {
        pid: nextPid++,
        unref() {},
      };
    },
  });

  return {
    scheduler,
    stateManager,
    worktreeCalls,
    forkCalls,
  };
}

test('schedulePendingTasks respects maxConcurrent and starts oldest queued task first', async () => {
  const runningTask = createTask({
    id: 'running-task',
    prdId: 'running-task',
    status: 'running',
    startTime: 300,
    worktree: '/worktrees/running-task',
    pid: 3010,
  });
  const oldestPending = createTask({
    id: 'oldest-pending',
    prdId: 'oldest-pending',
    prdPath: '/oldest.json',
    startTime: 100,
  });
  const newestPending = createTask({
    id: 'newest-pending',
    prdId: 'newest-pending',
    prdPath: '/newest.json',
    startTime: 200,
  });

  const { scheduler, stateManager, forkCalls } = createScheduler(
    [runningTask, oldestPending, newestPending],
    {
      '/oldest.json': { id: 'oldest-pending', dependencies: [] },
      '/newest.json': { id: 'newest-pending', dependencies: [] },
      '/running-task.json': { id: 'running-task', dependencies: [] },
    },
    { maxConcurrent: 2 }
  );

  const startedTasks = await scheduler.schedulePendingTasks();

  assert.equal(startedTasks.length, 1);
  assert.equal(startedTasks[0].id, 'oldest-pending');
  assert.deepEqual(forkCalls, ['oldest-pending']);

  const startedTask = await stateManager.loadTask('oldest-pending');
  const queuedTask = await stateManager.loadTask('newest-pending');

  assert.equal(startedTask.status, 'running');
  assert.equal(startedTask.worktree, '/worktrees/oldest-pending');
  assert.equal(startedTask.pid, 4000);
  assert.equal(queuedTask.status, 'pending');
});

test('schedulePendingTasks skips dependency-blocked tasks and starts later ready work', async () => {
  const blockedTask = createTask({
    id: 'blocked-task',
    prdId: 'blocked-task',
    prdPath: '/blocked.json',
    startTime: 100,
  });
  const readyTask = createTask({
    id: 'ready-task',
    prdId: 'ready-task',
    prdPath: '/ready.json',
    startTime: 200,
  });

  const { scheduler, stateManager, forkCalls } = createScheduler(
    [blockedTask, readyTask],
    {
      '/blocked.json': { id: 'blocked-task', dependencies: ['missing-dependency'] },
      '/ready.json': { id: 'ready-task', dependencies: [] },
    },
    { maxConcurrent: 1 }
  );

  const startedTasks = await scheduler.schedulePendingTasks();

  assert.equal(startedTasks.length, 1);
  assert.equal(startedTasks[0].id, 'ready-task');
  assert.deepEqual(forkCalls, ['ready-task']);

  const blocked = await stateManager.loadTask('blocked-task');
  const ready = await stateManager.loadTask('ready-task');

  assert.equal(blocked.status, 'pending');
  assert.equal(ready.status, 'running');
});

test('schedulePendingTasks claims a slot before fork so stale worker snapshots cannot overbook', async () => {
  const runningTask = createTask({
    id: 'running-task',
    prdId: 'running-task',
    status: 'running',
    startTime: 100,
    worktree: '/worktrees/running-task',
    pid: 3100,
  });
  const raceTask = createTask({
    id: 'race-task',
    prdId: 'race-task',
    prdPath: '/race.json',
    startTime: 200,
  });
  const queuedTask = createTask({
    id: 'queued-task',
    prdId: 'queued-task',
    prdPath: '/queued.json',
    startTime: 300,
  });

  const stateManager = new FakeStateManager([runningTask, raceTask, queuedTask]);
  const forkCalls = [];
  const lockDir = path.join(
    os.tmpdir(),
    `ralph-scheduler-race-test-${process.pid}-${Math.random().toString(36).slice(2)}`
  );
  let nextPid = 7000;
  let staleWorkerSnapshot;

  const scheduler = new TaskScheduler({
    stateManager,
    configManager: {
      get: (key) => key === 'runner.maxConcurrent' ? 2 : undefined,
    },
    worktreeManager: {
      createWorktree: async (_repoPath, taskId) => `/worktrees/${taskId}`,
    },
    bootstrapWorktreeDeps: () => {},
    parsePRD: createParsePrd({
      '/race.json': { id: 'race-task', dependencies: [] },
      '/queued.json': { id: 'queued-task', dependencies: [] },
    }),
    checkDependencies: dependencyChecker,
    lockDir,
    forkProcess: (_modulePath, args) => {
      const taskId = args[0];
      forkCalls.push(taskId);
      staleWorkerSnapshot = { ...stateManager.tasks.get(taskId) };

      return {
        pid: nextPid++,
        unref() {},
      };
    },
  });

  const initiallyStarted = await scheduler.schedulePendingTasks();

  assert.equal(initiallyStarted.length, 1);
  assert.equal(initiallyStarted[0].id, 'race-task');
  assert.equal(staleWorkerSnapshot.status, 'running');

  staleWorkerSnapshot.currentUS = 'US-1';
  await stateManager.saveTask(staleWorkerSnapshot);

  const laterStarted = await scheduler.schedulePendingTasks();
  const persistedRaceTask = await stateManager.loadTask('race-task');
  const persistedQueuedTask = await stateManager.loadTask('queued-task');

  assert.equal(laterStarted.length, 0);
  assert.deepEqual(forkCalls, ['race-task']);
  assert.equal(persistedRaceTask.status, 'running');
  assert.equal(persistedQueuedTask.status, 'pending');
});

test('finalizeTask releases a slot and auto-starts the next queued task', async () => {
  const runningTask = createTask({
    id: 'running-task',
    prdId: 'running-task',
    prdPath: '/running.json',
    status: 'running',
    startTime: 100,
    worktree: '/worktrees/running-task',
    pid: 5000,
  });
  const queuedTask = createTask({
    id: 'queued-task',
    prdId: 'queued-task',
    prdPath: '/queued.json',
    startTime: 200,
  });

  const { stateManager, forkCalls } = createScheduler(
    [runningTask, queuedTask],
    {
      '/running.json': { id: 'running-task', dependencies: [] },
      '/queued.json': { id: 'queued-task', dependencies: [] },
    },
    { maxConcurrent: 1 }
  );

  const taskToFinalize = await stateManager.loadTask('running-task');
  await finalizeTask(taskToFinalize, 'completed', {
    stateManager,
    configManager: {
      get: (key) => key === 'runner.maxConcurrent' ? 1 : undefined,
    },
    worktreeManager: {
      createWorktree: async (_repoPath, taskId) => `/worktrees/${taskId}`,
    },
    bootstrapWorktreeDeps: () => {},
    parsePRD: createParsePrd({
      '/running.json': { id: 'running-task', dependencies: [] },
      '/queued.json': { id: 'queued-task', dependencies: [] },
    }),
    checkDependencies: dependencyChecker,
    lockDir: path.join(
      os.tmpdir(),
      `ralph-finalize-test-${process.pid}-${Math.random().toString(36).slice(2)}`
    ),
    forkProcess: (_modulePath, args) => {
      forkCalls.push(args[0]);
      return {
        pid: 6000,
        unref() {},
      };
    },
  });

  const completedTask = await stateManager.loadTask('running-task');
  const startedQueuedTask = await stateManager.loadTask('queued-task');

  assert.equal(completedTask.status, 'completed');
  assert.equal(startedQueuedTask.status, 'running');
  assert.equal(startedQueuedTask.pid, 6000);
  assert.deepEqual(forkCalls, ['queued-task']);
});
