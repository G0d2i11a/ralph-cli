const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DependencyWatcher } = require('../dist/core/dependency-watcher.js');

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

function git(cwd, args) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function createConfigManager(overrides = {}) {
  const values = {
    'runner.pollInterval': 10,
    'runner.maxTransientRecoveryRequeues': 5,
    'runner.transientRecoveryBaseDelaySeconds': 1,
    'runner.transientRecoveryMaxDelaySeconds': 5,
    'runner.transientRecoveryDeadlineSeconds': 3600,
    'runner.maxTransientRecoverySameSignature': 3,
    'runner.transientRecoveryProgressAwareSameSignature': true,
    'runner.autoRecoveryHardCap': 20,
    'runner.autoRemediateFailedBlockers': true,
    'runner.maxFailedBlockerStoryRequeues': 1,
    'runner.failedBlockerRecoveryDeadlineSeconds': 3600,
    'runner.failedBlockerRecoveryHardCap': 2,
    'runner.autoRemediateStoryFailures': true,
    'runner.maxStoryRepairRequeues': 1,
    'runner.storyRepairRecoveryDeadlineSeconds': 3600,
    'runner.storyRepairRecoveryHardCap': 2,
    'runner.autoRemediateAgentContextFailures': true,
    'runner.maxAgentContextRecoveryRequeues': 1,
    'runner.agentContextRecoveryDeadlineSeconds': 3600,
    'runner.agentContextRecoveryHardCap': 2,
    'ingestion.ez4ielts.enabled': false,
    'autoMerge': false,
    'autoMergeDelay': 0,
    'merge.targetBranch': 'main',
    'merge.strategy': 'manual',
    'merge.pullLatest': true,
    'merge.integrationWorktreeDir': '.ralph-integration',
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

function queuedPendingState() {
  return {
    reason: 'queued',
    dependencies: [],
    blockers: [],
    maxConcurrent: 3,
    running: 0,
  };
}

function createFailedBlockerWatcher(stateManager, pendingStates, configOverrides = {}) {
  return new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager(configOverrides),
      scheduler: {
        describePendingTask: async (task) => pendingStates[task.id] || queuedPendingState(),
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
    }
  );
}

test('dependency watcher reopens baseline repair exhaustion for current failure reclassification', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-autonomy-baseline-'));
  const stateManager = new FakeStateManager([
    {
      id: 'baseline-exhausted-task',
      prdPath: path.join(tempDir, 'prd.json'),
      prdId: 'prd-visual-accessibility',
      status: 'failed_finalize',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 100 },
      ],
      worktree: path.join(tempDir, 'worktree'),
      logPath: path.join(tempDir, 'agent.log'),
      agent: 'codex',
      repoPath: path.join(tempDir, 'repo'),
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      lastErrorKind: 'baseline_quality_gate_failure',
      autoRecoveryKind: 'baseline_repair',
      autoRecoveryStoppedAt: 200,
      autoRecoveryStopReason: 'baseline_repair_exhausted',
      finalizeRepairStoppedAt: 200,
      finalizeRepairStopReason: 'baseline_quality_gate_failure',
      finalizerFailure: {
        failureKind: 'quality_gate',
        class: 'quality_gate_failure',
        gate: 'test',
        requestedGate: 'test',
        packageLabel: 'apps/web',
        cwd: path.join(tempDir, 'worktree/apps/web'),
        command: 'pnpm test',
        exitCode: 1,
        rawMessage: 'WritingChart tests failed',
      },
      baselineQualityGate: {
        kind: 'baseline_quality_gate_failure',
        observedAt: 100,
        targetBranch: 'main',
        gate: 'test',
        packageLabel: 'apps/web',
        signature: 'old-baseline-signature',
        latestFailureSignature: 'old-baseline-signature',
        taskFailureSignature: 'old-baseline-signature',
        repairGroupKey: 'baseline-quality-gate|main|package:apps/web',
        message: 'old baseline failure',
        phase: 'stopped',
        repairTaskId: 'baseline-repair-task',
        stoppedAt: 200,
        stopReason: 'baseline_repair_exhausted',
      },
      baselineRepair: {
        repairKey: 'old-baseline-signature',
        repairGroupKey: 'baseline-quality-gate|main|package:apps/web',
        targetBranch: 'main',
        gate: 'test',
        packageLabel: 'apps/web',
        demandTaskIds: ['baseline-exhausted-task'],
        repairTaskId: 'baseline-repair-task',
        startedAt: 100,
        updatedAt: 200,
        status: 'failed',
      },
    },
  ]);
  const watcher = createFailedBlockerWatcher(stateManager, {}, {
    'runner.autoRecoverBlockedTasks': true,
    'runner.autonomyRepairHardCap': 3,
  });

  await watcher.recoverBlockedAutonomyTasks();

  const task = stateManager.tasks.get('baseline-exhausted-task');
  assert.equal(task.status, 'failed_finalize');
  assert.equal(task.baselineQualityGate, undefined);
  assert.equal(task.baselineQualityGateHistory.length, 1);
  assert.equal(task.lastErrorKind, 'quality_gate_failure');
  assert.equal(task.autoRecoveryStoppedAt, undefined);
  assert.equal(task.finalizeRepairStoppedAt, undefined);
  assert.equal(task.autonomyRepairKind, 'baseline_exhaustion');
  assert.equal(task.autonomyRepairTotalRequeues, 1);
  assert.equal(task.baselineRepair.status, 'needs_more_repair');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('dependency watcher migrates superseded product baseline role back to ready finalization', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-autonomy-superseded-'));
  const stateManager = new FakeStateManager([
    {
      id: 'baseline-repair-task',
      prdPath: path.join(tempDir, 'baseline-repair.json'),
      prdId: 'baseline-quality-gate:abc123',
      status: 'completed',
      startTime: 50,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 80 },
      ],
      worktree: path.join(tempDir, 'baseline-worktree'),
      logPath: path.join(tempDir, 'baseline.log'),
      agent: 'codex',
      repoPath: path.join(tempDir, 'repo'),
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 80,
      lastFilesChanged: 1,
      integrationStatus: 'integrated',
      integratedAt: 120,
    },
    {
      id: 'product-task',
      prdPath: path.join(tempDir, 'product-prd.json'),
      prdId: 'prd-review-center',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 100 },
      ],
      worktree: path.join(tempDir, 'product-worktree'),
      logPath: path.join(tempDir, 'product.log'),
      agent: 'codex',
      repoPath: path.join(tempDir, 'repo'),
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      lastErrorKind: 'baseline_repair_superseded',
      lastError: 'Superseded by canonical baseline repair task baseline-repair-task',
      autoRecoveryStoppedAt: 200,
      autoRecoveryStopReason: 'baseline_repair_superseded',
      baselineRepair: {
        repairKey: 'baseline-quality-gate|main|test|apps/web',
        repairGroupKey: 'baseline-quality-gate|main|package:apps/web',
        targetBranch: 'main',
        gate: 'test',
        packageLabel: 'apps/web',
        demandTaskIds: ['product-task'],
        repairTaskId: 'product-task',
        startedAt: 100,
        updatedAt: 200,
        status: 'superseded',
        supersededByRepairTaskId: 'baseline-repair-task',
      },
      baselineQualityGate: {
        kind: 'baseline_quality_gate_failure',
        observedAt: 100,
        targetBranch: 'main',
        gate: 'test',
        packageLabel: 'apps/web',
        signature: 'web-test-signature',
        repairKey: 'baseline-quality-gate|main|test|apps/web',
        repairGroupKey: 'baseline-quality-gate|main|package:apps/web',
        message: 'wait for web repair',
        phase: 'stopped',
        repairTaskId: 'product-task',
        stoppedAt: 200,
        stopReason: 'baseline_repair_superseded',
      },
    },
  ]);
  const watcher = createFailedBlockerWatcher(stateManager, {}, {
    'runner.autoRecoverBlockedTasks': true,
    'runner.autonomyRepairHardCap': 3,
  });

  await watcher.recoverBlockedAutonomyTasks();

  const task = stateManager.tasks.get('product-task');
  assert.equal(task.status, 'ready_to_finalize');
  assert.equal(task.baselineRepairRole, 'demand_task');
  assert.equal(task.baselineRepair.repairTaskId, 'baseline-repair-task');
  assert.equal(task.baselineRepair.status, 'integrated');
  assert.equal(task.baselineQualityGate.repairTaskId, 'baseline-repair-task');
  assert.equal(task.baselineQualityGate.phase, 'baseline_repair_integrated');
  assert.equal(task.autoRecoveryStoppedAt, undefined);
  assert.equal(task.autonomyRepairKind, 'baseline_supersession_migration');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('dependency watcher routes baseline-exhausted failed blockers through autonomy repair', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-autonomy-blocker-'));
  const stateManager = new FakeStateManager([
    {
      id: 'baseline-exhausted-blocker',
      prdPath: path.join(tempDir, 'blocker.json'),
      prdId: 'blocker-prd',
      status: 'failed_finalize',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 100 },
      ],
      worktree: path.join(tempDir, 'blocker-worktree'),
      logPath: path.join(tempDir, 'blocker.log'),
      agent: 'codex',
      repoPath: path.join(tempDir, 'repo'),
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      lastErrorKind: 'baseline_quality_gate_failure',
      autoRecoveryKind: 'baseline_repair',
      autoRecoveryStoppedAt: 200,
      autoRecoveryStopReason: 'baseline_repair_exhausted',
      baselineQualityGate: {
        kind: 'baseline_quality_gate_failure',
        observedAt: 100,
        targetBranch: 'main',
        gate: 'test',
        packageLabel: 'apps/web',
        signature: 'baseline-blocker-signature',
        latestFailureSignature: 'baseline-blocker-signature',
        taskFailureSignature: 'baseline-blocker-signature',
        repairGroupKey: 'baseline-quality-gate|main|package:apps/web',
        message: 'baseline blocker exhausted',
        phase: 'stopped',
        repairTaskId: 'baseline-repair-task',
        stoppedAt: 200,
        stopReason: 'baseline_repair_exhausted',
      },
      baselineRepair: {
        repairKey: 'baseline-blocker-signature',
        repairGroupKey: 'baseline-quality-gate|main|package:apps/web',
        targetBranch: 'main',
        gate: 'test',
        packageLabel: 'apps/web',
        demandTaskIds: ['baseline-exhausted-blocker'],
        repairTaskId: 'baseline-repair-task',
        startedAt: 100,
        updatedAt: 200,
        status: 'failed',
      },
    },
    {
      id: 'blocked-child',
      prdPath: path.join(tempDir, 'child.json'),
      prdId: 'child-prd',
      status: 'pending',
      startTime: 200,
      completedUS: [],
      worktree: '',
      logPath: path.join(tempDir, 'child.log'),
      agent: 'codex',
      repoPath: path.join(tempDir, 'repo'),
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 200,
      lastFilesChanged: 0,
    },
  ]);
  const watcher = createFailedBlockerWatcher(stateManager, {
    'blocked-child': {
      reason: 'dependencies',
      dependencies: ['blocker-prd'],
      dependencyBlockers: [{
        prdId: 'blocker-prd',
        taskId: 'baseline-exhausted-blocker',
        kind: 'task_failed',
        reason: 'baseline repair exhausted',
        actionRequired: true,
      }],
      failedDependencies: ['blocker-prd'],
      blockers: [],
      maxConcurrent: 3,
      running: 0,
    },
  }, {
    'runner.autoRecoverBlockedTasks': true,
    'runner.autonomyRepairHardCap': 3,
  });

  await watcher.recoverFailedBlockers();

  const blocker = stateManager.tasks.get('baseline-exhausted-blocker');
  assert.equal(blocker.status, 'failed_finalize');
  assert.equal(blocker.baselineQualityGate, undefined);
  assert.equal(blocker.baselineQualityGateHistory.length, 1);
  assert.equal(blocker.autonomyRepairKind, 'baseline_exhaustion');
  assert.equal(blocker.autonomyRepairTotalRequeues, 1);
  assert.equal(blocker.failedBlockerRecoveryTotalRequeues, undefined);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('dependency watcher retries deferred target sync for integrated completed tasks', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-target-sync-retry-'));
  const stateManager = new FakeStateManager([
    {
      id: 'deferred-sync-task',
      prdPath: path.join(tempDir, 'prd.json'),
      prdId: 'deferred-sync-prd',
      status: 'completed',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
      ],
      worktree: path.join(tempDir, 'worktree'),
      logPath: path.join(tempDir, 'agent.log'),
      agent: 'codex',
      repoPath: path.join(tempDir, 'repo'),
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      integratedAt: 150,
      mergedAt: 150,
      integrationStatus: 'integrated',
      integrationBranch: 'ralph/integration/main',
      integrationWorktree: path.join(tempDir, 'integration'),
      integrationCommitSha: 'abc123',
      mergeCommitSha: 'abc123',
      mergeTargetBranch: 'main',
      mergeStrategy: 'manual',
      mergeMessage: 'Integrated task branch into ralph/integration/main; main sync deferred: checkout has uncommitted changes',
      targetSyncStatus: 'deferred_dirty_checkout',
      targetSyncDeferredReason: 'main sync deferred: checkout has uncommitted changes',
    },
  ]);
  const mergeCalls = [];
  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager({
        autoMerge: true,
        'merge.syncTargetBranch': true,
      }),
      scheduler: {
        describePendingTask: async () => queuedPendingState(),
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
      mergeTask: async (task, targetBranch, strategy, options) => {
        mergeCalls.push({ taskId: task.id, targetBranch, strategy, options });
        return {
          success: true,
          hasConflicts: false,
          alreadyMerged: true,
          commitSha: 'abc123',
          integrationBranch: 'ralph/integration/main',
          integrationWorktree: path.join(tempDir, 'integration'),
          targetSynced: true,
          targetSyncMessage: 'main fast-forwarded to abc123',
          message: 'task branch is already integrated in ralph/integration/main; main fast-forwarded to abc123',
        };
      },
    },
  );

  await watcher.reconcileDeferredTargetSyncs();

  const task = stateManager.tasks.get('deferred-sync-task');
  assert.equal(mergeCalls.length, 1);
  assert.equal(mergeCalls[0].targetBranch, 'main');
  assert.equal(mergeCalls[0].options.syncTargetBranch, true);
  assert.equal(task.integrationStatus, 'integrated');
  assert.equal(task.targetSyncStatus, 'synced');
  assert.ok(typeof task.targetSyncedAt === 'number');
  assert.equal(task.targetSyncDeferredReason, undefined);
  assert.match(task.mergeMessage, /fast-forwarded/);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('dependency watcher retries transient failed target sync for integrated completed tasks', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-target-sync-failed-retry-'));
  const stateManager = new FakeStateManager([
    {
      id: 'failed-sync-task',
      prdPath: path.join(tempDir, 'prd.json'),
      prdId: 'failed-sync-prd',
      status: 'completed',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
      ],
      worktree: path.join(tempDir, 'worktree'),
      logPath: path.join(tempDir, 'agent.log'),
      agent: 'codex',
      repoPath: path.join(tempDir, 'repo'),
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      integratedAt: 150,
      mergedAt: 150,
      integrationStatus: 'integrated',
      integrationBranch: 'ralph/integration/main',
      integrationWorktree: path.join(tempDir, 'integration'),
      integrationCommitSha: 'abc123',
      mergeCommitSha: 'abc123',
      mergeTargetBranch: 'main',
      mergeStrategy: 'manual',
      mergeMessage: 'Integrated task branch into ralph/integration/main',
      targetSyncStatus: 'failed',
      targetSyncDeferredReason: 'target sync retry failed: Command failed: git fetch\nConnection to github.com port 22 timed out',
    },
  ]);
  const mergeCalls = [];
  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager({
        autoMerge: true,
        'merge.syncTargetBranch': true,
      }),
      scheduler: {
        describePendingTask: async () => queuedPendingState(),
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
      mergeTask: async (task, targetBranch, strategy, options) => {
        mergeCalls.push({ taskId: task.id, targetBranch, strategy, options });
        return {
          success: true,
          hasConflicts: false,
          alreadyMerged: true,
          commitSha: 'abc123',
          integrationBranch: 'ralph/integration/main',
          integrationWorktree: path.join(tempDir, 'integration'),
          targetSynced: true,
          targetSyncMessage: 'main already contains abc123',
          message: 'task branch is already integrated in ralph/integration/main; main already contains abc123',
        };
      },
    },
  );

  await watcher.reconcileDeferredTargetSyncs();

  const task = stateManager.tasks.get('failed-sync-task');
  assert.equal(mergeCalls.length, 1);
  assert.equal(mergeCalls[0].targetBranch, 'main');
  assert.equal(mergeCalls[0].options.syncTargetBranch, true);
  assert.equal(task.integrationStatus, 'integrated');
  assert.equal(task.targetSyncStatus, 'synced');
  assert.ok(typeof task.targetSyncedAt === 'number');
  assert.equal(task.targetSyncDeferredReason, undefined);
  assert.match(task.mergeMessage, /already contains/);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('dependency watcher clears stale deferred target sync when target publishing is disabled', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-target-sync-disabled-'));
  const repoDir = path.join(tempDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ['init', '-b', 'main']);
  git(repoDir, ['config', 'user.name', 'Ralph Test']);
  git(repoDir, ['config', 'user.email', 'ralph@example.com']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'base\n');
  git(repoDir, ['add', 'README.md']);
  git(repoDir, ['commit', '-m', 'base']);

  const stateManager = new FakeStateManager([
    {
      id: 'deferred-sync-disabled-task',
      prdPath: path.join(tempDir, 'prd.json'),
      prdId: 'deferred-sync-disabled-prd',
      status: 'completed',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
      ],
      worktree: path.join(tempDir, 'worktree'),
      logPath: path.join(tempDir, 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      integratedAt: 150,
      mergedAt: 150,
      integrationStatus: 'integrated',
      integrationBranch: 'ralph/integration/main',
      integrationWorktree: path.join(tempDir, 'integration'),
      integrationCommitSha: 'abc123',
      mergeCommitSha: 'abc123',
      mergeTargetBranch: 'main',
      mergeStrategy: 'manual',
      mergeMessage: 'Integrated task branch into ralph/integration/main; main sync deferred: checkout has uncommitted changes',
      targetSyncStatus: 'deferred_dirty_checkout',
      targetSyncDeferredReason: 'main sync deferred: checkout has uncommitted changes',
    },
  ]);
  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager({
        autoMerge: false,
        'merge.syncTargetBranch': true,
      }),
      scheduler: {
        describePendingTask: async () => queuedPendingState(),
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
      mergeTask: async () => {
        throw new Error('merge should not run when target publishing is disabled');
      },
    },
  );

  await watcher.reconcileDeferredTargetSyncs();

  const task = stateManager.tasks.get('deferred-sync-disabled-task');
  assert.equal(task.targetSyncStatus, 'disabled');
  assert.match(task.targetSyncDeferredReason, /target sync disabled by policy/);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('dependency watcher auto-repairs no-objective-evidence story failures directly', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'no-objective-task',
      prdPath: '/tmp/prd.json',
      prdId: 'no-objective-prd',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001', 'US-002'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'passed', attempts: 1, updatedAt: 1 },
        {
          id: 'US-003',
          status: 'failed',
          attempts: 2,
          lastError: 'Agent reported success for US-003, but Ralph found no objective diff or commit evidence',
          updatedAt: 1,
        },
      ],
      worktree: '/tmp/worktree',
      logPath: '/tmp/agent.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 1,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Agent reported success for US-003, but Ralph found no objective diff or commit evidence',
      lastErrorKind: 'no_objective_evidence',
      lastErrorClass: 'story_validation',
      lastErrorRetryable: true,
      lastErrorSignature: 'US-003:no_objective_evidence',
    },
  ]);
  const watcher = createFailedBlockerWatcher(stateManager, {});

  await watcher.recoverFailedStoryRepairTasks();

  const task = stateManager.tasks.get('no-objective-task');
  assert.equal(task.status, 'pending');
  assert.deepEqual(task.completedUS, ['US-001', 'US-002']);
  assert.equal(task.storyProgress[0].status, 'passed');
  assert.equal(task.storyProgress[1].status, 'passed');
  assert.equal(task.storyProgress[2].status, 'pending');
  assert.equal(task.storyProgress[2].attempts, 0);
  assert.equal(task.storyRepairRecoveryTotalRequeues, 1);
  assert.equal(task.autoRecoveryKind, 'story_repair');
  assert.equal(task.lastError, undefined);
});

test('dependency watcher auto-repairs story incomplete failures directly', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'story-incomplete-task',
      prdPath: '/tmp/prd.json',
      prdId: 'story-incomplete-prd',
      status: 'failed',
      startTime: 100,
      completedUS: [],
      storyProgress: [
        { id: 'US-001', status: 'failed', attempts: 2, lastError: 'incomplete', updatedAt: 1 },
        { id: 'US-002', status: 'pending', attempts: 0, updatedAt: 1 },
        { id: 'US-003', status: 'pending', attempts: 0, updatedAt: 1 },
      ],
      worktree: '/tmp/worktree',
      logPath: '/tmp/agent.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Task cannot finalize: 3/3 stories are incomplete',
      lastErrorKind: 'story_incomplete',
      lastErrorClass: 'semantic',
      lastErrorRetryable: false,
      autoRecoveryStoppedAt: 200,
      autoRecoveryStopReason: 'story_incomplete',
    },
  ]);
  const watcher = createFailedBlockerWatcher(stateManager, {});

  await watcher.recoverFailedStoryRepairTasks();

  const task = stateManager.tasks.get('story-incomplete-task');
  assert.equal(task.status, 'pending');
  assert.deepEqual(task.completedUS, []);
  assert.deepEqual(task.storyProgress.map((story) => story.status), ['pending', 'pending', 'pending']);
  assert.deepEqual(task.storyProgress.map((story) => story.attempts), [0, 0, 0]);
  assert.equal(task.storyRepairRecoveryTotalRequeues, 1);
  assert.equal(task.autoRecoveryStoppedAt, undefined);
  assert.equal(task.autoRecoveryStopReason, undefined);
});

test('dependency watcher refuses direct story repair with delivery markers', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'integrated-failed-task',
      prdPath: '/tmp/prd.json',
      prdId: 'integrated-prd',
      status: 'failed',
      startTime: 100,
      completedUS: [],
      storyProgress: [
        { id: 'US-001', status: 'failed', attempts: 2, lastError: 'incomplete', updatedAt: 1 },
      ],
      worktree: '/tmp/worktree',
      logPath: '/tmp/agent.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Task cannot finalize: 1/1 stories are incomplete',
      lastErrorKind: 'story_incomplete',
      integratedAt: 123,
    },
  ]);
  const watcher = createFailedBlockerWatcher(stateManager, {});

  await watcher.recoverFailedStoryRepairTasks();

  const task = stateManager.tasks.get('integrated-failed-task');
  assert.equal(task.status, 'failed');
  assert.equal(task.storyProgress[0].status, 'failed');
  assert.equal(task.storyRepairRecoveryStopReason, 'story_repair_unsafe_delivery_marker');
  assert.equal(task.autoRecoveryStopReason, 'story_repair_unsafe_delivery_marker');
});

test('dependency watcher auto-remediates failed story dependency blockers once', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-dependency',
      prdPath: '/tmp/dep.json',
      prdId: 'dep-prd',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'failed', attempts: 2, lastError: 'incomplete', updatedAt: 1 },
      ],
      worktree: '/tmp/dep-worktree',
      logPath: '/tmp/dep-agent.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'US-002 failed',
      lastErrorKind: 'story_incomplete',
      lastErrorObservedAt: 100,
    },
    {
      id: 'blocked-child',
      prdPath: '/tmp/child.json',
      prdId: 'child-prd',
      status: 'pending',
      startTime: 200,
      completedUS: [],
      worktree: '',
      logPath: '/tmp/child-agent.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 200,
      lastFilesChanged: 0,
    },
  ]);
  const watcher = createFailedBlockerWatcher(stateManager, {
    'blocked-child': {
      reason: 'dependencies',
      dependencies: ['dep-prd'],
      dependencyBlockers: [{
        prdId: 'dep-prd',
        taskId: 'failed-dependency',
        kind: 'task_failed',
        reason: 'US-002 failed',
        actionRequired: true,
      }],
      failedDependencies: ['dep-prd'],
      blockers: [],
      maxConcurrent: 3,
      running: 0,
    },
  });

  await watcher.recoverFailedBlockers();

  const task = stateManager.tasks.get('failed-dependency');
  assert.equal(task.status, 'pending');
  assert.deepEqual(task.completedUS, ['US-001']);
  assert.equal(task.storyProgress[0].status, 'passed');
  assert.equal(task.storyProgress[0].attempts, 1);
  assert.equal(task.storyProgress[1].status, 'pending');
  assert.equal(task.storyProgress[1].attempts, 0);
  assert.equal(task.autoRecoveryKind, 'story_repair');
  assert.equal(task.failedBlockerRecoveryTotalRequeues, 1);
  assert.deepEqual(task.failedBlockerRecoveryDemandTaskIds, ['blocked-child']);
  assert.equal(task.lastError, undefined);
});

test('dependency watcher auto-remediates failed story coordination blockers once', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-owner',
      prdPath: '/tmp/owner.json',
      prdId: 'owner-prd',
      status: 'failed',
      startTime: 100,
      completedUS: [],
      storyProgress: [
        { id: 'US-001', status: 'failed', attempts: 2, lastError: 'incomplete', updatedAt: 1 },
      ],
      worktree: '/tmp/owner-worktree',
      logPath: '/tmp/owner-agent.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'US-001 failed',
      lastErrorKind: 'story_incomplete',
      lastErrorObservedAt: 100,
    },
    {
      id: 'later-task',
      prdPath: '/tmp/later.json',
      prdId: 'later-prd',
      status: 'pending',
      startTime: 200,
      completedUS: [],
      worktree: '',
      logPath: '/tmp/later-agent.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 200,
      lastFilesChanged: 0,
    },
  ]);
  const watcher = createFailedBlockerWatcher(stateManager, {
    'later-task': {
      reason: 'coordination',
      dependencies: [],
      blockers: ['failed-owner'],
      failedBlockers: ['failed-owner'],
      maxConcurrent: 3,
      running: 0,
    },
  });

  await watcher.recoverFailedBlockers();

  const task = stateManager.tasks.get('failed-owner');
  assert.equal(task.status, 'pending');
  assert.equal(task.storyProgress[0].status, 'pending');
  assert.equal(task.failedBlockerRecoveryTotalRequeues, 1);
  assert.deepEqual(task.failedBlockerRecoveryDemandTaskIds, ['later-task']);
});

test('dependency watcher leaves failed blocker blocked after story repair budget is exhausted', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-dependency',
      prdPath: '/tmp/dep.json',
      prdId: 'dep-prd',
      status: 'failed',
      startTime: 100,
      completedUS: [],
      storyProgress: [
        { id: 'US-001', status: 'failed', attempts: 2, lastError: 'incomplete', updatedAt: 1 },
      ],
      worktree: '/tmp/dep-worktree',
      logPath: '/tmp/dep-agent.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'US-001 failed',
      lastErrorKind: 'story_incomplete',
      failedBlockerRecoveryTotalRequeues: 1,
    },
    {
      id: 'blocked-child',
      prdPath: '/tmp/child.json',
      prdId: 'child-prd',
      status: 'pending',
      startTime: 200,
      completedUS: [],
      worktree: '',
      logPath: '/tmp/child-agent.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 200,
      lastFilesChanged: 0,
    },
  ]);
  const watcher = createFailedBlockerWatcher(stateManager, {
    'blocked-child': {
      reason: 'dependencies',
      dependencies: ['dep-prd'],
      dependencyBlockers: [{
        prdId: 'dep-prd',
        taskId: 'failed-dependency',
        kind: 'task_failed',
        reason: 'US-001 failed',
        actionRequired: true,
      }],
      failedDependencies: ['dep-prd'],
      blockers: [],
      maxConcurrent: 3,
      running: 0,
    },
  });

  await watcher.recoverFailedBlockers();

  const task = stateManager.tasks.get('failed-dependency');
  assert.equal(task.status, 'failed');
  assert.equal(task.failedBlockerRecoveryTotalRequeues, 1);
  assert.equal(task.failedBlockerRecoveryStopReason, 'failed_blocker_story_budget_exhausted');
  assert.equal(task.autoRecoveryStopReason, 'failed_blocker_story_budget_exhausted');
  assert.ok(task.failedBlockerRecoveryStoppedAt);
});

test('dependency watcher does not count prior generic auto-recovery against failed blocker story repair', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-dependency',
      prdPath: '/tmp/dep.json',
      prdId: 'dep-prd',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-002'],
      storyProgress: [
        { id: 'US-001', status: 'failed', attempts: 2, lastError: 'incomplete', updatedAt: 1 },
        { id: 'US-002', status: 'passed', attempts: 1, updatedAt: 1 },
      ],
      worktree: '/tmp/dep-worktree',
      logPath: '/tmp/dep-agent.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'US-001 failed',
      lastErrorKind: 'story_incomplete',
      autoRecoveryTotalRequeues: 2,
    },
    {
      id: 'blocked-child',
      prdPath: '/tmp/child.json',
      prdId: 'child-prd',
      status: 'pending',
      startTime: 200,
      completedUS: [],
      worktree: '',
      logPath: '/tmp/child-agent.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 200,
      lastFilesChanged: 0,
    },
  ]);
  const watcher = createFailedBlockerWatcher(stateManager, {
    'blocked-child': {
      reason: 'dependencies',
      dependencies: ['dep-prd'],
      dependencyBlockers: [{
        prdId: 'dep-prd',
        taskId: 'failed-dependency',
        kind: 'task_failed',
        reason: 'US-001 failed',
        actionRequired: true,
      }],
      failedDependencies: ['dep-prd'],
      blockers: [],
      maxConcurrent: 3,
      running: 0,
    },
  });

  await watcher.recoverFailedBlockers();

  const task = stateManager.tasks.get('failed-dependency');
  assert.equal(task.status, 'pending');
  assert.equal(task.failedBlockerRecoveryTotalRequeues, 1);
  assert.equal(task.autoRecoveryTotalRequeues, 3);
  assert.equal(task.failedBlockerRecoveryStopReason, undefined);
});

test('dependency watcher refuses failed blocker story reset with integration markers', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-dependency',
      prdPath: '/tmp/dep.json',
      prdId: 'dep-prd',
      status: 'failed',
      startTime: 100,
      completedUS: [],
      storyProgress: [
        { id: 'US-001', status: 'failed', attempts: 2, lastError: 'incomplete', updatedAt: 1 },
      ],
      worktree: '/tmp/dep-worktree',
      logPath: '/tmp/dep-agent.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'US-001 failed',
      lastErrorKind: 'story_incomplete',
      integratedAt: 123,
    },
    {
      id: 'blocked-child',
      prdPath: '/tmp/child.json',
      prdId: 'child-prd',
      status: 'pending',
      startTime: 200,
      completedUS: [],
      worktree: '',
      logPath: '/tmp/child-agent.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 200,
      lastFilesChanged: 0,
    },
  ]);
  const watcher = createFailedBlockerWatcher(stateManager, {
    'blocked-child': {
      reason: 'dependencies',
      dependencies: ['dep-prd'],
      dependencyBlockers: [{
        prdId: 'dep-prd',
        taskId: 'failed-dependency',
        kind: 'task_failed',
        reason: 'US-001 failed',
        actionRequired: true,
      }],
      failedDependencies: ['dep-prd'],
      blockers: [],
      maxConcurrent: 3,
      running: 0,
    },
  });

  await watcher.recoverFailedBlockers();

  const task = stateManager.tasks.get('failed-dependency');
  assert.equal(task.status, 'failed');
  assert.equal(task.storyProgress[0].status, 'failed');
  assert.equal(task.failedBlockerRecoveryStopReason, 'failed_blocker_unsafe_integrated_marker');
});

test('dependency watcher does not reset merge repair deadline exhausted blockers', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-merge-repair',
      prdPath: '/tmp/dep.json',
      prdId: 'dep-prd',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'needs_repair', attempts: 2, lastError: 'conflict', updatedAt: 1 },
      ],
      worktree: '/tmp/dep-worktree',
      logPath: '/tmp/dep-agent.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Worker merge repair deadline exhausted',
      lastErrorKind: 'merge_conflict',
      mergeRepairRecoveryStopReason: 'merge_repair_deadline_exhausted',
    },
    {
      id: 'blocked-child',
      prdPath: '/tmp/child.json',
      prdId: 'child-prd',
      status: 'pending',
      startTime: 200,
      completedUS: [],
      worktree: '',
      logPath: '/tmp/child-agent.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 200,
      lastFilesChanged: 0,
    },
  ]);
  const watcher = createFailedBlockerWatcher(stateManager, {
    'blocked-child': {
      reason: 'dependencies',
      dependencies: ['dep-prd'],
      dependencyBlockers: [{
        prdId: 'dep-prd',
        taskId: 'failed-merge-repair',
        kind: 'task_failed',
        reason: 'deadline exhausted',
        actionRequired: true,
      }],
      failedDependencies: ['dep-prd'],
      blockers: [],
      maxConcurrent: 3,
      running: 0,
    },
  });

  await watcher.recoverFailedBlockers();

  const task = stateManager.tasks.get('failed-merge-repair');
  assert.equal(task.status, 'failed');
  assert.equal(task.storyProgress[0].status, 'needs_repair');
  assert.equal(task.failedBlockerRecoveryTotalRequeues, undefined);
  assert.equal(task.failedBlockerRecoveryStopReason, undefined);
});

test('dependency watcher recovers soft-failed tasks into finalize flow', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-soft-failed-'));
  const logPath = path.join(tempDir, 'agent.log');
  fs.writeFileSync(logPath, `
**Done**
- Reworked the exception layer

**Validation**
- 8 suites, 233 tests passed

Suggested commit message: refactor(api): replace raw service errors with domain exceptions
`);

  const stateManager = new FakeStateManager([
    {
      id: 'soft-failed',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001', 'US-002'],
      worktree: '/repo/.ralph-worktrees/soft-failed',
      logPath,
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 0,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 12,
    },
  ]);

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
      finalizer: () => ({
        success: true,
        committed: true,
        message: 'Committed task changes successfully',
        commitMessage: 'feat: recovered finalize',
      }),
    }
  );

  await watcher.recoverSoftFailedTasks();
  assert.equal(stateManager.tasks.get('soft-failed').status, 'ready_to_finalize');

  await watcher.finalizeReadyTasks();
  const task = stateManager.tasks.get('soft-failed');
  assert.equal(task.status, 'completed');
  assert.equal(task.finalizerCommitMessage, 'feat: recovered finalize');
});

test('dependency watcher skips soft recovery for tasks already handed to follow-up PRDs', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-soft-failed-followup-'));
  const logPath = path.join(tempDir, 'agent.log');
  fs.writeFileSync(logPath, `
**Done**
- Reworked the exception layer

**Validation**
- 8 suites, 233 tests passed

Suggested commit message: refactor(api): replace raw service errors with domain exceptions
`);

  const stateManager = new FakeStateManager([
    {
      id: 'soft-failed-source',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001'],
      followupTaskIds: ['followup-task'],
      worktree: '/repo/.ralph-worktrees/soft-failed-source',
      logPath,
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 0,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 12,
    },
  ]);

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
    }
  );

  await watcher.recoverSoftFailedTasks();

  const task = stateManager.tasks.get('soft-failed-source');
  assert.equal(task.status, 'failed');
  assert.equal(task.currentUS, undefined);
});

test('dependency watcher skips soft recovery for story-incomplete failures', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-soft-failed-story-incomplete-'));
  const logPath = path.join(tempDir, 'agent.log');
  fs.writeFileSync(logPath, `
**Done**
- Reworked the exception layer

**Validation**
- 8 suites, 233 tests passed

Suggested commit message: refactor(api): replace raw service errors with domain exceptions
`);

  const stateManager = new FakeStateManager([
    {
      id: 'soft-failed-story-incomplete',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'failed', attempts: 2, updatedAt: 2 },
      ],
      worktree: '/repo/.ralph-worktrees/soft-failed-story-incomplete',
      logPath,
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 0,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 12,
      lastError: 'Task cannot finalize: 1/2 stories are incomplete',
      lastErrorKind: 'story_incomplete',
      lastErrorClass: 'semantic',
      lastErrorRetryable: false,
    },
  ]);

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
    }
  );

  await watcher.recoverSoftFailedTasks();

  const task = stateManager.tasks.get('soft-failed-story-incomplete');
  assert.equal(task.status, 'failed');
  assert.equal(task.lastErrorKind, 'story_incomplete');
});

test('dependency watcher schedules transient finalizer retry without entering finalize repair', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'transient-finalizer-fetch',
      prdPath: '/tmp/prd.json',
      status: 'ready_to_finalize',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/transient-finalizer-fetch',
      logPath: '/tmp/transient-finalizer-fetch.log',
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
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
      finalizer: () => {
        throw new Error('Command failed: git fetch\nConnection to 20.205.243.166 port 22 timed out');
      },
    },
  );

  await watcher.finalizeReadyTasks();
  const task = stateManager.tasks.get('transient-finalizer-fetch');
  assert.equal(task.status, 'failed_finalize');
  assert.equal(task.lastErrorKind, 'transport_timeout');
  assert.equal(task.lastErrorClass, 'transport');
  assert.equal(task.lastErrorRetryable, true);
  assert.equal(task.autoRecoveryKind, 'transient');
  assert.ok(task.transientRecoveryNextEligibleAt > Date.now());
  assert.equal(task.repairContext, undefined);
  assert.equal(task.finalizerFailure, undefined);
});

test('dependency watcher returns transient failed finalizer to ready_to_finalize after cooldown', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'transient-finalizer-ready',
      prdPath: '/tmp/prd.json',
      status: 'failed_finalize',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/transient-finalizer-ready',
      logPath: '/tmp/transient-finalizer-ready.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      lastError: 'Command failed: git fetch\nConnection to github.com port 22 timed out',
      mergeError: 'Command failed: git fetch\nConnection to github.com port 22 timed out',
      lastErrorKind: 'transport_timeout',
      lastErrorClass: 'transport',
      lastErrorRetryable: true,
      lastErrorSignature: 'transport_timeout',
      transientRecoveryStartedAt: Date.now() - 5000,
      transientRecoveryDeadlineAt: Date.now() + 60000,
      transientRecoveryTotalRequeues: 0,
      transientRecoveryLastFailureKind: 'transport_timeout',
      transientRecoveryLastFailureClass: 'transport',
      transientRecoveryLastFailureSignature: 'transport_timeout',
      transientRecoveryNextEligibleAt: Date.now() - 1000,
      autoRecoveryKind: 'transient',
      autoRecoveryTotalRequeues: 0,
      autoRecoveryHardCap: 20,
      repairContext: {
        mode: 'finalize',
        storyId: 'US-001',
        createdAt: 1,
        reason: 'old repair context should be cleared for transient retry',
      },
    },
  ]);

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
    },
  );

  await watcher.recoverFailedFinalizeTasks();
  const task = stateManager.tasks.get('transient-finalizer-ready');
  assert.equal(task.status, 'ready_to_finalize');
  assert.equal(task.repairContext, undefined);
  assert.equal(task.finalizerFailure, undefined);
  assert.equal(task.transientRecoveryTotalRequeues, 1);
  assert.equal(task.autoRecoveryTotalRequeues, 1);
  assert.equal(task.transientRecoveryNextEligibleAt, undefined);
});

test('dependency watcher normalizes already integrated product finalize/autonomy state to completed', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-integrated-normalize-'));
  const stateManager = new FakeStateManager([
    {
      id: 'integrated-product',
      prdPath: path.join(tempDir, 'prd.json'),
      prdId: 'prd-product-ui',
      status: 'failed_finalize',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 100 },
      ],
      worktree: path.join(tempDir, 'worktree'),
      logPath: path.join(tempDir, 'agent.log'),
      agent: 'codex',
      repoPath: path.join(tempDir, 'repo'),
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      integrationStatus: 'integrated',
      integratedAt: 500,
      mergeCommitSha: 'abc123',
      targetSyncStatus: 'disabled',
      lastError: 'Quality gate failed after integration',
      lastErrorKind: 'quality_gate_failure',
      autoRecoveryKind: 'baseline_repair',
      baselineQualityGate: {
        kind: 'baseline_quality_gate_failure',
        observedAt: 300,
        targetBranch: 'main',
        gate: 'test',
        packageLabel: 'apps/api',
        signature: 'test|apps/api',
        message: 'baseline failed',
      },
    },
  ]);

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
    },
  );

  await watcher.normalizeIntegratedProductTasks();
  const task = stateManager.tasks.get('integrated-product');
  assert.equal(task.status, 'completed');
  assert.equal(task.endTime, 500);
  assert.equal(task.lastError, undefined);
  assert.equal(task.lastErrorKind, undefined);
  assert.equal(task.autoRecoveryKind, undefined);
  assert.equal(task.baselineQualityGate, undefined);
  assert.equal(task.baselineQualityGateHistory.length, 1);
});

test('dependency watcher does not normalize dedicated baseline repair tasks', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-integrated-baseline-'));
  const stateManager = new FakeStateManager([
    {
      id: 'integrated-baseline-repair',
      prdPath: path.join(tempDir, 'prd.json'),
      prdId: 'baseline-quality-gate:abc',
      status: 'failed_finalize',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 100 },
      ],
      worktree: path.join(tempDir, 'worktree'),
      logPath: path.join(tempDir, 'agent.log'),
      agent: 'codex',
      repoPath: path.join(tempDir, 'repo'),
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      integrationStatus: 'integrated',
      integratedAt: 500,
      mergeCommitSha: 'abc123',
      targetSyncStatus: 'disabled',
      baselineRepairRole: 'dedicated_repair_task',
    },
  ]);

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
    },
  );

  await watcher.normalizeIntegratedProductTasks();
  const task = stateManager.tasks.get('integrated-baseline-repair');
  assert.equal(task.status, 'failed_finalize');
});

test('dependency watcher refreshes expired finalize repair window for a new post-deadline failure', async () => {
  const now = Date.now();
  const stateManager = new FakeStateManager([
    {
      id: 'post-deadline-finalize-failure',
      prdPath: '/tmp/prd.json',
      status: 'failed_finalize',
      startTime: 100,
      completedUS: ['US-001', 'US-002'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'passed', attempts: 2, updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/post-deadline-finalize-failure',
      logPath: '/tmp/post-deadline-finalize-failure.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      lastError: 'Quality gate "test" failed',
      lastErrorKind: 'quality_gate_failure',
      finalizerFailure: {
        failureKind: 'quality_gate',
        class: 'quality_gate_failure',
        gate: 'test',
        requestedGate: 'test',
        packageLabel: 'apps/web',
        cwd: '/repo/apps/web',
        command: 'pnpm run test',
        rawMessage: 'Quality gate "test" failed',
      },
      repairContext: {
        mode: 'finalize',
        storyId: 'US-002',
        createdAt: now - 1000,
        reason: 'Quality gate "test" failed',
      },
      finalizeRepairStartedAt: now - 20_000,
      finalizeRepairDeadlineAt: now - 10_000,
      finalizeRepairLastFailureSnapshot: {
        headSha: 'abc',
        commitsAheadOfBase: 1,
        changedFiles: 2,
        worktreeDiffSignature: 'diff',
        failureKind: 'quality_gate',
        failureSignature: 'Quality gate "test" failed',
        failureClass: 'quality_gate_failure',
        gate: 'test',
        packageLabel: 'apps/web',
        capturedAt: now - 1000,
      },
      finalizeRepairLastProgressAt: now - 20_000,
      finalizeRepairLastProgressReason: 'old failure window',
      finalizeRepairConsecutiveNoProgress: 5,
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager({
        'runner.autoClassifyBaselineQualityGateFailures': false,
      }),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
    },
  );

  await watcher.recoverFailedFinalizeTasks();
  const task = stateManager.tasks.get('post-deadline-finalize-failure');
  assert.equal(task.status, 'pending');
  assert.equal(task.finalizeRepairStoppedAt, undefined);
  assert.equal(task.finalizeRepairStopReason, undefined);
  assert.ok(task.finalizeRepairDeadlineAt > Date.now());
  assert.equal(task.finalizeRepairConsecutiveNoProgress, 0);
  assert.equal(task.repairContext.mode, 'finalize');
  assert.equal(task.storyProgress.find((story) => story.id === 'US-002').status, 'needs_repair');
});

test('dependency watcher product-repairs failed finalizer after integrated baseline repair still fails', async () => {
  const now = Date.now();
  const signature = 'test|apps/web|quality_gate_failure|pnpm run test|breadcrumb title still exposes id';
  const stateManager = new FakeStateManager([
    {
      id: 'post-baseline-product-failure',
      prdPath: '/tmp/prd.json',
      status: 'failed_finalize',
      startTime: 100,
      completedUS: ['US-001', 'US-002'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'passed', attempts: 1, updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/post-baseline-product-failure',
      logPath: '/tmp/post-baseline-product-failure.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      lastError: 'Quality gate "test" failed: breadcrumb title still exposes id',
      lastErrorKind: 'quality_gate_failure',
      latestFailure: {
        kind: 'quality_gate',
        class: 'quality_gate_failure',
        gate: 'test',
        packageLabel: 'apps/web',
        signature,
        rawMessage: 'breadcrumb title still exposes id',
        observedAt: now,
      },
      finalizerFailure: {
        failureKind: 'quality_gate',
        class: 'quality_gate_failure',
        gate: 'test',
        requestedGate: 'test',
        packageLabel: 'apps/web',
        cwd: '/repo/apps/web',
        command: 'pnpm run test',
        rawMessage: 'breadcrumb title still exposes id',
      },
      repairContext: {
        mode: 'finalize',
        storyId: 'US-002',
        createdAt: now,
        reason: 'Quality gate "test" failed: breadcrumb title still exposes id',
      },
      baselineQualityGate: {
        kind: 'baseline_quality_gate_failure',
        phase: 'baseline_repair_integrated',
        targetBranch: 'main',
        gate: 'test',
        packageLabel: 'apps/web',
        rootCause: 'shared_baseline_code_debt',
        taskFailureSignature: signature,
        latestFailureSignature: signature,
        repairTaskId: 'baseline-repair-task',
      },
      baselineRepair: {
        repairTaskId: 'baseline-repair-task',
        status: 'needs_more_repair',
        appliedRepairCommitSha: 'abc123',
        message: 'Baseline repair task baseline-repair-task integrated',
      },
      finalizeRepairStartedAt: now - 1000,
      finalizeRepairDeadlineAt: now + 60_000,
      finalizeRepairLastFailureSnapshot: {
        headSha: 'abc',
        commitsAheadOfBase: 1,
        changedFiles: 2,
        worktreeDiffSignature: 'diff',
        failureKind: 'quality_gate',
        failureSignature: signature,
        failureClass: 'quality_gate_failure',
        gate: 'test',
        packageLabel: 'apps/web',
        capturedAt: now,
      },
      finalizeRepairLastProgressAt: now,
      finalizeRepairLastProgressReason: 'baseline repair integrated but product gate still fails',
      finalizeRepairConsecutiveNoProgress: 0,
    },
  ]);

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
    },
  );

  await watcher.recoverFailedFinalizeTasks();
  const task = stateManager.tasks.get('post-baseline-product-failure');
  assert.equal(task.status, 'pending');
  assert.equal(task.autoRecoveryKind, 'finalize_repair');
  assert.equal(task.repairContext.mode, 'finalize');
  assert.equal(task.repairContext.storyId, 'US-002');
  assert.deepEqual(task.completedUS, ['US-001']);
  assert.equal(task.storyProgress.find((story) => story.id === 'US-002').status, 'needs_repair');
});

test('dependency watcher skips baseline reclassification after integrated baseline repair evidence', async () => {
  const now = Date.now();
  const stateManager = new FakeStateManager([
    {
      id: 'integrated-baseline-evidence-task',
      prdPath: '/tmp/prd.json',
      status: 'failed_finalize',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/integrated-baseline-evidence-task',
      logPath: '/tmp/integrated-baseline-evidence-task.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      lastError: 'Quality gate "test" failed after baseline repair integrated',
      lastErrorKind: 'quality_gate_failure',
      latestFailure: {
        kind: 'quality_gate',
        class: 'quality_gate_failure',
        gate: 'test',
        packageLabel: 'apps/web',
        signature: 'test|apps/web|quality_gate_failure|pnpm run test|still failing',
        rawMessage: 'still failing',
        observedAt: now,
      },
      finalizerFailure: {
        failureKind: 'quality_gate',
        class: 'quality_gate_failure',
        gate: 'test',
        requestedGate: 'test',
        packageLabel: 'apps/web',
        cwd: '/repo/apps/web',
        command: 'pnpm run test',
        rawMessage: 'still failing',
      },
      repairContext: {
        mode: 'finalize',
        storyId: 'US-001',
        createdAt: now,
        reason: 'Quality gate "test" failed after baseline repair integrated',
      },
      baselineRepair: {
        repairTaskId: 'baseline-repair-task',
        status: 'integrated',
        appliedRepairCommitSha: 'abc123',
        message: 'Baseline repair task baseline-repair-task integrated',
      },
      finalizeRepairStartedAt: now - 1000,
      finalizeRepairDeadlineAt: now + 60_000,
      finalizeRepairLastFailureSnapshot: {
        headSha: 'abc',
        commitsAheadOfBase: 1,
        changedFiles: 2,
        worktreeDiffSignature: 'diff',
        failureKind: 'quality_gate',
        failureSignature: 'still failing',
        failureClass: 'quality_gate_failure',
        gate: 'test',
        packageLabel: 'apps/web',
        capturedAt: now,
      },
      finalizeRepairLastProgressAt: now,
      finalizeRepairLastProgressReason: 'baseline repair integrated but product gate still fails',
      finalizeRepairConsecutiveNoProgress: 0,
    },
  ]);

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
      classifyBaselineQualityGateFailure: async () => {
        throw new Error('baseline reclassification should not run');
      },
    },
  );

  await watcher.classifyBaselineQualityGateFailures();
  await watcher.recoverFailedFinalizeTasks();
  const task = stateManager.tasks.get('integrated-baseline-evidence-task');
  assert.equal(task.status, 'pending');
  assert.equal(task.autoRecoveryKind, 'finalize_repair');
  assert.equal(task.baselineQualityGate, undefined);
  assert.equal(task.storyProgress[0].status, 'needs_repair');
});

test('dependency watcher recovers failed repair task when current worktree evidence still exists', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-failed-repair-recovery-'));
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-failed-repair-log-'));
  const logPath = path.join(taskDir, 'agent.log');

  try {
    git(repoDir, ['init']);
    git(repoDir, ['config', 'user.email', 'test@example.com']);
    git(repoDir, ['config', 'user.name', 'Test User']);

    const filePath = path.join(repoDir, 'tracked.txt');
    fs.writeFileSync(filePath, 'base\n');
    git(repoDir, ['add', 'tracked.txt']);
    git(repoDir, ['commit', '-m', 'initial']);

    const baseCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();

    fs.writeFileSync(filePath, 'repaired implementation still present\n');
    fs.writeFileSync(logPath, `
**Result**
The worktree now enforces the topology approval boundaries in code and tests.

**Verification**
\`npm test\` at the repo root passed.

Suggested commit message: feat: recover failed finalize repair
`);

    const stateManager = new FakeStateManager([
      {
        id: 'failed-repair-recovery',
        prdPath: '/tmp/prd.json',
        status: 'failed',
        startTime: 100,
        completedUS: ['US-001', 'US-002'],
        storyProgress: [
          { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
          { id: 'US-002', status: 'passed', attempts: 1, updatedAt: 1 },
          {
            id: 'US-003',
            status: 'failed',
            attempts: 2,
            lastEvidence: '3 file(s) changed in working tree',
            lastError: 'Agent reported success for US-003, but Ralph found no objective diff or commit evidence',
            updatedAt: 1,
          },
        ],
        worktree: repoDir,
        logPath,
        agent: 'codex',
        repoPath: '/repo',
        baseCommitSha,
        loopCount: 2,
        consecutiveNoProgress: 1,
        consecutiveErrors: 0,
        lastProgressTime: 100,
        lastFilesChanged: 0,
        lastError: 'Agent reported success for US-003, but Ralph found no objective diff or commit evidence',
      },
    ]);

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
      }
    );

    await watcher.recoverSoftFailedTasks();
    const task = stateManager.tasks.get('failed-repair-recovery');
    assert.equal(task.status, 'ready_to_finalize');
    assert.deepEqual(task.completedUS, ['US-001', 'US-002', 'US-003']);
    assert.equal(task.storyProgress[2].status, 'passed');
    assert.equal(task.lastError, undefined);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test('dependency watcher does not recover failed repair task when current worktree evidence is gone', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-failed-repair-clean-'));
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-failed-repair-clean-log-'));
  const logPath = path.join(taskDir, 'agent.log');

  try {
    git(repoDir, ['init']);
    git(repoDir, ['config', 'user.email', 'test@example.com']);
    git(repoDir, ['config', 'user.name', 'Test User']);

    const filePath = path.join(repoDir, 'tracked.txt');
    fs.writeFileSync(filePath, 'base\n');
    git(repoDir, ['add', 'tracked.txt']);
    git(repoDir, ['commit', '-m', 'initial']);

    const baseCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();

    fs.writeFileSync(logPath, `
**Result**
The worktree now enforces the topology approval boundaries in code and tests.

**Verification**
\`npm test\` at the repo root passed.

Suggested commit message: feat: recover failed finalize repair
`);

    const stateManager = new FakeStateManager([
      {
        id: 'failed-repair-clean',
        prdPath: '/tmp/prd.json',
        status: 'failed',
        startTime: 100,
        completedUS: ['US-001', 'US-002'],
        storyProgress: [
          { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
          { id: 'US-002', status: 'passed', attempts: 1, updatedAt: 1 },
          {
            id: 'US-003',
            status: 'failed',
            attempts: 2,
            lastEvidence: '3 file(s) changed in working tree',
            lastError: 'Agent reported success for US-003, but Ralph found no objective diff or commit evidence',
            updatedAt: 1,
          },
        ],
        worktree: repoDir,
        logPath,
        agent: 'codex',
        repoPath: '/repo',
        baseCommitSha,
        loopCount: 2,
        consecutiveNoProgress: 1,
        consecutiveErrors: 0,
        lastProgressTime: 100,
        lastFilesChanged: 0,
        lastError: 'Agent reported success for US-003, but Ralph found no objective diff or commit evidence',
      },
    ]);

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
      }
    );

    await watcher.recoverSoftFailedTasks();
    const task = stateManager.tasks.get('failed-repair-clean');
    assert.equal(task.status, 'failed');
    assert.deepEqual(task.completedUS, ['US-001', 'US-002']);
    assert.equal(task.storyProgress[2].status, 'failed');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test('dependency watcher recovers failed repair task without prior story evidence when retained task evidence still exists', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-failed-repair-retained-'));
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-failed-repair-retained-log-'));
  const logPath = path.join(taskDir, 'agent.log');

  try {
    git(repoDir, ['init']);
    git(repoDir, ['config', 'user.email', 'test@example.com']);
    git(repoDir, ['config', 'user.name', 'Test User']);

    const filePath = path.join(repoDir, 'tracked.txt');
    fs.writeFileSync(filePath, 'base\n');
    git(repoDir, ['add', 'tracked.txt']);
    git(repoDir, ['commit', '-m', 'initial']);

    const baseCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();

    fs.writeFileSync(filePath, 'review drill intake retained in worktree\n');
    fs.writeFileSync(logPath, `
**Done**
- Wired the selection actions into review/drill intake.

**Validation**
- Passed targeted tests

Suggested commit message: feat: retain task-level evidence for selection action loop
`);

    const stateManager = new FakeStateManager([
      {
        id: 'failed-repair-retained-evidence',
        prdPath: '/tmp/prd.json',
        status: 'failed',
        startTime: 100,
        completedUS: ['US-001', 'US-002', 'US-003'],
        storyProgress: [
          { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
          { id: 'US-002', status: 'passed', attempts: 1, updatedAt: 1 },
          { id: 'US-003', status: 'passed', attempts: 2, updatedAt: 1 },
          {
            id: 'US-004',
            status: 'failed',
            attempts: 2,
            lastError: 'Agent reported success for US-004, but Ralph found no objective diff or commit evidence',
            updatedAt: 1,
          },
        ],
        worktree: repoDir,
        logPath,
        agent: 'codex',
        repoPath: '/repo',
        baseCommitSha,
        loopCount: 6,
        consecutiveNoProgress: 2,
        consecutiveErrors: 0,
        lastProgressTime: 100,
        lastFilesChanged: 0,
        lastError: 'Agent reported success for US-004, but Ralph found no objective diff or commit evidence',
      },
    ]);

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
      }
    );

    await watcher.recoverSoftFailedTasks();
    const task = stateManager.tasks.get('failed-repair-retained-evidence');
    assert.equal(task.status, 'ready_to_finalize');
    assert.deepEqual(task.completedUS, ['US-001', 'US-002', 'US-003', 'US-004']);
    assert.equal(task.storyProgress[3].status, 'passed');
    assert.equal(task.lastError, undefined);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test('dependency watcher does not soft-recover merge repair failures without an exact worktree mergeability pass', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-soft-failed-merge-proof-repo-'));
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-soft-failed-merge-proof-log-'));
  const logPath = path.join(taskDir, 'agent.log');
  fs.writeFileSync(logPath, `
**Done**
- Resolved the merge markers in the temp integration sandbox

**Validation**
- Targeted tests passed
`);

  try {
    git(repoDir, ['init']);
    git(repoDir, ['config', 'user.email', 'test@example.com']);
    git(repoDir, ['config', 'user.name', 'Test User']);

    const filePath = path.join(repoDir, 'tracked.txt');
    fs.writeFileSync(filePath, 'base\n');
    git(repoDir, ['add', 'tracked.txt']);
    git(repoDir, ['commit', '-m', 'initial']);

    const baseCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();

    fs.writeFileSync(filePath, 'merge repair still present in task worktree\n');

    const stateManager = new FakeStateManager([
      {
        id: 'soft-failed-merge-proof',
        prdPath: '/tmp/prd.json',
        status: 'failed',
        startTime: 100,
        completedUS: ['US-001'],
        storyProgress: [
          { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
          {
            id: 'US-002',
            status: 'failed',
            attempts: 2,
            lastEvidence: 'Retained task-level worktree evidence',
            lastError: 'Agent reported success for US-002, but Ralph found no objective diff or commit evidence',
            updatedAt: 1,
          },
        ],
        worktree: repoDir,
        logPath,
        agent: 'codex',
        repoPath: '/repo',
        baseCommitSha,
        loopCount: 2,
        consecutiveNoProgress: 0,
        consecutiveErrors: 1,
        lastProgressTime: 100,
        lastFilesChanged: 2,
        repairContext: {
          mode: 'merge',
          storyId: 'US-002',
          createdAt: 10,
          reason: 'Merge repair required by Ralph.',
        },
        postFinalizeMergeProbeRequired: true,
      },
    ]);

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
        probeWorktreeMergeability: async () => ({
          mergeable: false,
          alreadyIntegrated: false,
          message: 'Merge conflicts detected: docs/TODO.md',
          conflictFiles: ['docs/TODO.md'],
          integrationBranch: 'ralph/integration/main',
          integrationWorktree: '/tmp/integration',
        }),
      }
    );

    await watcher.recoverSoftFailedTasks();
    const task = stateManager.tasks.get('soft-failed-merge-proof');
    assert.equal(task.status, 'failed');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test('dependency watcher soft-recovers merge repair failures only after exact worktree mergeability passes', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-soft-failed-merge-proof-pass-repo-'));
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-soft-failed-merge-proof-pass-log-'));
  const logPath = path.join(taskDir, 'agent.log');
  fs.writeFileSync(logPath, `
**Done**
- Reconciled the merge repair on the task worktree

**Validation**
- Targeted tests passed
`);

  try {
    git(repoDir, ['init']);
    git(repoDir, ['config', 'user.email', 'test@example.com']);
    git(repoDir, ['config', 'user.name', 'Test User']);

    const filePath = path.join(repoDir, 'tracked.txt');
    fs.writeFileSync(filePath, 'base\n');
    git(repoDir, ['add', 'tracked.txt']);
    git(repoDir, ['commit', '-m', 'initial']);

    const baseCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();

    fs.writeFileSync(filePath, 'merge repair retained in task worktree\n');

    const stateManager = new FakeStateManager([
      {
        id: 'soft-failed-merge-proof-pass',
        prdPath: '/tmp/prd.json',
        status: 'failed',
        startTime: 100,
        completedUS: ['US-001'],
        storyProgress: [
          { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
          {
            id: 'US-002',
            status: 'failed',
            attempts: 2,
            lastEvidence: 'Retained task-level worktree evidence',
            lastError: 'Agent reported success for US-002, but Ralph found no objective diff or commit evidence',
            updatedAt: 1,
          },
        ],
        worktree: repoDir,
        logPath,
        agent: 'codex',
        repoPath: '/repo',
        baseCommitSha,
        loopCount: 2,
        consecutiveNoProgress: 0,
        consecutiveErrors: 1,
        lastProgressTime: 100,
        lastFilesChanged: 2,
        repairContext: {
          mode: 'merge',
          storyId: 'US-002',
          createdAt: 10,
          reason: 'Merge repair required by Ralph.',
        },
        postFinalizeMergeProbeRequired: true,
      },
    ]);

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
        probeWorktreeMergeability: async () => ({
          mergeable: true,
          alreadyIntegrated: false,
          message: 'ralph/task can merge cleanly',
          integrationBranch: 'ralph/integration/main',
          integrationWorktree: '/tmp/integration',
        }),
      }
    );

    await watcher.recoverSoftFailedTasks();
    const task = stateManager.tasks.get('soft-failed-merge-proof-pass');
    assert.equal(task.status, 'ready_to_finalize');
    assert.equal(task.postFinalizeMergeProbeRequired, true);
    assert.equal(task.mergeConflictFiles, undefined);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test('dependency watcher requeues failed worker merge-repair tasks when the exact probe still fails', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-worker-merge-repair',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'failed', attempts: 2, lastError: 'Exact mergeability probe still fails', updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/failed-worker-merge-repair',
      logPath: '/tmp/failed-worker-merge-repair.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 4,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Exact mergeability probe still fails against ralph/integration/main',
      repairContext: {
        mode: 'merge',
        storyId: 'US-002',
        createdAt: Date.now(),
        reason: 'Merge repair required by Ralph.',
      },
      mergeError: 'Merge conflicts detected: docs/TODO.md',
      mergeConflictFiles: ['docs/TODO.md'],
      postFinalizeMergeProbeRequired: true,
    },
  ]);

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
      probeWorktreeMergeability: async () => ({
        mergeable: false,
        alreadyIntegrated: false,
        message: 'Merge conflicts detected: docs/TODO.md',
        conflictFiles: ['docs/TODO.md'],
        integrationBranch: 'ralph/integration/main',
        integrationWorktree: '/tmp/integration',
      }),
    },
  );

  await watcher.recoverFailedWorkerMergeRepairTasks();
  const task = stateManager.tasks.get('failed-worker-merge-repair');
  assert.equal(task.status, 'pending');
  assert.equal(task.repairContext.mode, 'merge');
  assert.equal(task.repairContext.storyId, 'US-002');
  assert.equal(task.storyProgress[1].status, 'needs_repair');
  assert.equal(task.storyProgress[1].attempts, 0);
  assert.equal(task.mergeRepairRecoveryTotalRequeues, 1);
  assert.equal(task.autoRecoveryKind, 'merge_repair');
  assert.equal(task.autoRecoveryTotalRequeues, 1);
  assert.equal(task.postFinalizeMergeProbeRequired, true);
});

test('dependency watcher recovers failed worker merge-repair tasks into finalize when the exact probe passes', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-worker-merge-pass',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'failed', attempts: 2, lastError: 'Exact mergeability probe still fails', updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/failed-worker-merge-pass',
      logPath: '/tmp/failed-worker-merge-pass.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 4,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Exact mergeability probe still fails against ralph/integration/main',
      repairContext: {
        mode: 'merge',
        storyId: 'US-002',
        createdAt: Date.now(),
        reason: 'Merge repair required by Ralph.',
      },
      mergeError: 'Merge conflicts detected: docs/TODO.md',
      mergeConflictFiles: ['docs/TODO.md'],
      postFinalizeMergeProbeRequired: true,
    },
  ]);

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
      probeWorktreeMergeability: async () => ({
        mergeable: true,
        alreadyIntegrated: false,
        message: 'ralph/task can merge cleanly',
        integrationBranch: 'ralph/integration/main',
        integrationWorktree: '/tmp/integration',
      }),
    },
  );

  await watcher.recoverFailedWorkerMergeRepairTasks();
  const task = stateManager.tasks.get('failed-worker-merge-pass');
  assert.equal(task.status, 'ready_to_finalize');
  assert.deepEqual(task.completedUS, ['US-001', 'US-002']);
  assert.equal(task.storyProgress[1].status, 'passed');
  assert.equal(task.repairContext, undefined);
  assert.equal(task.mergeConflictFiles, undefined);
  assert.equal(task.postFinalizeMergeProbeRequired, true);
});

test('dependency watcher gives legacy merge-repair failures a fresh recovery window before stopping', async () => {
  const staleRepairCreatedAt = Date.now() - (3 * 60 * 60 * 1000);
  const stateManager = new FakeStateManager([
    {
      id: 'failed-worker-merge-legacy-window',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'failed', attempts: 2, lastError: 'Exact mergeability probe still fails', updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/failed-worker-merge-legacy-window',
      logPath: '/tmp/failed-worker-merge-legacy-window.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 4,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Exact mergeability probe still fails against ralph/integration/main',
      repairContext: {
        mode: 'merge',
        storyId: 'US-002',
        createdAt: staleRepairCreatedAt,
        reason: 'Merge repair required by Ralph.',
      },
      mergeError: 'Merge conflicts detected: docs/TODO.md',
      mergeConflictFiles: ['docs/TODO.md'],
      postFinalizeMergeProbeRequired: true,
    },
  ]);

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
      probeWorktreeMergeability: async () => ({
        mergeable: false,
        alreadyIntegrated: false,
        message: 'Merge conflicts detected: docs/TODO.md',
        conflictFiles: ['docs/TODO.md'],
        integrationBranch: 'ralph/integration/main',
        integrationWorktree: '/tmp/integration',
      }),
    },
  );

  await watcher.recoverFailedWorkerMergeRepairTasks();
  const task = stateManager.tasks.get('failed-worker-merge-legacy-window');
  assert.equal(task.status, 'pending');
  assert.equal(task.mergeRepairRecoveryStopReason, undefined);
  assert.ok(task.mergeRepairRecoveryStartedAt >= staleRepairCreatedAt + (2 * 60 * 60 * 1000));
  assert.ok(task.mergeRepairRecoveryDeadlineAt > Date.now());
});

test('dependency watcher backfills legacy transient failures and schedules bounded recovery', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-transient-legacy',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: [],
      storyProgress: [
        { id: 'US-001', status: 'failed', attempts: 2, lastError: 'high demand', updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/failed-transient-legacy',
      logPath: '/tmp/failed-transient-legacy.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 2,
      consecutiveErrors: 2,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'ERROR: Reconnecting... 1/5\nERROR: We are currently experiencing high demand, which may cause temporary errors.',
    },
  ]);

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
    },
  );

  await watcher.recoverFailedTransientTasks();
  const task = stateManager.tasks.get('failed-transient-legacy');
  assert.equal(task.status, 'failed');
  assert.equal(task.lastErrorKind, 'backend_high_demand');
  assert.equal(task.lastErrorClass, 'transient_backend');
  assert.equal(task.lastErrorRetryable, true);
  assert.equal(task.autoRecoveryKind, 'transient');
  assert.ok(task.transientRecoveryNextEligibleAt > Date.now());
});

test('dependency watcher requeues Codex context-window failures in a fresh conversation', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-agent-context',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        {
          id: 'US-002',
          status: 'failed',
          attempts: 2,
          lastError: 'ERROR: Codex ran out of room in the model context window. Start a new thread or clear earlier history before retrying.',
          updatedAt: 2,
        },
      ],
      worktree: '/repo/.ralph-worktrees/failed-agent-context',
      logPath: '/tmp/failed-agent-context.log',
      agent: 'codex',
      repoPath: '/repo',
      sessionId: 'old-session',
      threadId: 'old-thread',
      threadStoryId: 'US-002',
      loopCount: 4,
      consecutiveNoProgress: 2,
      consecutiveErrors: 2,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'unknown failure',
      lastErrorKind: 'unknown_no_progress',
      lastErrorClass: 'unknown',
      lastErrorRetryable: false,
    },
  ]);

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
    },
  );

  await watcher.recoverFailedAgentContextTasks();
  const task = stateManager.tasks.get('failed-agent-context');
  assert.equal(task.status, 'pending');
  assert.equal(task.completedUS.length, 1);
  assert.equal(task.storyProgress[0].status, 'passed');
  assert.equal(task.storyProgress[1].status, 'pending');
  assert.equal(task.storyProgress[1].attempts, 0);
  assert.equal(task.sessionId, undefined);
  assert.equal(task.threadId, undefined);
  assert.equal(task.threadStoryId, undefined);
  assert.equal(task.autoRecoveryKind, 'agent_context');
  assert.equal(task.agentContextRecoveryTotalRequeues, 1);
  assert.equal(task.autoRecoveryTotalRequeues, 1);
  assert.equal(task.lastErrorKind, undefined);
});

test('dependency watcher stops Codex context-window recovery after one fresh-conversation retry', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-agent-context-budget',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: [],
      storyProgress: [
        {
          id: 'US-001',
          status: 'failed',
          attempts: 1,
          lastError: 'ERROR: Codex ran out of room in the model context window.',
          updatedAt: 1,
        },
      ],
      worktree: '/repo/.ralph-worktrees/failed-agent-context-budget',
      logPath: '/tmp/failed-agent-context-budget.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'ERROR: Codex ran out of room in the model context window.',
      lastErrorKind: 'agent_context_window_exhausted',
      lastErrorClass: 'agent_session',
      lastErrorRetryable: true,
      agentContextRecoveryTotalRequeues: 1,
      autoRecoveryKind: 'agent_context',
      autoRecoveryTotalRequeues: 1,
    },
  ]);

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
    },
  );

  await watcher.recoverFailedAgentContextTasks();
  const task = stateManager.tasks.get('failed-agent-context-budget');
  assert.equal(task.status, 'failed');
  assert.equal(task.agentContextRecoveryStopReason, 'agent_context_budget_exhausted');
  assert.equal(task.autoRecoveryStopReason, 'agent_context_budget_exhausted');
});

test('dependency watcher refreshes never-requeued legacy context windows instead of leaving them stopped', async () => {
  const staleStartedAt = Date.now() - (3 * 60 * 60 * 1000);
  const stateManager = new FakeStateManager([
    {
      id: 'failed-agent-context-legacy-window',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: [],
      storyProgress: [
        {
          id: 'US-001',
          status: 'failed',
          attempts: 2,
          lastError: 'ERROR: Codex ran out of room in the model context window.',
          updatedAt: 1,
        },
      ],
      worktree: '/repo/.ralph-worktrees/failed-agent-context-legacy-window',
      logPath: '/tmp/failed-agent-context-legacy-window.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 2,
      consecutiveErrors: 2,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'ERROR: Codex ran out of room in the model context window.',
      lastErrorKind: 'unknown_no_progress',
      lastErrorClass: 'unknown',
      lastErrorRetryable: false,
      lastErrorSignature: 'unknown_no_progress',
      agentContextRecoveryStartedAt: staleStartedAt,
      agentContextRecoveryDeadlineAt: staleStartedAt + 60_000,
      agentContextRecoveryStoppedAt: staleStartedAt + 60_000,
      agentContextRecoveryStopReason: 'agent_context_deadline_exhausted',
      agentContextRecoveryTotalRequeues: 0,
      autoRecoveryKind: 'agent_context',
      autoRecoveryStoppedAt: staleStartedAt + 60_000,
      autoRecoveryStopReason: 'agent_context_deadline_exhausted',
    },
  ]);

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
    },
  );

  await watcher.recoverFailedAgentContextTasks();
  const task = stateManager.tasks.get('failed-agent-context-legacy-window');
  assert.equal(task.status, 'pending');
  assert.equal(task.agentContextRecoveryStopReason, undefined);
  assert.equal(task.autoRecoveryStopReason, undefined);
  assert.equal(task.agentContextRecoveryLastSignature, 'agent_context_window_exhausted');
  assert.ok(task.agentContextRecoveryStartedAt > staleStartedAt);
  assert.equal(task.agentContextRecoveryTotalRequeues, 1);
});

test('dependency watcher revives stopped context recovery when the requeue budget is raised', async () => {
  const stoppedAt = Date.now() - 60_000;
  const stateManager = new FakeStateManager([
    {
      id: 'failed-agent-context-raised-budget',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: [],
      storyProgress: [
        {
          id: 'US-001',
          status: 'failed',
          attempts: 1,
          lastError: 'ERROR: Codex ran out of room in the model context window.',
          updatedAt: 1,
        },
      ],
      worktree: '/repo/.ralph-worktrees/failed-agent-context-raised-budget',
      logPath: '/tmp/failed-agent-context-raised-budget.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'ERROR: Codex ran out of room in the model context window.',
      lastErrorKind: 'agent_context_window_exhausted',
      lastErrorClass: 'agent_session',
      lastErrorRetryable: true,
      agentContextRecoveryStartedAt: stoppedAt - 60_000,
      agentContextRecoveryDeadlineAt: stoppedAt + 60_000,
      agentContextRecoveryTotalRequeues: 1,
      agentContextRecoveryStoppedAt: stoppedAt,
      agentContextRecoveryStopReason: 'agent_context_budget_exhausted',
      autoRecoveryKind: 'agent_context',
      autoRecoveryTotalRequeues: 1,
      autoRecoveryStoppedAt: stoppedAt,
      autoRecoveryStopReason: 'agent_context_budget_exhausted',
    },
  ]);

  const watcher = new DependencyWatcher(
    {},
    {
      stateManager,
      configManager: createConfigManager({
        'runner.maxAgentContextRecoveryRequeues': 2,
      }),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      sleep: async () => undefined,
      logger: { log() {}, error() {} },
    },
  );

  await watcher.recoverFailedAgentContextTasks();
  const task = stateManager.tasks.get('failed-agent-context-raised-budget');
  assert.equal(task.status, 'pending');
  assert.equal(task.agentContextRecoveryTotalRequeues, 2);
  assert.equal(task.agentContextRecoveryStopReason, undefined);
  assert.equal(task.autoRecoveryStopReason, undefined);
});

test('dependency watcher requeues transient failures after cooldown while preserving merge repair context', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-transient-requeue',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'failed', attempts: 2, lastError: 'transport reconnecting', updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/failed-transient-requeue',
      logPath: '/tmp/failed-transient-requeue.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 2,
      consecutiveErrors: 2,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Connection lost while streaming output, reconnecting now.',
      lastErrorKind: 'transport_reconnecting',
      lastErrorClass: 'transport',
      lastErrorRetryable: true,
      lastErrorSignature: 'transport_reconnecting',
      lastErrorHadObjectiveProgress: false,
      repairContext: {
        mode: 'merge',
        storyId: 'US-002',
        createdAt: 10,
        reason: 'Merge repair required by Ralph.',
      },
      transientRecoveryStartedAt: Date.now() - 5000,
      transientRecoveryDeadlineAt: Date.now() + 60000,
      transientRecoveryTotalRequeues: 0,
      transientRecoveryConsecutiveSameSignature: 1,
      transientRecoveryLastFailureKind: 'transport_reconnecting',
      transientRecoveryLastFailureClass: 'transport',
      transientRecoveryLastFailureSignature: 'transport_reconnecting',
      transientRecoveryNextEligibleAt: Date.now() - 1000,
      autoRecoveryKind: 'transient',
      autoRecoveryTotalRequeues: 0,
      autoRecoveryHardCap: 20,
    },
  ]);

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
    },
  );

  await watcher.recoverFailedTransientTasks();
  const task = stateManager.tasks.get('failed-transient-requeue');
  assert.equal(task.status, 'pending');
  assert.equal(task.storyProgress[1].status, 'pending');
  assert.equal(task.storyProgress[1].attempts, 0);
  assert.equal(task.repairContext.mode, 'merge');
  assert.equal(task.transientRecoveryTotalRequeues, 1);
  assert.equal(task.autoRecoveryTotalRequeues, 1);
  assert.equal(task.transientRetryCount, 0);
});

test('dependency watcher stops obsolete baseline repair transient recovery', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'obsolete-baseline-repair',
      prdPath: '/tmp/baseline-repair.json',
      prdId: 'baseline-quality-gate:obsolete',
      status: 'failed',
      startTime: 100,
      completedUS: [],
      storyProgress: [
        { id: 'US-001', status: 'failed', attempts: 2, lastError: 'transport timeout', updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/obsolete-baseline-repair',
      logPath: '/tmp/obsolete-baseline-repair.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 2,
      consecutiveErrors: 2,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: '[Agent] Timed out after 600s; sending SIGTERM',
      lastErrorKind: 'transport_timeout',
      lastErrorClass: 'transport',
      lastErrorRetryable: true,
      lastErrorSignature: 'transport_timeout',
      lastErrorHadObjectiveProgress: false,
      baselineRepair: {
        repairKey: 'baseline-quality-gate|main|test|old',
        targetBranch: 'main',
        gate: 'test',
        packageLabel: 'task-id',
        demandTaskIds: ['demand-task'],
        startedAt: 1,
        updatedAt: 1,
      },
      transientRecoveryStartedAt: Date.now() - 5000,
      transientRecoveryDeadlineAt: Date.now() + 60000,
      transientRecoveryTotalRequeues: 0,
      transientRecoveryConsecutiveSameSignature: 1,
      transientRecoveryLastFailureKind: 'transport_timeout',
      transientRecoveryLastFailureClass: 'transport',
      transientRecoveryLastFailureSignature: 'transport_timeout',
      transientRecoveryNextEligibleAt: Date.now() - 1000,
      autoRecoveryKind: 'transient',
      autoRecoveryTotalRequeues: 0,
      autoRecoveryHardCap: 20,
    },
    {
      id: 'demand-task',
      prdPath: '/tmp/demand.json',
      prdId: 'demand-prd',
      status: 'failed_finalize',
      startTime: 99,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/demand-task',
      logPath: '/tmp/demand.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 1,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      lastErrorKind: 'quality_gate_failure',
      latestFailure: {
        id: 'failure-1',
        observedAt: 1,
        kind: 'quality_gate',
        gate: 'test',
        packageLabel: 'apps/api',
        command: 'pnpm test',
        signature: 'test|apps/api|pnpm test',
        rawMessage: 'api test failed',
      },
      baselineQualityGate: {
        kind: 'baseline_probe_failed',
        observedAt: 1,
        targetBranch: 'main',
        gate: 'test',
        packageLabel: 'apps/api',
        signature: 'test|apps/api|pnpm test',
        latestFailureSignature: 'test|apps/api|pnpm test',
        taskFailureSignature: 'test|apps/api|pnpm test',
        message: 'target baseline worktree is dirty',
      },
    },
  ]);

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
    },
  );

  await watcher.recoverFailedTransientTasks();
  const task = stateManager.tasks.get('obsolete-baseline-repair');
  assert.equal(task.status, 'failed');
  assert.equal(task.autoRecoveryStopReason, 'obsolete_baseline_repair');
  assert.equal(task.transientRecoveryStopReason, 'obsolete_baseline_repair');
  assert.equal(task.transientRecoveryNextEligibleAt, undefined);
});

test('dependency watcher still requeues retryable transient failures when the failed attempt had objective progress', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-transient-progress-requeue',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        {
          id: 'US-002',
          status: 'failed',
          attempts: 2,
          lastEvidence: 'working tree diff content changed',
          lastError: 'transport reconnecting',
          updatedAt: 1,
        },
      ],
      worktree: '/repo/.ralph-worktrees/failed-transient-progress-requeue',
      logPath: '/tmp/failed-transient-progress-requeue.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 0,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      lastError: 'Connection lost while streaming output, reconnecting now.',
      lastErrorKind: 'transport_reconnecting',
      lastErrorClass: 'transport',
      lastErrorRetryable: true,
      lastErrorSignature: 'transport_reconnecting',
      lastErrorHadObjectiveProgress: true,
      repairContext: {
        mode: 'merge',
        storyId: 'US-002',
        createdAt: 10,
        reason: 'Merge repair required by Ralph.',
      },
      transientRecoveryStartedAt: Date.now() - 5000,
      transientRecoveryDeadlineAt: Date.now() + 60000,
      transientRecoveryTotalRequeues: 0,
      transientRecoveryConsecutiveSameSignature: 1,
      transientRecoveryLastFailureKind: 'transport_reconnecting',
      transientRecoveryLastFailureClass: 'transport',
      transientRecoveryLastFailureSignature: 'transport_reconnecting',
      transientRecoveryNextEligibleAt: Date.now() - 1000,
      autoRecoveryKind: 'stagnant',
      autoRecoveryTotalRequeues: 2,
      autoRecoveryHardCap: 20,
    },
  ]);

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
    },
  );

  await watcher.recoverFailedTransientTasks();
  const task = stateManager.tasks.get('failed-transient-progress-requeue');
  assert.equal(task.status, 'pending');
  assert.equal(task.storyProgress[1].status, 'needs_repair');
  assert.equal(task.storyProgress[1].attempts, 0);
  assert.equal(task.repairContext.mode, 'merge');
  assert.equal(task.transientRecoveryTotalRequeues, 1);
  assert.equal(task.autoRecoveryKind, 'transient');
  assert.equal(task.autoRecoveryTotalRequeues, 3);
  assert.equal(task.lastErrorHadObjectiveProgress, true);
});

test('dependency watcher requeues progressful same-signature timeouts instead of stopping', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-transient-progress-same-signature',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001', 'US-002'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'passed', attempts: 1, updatedAt: 2 },
        { id: 'US-003', status: 'failed', attempts: 2, lastError: 'Timed out after 600s', updatedAt: 3 },
      ],
      worktree: '/repo/.ralph-worktrees/failed-transient-progress-same-signature',
      logPath: '/tmp/failed-transient-progress-same-signature.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 0,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 3,
      lastError: 'Timed out after 600s; sending SIGTERM',
      lastErrorKind: 'transport_timeout',
      lastErrorClass: 'transport',
      lastErrorRetryable: true,
      lastErrorSignature: 'transport_timeout',
      lastErrorHadObjectiveProgress: true,
      lastErrorObservedAt: 2000,
      transientRecoveryStartedAt: Date.now() - 5000,
      transientRecoveryDeadlineAt: Date.now() + 60000,
      transientRecoveryTotalRequeues: 1,
      transientRecoveryConsecutiveSameSignature: 2,
      transientRecoveryLastFailureKind: 'transport_timeout',
      transientRecoveryLastFailureClass: 'transport',
      transientRecoveryLastFailureSignature: 'transport_timeout',
      transientRecoveryLastFailureObservedAt: 1000,
      transientRecoveryLastFailureStoryId: 'US-003',
      transientRecoveryNextEligibleAt: Date.now() - 1000,
      autoRecoveryKind: 'transient',
      autoRecoveryTotalRequeues: 1,
      autoRecoveryHardCap: 20,
    },
  ]);

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
    },
  );

  await watcher.recoverFailedTransientTasks();
  const task = stateManager.tasks.get('failed-transient-progress-same-signature');
  assert.equal(task.status, 'pending');
  assert.equal(task.storyProgress[2].status, 'needs_repair');
  assert.equal(task.storyProgress[2].attempts, 0);
  assert.equal(task.transientRecoveryStopReason, undefined);
  assert.equal(task.autoRecoveryStopReason, undefined);
  assert.equal(task.transientRecoveryTotalRequeues, 2);
  assert.equal(task.autoRecoveryTotalRequeues, 2);
  assert.equal(task.transientRecoveryLastRequeuedStoryId, 'US-003');
  assert.equal(task.transientRecoveryLastFailureStoryId, 'US-003');
  assert.equal(task.transientRecoveryLastFailureObservedAt, 2000);
});

test('dependency watcher does not increment same-signature count for the same failure observation twice', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-transient-same-observation',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: [],
      storyProgress: [
        { id: 'US-001', status: 'failed', attempts: 2, lastError: 'Timed out after 600s', updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/failed-transient-same-observation',
      logPath: '/tmp/failed-transient-same-observation.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Timed out after 600s; sending SIGTERM',
      lastErrorKind: 'transport_timeout',
      lastErrorClass: 'transport',
      lastErrorRetryable: true,
      lastErrorSignature: 'transport_timeout',
      lastErrorHadObjectiveProgress: false,
      lastErrorObservedAt: 1000,
      transientRecoveryStartedAt: Date.now() - 5000,
      transientRecoveryDeadlineAt: Date.now() + 60000,
      transientRecoveryTotalRequeues: 1,
      transientRecoveryConsecutiveSameSignature: 1,
      transientRecoveryLastFailureKind: 'transport_timeout',
      transientRecoveryLastFailureClass: 'transport',
      transientRecoveryLastFailureSignature: 'transport_timeout',
      transientRecoveryLastFailureObservedAt: 1000,
      transientRecoveryLastFailureStoryId: 'US-001',
      transientRecoveryNextEligibleAt: Date.now() - 1000,
      autoRecoveryKind: 'transient',
      autoRecoveryTotalRequeues: 1,
      autoRecoveryHardCap: 20,
    },
  ]);

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
    },
  );

  await watcher.recoverFailedTransientTasks();
  const task = stateManager.tasks.get('failed-transient-same-observation');
  assert.equal(task.status, 'pending');
  assert.equal(task.transientRecoveryConsecutiveSameSignature, 1);
});

test('dependency watcher scopes same-signature timeout recovery to the failed story', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-transient-story-scope',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001', 'US-002'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'passed', attempts: 2, updatedAt: 2 },
        { id: 'US-003', status: 'failed', attempts: 2, lastError: 'Timed out after 600s', updatedAt: 3 },
      ],
      worktree: '/repo/.ralph-worktrees/failed-transient-story-scope',
      logPath: '/tmp/failed-transient-story-scope.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 0,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 3,
      lastError: 'Timed out after 600s; sending SIGTERM',
      lastErrorKind: 'transport_timeout',
      lastErrorClass: 'transport',
      lastErrorRetryable: true,
      lastErrorSignature: 'transport_timeout',
      lastErrorHadObjectiveProgress: true,
      lastErrorObservedAt: 2000,
      transientRecoveryStartedAt: Date.now() - 5000,
      transientRecoveryDeadlineAt: Date.now() + 60000,
      transientRecoveryTotalRequeues: 1,
      transientRecoveryConsecutiveSameSignature: 2,
      transientRecoveryLastFailureKind: 'transport_timeout',
      transientRecoveryLastFailureClass: 'transport',
      transientRecoveryLastFailureSignature: 'transport_timeout',
      transientRecoveryLastFailureObservedAt: 1000,
      transientRecoveryLastFailureStoryId: 'US-002',
      transientRecoveryLastRequeuedStoryId: 'US-002',
      transientRecoveryNextEligibleAt: Date.now() - 1000,
      autoRecoveryKind: 'transient',
      autoRecoveryTotalRequeues: 1,
      autoRecoveryHardCap: 20,
    },
  ]);

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
    },
  );

  await watcher.recoverFailedTransientTasks();
  const task = stateManager.tasks.get('failed-transient-story-scope');
  assert.equal(task.status, 'pending');
  assert.equal(task.storyProgress[2].status, 'needs_repair');
  assert.equal(task.transientRecoveryConsecutiveSameSignature, 1);
  assert.equal(task.transientRecoveryStopReason, undefined);
  assert.equal(task.transientRecoveryLastFailureStoryId, 'US-003');
});

test('dependency watcher revives stopped same-signature timeout recovery when progress was observed', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-transient-revive-progress',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001', 'US-002'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'passed', attempts: 1, updatedAt: 2 },
        { id: 'US-003', status: 'failed', attempts: 2, lastError: 'Timed out after 600s', updatedAt: 3 },
      ],
      worktree: '/repo/.ralph-worktrees/failed-transient-revive-progress',
      logPath: '/tmp/failed-transient-revive-progress.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 0,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 3,
      lastError: 'Timed out after 600s; sending SIGTERM',
      lastErrorKind: 'transport_timeout',
      lastErrorClass: 'transport',
      lastErrorRetryable: true,
      lastErrorSignature: 'transport_timeout',
      lastErrorHadObjectiveProgress: true,
      lastErrorObservedAt: 2000,
      transientRecoveryStartedAt: Date.now() - 5000,
      transientRecoveryDeadlineAt: Date.now() + 60000,
      transientRecoveryTotalRequeues: 1,
      transientRecoveryConsecutiveSameSignature: 3,
      transientRecoveryLastFailureKind: 'transport_timeout',
      transientRecoveryLastFailureClass: 'transport',
      transientRecoveryLastFailureSignature: 'transport_timeout',
      transientRecoveryLastFailureObservedAt: 1000,
      transientRecoveryLastFailureStoryId: 'US-003',
      transientRecoveryStoppedAt: 123,
      transientRecoveryStopReason: 'transient_same_signature_no_progress',
      autoRecoveryKind: 'transient',
      autoRecoveryTotalRequeues: 1,
      autoRecoveryHardCap: 20,
      autoRecoveryStoppedAt: 123,
      autoRecoveryStopReason: 'transient_same_signature_no_progress',
    },
  ]);

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
    },
  );

  await watcher.recoverFailedTransientTasks();
  const task = stateManager.tasks.get('failed-transient-revive-progress');
  assert.equal(task.status, 'pending');
  assert.equal(task.storyProgress[2].status, 'needs_repair');
  assert.equal(task.storyProgress[2].attempts, 0);
  assert.equal(task.transientRecoveryStoppedAt, undefined);
  assert.equal(task.transientRecoveryStopReason, undefined);
  assert.equal(task.autoRecoveryStoppedAt, undefined);
  assert.equal(task.autoRecoveryStopReason, undefined);
  assert.equal(task.transientRecoveryLastRequeuedStoryId, 'US-003');
  assert.ok(task.transientRecoveryDeadlineAt > Date.now());
});

test('dependency watcher still stops progressful transient recovery at the hard cap', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-transient-progress-hard-cap',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: [],
      storyProgress: [
        { id: 'US-001', status: 'failed', attempts: 2, lastError: 'Timed out after 600s', updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/failed-transient-progress-hard-cap',
      logPath: '/tmp/failed-transient-progress-hard-cap.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 0,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      lastError: 'Timed out after 600s; sending SIGTERM',
      lastErrorKind: 'transport_timeout',
      lastErrorClass: 'transport',
      lastErrorRetryable: true,
      lastErrorSignature: 'transport_timeout',
      lastErrorHadObjectiveProgress: true,
      transientRecoveryStartedAt: Date.now() - 5000,
      transientRecoveryDeadlineAt: Date.now() + 60000,
      transientRecoveryTotalRequeues: 1,
      transientRecoveryConsecutiveSameSignature: 2,
      transientRecoveryLastFailureKind: 'transport_timeout',
      transientRecoveryLastFailureClass: 'transport',
      transientRecoveryLastFailureSignature: 'transport_timeout',
      autoRecoveryKind: 'transient',
      autoRecoveryTotalRequeues: 20,
      autoRecoveryHardCap: 20,
    },
  ]);

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
    },
  );

  await watcher.recoverFailedTransientTasks();
  const task = stateManager.tasks.get('failed-transient-progress-hard-cap');
  assert.equal(task.status, 'failed');
  assert.equal(task.autoRecoveryStopReason, 'auto_recovery_hard_cap_reached');
});

test('dependency watcher still stops progressful transient recovery at the transient requeue budget', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-transient-progress-budget',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: [],
      storyProgress: [
        { id: 'US-001', status: 'failed', attempts: 2, lastError: 'Timed out after 600s', updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/failed-transient-progress-budget',
      logPath: '/tmp/failed-transient-progress-budget.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 0,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      lastError: 'Timed out after 600s; sending SIGTERM',
      lastErrorKind: 'transport_timeout',
      lastErrorClass: 'transport',
      lastErrorRetryable: true,
      lastErrorSignature: 'transport_timeout',
      lastErrorHadObjectiveProgress: true,
      transientRecoveryStartedAt: Date.now() - 5000,
      transientRecoveryDeadlineAt: Date.now() + 60000,
      transientRecoveryTotalRequeues: 5,
      transientRecoveryConsecutiveSameSignature: 2,
      transientRecoveryLastFailureKind: 'transport_timeout',
      transientRecoveryLastFailureClass: 'transport',
      transientRecoveryLastFailureSignature: 'transport_timeout',
      autoRecoveryKind: 'transient',
      autoRecoveryTotalRequeues: 1,
      autoRecoveryHardCap: 20,
    },
  ]);

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
    },
  );

  await watcher.recoverFailedTransientTasks();
  const task = stateManager.tasks.get('failed-transient-progress-budget');
  assert.equal(task.status, 'failed');
  assert.equal(task.transientRecoveryStopReason, 'transient_budget_exhausted');
});

test('dependency watcher blocks transient recovery after delivery markers', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-transient-delivered',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: [],
      storyProgress: [
        { id: 'US-001', status: 'failed', attempts: 2, lastError: 'Timed out after 600s', updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/failed-transient-delivered',
      logPath: '/tmp/failed-transient-delivered.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 0,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      lastError: 'Timed out after 600s; sending SIGTERM',
      lastErrorKind: 'transport_timeout',
      lastErrorClass: 'transport',
      lastErrorRetryable: true,
      lastErrorSignature: 'transport_timeout',
      lastErrorHadObjectiveProgress: true,
      finalizerCommitSha: 'abc123',
      transientRecoveryStartedAt: Date.now() - 5000,
      transientRecoveryDeadlineAt: Date.now() + 60000,
      transientRecoveryTotalRequeues: 0,
      transientRecoveryConsecutiveSameSignature: 1,
      transientRecoveryLastFailureKind: 'transport_timeout',
      transientRecoveryLastFailureClass: 'transport',
      transientRecoveryLastFailureSignature: 'transport_timeout',
      autoRecoveryKind: 'transient',
      autoRecoveryTotalRequeues: 0,
      autoRecoveryHardCap: 20,
    },
  ]);

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
    },
  );

  await watcher.recoverFailedTransientTasks();
  const task = stateManager.tasks.get('failed-transient-delivered');
  assert.equal(task.status, 'failed');
  assert.equal(task.transientRecoveryStopReason, 'transient_unsafe_delivery_marker');
});

test('dependency watcher stops repeated same-signature transient failures', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-transient-stop',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: [],
      storyProgress: [
        { id: 'US-001', status: 'failed', attempts: 2, lastError: 'high demand', updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/failed-transient-stop',
      logPath: '/tmp/failed-transient-stop.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 2,
      consecutiveNoProgress: 2,
      consecutiveErrors: 2,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'The backend is under high demand and temporarily errors right now.',
      lastErrorKind: 'backend_high_demand',
      lastErrorClass: 'transient_backend',
      lastErrorRetryable: true,
      lastErrorSignature: 'backend_high_demand',
      lastErrorHadObjectiveProgress: false,
      transientRecoveryStartedAt: Date.now() - 5000,
      transientRecoveryDeadlineAt: Date.now() + 60000,
      transientRecoveryTotalRequeues: 1,
      transientRecoveryConsecutiveSameSignature: 2,
      transientRecoveryLastFailureKind: 'backend_high_demand',
      transientRecoveryLastFailureClass: 'transient_backend',
      transientRecoveryLastFailureSignature: 'backend_high_demand',
      autoRecoveryKind: 'transient',
      autoRecoveryTotalRequeues: 1,
      autoRecoveryHardCap: 20,
    },
  ]);

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
    },
  );

  await watcher.recoverFailedTransientTasks();
  const task = stateManager.tasks.get('failed-transient-stop');
  assert.equal(task.status, 'failed');
  assert.equal(task.transientRecoveryStopReason, 'transient_same_signature_no_progress');
  assert.ok(task.transientRecoveryStoppedAt);
});

test('dependency watcher requeues stagnant merge-repair tasks without dropping repair context', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'stagnant-merge-repair',
      prdPath: '/tmp/prd.json',
      status: 'stagnant',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'in_progress', attempts: 2, updatedAt: 2 },
      ],
      worktree: '/repo/.ralph-worktrees/stagnant-merge-repair',
      logPath: '/tmp/stagnant-merge-repair.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 8,
      consecutiveNoProgress: 3,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Running worker made no progress for 1802s; task was marked stagnant for retry',
      lastErrorKind: 'stagnation',
      lastErrorClass: 'stagnation',
      lastErrorRetryable: false,
      lastErrorObservedAt: 200,
      repairContext: {
        mode: 'merge',
        storyId: 'US-002',
        createdAt: 50,
        reason: 'Merge repair required by Ralph.',
      },
      integrationStatus: 'blocked_conflict',
      mergeError: 'Merge conflicts detected: src/conflict.ts',
      mergeConflictFiles: ['src/conflict.ts'],
      mergeRepairAttempts: 2,
    },
  ]);

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
    },
  );

  await watcher.recoverStagnantTasks();
  const task = stateManager.tasks.get('stagnant-merge-repair');
  assert.equal(task.status, 'pending');
  assert.equal(task.currentUS, undefined);
  assert.equal(task.storyProgress[1].status, 'needs_repair');
  assert.equal(task.storyProgress[1].attempts, 0);
  assert.equal(task.repairContext.mode, 'merge');
  assert.equal(task.repairContext.storyId, 'US-002');
  assert.equal(task.integrationStatus, 'blocked_conflict');
  assert.equal(task.mergeError, 'Merge conflicts detected: src/conflict.ts');
  assert.deepEqual(task.mergeConflictFiles, ['src/conflict.ts']);
  assert.equal(task.autoRecoveryKind, 'stagnant');
  assert.equal(task.autoRecoveryTotalRequeues, 1);
  assert.equal(task.autoRecoveryHardCap, 20);
  assert.equal(task.lastError, undefined);
  assert.equal(task.loopCount, 0);
  assert.equal(task.consecutiveNoProgress, 0);
});

test('dependency watcher removes rewound stagnant story from completedUS', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'stagnant-passed-story',
      prdPath: '/tmp/prd.json',
      status: 'stagnant',
      startTime: 100,
      currentUS: 'US-003',
      completedUS: ['US-001', 'US-002', 'US-003'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'passed', attempts: 1, updatedAt: 2 },
        { id: 'US-003', status: 'passed', attempts: 1, updatedAt: 3 },
      ],
      worktree: '/repo/.ralph-worktrees/stagnant-passed-story',
      logPath: '/tmp/stagnant-passed-story.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 8,
      consecutiveNoProgress: 3,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Running worker made no progress for 1802s; task was marked stagnant for retry',
      lastErrorKind: 'stagnation',
      lastErrorClass: 'stagnation',
      lastErrorRetryable: false,
      lastErrorObservedAt: 200,
    },
  ]);

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
    },
  );

  await watcher.recoverStagnantTasks();
  const task = stateManager.tasks.get('stagnant-passed-story');
  assert.equal(task.status, 'pending');
  assert.deepEqual(task.completedUS, ['US-001', 'US-002']);
  assert.equal(task.storyProgress[2].status, 'pending');
  assert.equal(task.storyProgress[2].attempts, 0);
});

test('dependency watcher refreshes merge-repair recovery state after stagnant auto-requeue', async () => {
  const staleStartedAt = Date.now() - (3 * 60 * 60 * 1000);
  const staleDeadlineAt = staleStartedAt + 60_000;
  const stateManager = new FakeStateManager([
    {
      id: 'stagnant-merge-repair-refresh-window',
      prdPath: '/tmp/prd.json',
      status: 'stagnant',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'in_progress', attempts: 2, updatedAt: 2 },
      ],
      worktree: '/repo/.ralph-worktrees/stagnant-merge-repair-refresh-window',
      logPath: '/tmp/stagnant-merge-repair-refresh-window.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 8,
      consecutiveNoProgress: 3,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Running worker made no progress for 1802s; task was marked stagnant for retry',
      lastErrorKind: 'stagnation',
      lastErrorClass: 'stagnation',
      lastErrorRetryable: false,
      lastErrorObservedAt: 200,
      repairContext: {
        mode: 'merge',
        storyId: 'US-002',
        createdAt: staleStartedAt,
        reason: 'Merge repair required by Ralph.',
      },
      integrationStatus: 'blocked_conflict',
      mergeError: 'Merge conflicts detected: src/conflict.ts',
      mergeConflictFiles: ['src/conflict.ts'],
      mergeRepairAttempts: 2,
      mergeRepairRecoveryStartedAt: staleStartedAt,
      mergeRepairRecoveryDeadlineAt: staleDeadlineAt,
      mergeRepairRecoveryTotalRequeues: 2,
      mergeRepairRecoveryConsecutiveNoProgress: 1,
      mergeRepairRecoveryLastConflictSignature: 'src/conflict.ts',
      mergeRepairRecoveryLastProbeMessage: 'Merge conflicts detected: src/conflict.ts',
      mergeRepairRecoveryLastProgressReason: 'Initialized worker merge-repair recovery tracking',
      mergeRepairRecoveryStoppedAt: staleDeadlineAt,
      mergeRepairRecoveryStopReason: 'merge_repair_deadline_exhausted',
    },
  ]);

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
      probeWorktreeMergeability: async () => ({
        mergeable: false,
        alreadyIntegrated: false,
        message: 'Merge conflicts detected: src/conflict.ts',
        conflictFiles: ['src/conflict.ts'],
        integrationBranch: 'ralph/integration/main',
        integrationWorktree: '/tmp/integration',
      }),
    },
  );

  await watcher.recoverStagnantTasks();

  let task = stateManager.tasks.get('stagnant-merge-repair-refresh-window');
  assert.equal(task.status, 'pending');
  assert.equal(task.repairContext.mode, 'merge');
  assert.equal(task.repairContext.storyId, 'US-002');
  assert.equal(task.mergeRepairRecoveryStartedAt, undefined);
  assert.equal(task.mergeRepairRecoveryDeadlineAt, undefined);
  assert.equal(task.mergeRepairRecoveryTotalRequeues, undefined);
  assert.equal(task.mergeRepairRecoveryConsecutiveNoProgress, undefined);
  assert.equal(task.mergeRepairRecoveryStoppedAt, undefined);
  assert.equal(task.mergeRepairRecoveryStopReason, undefined);

  stateManager.tasks.set(task.id, {
    ...task,
    status: 'failed',
    storyProgress: [
      { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
      { id: 'US-002', status: 'needs_repair', attempts: 2, updatedAt: Date.now(), lastError: 'merge failed' },
    ],
    lastError: 'Exact mergeability probe still fails against ralph/integration/main',
    lastErrorKind: 'merge_conflict',
    lastErrorClass: 'merge_conflict',
    lastErrorRetryable: true,
    lastErrorObservedAt: Date.now(),
    lastErrorSignature: 'src/conflict.ts',
  });

  await watcher.recoverFailedWorkerMergeRepairTasks();
  task = stateManager.tasks.get('stagnant-merge-repair-refresh-window');
  assert.equal(task.status, 'pending');
  assert.equal(task.mergeRepairRecoveryStopReason, undefined);
  assert.ok(task.mergeRepairRecoveryStartedAt >= task.repairContext.createdAt);
  assert.ok(task.mergeRepairRecoveryDeadlineAt > Date.now());
});

test('dependency watcher keeps auto-requeueing failed merge repair when the unresolved worktree observation repeats', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-worker-merge-stop-same-state',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'failed', attempts: 2, lastError: 'merge failed', updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/failed-worker-merge-stop-same-state',
      logPath: '/tmp/failed-worker-merge-stop-same-state.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 4,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Exact mergeability probe still fails against ralph/integration/main',
      lastErrorObservedAt: Date.now() - 1000,
      repairContext: {
        mode: 'merge',
        storyId: 'US-002',
        createdAt: Date.now() - 10_000,
        reason: 'Merge repair required by Ralph.',
      },
      mergeError: 'Merge conflicts detected: docs/TODO.md',
      mergeConflictFiles: ['docs/TODO.md'],
      postFinalizeMergeProbeRequired: true,
      mergeRepairRecoveryStartedAt: Date.now() - 5_000,
      mergeRepairRecoveryDeadlineAt: Date.now() + 60_000,
      mergeRepairRecoveryConsecutiveNoProgress: 1,
      mergeRepairRecoveryLastConflictSignature: 'docs/TODO.md',
    },
  ]);

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
      probeWorktreeMergeability: async () => ({
        mergeable: false,
        alreadyIntegrated: false,
        message: 'Merge conflicts detected: docs/TODO.md',
        conflictFiles: ['docs/TODO.md'],
        integrationBranch: 'ralph/integration/main',
        integrationWorktree: '/tmp/integration',
        sourceKind: 'worktree_snapshot',
        worktreeMergeState: {
          kind: 'unresolved',
          usesGitLocal: true,
          gitDir: '/repo/.ralph-worktrees/failed-worker-merge-stop-same-state/.git-local',
          headSha: 'abc123',
          mergeParents: ['def456'],
          unmergedFiles: ['docs/TODO.md'],
          changedFiles: ['docs/TODO.md'],
          statusPorcelain: 'UU docs/TODO.md',
          statusSignature: 'same-state',
        },
      }),
    },
  );

  await watcher.recoverFailedWorkerMergeRepairTasks();
  const task = stateManager.tasks.get('failed-worker-merge-stop-same-state');
  assert.equal(task.status, 'pending');
  assert.equal(task.storyProgress[1].status, 'needs_repair');
  assert.equal(task.mergeRepairRecoveryStopReason, undefined);
  assert.equal(task.mergeRepairRecoveryStoppedAt, undefined);
  assert.equal(task.mergeRepairDisplayStatus, 'requeued');
  assert.equal(task.mergeRepairRecoveryTotalRequeues, 1);
  assert.equal(task.mergeRepairRecoveryConsecutiveNoProgress, 2);
  assert.equal(task.autoRecoveryStoppedAt, undefined);
  assert.equal(task.autoRecoveryStopReason, undefined);
});

test('dependency watcher revives stopped deadline-exhausted merge repair while under the hard cap', async () => {
  const staleStartedAt = Date.now() - (3 * 60 * 60 * 1000);
  const staleDeadlineAt = staleStartedAt + (60 * 60 * 1000);
  const stateManager = new FakeStateManager([
    {
      id: 'failed-worker-merge-revive-deadline',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'failed', attempts: 2, lastError: 'merge failed', updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/failed-worker-merge-revive-deadline',
      logPath: '/tmp/failed-worker-merge-revive-deadline.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 4,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Worker merge repair deadline exhausted',
      lastErrorObservedAt: Date.now() - 1000,
      repairContext: {
        mode: 'merge',
        storyId: 'US-002',
        createdAt: staleStartedAt,
        reason: 'Merge repair required by Ralph.',
      },
      mergeError: 'Merge conflicts detected: docs/TODO.md',
      mergeConflictFiles: ['docs/TODO.md'],
      postFinalizeMergeProbeRequired: true,
      autoRecoveryKind: 'merge_repair',
      autoRecoveryTotalRequeues: 2,
      autoRecoveryHardCap: 20,
      autoRecoveryStoppedAt: Date.now() - 1000,
      autoRecoveryStopReason: 'merge_repair_deadline_exhausted',
      autoRecoveryLastReason: 'Worker merge repair deadline exhausted',
      mergeRepairRecoveryStartedAt: staleStartedAt,
      mergeRepairRecoveryDeadlineAt: staleDeadlineAt,
      mergeRepairRecoveryTotalRequeues: 2,
      mergeRepairRecoveryConsecutiveNoProgress: 1,
      mergeRepairRecoveryLastConflictSignature: 'docs/TODO.md',
      mergeRepairRecoveryStoppedAt: Date.now() - 1000,
      mergeRepairRecoveryStopReason: 'merge_repair_deadline_exhausted',
      mergeRepairDisplayStatus: 'stopped',
    },
  ]);

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
      probeWorktreeMergeability: async () => ({
        mergeable: false,
        alreadyIntegrated: false,
        message: 'Merge conflicts detected: docs/TODO.md',
        conflictFiles: ['docs/TODO.md'],
        integrationBranch: 'ralph/integration/main',
        integrationWorktree: '/tmp/integration',
        sourceKind: 'worktree_snapshot',
        worktreeMergeState: {
          kind: 'unresolved',
          usesGitLocal: true,
          gitDir: '/repo/.ralph-worktrees/failed-worker-merge-revive-deadline/.git-local',
          headSha: 'abc123',
          mergeParents: ['def456'],
          unmergedFiles: ['docs/TODO.md'],
          changedFiles: ['docs/TODO.md'],
          statusPorcelain: 'UU docs/TODO.md',
          statusSignature: 'same-state',
        },
      }),
    },
  );

  await watcher.recoverFailedWorkerMergeRepairTasks();
  const task = stateManager.tasks.get('failed-worker-merge-revive-deadline');
  assert.equal(task.status, 'pending');
  assert.equal(task.storyProgress[1].status, 'needs_repair');
  assert.equal(task.mergeRepairDisplayStatus, 'requeued');
  assert.equal(task.mergeRepairRecoveryTotalRequeues, 3);
  assert.equal(task.autoRecoveryTotalRequeues, 3);
  assert.equal(task.mergeRepairRecoveryStoppedAt, undefined);
  assert.equal(task.mergeRepairRecoveryStopReason, undefined);
  assert.equal(task.autoRecoveryStoppedAt, undefined);
  assert.equal(task.autoRecoveryStopReason, undefined);
  assert.ok(task.mergeRepairRecoveryStartedAt >= staleDeadlineAt);
  assert.ok(task.mergeRepairRecoveryDeadlineAt > Date.now());
});

test('dependency watcher stops task repair immediately on integration sync conflicts', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-worker-integration-sync-conflict',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'failed', attempts: 2, lastError: 'merge failed', updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/failed-worker-integration-sync-conflict',
      logPath: '/tmp/failed-worker-integration-sync-conflict.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 4,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Integration branch sync failed with conflicts: docs/TODO.md',
      lastErrorObservedAt: Date.now() - 1000,
      repairContext: {
        mode: 'merge',
        storyId: 'US-002',
        createdAt: Date.now() - 10_000,
        reason: 'Merge repair required by Ralph.',
      },
      mergeError: 'Integration branch sync failed with conflicts: docs/TODO.md',
      mergeConflictFiles: ['docs/TODO.md'],
      postFinalizeMergeProbeRequired: true,
      mergeRepairRecoveryStartedAt: Date.now() - 5_000,
      mergeRepairRecoveryDeadlineAt: Date.now() + 60_000,
      mergeRepairRecoveryConsecutiveNoProgress: 0,
      mergeRepairRecoveryLastConflictSignature: 'docs/TODO.md',
    },
  ]);

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
      probeWorktreeMergeability: async () => ({
        mergeable: false,
        alreadyIntegrated: false,
        message: 'Integration branch sync failed with conflicts: docs/TODO.md',
        conflictFiles: ['docs/TODO.md'],
        failurePhase: 'integration_sync',
        integrationBranch: 'ralph/integration/main',
        integrationWorktree: '/tmp/integration',
        sourceKind: 'worktree_snapshot',
        worktreeMergeState: {
          kind: 'none',
          usesGitLocal: false,
          gitDir: '/repo/.git/worktrees/failed-worker-integration-sync-conflict',
          headSha: 'abc123',
          mergeParents: [],
          unmergedFiles: [],
          changedFiles: ['src/task.ts'],
          statusPorcelain: ' M src/task.ts',
          statusSignature: 'task-state',
        },
      }),
    },
  );

  await watcher.recoverFailedWorkerMergeRepairTasks();
  const task = stateManager.tasks.get('failed-worker-integration-sync-conflict');
  assert.equal(task.status, 'failed');
  assert.equal(task.mergeRepairRecoveryStopReason, 'merge_repair_integration_sync_conflict');
  assert.equal(task.mergeConflictPhase, 'integration_sync');
  assert.equal(task.mergeRepairRecoveryTotalRequeues, undefined);
  assert.equal(task.mergeRepairDisplayStatus, 'stopped');
});

test('dependency watcher refuses worker merge repair recovery when another story is incomplete', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'failed-worker-merge-incomplete-story',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-002'],
      storyProgress: [
        { id: 'US-001', status: 'failed', attempts: 2, lastError: 'story failed', updatedAt: 1 },
        { id: 'US-002', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-003', status: 'needs_repair', attempts: 2, lastError: 'merge failed', updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/failed-worker-merge-incomplete-story',
      logPath: '/tmp/failed-worker-merge-incomplete-story.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 4,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Exact mergeability probe still fails against ralph/integration/main',
      lastErrorObservedAt: Date.now() - 1000,
      repairContext: {
        mode: 'merge',
        storyId: 'US-003',
        createdAt: Date.now() - 10_000,
        reason: 'Merge repair required by Ralph.',
      },
      mergeError: 'Merge conflicts detected: docs/TODO.md',
      mergeConflictFiles: ['docs/TODO.md'],
      postFinalizeMergeProbeRequired: true,
      mergeRepairRecoveryStartedAt: Date.now() - 5_000,
      mergeRepairRecoveryDeadlineAt: Date.now() + 60_000,
      mergeRepairRecoveryConsecutiveNoProgress: 1,
      mergeRepairRecoveryLastConflictSignature: 'docs/TODO.md',
    },
  ]);

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
      probeWorktreeMergeability: async () => ({
        mergeable: true,
        alreadyIntegrated: false,
        message: 'ralph/task (worktree snapshot) can merge cleanly into ralph/integration/main',
        conflictFiles: [],
        integrationBranch: 'ralph/integration/main',
        integrationWorktree: '/tmp/integration',
        sourceKind: 'worktree_snapshot',
        worktreeMergeState: {
          kind: 'none',
          usesGitLocal: false,
          gitDir: '/repo/.git/worktrees/task',
          headSha: 'abc123',
          mergeParents: [],
          unmergedFiles: [],
          changedFiles: ['docs/TODO.md'],
          statusPorcelain: 'M docs/TODO.md',
          statusSignature: 'ready-proof',
        },
      }),
    },
  );

  await watcher.recoverFailedWorkerMergeRepairTasks();
  const task = stateManager.tasks.get('failed-worker-merge-incomplete-story');
  assert.equal(task.status, 'failed');
  assert.deepEqual(task.completedUS, ['US-002', 'US-003']);
  assert.equal(task.storyProgress.find((story) => story.id === 'US-003').status, 'passed');
  assert.equal(task.integrationStatus, 'failed');
  assert.equal(task.lastErrorKind, 'story_incomplete');
  assert.match(task.lastError, /cannot finalize/);
  assert.match(task.lastError, /US-001:failed:2/);
});

test('dependency watcher ignores stale merge repair residue for ordinary failed stories', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'stale-merge-residue',
      prdPath: '/tmp/prd.json',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-002', 'US-003'],
      storyProgress: [
        { id: 'US-001', status: 'failed', attempts: 2, lastError: 'story failed', updatedAt: 1 },
        { id: 'US-002', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-003', status: 'passed', attempts: 1, updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/stale-merge-residue',
      logPath: '/tmp/stale-merge-residue.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 4,
      consecutiveNoProgress: 1,
      consecutiveErrors: 1,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Task cannot integrate: 1/3 stories are incomplete',
      lastErrorKind: 'story_incomplete',
      lastErrorClass: 'semantic',
      mergeRepairAttempts: 2,
      mergeRepairProof: {
        observedAt: Date.now(),
        sourceKind: 'worktree_snapshot',
        message: 'stale proof',
        integrationBranch: 'ralph/integration/main',
      },
    },
  ]);
  let probeCalls = 0;

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
      probeWorktreeMergeability: async () => {
        probeCalls += 1;
        throw new Error('probe should not run');
      },
    },
  );

  await watcher.recoverFailedWorkerMergeRepairTasks();
  const task = stateManager.tasks.get('stale-merge-residue');
  assert.equal(task.status, 'failed');
  assert.deepEqual(task.completedUS, ['US-002', 'US-003']);
  assert.equal(task.storyProgress.find((story) => story.id === 'US-001').status, 'failed');
  assert.equal(probeCalls, 0);
});

test('dependency watcher promotes completed blocked_conflict tasks to ready_to_finalize when the task worktree now passes the exact probe', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'completed-blocked-conflict-worktree-proof',
      prdPath: '/tmp/prd.json',
      status: 'completed',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/completed-blocked-conflict-worktree-proof',
      logPath: '/tmp/completed-blocked-conflict-worktree-proof.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 4,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      integrationStatus: 'blocked_conflict',
      mergeError: 'Merge conflicts detected: docs/TODO.md',
      mergeConflictFiles: ['docs/TODO.md'],
    },
  ]);

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
      probeWorktreeMergeability: async () => ({
        mergeable: true,
        alreadyIntegrated: false,
        message: 'ralph/task (worktree snapshot) can merge cleanly into ralph/integration/main',
        integrationBranch: 'ralph/integration/main',
        integrationWorktree: '/tmp/integration',
        sourceKind: 'worktree_snapshot',
        worktreeMergeState: {
          kind: 'none',
          usesGitLocal: false,
          gitDir: '/repo/.git/worktrees/task',
          headSha: 'abc123',
          mergeParents: [],
          unmergedFiles: [],
          changedFiles: ['docs/TODO.md'],
          statusPorcelain: 'M docs/TODO.md',
          statusSignature: 'ready-proof',
        },
      }),
    },
  );

  await watcher.recoverCompletedConflictTasks();
  const task = stateManager.tasks.get('completed-blocked-conflict-worktree-proof');
  assert.equal(task.status, 'ready_to_finalize');
  assert.equal(task.postFinalizeMergeProbeRequired, true);
  assert.equal(task.mergeError, undefined);
  assert.equal(task.mergeRepairDisplayStatus, 'probe_mergeable');
  assert.equal(task.mergeRepairProof.integrationBranch, 'ralph/integration/main');
});

test('dependency watcher stops stagnant auto-recovery at the hard cap', async () => {
  const stateManager = new FakeStateManager([
    {
      id: 'stagnant-hard-cap',
      prdPath: '/tmp/prd.json',
      status: 'stagnant',
      startTime: 100,
      completedUS: [],
      storyProgress: [
        { id: 'US-001', status: 'in_progress', attempts: 4, updatedAt: 1 },
      ],
      worktree: '/repo/.ralph-worktrees/stagnant-hard-cap',
      logPath: '/tmp/stagnant-hard-cap.log',
      agent: 'codex',
      repoPath: '/repo',
      loopCount: 8,
      consecutiveNoProgress: 3,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 0,
      lastError: 'Running worker made no progress for 1802s; task was marked stagnant for retry',
      autoRecoveryTotalRequeues: 20,
    },
  ]);

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
    },
  );

  await watcher.recoverStagnantTasks();
  const task = stateManager.tasks.get('stagnant-hard-cap');
  assert.equal(task.status, 'stagnant');
  assert.equal(task.autoRecoveryKind, 'stagnant');
  assert.equal(task.autoRecoveryStopReason, 'stagnation_auto_recovery_hard_cap_reached');
  assert.ok(task.autoRecoveryStoppedAt);
});
