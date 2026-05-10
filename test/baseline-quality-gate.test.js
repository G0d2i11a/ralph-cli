const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  classifyBaselineQualityGateFailure,
  deriveBaselineRepairGroupKey,
  isBaselineQualityGateStateCurrent,
} = require('../dist/core/baseline-quality-gate.js');
const {
  ensureBaselineRepairTask,
} = require('../dist/core/baseline-repair.js');
const {
  repairTaskWorktreeDependencyBootstrap,
} = require('../dist/core/baseline-environment-repair.js');
const { StateManager } = require('../dist/core/state.js');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createRepoFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-baseline-gate-'));
  const repoPath = path.join(tempDir, 'repo');
  const taskWorktree = path.join(repoPath, '.ralph-worktrees', 'task-1');
  const baselineCwd = path.join(repoPath, 'apps', 'api');
  const taskCwd = path.join(taskWorktree, 'apps', 'api');

  fs.mkdirSync(baselineCwd, { recursive: true });
  fs.mkdirSync(taskCwd, { recursive: true });
  fs.writeFileSync(path.join(baselineCwd, 'package.json'), '{"scripts":{"typecheck":"tsc"}}\n');

  git(repoPath, ['init', '-b', 'main']);
  git(repoPath, ['config', 'user.email', 'ralph@example.test']);
  git(repoPath, ['config', 'user.name', 'Ralph Test']);
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-m', 'initial']);

  return {
    tempDir,
    repoPath,
    taskWorktree,
    baselineCwd,
    taskCwd,
  };
}

function createTask(fixture, overrides = {}) {
  return {
    id: 'baseline-task',
    prdPath: path.join(fixture.repoPath, 'prd.json'),
    status: 'failed_finalize',
    startTime: 100,
    completedUS: ['US-001'],
    worktree: fixture.taskWorktree,
    logPath: path.join(fixture.tempDir, 'task.log'),
    agent: 'codex',
    repoPath: fixture.repoPath,
    loopCount: 1,
    consecutiveNoProgress: 0,
    consecutiveErrors: 0,
    lastProgressTime: 100,
    lastFilesChanged: 1,
    lastErrorKind: 'quality_gate_failure',
    finalizerFailure: {
      failureKind: 'quality_gate',
      class: 'typescript_diagnostics',
      gate: 'typecheck',
      requestedGate: 'typecheck',
      packageLabel: 'apps/api',
      cwd: fixture.taskCwd,
      command: 'npm run typecheck',
      exitCode: 2,
      rawMessage: 'src/service.ts(1,1): error TS2322',
    },
    ...overrides,
  };
}

function createConfigManager(overrides = {}) {
  const values = {
    'finalizer.qualityGateTimeout': 30,
    ...overrides,
  };

  return {
    get(key) {
      return values[key];
    },
  };
}

test('baseline quality-gate classifier records baseline failure when target gate fails', async () => {
  const fixture = createRepoFixture();
  const task = createTask(fixture);
  let probeInput;

  try {
    const classification = await classifyBaselineQualityGateFailure({
      task,
      configManager: createConfigManager(),
      runGate: (input) => {
        probeInput = input;
        return {
          ok: false,
          exitCode: 2,
          message: 'baseline typecheck failed',
        };
      },
    });

    assert.equal(classification.kind, 'baseline_quality_gate_failure');
    assert.equal(classification.baselineFailure.cwd, fixture.baselineCwd);
    assert.equal(classification.baselineFailure.rawMessage, 'baseline typecheck failed');
    assert.equal(probeInput.cwd, fixture.baselineCwd);
    assert.equal(probeInput.command, 'npm run typecheck');
    assert.equal(probeInput.timeoutMs, 30_000);
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test('baseline quality-gate classifier treats module resolution on target as shared baseline debt', async () => {
  const fixture = createRepoFixture();
  const task = createTask(fixture, {
    finalizerFailure: {
      ...createTask(fixture).finalizerFailure,
      rawMessage: 'task typecheck failed',
    },
  });

  try {
    const classification = await classifyBaselineQualityGateFailure({
      task,
      configManager: createConfigManager(),
      targetBranch: 'main',
      runGate: () => ({
        ok: false,
        exitCode: 1,
        message: "Module not found: Can't resolve './entitlement.js' in packages/contracts/src/index.ts",
      }),
    });

    assert.equal(classification.kind, 'baseline_quality_gate_failure');
    assert.equal(classification.rootCause, 'shared_baseline_code_debt');
    assert.match(classification.baselineFailureSignature, /entitlement\.js/);
    assert.doesNotMatch(classification.baselineFailureSignature, /task typecheck failed/);
    assert.match(classification.repairKey, /baseline-quality-gate\|main\|/);
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test('baseline quality-gate classifier treats Turbopack node_modules symlink as worktree environment', async () => {
  const fixture = createRepoFixture();
  const task = createTask(fixture, {
    finalizerFailure: {
      ...createTask(fixture).finalizerFailure,
      rawMessage: 'Turbopack internal error: symlink apps/web/node_modules is invalid because it points outside the filesystem root',
    },
  });

  try {
    const classification = await classifyBaselineQualityGateFailure({
      task,
      configManager: createConfigManager(),
      runGate: () => ({
        ok: true,
        exitCode: 0,
        message: 'baseline passed',
      }),
    });

    assert.equal(classification.kind, 'task_quality_gate_failure');
    assert.equal(classification.rootCause, 'dependency_bootstrap_worktree_environment');
    assert.equal(classification.taskRootCause, 'dependency_bootstrap_worktree_environment');
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test('baseline quality-gate classifier short-circuits Corepack download failure as task environment', async () => {
  const fixture = createRepoFixture();
  const task = createTask(fixture, {
    finalizerFailure: {
      ...createTask(fixture).finalizerFailure,
      rawMessage: 'Corepack is about to download https://registry.npmjs.org/pnpm/-/pnpm-9.0.0.tgz and failed with Connect Timeout',
    },
  });
  let probed = false;

  try {
    const classification = await classifyBaselineQualityGateFailure({
      task,
      configManager: createConfigManager(),
      targetBranch: 'main',
      runGate: () => {
        probed = true;
        return {
          ok: false,
          exitCode: 1,
          message: 'baseline failed',
        };
      },
    });

    assert.equal(probed, false);
    assert.equal(classification.kind, 'task_quality_gate_failure');
    assert.equal(classification.rootCause, 'dependency_bootstrap_worktree_environment');
    assert.equal(classification.repairGroupKey, 'baseline-quality-gate|main|package:apps/api');
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test('baseline repair group key is package scoped across gates', async () => {
  const buildGroup = deriveBaselineRepairGroupKey({
    targetBranch: 'main',
    packageLabel: 'apps/api',
  });
  const testGroup = deriveBaselineRepairGroupKey({
    targetBranch: 'main',
    packageLabel: 'apps/api',
  });

  assert.equal(buildGroup, testGroup);
  assert.equal(buildGroup, 'baseline-quality-gate|main|package:apps/api');
});

test('baseline quality-gate classifier keeps task env and baseline code-debt evidence separate', async () => {
  const fixture = createRepoFixture();
  const task = createTask(fixture, {
    finalizerFailure: {
      ...createTask(fixture).finalizerFailure,
      rawMessage: 'Turbopack internal error: symlink apps/web/node_modules is invalid because it points outside the filesystem root',
    },
  });

  try {
    const classification = await classifyBaselineQualityGateFailure({
      task,
      configManager: createConfigManager(),
      targetBranch: 'main',
      runGate: () => ({
        ok: false,
        exitCode: 1,
        message: "Module not found: Can't resolve './entitlement.js'",
      }),
    });

    assert.equal(classification.kind, 'baseline_quality_gate_failure');
    assert.equal(classification.taskRootCause, 'dependency_bootstrap_worktree_environment');
    assert.equal(classification.rootCause, 'shared_baseline_code_debt');
    assert.match(classification.taskFailureSignature, /node_modules/);
    assert.match(classification.baselineFailureSignature, /entitlement\.js/);
    assert.doesNotMatch(classification.baselineFailureSignature, /node_modules/);
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test('baseline quality-gate classifier records task-specific failure when baseline passes', async () => {
  const fixture = createRepoFixture();
  const task = createTask(fixture);

  try {
    const classification = await classifyBaselineQualityGateFailure({
      task,
      configManager: createConfigManager(),
      runGate: () => ({
        ok: true,
        exitCode: 0,
        message: 'baseline passed',
      }),
    });

    assert.equal(classification.kind, 'task_quality_gate_failure');
    assert.match(classification.message, /task-specific/);
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test('baseline quality-gate classifier treats ENOBUFS as probe failure, not baseline product debt', async () => {
  const fixture = createRepoFixture();
  const task = createTask(fixture);

  try {
    const classification = await classifyBaselineQualityGateFailure({
      task,
      configManager: createConfigManager({
        'runner.baselineQualityGateTreatProbeBufferOverflowAsProbeFailure': true,
      }),
      runGate: () => ({
        ok: false,
        exitCode: null,
        errorKind: 'output_buffer_overflow',
        message: 'spawnSync /bin/sh ENOBUFS',
      }),
    });

    assert.equal(classification.kind, 'baseline_probe_failed');
    assert.equal(classification.rootCause, 'toolchain_flake');
    assert.match(classification.message, /probe exceeded output buffer/);
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test('baseline quality-gate currentness rejects legacy states without concrete failure signatures', () => {
  const fixture = createRepoFixture();
  const task = createTask(fixture, {
    latestFailure: {
      id: 'failure-1',
      observedAt: 200,
      kind: 'quality_gate',
      class: 'typescript_diagnostics',
      gate: 'typecheck',
      packageLabel: 'apps/api',
      signature: 'current-writing-chart-signature',
      rawMessage: 'current failure',
    },
    baselineQualityGate: {
      kind: 'baseline_quality_gate_failure',
      observedAt: 100,
      targetBranch: 'main',
      gate: 'typecheck',
      packageLabel: 'apps/api',
      signature: 'legacy-package-only-signature',
      message: 'legacy baseline state without task/latest failure signatures',
    },
  });

  try {
    assert.equal(isBaselineQualityGateStateCurrent(task), false);
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test('baseline quality-gate classifier probes from isolated worktree when target checkout is dirty', async () => {
  const fixture = createRepoFixture();
  const task = createTask(fixture);
  let probeInput;

  try {
    fs.writeFileSync(path.join(fixture.repoPath, 'dirty.txt'), 'dirty\n');
    const classification = await classifyBaselineQualityGateFailure({
      task,
      configManager: createConfigManager(),
      runGate: (input) => {
        probeInput = input;
        return {
          ok: false,
          exitCode: 2,
          message: 'isolated baseline failed',
        };
      },
    });

    assert.equal(classification.kind, 'baseline_quality_gate_failure');
    assert.match(classification.message, /isolated target baseline/);
    assert.notEqual(probeInput.cwd, fixture.baselineCwd);
    assert.equal(path.basename(probeInput.cwd), 'api');
    assert.equal(path.basename(path.dirname(probeInput.cwd)), 'apps');
    assert.equal(fs.existsSync(path.join(fixture.repoPath, 'dirty.txt')), true);
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test('ensureBaselineRepairTask creates one deterministic shared repair PRD', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-baseline-repair-'));
  const repoPath = path.join(tempDir, 'repo');
  const ralphHome = path.join(tempDir, 'ralph-home');
  const stateManager = new StateManager({ ralphHome });
  const scheduler = {
    schedulePendingTasks: async () => [],
    describePendingTask: async () => ({
      reason: 'queued',
      dependencies: [],
      blockers: [],
      maxConcurrent: 3,
      running: 0,
    }),
  };
  const configManager = {
    get(key) {
      return key === 'merge.targetBranch' ? 'main' : undefined;
    },
  };

  try {
    fs.mkdirSync(repoPath, { recursive: true });
    const failure = {
      failureKind: 'quality_gate',
      class: 'typescript_diagnostics',
      gate: 'test',
      requestedGate: 'test',
      packageLabel: 'apps/web',
      cwd: path.join(repoPath, 'apps/web'),
      command: 'npm test',
      preparationCommands: ["cd 'packages/db' && pnpm run db:generate:safe"],
      validationCommands: ["cd 'packages/db' && pnpm run db:generate:safe", 'pnpm run test'],
      exitCode: 1,
      rawMessage: 'baseline web tests failed',
    };

    const first = await ensureBaselineRepairTask({
      repoPath,
      targetBranch: 'main',
      failure,
      signature: 'test|apps/web|baseline',
      repairKey: 'baseline-quality-gate|main|test|apps/web|baseline',
      rootCause: 'shared_baseline_code_debt',
      demandTaskIds: ['task-a'],
      stateManager,
      scheduler,
      configManager,
    });
    const second = await ensureBaselineRepairTask({
      repoPath,
      targetBranch: 'main',
      failure,
      signature: 'test|apps/web|baseline',
      repairKey: 'baseline-quality-gate|main|test|apps/web|baseline',
      rootCause: 'shared_baseline_code_debt',
      demandTaskIds: ['task-b'],
      stateManager,
      scheduler,
      configManager,
    });

    const tasks = await stateManager.listTasks();
    assert.equal(tasks.length, 1);
    assert.equal(first.alreadyExists, false);
    assert.equal(second.alreadyExists, true);
    assert.equal(second.taskId, first.taskId);
    assert.match(tasks[0].prdId, /^baseline-quality-gate:/);
    assert.equal(tasks[0].prdTitle, 'Repair shared baseline quality gate test for apps/web');
    assert.deepEqual(tasks[0].baselineRepair.demandTaskIds.sort(), ['task-a', 'task-b']);
    assert.equal(tasks[0].baselineRepair.rootCause, 'shared_baseline_code_debt');

    const repairFiles = fs.readdirSync(path.join(ralphHome, 'baseline-repairs'));
    assert.equal(repairFiles.length, 1);
    const repairPrdText = fs.readFileSync(path.join(ralphHome, 'baseline-repairs', repairFiles[0]), 'utf-8');
    assert.match(repairPrdText, /Repair the shared target-branch baseline quality gate failure/);
    assert.match(repairPrdText, /dedicated baseline repair worktree/);
    assert.match(repairPrdText, /Do not use the dirty source checkout as proof/);
    assert.match(repairPrdText, /Do not run the full finalizer sequence inside this worker/);
    assert.doesNotMatch(repairPrdText, /Run the full finalizer sequence before reporting success/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('ensureBaselineRepairTask reuses canonical task for different exact keys in same repair group', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-baseline-repair-'));
  const repoPath = path.join(tempDir, 'repo');
  const ralphHome = path.join(tempDir, 'ralph-home');
  const stateManager = new StateManager({ ralphHome });
  const scheduler = {
    schedulePendingTasks: async () => [],
    describePendingTask: async () => ({
      reason: 'queued',
      dependencies: [],
      blockers: [],
      maxConcurrent: 3,
      running: 0,
    }),
  };
  const configManager = {
    get(key) {
      return key === 'merge.targetBranch' ? 'main' : undefined;
    },
  };

  try {
    fs.mkdirSync(repoPath, { recursive: true });
    const baseFailure = {
      failureKind: 'quality_gate',
      class: 'typescript_diagnostics',
      gate: 'build',
      requestedGate: 'build',
      packageLabel: 'apps/api',
      cwd: path.join(repoPath, 'apps/api'),
      command: 'pnpm run build',
      exitCode: 1,
      rawMessage: 'baseline api build failed',
    };
    const repairGroupKey = 'baseline-quality-gate|main|package:apps/api';

    const first = await ensureBaselineRepairTask({
      repoPath,
      targetBranch: 'main',
      failure: baseFailure,
      signature: 'build|apps/api|baseline',
      repairKey: 'baseline-quality-gate|main|build|apps/api',
      repairGroupKey,
      rootCause: 'shared_baseline_code_debt',
      demandTaskIds: ['task-build'],
      stateManager,
      scheduler,
      configManager,
    });
    const second = await ensureBaselineRepairTask({
      repoPath,
      targetBranch: 'main',
      failure: {
        ...baseFailure,
        gate: 'test',
        requestedGate: 'test',
        command: 'pnpm test',
        rawMessage: 'baseline api tests failed',
      },
      signature: 'test|apps/api|baseline',
      repairKey: 'baseline-quality-gate|main|test|apps/api',
      repairGroupKey,
      rootCause: 'shared_baseline_code_debt',
      demandTaskIds: ['task-test'],
      stateManager,
      scheduler,
      configManager,
    });

    const tasks = await stateManager.listTasks();
    assert.equal(tasks.length, 1);
    assert.equal(second.alreadyExists, true);
    assert.equal(second.taskId, first.taskId);
    assert.equal(tasks[0].baselineRepair.repairGroupKey, repairGroupKey);
    assert.deepEqual(tasks[0].baselineRepair.demandTaskIds.sort(), ['task-build', 'task-test']);
    assert.deepEqual(
      tasks[0].baselineRepair.repairKeyAliases.sort(),
      [
        'baseline-quality-gate|main|build|apps/api',
        'baseline-quality-gate|main|test|apps/api',
      ],
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('repairTaskWorktreeDependencyBootstrap removes only invalid worktree node_modules symlinks', () => {
  const fixture = createRepoFixture();
  const outsideArtifacts = path.join(fixture.tempDir, 'outside-node-modules');
  const taskNodeModules = path.join(fixture.taskCwd, 'node_modules');
  const task = createTask(fixture, {
    finalizerFailure: {
      ...createTask(fixture).finalizerFailure,
      rawMessage: `Turbopack internal error: symlink ${taskNodeModules} is invalid because it points outside the filesystem root`,
    },
  });
  const calls = [];

  try {
    fs.writeFileSync(path.join(fixture.taskCwd, 'package.json'), '{"scripts":{"build":"next build"},"dependencies":{"next":"1.0.0"}}\n');
    fs.mkdirSync(outsideArtifacts, { recursive: true });
    fs.symlinkSync(outsideArtifacts, taskNodeModules, 'dir');

    const result = repairTaskWorktreeDependencyBootstrap(task, 1, {
      commandRunner: (command, args, cwd) => {
        calls.push({ command, args, cwd });
        fs.mkdirSync(taskNodeModules, { recursive: true });
        return { status: 0, stdout: 'installed', stderr: '' };
      },
    });

    assert.equal(result.repaired, true);
    assert.deepEqual(result.removedPaths, [taskNodeModules]);
    assert.equal(result.packageManager, 'npm');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'npm');
    assert.equal(calls[0].cwd, fixture.taskCwd);
    assert.equal(fs.lstatSync(taskNodeModules).isSymbolicLink(), false);
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});
