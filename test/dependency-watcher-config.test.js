const test = require('node:test');
const assert = require('node:assert/strict');

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
