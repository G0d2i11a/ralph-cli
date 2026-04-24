const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { StateManager } = require('../dist/core/state.js');

function createTask(overrides = {}) {
  const now = 1_000;
  return {
    id: 'state-task',
    prdPath: '/tmp/prd.json',
    status: 'pending',
    startTime: now,
    completedUS: [],
    worktree: '',
    logPath: '/tmp/agent.log',
    agent: 'codex',
    repoPath: '/tmp/repo',
    loopCount: 0,
    consecutiveNoProgress: 0,
    consecutiveErrors: 0,
    lastProgressTime: now,
    lastFilesChanged: 0,
    ...overrides,
  };
}

test('StateManager rejects stale full-object writes and accepts patch updates', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-state-revision-'));
  const previousHome = process.env.HOME;

  try {
    process.env.HOME = homeDir;
    const stateManager = new StateManager();

    const originalTask = createTask();
    await stateManager.saveTask(originalTask);
    const firstSnapshot = await stateManager.loadTask(originalTask.id);

    await stateManager.updateTask(originalTask.id, {
      status: 'running',
      pid: 1234,
    });

    await assert.rejects(
      () => stateManager.saveTask({
        ...firstSnapshot,
        currentUS: 'US-001',
      }),
      /Stale task write rejected/
    );

    await stateManager.updateTask(originalTask.id, {
      currentUS: 'US-001',
    });

    const latestTask = await stateManager.loadTask(originalTask.id);
    assert.equal(latestTask.status, 'running');
    assert.equal(latestTask.pid, 1234);
    assert.equal(latestTask.currentUS, 'US-001');
    assert.equal(latestTask.revision, 3);
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
