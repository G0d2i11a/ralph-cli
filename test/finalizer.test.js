const test = require('node:test');
const assert = require('node:assert/strict');

const { DependencyWatcher } = require('../dist/core/dependency-watcher.js');
const {
  classifyQualityGateFailure,
  QualityGateFailure,
} = require('../dist/core/finalize-failure-classifier.js');

class FakeStateManager {
  constructor(tasks = []) {
    this.tasks = new Map(tasks.map((task) => [task.id, { ...task }]));
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
    if (!task) throw new Error(`Task ${taskId} not found`);
    this.tasks.set(taskId, { ...task, ...updates });
  }
}

function createConfigManager(overrides = {}) {
  const values = {
    'runner.pollInterval': 10,
    'ingestion.ez4ielts.enabled': false,
    'autoMerge': false,
    'autoMergeDelay': 0,
    'merge.autoIntegrate': false,
    'merge.targetBranch': 'main',
    'merge.strategy': 'manual',
    'merge.pullLatest': true,
    'finalizer.repairPolicy': 'progress',
    'finalizer.maxRepairAttempts': 1,
    'finalizer.maxNoProgressRepairRounds': 2,
    'finalizer.repairDeadlineSeconds': 7200,
    'finalizer.repairHardCap': 20,
    ...overrides,
  };

  return {
    get(key) {
      return values[key];
    },
  };
}

test('dependency watcher finalizes ready_to_finalize tasks before scheduling pending work', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'finalize-me',
      prdPath: '/tmp/prd.json',
      status: 'ready_to_finalize',
      startTime: 100,
      completedUS: ['US-001'],
      worktree: '/repo/.ralph-worktrees/finalize-me',
      logPath: '/tmp/finalize.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
    },
  ]);

  const started = [];
  const logs = [];
  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager(),
      scheduler: {
        schedulePendingTasks: async () => {
          started.push('scheduled');
          return [];
        },
      },
      sleep: async () => undefined,
      logger: {
        log: (msg) => logs.push(String(msg)),
        error: (msg) => logs.push(`ERR:${String(msg)}`),
      },
      finalizer: () => ({
        success: true,
        committed: true,
        message: 'Committed task changes successfully',
        commitMessage: 'feat: finalize test',
      }),
    }
  );

  watcher.stop = () => {
    watcher.isRunning = false;
  };

  const finalizeReadyTasks = watcher.finalizeReadyTasks?.bind(watcher);
  assert.ok(finalizeReadyTasks, 'finalizeReadyTasks should exist');
  await finalizeReadyTasks();
  await watcher.checkPendingTasks();

  const finalizedTask = stateManager.tasks.get('finalize-me');
  assert.equal(finalizedTask.status, 'completed');
  assert.equal(finalizedTask.finalizerCommitMessage, 'feat: finalize test');
  assert.equal(finalizedTask.mergedAt, undefined);
  assert.equal(started.length, 1);
});

test('dependency watcher refuses to finalize tasks with incomplete stories', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'incomplete-finalize',
      prdPath: '/tmp/prd.json',
      status: 'ready_to_finalize',
      startTime: 100,
      completedUS: ['US-002', 'US-003'],
      storyProgress: [
        { id: 'US-001', status: 'failed', attempts: 2, updatedAt: 1 },
        { id: 'US-002', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-003', status: 'passed', attempts: 1, updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/incomplete-finalize',
      logPath: '/tmp/incomplete-finalize.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
    },
  ]);

  let finalizerCalls = 0;
  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager(),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
      finalizer: () => {
        finalizerCalls += 1;
        return {
          success: true,
          committed: true,
          message: 'Committed task changes successfully',
          commitMessage: 'feat: should not run',
        };
      },
    }
  );

  await watcher.finalizeReadyTasks();

  const task = stateManager.tasks.get('incomplete-finalize');
  assert.equal(task.status, 'failed');
  assert.equal(task.integrationStatus, 'failed');
  assert.equal(task.lastErrorKind, 'story_incomplete');
  assert.match(task.lastError, /cannot finalize/);
  assert.match(task.lastError, /US-001:failed:2/);
  assert.equal(finalizerCalls, 0);
});

test('dependency watcher auto-integrates finalized tasks when enabled', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'auto-merge-me',
      prdPath: '/tmp/prd.json',
      status: 'ready_to_finalize',
      startTime: 100,
      completedUS: ['US-001'],
      worktree: '/repo/.ralph-worktrees/auto-merge-me',
      logPath: '/tmp/auto-merge.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager({
        'merge.autoIntegrate': true,
        'merge.targetBranch': 'main',
        'merge.strategy': 'manual',
        'merge.pullLatest': false,
      }),
      sleep: async () => undefined,
      logger: console,
      finalizer: () => ({
        success: true,
        committed: true,
        message: 'Committed task changes successfully',
        commitMessage: 'feat: finalize test',
      }),
      mergeTask: async (_task, targetBranch, strategy, options) => {
        assert.equal(targetBranch, 'main');
        assert.equal(strategy, 'manual');
        assert.equal(options.pullLatest, false);
        return {
          success: true,
          hasConflicts: false,
          message: 'Merged into main',
          commitSha: 'abc123',
        };
      },
    }
  );

  await watcher.finalizeReadyTasks();

  const finalizedTask = stateManager.tasks.get('auto-merge-me');
  assert.equal(finalizedTask.status, 'completed');
  assert.equal(finalizedTask.finalizerCommitMessage, 'feat: finalize test');
  assert.equal(finalizedTask.mergeTargetBranch, 'main');
  assert.equal(finalizedTask.mergeStrategy, 'manual');
  assert.equal(finalizedTask.mergeCommitSha, 'abc123');
  assert.equal(finalizedTask.mergeMessage, 'Merged into main');
  assert.ok(typeof finalizedTask.mergedAt === 'number');
});

test('dependency watcher preserves finalizer success when unattended integration policy is unsafe', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'unsafe-auto-merge',
      prdPath: '/tmp/prd.json',
      status: 'ready_to_finalize',
      startTime: 100,
      completedUS: ['US-001'],
      worktree: '/repo/.ralph-worktrees/unsafe-auto-merge',
      logPath: '/tmp/unsafe-auto-merge.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
    },
  ]);
  let mergeCalled = false;

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager({
        'merge.autoIntegrate': true,
        'merge.strategy': 'theirs',
      }),
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
      finalizer: () => ({
        success: true,
        committed: true,
        message: 'Committed task changes successfully',
        commitMessage: 'feat: finalize test',
      }),
      mergeTask: async () => {
        mergeCalled = true;
        throw new Error('should not merge');
      },
    }
  );

  await watcher.finalizeReadyTasks();

  const task = stateManager.tasks.get('unsafe-auto-merge');
  assert.equal(mergeCalled, false);
  assert.equal(task.status, 'completed');
  assert.equal(task.integrationStatus, 'failed');
  assert.match(task.mergeError, /Unattended autoMerge with 'theirs' is disabled/);
});

test('dependency watcher keeps task completed when automatic integration hits conflicts', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'merge-conflict-task',
      prdPath: '/tmp/prd.json',
      status: 'ready_to_finalize',
      startTime: 100,
      completedUS: ['US-001'],
      worktree: '/repo/.ralph-worktrees/merge-conflict-task',
      logPath: '/tmp/merge-conflict.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager({
        'merge.autoIntegrate': true,
      }),
      sleep: async () => undefined,
      logger: console,
      finalizer: () => ({
        success: true,
        committed: true,
        message: 'Committed task changes successfully',
        commitMessage: 'feat: finalize test',
      }),
      mergeTask: async () => ({
        success: false,
        hasConflicts: true,
        message: 'Merge conflicts detected: src/app.ts',
        conflictFiles: ['src/app.ts'],
        integrationBranch: 'ralph/integration/main',
        integrationWorktree: '/repo/.ralph-integration/main',
      }),
    }
  );

  await watcher.finalizeReadyTasks();

  const finalizedTask = stateManager.tasks.get('merge-conflict-task');
  assert.equal(finalizedTask.status, 'completed');
  assert.equal(finalizedTask.integrationStatus, 'blocked_conflict');
  assert.equal(finalizedTask.finalizerCommitMessage, 'feat: finalize test');
  assert.match(finalizedTask.mergeError, /Merge conflicts detected/);
  assert.deepEqual(finalizedTask.mergeConflictFiles, ['src/app.ts']);
  assert.equal(finalizedTask.integrationBranch, 'ralph/integration/main');
  assert.ok(typeof finalizedTask.mergeConflictAt === 'number');
});

test('dependency watcher fails finalization when post-finalize merge probe still reports conflicts', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'post-finalize-probe-task',
      prdPath: '/tmp/prd.json',
      status: 'ready_to_finalize',
      startTime: 100,
      completedUS: ['US-001'],
      worktree: '/repo/.ralph-worktrees/post-finalize-probe-task',
      logPath: '/tmp/post-finalize-probe.log',
      agent: 'codex',
      repoPath: '/repo',
      repairContext: {
        mode: 'merge',
        storyId: 'US-001',
        createdAt: Date.now(),
        reason: 'Merge repair required by Ralph.',
      },
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager(),
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
      finalizer: () => ({
        success: true,
        committed: true,
        message: 'Committed task changes successfully',
        commitMessage: 'feat: finalize test',
        commitSha: 'abc123',
      }),
      probeWorktreeMergeability: async () => ({
        mergeable: false,
        alreadyIntegrated: false,
        message: 'Merge conflicts detected: docs/TODO.md',
        conflictFiles: ['docs/TODO.md'],
        integrationBranch: 'ralph/integration/main',
        integrationWorktree: '/repo/.ralph-integration/main',
      }),
    }
  );

  await watcher.finalizeReadyTasks();

  const task = stateManager.tasks.get('post-finalize-probe-task');
  assert.equal(task.status, 'failed_finalize');
  assert.equal(task.finalizerCommitMessage, 'feat: finalize test');
  assert.equal(task.finalizerCommitSha, 'abc123');
  assert.match(task.mergeError, /Merge conflicts detected/);
  assert.deepEqual(task.mergeConflictFiles, ['docs/TODO.md']);
  assert.equal(task.repairContext?.mode, 'merge');
});

test('dependency watcher integrates completed backlog before later overlapping finalization', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'completed-blocker',
      prdPath: '/tmp/a.json',
      status: 'completed',
      startTime: 100,
      completedUS: ['US-001'],
      worktree: '/repo/.ralph-worktrees/completed-blocker',
      logPath: '/tmp/completed-blocker.log',
      agent: 'codex',
      repoPath: '/repo',
      observedWriteSurface: ['apps/api/src/a.ts'],
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
    },
    {
      id: 'ready-overlap',
      prdPath: '/tmp/b.json',
      status: 'ready_to_finalize',
      startTime: 200,
      completedUS: ['US-001'],
      worktree: '/repo/.ralph-worktrees/ready-overlap',
      logPath: '/tmp/ready-overlap.log',
      agent: 'codex',
      repoPath: '/repo',
      observedWriteSurface: ['apps/api/src/a.ts'],
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 200,
      lastFilesChanged: 1,
    },
  ]);
  const mergeCalls = [];

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager({
        'merge.autoIntegrate': true,
      }),
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
      mergeTask: async (task) => {
        mergeCalls.push(task.id);
        return {
          success: true,
          hasConflicts: false,
          message: `Integrated ${task.id}`,
          commitSha: `${task.id}-sha`,
          integrationBranch: 'ralph/integration/main',
          integrationWorktree: '/repo/.ralph-integration/main',
        };
      },
      finalizer: () => ({
        success: true,
        committed: true,
        message: 'Committed task changes successfully',
        commitMessage: 'feat: finalize test',
      }),
    }
  );

  await watcher.integrateCompletedTasks();
  await watcher.finalizeReadyTasks();

  const blocker = stateManager.tasks.get('completed-blocker');
  const readyTask = stateManager.tasks.get('ready-overlap');
  assert.equal(blocker.integrationStatus, 'integrated');
  assert.equal(readyTask.status, 'completed');
  assert.deepEqual(mergeCalls, ['completed-blocker', 'ready-overlap']);
});

test('dependency watcher stores structured finalizer failure details for quality gate errors', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'quality-gate-failure-task',
      prdPath: '/tmp/prd.json',
      status: 'ready_to_finalize',
      startTime: 100,
      completedUS: ['US-001'],
      worktree: '/repo/.ralph-worktrees/quality-gate-failure-task',
      logPath: '/tmp/quality-gate-failure.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager(),
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
      finalizer: () => {
        throw new QualityGateFailure(classifyQualityGateFailure({
          requestedScript: 'typecheck',
          actualScript: 'typecheck',
          cwd: '/repo/apps/api',
          packageLabel: 'apps/api',
          command: 'pnpm run typecheck',
          rawMessage: 'Quality gate "typecheck" failed: src/service.ts(12,5): error TS2353: Object literal may only specify known properties, and \'sourceType\' does not exist in type \'SpeakingPersonaWhereInput\'.',
          stderr: 'src/service.ts(12,5): error TS2353: Object literal may only specify known properties, and \'sourceType\' does not exist in type \'SpeakingPersonaWhereInput\'.',
          exitCode: 2,
        }));
      },
    }
  );

  await watcher.finalizeReadyTasks();

  const task = stateManager.tasks.get('quality-gate-failure-task');
  assert.equal(task.status, 'failed_finalize');
  assert.equal(task.lastErrorClass, 'quality_gate');
  assert.equal(task.lastErrorKind, 'quality_gate_failure');
  assert.equal(task.finalizerFailure.class, 'generated_type_drift');
  assert.equal(task.finalizerFailure.gate, 'typecheck');
  assert.equal(task.finalizerFailure.packageLabel, 'apps/api');
  assert.equal(task.finalizerFailure.diagnosticCount, 1);
  assert.deepEqual(task.finalizerFailure.failedSymbols, ['sourceType']);
});

test('dependency watcher routes failed_finalize tasks back to pending repair once', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'repair-finalize-task',
      prdPath: '/tmp/prd.json',
      status: 'failed_finalize',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        {
          id: 'US-001',
          status: 'passed',
          attempts: 1,
          updatedAt: 100,
        },
      ],
      worktree: '/repo/.ralph-worktrees/repair-finalize-task',
      logPath: '/tmp/repair-finalize.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      finalizerAttempts: 1,
      lastError: 'Quality gate "test" failed',
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager({
        'finalizer.maxRepairAttempts': 1,
      }),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
    }
  );

  await watcher.recoverFailedFinalizeTasks();

  const task = stateManager.tasks.get('repair-finalize-task');
  assert.equal(task.status, 'pending');
  assert.deepEqual(task.completedUS, []);
  assert.equal(task.storyProgress[0].status, 'needs_repair');
  assert.match(task.storyProgress[0].lastError, /Quality gate/);
  assert.deepEqual(task.repairContext, {
    mode: 'finalize',
    storyId: 'US-001',
    createdAt: task.repairContext.createdAt,
    reason: 'Quality gate "test" failed',
  });
  assert.equal(typeof task.finalizeRepairStartedAt, 'number');
  assert.equal(typeof task.finalizeRepairDeadlineAt, 'number');
  assert.equal(typeof task.finalizeRepairLastFailureSnapshot?.capturedAt, 'number');
  assert.equal(task.finalizeRepairTotalRequeues, 1);
});

test('dependency watcher routes merge conflicts through merge repair context', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'merge-repair-task',
      prdPath: '/tmp/prd.json',
      status: 'failed_finalize',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        {
          id: 'US-001',
          status: 'passed',
          attempts: 1,
          updatedAt: 100,
        },
      ],
      worktree: '/repo/.ralph-worktrees/merge-repair-task',
      logPath: '/tmp/merge-repair.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      finalizerAttempts: 1,
      mergeError: 'Merge conflicts detected: src/app.ts',
      mergeConflictFiles: ['src/app.ts'],
      integrationBranch: 'ralph/integration/main',
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager({
        'finalizer.maxRepairAttempts': 1,
      }),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
    }
  );

  await watcher.recoverFailedFinalizeTasks();

  const task = stateManager.tasks.get('merge-repair-task');
  assert.equal(task.status, 'pending');
  assert.deepEqual(task.completedUS, []);
  assert.equal(task.storyProgress[0].status, 'needs_repair');
  assert.equal(task.storyProgress[0].attempts, 0);
  assert.match(task.storyProgress[0].lastError, /Merge repair required/);
  assert.match(task.storyProgress[0].lastError, /src\/app\.ts/);
  assert.equal(task.mergeRepairAttempts, 1);
  assert.equal(task.repairContext.mode, 'merge');
  assert.equal(task.repairContext.storyId, 'US-001');
});

test('dependency watcher restores already integrated merge conflicts to ready_to_finalize', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'already-integrated-task',
      prdPath: '/tmp/prd.json',
      status: 'failed_finalize',
      startTime: 100,
      completedUS: [],
      storyProgress: [
        {
          id: 'US-001',
          status: 'needs_repair',
          attempts: 1,
          lastError: 'Merge repair required by Ralph.',
          updatedAt: 100,
        },
      ],
      worktree: '/repo/.ralph-worktrees/already-integrated-task',
      logPath: '/tmp/already-integrated.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      finalizerAttempts: 2,
      mergeRepairAttempts: 1,
      mergeError: 'Merge conflicts detected: src/app.ts',
      mergeConflictFiles: ['src/app.ts'],
      integrationBranch: 'ralph/integration/main',
      finalizeRepairStoppedAt: 123,
      finalizeRepairStopReason: 'repair_no_progress',
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager({
        'finalizer.maxRepairAttempts': 1,
      }),
      detectAlreadyIntegratedTask: () => true,
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
    }
  );

  await watcher.recoverFailedFinalizeTasks();

  const task = stateManager.tasks.get('already-integrated-task');
  assert.equal(task.status, 'ready_to_finalize');
  assert.deepEqual(task.completedUS, ['US-001']);
  assert.equal(task.storyProgress[0].status, 'passed');
  assert.equal(task.storyProgress[0].lastError, undefined);
  assert.equal(task.mergeError, undefined);
  assert.equal(task.mergeConflictFiles, undefined);
  assert.equal(task.repairContext, undefined);
  assert.equal(task.finalizeRepairStoppedAt, undefined);
  assert.equal(task.finalizeRepairStopReason, undefined);
});

test('dependency watcher restores mergeable failed_finalize tasks via exact mergeability probe', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'probe-recovered-task',
      prdPath: '/tmp/prd.json',
      status: 'failed_finalize',
      startTime: 100,
      completedUS: [],
      storyProgress: [
        {
          id: 'US-001',
          status: 'needs_repair',
          attempts: 1,
          lastError: 'Merge repair required by Ralph.',
          updatedAt: 100,
        },
      ],
      worktree: '/repo/.ralph-worktrees/probe-recovered-task',
      logPath: '/tmp/probe-recovered.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      finalizerAttempts: 3,
      mergeRepairAttempts: 2,
      mergeError: 'Merge conflicts detected: src/app.ts',
      mergeConflictFiles: ['src/app.ts'],
      integrationBranch: 'ralph/integration/main',
      finalizeRepairStoppedAt: 123,
      finalizeRepairStopReason: 'repair_no_progress',
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager({
        'finalizer.maxRepairAttempts': 1,
      }),
      probeWorktreeMergeability: async () => ({
        mergeable: true,
        alreadyIntegrated: false,
        message: 'ralph/task-probe can merge cleanly into ralph/integration/main',
        integrationBranch: 'ralph/integration/main',
        integrationWorktree: '/repo/.ralph-integration/main',
        sourceKind: 'worktree_snapshot',
        worktreeMergeState: {
          kind: 'none',
          usesGitLocal: false,
          gitDir: '/repo/.git/worktrees/probe-recovered-task',
          headSha: 'abc123',
          mergeParents: [],
          unmergedFiles: [],
          changedFiles: ['src/app.ts'],
          statusPorcelain: 'M src/app.ts',
          statusSignature: 'probe-recovered',
        },
      }),
      detectAlreadyIntegratedTask: () => false,
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
    }
  );

  await watcher.recoverFailedFinalizeTasks();

  const task = stateManager.tasks.get('probe-recovered-task');
  assert.equal(task.status, 'ready_to_finalize');
  assert.deepEqual(task.completedUS, ['US-001']);
  assert.equal(task.storyProgress[0].status, 'passed');
  assert.equal(task.mergeError, undefined);
  assert.equal(task.mergeConflictFiles, undefined);
  assert.equal(task.repairContext, undefined);
  assert.equal(task.finalizeRepairStoppedAt, undefined);
  assert.equal(task.finalizeRepairStopReason, undefined);
});

test('dependency watcher requeues unrun merge repair without consuming another repair attempt', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'unrun-merge-repair-task',
      prdPath: '/tmp/prd.json',
      status: 'failed_finalize',
      startTime: 100,
      completedUS: ['US-000'],
      storyProgress: [
        {
          id: 'US-000',
          status: 'passed',
          attempts: 1,
          updatedAt: 50,
        },
        {
          id: 'US-001',
          status: 'needs_repair',
          attempts: 2,
          lastError: 'Merge repair required by Ralph.',
          updatedAt: 100,
        },
      ],
      worktree: '/repo/.ralph-worktrees/unrun-merge-repair-task',
      logPath: '/tmp/unrun-merge-repair.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      finalizerAttempts: 2,
      mergeRepairAttempts: 1,
      mergeError: 'Merge conflicts detected: src/app.ts',
      mergeConflictFiles: ['src/app.ts'],
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager({
        'finalizer.maxRepairAttempts': 1,
      }),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
    }
  );

  await watcher.recoverFailedFinalizeTasks();

  const task = stateManager.tasks.get('unrun-merge-repair-task');
  assert.equal(task.status, 'pending');
  assert.deepEqual(task.completedUS, ['US-000']);
  assert.equal(task.storyProgress[0].status, 'passed');
  assert.equal(task.storyProgress[1].status, 'needs_repair');
  assert.equal(task.storyProgress[1].attempts, 0);
  assert.equal(task.mergeRepairAttempts, 1);
  assert.equal(task.repairContext.mode, 'merge');
  assert.equal(task.repairContext.storyId, 'US-001');
  assert.equal(task.finalizeRepairTotalRequeues, 1);
});

test('dependency watcher keeps progress-based finalize repair alive beyond legacy repair limits', async () => {
  const now = Date.now();
  const stateManager = new FakeStateManager([
    {
      id: 'progress-repair-task',
      prdPath: '/tmp/prd.json',
      status: 'failed_finalize',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        {
          id: 'US-001',
          status: 'passed',
          attempts: 1,
          updatedAt: 100,
        },
      ],
      worktree: '/repo/.ralph-worktrees/progress-repair-task',
      logPath: '/tmp/progress-repair.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      finalizerAttempts: 6,
      lastError: 'Quality gate "test" failed',
      finalizeRepairStartedAt: now - 1_000,
      finalizeRepairDeadlineAt: now + 60_000,
      finalizeRepairLastProgressReason: 'HEAD changed',
      finalizeRepairConsecutiveNoProgress: 0,
      finalizeRepairTotalRequeues: 5,
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager({
        'finalizer.repairPolicy': 'progress',
        'finalizer.maxRepairAttempts': 1,
      }),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
    }
  );

  await watcher.recoverFailedFinalizeTasks();

  const task = stateManager.tasks.get('progress-repair-task');
  assert.equal(task.status, 'pending');
  assert.deepEqual(task.completedUS, []);
  assert.equal(task.storyProgress[0].status, 'needs_repair');
  assert.equal(task.repairContext.mode, 'finalize');
  assert.equal(task.repairContext.storyId, 'US-001');
  assert.equal(task.finalizeRepairTotalRequeues, 6);
});

test('dependency watcher stops progress-based finalize repair after repeated no-progress failures', async () => {
  const now = Date.now();
  const stateManager = new FakeStateManager([
    {
      id: 'stalled-repair-task',
      prdPath: '/tmp/prd.json',
      status: 'failed_finalize',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        {
          id: 'US-001',
          status: 'passed',
          attempts: 1,
          updatedAt: 100,
        },
      ],
      worktree: '/repo/.ralph-worktrees/stalled-repair-task',
      logPath: '/tmp/stalled-repair.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      finalizerAttempts: 4,
      lastError: 'Quality gate "test" failed',
      finalizeRepairStartedAt: now - 1_000,
      finalizeRepairDeadlineAt: now + 60_000,
      finalizeRepairConsecutiveNoProgress: 2,
      finalizeRepairTotalRequeues: 2,
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager({
        'finalizer.repairPolicy': 'progress',
        'finalizer.maxNoProgressRepairRounds': 2,
      }),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
    }
  );

  await watcher.recoverFailedFinalizeTasks();

  const task = stateManager.tasks.get('stalled-repair-task');
  assert.equal(task.status, 'failed_finalize');
  assert.equal(typeof task.finalizeRepairStoppedAt, 'number');
  assert.equal(task.finalizeRepairStopReason, 'repair_no_progress');
});

test('dependency watcher stops progress-based finalize repair when deadline expires', async () => {
  const now = Date.now();
  const stateManager = new FakeStateManager([
    {
      id: 'deadline-repair-task',
      prdPath: '/tmp/prd.json',
      status: 'failed_finalize',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        {
          id: 'US-001',
          status: 'passed',
          attempts: 1,
          updatedAt: 100,
        },
      ],
      worktree: '/repo/.ralph-worktrees/deadline-repair-task',
      logPath: '/tmp/deadline-repair.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      finalizerAttempts: 2,
      lastError: 'Quality gate "test" failed',
      finalizeRepairStartedAt: now - 120_000,
      finalizeRepairDeadlineAt: now - 1,
      finalizeRepairConsecutiveNoProgress: 0,
      finalizeRepairTotalRequeues: 1,
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager({
        'finalizer.repairPolicy': 'progress',
      }),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
    }
  );

  await watcher.recoverFailedFinalizeTasks();

  const task = stateManager.tasks.get('deadline-repair-task');
  assert.equal(task.status, 'failed_finalize');
  assert.equal(task.finalizeRepairStopReason, 'repair_deadline_exhausted');
});

test('dependency watcher stops progress-based finalize repair when hard cap is reached', async () => {
  const now = Date.now();
  const stateManager = new FakeStateManager([
    {
      id: 'hard-cap-repair-task',
      prdPath: '/tmp/prd.json',
      status: 'failed_finalize',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        {
          id: 'US-001',
          status: 'passed',
          attempts: 1,
          updatedAt: 100,
        },
      ],
      worktree: '/repo/.ralph-worktrees/hard-cap-repair-task',
      logPath: '/tmp/hard-cap-repair.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      finalizerAttempts: 2,
      lastError: 'Quality gate "test" failed',
      finalizeRepairStartedAt: now - 1_000,
      finalizeRepairDeadlineAt: now + 60_000,
      finalizeRepairConsecutiveNoProgress: 0,
      finalizeRepairTotalRequeues: 3,
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager({
        'finalizer.repairPolicy': 'progress',
        'finalizer.repairHardCap': 3,
      }),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
    }
  );

  await watcher.recoverFailedFinalizeTasks();

  const task = stateManager.tasks.get('hard-cap-repair-task');
  assert.equal(task.status, 'failed_finalize');
  assert.equal(task.finalizeRepairStopReason, 'repair_hard_cap_reached');
});

test('dependency watcher records stop reason for fixed-policy finalize repair exhaustion', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'fixed-limit-repair-task',
      prdPath: '/tmp/prd.json',
      status: 'failed_finalize',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        {
          id: 'US-001',
          status: 'passed',
          attempts: 1,
          updatedAt: 100,
        },
      ],
      worktree: '/repo/.ralph-worktrees/fixed-limit-repair-task',
      logPath: '/tmp/fixed-limit-repair.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      finalizerAttempts: 2,
      lastError: 'Quality gate "test" failed',
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager({
        'finalizer.repairPolicy': 'fixed',
        'finalizer.maxRepairAttempts': 1,
      }),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
    }
  );

  await watcher.recoverFailedFinalizeTasks();

  const task = stateManager.tasks.get('fixed-limit-repair-task');
  assert.equal(task.status, 'failed_finalize');
  assert.equal(task.finalizeRepairStopReason, 'repair_limit_reached');
  assert.equal(typeof task.finalizeRepairStoppedAt, 'number');
});

test('dependency watcher automatically requeues completed blocked_conflict tasks into merge repair', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'completed-blocked-conflict-task',
      prdPath: '/tmp/prd.json',
      status: 'completed',
      startTime: 100,
      completedUS: ['US-001', 'US-002'],
      storyProgress: [
        {
          id: 'US-001',
          status: 'passed',
          attempts: 1,
          updatedAt: 50,
        },
        {
          id: 'US-002',
          status: 'in_progress',
          attempts: 2,
          updatedAt: 100,
        },
      ],
      worktree: '/repo/.ralph-worktrees/completed-blocked-conflict-task',
      logPath: '/tmp/completed-blocked-conflict.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 3,
      consecutiveNoProgress: 1,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 2,
      finalizerCommitSha: 'abc123',
      finalizerCommitMessage: 'feat: finalized task',
      finalizerCommittedAt: 110,
      finalizerAttempts: 2,
      integrationStatus: 'blocked_conflict',
      integrationBranch: 'ralph/integration/main',
      integrationWorktree: '/repo/.ralph-integration/main',
      mergeTargetBranch: 'main',
      mergeStrategy: 'manual',
      mergeError: 'Merge conflicts detected: src/app.ts',
      mergeConflictFiles: ['src/app.ts'],
      mergeConflictAt: 120,
      mergeRepairAttempts: 4,
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager(),
      probeMergeability: async () => ({
        mergeable: false,
        alreadyIntegrated: false,
        hasConflicts: true,
        conflictFiles: ['src/app.ts'],
        message: 'Merge conflicts detected: src/app.ts',
        sourceBranch: 'ralph/completed-blocked-conflict-task',
        targetBranch: 'main',
        integrationBranch: 'ralph/integration/main',
        integrationWorktree: '/repo/.ralph-integration/main',
      }),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
    }
  );

  await watcher.recoverCompletedConflictTasks();

  const task = stateManager.tasks.get('completed-blocked-conflict-task');
  assert.equal(task.status, 'pending');
  assert.deepEqual(task.completedUS, ['US-001']);
  assert.equal(task.storyProgress[1].status, 'pending');
  assert.equal(task.storyProgress[1].attempts, 0);
  assert.match(task.storyProgress[1].lastError, /Merge repair required by Ralph/);
  assert.equal(task.repairContext.mode, 'merge');
  assert.equal(task.repairContext.storyId, 'US-002');
  assert.equal(task.finalizerCommitSha, undefined);
  assert.equal(task.finalizerCommitMessage, undefined);
  assert.equal(task.integrationStatus, 'not_started');
  assert.equal(task.mergeError, undefined);
  assert.equal(task.mergeConflictFiles, undefined);
  assert.equal(task.mergeRepairAttempts, 0);
});

test('dependency watcher clears completed blocked_conflict tasks when exact mergeability probe passes', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'completed-probe-recovered-task',
      prdPath: '/tmp/prd.json',
      status: 'completed',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        {
          id: 'US-001',
          status: 'passed',
          attempts: 1,
          updatedAt: 100,
        },
      ],
      worktree: '/repo/.ralph-worktrees/completed-probe-recovered-task',
      logPath: '/tmp/completed-probe-recovered.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      finalizerCommitSha: 'abc123',
      finalizerCommitMessage: 'feat: finalized task',
      finalizerCommittedAt: 110,
      finalizerAttempts: 1,
      integrationStatus: 'blocked_conflict',
      integrationBranch: 'ralph/integration/main',
      integrationWorktree: '/repo/.ralph-integration/main',
      mergeTargetBranch: 'main',
      mergeStrategy: 'manual',
      mergeError: 'Merge conflicts detected: src/app.ts',
      mergeConflictFiles: ['src/app.ts'],
      mergeConflictAt: 120,
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager(),
      probeWorktreeMergeability: async () => ({
        mergeable: true,
        alreadyIntegrated: false,
        hasConflicts: false,
        conflictFiles: [],
        message: 'ralph/completed-probe-recovered-task can merge cleanly into ralph/integration/main',
        sourceBranch: 'ralph/completed-probe-recovered-task',
        targetBranch: 'main',
        integrationBranch: 'ralph/integration/main',
        integrationWorktree: '/repo/.ralph-integration/main',
        sourceKind: 'branch_head',
        worktreeMergeState: {
          kind: 'none',
          usesGitLocal: false,
          gitDir: '/repo/.git/worktrees/completed-probe-recovered-task',
          headSha: 'abc123',
          mergeParents: [],
          unmergedFiles: [],
          changedFiles: ['src/app.ts'],
          statusPorcelain: 'M src/app.ts',
          statusSignature: 'completed-probe-recovered',
        },
      }),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
    }
  );

  await watcher.recoverCompletedConflictTasks();

  const task = stateManager.tasks.get('completed-probe-recovered-task');
  assert.equal(task.status, 'completed');
  assert.deepEqual(task.completedUS, ['US-001']);
  assert.equal(task.integrationStatus, 'not_started');
  assert.equal(task.mergeError, undefined);
  assert.equal(task.mergeConflictFiles, undefined);
  assert.equal(task.finalizerCommitSha, 'abc123');
  assert.equal(task.finalizerCommitMessage, 'feat: finalized task');
});

test('dependency watcher refuses to integrate completed tasks with incomplete stories', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'completed-incomplete-task',
      prdPath: '/tmp/prd.json',
      status: 'completed',
      startTime: 100,
      completedUS: ['US-002', 'US-003'],
      storyProgress: [
        { id: 'US-001', status: 'pending', attempts: 2, updatedAt: 1 },
        { id: 'US-002', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-003', status: 'passed', attempts: 1, updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/completed-incomplete-task',
      logPath: '/tmp/completed-incomplete-task.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      integrationStatus: 'not_started',
    },
  ]);
  const mergeCalls = [];

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager({
        'merge.autoIntegrate': true,
      }),
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
      mergeTask: async (task) => {
        mergeCalls.push(task.id);
        return {
          success: true,
          hasConflicts: false,
          message: `Integrated ${task.id}`,
          commitSha: `${task.id}-sha`,
          integrationBranch: 'ralph/integration/main',
          integrationWorktree: '/repo/.ralph-integration/main',
        };
      },
    },
  );

  await watcher.integrateCompletedTasks();

  const task = stateManager.tasks.get('completed-incomplete-task');
  assert.equal(task.status, 'completed');
  assert.equal(task.integrationStatus, 'failed');
  assert.match(task.mergeError, /cannot integrate/);
  assert.deepEqual(mergeCalls, []);
});

test('dependency watcher invalidates historical completed tasks with incomplete stories', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'historical-bad-completed',
      prdPath: '/tmp/prd.json',
      status: 'completed',
      startTime: 100,
      completedUS: ['US-002', 'US-003'],
      storyProgress: [
        { id: 'US-001', status: 'failed', attempts: 2, updatedAt: 1 },
        { id: 'US-002', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-003', status: 'passed', attempts: 1, updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/historical-bad-completed',
      logPath: '/tmp/historical-bad-completed.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      integrationStatus: 'integrated',
      integratedAt: 200,
      mergedAt: 200,
      integrationCommitSha: 'bad-sha',
      mergeCommitSha: 'bad-sha',
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager(),
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
    },
  );

  await watcher.auditStoryCompletionInvariants();

  const task = stateManager.tasks.get('historical-bad-completed');
  assert.equal(task.status, 'failed');
  assert.equal(task.integrationStatus, 'failed');
  assert.equal(task.integratedAt, undefined);
  assert.equal(task.mergeCommitSha, undefined);
  assert.equal(task.lastErrorKind, 'story_incomplete');
  assert.match(task.lastError, /cannot integrate/);
});
