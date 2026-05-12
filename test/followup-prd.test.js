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

test('buildFollowupPrdForTask marks hard-cap dependency repair follow-up metadata', () => {
  const task = createTask({
    declaredWriteSurface: ['apps/api'],
    declaredConflictDomains: ['api-contracts'],
    integrationLane: 'api-repairs',
    failedBlockerRecoveryDemandTaskIds: ['blocked-child'],
    oraclePacket: {
      guidanceMode: 'candidate_only',
      summary: 'Check the failing API route first.',
    },
  });

  const generated = buildFollowupPrdForTask({
    task,
    reason: 'story_repair_hard_cap_reached',
    failure: {
      id: 'failure:hard-cap',
      observedAt: 1,
      kind: 'quality_gate',
      signature: 'hard-cap-signature',
      gate: 'test',
      packageLabel: 'apps/api',
      command: 'npm test -- --scope apps/api',
      rawMessage: 'test failed',
      failedFiles: ['apps/api/service.ts'],
    },
    recommendedStories: ['Repair the hard-cap blocker'],
    scope: ['apps/api/routes.ts'],
  });

  assert.equal(generated.signature, 'hard-cap-signature');
  assert.equal(generated.prd.id, 'followup:source-prd:80a07c53bb8cd90d');
  assert.equal(generated.prd.priorityClass, 'dependency_repair');
  assert.deepEqual(generated.prd.repairOf, {
    prdId: 'source-prd',
    taskId: 'source-task',
    reason: 'story_repair_hard_cap_reached',
  });
  assert.deepEqual(generated.prd.releasesDependenciesFor, ['source-prd']);
  assert.deepEqual(generated.prd.schedulerHints, {
    priorityClass: 'dependency_repair',
    effectiveDependencyPrdId: 'source-prd',
    releasesDependenciesFor: ['source-prd'],
    repairTaskId: 'source-task',
    repairReason: 'story_repair_hard_cap_reached',
    demandTaskIds: ['blocked-child'],
    bypassPendingDownstreamOverlaps: true,
    doNotBypassRunningOverlaps: true,
    parkNonRepairPendingOverlaps: true,
    emitRepairStarvationIfBlockedForMs: 600000,
  });
  assert.deepEqual(generated.prd.conflictDomains, ['api-contracts']);
  assert.equal(generated.prd.integrationLane, 'api-repairs');
  assert.deepEqual(generated.prd.writeSurface, ['apps/api/routes.ts', 'apps/api/service.ts']);
  assert.match(generated.prd.description, /Original task id: source-task/);
  assert.match(generated.prd.description, /Original PRD id: source-prd/);
  assert.match(generated.prd.description, /Reason: story_repair_hard_cap_reached/);
  assert.match(generated.prd.description, /Original status: failed/);
  assert.match(generated.prd.description, /Failure signature: hard-cap-signature/);
  assert.match(generated.prd.description, /Gate: test/);
  assert.match(generated.prd.description, /Package: apps\/api/);
  assert.match(generated.prd.description, /Command: npm test -- --scope apps\/api/);
  assert.match(generated.prd.description, /candidate_only guidance/);
  assert.match(generated.prd.description, /separate baseline repair PRD/);
  assert.match(
    generated.prd.userStories[0].acceptanceCriteria.join('\n'),
    /separate baseline repair PRD instead of expanding this dependency repair surface/,
  );
});

test('buildFollowupPrdForTask marks failed-blocker hard-cap dependency repair follow-up metadata', () => {
  const task = createTask({
    declaredWriteSurface: ['apps/api'],
    declaredConflictDomains: ['api-blockers'],
    integrationLane: 'blocked-api-repairs',
    failedBlockerRecoveryDemandTaskIds: ['blocked-a', 'blocked-b'],
    storyRepairRecoveryDemandTaskIds: ['blocked-b', 'blocked-c'],
  });

  const generated = buildFollowupPrdForTask({
    task,
    reason: 'failed_blocker_recovery_hard_cap_reached',
    failure: {
      id: 'failure:blocker-hard-cap',
      observedAt: 1,
      kind: 'quality_gate',
      signature: 'blocker-signature',
      packageLabel: 'apps/api',
      rawMessage: 'blocked test failed',
      failedFiles: ['apps/api/src/server.ts'],
    },
    recommendedStories: ['Repair the failed blocker without broadening scope'],
  });

  assert.equal(generated.signature, 'blocker-signature');
  assert.equal(generated.prd.id, 'followup:source-prd:4911dd16d865281b');
  assert.equal(generated.prd.priorityClass, 'dependency_repair');
  assert.deepEqual(generated.prd.repairOf, {
    prdId: 'source-prd',
    taskId: 'source-task',
    reason: 'failed_blocker_recovery_hard_cap_reached',
  });
  assert.deepEqual(generated.prd.releasesDependenciesFor, ['source-prd']);
  assert.deepEqual(generated.prd.schedulerHints, {
    priorityClass: 'dependency_repair',
    effectiveDependencyPrdId: 'source-prd',
    releasesDependenciesFor: ['source-prd'],
    repairTaskId: 'source-task',
    repairReason: 'failed_blocker_recovery_hard_cap_reached',
    demandTaskIds: ['blocked-a', 'blocked-b', 'blocked-c'],
    bypassPendingDownstreamOverlaps: true,
    doNotBypassRunningOverlaps: true,
    parkNonRepairPendingOverlaps: true,
    emitRepairStarvationIfBlockedForMs: 600000,
  });
  assert.deepEqual(generated.prd.conflictDomains, ['api-blockers']);
  assert.equal(generated.prd.integrationLane, 'blocked-api-repairs');
  assert.deepEqual(generated.prd.writeSurface, ['apps/api/src/server.ts']);
  assert.match(generated.prd.description, /Demand task ids: blocked-a, blocked-b, blocked-c/);
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
      storyRepairRecoveryStopReason: 'story_repair_hard_cap_reached',
      declaredWriteSurface: ['apps/web/src/app.ts'],
      declaredConflictDomains: ['apps-web'],
      integrationLane: 'story-repair',
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
    assert.equal(updatedSource.followupReason, 'story_repair_hard_cap_reached');
    const followupTask = await stateManager.loadTask(updatedSource.followupTaskIds[0]);
    assert.equal(followupTask.prdId, updatedSource.followupPrdIds[0]);
    assert.equal(followupTask.priorityClass, 'dependency_repair');
    assert.deepEqual(followupTask.repairOf, {
      prdId: 'source-prd',
      taskId: 'source-task',
      reason: 'story_repair_hard_cap_reached',
    });
    assert.deepEqual(followupTask.releasesDependenciesFor, ['source-prd']);
    assert.equal(followupTask.effectiveDependencyPrdId, 'source-prd');
    assert.deepEqual(followupTask.schedulerHints, {
      priorityClass: 'dependency_repair',
      effectiveDependencyPrdId: 'source-prd',
      releasesDependenciesFor: ['source-prd'],
      repairTaskId: 'source-task',
      repairReason: 'story_repair_hard_cap_reached',
      demandTaskIds: [],
      bypassPendingDownstreamOverlaps: true,
      doNotBypassRunningOverlaps: true,
      parkNonRepairPendingOverlaps: true,
      emitRepairStarvationIfBlockedForMs: 600000,
    });
    assert.deepEqual(followupTask.declaredConflictDomains, ['apps-web']);
    assert.deepEqual(followupTask.declaredWriteSurface, ['apps/web/src/app.ts']);
    assert.equal(followupTask.integrationLane, 'story-repair');
    const generatedPrd = JSON.parse(fs.readFileSync(followupTask.prdPath, 'utf8'));
    assert.deepEqual(generatedPrd.repairOf, followupTask.repairOf);
    assert.deepEqual(generatedPrd.schedulerHints, followupTask.schedulerHints);
    assert.deepEqual(generatedPrd.releasesDependenciesFor, ['source-prd']);
    assert.deepEqual(generatedPrd.conflictDomains, ['apps-web']);
    assert.equal(generatedPrd.integrationLane, 'story-repair');
    assert.deepEqual(generatedPrd.writeSurface, ['apps/web/src/app.ts']);
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
