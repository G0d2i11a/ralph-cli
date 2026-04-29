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

test('DependencyWatcher enables configured PRD globs without an ez4ielts watch directory', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-configured-prd-glob-repo-'));

  try {
    const watcher = new DependencyWatcher(
      {},
      {
        stateManager: new FakeStateManager(),
        scheduler: {
          schedulePendingTasks: async () => [],
        },
        configManager: {
          get: (key) => ({
            'runner.pollInterval': 7,
            'ingestion.prds.enabled': true,
            'ingestion.prds.globs': [
              {
                repo: repoDir,
                glob: 'tasks/prd-*.md',
              },
            ],
            'ingestion.prds.settleMs': 0,
          })[key],
        },
      }
    );

    assert.equal(watcher.isAutoIngestEnabled(), true);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
