const test = require('node:test');
const assert = require('node:assert/strict');
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

function makeEvidenceCandidate(repoPath, worktree, overrides = {}) {
  return {
    kind: 'task_worktree',
    taskId: 'failed-task',
    status: 'failed',
    repoPath,
    worktree,
    tier: 'terminal',
    inspection: makeInspection(worktree, {
      dirty: true,
      branch: 'ralph/failed-task',
      head: '0123456789abcdef',
    }),
    ...overrides,
  };
}

function makeEvidenceConfig(values = {}) {
  return makeConfig({
    'reclamation.evidence.includeTaskSnapshot': false,
    'reclamation.evidence.includeTaskEventLogTail': false,
    'reclamation.evidence.includeAgentLogTail': false,
    'reclamation.evidence.includeStatus': false,
    'reclamation.evidence.includePatches': false,
    'reclamation.evidence.includeFileList': false,
    'reclamation.evidence.includeUntrackedFiles': false,
    ...values,
  });
}

function makeEvidenceWorktreeManager() {
  return {
    getWorktreeStatusPorcelainV2: async () => '',
    getWorktreeStatusShort: async () => '',
    getWorktreeListPorcelain: async () => '',
    getWorktreeDiffPatch: async () => '',
    getWorktreeCachedDiffPatch: async () => '',
    listTrackedAndOtherFiles: async () => [],
    listUntrackedFiles: async () => [],
  };
}

function makeArchiveDecision() {
  return {
    attentionState: 'retained',
    action: 'archive_only',
    reason: 'test',
    safetyGates: [],
  };
}

function writeEvidenceArchive(evidenceRoot, id, createdAtMs, payloadBytes) {
  const dateSegment = new Date(createdAtMs).toISOString().slice(0, 10);
  const archiveDir = path.join(evidenceRoot, dateSegment, id);
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(path.join(archiveDir, 'payload.bin'), Buffer.alloc(payloadBytes, 'x'));
  fs.writeFileSync(
    path.join(archiveDir, 'manifest.json'),
    `${JSON.stringify({ createdAt: new Date(createdAtMs).toISOString() }, null, 2)}\n`,
  );
  fs.utimesSync(archiveDir, new Date(createdAtMs), new Date(createdAtMs));
  return archiveDir;
}

function directoryBytes(dir) {
  if (!fs.existsSync(dir)) {
    return 0;
  }

  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += directoryBytes(absolutePath);
    } else if (entry.isFile()) {
      total += fs.statSync(absolutePath).size;
    }
  }
  return total;
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

test('ReclamationService automatic run removes clean terminal worktrees immediately', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-repo-'));
  const worktree = path.join(repo, '.ralph-worktrees', 'completed-task');
  const now = Date.now();
  const updates = [];
  const task = makeTask({
    id: 'completed-task',
    repoPath: repo,
    worktree,
    endTime: now,
    logPath: path.join(home, 'tasks', 'completed-task', 'agent.log'),
  });
  let removeCalls = 0;

  try {
    fs.mkdirSync(worktree, { recursive: true });
    const service = new ReclamationService({
      stateManager: makeStateManager(home, [task], updates),
      configManager: makeConfig({
        'reclamation.worktrees.cleanTerminalRetentionHours': 0,
        'reclamation.worktrees.completedRetentionHours': 24,
        'reclamation.worktrees.keepNewestCleanPerRepo': 0,
        'reclamation.reporting.emitTaskEvents': false,
      }),
      now: () => now,
      worktreeManager: {
        inspectWorktree: async () => makeInspection(worktree),
        removeWorktreeSafe: async (_repoPath, worktreePath, options) => {
          removeCalls += 1;
          assert.equal(worktreePath, worktree);
          assert.equal(options.force, false);
          return { removed: true, dryRun: false };
        },
        pruneWorktreeMetadata: async () => undefined,
        listWorktrees: async () => [],
      },
    });

    const report = await service.run({ mode: 'manager_periodic' });

    assert.equal(report.removed, 1);
    assert.equal(report.candidates[0].taskId, 'completed-task');
    assert.equal(report.candidates[0].retentionHours, 0);
    assert.equal(report.candidates[0].decisionAction, 'remove_clean');
    assert.equal(removeCalls, 1);
    assert.equal(updates[0].update.worktreeReclaimDecision, 'remove_clean');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('ReclamationService keep-newest retention does not protect clean terminal worktrees by default', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-repo-'));
  const now = Date.now();
  const oldWorktree = path.join(repo, '.ralph-worktrees', 'old-task');
  const newWorktree = path.join(repo, '.ralph-worktrees', 'new-task');
  const oldTask = makeTask({
    id: 'old-task',
    repoPath: repo,
    worktree: oldWorktree,
    endTime: now - HOUR,
  });
  const newTask = makeTask({
    id: 'new-task',
    repoPath: repo,
    worktree: newWorktree,
    endTime: now,
  });
  const removed = [];

  try {
    fs.mkdirSync(oldWorktree, { recursive: true });
    fs.mkdirSync(newWorktree, { recursive: true });
    const service = new ReclamationService({
      stateManager: makeStateManager(home, [oldTask, newTask]),
      configManager: makeConfig({
        'reclamation.worktrees.cleanTerminalRetentionHours': 0,
        'reclamation.worktrees.keepNewestPerRepo': 5,
        'reclamation.reporting.emitTaskEvents': false,
      }),
      now: () => now,
      worktreeManager: {
        inspectWorktree: async (_repoPath, worktreePath) => makeInspection(worktreePath),
        removeWorktreeSafe: async (_repoPath, worktreePath) => {
          removed.push(worktreePath);
          return { removed: true, dryRun: false };
        },
        pruneWorktreeMetadata: async () => undefined,
        listWorktrees: async () => [],
      },
    });

    const report = await service.run({ mode: 'manager_periodic' });

    assert.equal(report.removed, 2);
    assert.deepEqual(removed, [oldWorktree, newWorktree]);
    assert.equal(report.skipped.length, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('ReclamationService can explicitly keep newest clean terminal worktrees', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-repo-'));
  const now = Date.now();
  const oldWorktree = path.join(repo, '.ralph-worktrees', 'old-task');
  const newWorktree = path.join(repo, '.ralph-worktrees', 'new-task');
  const oldTask = makeTask({
    id: 'old-task',
    repoPath: repo,
    worktree: oldWorktree,
    endTime: now - HOUR,
  });
  const newTask = makeTask({
    id: 'new-task',
    repoPath: repo,
    worktree: newWorktree,
    endTime: now,
  });
  const removed = [];

  try {
    fs.mkdirSync(oldWorktree, { recursive: true });
    fs.mkdirSync(newWorktree, { recursive: true });
    const service = new ReclamationService({
      stateManager: makeStateManager(home, [oldTask, newTask]),
      configManager: makeConfig({
        'reclamation.worktrees.cleanTerminalRetentionHours': 0,
        'reclamation.worktrees.keepNewestCleanPerRepo': 1,
        'reclamation.reporting.emitTaskEvents': false,
      }),
      now: () => now,
      worktreeManager: {
        inspectWorktree: async (_repoPath, worktreePath) => makeInspection(worktreePath),
        removeWorktreeSafe: async (_repoPath, worktreePath) => {
          removed.push(worktreePath);
          return { removed: true, dryRun: false };
        },
        pruneWorktreeMetadata: async () => undefined,
        listWorktrees: async () => [],
      },
    });

    const report = await service.run({ mode: 'manager_periodic' });

    assert.deepEqual(removed, [oldWorktree]);
    assert.equal(report.removed, 1);
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0].taskId, 'new-task');
    assert.equal(report.skipped[0].reason, 'keep_newest_clean_per_repo');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('ReclamationService re-inspects before clean removal and refuses if worktree became dirty', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reclaim-repo-'));
  const worktree = path.join(repo, '.ralph-worktrees', 'completed-task');
  const now = Date.now();
  const task = makeTask({
    id: 'completed-task',
    repoPath: repo,
    worktree,
    endTime: now,
  });
  let inspections = 0;
  let removeCalls = 0;

  try {
    fs.mkdirSync(worktree, { recursive: true });
    const service = new ReclamationService({
      stateManager: {
        ...makeStateManager(home, [task]),
        loadTask: async () => task,
      },
      configManager: makeConfig({
        'reclamation.worktrees.cleanTerminalRetentionHours': 0,
        'reclamation.reporting.emitTaskEvents': false,
      }),
      now: () => now,
      worktreeManager: {
        inspectWorktree: async () => {
          inspections += 1;
          return makeInspection(worktree, { dirty: inspections > 1 });
        },
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
    assert.equal(report.skipped[0].reason, 'became_dirty_before_clean_removal');
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

test('ReclamationService disk pressure dirty reclaim keeps retry-attention worktrees archive-only', async () => {
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
    lastErrorClass: 'transport',
    lastErrorRetryable: true,
  });
  let removeCalls = 0;

  try {
    fs.mkdirSync(worktree, { recursive: true });
    const service = new ReclamationService({
      stateManager: makeStateManager(home, [task]),
      configManager: makeConfig({
        'reclamation.evidence.requireForDirtyReclaim': true,
        'reclamation.worktrees.skipDirtyIfRetryableFailure': true,
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
          dir: path.join(home, 'evidence', 'failed-task'),
          manifestPath: path.join(home, 'evidence', 'failed-task', 'manifest.json'),
          bytes: 42,
        }),
      },
    });

    const report = await service.run({
      mode: 'disk_pressure',
      dirtyTerminalModeOverride: 'archive_then_reclaim',
      dirtyTerminalRetentionHoursOverride: 0,
    });

    assert.equal(report.worktrees.archived, 1);
    assert.equal(report.removed, 0);
    assert.equal(report.skipped[0].attentionState, 'retry');
    assert.equal(report.skipped[0].decisionAction, 'archive_only');
    assert.equal(report.skipped[0].reason, 'dirty_worktree_archived_retry_attention');
    assert.equal(removeCalls, 0);
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

test('WorktreeEvidenceArchiver prunes old evidence archives and stale temp dirs before archiving', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-evidence-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-evidence-repo-'));
  const worktree = path.join(repo, '.ralph-worktrees', 'failed-task');
  const evidenceRoot = path.join(home, 'evidence');
  const now = Date.UTC(2026, 0, 2, 12, 0, 0);

  try {
    fs.mkdirSync(worktree, { recursive: true });
    const oldArchive = writeEvidenceArchive(evidenceRoot, 'old-archive', now - 3 * HOUR, 1024);
    const staleTemp = path.join(evidenceRoot, '.tmp', 'stale-archive');
    fs.mkdirSync(staleTemp, { recursive: true });
    fs.writeFileSync(path.join(staleTemp, 'partial.bin'), Buffer.alloc(1024, 'x'));
    fs.utimesSync(staleTemp, new Date(now - 3 * HOUR), new Date(now - 3 * HOUR));

    const archiver = new WorktreeEvidenceArchiver({
      ralphHome: home,
      configManager: makeEvidenceConfig({
        'reclamation.evidence.dir': evidenceRoot,
        'reclamation.evidence.maxAgeHours': 1,
        'reclamation.evidence.incompleteTempRetentionHours': 1,
      }),
      worktreeManager: makeEvidenceWorktreeManager(),
      now: () => now,
    });

    const result = await archiver.archive(makeEvidenceCandidate(repo, worktree), makeArchiveDecision(), { mode: 'manager_periodic' });

    assert.equal(result.ok, true);
    assert.ok(result.manifestPath);
    assert.equal(fs.existsSync(result.manifestPath), true);
    assert.equal(fs.existsSync(oldArchive), false);
    assert.equal(fs.existsSync(staleTemp), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('WorktreeEvidenceArchiver enforces evidence total byte cap while preserving current archive', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-evidence-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-evidence-repo-'));
  const worktree = path.join(repo, '.ralph-worktrees', 'failed-task');
  const evidenceRoot = path.join(home, 'evidence');
  const now = Date.UTC(2026, 0, 3, 12, 0, 0);
  const maxTotalBytes = 20 * 1024;

  try {
    fs.mkdirSync(worktree, { recursive: true });
    const oldestArchive = writeEvidenceArchive(evidenceRoot, 'oldest', now - 3 * HOUR, 10 * 1024);
    writeEvidenceArchive(evidenceRoot, 'middle', now - 2 * HOUR, 10 * 1024);
    writeEvidenceArchive(evidenceRoot, 'newest', now - HOUR, 10 * 1024);

    const archiver = new WorktreeEvidenceArchiver({
      ralphHome: home,
      configManager: makeEvidenceConfig({
        'reclamation.evidence.dir': evidenceRoot,
        'reclamation.evidence.maxAgeHours': 24,
        'reclamation.evidence.maxTotalBytes': maxTotalBytes,
      }),
      worktreeManager: makeEvidenceWorktreeManager(),
      now: () => now,
    });

    const result = await archiver.archive(makeEvidenceCandidate(repo, worktree), makeArchiveDecision(), { mode: 'manager_periodic' });

    assert.equal(result.ok, true);
    assert.ok(result.dir);
    assert.equal(fs.existsSync(result.dir), true);
    assert.equal(fs.existsSync(oldestArchive), false);
    assert.ok(directoryBytes(evidenceRoot) <= maxTotalBytes);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('WorktreeEvidenceArchiver deletes incomplete temp archive when candidate exceeds size limit', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-evidence-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-evidence-repo-'));
  const worktree = path.join(repo, '.ralph-worktrees', 'failed-task');
  const evidenceRoot = path.join(home, 'evidence');
  const now = Date.UTC(2026, 0, 4, 12, 0, 0);

  try {
    fs.mkdirSync(worktree, { recursive: true });
    const archiver = new WorktreeEvidenceArchiver({
      ralphHome: home,
      configManager: makeEvidenceConfig({
        'reclamation.evidence.dir': evidenceRoot,
        'reclamation.evidence.maxBytesPerCandidate': 1,
      }),
      worktreeManager: makeEvidenceWorktreeManager(),
      now: () => now,
    });

    const result = await archiver.archive(makeEvidenceCandidate(repo, worktree), makeArchiveDecision(), { mode: 'manager_periodic' });
    const tempRoot = path.join(evidenceRoot, '.tmp');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'evidence_archive_limit_exceeded');
    assert.equal(result.dir, undefined);
    assert.equal(fs.existsSync(tempRoot) ? fs.readdirSync(tempRoot).length : 0, 0);
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
