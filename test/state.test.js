const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { StateManager } = require('../dist/core/state.js');
const { checkDependencies } = require('../dist/utils/helpers.js');

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

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createGitRepoWithIntegrationWorktree(rootDir) {
  const repoDir = path.join(rootDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ['init']);
  git(repoDir, ['config', 'user.email', 'ralph-test@example.com']);
  git(repoDir, ['config', 'user.name', 'Ralph Test']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'test\n');
  git(repoDir, ['add', 'README.md']);
  git(repoDir, ['commit', '-m', 'initial']);
  git(repoDir, ['branch', '-M', 'main']);

  const integrationWorktree = path.join(repoDir, '.ralph-integration', 'main');
  fs.mkdirSync(path.dirname(integrationWorktree), { recursive: true });
  git(repoDir, ['worktree', 'add', '-b', 'ralph/integration/main', integrationWorktree]);

  return { repoDir, integrationWorktree };
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

test('StateManager resolves dependency repair tasks by original PRD identity', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-state-repair-identity-'));
  const previousHome = process.env.HOME;
  const previousRalphHome = process.env.RALPH_HOME;

  try {
    process.env.HOME = homeDir;
    delete process.env.RALPH_HOME;
    const stateManager = new StateManager();

    await stateManager.saveTask(createTask({
      id: 'failed-source',
      prdId: 'source-prd',
      status: 'failed',
      startTime: 100,
      repoPath: '/tmp/repo',
    }));
    await stateManager.saveTask(createTask({
      id: 'repair-followup',
      prdId: 'followup:source-prd:abc123',
      priorityClass: 'dependency_repair',
      repairOf: {
        prdId: 'source-prd',
        taskId: 'failed-source',
        reason: 'story_repair_hard_cap_reached',
      },
      releasesDependenciesFor: ['source-prd'],
      effectiveDependencyPrdId: 'source-prd',
      status: 'pending',
      startTime: 200,
      repoPath: '/tmp/repo',
    }));

    const dependencyTask = await stateManager.getTaskByPrdId('source-prd', { repoPath: '/tmp/repo' });
    assert.equal(dependencyTask.id, 'repair-followup');
    assert.equal(dependencyTask.prdId, 'followup:source-prd:abc123');
    const followupTask = await stateManager.getTaskByPrdId('followup:source-prd:abc123', { repoPath: '/tmp/repo' });
    assert.equal(followupTask.id, 'repair-followup');

    const dependencyState = await checkDependencies({
      id: 'downstream-prd',
      title: 'Downstream',
      description: '',
      userStories: [],
      dependencies: ['source-prd'],
    }, stateManager, { repoPath: '/tmp/repo' });
    assert.equal(dependencyState.satisfied, false);
    assert.deepEqual(dependencyState.recovering, ['source-prd']);
    assert.deepEqual(dependencyState.repairTaskIds, ['repair-followup']);
    assert.equal(dependencyState.blockers[0].taskId, 'repair-followup');
    assert.equal(dependencyState.blockers[0].dependencyRepairActive, true);
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

test('StateManager resolves dependency tasks across main repo and integration worktree paths', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-state-repo-equivalence-'));
  const homeDir = path.join(tempDir, 'home');
  const { repoDir, integrationWorktree } = createGitRepoWithIntegrationWorktree(tempDir);
  const previousHome = process.env.HOME;
  const previousRalphHome = process.env.RALPH_HOME;

  try {
    process.env.HOME = homeDir;
    delete process.env.RALPH_HOME;
    const stateManager = new StateManager();

    await stateManager.saveTask(createTask({
      id: 'completed-source',
      prdId: 'source-prd',
      status: 'completed',
      integrationStatus: 'integrated',
      integratedAt: 300,
      startTime: 100,
      repoPath: repoDir,
    }));

    const dependencyTask = await stateManager.getTaskByPrdId('source-prd', {
      repoPath: integrationWorktree,
    });
    assert.equal(dependencyTask.id, 'completed-source');

    const dependencyState = await checkDependencies({
      id: 'downstream-prd',
      title: 'Downstream',
      description: '',
      userStories: [],
      dependencies: ['source-prd'],
    }, stateManager, { repoPath: integrationWorktree });

    assert.equal(dependencyState.satisfied, true);
    assert.deepEqual(dependencyState.pending, []);
    assert.deepEqual(dependencyState.missing, []);
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

test('checkDependencies treats legacy hard-cap follow-up as active dependency repair', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-state-legacy-repair-'));
  const previousHome = process.env.HOME;
  const previousRalphHome = process.env.RALPH_HOME;

  try {
    process.env.HOME = homeDir;
    delete process.env.RALPH_HOME;
    const stateManager = new StateManager();

    await stateManager.saveTask(createTask({
      id: 'failed-source',
      prdId: 'source-prd',
      status: 'failed',
      followupTaskIds: ['legacy-followup'],
      followupPrdIds: ['followup:source-prd:legacy'],
      followupReason: 'story_repair_hard_cap_reached',
      startTime: 100,
      repoPath: '/tmp/repo',
    }));
    await stateManager.saveTask(createTask({
      id: 'legacy-followup',
      prdId: 'followup:source-prd:legacy',
      status: 'pending',
      startTime: 200,
      repoPath: '/tmp/repo',
    }));

    const dependencyState = await checkDependencies({
      id: 'downstream-prd',
      title: 'Downstream',
      description: '',
      userStories: [],
      dependencies: ['source-prd'],
    }, stateManager, { repoPath: '/tmp/repo' });

    assert.equal(dependencyState.satisfied, false);
    assert.deepEqual(dependencyState.failed, []);
    assert.deepEqual(dependencyState.recovering, ['source-prd']);
    assert.deepEqual(dependencyState.repairTaskIds, ['legacy-followup']);
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

test('checkDependencies treats integrated legacy hard-cap follow-up as releasing the dependency', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-state-legacy-repair-integrated-'));
  const previousHome = process.env.HOME;
  const previousRalphHome = process.env.RALPH_HOME;

  try {
    process.env.HOME = homeDir;
    delete process.env.RALPH_HOME;
    const stateManager = new StateManager();

    await stateManager.saveTask(createTask({
      id: 'failed-source',
      prdId: 'source-prd',
      status: 'failed',
      followupTaskIds: ['legacy-followup'],
      followupPrdIds: ['followup:source-prd:legacy'],
      followupReason: 'story_repair_hard_cap_reached',
      startTime: 100,
      repoPath: '/tmp/repo',
    }));
    await stateManager.saveTask(createTask({
      id: 'legacy-followup',
      prdId: 'followup:source-prd:legacy',
      status: 'completed',
      integrationStatus: 'integrated',
      integratedAt: 300,
      integrationCommitSha: 'abc123',
      startTime: 200,
      repoPath: '/tmp/repo',
    }));

    const dependencyState = await checkDependencies({
      id: 'downstream-prd',
      title: 'Downstream',
      description: '',
      userStories: [],
      dependencies: ['source-prd'],
    }, stateManager, { repoPath: '/tmp/repo' });

    assert.equal(dependencyState.satisfied, true);
    assert.deepEqual(dependencyState.pending, []);
    assert.deepEqual(dependencyState.failed, []);
    assert.deepEqual(dependencyState.recovering, []);
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
