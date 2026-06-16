const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  buildCoordinationState,
  captureObservedTaskSurface,
  findCoordinationBlockers,
} = require('../dist/core/task-coordination.js');
const { buildDeliveryState } = require('../dist/core/task-delivery.js');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createTask(overrides = {}) {
  return {
    id: overrides.id || 'task',
    prdId: overrides.prdId || overrides.id || 'task',
    prdPath: overrides.prdPath || '/tmp/prd.json',
    status: overrides.status || 'completed',
    startTime: overrides.startTime || 100,
    enqueuedAt: overrides.enqueuedAt || overrides.startTime || 100,
    completedUS: [],
    worktree: overrides.worktree || '',
    logPath: overrides.logPath || `/tmp/${overrides.id || 'task'}.log`,
    agent: 'codex',
    repoPath: overrides.repoPath || '/repo',
    loopCount: 0,
    consecutiveNoProgress: 0,
    consecutiveErrors: 0,
    lastProgressTime: overrides.startTime || 100,
    lastFilesChanged: 0,
    ...overrides,
  };
}

function createDependencyRepairTask(overrides = {}) {
  const { repairedPrdId = 'upstream-prd', ...taskOverrides } = overrides;

  return createTask({
    id: 'dependency-repair-task',
    prdId: `followup:${repairedPrdId}:repair`,
    priorityClass: 'dependency_repair',
    repairOf: {
      prdId: repairedPrdId,
      taskId: `failed-${repairedPrdId}-task`,
      reason: 'story_repair_hard_cap_reached',
    },
    releasesDependenciesFor: [repairedPrdId],
    effectiveDependencyPrdId: repairedPrdId,
    status: 'pending',
    startTime: 200,
    enqueuedAt: 200,
    ...taskOverrides,
  });
}

test('findCoordinationBlockers blocks merge when earlier same-repo task overlaps on observed write surface', () => {
  const earlierTask = createTask({
    id: 'earlier-task',
    status: 'completed',
    integratedAt: undefined,
    observedWriteSurface: ['packages/contracts/src/index.ts'],
    startTime: 100,
    enqueuedAt: 100,
  });
  const laterTask = createTask({
    id: 'later-task',
    status: 'completed',
    observedWriteSurface: ['packages/contracts/src/index.ts'],
    startTime: 200,
    enqueuedAt: 200,
  });

  const result = findCoordinationBlockers(laterTask, [earlierTask, laterTask], 'merge', { targetBranch: 'main' });

  assert.equal(result.blocked, true);
  assert.equal(result.status, 'blocked_observed_overlap');
  assert.deepEqual(result.blockers, ['earlier-task']);
  assert.equal(result.phase, 'merge');
});

test('findCoordinationBlockers does not block across repositories in a shared Ralph home', () => {
  const earlierTask = createTask({
    id: 'repo-a-task',
    status: 'completed',
    observedWriteSurface: ['packages/contracts/src/index.ts'],
    repoPath: '/repo-a',
    startTime: 100,
    enqueuedAt: 100,
  });
  const laterTask = createTask({
    id: 'repo-b-task',
    status: 'completed',
    observedWriteSurface: ['packages/contracts/src/index.ts'],
    repoPath: '/repo-b',
    startTime: 200,
    enqueuedAt: 200,
  });

  const result = findCoordinationBlockers(laterTask, [earlierTask, laterTask], 'merge', { targetBranch: 'main' });

  assert.equal(result.blocked, false);
  assert.deepEqual(result.blockers, []);
});

test('findCoordinationBlockers keeps failed merge-conflict owners blocking later overlap', () => {
  const earlierTask = createTask({
    id: 'failed-owner',
    status: 'failed',
    repairContext: {
      mode: 'merge',
      storyId: 'US-003',
      createdAt: 123,
      reason: 'Merge repair required by Ralph.',
    },
    mergeConflictFiles: ['packages/contracts/src/index.ts'],
    observedWriteSurface: ['packages/contracts/src/index.ts'],
    startTime: 100,
    enqueuedAt: 100,
  });
  const laterTask = createTask({
    id: 'later-task',
    status: 'pending',
    declaredWriteSurface: ['packages/contracts/src/index.ts'],
    startTime: 200,
    enqueuedAt: 200,
  });

  const result = findCoordinationBlockers(laterTask, [earlierTask, laterTask], 'start', { targetBranch: 'main' });

  assert.equal(result.blocked, true);
  assert.equal(result.status, 'blocked_predicted_overlap');
  assert.deepEqual(result.blockers, ['failed-owner']);
  assert.equal(result.phase, 'start');
});

test('findCoordinationBlockers lets dependency predecessors start before earlier pending downstream overlaps', () => {
  const downstreamTask = createTask({
    id: 'downstream-task',
    prdId: 'downstream-prd',
    status: 'pending',
    prdDependencies: ['upstream-prd'],
    declaredConflictDomains: ['runtime-registry'],
    startTime: 100,
    enqueuedAt: 100,
  });
  const upstreamTask = createTask({
    id: 'upstream-task',
    prdId: 'upstream-prd',
    status: 'pending',
    declaredConflictDomains: ['runtime-registry'],
    startTime: 200,
    enqueuedAt: 200,
  });

  const result = findCoordinationBlockers(upstreamTask, [downstreamTask, upstreamTask], 'start', { targetBranch: 'main' });

  assert.equal(result.blocked, false);
  assert.deepEqual(result.blockers, []);
});

test('findCoordinationBlockers treats dependency repair effective identity as predecessor', () => {
  const downstreamTask = createTask({
    id: 'downstream-task',
    prdId: 'downstream-prd',
    status: 'pending',
    prdDependencies: ['upstream-prd'],
    declaredConflictDomains: ['runtime-registry'],
    startTime: 100,
    enqueuedAt: 100,
  });
  const repairTask = createDependencyRepairTask({
    id: 'repair-followup-task',
    repairedPrdId: 'upstream-prd',
    declaredConflictDomains: ['runtime-registry'],
    startTime: 200,
    enqueuedAt: 200,
  });

  const result = findCoordinationBlockers(repairTask, [downstreamTask, repairTask], 'start', { targetBranch: 'main' });

  assert.equal(result.blocked, false);
  assert.deepEqual(result.blockers, []);
});

test('findCoordinationBlockers infers legacy hard-cap follow-up as dependency repair', () => {
  const sourceTask = createTask({
    id: 'failed-upstream-task',
    prdId: 'upstream-prd',
    status: 'failed',
    followupTaskIds: ['legacy-repair-followup'],
    followupPrdIds: ['followup:upstream-prd:legacy'],
    followupReason: 'story_repair_hard_cap_reached',
    startTime: 50,
    enqueuedAt: 50,
  });
  const downstreamTask = createTask({
    id: 'downstream-task',
    prdId: 'downstream-prd',
    status: 'pending',
    prdDependencies: ['upstream-prd'],
    declaredConflictDomains: ['runtime-registry'],
    startTime: 100,
    enqueuedAt: 100,
  });
  const repairTask = createTask({
    id: 'legacy-repair-followup',
    prdId: 'followup:upstream-prd:legacy',
    status: 'pending',
    declaredConflictDomains: ['runtime-registry'],
    startTime: 200,
    enqueuedAt: 200,
  });

  const result = findCoordinationBlockers(
    repairTask,
    [sourceTask, downstreamTask, repairTask],
    'start',
    { targetBranch: 'main' },
  );

  assert.equal(result.blocked, false);
  assert.deepEqual(result.blockers, []);
});

test('findCoordinationBlockers lets dependency_repair bypass pending downstream overlap', () => {
  const downstreamTask = createTask({
    id: 'pending-downstream-overlap',
    prdId: 'downstream-prd',
    status: 'pending',
    prdDependencies: ['failed-dependency'],
    declaredWriteSurface: ['packages/contracts/src/index.ts'],
    startTime: 100,
    enqueuedAt: 100,
  });
  const repairTask = createDependencyRepairTask({
    id: 'dependency-repair-overlap',
    repairedPrdId: 'failed-dependency',
    declaredWriteSurface: ['packages/contracts/src/index.ts'],
    startTime: 200,
    enqueuedAt: 200,
  });

  const result = findCoordinationBlockers(
    repairTask,
    [downstreamTask, repairTask],
    'start',
    { targetBranch: 'main' },
  );

  assert.equal(result.blocked, false);
  assert.deepEqual(result.blockers, []);
});

test('findCoordinationBlockers lets dependency_repair bypass pending ordinary same-cohort overlap', () => {
  const cohortTask = createTask({
    id: 'pending-same-cohort-overlap',
    prdId: 'same-cohort-prd',
    status: 'pending',
    declaredConflictDomains: ['contracts-index'],
    declaredWriteSurface: ['packages/contracts/src/index.ts'],
    startTime: 100,
    enqueuedAt: 100,
  });
  const repairTask = createDependencyRepairTask({
    id: 'dependency-repair-same-cohort',
    repairedPrdId: 'failed-dependency',
    declaredConflictDomains: ['contracts-index'],
    declaredWriteSurface: ['packages/contracts/src/index.ts'],
    startTime: 200,
    enqueuedAt: 200,
  });

  const result = findCoordinationBlockers(
    repairTask,
    [cohortTask, repairTask],
    'start',
    { targetBranch: 'main' },
  );

  assert.equal(result.blocked, false);
  assert.deepEqual(result.blockers, []);
});

test('findCoordinationBlockers lets dependency_repair bypass pending generated follow-up overlap', () => {
  const generatedFollowup = createTask({
    id: 'pending-generated-followup',
    prdId: 'followup:ux-task:repair',
    prdPath: '/tmp/generated-prds/ux-task/followup.json',
    status: 'pending',
    declaredWriteSurface: ['packages/contracts/src/index.ts'],
    startTime: 100,
    enqueuedAt: 100,
  });
  const repairTask = createDependencyRepairTask({
    id: 'dependency-repair-with-generated-followup',
    repairedPrdId: 'failed-dependency',
    declaredWriteSurface: ['packages/contracts/src/index.ts'],
    startTime: 200,
    enqueuedAt: 200,
  });

  const result = findCoordinationBlockers(
    repairTask,
    [generatedFollowup, repairTask],
    'start',
    { targetBranch: 'main' },
  );

  assert.equal(result.blocked, false);
  assert.deepEqual(result.blockers, []);
});

test('findCoordinationBlockers keeps running overlap blocking dependency_repair', () => {
  const runningTask = createTask({
    id: 'running-overlap',
    prdId: 'running-overlap',
    status: 'running',
    declaredConflictDomains: ['contracts-index'],
    declaredWriteSurface: ['packages/contracts/src/index.ts'],
    startTime: 100,
    enqueuedAt: 100,
  });
  const repairTask = createDependencyRepairTask({
    id: 'dependency-repair-with-running-overlap',
    repairedPrdId: 'failed-dependency',
    declaredConflictDomains: ['contracts-index'],
    declaredWriteSurface: ['packages/contracts/src/index.ts'],
    startTime: 200,
    enqueuedAt: 200,
  });

  const result = findCoordinationBlockers(
    repairTask,
    [runningTask, repairTask],
    'start',
    { targetBranch: 'main' },
  );

  assert.equal(result.blocked, true);
  assert.deepEqual(result.blockers, ['running-overlap']);
});

test('findCoordinationBlockers ignores non-hot original failed source for dependency_repair', () => {
  const failedSourceTask = createTask({
    id: 'failed-dependency-task',
    prdId: 'failed-dependency',
    status: 'failed',
    followupTaskIds: ['dependency-repair-cool-source'],
    observedWriteSurface: ['packages/contracts/src/index.ts'],
    declaredWriteSurface: ['packages/contracts/src/index.ts'],
    startTime: 100,
    enqueuedAt: 100,
  });
  const repairTask = createDependencyRepairTask({
    id: 'dependency-repair-cool-source',
    repairedPrdId: 'failed-dependency',
    declaredWriteSurface: ['packages/contracts/src/index.ts'],
    startTime: 200,
    enqueuedAt: 200,
  });

  const result = findCoordinationBlockers(
    repairTask,
    [failedSourceTask, repairTask],
    'start',
    { targetBranch: 'main' },
  );

  assert.equal(result.blocked, false);
  assert.deepEqual(result.blockers, []);
});

test('findCoordinationBlockers keeps unrelated earlier pending overlap blocking dependency_repair', () => {
  const unrelatedTask = createTask({
    id: 'unrelated-pending-overlap',
    prdId: 'unrelated-prd',
    status: 'pending',
    declaredWriteSurface: ['packages/contracts/src/index.ts'],
    startTime: 100,
    enqueuedAt: 100,
  });
  const repairTask = createDependencyRepairTask({
    id: 'dependency-repair-unrelated-overlap',
    repairedPrdId: 'failed-dependency',
    declaredConflictDomains: ['contracts-index'],
    declaredWriteSurface: ['packages/contracts/src/index.ts'],
    startTime: 200,
    enqueuedAt: 200,
  });

  const result = findCoordinationBlockers(
    repairTask,
    [unrelatedTask, repairTask],
    'start',
    { targetBranch: 'main' },
  );

  assert.equal(result.blocked, true);
  assert.deepEqual(result.blockers, ['unrelated-pending-overlap']);
});

test('findCoordinationBlockers lets dependency predecessors finalize before earlier pending downstream overlaps', () => {
  const downstreamTask = createTask({
    id: 'downstream-task',
    prdId: 'downstream-prd',
    status: 'pending',
    prdDependencies: ['upstream-prd'],
    declaredConflictDomains: ['runtime-registry'],
    startTime: 100,
    enqueuedAt: 100,
  });
  const upstreamTask = createTask({
    id: 'upstream-task',
    prdId: 'upstream-prd',
    status: 'ready_to_finalize',
    declaredConflictDomains: ['runtime-registry'],
    observedWriteSurface: ['packages/control-plane/src/runtime-registry.ts'],
    startTime: 200,
    enqueuedAt: 200,
  });

  const result = findCoordinationBlockers(upstreamTask, [downstreamTask, upstreamTask], 'finalize', { targetBranch: 'main' });

  assert.equal(result.blocked, false);
  assert.deepEqual(result.blockers, []);
});

test('findCoordinationBlockers lets dependency predecessors merge before earlier pending downstream overlaps', () => {
  const downstreamTask = createTask({
    id: 'downstream-task',
    prdId: 'downstream-prd',
    status: 'pending',
    prdDependencies: ['upstream-prd'],
    declaredConflictDomains: ['runtime-registry'],
    startTime: 100,
    enqueuedAt: 100,
  });
  const upstreamTask = createTask({
    id: 'upstream-task',
    prdId: 'upstream-prd',
    status: 'completed',
    declaredConflictDomains: ['runtime-registry'],
    observedWriteSurface: ['packages/control-plane/src/runtime-registry.ts'],
    startTime: 200,
    enqueuedAt: 200,
  });

  const result = findCoordinationBlockers(upstreamTask, [downstreamTask, upstreamTask], 'merge', { targetBranch: 'main' });

  assert.equal(result.blocked, false);
  assert.deepEqual(result.blockers, []);
});

test('findCoordinationBlockers keeps active downstream overlaps blocking despite dependency order', () => {
  const downstreamTask = createTask({
    id: 'downstream-task',
    prdId: 'downstream-prd',
    status: 'running',
    prdDependencies: ['upstream-prd'],
    declaredConflictDomains: ['runtime-registry'],
    startTime: 100,
    enqueuedAt: 100,
  });
  const upstreamTask = createTask({
    id: 'upstream-task',
    prdId: 'upstream-prd',
    status: 'pending',
    declaredConflictDomains: ['runtime-registry'],
    startTime: 200,
    enqueuedAt: 200,
  });

  const result = findCoordinationBlockers(upstreamTask, [downstreamTask, upstreamTask], 'start', { targetBranch: 'main' });

  assert.equal(result.blocked, true);
  assert.deepEqual(result.blockers, ['downstream-task']);
});

test('findCoordinationBlockers ignores already integrated finalize-state product tasks', () => {
  const earlierTask = createTask({
    id: 'integrated-finalize-owner',
    prdId: 'prd-integrated-owner',
    status: 'failed_finalize',
    integrationStatus: 'integrated',
    integratedAt: 500,
    mergeCommitSha: 'abc123',
    observedWriteSurface: ['apps/web/components/header.tsx'],
    declaredWriteSurface: ['apps/web/components/header.tsx'],
    startTime: 100,
    enqueuedAt: 100,
  });
  const laterTask = createTask({
    id: 'later-task',
    status: 'pending',
    declaredWriteSurface: ['apps/web/components/header.tsx'],
    startTime: 200,
    enqueuedAt: 200,
  });

  const result = findCoordinationBlockers(laterTask, [earlierTask, laterTask], 'start', { targetBranch: 'main' });

  assert.equal(result.blocked, false);
  assert.deepEqual(result.blockers, []);
});

test('findCoordinationBlockers lets generated follow-up tasks bypass their source failure only', () => {
  const sourceTask = createTask({
    id: 'source-failed-finalize',
    status: 'failed_finalize',
    declaredWriteSurface: ['apps/web/components/header.tsx'],
    observedWriteSurface: ['apps/web/components/header.tsx'],
    followupTaskIds: ['followup-task'],
    finalizeRepairStoppedAt: 300,
    finalizeRepairStopReason: 'repair_no_progress',
    startTime: 100,
    enqueuedAt: 100,
  });
  const followupTask = createTask({
    id: 'followup-task',
    status: 'pending',
    declaredWriteSurface: ['apps/web/components/header.tsx'],
    startTime: 200,
    enqueuedAt: 200,
  });
  const siblingFollowupTask = createTask({
    id: 'sibling-followup-task',
    prdId: 'followup:sibling-source:abc123',
    status: 'pending',
    declaredWriteSurface: ['apps/web/components/header.tsx'],
    startTime: 225,
    enqueuedAt: 225,
  });
  const unrelatedTask = createTask({
    id: 'unrelated-task',
    status: 'pending',
    declaredWriteSurface: ['apps/web/components/header.tsx'],
    startTime: 250,
    enqueuedAt: 250,
  });

  const followupResult = findCoordinationBlockers(
    followupTask,
    [sourceTask, followupTask],
    'start',
    { targetBranch: 'main' },
  );
  const siblingFollowupResult = findCoordinationBlockers(
    siblingFollowupTask,
    [sourceTask, siblingFollowupTask],
    'start',
    { targetBranch: 'main' },
  );
  const unrelatedResult = findCoordinationBlockers(
    unrelatedTask,
    [sourceTask, unrelatedTask],
    'start',
    { targetBranch: 'main' },
  );

  assert.equal(followupResult.blocked, false);
  assert.deepEqual(followupResult.blockers, []);
  assert.equal(siblingFollowupResult.blocked, false);
  assert.deepEqual(siblingFollowupResult.blockers, []);
  assert.equal(unrelatedResult.blocked, true);
  assert.deepEqual(unrelatedResult.blockers, ['source-failed-finalize']);
});

test('findCoordinationBlockers conservatively blocks unknown-surface tasks behind a hot merge-repair owner', () => {
  const earlierTask = createTask({
    id: 'failed-owner',
    status: 'failed',
    repairContext: {
      mode: 'merge',
      storyId: 'US-003',
      createdAt: 123,
      reason: 'Merge repair required by Ralph.',
    },
    mergeConflictFiles: ['packages/contracts/src/index.ts'],
    observedWriteSurface: ['packages/contracts/src/index.ts'],
    startTime: 100,
    enqueuedAt: 100,
  });
  const laterTask = createTask({
    id: 'later-unknown-surface',
    status: 'pending',
    startTime: 200,
    enqueuedAt: 200,
  });

  const result = findCoordinationBlockers(laterTask, [earlierTask, laterTask], 'start', { targetBranch: 'main' });

  assert.equal(result.blocked, true);
  assert.deepEqual(result.blockers, ['failed-owner']);
  assert.deepEqual(result.matches[0].overlappingPaths, ['<unknown-surface-during-hot-merge-repair>']);
});

test('findCoordinationBlockers lets baseline repair tasks bypass non-running ordinary blockers', () => {
  const demandTask = createTask({
    id: 'baseline-blocked-task',
    status: 'failed_finalize',
    autoRecoveryKind: 'baseline_repair',
    declaredWriteSurface: ['packages/contracts/src/index.ts'],
    startTime: 100,
    enqueuedAt: 100,
  });
  const ordinaryReadyTask = createTask({
    id: 'ordinary-ready-task',
    status: 'ready_to_finalize',
    declaredWriteSurface: ['packages/contracts/src/index.ts'],
    startTime: 110,
    enqueuedAt: 110,
  });
  const otherBaselineRepair = createTask({
    id: 'other-baseline-repair-task',
    prdId: 'baseline-quality-gate:def',
    status: 'pending',
    declaredWriteSurface: ['packages/contracts/src/index.ts'],
    baselineRepair: {
      repairKey: 'baseline-quality-gate|main|test|apps/web',
      rootCause: 'shared_baseline_code_debt',
      targetBranch: 'main',
      gate: 'test',
      packageLabel: 'apps/web',
      demandTaskIds: ['other-demand'],
      repairTaskId: 'other-baseline-repair-task',
      repairPrdId: 'baseline-quality-gate:def',
      startedAt: 120,
      updatedAt: 120,
      status: 'waiting',
    },
    startTime: 120,
    enqueuedAt: 120,
  });
  const repairTask = createTask({
    id: 'baseline-repair-task',
    prdId: 'baseline-quality-gate:abc',
    status: 'pending',
    declaredWriteSurface: ['packages/contracts/src/index.ts'],
    declaredConflictDomains: ['baseline-quality-gate', 'apps/web'],
    baselineRepair: {
      repairKey: 'baseline-quality-gate|main|build|apps/web',
      rootCause: 'shared_baseline_code_debt',
      targetBranch: 'main',
      gate: 'build',
      packageLabel: 'apps/web',
      demandTaskIds: ['baseline-blocked-task'],
      repairTaskId: 'baseline-repair-task',
      repairPrdId: 'baseline-quality-gate:abc',
      startedAt: 200,
      updatedAt: 200,
      status: 'waiting',
    },
    startTime: 200,
    enqueuedAt: 200,
  });

  const result = findCoordinationBlockers(
    repairTask,
    [demandTask, ordinaryReadyTask, otherBaselineRepair, repairTask],
    'start',
    { targetBranch: 'main' },
  );

  assert.equal(result.blocked, true);
  assert.deepEqual(result.blockers, ['other-baseline-repair-task']);
});

test('findCoordinationBlockers lets nested baseline repair start behind its failed repair demand', () => {
  const failedRepairDemand = createTask({
    id: 'failed-baseline-repair-task',
    prdId: 'baseline-quality-gate:old',
    status: 'failed_finalize',
    autoRecoveryKind: 'baseline_repair',
    declaredWriteSurface: ['apps/api'],
    observedWriteSurface: ['apps/api/src/test.ts'],
    baselineQualityGate: {
      kind: 'baseline_quality_gate_failure',
      observedAt: 200,
      targetBranch: 'main',
      gate: 'test',
      packageLabel: 'apps/api',
      signature: 'test|apps/api|old',
      repairTaskId: 'nested-baseline-repair-task',
      message: 'repair task hit another baseline failure',
    },
    baselineRepair: {
      repairKey: 'baseline-quality-gate|main|test|apps/api|old',
      rootCause: 'shared_baseline_code_debt',
      targetBranch: 'main',
      gate: 'test',
      packageLabel: 'apps/api',
      demandTaskIds: ['feature-demand-task'],
      repairTaskId: 'failed-baseline-repair-task',
      repairPrdId: 'baseline-quality-gate:old',
      startedAt: 100,
      updatedAt: 200,
      status: 'waiting',
    },
    startTime: 100,
    enqueuedAt: 100,
  });
  const nestedRepairTask = createTask({
    id: 'nested-baseline-repair-task',
    prdId: 'baseline-quality-gate:nested',
    status: 'pending',
    declaredWriteSurface: ['apps/api'],
    declaredConflictDomains: ['baseline-quality-gate', 'apps/api'],
    baselineRepair: {
      repairKey: 'baseline-quality-gate|main|test|apps/api|nested',
      rootCause: 'shared_baseline_code_debt',
      targetBranch: 'main',
      gate: 'test',
      packageLabel: 'apps/api',
      demandTaskIds: ['failed-baseline-repair-task'],
      repairTaskId: 'nested-baseline-repair-task',
      repairPrdId: 'baseline-quality-gate:nested',
      startedAt: 300,
      updatedAt: 300,
      status: 'waiting',
    },
    startTime: 300,
    enqueuedAt: 300,
  });

  const result = findCoordinationBlockers(
    nestedRepairTask,
    [failedRepairDemand, nestedRepairTask],
    'start',
    { targetBranch: 'main' },
  );

  assert.equal(result.blocked, false);
  assert.deepEqual(result.blockers, []);
});

test('findCoordinationBlockers lets chained baseline repair start behind failed ancestor waiting on its demand', () => {
  const ancestorRepair = createTask({
    id: 'ancestor-repair-task',
    prdId: 'baseline-quality-gate:ancestor',
    status: 'failed_finalize',
    autoRecoveryKind: 'baseline_repair',
    declaredWriteSurface: ['apps/api'],
    observedWriteSurface: ['apps/api/src/test.ts'],
    baselineQualityGate: {
      kind: 'baseline_quality_gate_failure',
      observedAt: 200,
      targetBranch: 'main',
      gate: 'test',
      packageLabel: 'apps/api',
      signature: 'test|apps/api|ancestor',
      repairTaskId: 'middle-repair-task',
      message: 'ancestor repair is waiting for middle repair',
    },
    baselineRepair: {
      repairKey: 'baseline-quality-gate|main|test|apps/api|ancestor',
      rootCause: 'shared_baseline_code_debt',
      targetBranch: 'main',
      gate: 'test',
      packageLabel: 'apps/api',
      demandTaskIds: ['ancestor-repair-task'],
      repairTaskId: 'middle-repair-task',
      repairPrdId: 'baseline-quality-gate:middle',
      startedAt: 100,
      updatedAt: 200,
      status: 'waiting',
    },
    startTime: 100,
    enqueuedAt: 100,
  });
  const chainedRepair = createTask({
    id: 'chained-build-repair-task',
    prdId: 'baseline-quality-gate:build',
    status: 'pending',
    declaredWriteSurface: ['apps/api'],
    declaredConflictDomains: ['baseline-quality-gate', 'apps/api'],
    baselineRepair: {
      repairKey: 'baseline-quality-gate|main|build|apps/api',
      rootCause: 'generated_artifact_drift',
      targetBranch: 'main',
      gate: 'build',
      packageLabel: 'apps/api',
      demandTaskIds: ['middle-repair-task'],
      repairTaskId: 'chained-build-repair-task',
      repairPrdId: 'baseline-quality-gate:build',
      startedAt: 300,
      updatedAt: 300,
      status: 'waiting',
    },
    startTime: 300,
    enqueuedAt: 300,
  });

  const result = findCoordinationBlockers(
    chainedRepair,
    [ancestorRepair, chainedRepair],
    'start',
    { targetBranch: 'main' },
  );

  assert.equal(result.blocked, false);
  assert.deepEqual(result.blockers, []);
});

test('findCoordinationBlockers lets baseline repair start behind transitive failed baseline ancestors', () => {
  const ancestorRepair = createTask({
    id: 'ancestor-test-repair-task',
    prdId: 'baseline-quality-gate:ancestor',
    status: 'failed_finalize',
    autoRecoveryKind: 'baseline_repair',
    declaredWriteSurface: ['apps/api'],
    observedWriteSurface: ['apps/api/package.json'],
    baselineQualityGate: {
      kind: 'baseline_quality_gate_failure',
      observedAt: 200,
      targetBranch: 'main',
      gate: 'test',
      packageLabel: 'apps/api',
      signature: 'test|apps/api|ancestor',
      repairTaskId: 'middle-test-repair-task',
      message: 'ancestor repair is waiting for middle repair',
    },
    baselineRepair: {
      repairKey: 'baseline-quality-gate|main|test|apps/api|ancestor',
      rootCause: 'shared_baseline_code_debt',
      targetBranch: 'main',
      gate: 'test',
      packageLabel: 'apps/api',
      demandTaskIds: ['original-feature-task'],
      repairTaskId: 'middle-test-repair-task',
      repairPrdId: 'baseline-quality-gate:middle',
      startedAt: 100,
      updatedAt: 200,
      status: 'waiting',
    },
    startTime: 100,
    enqueuedAt: 100,
  });
  const middleRepair = createTask({
    id: 'middle-test-repair-task',
    prdId: 'baseline-quality-gate:middle',
    status: 'failed_finalize',
    autoRecoveryKind: 'baseline_repair',
    declaredWriteSurface: ['apps/api'],
    observedWriteSurface: ['apps/api/src/module.ts'],
    baselineQualityGate: {
      kind: 'baseline_quality_gate_failure',
      observedAt: 300,
      targetBranch: 'main',
      gate: 'build',
      packageLabel: 'apps/api',
      signature: 'build|apps/api|middle',
      repairTaskId: 'demand-build-repair-task',
      message: 'middle repair is waiting for build repair',
    },
    baselineRepair: {
      repairKey: 'baseline-quality-gate|main|build|apps/api|middle',
      rootCause: 'generated_artifact_drift',
      targetBranch: 'main',
      gate: 'build',
      packageLabel: 'apps/api',
      demandTaskIds: ['ancestor-test-repair-task'],
      repairTaskId: 'demand-build-repair-task',
      repairPrdId: 'baseline-quality-gate:build',
      startedAt: 200,
      updatedAt: 300,
      status: 'waiting',
    },
    startTime: 200,
    enqueuedAt: 200,
  });
  const demandBuildRepair = createTask({
    id: 'demand-build-repair-task',
    prdId: 'baseline-quality-gate:build',
    status: 'failed_finalize',
    autoRecoveryKind: 'baseline_repair',
    declaredWriteSurface: ['apps/api'],
    observedWriteSurface: ['packages/db/prisma/generate-safe.mjs'],
    startTime: 300,
    enqueuedAt: 300,
  });
  const newTestRepair = createTask({
    id: 'new-test-repair-task',
    prdId: 'baseline-quality-gate:new-test',
    status: 'pending',
    declaredWriteSurface: ['apps/api'],
    declaredConflictDomains: ['baseline-quality-gate', 'apps/api'],
    baselineRepair: {
      repairKey: 'baseline-quality-gate|main|test|apps/api|new',
      rootCause: 'shared_baseline_code_debt',
      targetBranch: 'main',
      gate: 'test',
      packageLabel: 'apps/api',
      demandTaskIds: ['demand-build-repair-task'],
      repairTaskId: 'new-test-repair-task',
      repairPrdId: 'baseline-quality-gate:new-test',
      startedAt: 400,
      updatedAt: 400,
      status: 'waiting',
    },
    startTime: 400,
    enqueuedAt: 400,
  });

  const result = findCoordinationBlockers(
    newTestRepair,
    [ancestorRepair, middleRepair, demandBuildRepair, newTestRepair],
    'start',
    { targetBranch: 'main' },
  );

  assert.equal(result.blocked, false);
  assert.deepEqual(result.blockers, []);
});

test('findCoordinationBlockers keeps running ordinary blockers ahead of baseline repair tasks', () => {
  const runningTask = createTask({
    id: 'running-task',
    status: 'running',
    declaredWriteSurface: ['packages/contracts/src/index.ts'],
    startTime: 100,
    enqueuedAt: 100,
  });
  const repairTask = createTask({
    id: 'baseline-repair-task',
    prdId: 'baseline-quality-gate:abc',
    status: 'pending',
    declaredWriteSurface: ['packages/contracts/src/index.ts'],
    baselineRepair: {
      repairKey: 'baseline-quality-gate|main|build|apps/web',
      rootCause: 'shared_baseline_code_debt',
      targetBranch: 'main',
      gate: 'build',
      packageLabel: 'apps/web',
      demandTaskIds: ['baseline-blocked-task'],
      repairTaskId: 'baseline-repair-task',
      repairPrdId: 'baseline-quality-gate:abc',
      startedAt: 200,
      updatedAt: 200,
      status: 'waiting',
    },
    startTime: 200,
    enqueuedAt: 200,
  });

  const result = findCoordinationBlockers(repairTask, [runningTask, repairTask], 'start', { targetBranch: 'main' });

  assert.equal(result.blocked, true);
  assert.deepEqual(result.blockers, ['running-task']);
});

test('findCoordinationBlockers lets baseline repair finalize before non-running overlap cohort', () => {
  const ordinaryReadyTask = createTask({
    id: 'ordinary-ready-task',
    status: 'ready_to_finalize',
    declaredWriteSurface: ['packages/contracts/src/index.ts'],
    observedWriteSurface: ['packages/contracts/src/index.ts'],
    startTime: 100,
    enqueuedAt: 100,
  });
  const failedDemandTask = createTask({
    id: 'failed-demand-task',
    status: 'failed_finalize',
    autoRecoveryKind: 'baseline_repair',
    declaredWriteSurface: ['packages/contracts/src/index.ts'],
    observedWriteSurface: ['packages/contracts/src/index.ts'],
    baselineQualityGate: {
      kind: 'baseline_quality_gate_failure',
      observedAt: 150,
      targetBranch: 'main',
      gate: 'build',
      packageLabel: 'apps/web',
      signature: 'build|apps/web',
      repairKey: 'baseline-quality-gate|main|build|apps/web',
      repairTaskId: 'baseline-repair-task',
      message: 'shared baseline build failed',
    },
    startTime: 150,
    enqueuedAt: 150,
  });
  const repairTask = createTask({
    id: 'baseline-repair-task',
    prdId: 'baseline-quality-gate:abc',
    status: 'ready_to_finalize',
    declaredWriteSurface: ['packages/contracts/src/index.ts'],
    observedWriteSurface: ['packages/contracts/src/index.ts'],
    baselineRepair: {
      repairKey: 'baseline-quality-gate|main|build|apps/web',
      rootCause: 'shared_baseline_code_debt',
      targetBranch: 'main',
      gate: 'build',
      packageLabel: 'apps/web',
      demandTaskIds: ['failed-demand-task'],
      repairTaskId: 'baseline-repair-task',
      repairPrdId: 'baseline-quality-gate:abc',
      startedAt: 200,
      updatedAt: 200,
      status: 'waiting',
    },
    startTime: 200,
    enqueuedAt: 200,
  });

  const result = findCoordinationBlockers(
    repairTask,
    [ordinaryReadyTask, failedDemandTask, repairTask],
    'finalize',
    { targetBranch: 'main' },
  );

  assert.equal(result.blocked, false);
  assert.deepEqual(result.blockers, []);
});

test('findCoordinationBlockers lets baseline repair merge before generated follow-up overlap', () => {
  const generatedFollowup = createTask({
    id: 'generated-followup-task',
    prdId: 'followup:failed-feature:baseline_quality_gate_failure',
    prdPath: '/tmp/ralph-home/generated-prds/failed-feature/followup.json',
    status: 'pending',
    declaredWriteSurface: ['packages/control-plane'],
    declaredConflictDomains: ['packages/control-plane'],
    startTime: 100,
    enqueuedAt: 100,
  });
  const repairTask = createTask({
    id: 'baseline-repair-task',
    prdId: 'baseline-quality-gate:abc',
    status: 'completed',
    declaredWriteSurface: ['packages/control-plane'],
    declaredConflictDomains: ['baseline-quality-gate', 'packages/control-plane'],
    observedWriteSurface: ['packages/control-plane/src/self-evolution.ts'],
    observedPackageSurface: ['packages/control-plane'],
    baselineRepair: {
      repairKey: 'baseline-quality-gate|main|test|packages/control-plane',
      rootCause: 'generated_artifact_drift',
      targetBranch: 'main',
      gate: 'test',
      packageLabel: 'packages/control-plane',
      demandTaskIds: ['failed-feature-task'],
      repairTaskId: 'baseline-repair-task',
      repairPrdId: 'baseline-quality-gate:abc',
      startedAt: 200,
      updatedAt: 200,
      status: 'waiting',
    },
    startTime: 200,
    enqueuedAt: 200,
  });

  const result = findCoordinationBlockers(
    repairTask,
    [generatedFollowup, repairTask],
    'merge',
    { targetBranch: 'main' },
  );

  assert.equal(result.blocked, false);
  assert.deepEqual(result.blockers, []);
});

test('findCoordinationBlockers keeps nested baseline repair tasks as barrier tasks', () => {
  const ordinaryReadyTask = createTask({
    id: 'ordinary-ready-task',
    status: 'ready_to_finalize',
    declaredWriteSurface: ['apps/web'],
    observedWriteSurface: ['apps/web/app/page.tsx'],
    startTime: 100,
    enqueuedAt: 100,
  });
  const repairTask = createTask({
    id: 'baseline-repair-task',
    prdId: 'baseline-quality-gate:test-repair',
    prdPath: '/tmp/ralph-home/baseline-repairs/baseline-quality-gate-test-repair.json',
    status: 'ready_to_finalize',
    declaredWriteSurface: ['apps/web'],
    observedWriteSurface: ['apps/web/app/page.tsx'],
    baselineRepair: {
      repairKey: 'baseline-quality-gate|main|build|apps/web',
      rootCause: 'shared_baseline_code_debt',
      targetBranch: 'main',
      gate: 'build',
      packageLabel: 'apps/web',
      demandTaskIds: ['baseline-repair-task'],
      repairTaskId: 'older-build-repair-task',
      repairPrdId: 'baseline-quality-gate:older-build-repair',
      startedAt: 200,
      updatedAt: 200,
      status: 'integrated',
    },
    startTime: 200,
    enqueuedAt: 200,
  });

  const result = findCoordinationBlockers(
    repairTask,
    [ordinaryReadyTask, repairTask],
    'finalize',
    { targetBranch: 'main' },
  );

  assert.equal(result.blocked, false);
  assert.deepEqual(result.blockers, []);
});

test('buildDeliveryState infers deferred dirty-checkout sync for legacy tasks without targetSyncStatus', () => {
  const delivery = buildDeliveryState({
    integratedAt: 123,
    integrationStatus: undefined,
    integrationCommitSha: 'abc123',
    integrationBranch: 'ralph/integration/main',
    integrationWorktree: '/tmp/integration',
    targetSyncedAt: undefined,
    targetSyncStatus: undefined,
    targetSyncDeferredReason: 'main sync deferred: checkout /repo has uncommitted changes',
    mergeTargetBranch: 'main',
    mergeStrategy: 'manual',
    mergeCommitSha: 'abc123',
    mergeMessage: 'Integrated branch; main sync deferred: checkout /repo has uncommitted changes',
    mergeError: undefined,
  });

  assert.equal(delivery.integrationStatus, 'integrated');
  assert.equal(delivery.targetSyncStatus, 'deferred_dirty_checkout');
});

test('buildCoordinationState exposes blocker and observed surface details', () => {
  const coordination = buildCoordinationState({
    coordinationStatus: 'blocked_observed_overlap',
    coordinationPhase: 'merge',
    coordinationBlockers: ['task-a'],
    coordinationReason: 'Earlier overlapping task(s) must integrate first: task-a',
    integrationLane: 'main',
    declaredWriteSurface: ['packages/contracts'],
    declaredConflictDomains: ['contracts-index'],
    observedWriteSurface: ['packages/contracts/src/index.ts'],
    observedPackageSurface: ['packages/contracts'],
    surfaceCapturedAt: 123,
  });

  assert.equal(coordination.status, 'blocked_observed_overlap');
  assert.equal(coordination.phase, 'merge');
  assert.deepEqual(coordination.blockers, ['task-a']);
  assert.deepEqual(coordination.observedPackageSurface, ['packages/contracts']);
});

test('captureObservedTaskSurface excludes git-internal paths from the observed write surface', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-coordination-surface-'));

  try {
    git(repoDir, ['init', '-b', 'main']);
    git(repoDir, ['config', 'user.name', 'Ralph Test']);
    git(repoDir, ['config', 'user.email', 'ralph@example.com']);

    fs.mkdirSync(path.join(repoDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'docs', 'TODO.md'), 'base\n');
    git(repoDir, ['add', 'docs/TODO.md']);
    git(repoDir, ['commit', '-m', 'chore: base']);

    const baseCommitSha = git(repoDir, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(repoDir, 'docs', 'TODO.md'), 'base\nchange\n');
    fs.mkdirSync(path.join(repoDir, '.git-local'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, '.git-local', 'MERGE_HEAD'), 'metadata\n');

    const observed = captureObservedTaskSurface({
      worktree: repoDir,
      repoPath: repoDir,
      baseCommitSha,
    });

    assert.deepEqual(observed.observedWriteSurface, ['docs/TODO.md']);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
