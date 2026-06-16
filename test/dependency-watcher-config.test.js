const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DependencyWatcher } = require('../dist/core/dependency-watcher.js');

class FakeStateManager {
  async listTasks() {
    return [];
  }

  async updateTask() {}
}

test('DependencyWatcher uses configured poll interval when CLI interval is omitted', async () => {
  const sleeps = [];
  const logs = [];
  let watcher;

  watcher = new DependencyWatcher(
    {},
    {
      stateManager: new FakeStateManager(),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      configManager: {
        get: (key) => key === 'runner.pollInterval' ? 7 : undefined,
      },
      autoIngestor: {
        initialize: async () => undefined,
        scan: async () => {
          watcher.stop();
          return [];
        },
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      logger: {
        log: (message) => logs.push(String(message)),
        error: (message) => logs.push(`ERR:${String(message)}`),
      },
    }
  );

  await watcher.start();

  assert.deepEqual(sleeps, [7000]);
  assert.ok(logs.some((line) => line.includes('polling every 7s')));
});

test('DependencyWatcher requires a watch directory before enabling ez4ielts auto-ingest', () => {
  assert.throws(() => {
    new DependencyWatcher(
      { autoIngestEz4ielts: true },
      {
        stateManager: new FakeStateManager(),
        scheduler: {
          schedulePendingTasks: async () => [],
        },
        configManager: {
          get: () => undefined,
        },
      }
    );
  }, /watch directory/);
});

test('DependencyWatcher exposes explicit startup backlog ingestion mode', () => {
  const watcher = new DependencyWatcher(
    { ingestExistingEz4ielts: true },
    {
      stateManager: new FakeStateManager(),
      scheduler: {
        schedulePendingTasks: async () => [],
      },
      configManager: {
        get: () => undefined,
      },
      autoIngestor: {
        initialize: async () => undefined,
        scan: async () => [],
      },
    }
  );

  assert.equal(watcher.isAutoIngestExistingOnStartupEnabled(), true);
});

test('DependencyWatcher does not initialize auto-ingest while manager scheduling is paused', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-watcher-paused-'));
  const previousRalphHome = process.env.RALPH_HOME;
  let initializeCalls = 0;
  let scanCalls = 0;
  let watcher;

  try {
    process.env.RALPH_HOME = homeDir;
    fs.mkdirSync(path.join(homeDir, 'manager'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, 'manager', 'control.json'), JSON.stringify({
      schemaVersion: 1,
      schedulingPaused: true,
      pausedAt: Date.now(),
      pauseReason: 'operator_paused',
    }, null, 2));

    watcher = new DependencyWatcher(
      {},
      {
        stateManager: new FakeStateManager(),
        scheduler: {
          recoverStaleTasks: async () => {
            throw new Error('recoverStaleTasks should not run while paused');
          },
          schedulePendingTasks: async () => {
            throw new Error('schedulePendingTasks should not run while paused');
          },
        },
        configManager: {
          get: (key) => key === 'runner.pollInterval' ? 1 : undefined,
        },
        autoIngestor: {
          initialize: async () => {
            initializeCalls++;
          },
          scan: async () => {
            scanCalls++;
          },
        },
        sleep: async () => {
          watcher.stop();
        },
        logger: {
          log: () => undefined,
          error: () => undefined,
        },
      }
    );

    await watcher.start();

    assert.equal(initializeCalls, 0);
    assert.equal(scanCalls, 0);
  } finally {
    if (previousRalphHome === undefined) {
      delete process.env.RALPH_HOME;
    } else {
      process.env.RALPH_HOME = previousRalphHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('DependencyWatcher runs startup reclamation after configured delay', async () => {
  const sleeps = [];
  const reclamationRuns = [];
  let watcher;

  watcher = new DependencyWatcher(
    {},
    {
      stateManager: new FakeStateManager(),
      scheduler: {
        recoverStaleTasks: async () => undefined,
        schedulePendingTasks: async () => [],
      },
      configManager: {
        get: (key) => key === 'runner.pollInterval' ? 1 : undefined,
      },
      autoIngestor: {
        initialize: async () => undefined,
        scan: async () => [],
      },
      reclamationService: {
        isAutomaticReclamationEnabled: () => true,
        getStartupDelayMs: () => 0,
        getIntervalMs: () => 60 * 1000,
        getCleanTerminalSweepIntervalMs: () => 30 * 1000,
        run: async (options) => {
          reclamationRuns.push(options);
          return {
            removed: 0,
            errors: [],
            worktrees: { skipped: 0 },
          };
        },
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        watcher.stop();
      },
      logger: {
        log: () => undefined,
        error: () => undefined,
      },
    }
  );

  await watcher.start();

  assert.deepEqual(reclamationRuns, [{ mode: 'manager_startup' }]);
  assert.deepEqual(sleeps, [1000]);
});

test('DependencyWatcher runs frequent clean terminal reclamation between full sweeps', async () => {
  const sleeps = [];
  const reclamationRuns = [];
  let watcher;

  watcher = new DependencyWatcher(
    {},
    {
      stateManager: new FakeStateManager(),
      scheduler: {
        recoverStaleTasks: async () => undefined,
        schedulePendingTasks: async () => [],
      },
      configManager: {
        get: (key) => key === 'runner.pollInterval' ? 1 : undefined,
      },
      autoIngestor: {
        initialize: async () => undefined,
        scan: async () => [],
      },
      reclamationService: {
        isAutomaticReclamationEnabled: () => true,
        getStartupDelayMs: () => 60 * 1000,
        getIntervalMs: () => 15 * 60 * 1000,
        getCleanTerminalSweepIntervalMs: () => 0,
        run: async (options) => {
          reclamationRuns.push(options);
          return {
            removed: 1,
            errors: [],
            worktrees: { skipped: 0 },
          };
        },
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        watcher.stop();
      },
      logger: {
        log: () => undefined,
        error: () => undefined,
      },
    }
  );

  await watcher.start();

  assert.deepEqual(reclamationRuns, [{
    mode: 'manager_clean_terminal',
    cleanTerminalOnly: true,
    cleanTerminalRetentionHoursOverride: 0,
    skipKeepNewestPerRepo: true,
  }]);
  assert.deepEqual(sleeps, [1000]);
});

test('DependencyWatcher runs emergency disk pressure reclamation immediately', async () => {
  const sleeps = [];
  const logs = [];
  const reclamationRuns = [];
  const gib = 1024 * 1024 * 1024;
  let watcher;

  watcher = new DependencyWatcher(
    { repo: '/tmp/ralph-disk-pressure-repo' },
    {
      stateManager: new FakeStateManager(),
      scheduler: {
        recoverStaleTasks: async () => undefined,
        schedulePendingTasks: async () => [],
      },
      configManager: {
        get: (key) => {
          const values = {
            'runner.pollInterval': 1,
            'reclamation.diskPressure.enabled': true,
            'reclamation.diskPressure.checkIntervalSeconds': 60,
            'reclamation.diskPressure.minFreeBytes': 10 * gib,
            'reclamation.diskPressure.minFreePercent': 10,
            'reclamation.diskPressure.targetFreeBytes': 30 * gib,
            'reclamation.diskPressure.emergencyFreeBytes': 5 * gib,
            'reclamation.worktrees.pressureEmergencyMaxRemovalsPerRun': 250,
          };
          return values[key];
        },
      },
      autoIngestor: {
        initialize: async () => undefined,
        scan: async () => [],
      },
      reclamationService: {
        isAutomaticReclamationEnabled: () => true,
        getStartupDelayMs: () => 60 * 1000,
        getIntervalMs: () => 15 * 60 * 1000,
        getCleanTerminalSweepIntervalMs: () => 30 * 1000,
        run: async (options) => {
          reclamationRuns.push(options);
          return {
            removed: 3,
            errors: [],
            worktrees: { skipped: 1 },
          };
        },
      },
      statfs: () => reclamationRuns.length > 0
        ? {
            bavail: 31,
            blocks: 100,
            bsize: gib,
          }
        : {
            bavail: 1,
            blocks: 100,
            bsize: gib,
          },
      sleep: async (ms) => {
        sleeps.push(ms);
        watcher.stop();
      },
      logger: {
        log: (message) => logs.push(String(message)),
        error: (message) => logs.push(`ERR:${String(message)}`),
      },
    }
  );

  await watcher.start();

  assert.deepEqual(reclamationRuns, [{
    mode: 'disk_pressure',
    includeOrphanWorktrees: true,
    cleanTerminalRetentionHoursOverride: 0,
    cleanOrphanRetentionHoursOverride: 0,
    skipKeepNewestPerRepo: true,
    maxRemovals: 250,
    dirtyTerminalModeOverride: 'archive_then_reclaim',
    dirtyOrphanModeOverride: 'archive_then_reclaim',
    includeDirtyOrphanWorktrees: true,
    dirtyTerminalRetentionHoursOverride: 0,
    dirtyOrphanRetentionHoursOverride: 0,
  }]);
  assert.deepEqual(sleeps, [1000]);
  assert.ok(logs.some((line) => line.includes('Reclamation disk_pressure removed 3 worktree(s)')));
});
