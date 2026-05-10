const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ReclamationService } = require('../dist/core/reclamation.js');

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
        removeWorktreeSafe: async () => ({ removed: true, dryRun: false }),
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
