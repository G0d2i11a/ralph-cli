const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const {
  TaskScheduler,
  finalizeTask,
  markTaskReadyToFinalize,
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
    agent: 'codex',
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

  async updateTaskIf(taskId, predicate, updates) {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { updated: false, task: null };
    }

    const latest = { ...task };
    if (!predicate(latest)) {
      return { updated: false, task: latest };
    }

    const updatedTask = {
      ...task,
      ...updates,
    };
    this.tasks.set(taskId, updatedTask);
    return { updated: true, task: { ...updatedTask } };
  }

  async getTaskByPrdId(prdId, options = {}) {
    const repoPath = options.repoPath;

    for (const task of this.tasks.values()) {
      if (repoPath && task.repoPath !== repoPath) {
        continue;
      }

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

async function dependencyChecker(prd, stateManager, options = {}) {
  const pending = [];

  for (const depId of prd.dependencies || []) {
    const depTask = await stateManager.getTaskByPrdId(depId, options);
    const isIntegrated = Boolean(
      depTask
      && depTask.status === 'completed'
      && (depTask.integratedAt || depTask.integrationCommitSha || depTask.mergedAt || depTask.mergeCommitSha)
    );

    if (!isIntegrated) {
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
    ralphHome: options.ralphHome,
    stateManager,
    configManager: {
      get: (key) => {
        if (key === 'runner.maxConcurrent') {
          return options.maxConcurrent || 1;
        }

        return options.config?.[key];
      },
    },
    worktreeManager: {
      createWorktree: async (_repoPath, taskId, baseRef) => {
        const worktreePath = `/worktrees/${taskId}`;
        worktreeCalls.push({ taskId, worktreePath, baseRef });
        return worktreePath;
      },
    },
    bootstrapWorktreeDeps: () => {},
    parsePRD: createParsePrd(prds),
    checkDependencies: dependencyChecker,
    isProcessRunning: options.isProcessRunning || (() => true),
    terminateProcess: options.terminateProcess,
    lockDir,
    now: options.now,
    sleep: options.sleep,
    forkProcess: (_modulePath, args, forkOptions) => {
      options.onFork?.(forkOptions);
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

test('schedulePendingTasks passes RALPH_HOME to worker processes', async () => {
  const ralphHome = path.join(os.tmpdir(), `ralph-worker-home-${process.pid}-${Date.now()}`);
  let capturedEnv;
  const pendingTask = createTask({
    id: 'pending-env-task',
    prdId: 'pending-env-task',
    prdPath: '/pending-env-task.json',
    startTime: 100,
  });

  const { scheduler } = createScheduler(
    [pendingTask],
    {
      '/pending-env-task.json': { id: 'pending-env-task', dependencies: [] },
    },
    {
      maxConcurrent: 1,
      ralphHome,
      onFork: (forkOptions) => {
        capturedEnv = forkOptions.env;
      },
    }
  );

  await scheduler.schedulePendingTasks();

  assert.equal(capturedEnv.RALPH_HOME, ralphHome);
});

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

test('schedulePendingTasks resets runtime progress counters when restarting a pending task', async () => {
  const now = 50_000;
  const pendingTask = createTask({
    id: 'restart-pending-task',
    prdId: 'restart-pending-task',
    prdPath: '/restart-pending-task.json',
    startTime: 100,
    currentUS: 'US-legacy',
    loopCount: 9,
    consecutiveNoProgress: 4,
    consecutiveErrors: 3,
    lastProgressTime: 10,
    lastFilesChanged: 17,
  });

  const { scheduler, stateManager } = createScheduler(
    [pendingTask],
    {
      '/restart-pending-task.json': { id: 'restart-pending-task', dependencies: [] },
    },
    {
      maxConcurrent: 1,
      now: () => now,
    }
  );

  await scheduler.schedulePendingTasks();

  const startedTask = await stateManager.loadTask('restart-pending-task');

  assert.equal(startedTask.status, 'running');
  assert.equal(startedTask.currentUS, undefined);
  assert.equal(startedTask.loopCount, 0);
  assert.equal(startedTask.consecutiveNoProgress, 0);
  assert.equal(startedTask.consecutiveErrors, 0);
  assert.equal(startedTask.lastProgressTime, now);
  assert.equal(startedTask.lastFilesChanged, 0);
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

test('schedulePendingTasks blocks later same-repo tasks that overlap on declared conflict domains', async () => {
  const firstTask = createTask({
    id: 'first-task',
    prdId: 'first-task',
    prdPath: '/first-task.json',
    declaredConflictDomains: ['contracts-index'],
    startTime: 100,
    enqueuedAt: 100,
  });
  const secondTask = createTask({
    id: 'second-task',
    prdId: 'second-task',
    prdPath: '/second-task.json',
    declaredConflictDomains: ['contracts-index'],
    startTime: 200,
    enqueuedAt: 200,
  });

  const { scheduler, stateManager, forkCalls } = createScheduler(
    [firstTask, secondTask],
    {
      '/first-task.json': { id: 'first-task', dependencies: [] },
      '/second-task.json': { id: 'second-task', dependencies: [] },
    },
    { maxConcurrent: 2 }
  );

  const startedTasks = await scheduler.schedulePendingTasks();
  const persistedSecondTask = await stateManager.loadTask('second-task');

  assert.equal(startedTasks.length, 1);
  assert.deepEqual(forkCalls, ['first-task']);
  assert.equal(persistedSecondTask.status, 'pending');
  assert.equal(persistedSecondTask.coordinationStatus, 'blocked_predicted_overlap');
  assert.deepEqual(persistedSecondTask.coordinationBlockers, ['first-task']);
});

test('schedulePendingTasks keeps later overlap pending while an earlier failed merge repair still owns the conflict surface', async () => {
  const failedOwner = createTask({
    id: 'failed-owner',
    prdId: 'failed-owner',
    status: 'failed',
    observedWriteSurface: ['packages/contracts/src/index.ts'],
    mergeConflictFiles: ['packages/contracts/src/index.ts'],
    repairContext: {
      mode: 'merge',
      storyId: 'US-003',
      createdAt: 123,
      reason: 'Merge repair required by Ralph.',
    },
    startTime: 100,
    enqueuedAt: 100,
  });
  const laterTask = createTask({
    id: 'later-task',
    prdId: 'later-task',
    prdPath: '/later-task.json',
    declaredWriteSurface: ['packages/contracts/src/index.ts'],
    startTime: 200,
    enqueuedAt: 200,
  });

  const { scheduler, stateManager, forkCalls } = createScheduler(
    [failedOwner, laterTask],
    {
      '/later-task.json': { id: 'later-task', dependencies: [] },
    },
    { maxConcurrent: 2 }
  );

  const startedTasks = await scheduler.schedulePendingTasks();
  const persistedLaterTask = await stateManager.loadTask('later-task');

  assert.equal(startedTasks.length, 0);
  assert.deepEqual(forkCalls, []);
  assert.equal(persistedLaterTask.status, 'pending');
  assert.equal(persistedLaterTask.coordinationStatus, 'blocked_predicted_overlap');
  assert.deepEqual(persistedLaterTask.coordinationBlockers, ['failed-owner']);
});

test('schedulePendingTasks does not block overlapping declared conflict domains across repositories', async () => {
  const repoATask = createTask({
    id: 'repo-a-task',
    prdId: 'repo-a-task',
    prdPath: '/repo-a-task.json',
    repoPath: '/repo-a',
    declaredConflictDomains: ['contracts-index'],
    startTime: 100,
    enqueuedAt: 100,
  });
  const repoBTask = createTask({
    id: 'repo-b-task',
    prdId: 'repo-b-task',
    prdPath: '/repo-b-task.json',
    repoPath: '/repo-b',
    declaredConflictDomains: ['contracts-index'],
    startTime: 200,
    enqueuedAt: 200,
  });

  const { scheduler, forkCalls } = createScheduler(
    [repoATask, repoBTask],
    {
      '/repo-a-task.json': { id: 'repo-a-task', dependencies: [] },
      '/repo-b-task.json': { id: 'repo-b-task', dependencies: [] },
    },
    { maxConcurrent: 2 }
  );

  const startedTasks = await scheduler.schedulePendingTasks();

  assert.equal(startedTasks.length, 2);
  assert.deepEqual(forkCalls, ['repo-a-task', 'repo-b-task']);
});

test('schedulePendingTasks only satisfies dependencies from the same repository', async () => {
  const foreignCompletedTask = createTask({
    id: 'shared-dependency-foreign',
    prdId: 'shared-dependency',
    status: 'completed',
    integratedAt: 123,
    integrationCommitSha: 'foreign-sha',
    repoPath: '/other-repo',
    worktree: '/other-repo/.ralph-worktrees/shared-dependency-foreign',
  });
  const blockedTask = createTask({
    id: 'repo-scoped-task',
    prdId: 'repo-scoped-task',
    prdPath: '/repo-scoped-task.json',
    repoPath: '/repo',
    startTime: 100,
  });
  const readyTask = createTask({
    id: 'same-repo-ready',
    prdId: 'same-repo-ready',
    prdPath: '/same-repo-ready.json',
    repoPath: '/repo',
    startTime: 200,
  });

  const { scheduler, stateManager, forkCalls } = createScheduler(
    [foreignCompletedTask, blockedTask, readyTask],
    {
      '/repo-scoped-task.json': { id: 'repo-scoped-task', dependencies: ['shared-dependency'] },
      '/same-repo-ready.json': { id: 'same-repo-ready', dependencies: [] },
    },
    { maxConcurrent: 1 }
  );

  const startedTasks = await scheduler.schedulePendingTasks();
  const persistedBlockedTask = await stateManager.loadTask('repo-scoped-task');
  const persistedReadyTask = await stateManager.loadTask('same-repo-ready');

  assert.equal(startedTasks.length, 1);
  assert.equal(startedTasks[0].id, 'same-repo-ready');
  assert.equal(persistedBlockedTask.status, 'pending');
  assert.equal(persistedReadyTask.status, 'running');
  assert.deepEqual(forkCalls, ['same-repo-ready']);
});

test('schedulePendingTasks uses immutable task dependency metadata instead of mutable PRD source', async () => {
  const dependencyTask = createTask({
    id: 'dep-task',
    prdId: 'dep-prd',
    status: 'completed',
    integratedAt: 500,
    integrationCommitSha: 'integrated-sha',
    repoPath: '/repo',
  });
  const pendingTask = createTask({
    id: 'pending-with-snapshot',
    prdId: 'pending-with-snapshot',
    prdPath: '/mutable-prd.json',
    prdDependencies: ['dep-prd'],
    startTime: 100,
  });

  const { scheduler, stateManager, forkCalls } = createScheduler(
    [dependencyTask, pendingTask],
    {
      '/mutable-prd.json': { id: 'pending-with-snapshot', dependencies: ['new-unintegrated-dep'] },
    },
    { maxConcurrent: 1 }
  );

  const startedTasks = await scheduler.schedulePendingTasks();
  const persistedTask = await stateManager.loadTask('pending-with-snapshot');

  assert.equal(startedTasks.length, 1);
  assert.equal(persistedTask.status, 'running');
  assert.deepEqual(forkCalls, ['pending-with-snapshot']);
});

test('schedulePendingTasks waits for dependencies to be integrated, not merely completed', async () => {
  const completedButNotIntegrated = createTask({
    id: 'upstream-task',
    prdId: 'upstream-prd',
    status: 'completed',
    repoPath: '/repo',
  });
  const blockedTask = createTask({
    id: 'blocked-on-integration',
    prdId: 'blocked-on-integration',
    prdPath: '/blocked-on-integration.json',
    prdDependencies: ['upstream-prd'],
    startTime: 100,
  });

  const { scheduler, stateManager, forkCalls } = createScheduler(
    [completedButNotIntegrated, blockedTask],
    {
      '/blocked-on-integration.json': { id: 'blocked-on-integration', dependencies: [] },
    },
    { maxConcurrent: 1 }
  );

  const startedTasks = await scheduler.schedulePendingTasks();
  const persistedTask = await stateManager.loadTask('blocked-on-integration');

  assert.equal(startedTasks.length, 0);
  assert.equal(persistedTask.status, 'pending');
  assert.deepEqual(forkCalls, []);
});

test('schedulePendingTasks creates queued worktree from recorded base ref', async () => {
  const queuedTask = createTask({
    id: 'queued-base-task',
    prdId: 'queued-base-task',
    prdPath: '/queued-base.json',
    baseRef: 'main-at-enqueue',
    startTime: 100,
  });

  const { scheduler, worktreeCalls } = createScheduler(
    [queuedTask],
    {
      '/queued-base.json': { id: 'queued-base-task', dependencies: [] },
    },
    { maxConcurrent: 1 }
  );

  await scheduler.schedulePendingTasks();

  assert.deepEqual(worktreeCalls, [{
    taskId: 'queued-base-task',
    worktreePath: '/worktrees/queued-base-task',
    baseRef: 'main-at-enqueue',
  }]);
});

test('schedulePendingTasks recovers stale running tasks before claiming concurrency slots', async () => {
  const staleRunningTask = createTask({
    id: 'stale-running-task',
    prdId: 'stale-running-task',
    prdPath: '/stale-running.json',
    status: 'running',
    startTime: 100,
    currentUS: 'US-001',
    worktree: '/worktrees/stale-running-task',
    pid: 999999,
  });
  const queuedTask = createTask({
    id: 'queued-after-stale',
    prdId: 'queued-after-stale',
    prdPath: '/queued-after-stale.json',
    startTime: 200,
  });

  const { scheduler, stateManager, forkCalls } = createScheduler(
    [staleRunningTask, queuedTask],
    {
      '/stale-running.json': { id: 'stale-running-task', dependencies: [] },
      '/queued-after-stale.json': { id: 'queued-after-stale', dependencies: [] },
    },
    {
      maxConcurrent: 1,
      isProcessRunning: (pid) => pid !== 999999,
    }
  );

  const startedTasks = await scheduler.schedulePendingTasks();
  const recoveredTask = await stateManager.loadTask('stale-running-task');
  const startedQueuedTask = await stateManager.loadTask('queued-after-stale');

  assert.equal(startedTasks.length, 1);
  assert.equal(startedTasks[0].id, 'queued-after-stale');
  assert.equal(recoveredTask.status, 'failed');
  assert.equal(recoveredTask.pid, undefined);
  assert.equal(recoveredTask.currentUS, undefined);
  assert.match(recoveredTask.lastError, /no longer running/i);
  assert.equal(startedQueuedTask.status, 'running');
  assert.deepEqual(forkCalls, ['queued-after-stale']);
});

test('schedulePendingTasks recovers running tasks with missing PID and stale lease', async () => {
  const now = 10_000;
  const missingPidTask = createTask({
    id: 'missing-pid-running',
    prdId: 'missing-pid-running',
    prdPath: '/missing-pid.json',
    status: 'running',
    startTime: 100,
    currentUS: 'US-001',
    worktree: '/worktrees/missing-pid-running',
    leaseOwner: 'worker:missing',
    leaseHeartbeatAt: 1_000,
    leaseExpiresAt: 2_000,
  });
  const queuedTask = createTask({
    id: 'queued-after-missing-pid',
    prdId: 'queued-after-missing-pid',
    prdPath: '/queued-after-missing-pid.json',
    startTime: 200,
  });

  const { scheduler, stateManager, forkCalls } = createScheduler(
    [missingPidTask, queuedTask],
    {
      '/missing-pid.json': { id: 'missing-pid-running', dependencies: [] },
      '/queued-after-missing-pid.json': { id: 'queued-after-missing-pid', dependencies: [] },
    },
    {
      maxConcurrent: 1,
      now: () => now,
    }
  );

  const startedTasks = await scheduler.schedulePendingTasks();
  const recoveredTask = await stateManager.loadTask('missing-pid-running');
  const startedQueuedTask = await stateManager.loadTask('queued-after-missing-pid');

  assert.equal(startedTasks.length, 1);
  assert.equal(recoveredTask.status, 'failed');
  assert.equal(recoveredTask.leaseOwner, undefined);
  assert.match(recoveredTask.lastError, /pid is missing/i);
  assert.equal(startedQueuedTask.status, 'running');
  assert.deepEqual(forkCalls, ['queued-after-missing-pid']);
});

test('schedulePendingTasks recovers live running tasks that exceed stagnation timeout', async () => {
  let processAlive = true;
  const terminateSignals = [];
  let now = 100_000;
  const stagnantTask = createTask({
    id: 'stagnant-running-task',
    prdId: 'stagnant-running-task',
    prdPath: '/stagnant-running.json',
    status: 'running',
    startTime: 100,
    currentUS: 'US-003',
    worktree: '/worktrees/stagnant-running-task',
    pid: 4242,
    lastProgressTime: 0,
  });
  const queuedTask = createTask({
    id: 'queued-after-stagnant',
    prdId: 'queued-after-stagnant',
    prdPath: '/queued-after-stagnant.json',
    startTime: 200,
  });

  const { scheduler, stateManager, forkCalls } = createScheduler(
    [stagnantTask, queuedTask],
    {
      '/stagnant-running.json': { id: 'stagnant-running-task', dependencies: [] },
      '/queued-after-stagnant.json': { id: 'queued-after-stagnant', dependencies: [] },
    },
    {
      maxConcurrent: 1,
      config: {
        'runner.stagnationTimeout': 30,
      },
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      isProcessRunning: () => processAlive,
      terminateProcess: (_pid, signal) => {
        terminateSignals.push(signal);
        processAlive = false;
      },
    }
  );

  const startedTasks = await scheduler.schedulePendingTasks();
  const recoveredTask = await stateManager.loadTask('stagnant-running-task');
  const startedQueuedTask = await stateManager.loadTask('queued-after-stagnant');

  assert.equal(startedTasks.length, 1);
  assert.equal(startedTasks[0].id, 'queued-after-stagnant');
  assert.equal(recoveredTask.status, 'stagnant');
  assert.equal(recoveredTask.pid, undefined);
  assert.equal(recoveredTask.currentUS, undefined);
  assert.equal(recoveredTask.lastErrorKind, 'stagnation');
  assert.match(recoveredTask.lastError, /no progress/i);
  assert.deepEqual(terminateSignals, ['SIGTERM']);
  assert.equal(startedQueuedTask.status, 'running');
  assert.deepEqual(forkCalls, ['queued-after-stagnant']);
});

test('schedulePendingTasks does not overwrite ready_to_finalize task after stale stagnant worker completes during recovery', async () => {
  let processAlive = true;
  let now = 100_000;
  const staleRunningTask = createTask({
    id: 'stale-finishing-task',
    prdId: 'stale-finishing-task',
    prdPath: '/stale-finishing-task.json',
    status: 'running',
    startTime: 100,
    currentUS: 'US-003',
    worktree: '/worktrees/stale-finishing-task',
    pid: 4444,
    leaseOwner: 'worker:4444',
    lastProgressTime: 0,
    completedUS: ['US-001', 'US-002', 'US-003'],
    storyProgress: [
      { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
      { id: 'US-002', status: 'passed', attempts: 1, updatedAt: 2 },
      { id: 'US-003', status: 'passed', attempts: 1, updatedAt: 3 },
    ],
  });
  const queuedTask = createTask({
    id: 'queued-after-finishing-task',
    prdId: 'queued-after-finishing-task',
    prdPath: '/queued-after-finishing-task.json',
    startTime: 200,
  });

  const { scheduler, stateManager } = createScheduler(
    [staleRunningTask, queuedTask],
    {
      '/stale-finishing-task.json': { id: 'stale-finishing-task', dependencies: [] },
      '/queued-after-finishing-task.json': { id: 'queued-after-finishing-task', dependencies: [] },
    },
    {
      maxConcurrent: 1,
      config: {
        'runner.stagnationTimeout': 30,
      },
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      isProcessRunning: () => processAlive,
      terminateProcess: () => {
        processAlive = false;
        stateManager.updateTask('stale-finishing-task', {
          status: 'ready_to_finalize',
          pid: undefined,
          currentUS: undefined,
          leaseOwner: undefined,
          leaseHeartbeatAt: undefined,
          leaseExpiresAt: undefined,
          lastProgressTime: now,
        });
      },
    }
  );

  await scheduler.schedulePendingTasks();

  const recoveredTask = await stateManager.loadTask('stale-finishing-task');
  assert.equal(recoveredTask.status, 'ready_to_finalize');
  assert.equal(recoveredTask.lastErrorKind, undefined);
  assert.deepEqual(recoveredTask.completedUS, ['US-001', 'US-002', 'US-003']);
  assert.equal(recoveredTask.storyProgress[2].status, 'passed');
});

test('recoverStaleTasks returns stale finalizing tasks to ready_to_finalize', async () => {
  const finalizingTask = createTask({
    id: 'stale-finalizing',
    prdId: 'stale-finalizing',
    status: 'finalizing',
    startTime: 100,
    worktree: '/worktrees/stale-finalizing',
    leaseOwner: 'finalizer:dead',
    leaseHeartbeatAt: 100,
    leaseExpiresAt: 200,
  });

  const { scheduler, stateManager } = createScheduler(
    [finalizingTask],
    {},
    { maxConcurrent: 1, now: () => 10_000 }
  );

  await scheduler.recoverStaleTasks();

  const recoveredTask = await stateManager.loadTask('stale-finalizing');
  assert.equal(recoveredTask.status, 'ready_to_finalize');
  assert.equal(recoveredTask.leaseOwner, undefined);
  assert.match(recoveredTask.lastError, /finalizer lease is stale/i);
});

test('recoverStaleTasks treats configured finalizer lease timeouts as seconds', async () => {
  const finalizingTask = createTask({
    id: 'fresh-finalizing',
    prdId: 'fresh-finalizing',
    status: 'finalizing',
    startTime: 100,
    worktree: '/worktrees/fresh-finalizing',
    leaseOwner: 'finalizer:alive',
    leaseHeartbeatAt: 1_000,
  });

  const { scheduler, stateManager } = createScheduler(
    [finalizingTask],
    {},
    {
      maxConcurrent: 1,
      now: () => 10_000,
      config: {
        'finalizer.leaseTimeout': 1800,
      },
    }
  );

  await scheduler.recoverStaleTasks();

  const recoveredTask = await stateManager.loadTask('fresh-finalizing');
  assert.equal(recoveredTask.status, 'finalizing');
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
    isProcessRunning: () => true,
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

test('markTaskReadyToFinalize releases a slot and auto-starts the next queued task', async () => {
  const runningTask = createTask({
    id: 'running-ready-task',
    prdId: 'running-ready-task',
    prdPath: '/running-ready.json',
    status: 'running',
    startTime: 100,
    currentUS: 'US-002',
    worktree: '/worktrees/running-ready-task',
    pid: 6100,
  });
  const queuedTask = createTask({
    id: 'queued-after-ready',
    prdId: 'queued-after-ready',
    prdPath: '/queued-after-ready.json',
    startTime: 200,
  });

  const { stateManager, forkCalls } = createScheduler(
    [runningTask, queuedTask],
    {
      '/running-ready.json': { id: 'running-ready-task', dependencies: [] },
      '/queued-after-ready.json': { id: 'queued-after-ready', dependencies: [] },
    },
    { maxConcurrent: 1 }
  );

  const taskToAdvance = await stateManager.loadTask('running-ready-task');
  await markTaskReadyToFinalize(taskToAdvance, {
    stateManager,
    configManager: {
      get: (key) => key === 'runner.maxConcurrent' ? 1 : undefined,
    },
    worktreeManager: {
      createWorktree: async (_repoPath, taskId) => `/worktrees/${taskId}`,
    },
    bootstrapWorktreeDeps: () => {},
    parsePRD: createParsePrd({
      '/running-ready.json': { id: 'running-ready-task', dependencies: [] },
      '/queued-after-ready.json': { id: 'queued-after-ready', dependencies: [] },
    }),
    checkDependencies: dependencyChecker,
    lockDir: path.join(
      os.tmpdir(),
      `ralph-ready-test-${process.pid}-${Math.random().toString(36).slice(2)}`
    ),
    forkProcess: (_modulePath, args) => {
      forkCalls.push(args[0]);
      return {
        pid: 6200,
        unref() {},
      };
    },
  });

  const readyTask = await stateManager.loadTask('running-ready-task');
  const startedQueuedTask = await stateManager.loadTask('queued-after-ready');

  assert.equal(readyTask.status, 'ready_to_finalize');
  assert.equal(readyTask.pid, undefined);
  assert.equal(readyTask.currentUS, undefined);
  assert.equal(startedQueuedTask.status, 'running');
  assert.equal(startedQueuedTask.pid, 6200);
  assert.deepEqual(forkCalls, ['queued-after-ready']);
});
