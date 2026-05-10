const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildBaselineRepairGraph,
  coalesceBaselineRepairGraph,
  findBaselineRepairSccs,
} = require('../dist/core/baseline-repair-graph.js');
const { StateManager } = require('../dist/core/state.js');

function createTask(tempDir, id, overrides = {}) {
  return {
    id,
    prdPath: path.join(tempDir, `${id}.json`),
    prdId: `baseline-quality-gate:${id}`,
    prdTitle: `Repair ${id}`,
    status: 'failed_finalize',
    startTime: 100,
    completedUS: ['US-001'],
    storyProgress: [{
      id: 'US-001',
      status: 'passed',
      attempts: 1,
      updatedAt: 100,
    }],
    worktree: path.join(tempDir, 'repo', '.ralph-worktrees', id),
    logPath: path.join(tempDir, 'logs', `${id}.log`),
    agent: 'codex',
    repoPath: path.join(tempDir, 'repo'),
    loopCount: 1,
    consecutiveNoProgress: 0,
    consecutiveErrors: 0,
    lastProgressTime: 100,
    lastFilesChanged: 1,
    ...overrides,
  };
}

test('baseline repair graph detects and coalesces same-group mutual repair cycle', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-baseline-graph-'));
  const ralphHome = path.join(tempDir, 'ralph-home');
  const stateManager = new StateManager({ ralphHome });
  const buildRepair = createTask(tempDir, 'task-build', {
    updatedAt: 100,
    baselineRepair: {
      repairKey: 'baseline-quality-gate|main|build|apps/api',
      targetBranch: 'main',
      gate: 'build',
      packageLabel: 'apps/api',
      demandTaskIds: ['task-demand-a'],
      repairTaskId: 'task-build',
      repairPrdId: 'baseline-quality-gate:build',
      startedAt: 100,
      updatedAt: 100,
      status: 'waiting',
    },
    baselineQualityGate: {
      kind: 'baseline_quality_gate_failure',
      observedAt: 100,
      targetBranch: 'main',
      gate: 'test',
      packageLabel: 'apps/api',
      signature: 'test-signature',
      repairKey: 'baseline-quality-gate|main|test|apps/api',
      message: 'wait for test repair',
      phase: 'waiting_for_baseline_repair',
      repairTaskId: 'task-test',
    },
  });
  const testRepair = createTask(tempDir, 'task-test', {
    updatedAt: 200,
    lastFilesChanged: 13,
    baselineRepair: {
      repairKey: 'baseline-quality-gate|main|test|apps/api',
      targetBranch: 'main',
      gate: 'test',
      packageLabel: 'apps/api',
      demandTaskIds: ['task-demand-b'],
      repairTaskId: 'task-test',
      repairPrdId: 'baseline-quality-gate:test',
      startedAt: 100,
      updatedAt: 200,
      status: 'waiting',
    },
    baselineQualityGate: {
      kind: 'baseline_quality_gate_failure',
      observedAt: 200,
      targetBranch: 'main',
      gate: 'build',
      packageLabel: 'apps/api',
      signature: 'build-signature',
      repairKey: 'baseline-quality-gate|main|build|apps/api',
      message: 'wait for build repair',
      phase: 'waiting_for_baseline_repair',
      repairTaskId: 'task-build',
    },
  });
  const demandTask = createTask(tempDir, 'task-demand-a', {
    prdId: 'ordinary-demand',
    baselineQualityGate: {
      kind: 'baseline_quality_gate_failure',
      observedAt: 150,
      targetBranch: 'main',
      gate: 'build',
      packageLabel: 'apps/api',
      signature: 'demand-signature',
      repairKey: 'baseline-quality-gate|main|build|apps/api',
      message: 'wait for build repair',
      phase: 'waiting_for_baseline_repair',
      repairTaskId: 'task-build',
    },
  });

  try {
    fs.mkdirSync(path.join(tempDir, 'repo'), { recursive: true });
    await stateManager.saveTask(buildRepair);
    await stateManager.saveTask(testRepair);
    await stateManager.saveTask(demandTask);

    const graph = buildBaselineRepairGraph([buildRepair, testRepair, demandTask]);
    const sccs = findBaselineRepairSccs(graph);
    assert.equal(sccs.length, 1);
    assert.deepEqual(sccs[0].taskIds, ['task-build', 'task-test']);
    assert.equal(sccs[0].sameGroup, true);
    assert.deepEqual(sccs[0].repairGroupKeys, ['baseline-quality-gate|main|package:apps/api']);

    const result = await coalesceBaselineRepairGraph({
      tasks: [buildRepair, testRepair, demandTask],
      stateManager,
      now: () => 300,
    });

    assert.equal(result.collapsed, 1);
    assert.deepEqual(result.canonicalTaskIds, ['task-test']);
    assert.deepEqual(result.supersededTaskIds, ['task-build']);

    const canonical = await stateManager.loadTask('task-test');
    const superseded = await stateManager.loadTask('task-build');
    const redirectedDemand = await stateManager.loadTask('task-demand-a');

    assert.equal(canonical.status, 'pending');
    assert.equal(canonical.baselineRepair.status, 'needs_more_repair');
    assert.equal(canonical.baselineRepair.repairGroupKey, 'baseline-quality-gate|main|package:apps/api');
    assert.deepEqual(canonical.baselineRepair.demandTaskIds, ['task-demand-a', 'task-demand-b']);
    assert.deepEqual(
      canonical.baselineRepair.repairKeyAliases,
      [
        'baseline-quality-gate|main|build|apps/api',
        'baseline-quality-gate|main|test|apps/api',
      ],
    );
    assert.equal(canonical.baselineQualityGate.repairTaskId, undefined);
    assert.equal(superseded.baselineRepair.status, 'superseded');
    assert.equal(superseded.baselineRepair.supersededByRepairTaskId, 'task-test');
    assert.equal(redirectedDemand.baselineQualityGate.repairTaskId, 'task-test');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('baseline repair graph migrates superseded product tasks instead of failing them as repair tasks', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-baseline-product-migrate-'));
  const ralphHome = path.join(tempDir, 'ralph-home');
  const stateManager = new StateManager({ ralphHome });
  const canonicalRepair = createTask(tempDir, 'task-canonical', {
    prdId: 'baseline-quality-gate:canonical',
    status: 'running',
    baselineRepairRole: 'dedicated_repair_task',
    baselineRepair: {
      repairKey: 'baseline-quality-gate|main|test|apps/web',
      repairGroupKey: 'baseline-quality-gate|main|package:apps/web',
      targetBranch: 'main',
      gate: 'test',
      packageLabel: 'apps/web',
      demandTaskIds: ['task-product'],
      repairTaskId: 'task-canonical',
      repairPrdId: 'baseline-quality-gate:canonical',
      dedicatedRepairTask: true,
      startedAt: 100,
      updatedAt: 100,
      status: 'waiting',
    },
  });
  const productTask = createTask(tempDir, 'task-product', {
    prdId: 'prd-review-center',
    status: 'failed_finalize',
    lastErrorKind: 'baseline_repair_superseded',
    lastError: 'Superseded by canonical baseline repair task task-canonical',
    autoRecoveryStoppedAt: 200,
    autoRecoveryStopReason: 'baseline_repair_superseded',
    baselineRepair: {
      repairKey: 'baseline-quality-gate|main|test|apps/web',
      repairGroupKey: 'baseline-quality-gate|main|package:apps/web',
      targetBranch: 'main',
      gate: 'test',
      packageLabel: 'apps/web',
      demandTaskIds: ['task-product'],
      repairTaskId: 'task-product',
      repairPrdId: 'prd-review-center',
      startedAt: 100,
      updatedAt: 200,
      status: 'superseded',
      supersededByRepairTaskId: 'task-canonical',
      message: 'Superseded by canonical baseline repair task task-canonical',
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
      repairTaskId: 'task-product',
      stoppedAt: 200,
      stopReason: 'baseline_repair_superseded',
    },
  });

  try {
    fs.mkdirSync(path.join(tempDir, 'repo'), { recursive: true });
    await stateManager.saveTask(canonicalRepair);
    await stateManager.saveTask(productTask);

    const result = await coalesceBaselineRepairGraph({
      tasks: [canonicalRepair, productTask],
      stateManager,
      now: () => 300,
    });

    assert.equal(result.collapsed, 0);
    const migrated = await stateManager.loadTask('task-product');
    assert.equal(migrated.status, 'failed_finalize');
    assert.equal(migrated.lastErrorKind, 'quality_gate_failure');
    assert.equal(migrated.autoRecoveryKind, 'baseline_repair');
    assert.equal(migrated.autoRecoveryStoppedAt, undefined);
    assert.equal(migrated.baselineRepairRole, 'demand_task');
    assert.equal(migrated.baselineRepair.repairTaskId, 'task-canonical');
    assert.equal(migrated.baselineRepair.status, 'waiting');
    assert.equal(migrated.baselineQualityGate.repairTaskId, 'task-canonical');
    assert.equal(migrated.baselineQualityGate.phase, 'waiting_for_baseline_repair');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
