const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ConfigManager } = require('../dist/config/manager.js');
const { DependencyWatcher } = require('../dist/core/dependency-watcher.js');
const { enqueueFollowupPrd, buildFollowupPrdForTask } = require('../dist/core/followup-prd.js');
const { StateManager } = require('../dist/core/state.js');

function createTask(overrides = {}) {
  const now = 1_000;
  return {
    id: 'source-task',
    prdPath: '/tmp/source.json',
    prdId: 'source-prd',
    prdTitle: 'Source PRD',
    status: 'failed',
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

test('buildFollowupPrdForTask creates deterministic repair PRD content', () => {
  const task = createTask({
    declaredWriteSurface: ['apps/api'],
  });
  const generated = buildFollowupPrdForTask({
    task,
    reason: 'story repair budget exhausted',
    failure: {
      id: 'failure:1',
      observedAt: 1,
      kind: 'quality_gate',
      signature: 'failure-signature',
      rawMessage: 'test failed',
      failedFiles: ['apps/api/service.ts'],
    },
    recommendedStories: ['Repair the failing API test'],
  });

  assert.equal(generated.prd.id, 'followup:source-prd:6dae7b71e78e8413');
  assert.match(generated.prd.title, /story repair budget exhausted/);
  assert.equal(generated.prd.userStories[0].id, 'US-001');
  assert.deepEqual(generated.prd.writeSurface, ['apps/api/service.ts', 'apps/api']);
  assert.match(generated.prd.description, /failure-signature/);
});

test('enqueueFollowupPrd writes generated PRD, enqueues it, and records source linkage', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-followup-prd-'));
  const repoDir = path.join(homeDir, 'repo');
  const previousHome = process.env.HOME;
  const previousRalphHome = process.env.RALPH_HOME;
  fs.mkdirSync(repoDir, { recursive: true });

  try {
    process.env.HOME = homeDir;
    delete process.env.RALPH_HOME;
    const stateManager = new StateManager();
    const configManager = new ConfigManager();
    const sourceTask = createTask({
      repoPath: repoDir,
      prdPath: path.join(repoDir, 'source.json'),
      logPath: path.join(homeDir, 'source-agent.log'),
      followupGenerationHardCap: 2,
    });
    const scheduler = {
      describePendingTask: async () => null,
      schedulePendingTasks: async () => {},
    };
    fs.writeFileSync(sourceTask.prdPath, JSON.stringify({
      id: 'source-prd',
      title: 'Source PRD',
      description: 'source',
      userStories: [
        {
          id: 'US-001',
          title: 'Source story',
          description: 'source',
          acceptanceCriteria: ['source'],
        },
      ],
    }, null, 2));
    await stateManager.saveTask(sourceTask);

    const result = await enqueueFollowupPrd({
      task: sourceTask,
      stateManager,
      scheduler,
      configManager,
      reason: 'failed blocker recovery stopped',
      recommendedStories: ['Implement a targeted blocker repair'],
      now: () => 1234,
    });

    assert.equal(result.prdId.startsWith('followup:source-prd:'), true);
    assert.equal(result.prdPath, path.join(homeDir, '.ralph', 'generated-prds', 'source-task', '1234-followup.json'));
    assert.equal(fs.existsSync(result.prdPath), true);

    const followupTask = await stateManager.loadTask(result.taskId);
    assert.equal(followupTask.prdId, result.prdId);
    assert.equal(followupTask.status, 'pending');

    const updatedSource = await stateManager.loadTask(sourceTask.id);
    assert.deepEqual(updatedSource.followupPrdIds, [result.prdId]);
    assert.deepEqual(updatedSource.followupTaskIds, [result.taskId]);
    assert.equal(updatedSource.followupGeneratedAt, 1234);
    assert.equal(updatedSource.followupReason, 'failed blocker recovery stopped');
    assert.equal(updatedSource.followupGenerationTotal, 1);
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

test('DependencyWatcher generates follow-up PRD for stopped story repair recovery', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-followup-watcher-'));
  const repoDir = path.join(homeDir, 'repo');
  const previousHome = process.env.HOME;
  const previousRalphHome = process.env.RALPH_HOME;
  fs.mkdirSync(repoDir, { recursive: true });

  try {
    process.env.HOME = homeDir;
    delete process.env.RALPH_HOME;
    const stateManager = new StateManager();
    const configManager = new ConfigManager();
    const scheduler = {
      describePendingTask: async () => null,
      schedulePendingTasks: async () => {},
    };
    const sourceTask = createTask({
      repoPath: repoDir,
      prdPath: path.join(repoDir, 'source.json'),
      logPath: path.join(homeDir, 'source-agent.log'),
      storyRepairRecoveryStoppedAt: 2000,
      storyRepairRecoveryStopReason: 'story_repair_budget_exhausted',
    });
    fs.writeFileSync(sourceTask.prdPath, JSON.stringify({
      id: 'source-prd',
      title: 'Source PRD',
      description: 'source',
      userStories: [
        {
          id: 'US-001',
          title: 'Source story',
          description: 'source',
          acceptanceCriteria: ['source'],
        },
      ],
    }, null, 2));
    await stateManager.saveTask(sourceTask);

    const watcher = new DependencyWatcher({ repo: repoDir }, {
      stateManager,
      scheduler,
      configManager,
      logger: { log() {}, error() {} },
    });

    await watcher.recoverStoppedStoryRepairTasks();

    const updatedSource = await stateManager.loadTask(sourceTask.id);
    assert.equal(updatedSource.followupPrdIds.length, 1);
    assert.equal(updatedSource.followupTaskIds.length, 1);
    assert.equal(updatedSource.followupReason, 'story_repair_budget_exhausted');
    const followupTask = await stateManager.loadTask(updatedSource.followupTaskIds[0]);
    assert.equal(followupTask.prdId, updatedSource.followupPrdIds[0]);
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

test('DependencyWatcher generates follow-up PRD for generic stopped recovery state', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-followup-generic-'));
  const repoDir = path.join(homeDir, 'repo');
  const previousHome = process.env.HOME;
  const previousRalphHome = process.env.RALPH_HOME;
  fs.mkdirSync(repoDir, { recursive: true });

  try {
    process.env.HOME = homeDir;
    delete process.env.RALPH_HOME;
    const stateManager = new StateManager();
    const configManager = new ConfigManager();
    const scheduler = {
      describePendingTask: async () => null,
      schedulePendingTasks: async () => {},
    };
    const sourceTask = createTask({
      repoPath: repoDir,
      prdPath: path.join(repoDir, 'source.json'),
      logPath: path.join(homeDir, 'source-agent.log'),
      autoRecoveryStoppedAt: 2000,
      autoRecoveryStopReason: 'operator_stopped',
      autoRecoveryLastReason: 'Task was explicitly stopped by operator',
    });
    fs.writeFileSync(sourceTask.prdPath, JSON.stringify({
      id: 'source-prd',
      title: 'Source PRD',
      description: 'source',
      userStories: [
        {
          id: 'US-001',
          title: 'Source story',
          description: 'source',
          acceptanceCriteria: ['source'],
        },
      ],
    }, null, 2));
    await stateManager.saveTask(sourceTask);

    const watcher = new DependencyWatcher({ repo: repoDir }, {
      stateManager,
      scheduler,
      configManager,
      logger: { log() {}, error() {} },
    });

    await watcher.recoverStoppedGenericRecoveryTasks();

    const updatedSource = await stateManager.loadTask(sourceTask.id);
    assert.equal(updatedSource.followupPrdIds.length, 1);
    assert.equal(updatedSource.followupTaskIds.length, 1);
    assert.equal(updatedSource.followupReason, 'operator_stopped');
    const followupTask = await stateManager.loadTask(updatedSource.followupTaskIds[0]);
    assert.equal(followupTask.prdId, updatedSource.followupPrdIds[0]);
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
