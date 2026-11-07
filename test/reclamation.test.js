const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ReclamationService } = require('../dist/core/reclamation.js');
const { WorktreeEvidenceArchiver } = require('../dist/core/reclamation-evidence.js');

const HOUR = 60 * 60 * 1000;

function makeTask(overrides = {}) {
  return {
    id: overrides.id || 'task-1',
    prdPath: '/tmp/prd.json',
    status: overrides.status || 'completed',
    startTime: overrides.startTime ?? 1,
    endTime: overrides.endTime ?? 1,
    completedUS: [],
    worktree: overrides.worktree || '/tmp/worktree',
    logPath: overrides.logPath || '/tmp/task/agent.log',
    agent: 'codex',
    repoPath: overrides.repoPath || '/tmp/repo',
    loopCount: 0,
    consecutiveNoProgress: 0,
    consecutiveErrors: 0,
    lastProgressTime: overrides.lastProgressTime ?? 1,
    lastFilesChanged: 0,
    ...overrides,
  };
}

function makeConfig(values = {}) {
  return {
    get: (key) => values[key],
  };
}

function makeInspection(worktree, overrides = {}) {
  return {
    path: path.resolve(worktree),
    exists: true,
    registered: true,
    dirty: false,
    pathInsideRalphWorktrees: true,
    ...overrides,
  };
}

function makeStateManager(home, tasks, updates = []) {
  return {
    getRalphHome: () => home,
    listTasks: async () => tasks,
    loadTask: async (taskId) => tasks.find((task) => task.id === taskId) || null,
    updateTask: async (taskId, update) => {
      updates.push({ taskId, update });
    },
  };
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function sha256Text(content) {
  return crypto.createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex');
}

function writeFile(filePath, content = 'x') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test('ReclamationService dry-runs old completed task worktrees', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-repo-'));
  const worktree = path.join(repo, '.ralph-worktrees', 'completed-task');
  const now = Date.now();
  const task = makeTask({
    id: 'completed-task',
    repoPath: repo,
    worktree,
    endTime: now - 48 * HOUR,
    logPath: path.join(home, 'tasks', 'completed-task', 'agent.log'),
  });
  let removeCalls = 0;

  try {
    fs.mkdirSync(worktree, { recursive: true });
    const service = new ReclamationService({
      stateManager: makeStateManager(home, [task]),
      configManager: makeConfig(),
      now: () => now,
      worktreeManager: {
        inspectWorktree: async () => makeInspection(worktree),
        removeWorktreeSafe: async () => {
          removeCalls += 1;
          return { removed: true, dryRun: false };
        },
        pruneWorktreeMetadata: async () => undefined,
        listWorktrees: async () => [],
      },
    });

    const report = await service.run({ mode: 'manual', dryRun: true, olderThanHours: 24 });

    assert.equal(report.ok, true);
    assert.equal(report.candidates.length, 1);
    assert.equal(report.candidates[0].taskId, 'completed-task');
    assert.equal(report.candidates[0].wouldRemove, true);
    assert.equal(report.candidates[0].removed, false);
    assert.equal(removeCalls, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('ReclamationService removes clean task worktrees and annotates task state', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-repo-'));
  const worktree = path.join(repo, '.ralph-worktrees', 'completed-task');
  const now = Date.now();
  const updates = [];
  const task = makeTask({
    id: 'completed-task',
    repoPath: repo,
    worktree,
    endTime: now - 48 * HOUR,
    logPath: path.join(home, 'tasks', 'completed-task', 'agent.log'),
  });
  let removeForce;

  try {
    fs.mkdirSync(worktree, { recursive: true });
    const service = new ReclamationService({
      stateManager: makeStateManager(home, [task], updates),
      configManager: makeConfig({
        'reclamation.reporting.emitTaskEvents': false,
      }),
      now: () => now,
      worktreeManager: {
        inspectWorktree: async () => makeInspection(worktree),
        removeWorktreeSafe: async (_repoPath, _worktreePath, options) => {
          removeForce = options.force;
          return { removed: true, dryRun: false };
        },
        pruneWorktreeMetadata: async () => undefined,
        listWorktrees: async () => [],
      },
    });

    const report = await service.run({ mode: 'manual', olderThanHours: 24 });

    assert.equal(report.removed, 1);
    assert.equal(report.candidates[0].removed, true);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].taskId, 'completed-task');
    assert.equal(updates[0].update.worktreeReclaimedBy, 'manual');
    assert.equal(updates[0].update.worktreeReclaimReason, 'manual_retention');
    assert.equal(updates[0].update.worktreeReclaimReportPath, path.join(home, 'reclamation', 'last-run.json'));
    assert.equal(removeForce, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('ReclamationService reclaims recent clean terminal worktrees during disk pressure', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-repo-'));
  const worktree = path.join(repo, '.ralph-worktrees', 'completed-task');
  const now = Date.now();
  const task = makeTask({
    id: 'completed-task',
    repoPath: repo,
    worktree,
    endTime: now,
    logPath: path.join(home, 'tasks', 'completed-task', 'agent.log'),
  });

  try {
    fs.mkdirSync(worktree, { recursive: true });
    const service = new ReclamationService({
      stateManager: makeStateManager(home, [task]),
      configManager: makeConfig({
        'reclamation.reporting.emitTaskEvents': false,
      }),
      now: () => now,
      diskPressureProvider: (paths) => ({
        enabled: true,
        active: true,
        emergency: false,
        checkedPaths: paths,
        freeBytes: 2 * 1024 * 1024 * 1024,
        totalBytes: 100 * 1024 * 1024 * 1024,
        freePercent: 2,
        minFreeBytes: 10 * 1024 * 1024 * 1024,
        minFreePercent: 10,
        targetFreeBytes: 30 * 1024 * 1024 * 1024,
        emergencyFreeBytes: 5 * 1024 * 1024 * 1024,
        reason: 'disk_pressure_min_free_bytes',
      }),
      worktreeManager: {
        inspectWorktree: async () => makeInspection(worktree),
        removeWorktreeSafe: async (_repoPath, _worktreePath, options) => {
          assert.equal(options.force, false);
          return { removed: true, dryRun: false };
        },
        pruneWorktreeMetadata: async () => undefined,
        listWorktrees: async () => [],
      },
    });

    const report = await service.run({ mode: 'disk_pressure' });

    assert.equal(report.diskPressure.active, true);
    assert.equal(report.removed, 1);
    assert.equal(report.candidates[0].taskId, 'completed-task');
    assert.equal(report.candidates[0].tier, 'disk_pressure_retention');
    assert.equal(report.candidates[0].retentionHours, 0);
    assert.equal(report.candidates[0].decisionAction, 'remove_clean');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('ReclamationService does not archive dirty worktrees during disk pressure by default', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-repo-'));
  const worktree = path.join(repo, '.ralph-worktrees', 'failed-task');
  const now = Date.now();
  const task = makeTask({
    id: 'failed-task',
    status: 'failed',
    repoPath: repo,
    worktree,
    endTime: now,
    logPath: path.join(home, 'tasks', 'failed-task', 'agent.log'),
  });
  let archiveCalls = 0;
  let removeCalls = 0;

  try {
    fs.mkdirSync(worktree, { recursive: true });
    const service = new ReclamationService({
      stateManager: makeStateManager(home, [task]),
      configManager: makeConfig({
        'reclamation.worktrees.dirtyTerminalMode': 'archive_only',
        'reclamation.reporting.emitTaskEvents': false,
      }),
      now: () => now,
      diskPressureProvider: (paths) => ({
        enabled: true,
        active: true,
        emergency: true,
        checkedPaths: paths,
        freeBytes: 1024 * 1024 * 1024,
        totalBytes: 100 * 1024 * 1024 * 1024,
        freePercent: 1,
        minFreeBytes: 10 * 1024 * 1024 * 1024,
        minFreePercent: 10,
        targetFreeBytes: 30 * 1024 * 1024 * 1024,
        emergencyFreeBytes: 5 * 1024 * 1024 * 1024,
        reason: 'disk_pressure_emergency_free_bytes',
      }),
      worktreeManager: {
        inspectWorktree: async () => makeInspection(worktree, { dirty: true }),
        removeWorktreeSafe: async () => {
          removeCalls += 1;
          return { removed: true, dryRun: false };
        },
        pruneWorktreeMetadata: async () => undefined,
        listWorktrees: async () => [],
      },
      evidenceArchiver: {
        archive: async () => {
          archiveCalls += 1;
          return {
            ok: true,
            complete: true,
            dir: path.join(home, 'reclamation', 'evidence', 'failed-task'),
            manifestPath: path.join(home, 'reclamation', 'evidence', 'failed-task', 'manifest.json'),
          };
        },
      },
    });

    const report = await service.run({ mode: 'disk_pressure' });

    assert.equal(report.diskPressure.active, true);
    assert.equal(report.removed, 0);
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0].taskId, 'failed-task');
    assert.equal(report.skipped[0].reason, 'dirty_terminal_worktree_retained');
    assert.equal(archiveCalls, 0);
    assert.equal(removeCalls, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('ReclamationService prunes generated caches in retained dirty orphan worktrees during disk pressure', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-repo-'));
  const worktree = path.join(repo, '.ralph-worktrees', 'dirty-orphan-task');
  const now = Date.now();
  let removeCalls = 0;

  try {
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    writeFile(path.join(worktree, 'node_modules', 'pkg', 'index.js'));
    writeFile(path.join(worktree, '.turbo', 'cache', 'artifact'));
    writeFile(path.join(worktree, 'apps', 'web', '.next', 'cache', 'webpack', 'artifact'));
    writeFile(path.join(worktree, 'package.json'), '{"scripts":{"test":"node test.js"}}\n');
    writeFile(path.join(worktree, 'scripts', 'valuable-change.mjs'), 'export const value = true;\n');

    const service = new ReclamationService({
      stateManager: makeStateManager(home, []),
      configManager: makeConfig(),
      now: () => now,
      diskPressureProvider: (paths) => ({
        enabled: true,
        active: true,
        emergency: true,
        checkedPaths: paths,
        freeBytes: 1024 * 1024 * 1024,
        totalBytes: 100 * 1024 * 1024 * 1024,
        freePercent: 1,
        minFreeBytes: 10 * 1024 * 1024 * 1024,
        minFreePercent: 10,
        targetFreeBytes: 30 * 1024 * 1024 * 1024,
        emergencyFreeBytes: 5 * 1024 * 1024 * 1024,
        reason: 'disk_pressure_emergency_free_bytes',
      }),
      worktreeManager: {
        inspectWorktree: async () => makeInspection(worktree, {
          dirty: true,
          changedFileCount: 1,
          untrackedFileCount: 1,
          hasUnstagedChanges: true,
          hasUntrackedFiles: true,
        }),
        removeWorktreeSafe: async () => {
          removeCalls += 1;
          return { removed: true, dryRun: false };
        },
        pruneWorktreeMetadata: async () => undefined,
        listWorktrees: async () => [worktree],
      },
    });

    const report = await service.run({ mode: 'disk_pressure', repoPath: repo });

    assert.equal(report.removed, 0);
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0].kind, 'orphan_worktree');
    assert.equal(report.skipped[0].reason, 'dirty_orphan_retained');
    assert.equal(report.skipped[0].prunedCachePaths.length, 3);
    assert.equal(report.tempDirs.scanned, 1);
    assert.equal(report.tempDirs.candidates, 3);
    assert.equal(report.tempDirs.removed, 3);
    assert.equal(removeCalls, 0);
    assert.equal(fs.existsSync(path.join(worktree, 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(worktree, '.turbo')), false);
    assert.equal(fs.existsSync(path.join(worktree, 'apps', 'web', '.next', 'cache')), false);
    assert.equal(fs.existsSync(path.join(worktree, 'package.json')), true);
    assert.equal(fs.existsSync(path.join(worktree, 'scripts', 'valuable-change.mjs')), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('ReclamationService dry-runs retained dirty worktree cache pruning without deleting caches', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-repo-'));
  const worktree = path.join(repo, '.ralph-worktrees', 'dirty-orphan-task');
  const now = Date.now();

  try {
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    writeFile(path.join(worktree, 'node_modules', 'pkg', 'index.js'));
    writeFile(path.join(worktree, 'package.json'), '{"scripts":{"test":"node test.js"}}\n');

    const service = new ReclamationService({
      stateManager: makeStateManager(home, []),
      configManager: makeConfig(),
      now: () => now,
      diskPressureProvider: (paths) => ({
        enabled: true,
        active: true,
        emergency: false,
        checkedPaths: paths,
        freeBytes: 2 * 1024 * 1024 * 1024,
        totalBytes: 100 * 1024 * 1024 * 1024,
        freePercent: 2,
        minFreeBytes: 10 * 1024 * 1024 * 1024,
        minFreePercent: 10,
        targetFreeBytes: 30 * 1024 * 1024 * 1024,
        emergencyFreeBytes: 5 * 1024 * 1024 * 1024,
        reason: 'disk_pressure_min_free_bytes',
      }),
      worktreeManager: {
        inspectWorktree: async () => makeInspection(worktree, { dirty: true }),
        removeWorktreeSafe: async () => ({ removed: true, dryRun: false }),
        pruneWorktreeMetadata: async () => undefined,
        listWorktrees: async () => [worktree],
      },
    });

    const report = await service.run({ mode: 'disk_pressure', dryRun: true, repoPath: repo });

    assert.equal(report.removed, 0);
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0].reason, 'dirty_orphan_retained');
    assert.equal(report.skipped[0].prunableCachePaths.length, 1);
    assert.equal(report.skipped[0].prunedCachePaths, undefined);
    assert.equal(report.tempDirs.candidates, 1);
    assert.equal(report.tempDirs.removed, 0);
    assert.equal(report.tempDirs.skipped, 1);
    assert.equal(fs.existsSync(path.join(worktree, 'node_modules')), true);
    assert.equal(fs.existsSync(path.join(worktree, 'package.json')), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('ReclamationService skips disk pressure run when free space is healthy', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-repo-'));
  const worktree = path.join(repo, '.ralph-worktrees', 'old-task');
  const now = Date.now();
  const task = makeTask({
    id: 'old-task',
    repoPath: repo,
    worktree,
    endTime: now - 400 * HOUR,
    logPath: path.join(home, 'tasks', 'old-task', 'agent.log'),
  });
  let inspectCalls = 0;

  try {
    fs.mkdirSync(worktree, { recursive: true });
    const service = new ReclamationService({
      stateManager: makeStateManager(home, [task]),
      configManager: makeConfig(),
      now: () => now,
      diskPressureProvider: (paths) => ({
        enabled: true,
        active: false,
        emergency: false,
        checkedPaths: paths,
        freeBytes: 50 * 1024 * 1024 * 1024,
        totalBytes: 100 * 1024 * 1024 * 1024,
        freePercent: 50,
        minFreeBytes: 10 * 1024 * 1024 * 1024,
        minFreePercent: 10,
        targetFreeBytes: 30 * 1024 * 1024 * 1024,
        emergencyFreeBytes: 5 * 1024 * 1024 * 1024,
        reason: 'disk_pressure_ok',
      }),
      worktreeManager: {
        inspectWorktree: async () => {
          inspectCalls += 1;
          return makeInspection(worktree);
        },
        removeWorktreeSafe: async () => ({ removed: true, dryRun: false }),
        pruneWorktreeMetadata: async () => undefined,
        listWorktrees: async () => [],
      },
    });

    const report = await service.run({ mode: 'disk_pressure' });

    assert.equal(report.diskPressure.active, false);
    assert.equal(report.removed, 0);
    assert.equal(report.candidates.length, 0);
    assert.equal(inspectCalls, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('ReclamationService rechecks task state before removing a stale terminal candidate', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-repo-'));
  const worktree = path.join(repo, '.ralph-worktrees', 'race-task');
  const now = Date.now();
  const failedSnapshot = makeTask({
    id: 'race-task',
    status: 'failed',
    repoPath: repo,
    worktree,
    endTime: now - 48 * HOUR,
    logPath: path.join(home, 'tasks', 'race-task', 'agent.log'),
  });
  const runningLatest = {
    ...failedSnapshot,
    status: 'running',
    endTime: undefined,
    updatedAt: now,
  };
  let removeCalls = 0;

  try {
    fs.mkdirSync(worktree, { recursive: true });
    const service = new ReclamationService({
      stateManager: {
        getRalphHome: () => home,
        listTasks: async () => [failedSnapshot],
        loadTask: async () => runningLatest,
        updateTask: async () => undefined,
      },
      configManager: makeConfig(),
      now: () => now,
      worktreeManager: {
        inspectWorktree: async () => makeInspection(worktree),
        removeWorktreeSafe: async () => {
          removeCalls += 1;
          return { removed: true, dryRun: false };
        },
        pruneWorktreeMetadata: async () => undefined,
        listWorktrees: async () => [],
      },
    });

    const report = await service.run({ mode: 'manual', olderThanHours: 0 });

    assert.equal(report.removed, 0);
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0].taskId, 'race-task');
    assert.equal(report.skipped[0].reason, 'task_state_active_before_reclaim');
    assert.equal(removeCalls, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('ReclamationService reclaims clean stopped task worktrees after stopped retention', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-repo-'));
  const worktree = path.join(repo, '.ralph-worktrees', 'stopped-task');
  const now = Date.now();
  const updates = [];
  const task = makeTask({
    id: 'stopped-task',
    status: 'stopped',
    repoPath: repo,
    worktree,
    endTime: now - 25 * HOUR,
    logPath: path.join(home, 'tasks', 'stopped-task', 'agent.log'),
  });
  let removeForce;

  try {
    fs.mkdirSync(worktree, { recursive: true });
    const service = new ReclamationService({
      stateManager: makeStateManager(home, [task], updates),
      configManager: makeConfig({
        'reclamation.worktrees.keepNewestPerRepo': 0,
        'reclamation.worktrees.stoppedCleanRetentionHours': 24,
        'reclamation.reporting.emitTaskEvents': false,
      }),
      now: () => now,
      worktreeManager: {
        inspectWorktree: async () => makeInspection(worktree),
        removeWorktreeSafe: async (_repoPath, _worktreePath, options) => {
          removeForce = options.force;
          return { removed: true, dryRun: false };
        },
        pruneWorktreeMetadata: async () => undefined,
        listWorktrees: async () => [],
      },
    });

    const report = await service.run({ mode: 'manager_periodic' });

    assert.equal(report.removed, 1);
    assert.equal(report.candidates[0].taskId, 'stopped-task');
    assert.equal(report.candidates[0].status, 'stopped');
    assert.equal(report.candidates[0].tier, 'safe_stopped_clean');
    assert.equal(report.candidates[0].decisionAction, 'remove_clean');
    assert.equal(removeForce, false);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].update.worktreeReclaimReason, 'safe_stopped_clean');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('ReclamationService retains dirty stopped task worktrees by default', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-repo-'));
  const worktree = path.join(repo, '.ralph-worktrees', 'stopped-task');
  const now = Date.now();
  const task = makeTask({
    id: 'stopped-task',
    status: 'stopped',
    repoPath: repo,
    worktree,
    endTime: now - 400 * HOUR,
    logPath: path.join(home, 'tasks', 'stopped-task', 'agent.log'),
  });
  let removeCalls = 0;

  try {
    fs.mkdirSync(worktree, { recursive: true });
    const service = new ReclamationService({
      stateManager: makeStateManager(home, [task]),
      configManager: makeConfig({
        'reclamation.worktrees.keepNewestPerRepo': 0,
      }),
      now: () => now,
      worktreeManager: {
        inspectWorktree: async () => makeInspection(worktree, { dirty: true }),
        removeWorktreeSafe: async () => {
          removeCalls += 1;
          return { removed: true, dryRun: false };
        },
        pruneWorktreeMetadata: async () => undefined,
        listWorktrees: async () => [],
      },
    });

    const report = await service.run({ mode: 'manager_periodic' });

    assert.equal(report.removed, 0);
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0].taskId, 'stopped-task');
    assert.equal(report.skipped[0].status, 'stopped');
    assert.equal(report.skipped[0].tier, 'debug_stopped_dirty');
    assert.equal(report.skipped[0].reason, 'dirty_terminal_worktree_retained');
    assert.equal(removeCalls, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('ReclamationService retains dirty failed worktrees by default', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-repo-'));
  const worktree = path.join(repo, '.ralph-worktrees', 'failed-task');
  const now = Date.now();
  const task = makeTask({
    id: 'failed-task',
    status: 'failed',
    repoPath: repo,
    worktree,
    endTime: now - 240 * HOUR,
    logPath: path.join(home, 'tasks', 'failed-task', 'agent.log'),
  });
  let removeCalls = 0;

  try {
    fs.mkdirSync(worktree, { recursive: true });
    const service = new ReclamationService({
      stateManager: makeStateManager(home, [task]),
      configManager: makeConfig(),
      now: () => now,
      worktreeManager: {
        inspectWorktree: async () => makeInspection(worktree, { dirty: true }),
        removeWorktreeSafe: async () => {
          removeCalls += 1;
          return { removed: true, dryRun: false };
        },
        pruneWorktreeMetadata: async () => undefined,
        listWorktrees: async () => [],
      },
    });

    const report = await service.run({ mode: 'manual', olderThanHours: 24 });

    assert.equal(report.removed, 0);
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0].reason, 'dirty_terminal_worktree_retained');
    assert.equal(removeCalls, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('ReclamationService archives dirty failed worktrees in automatic archive-only mode', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-repo-'));
  const worktree = path.join(repo, '.ralph-worktrees', 'failed-task');
  const now = Date.now();
  const updates = [];
  const task = makeTask({
    id: 'failed-task',
    status: 'failed',
    repoPath: repo,
    worktree,
    endTime: now - 400 * HOUR,
    logPath: path.join(home, 'tasks', 'failed-task', 'agent.log'),
  });
  const archiveCalls = [];
  let removeCalls = 0;

  try {
    fs.mkdirSync(worktree, { recursive: true });
    const service = new ReclamationService({
      stateManager: makeStateManager(home, [task], updates),
      configManager: makeConfig({
        'reclamation.worktrees.keepNewestPerRepo': 0,
        'reclamation.worktrees.dirtyTerminalMode': 'archive_only',
        'reclamation.reporting.emitTaskEvents': false,
      }),
      now: () => now,
      worktreeManager: {
        inspectWorktree: async () => makeInspection(worktree, { dirty: true }),
        removeWorktreeSafe: async () => {
          removeCalls += 1;
          return { removed: true, dryRun: false };
        },
        pruneWorktreeMetadata: async () => undefined,
        listWorktrees: async () => [],
      },
      evidenceArchiver: {
        archive: async (_candidate, decision) => {
          archiveCalls.push(decision);
          return {
            ok: true,
            complete: true,
            dir: path.join(home, 'reclamation', 'evidence', 'failed-task'),
            manifestPath: path.join(home, 'reclamation', 'evidence', 'failed-task', 'manifest.json'),
            bytes: 42,
          };
        },
      },
    });

    const report = await service.run({ mode: 'manager_periodic' });

    assert.equal(report.removed, 0);
    assert.equal(report.worktrees.archived, 1);
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0].attentionState, 'reclamation');
    assert.equal(report.skipped[0].decisionAction, 'archive_only');
    assert.equal(report.skipped[0].reason, 'dirty_worktree_archived_retained');
    assert.equal(report.skipped[0].evidenceComplete, true);
    assert.equal(archiveCalls.length, 1);
    assert.equal(removeCalls, 0);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].update.worktreeReclaimDecision, 'archive_only');
    assert.match(updates[0].update.worktreeReclaimEvidenceManifestPath, /manifest\.json$/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('ReclamationService archive-then-reclaims dirty failed worktrees when explicitly requested', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-repo-'));
  const worktree = path.join(repo, '.ralph-worktrees', 'failed-task');
  const now = Date.now();
  const updates = [];
  const task = makeTask({
    id: 'failed-task',
    status: 'failed',
    repoPath: repo,
    worktree,
    endTime: now - 400 * HOUR,
    logPath: path.join(home, 'tasks', 'failed-task', 'agent.log'),
  });
  const order = [];

  try {
    fs.mkdirSync(worktree, { recursive: true });
    const service = new ReclamationService({
      stateManager: makeStateManager(home, [task], updates),
      configManager: makeConfig({
        'reclamation.reporting.emitTaskEvents': false,
      }),
      now: () => now,
      worktreeManager: {
        inspectWorktree: async () => makeInspection(worktree, { dirty: true }),
        removeWorktreeSafe: async () => {
          order.push('remove');
          return { removed: true, dryRun: false };
        },
        pruneWorktreeMetadata: async () => undefined,
        listWorktrees: async () => [],
      },
      evidenceArchiver: {
        archive: async () => {
          order.push('archive');
          return {
            ok: true,
            complete: true,
            dir: path.join(home, 'reclamation', 'evidence', 'failed-task'),
            manifestPath: path.join(home, 'reclamation', 'evidence', 'failed-task', 'manifest.json'),
            bytes: 42,
          };
        },
      },
    });

    const report = await service.run({
      mode: 'manual',
      olderThanHours: 24,
      dirtyTerminalModeOverride: 'archive_then_reclaim',
    });

    assert.equal(report.removed, 1);
    assert.equal(report.worktrees.archived, 1);
    assert.equal(report.candidates.length, 1);
    assert.equal(report.candidates[0].decisionAction, 'archive_then_reclaim');
    assert.equal(report.candidates[0].evidenceComplete, true);
    assert.deepEqual(order, ['archive', 'remove']);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].update.worktreeReclaimDecision, 'archive_then_reclaim');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('ReclamationService keeps retry-attention dirty failures archive-only', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-repo-'));
  const worktree = path.join(repo, '.ralph-worktrees', 'failed-task');
  const now = Date.now();
  const task = makeTask({
    id: 'failed-task',
    status: 'failed',
    repoPath: repo,
    worktree,
    endTime: now - 400 * HOUR,
    logPath: path.join(home, 'tasks', 'failed-task', 'agent.log'),
    lastErrorClass: 'transport',
    lastErrorRetryable: true,
  });
  let removeCalls = 0;

  try {
    fs.mkdirSync(worktree, { recursive: true });
    const service = new ReclamationService({
      stateManager: makeStateManager(home, [task]),
      configManager: makeConfig({
        'reclamation.reporting.emitTaskEvents': false,
      }),
      now: () => now,
      worktreeManager: {
        inspectWorktree: async () => makeInspection(worktree, { dirty: true }),
        removeWorktreeSafe: async () => {
          removeCalls += 1;
          return { removed: true, dryRun: false };
        },
        pruneWorktreeMetadata: async () => undefined,
        listWorktrees: async () => [],
      },
      evidenceArchiver: {
        archive: async () => ({
          ok: true,
          complete: true,
          dir: path.join(home, 'reclamation', 'evidence', 'failed-task'),
          manifestPath: path.join(home, 'reclamation', 'evidence', 'failed-task', 'manifest.json'),
          bytes: 42,
        }),
      },
    });

    const report = await service.run({
      mode: 'manual',
      olderThanHours: 24,
      dirtyTerminalModeOverride: 'archive_then_reclaim',
    });

    assert.equal(report.removed, 0);
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0].attentionState, 'retry');
    assert.equal(report.skipped[0].decisionAction, 'archive_only');
    assert.equal(report.skipped[0].reason, 'dirty_worktree_archived_retry_attention');
    assert.equal(removeCalls, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('ReclamationService real evidence archive captures patches and untracked files', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-repo-'));
  const now = Date.now();
  const updates = [];
  let worktree;

  try {
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.name', 'Ralph Test']);
    git(repo, ['config', 'user.email', 'ralph@example.com']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '-m', 'base']);

    worktree = path.join(repo, '.ralph-worktrees', 'failed-task');
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    git(repo, ['worktree', 'add', '-b', 'ralph/failed-task', worktree, 'main']);
    fs.writeFileSync(path.join(worktree, 'README.md'), 'base\nchange\n');
    fs.writeFileSync(path.join(worktree, 'notes.txt'), 'untracked\n');

    const task = makeTask({
      id: 'failed-task',
      status: 'failed',
      repoPath: repo,
      worktree,
      endTime: now - 400 * HOUR,
      logPath: path.join(home, 'tasks', 'failed-task', 'agent.log'),
    });
    const service = new ReclamationService({
      stateManager: makeStateManager(home, [task], updates),
      configManager: makeConfig({
        'reclamation.worktrees.keepNewestPerRepo': 0,
        'reclamation.worktrees.dirtyTerminalMode': 'archive_only',
        'reclamation.evidence.dir': path.join(home, 'evidence'),
        'reclamation.reporting.emitTaskEvents': false,
      }),
      now: () => now,
    });

    const report = await service.run({ mode: 'manager_periodic' });
    const manifestPath = report.skipped[0].evidenceManifestPath;

    assert.equal(report.removed, 0);
    assert.equal(report.worktrees.archived, 1);
    assert.ok(manifestPath);
    assert.equal(fs.existsSync(worktree), true);
    assert.equal(fs.existsSync(manifestPath), true);
    assert.match(fs.readFileSync(path.join(path.dirname(manifestPath), 'git-diff.patch'), 'utf-8'), /change/);
    assert.equal(fs.readFileSync(path.join(path.dirname(manifestPath), 'untracked', 'notes.txt'), 'utf-8'), 'untracked\n');
    assert.equal(updates[0].update.worktreeReclaimDecision, 'archive_only');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('WorktreeEvidenceArchiver reuses complete archive-only evidence for unchanged task worktrees', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-repo-'));
  const worktree = path.join(repo, '.ralph-worktrees', 'failed-task');
  const evidenceDir = path.join(home, 'reclamation', 'evidence', '2026-05-26', 'failed-task-existing');
  const manifestPath = path.join(evidenceDir, 'manifest.json');
  const branch = 'refs/heads/ralph/failed-task';
  const head = 'abc123abc123abc123abc123abc123abc123abc1';
  const statusPorcelain = '# branch.oid abc123abc123abc123abc123abc123abc123abc1\n1 .M N... 100644 100644 100644 abc abc README.md\n';
  const diffPatch = 'diff --git a/README.md b/README.md\n';
  const cachedDiffPatch = '';
  const untrackedFiles = ['notes.txt'];
  const task = makeTask({
    id: 'failed-task',
    status: 'failed',
    repoPath: repo,
    worktree,
    worktreeReclaimEvidenceManifestPath: manifestPath,
  });
  let worktreeManagerCalls = 0;

  try {
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      id: 'failed-task-existing',
      createdAt: new Date().toISOString(),
      mode: 'manager_periodic',
      complete: true,
      candidate: {
        kind: 'task_worktree',
        taskId: task.id,
        status: task.status,
        repoPath: repo,
        worktree,
        branch,
        head,
      },
      decision: {
        attentionState: 'reclamation',
        action: 'archive_only',
        reason: 'dirty_worktree_archive_only',
        safetyGates: [],
      },
      limits: {
        maxBytesPerCandidate: 100,
        maxUntrackedFiles: 100,
        maxUntrackedBytes: 100,
        maxSingleUntrackedFileBytes: 100,
      },
      artifacts: [
        {
          kind: 'status_porcelain',
          relativePath: 'git-status-porcelain-v2.txt',
          bytes: Buffer.byteLength(statusPorcelain),
          sha256: sha256Text(statusPorcelain),
        },
        {
          kind: 'diff_patch',
          relativePath: 'git-diff.patch',
          bytes: Buffer.byteLength(diffPatch),
          sha256: sha256Text(diffPatch),
        },
        {
          kind: 'cached_diff_patch',
          relativePath: 'git-diff-cached.patch',
          bytes: Buffer.byteLength(cachedDiffPatch),
          sha256: sha256Text(cachedDiffPatch),
        },
        {
          kind: 'untracked_file_list',
          relativePath: 'untracked-files.txt',
          bytes: Buffer.byteLength(`${untrackedFiles.join('\n')}\n`),
          sha256: sha256Text(`${untrackedFiles.join('\n')}\n`),
        },
      ],
      restore: { notes: 'existing evidence' },
    }, null, 2)}\n`);

    const archiver = new WorktreeEvidenceArchiver({
      ralphHome: home,
      configManager: makeConfig(),
      worktreeManager: {
        getWorktreeStatusPorcelainV2: async () => {
          worktreeManagerCalls += 1;
          return statusPorcelain;
        },
        getWorktreeDiffPatch: async () => {
          worktreeManagerCalls += 1;
          return diffPatch;
        },
        getWorktreeCachedDiffPatch: async () => {
          worktreeManagerCalls += 1;
          return cachedDiffPatch;
        },
        listUntrackedFiles: async () => {
          worktreeManagerCalls += 1;
          return untrackedFiles;
        },
      },
    });

    const result = await archiver.archive(
      {
        kind: 'task_worktree',
        task,
        taskId: task.id,
        status: task.status,
        repoPath: repo,
        worktree,
        tier: 'debug_failed',
        inspection: makeInspection(worktree, { branch, head, dirty: true }),
      },
      {
        attentionState: 'reclamation',
        action: 'archive_only',
        reason: 'dirty_worktree_archive_only',
        safetyGates: [],
      },
      { mode: 'manager_periodic' },
    );

    assert.equal(result.ok, true);
    assert.equal(result.complete, true);
    assert.equal(result.reused, true);
    assert.equal(result.dir, evidenceDir);
    assert.equal(result.manifestPath, manifestPath);
    assert.equal(worktreeManagerCalls, 4);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('WorktreeEvidenceArchiver does not copy git metadata directories as untracked evidence', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-repo-'));
  const worktree = path.join(repo, '.ralph-worktrees', 'dirty-task');

  try {
    fs.mkdirSync(path.join(worktree, '.git-local'), { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git-local', 'index'), 'git metadata\n');
    fs.writeFileSync(path.join(worktree, 'notes.txt'), 'keep me\n');

    const archiver = new WorktreeEvidenceArchiver({
      ralphHome: home,
      configManager: makeConfig({
        'reclamation.evidence.includeTaskSnapshot': false,
        'reclamation.evidence.includeAgentLogTail': false,
        'reclamation.evidence.includeTaskEventLogTail': false,
      }),
      worktreeManager: {
        getWorktreeStatusPorcelainV2: async () => '',
        getWorktreeStatusShort: async () => '',
        getWorktreeListPorcelain: async () => '',
        getWorktreeDiffPatch: async () => '',
        getWorktreeCachedDiffPatch: async () => '',
        listTrackedAndOtherFiles: async () => [],
        listUntrackedFiles: async () => ['.git-local/index', 'notes.txt'],
      },
    });

    const result = await archiver.archive(
      {
        kind: 'task_worktree',
        taskId: 'dirty-task',
        status: 'failed',
        repoPath: repo,
        worktree,
        tier: 'debug_failed',
        inspection: makeInspection(worktree, { dirty: true }),
      },
      {
        attentionState: 'reclamation',
        action: 'archive_only',
        reason: 'dirty_worktree_archive_only',
        safetyGates: [],
      },
      { mode: 'manager_periodic' },
    );

    assert.equal(result.ok, true);
    assert.ok(result.dir);
    assert.equal(fs.existsSync(path.join(result.dir, 'untracked', '.git-local', 'index')), false);
    assert.equal(fs.readFileSync(path.join(result.dir, 'untracked', 'notes.txt'), 'utf-8'), 'keep me\n');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('ReclamationService can reclaim clean orphan worktrees when requested', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-repo-'));
  const orphan = path.join(repo, '.ralph-worktrees', 'orphan-task');
  const now = Date.now();
  let removedPath;

  try {
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(orphan, { recursive: true });
    fs.utimesSync(orphan, new Date(now - 48 * HOUR), new Date(now - 48 * HOUR));

    const service = new ReclamationService({
      stateManager: makeStateManager(home, []),
      configManager: makeConfig({
        'reclamation.reporting.emitTaskEvents': false,
      }),
      now: () => now,
      worktreeManager: {
        listWorktrees: async () => [orphan],
        inspectWorktree: async () => makeInspection(orphan),
        removeWorktreeSafe: async (_repoPath, worktreePath) => {
          removedPath = worktreePath;
          return { removed: true, dryRun: false };
        },
        pruneWorktreeMetadata: async () => undefined,
      },
    });

    const report = await service.run({
      mode: 'manual',
      repoPath: repo,
      includeOrphanWorktrees: true,
      olderThanHours: 24,
    });

    assert.equal(report.removed, 1);
    assert.equal(report.candidates[0].kind, 'orphan_worktree');
    assert.equal(removedPath, orphan);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
