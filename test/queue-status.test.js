const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  adjustManagerStatusForFinalizerLease,
  buildQueueSnapshot,
  buildSystemBlocks,
  deriveQueueState,
  findFreshFinalizerLease,
  isActionItem,
  resolveActionability,
  resolveNextAction,
} = require('../dist/commands/queue.js');
const { StateManager } = require('../dist/core/state.js');

function createTask(overrides = {}) {
  return {
    id: 'task',
    prdPath: '/tmp/prd.json',
    status: 'failed',
    startTime: 100,
    completedUS: [],
    worktree: '/tmp/worktree',
    logPath: '/tmp/agent.log',
    agent: 'codex',
    repoPath: '/tmp/repo',
    loopCount: 0,
    consecutiveNoProgress: 0,
    consecutiveErrors: 0,
    lastProgressTime: 100,
    lastFilesChanged: 0,
    ...overrides,
  };
}

function assertQueueState(task, expectedPhase, expectedDetail, pendingState, context) {
  const queueState = deriveQueueState(task, pendingState, context);
  assert.equal(queueState.phase, expectedPhase);
  assert.equal(queueState.detail, expectedDetail);
  assert.notEqual(queueState.phase, 'needs_operator');
  return queueState;
}

test('queue state labels stopped merge repair as policy block', () => {
  const task = createTask({
    status: 'failed',
    autoRecoveryKind: 'merge_repair',
    lastError: 'merge repair saw the same unresolved conflicts',
    lastErrorRetryable: true,
    mergeRepairDisplayStatus: 'stopped',
    mergeRepairRecoveryStoppedAt: 200,
    mergeRepairRecoveryStopReason: 'merge_repair_same_unresolved_state',
    mergeConflictFiles: ['apps/api/src/service.ts'],
  });

  const queueState = assertQueueState(task, 'blocked_by_policy', 'policy_unresolved_merge_conflict');

  assert.equal(queueState.reason, 'merge_repair_stopped');
  assert.equal(isActionItem(queueState), true);
  assert.match(resolveNextAction(task), /merge repair/);
});

test('queue state labels integration sync conflicts as policy block', () => {
  const task = createTask({
    status: 'failed',
    autoRecoveryKind: 'merge_repair',
    lastError: 'Integration branch sync failed with conflicts: docs/TODO.md',
    lastErrorRetryable: true,
    mergeRepairDisplayStatus: 'stopped',
    mergeRepairRecoveryStoppedAt: 200,
    mergeRepairRecoveryStopReason: 'merge_repair_integration_sync_conflict',
    mergeConflictFiles: ['docs/TODO.md'],
    mergeConflictPhase: 'integration_sync',
  });

  const queueState = assertQueueState(task, 'blocked_by_policy', 'policy_unresolved_merge_conflict');

  assert.equal(queueState.reason, 'integration_sync_conflict');
  assert.match(resolveNextAction(task), /integration branch sync conflict/);
});

test('queue state labels unresolved PRD execution gates as policy block', () => {
  const task = createTask({
    status: 'pending',
  });
  const pendingState = {
    reason: 'execution_gate',
    dependencies: [],
    blockers: ['Claude Code re-adjudication'],
    gateReason: 'enqueue_blocked_until',
    nextAction: 'Resolve PRD enqueue gate: Claude Code re-adjudication',
    maxConcurrent: 3,
    running: 0,
  };

  const queueState = assertQueueState(task, 'blocked_by_policy', 'policy_execution_gate_blocked', pendingState);

  assert.equal(queueState.reason, 'enqueue_blocked_until');
  assert.deepEqual(queueState.blockers, ['Claude Code re-adjudication']);
  assert.equal(queueState.policy.prohibitedAction, 'normal worker execution before declared PRD execution gate is satisfied');
  assert.equal(isActionItem(queueState), true);
  assert.match(resolveNextAction(task, pendingState), /Resolve PRD enqueue gate/);
});

test('queue state maps story incomplete failures to autonomous recovery', () => {
  const task = createTask({
    status: 'failed',
    autoRecoveryKind: 'stagnant',
    lastErrorKind: 'story_incomplete',
    lastErrorRetryable: false,
  });

  const queueState = assertQueueState(task, 'recovering', 'auto_repairing_story');

  assert.equal(queueState.reason, 'story_incomplete');
  assert.equal(queueState.autonomous, true);
  assert.equal(isActionItem(queueState), false);
});

test('queue state keeps active auto recovery out of action items', () => {
  const task = createTask({
    status: 'failed',
    autoRecoveryKind: 'transient',
    autoRecoveryNextEligibleAt: Date.now() + 60_000,
    lastErrorRetryable: true,
  });

  const queueState = assertQueueState(task, 'recovering', 'retrying_transient');

  assert.equal(isActionItem(queueState), false);
});

test('queue system blocks report manager scheduling pause', () => {
  const systemBlocks = buildSystemBlocks({
    repoPath: '/tmp/repo',
    control: {
      schemaVersion: 1,
      schedulingPaused: true,
      pausedAt: 100,
      pauseReason: 'operator_paused',
      controlPath: '/tmp/home/manager/control.json',
      stateExists: true,
    },
    ingestion: {
      managerActive: true,
      managerAutoIngestEnabled: true,
      notIngestedCount: 0,
      nextAction: 'auto-ingest inventory is clear',
    },
    taskActionCount: 0,
    tasks: [],
    capacity: {
      running: 0,
      available: 3,
      queuedRunnable: 1,
    },
  });

  assert.equal(systemBlocks[0].id, 'manager-scheduling-paused');
  assert.equal(systemBlocks[0].detail, 'blocked_by_manager_pause');

  const actionability = resolveActionability({
    tasks: [],
    actions: [],
    systemBlocks,
    capacity: {
      running: 0,
      available: 3,
      queuedRunnable: 1,
    },
  });

  assert.equal(actionability.status, 'paused');
  assert.equal(actionability.reason, 'manager_scheduling_paused');
});

test('queue state treats pending tasks waiting on recovery as autonomous recovering', () => {
  const task = createTask({
    status: 'pending',
  });
  const queueState = assertQueueState(task, 'recovering', 'blocked_by_coordination', {
    reason: 'coordination',
    dependencies: [],
    blockers: ['recovering-blocker'],
    recoveringBlockers: ['recovering-blocker'],
    maxConcurrent: 3,
    running: 1,
  });

  assert.equal(queueState.reason, 'waiting_for_coordination_recovery');
  assert.equal(queueState.autonomous, true);
  assert.equal(isActionItem(queueState), false);
});

test('queue snapshot reports failed dependency with active dependency repair as waiting recovery', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-dependency-repair-active-'));
  const previousRalphHome = process.env.RALPH_HOME;

  try {
    process.env.RALPH_HOME = homeDir;
    const stateManager = new StateManager({ ralphHome: homeDir });
    await stateManager.saveTask(createTask({
      id: 'failed-p0',
      prdId: 'P0-003',
      prdDependencies: [],
      status: 'failed',
      startTime: 100,
      enqueuedAt: 100,
      lastError: 'P0 failed',
    }));
    await stateManager.saveTask(createTask({
      id: 'repair-p0',
      prdId: 'followup:P0-003:repair',
      prdDependencies: [],
      priorityClass: 'dependency_repair',
      repairOf: {
        prdId: 'P0-003',
        taskId: 'failed-p0',
        reason: 'dependency repair',
      },
      releasesDependenciesFor: ['P0-003'],
      effectiveDependencyPrdId: 'P0-003',
      status: 'running',
      startTime: 200,
      enqueuedAt: 200,
    }));
    await stateManager.saveTask(createTask({
      id: 'p1',
      prdId: 'P1',
      prdDependencies: ['P0-003'],
      status: 'pending',
      startTime: 300,
      enqueuedAt: 300,
    }));

    const snapshot = await buildQueueSnapshot(undefined, 7200, 5, true);
    const p1 = snapshot.tasks.find((task) => task.id === 'p1');

    assert.equal(p1.queueState.phase, 'recovering');
    assert.equal(p1.queueState.detail, 'blocked_by_dependency');
    assert.equal(p1.queueState.reason, 'waiting_for_dependency_recovery');
    assert.deepEqual(p1.failedDependencies, []);
    assert.deepEqual(p1.recoveringDependencies, ['P0-003']);
    assert.deepEqual(p1.repairTaskIds, ['repair-p0']);
    assert.deepEqual(p1.queueState.blockers, ['P0-003']);
    assert.deepEqual(p1.queueState.repairTaskIds, ['repair-p0']);
  } finally {
    if (previousRalphHome === undefined) {
      delete process.env.RALPH_HOME;
    } else {
      process.env.RALPH_HOME = previousRalphHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue snapshot stops reporting recovery after dependency repair integrates', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-dependency-repair-integrated-'));
  const previousRalphHome = process.env.RALPH_HOME;

  try {
    process.env.RALPH_HOME = homeDir;
    const stateManager = new StateManager({ ralphHome: homeDir });
    await stateManager.saveTask(createTask({
      id: 'failed-p0',
      prdId: 'P0-003',
      prdDependencies: [],
      status: 'failed',
      startTime: 100,
      enqueuedAt: 100,
      lastError: 'P0 failed',
    }));
    await stateManager.saveTask(createTask({
      id: 'repair-p0',
      prdId: 'followup:P0-003:repair',
      prdDependencies: [],
      priorityClass: 'dependency_repair',
      repairOf: {
        prdId: 'P0-003',
        taskId: 'failed-p0',
        reason: 'dependency repair',
      },
      releasesDependenciesFor: ['P0-003'],
      effectiveDependencyPrdId: 'P0-003',
      status: 'completed',
      integrationStatus: 'integrated',
      integratedAt: 400,
      integrationCommitSha: 'repair-sha',
      targetSyncStatus: 'disabled',
      startTime: 200,
      enqueuedAt: 200,
    }));
    await stateManager.saveTask(createTask({
      id: 'p1',
      prdId: 'P1',
      prdDependencies: ['P0-003'],
      status: 'pending',
      startTime: 300,
      enqueuedAt: 300,
    }));

    const snapshot = await buildQueueSnapshot(undefined, 7200, 5, true);
    const p1 = snapshot.tasks.find((task) => task.id === 'p1');

    assert.equal(p1.queueState.phase, 'queued');
    assert.equal(p1.queueState.detail, 'waiting_for_slot');
    assert.notEqual(p1.queueState.reason, 'waiting_for_dependency_recovery');
    assert.notEqual(p1.queueState.reason, 'blocked_failed_dependency');
    assert.equal(p1.recoveringDependencies, undefined);
    assert.equal(p1.failedDependencies, undefined);
    assert.equal(p1.repairTaskIds, undefined);
  } finally {
    if (previousRalphHome === undefined) {
      delete process.env.RALPH_HOME;
    } else {
      process.env.RALPH_HOME = previousRalphHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue snapshot falls back to failed dependency after dependency repair fails', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-dependency-repair-failed-'));
  const previousRalphHome = process.env.RALPH_HOME;

  try {
    process.env.RALPH_HOME = homeDir;
    const stateManager = new StateManager({ ralphHome: homeDir });
    await stateManager.saveTask(createTask({
      id: 'failed-p0',
      prdId: 'P0-003',
      prdDependencies: [],
      status: 'failed',
      startTime: 100,
      enqueuedAt: 100,
      lastError: 'P0 failed',
    }));
    await stateManager.saveTask(createTask({
      id: 'repair-p0',
      prdId: 'followup:P0-003:repair',
      prdDependencies: [],
      priorityClass: 'dependency_repair',
      repairOf: {
        prdId: 'P0-003',
        taskId: 'failed-p0',
        reason: 'dependency repair',
      },
      releasesDependenciesFor: ['P0-003'],
      effectiveDependencyPrdId: 'P0-003',
      status: 'failed',
      startTime: 200,
      enqueuedAt: 200,
      lastError: 'repair failed',
    }));
    await stateManager.saveTask(createTask({
      id: 'p1',
      prdId: 'P1',
      prdDependencies: ['P0-003'],
      status: 'pending',
      startTime: 300,
      enqueuedAt: 300,
    }));

    const snapshot = await buildQueueSnapshot(undefined, 7200, 5, true);
    const p1 = snapshot.tasks.find((task) => task.id === 'p1');

    assert.equal(p1.queueState.phase, 'blocked');
    assert.equal(p1.queueState.detail, 'blocked_by_dependency');
    assert.equal(p1.queueState.reason, 'blocked_failed_dependency');
    assert.deepEqual(p1.failedDependencies, ['P0-003']);
    assert.deepEqual(p1.recoveringDependencies, []);
    assert.deepEqual(p1.queueState.blockers, ['P0-003']);
    assert.equal(p1.queueState.repairTaskIds, undefined);
  } finally {
    if (previousRalphHome === undefined) {
      delete process.env.RALPH_HOME;
    } else {
      process.env.RALPH_HOME = previousRalphHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('pending queued next action reports occupied worker capacity', () => {
  const task = createTask({
    status: 'pending',
  });

  assert.equal(resolveNextAction(task, {
    reason: 'queued',
    dependencies: [],
    blockers: [],
    maxConcurrent: 1,
    running: 1,
  }), 'wait for a concurrency slot; 1/1 worker slot(s) are occupied');
});

test('queue state maps stopped agent context recovery to split/follow-up path', () => {
  const task = createTask({
    status: 'failed',
    autoRecoveryKind: 'agent_context',
    lastErrorKind: 'agent_context_window_exhausted',
    lastErrorRetryable: true,
    agentContextRecoveryStoppedAt: 200,
    agentContextRecoveryStopReason: 'agent_context_budget_exhausted',
  });

  const queueState = assertQueueState(task, 'recovering', 'splitting_story');

  assert.equal(queueState.reason, 'agent_context_recovery_stopped');
  assert.match(resolveNextAction(task), /split or reduce the story/);
});

test('queue state maps generic stopped recovery to autonomous follow-up generation', () => {
  const task = createTask({
    status: 'failed',
    autoRecoveryKind: undefined,
    autoRecoveryStoppedAt: 200,
    autoRecoveryStopReason: 'recovery_budget_exhausted',
    autoRecoveryLastReason: 'Generic recovery budget exhausted',
  });

  const queueState = assertQueueState(task, 'recovering', 'generating_followup_prd');

  assert.equal(queueState.reason, 'generic_recovery_stopped');
  assert.equal(isActionItem(queueState), false);
  assert.match(resolveNextAction(task), /generate a follow-up PRD/);
});

test('queue state treats generated follow-up stopped recovery as diagnostics', () => {
  const task = createTask({
    status: 'failed',
    prdId: 'followup:source-prd:abc123',
    autoRecoveryKind: 'story_repair',
    storyRepairRecoveryStoppedAt: 200,
    storyRepairRecoveryStopReason: 'story_repair_hard_cap_reached',
    autoRecoveryStoppedAt: 200,
    autoRecoveryStopReason: 'story_repair_hard_cap_reached',
  });

  const queueState = assertQueueState(task, 'diagnostics', 'diagnosing_failure');

  assert.equal(queueState.reason, 'story_repair_stopped');
  assert.equal(isActionItem(queueState), true);
  assert.match(resolveNextAction(task), /will not generate another automatic follow-up/);
});

test('queue state treats operator-stopped failure as diagnostics, not follow-up planning', () => {
  const task = createTask({
    status: 'failed',
    autoRecoveryKind: undefined,
    autoRecoveryStoppedAt: 200,
    autoRecoveryStopReason: 'operator_stopped',
    autoRecoveryLastReason: 'Task was explicitly stopped by operator',
  });

  const queueState = assertQueueState(task, 'diagnostics', 'diagnosing_failure');

  assert.equal(queueState.reason, 'task_failed');
  assert.equal(isActionItem(queueState), true);
  assert.doesNotMatch(resolveNextAction(task), /generate a follow-up PRD/);
});

test('queue snapshot separates follow-up planning from active recovery count', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-followup-planning-'));
  const previousRalphHome = process.env.RALPH_HOME;

  try {
    process.env.RALPH_HOME = homeDir;
    const stateManager = new StateManager({ ralphHome: homeDir });
    await stateManager.saveTask(createTask({
      id: 'stopped-source-task',
      status: 'failed',
      autoRecoveryKind: undefined,
      autoRecoveryStoppedAt: 200,
      autoRecoveryStopReason: 'recovery_budget_exhausted',
      autoRecoveryLastReason: 'Generic recovery budget exhausted',
      declaredWriteSurface: ['apps/web'],
    }));

    const snapshot = await buildQueueSnapshot(undefined, 7200, 5, true);

    assert.equal(snapshot.summary.totalActive, 1);
    assert.equal(snapshot.summary.recovering, 0);
    assert.equal(snapshot.summary.planning, 1);
    assert.equal(snapshot.actionability.status, 'runnable');
    assert.equal(snapshot.actionability.reason, 'generating_followup_prd');
    assert.deepEqual(snapshot.actions, []);
  } finally {
    if (previousRalphHome === undefined) {
      delete process.env.RALPH_HOME;
    } else {
      process.env.RALPH_HOME = previousRalphHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue next action treats generated follow-up as recovery owner', () => {
  const task = createTask({
    status: 'failed',
    storyRepairRecoveryStoppedAt: 200,
    storyRepairRecoveryStopReason: 'story_repair_budget_exhausted',
    followupTaskIds: ['followup-task'],
  });

  assert.match(resolveNextAction(task), /follow-up task followup-task is carrying this recovery path/);
});

test('queue state maps target sync blocks to environment block', () => {
  const deferred = createTask({
    status: 'completed',
    integrationStatus: 'integrated',
    integratedAt: 200,
    integrationCommitSha: 'abc123',
    targetSyncStatus: 'deferred_dirty_checkout',
    targetSyncDeferredReason: 'sync deferred because main has local edits',
  });
  const failed = createTask({
    status: 'completed',
    integrationStatus: 'integrated',
    integratedAt: 200,
    integrationCommitSha: 'abc123',
    targetSyncStatus: 'failed',
    targetSyncDeferredReason: 'target ref is not a fast-forward',
  });

  assertQueueState(deferred, 'blocked', 'blocked_by_environment');
  assertQueueState(failed, 'blocked', 'blocked_by_environment');
});

test('queue does not report deadlock while a finalizer is in flight', () => {
  const systemBlocks = buildSystemBlocks({
    repoPath: '/tmp/repo',
    ingestion: {
      managerActive: true,
      managerAutoIngestEnabled: true,
      notIngestedCount: 0,
      nextAction: 'auto-ingest inventory is clear',
    },
    taskActionCount: 0,
    tasks: [
      {
        id: 'task-finalizing',
        status: 'finalizing',
        queueState: { phase: 'finalizing', detail: 'finalizer_running' },
        nextAction: 'wait for finalizer completion or stale lease recovery',
      },
      {
        id: 'task-blocked',
        status: 'ready_to_finalize',
        queueState: { phase: 'blocked', detail: 'blocked_by_coordination' },
        coordination: {
          status: 'blocked_observed_overlap',
          blockers: ['task-finalizing'],
        },
        nextAction: 'wait for earlier overlapping task(s) to integrate: task-finalizing',
      },
    ],
    capacity: {
      running: 0,
      available: 3,
      queuedRunnable: 0,
    },
  });

  assert.deepEqual(systemBlocks, []);
});

test('queue reports finalizer progress instead of no runnable tasks', () => {
  const actionability = resolveActionability({
    actions: [],
    systemBlocks: [],
    tasks: [
      {
        id: 'task-finalizing',
        status: 'finalizing',
        queueState: { phase: 'finalizing', detail: 'finalizer_running' },
        nextAction: 'wait for finalizer completion or stale lease recovery',
      },
    ],
    capacity: {
      running: 0,
      available: 3,
      queuedRunnable: 0,
    },
  });

  assert.deepEqual(actionability, {
    status: 'runnable',
    reason: 'finalizer_running',
    nextAction: 'wait for finalizer completion',
  });
});

test('queue reports recoverable task state as recovering, never operator need', () => {
  const actionability = resolveActionability({
    actions: [],
    systemBlocks: [],
    tasks: [
      {
        id: 'task-baseline-exhausted',
        status: 'failed_finalize',
        queueState: {
          phase: 'recovering',
          detail: 'reclassifying_baseline_failure',
          reason: 'baseline_repair_exhausted',
        },
        nextAction: 'manager will reclassify post-baseline finalizer failure',
      },
    ],
    capacity: {
      running: 0,
      available: 3,
      queuedRunnable: 0,
    },
  });

  assert.deepEqual(actionability, {
    status: 'recovering',
    reason: 'baseline_repair_exhausted',
    principalBlocker: 'task-baseline-exhausted',
    nextAction: 'manager will reclassify post-baseline finalizer failure',
  });
});

test('queue state treats autonomy repair as active recovering state', () => {
  const task = createTask({
    status: 'failed_finalize',
    autoRecoveryKind: undefined,
    autonomyRepairKind: 'baseline_exhaustion',
    autonomyRepairTotalRequeues: 1,
    autonomyRepairLastReason: 'Baseline repair exhausted; reclassifying',
    lastErrorKind: 'quality_gate_failure',
    baselineQualityGate: {
      kind: 'baseline_quality_gate_failure',
      observedAt: 100,
      targetBranch: 'main',
      gate: 'test',
      packageLabel: 'apps/web',
      signature: 'test|apps/web|quality_gate_failure|pnpm test|failure',
      taskFailureSignature: 'test|apps/web|quality_gate_failure|pnpm test|failure',
      latestFailureSignature: 'test|apps/web|quality_gate_failure|pnpm test|failure',
      message: 'baseline repair exhausted',
      phase: 'stopped',
      stoppedAt: 200,
      stopReason: 'baseline_repair_exhausted',
    },
    finalizerFailure: {
      failureKind: 'quality_gate',
      class: 'quality_gate_failure',
      gate: 'test',
      requestedGate: 'test',
      packageLabel: 'apps/web',
      cwd: '/tmp/worktree/apps/web',
      command: 'pnpm test',
      rawMessage: 'failure',
    },
  });

  const queueState = assertQueueState(task, 'recovering', 'reclassifying_baseline_failure');

  assert.equal(queueState.recovery.kind, 'baseline_exhaustion');
  assert.equal(queueState.recovery.active, true);
  assert.equal(isActionItem(queueState), false);
});

test('queue reports active recovery workers as runnable instead of stuck recovering', () => {
  const actionability = resolveActionability({
    actions: [],
    systemBlocks: [],
    tasks: [
      {
        id: 'active-recovery-worker',
        status: 'running',
        queueState: {
          phase: 'running',
          detail: 'worker_running',
        },
        autoRecovery: {
          active: true,
          kind: 'baseline_repair',
        },
        nextAction: 'finalize repair is executing on US-003',
      },
      {
        id: 'waiting-on-recovery',
        status: 'pending',
        queueState: {
          phase: 'recovering',
          detail: 'blocked_by_coordination',
          reason: 'waiting_for_coordination_recovery',
        },
        nextAction: 'wait for overlapping task auto-recovery: active-recovery-worker',
      },
    ],
    capacity: {
      running: 1,
      available: 2,
      queuedRunnable: 0,
    },
  });

  assert.deepEqual(actionability, {
    status: 'runnable',
    reason: 'workers_running',
    nextAction: 'wait for worker progress',
  });
});

test('queue suppresses action state for already integrated finalize-state product tasks', () => {
  const task = createTask({
    status: 'failed_finalize',
    integrationStatus: 'integrated',
    integratedAt: 500,
    mergeCommitSha: 'abc123',
    targetSyncStatus: 'disabled',
    completedUS: ['US-001'],
    storyProgress: [
      { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 100 },
    ],
    lastErrorKind: 'quality_gate_failure',
  });

  const queueState = assertQueueState(task, 'completed', 'completed_integrated');

  assert.equal(isActionItem(queueState), false);
});

test('queue does not let stale merge repair proof suppress quality-gate finalize recovery', () => {
  const task = createTask({
    status: 'failed_finalize',
    completedUS: ['US-001'],
    storyProgress: [
      { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 100 },
    ],
    lastErrorKind: 'quality_gate_failure',
    finalizerFailure: {
      failureKind: 'quality_gate',
      class: 'quality_gate_failure',
      gate: 'test',
      requestedGate: 'test',
      packageLabel: 'apps/web',
      cwd: '/tmp/repo/apps/web',
      command: 'pnpm run test',
      rawMessage: 'Quality gate "test" failed',
    },
    repairContext: {
      mode: 'finalize',
      storyId: 'US-001',
      createdAt: 200,
      reason: 'Quality gate "test" failed',
    },
    mergeRepairDisplayStatus: 'probe_mergeable',
    mergeRepairProof: {
      observedAt: 100,
      sourceKind: 'worktree_snapshot',
      worktreeMergeKind: 'none',
      message: 'old merge proof',
      changedFiles: ['apps/web/header.tsx'],
    },
  });

  assertQueueState(task, 'recovering', 'auto_repairing_finalize');
});

test('queue maps baseline quality-gate failures to baseline recovery', () => {
  const task = createTask({
    status: 'failed_finalize',
    lastErrorKind: 'quality_gate_failure',
    baselineQualityGate: {
      kind: 'baseline_quality_gate_failure',
      observedAt: 200,
      targetBranch: 'main',
      gate: 'typecheck',
      packageLabel: 'apps/api',
      signature: 'typecheck|apps/api',
      message: 'target baseline quality gate failed with the same gate context',
    },
  });

  const queueState = assertQueueState(task, 'recovering', 'auto_repairing_baseline');

  assert.equal(queueState.reason, 'baseline_quality_gate_failure');
  assert.match(resolveNextAction(task), /enqueue or reuse a shared baseline repair task/);
});

test('queue maps baseline probe failures to diagnostics', () => {
  const task = createTask({
    status: 'failed_finalize',
    lastErrorKind: 'quality_gate_failure',
    baselineQualityGate: {
      kind: 'baseline_probe_failed',
      observedAt: 200,
      targetBranch: 'main',
      gate: 'typecheck',
      packageLabel: 'apps/api',
      signature: 'typecheck|apps/api',
      message: 'target baseline worktree is dirty',
    },
  });

  const queueState = assertQueueState(task, 'diagnostics', 'diagnosing_baseline_probe');

  assert.equal(queueState.reason, 'baseline_quality_gate_probe_failed');
  assert.match(resolveNextAction(task), /baseline quality-gate probe/);
});

test('queue snapshot excludes obsolete stopped baseline repairs from active diagnostics', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-obsolete-baseline-'));
  const previousRalphHome = process.env.RALPH_HOME;

  try {
    process.env.RALPH_HOME = homeDir;
    const stateManager = new StateManager({ ralphHome: homeDir });
    await stateManager.saveTask(createTask({
      id: 'obsolete-baseline-repair',
      prdId: 'baseline-quality-gate:obsolete',
      prdPath: path.join(homeDir, 'baseline-repairs', 'obsolete.json'),
      status: 'failed',
      finalizeRepairStoppedAt: 200,
      finalizeRepairStopReason: 'repair_no_progress',
      baselineRepair: {
        repairKey: 'baseline-quality-gate|main|test|apps/api',
        rootCause: 'shared_baseline_code_debt',
        targetBranch: 'main',
        gate: 'test',
        packageLabel: 'apps/api',
        demandTaskIds: ['missing-demand-task'],
        repairTaskId: 'obsolete-baseline-repair',
        repairPrdId: 'baseline-quality-gate:obsolete',
        startedAt: 100,
        updatedAt: 200,
        status: 'failed',
      },
    }));
    await stateManager.saveTask(createTask({
      id: 'superseded-hot-baseline-repair',
      prdId: 'baseline-quality-gate:superseded',
      prdPath: path.join(homeDir, 'baseline-repairs', 'superseded.json'),
      status: 'failed',
      repairContext: {
        mode: 'merge',
        storyId: 'US-001',
        createdAt: 150,
        reason: 'stale merge repair context',
      },
      mergeConflictFiles: ['apps/api/src/service.ts'],
      baselineRepair: {
        repairKey: 'baseline-quality-gate|main|test|apps/api|superseded',
        rootCause: 'shared_baseline_code_debt',
        targetBranch: 'main',
        gate: 'test',
        packageLabel: 'apps/api',
        demandTaskIds: ['old-demand-task'],
        repairTaskId: 'superseded-hot-baseline-repair',
        repairPrdId: 'baseline-quality-gate:superseded',
        startedAt: 100,
        updatedAt: 200,
        status: 'superseded',
        supersededByRepairTaskId: 'canonical-baseline-repair',
      },
    }));

    const snapshot = await buildQueueSnapshot(undefined, 7200, 5, true);

    assert.equal(snapshot.summary.totalActive, 0);
    assert.equal(snapshot.summary.diagnostics, 0);
    assert.deepEqual(snapshot.tasks, []);
    assert.deepEqual(snapshot.actions, []);
  } finally {
    if (previousRalphHome === undefined) {
      delete process.env.RALPH_HOME;
    } else {
      process.env.RALPH_HOME = previousRalphHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue snapshot excludes operator-cancelled obsolete recovery from active diagnostics', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-obsolete-recovery-'));
  const previousRalphHome = process.env.RALPH_HOME;

  try {
    process.env.RALPH_HOME = homeDir;
    const stateManager = new StateManager({ ralphHome: homeDir });
    await stateManager.saveTask(createTask({
      id: 'active-task',
      status: 'running',
      currentUS: 'US-001',
    }));
    await stateManager.saveTask(createTask({
      id: 'obsolete-recovery',
      status: 'failed',
      worktree: '',
      latestFailure: {
        kind: 'operator_cancelled_obsolete_recovery',
        class: 'operator_cancelled_obsolete_recovery',
        message: 'Obsolete recovery task cancelled because a combined PRD supersedes it.',
        observedAt: 200,
        retryable: false,
      },
    }));

    const snapshot = await buildQueueSnapshot(undefined, 7200, 5, true);

    assert.equal(snapshot.summary.totalActive, 1);
    assert.equal(snapshot.summary.running, 1);
    assert.equal(snapshot.summary.diagnostics, 0);
    assert.deepEqual(snapshot.tasks.map((task) => task.id), ['active-task']);
    assert.deepEqual(snapshot.actions, []);
    assert.equal(snapshot.actionability.status, 'runnable');
    assert.equal(snapshot.actionability.reason, 'workers_running');
  } finally {
    if (previousRalphHome === undefined) {
      delete process.env.RALPH_HOME;
    } else {
      process.env.RALPH_HOME = previousRalphHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue snapshot hides stopped source tasks while generated follow-ups are active', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-followup-shadow-'));
  const previousRalphHome = process.env.RALPH_HOME;

  try {
    process.env.RALPH_HOME = homeDir;
    const stateManager = new StateManager({ ralphHome: homeDir });
    await stateManager.saveTask(createTask({
      id: 'stopped-source-task',
      prdId: 'source-prd',
      status: 'failed',
      storyRepairRecoveryStoppedAt: 200,
      storyRepairRecoveryStopReason: 'story_repair_budget_exhausted',
      followupTaskIds: ['active-followup-task'],
      declaredWriteSurface: ['apps/web'],
    }));
    await stateManager.saveTask(createTask({
      id: 'active-followup-task',
      prdId: 'followup:source-prd:abc123',
      prdDependencies: [],
      status: 'pending',
      startTime: 300,
      enqueuedAt: 300,
      declaredWriteSurface: ['apps/web'],
    }));

    const snapshot = await buildQueueSnapshot(undefined, 7200, 5, true);

    assert.equal(snapshot.summary.totalActive, 1);
    assert.equal(snapshot.summary.recovering, 0);
    assert.deepEqual(snapshot.tasks.map((task) => task.id), ['active-followup-task']);
    assert.deepEqual(snapshot.actions, []);
  } finally {
    if (previousRalphHome === undefined) {
      delete process.env.RALPH_HOME;
    } else {
      process.env.RALPH_HOME = previousRalphHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue snapshot hides stopped source tasks after generated follow-up completes', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-followup-complete-shadow-'));
  const previousRalphHome = process.env.RALPH_HOME;

  try {
    process.env.RALPH_HOME = homeDir;
    const stateManager = new StateManager({ ralphHome: homeDir });
    await stateManager.saveTask(createTask({
      id: 'stopped-source-task',
      prdId: 'source-prd',
      status: 'failed',
      storyRepairRecoveryStoppedAt: 200,
      storyRepairRecoveryStopReason: 'story_repair_budget_exhausted',
      followupTaskIds: ['completed-followup-task'],
      declaredWriteSurface: ['apps/web'],
    }));
    await stateManager.saveTask(createTask({
      id: 'completed-followup-task',
      prdId: 'followup:source-prd:abc123',
      status: 'completed',
      integrationStatus: 'integrated',
      integratedAt: 400,
      integrationCommitSha: 'abc123',
      targetSyncStatus: 'disabled',
      startTime: 300,
      updatedAt: 400,
      declaredWriteSurface: ['apps/web'],
    }));

    const snapshot = await buildQueueSnapshot(undefined, 7200, 5, true);

    assert.equal(snapshot.summary.totalActive, 0);
    assert.equal(snapshot.summary.recovering, 0);
    assert.deepEqual(snapshot.tasks, []);
    assert.deepEqual(snapshot.actions, []);
  } finally {
    if (previousRalphHome === undefined) {
      delete process.env.RALPH_HOME;
    } else {
      process.env.RALPH_HOME = previousRalphHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue snapshot excludes archived terminal failures from active diagnostics', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-archived-terminal-failure-'));
  const previousRalphHome = process.env.RALPH_HOME;

  try {
    process.env.RALPH_HOME = homeDir;
    const stateManager = new StateManager({ ralphHome: homeDir });
    await stateManager.saveTask(createTask({
      id: 'archived-failed-task',
      status: 'failed',
      autoRecoveryKind: 'transient',
      autoRecoveryStoppedAt: 200,
      autoRecoveryStopReason: 'operator_stopped',
      worktreeReclaimDecision: 'archive_only',
      worktreeReclaimEvidencePath: path.join(homeDir, 'reclamation', 'evidence', 'archived-failed-task'),
      worktreeReclaimEvidenceManifestPath: path.join(homeDir, 'reclamation', 'evidence', 'archived-failed-task', 'manifest.json'),
      lastError: 'Worker process is no longer running',
      lastErrorRetryable: true,
    }));

    const snapshot = await buildQueueSnapshot(undefined, 7200, 5, true);

    assert.equal(snapshot.summary.totalActive, 0);
    assert.equal(snapshot.summary.diagnostics, 0);
    assert.deepEqual(snapshot.tasks, []);
    assert.deepEqual(snapshot.actions, []);
    assert.equal(snapshot.actionability.status, 'idle');
    assert.equal(snapshot.actionability.reason, 'no_active_tasks');
  } finally {
    if (previousRalphHome === undefined) {
      delete process.env.RALPH_HOME;
    } else {
      process.env.RALPH_HOME = previousRalphHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue snapshot keeps archived terminal failures active while recovery is still running', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-archived-active-recovery-'));
  const previousRalphHome = process.env.RALPH_HOME;

  try {
    process.env.RALPH_HOME = homeDir;
    const stateManager = new StateManager({ ralphHome: homeDir });
    await stateManager.saveTask(createTask({
      id: 'archived-but-recovering-task',
      status: 'failed',
      autoRecoveryKind: 'transient',
      autoRecoveryStartedAt: 200,
      autoRecoveryDeadlineAt: Date.now() + 60_000,
      autoRecoveryTotalRequeues: 1,
      autoRecoveryNextEligibleAt: Date.now() - 1_000,
      lastErrorKind: 'worker_process_exited',
      lastErrorClass: 'transient_backend',
      lastErrorRetryable: true,
      worktreeReclaimDecision: 'archive_only',
      worktreeReclaimEvidencePath: path.join(homeDir, 'reclamation', 'evidence', 'archived-but-recovering-task'),
      worktreeReclaimEvidenceManifestPath: path.join(homeDir, 'reclamation', 'evidence', 'archived-but-recovering-task', 'manifest.json'),
    }));

    const snapshot = await buildQueueSnapshot(undefined, 7200, 5, true);

    assert.equal(snapshot.summary.totalActive, 1);
    assert.equal(snapshot.summary.recovering, 1);
    assert.deepEqual(snapshot.tasks.map((task) => task.id), ['archived-but-recovering-task']);
    assert.equal(snapshot.actionability.status, 'recovering');
  } finally {
    if (previousRalphHome === undefined) {
      delete process.env.RALPH_HOME;
    } else {
      process.env.RALPH_HOME = previousRalphHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue snapshot ignores failed generated follow-up after source task integrates', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-followup-obsolete-after-integrated-'));
  const previousRalphHome = process.env.RALPH_HOME;

  try {
    process.env.RALPH_HOME = homeDir;
    const stateManager = new StateManager({ ralphHome: homeDir });
    await stateManager.saveTask(createTask({
      id: 'integrated-source-task',
      prdId: 'source-prd',
      status: 'completed',
      completedUS: ['US-001'],
      storyProgress: [{
        id: 'US-001',
        status: 'passed',
        attempts: 1,
      }],
      integrationStatus: 'integrated',
      integratedAt: 400,
      integrationCommitSha: 'source-sha',
      targetSyncStatus: 'disabled',
      updatedAt: Date.now(),
      followupTaskIds: ['stale-followup-task'],
      declaredWriteSurface: ['apps/web'],
    }));
    await stateManager.saveTask(createTask({
      id: 'stale-followup-task',
      prdId: 'followup:source-prd:abc123',
      status: 'failed',
      autoRecoveryStoppedAt: 500,
      autoRecoveryStopReason: 'operator_stopped',
      startTime: 300,
      updatedAt: 500,
      declaredWriteSurface: ['apps/web'],
    }));

    const snapshot = await buildQueueSnapshot(undefined, 7200, 5, true);

    assert.equal(snapshot.summary.totalActive, 0);
    assert.equal(snapshot.summary.diagnostics, 0);
    assert.deepEqual(snapshot.tasks, []);
    assert.deepEqual(snapshot.actions, []);
    assert.equal(snapshot.actionability.status, 'idle');
    const recentSourceTask = snapshot.recentCompleted.find((task) => task.id === 'integrated-source-task');
    assert.ok(recentSourceTask);
    assert.match(recentSourceTask.nextAction, /target sync is disabled/);
    assert.doesNotMatch(recentSourceTask.nextAction, /follow-up task/);
  } finally {
    if (previousRalphHome === undefined) {
      delete process.env.RALPH_HOME;
    } else {
      process.env.RALPH_HOME = previousRalphHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue snapshot separates ordinary pending waiters from active recovery count', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-waiting-recovery-'));
  const previousRalphHome = process.env.RALPH_HOME;

  try {
    process.env.RALPH_HOME = homeDir;
    const stateManager = new StateManager({ ralphHome: homeDir });
    await stateManager.saveTask(createTask({
      id: 'active-recovery-task',
      prdId: 'active-prd',
      prdDependencies: [],
      status: 'running',
      startTime: 100,
      enqueuedAt: 100,
      declaredWriteSurface: ['apps/web'],
      autoRecoveryKind: 'transient',
      lastErrorRetryable: true,
    }));
    await stateManager.saveTask(createTask({
      id: 'waiting-followup-task',
      prdId: 'followup:active-prd:abc123',
      prdDependencies: [],
      status: 'pending',
      startTime: 200,
      enqueuedAt: 200,
      declaredWriteSurface: ['apps/web'],
    }));

    const snapshot = await buildQueueSnapshot(undefined, 7200, 5, true);

    assert.equal(snapshot.summary.running, 1);
    assert.equal(snapshot.summary.recovering, 0);
    assert.equal(snapshot.summary.waitingRecovery, 0);
    assert.equal(snapshot.summary.capacity.queuedBlockedByCoordination, 1);
    const waitingTask = snapshot.tasks.find((task) => task.id === 'waiting-followup-task');
    assert.equal(waitingTask.queueState.phase, 'queued');
    assert.equal(waitingTask.queueState.detail, 'blocked_by_coordination');
    assert.equal(waitingTask.queueState.reason, 'waiting_for_coordination');
    assert.equal(snapshot.actionability.status, 'runnable');
  } finally {
    if (previousRalphHome === undefined) {
      delete process.env.RALPH_HOME;
    } else {
      process.env.RALPH_HOME = previousRalphHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('duplicate managers map to blocked_by_policy actionability', () => {
  const systemBlocks = buildSystemBlocks({
    repoPath: '/tmp/repo',
    duplicateManagers: {
      repoPath: '/tmp/repo',
      currentClaim: { ralphHome: '/tmp/current' },
      otherActiveClaims: [{ ralphHome: '/tmp/other' }],
      duplicateRepoManagers: true,
    },
    ingestion: {
      managerActive: true,
      managerAutoIngestEnabled: true,
      notIngestedCount: 0,
      nextAction: 'auto-ingest inventory is clear',
    },
    taskActionCount: 0,
    tasks: [],
    capacity: {
      running: 0,
      available: 1,
      queuedRunnable: 0,
    },
  });
  const actionability = resolveActionability({
    actions: [],
    systemBlocks,
    tasks: [],
    capacity: {
      running: 0,
      available: 1,
      queuedRunnable: 0,
    },
  });

  assert.equal(systemBlocks[0].phase, 'blocked_by_policy');
  assert.equal(systemBlocks[0].detail, 'policy_duplicate_managers');
  assert.equal(actionability.status, 'blocked_by_policy');
});

test('queue suppresses stale manager heartbeat display while finalizer lease is fresh', () => {
  const now = Date.now();
  const task = createTask({
    id: 'finalizing-task',
    status: 'finalizing',
    leaseOwner: 'finalizer:123',
    leaseHeartbeatAt: now - 1000,
    leaseExpiresAt: now + 60_000,
  });
  const manager = {
    ralphHome: '/tmp/ralph',
    statePath: '/tmp/ralph/manager/state.json',
    lockDir: '/tmp/ralph/manager.lock',
    state: null,
    stateExists: true,
    processRunning: true,
    active: true,
    heartbeatStale: true,
    staleAfterMs: 5000,
    codeDriftDetected: false,
    message: 'manager process 123 is running but heartbeat is stale',
  };

  const lease = findFreshFinalizerLease([task], now);
  const adjusted = adjustManagerStatusForFinalizerLease(manager, lease);

  assert.equal(adjusted.heartbeatStale, false);
  assert.equal(adjusted.heartbeatStaleSuppressed, true);
  assert.equal(adjusted.heartbeatStaleSuppressedReason, 'active_finalizer_lease');
  assert.equal(adjusted.finalizerLease.taskId, 'finalizing-task');
});

test('queue keeps stale manager heartbeat when finalizer lease is expired', () => {
  const now = Date.now();
  const task = createTask({
    id: 'finalizing-task',
    status: 'finalizing',
    leaseOwner: 'finalizer:123',
    leaseHeartbeatAt: now - 60_000,
    leaseExpiresAt: now - 1,
  });
  const manager = {
    ralphHome: '/tmp/ralph',
    statePath: '/tmp/ralph/manager/state.json',
    lockDir: '/tmp/ralph/manager.lock',
    state: null,
    stateExists: true,
    processRunning: true,
    active: true,
    heartbeatStale: true,
    staleAfterMs: 5000,
    codeDriftDetected: false,
    message: 'manager process 123 is running but heartbeat is stale',
  };

  const lease = findFreshFinalizerLease([task], now);
  const adjusted = adjustManagerStatusForFinalizerLease(manager, lease);

  assert.equal(lease, undefined);
  assert.equal(adjusted.heartbeatStale, true);
  assert.equal(adjusted.heartbeatStaleSuppressed, undefined);
});
