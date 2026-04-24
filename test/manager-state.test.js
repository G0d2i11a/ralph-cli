const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ManagerStateWriter,
  getManagerStatus,
  getManagerStatePath,
  writeManagerState,
} = require('../dist/core/manager-state.js');

test('ManagerStateWriter records loop heartbeat and stopped state', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-manager-home-'));
  let now = 1000;

  try {
    const writer = new ManagerStateWriter({
      homeDir,
      pollIntervalMs: 10000,
      autoIngestEnabled: false,
      repo: '/tmp/repo',
      agent: 'codex',
      backend: 'cli',
      now: () => now,
    });

    writer.start();
    now = 2000;
    writer.loopStarted();
    now = 3000;
    writer.loopCompleted();

    const runningStatus = getManagerStatus({
      homeDir,
      now: () => now,
      isProcessRunning: (pid) => pid === process.pid,
    });

    assert.equal(runningStatus.active, true);
    assert.equal(runningStatus.heartbeatStale, false);
    assert.equal(runningStatus.state.status, 'running');
    assert.equal(runningStatus.state.lastLoopStartedAt, 2000);
    assert.equal(runningStatus.state.lastLoopCompletedAt, 3000);

    now = 4000;
    writer.stopped();
    const stoppedStatus = getManagerStatus({
      homeDir,
      now: () => now,
      isProcessRunning: () => false,
    });

    assert.equal(stoppedStatus.active, false);
    assert.equal(stoppedStatus.state.status, 'stopped');
    assert.equal(stoppedStatus.state.stoppedAt, 4000);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('getManagerStatus marks a live manager with an old heartbeat as stale', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-manager-stale-home-'));

  try {
    writeManagerState({
      pid: 12345,
      status: 'running',
      startedAt: 1000,
      updatedAt: 1000,
      lastHeartbeatAt: 1000,
      pollIntervalMs: 1000,
      autoIngestEnabled: false,
      hostname: 'test-host',
      argv: ['ralph', 'manager'],
    }, { homeDir });

    const status = getManagerStatus({
      homeDir,
      now: () => 7000,
      staleAfterMs: 5000,
      isProcessRunning: () => true,
    });

    assert.equal(status.active, true);
    assert.equal(status.heartbeatStale, true);
    assert.match(status.message, /heartbeat is stale/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('getManagerStatus distinguishes dead manager PIDs from active managers', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-manager-dead-home-'));

  try {
    writeManagerState({
      pid: 54321,
      status: 'running',
      startedAt: 1000,
      updatedAt: 2000,
      lastHeartbeatAt: 2000,
      pollIntervalMs: 1000,
      autoIngestEnabled: false,
      hostname: 'test-host',
      argv: ['ralph', 'manager'],
    }, { homeDir });

    const status = getManagerStatus({
      homeDir,
      now: () => 3000,
      staleAfterMs: 5000,
      isProcessRunning: () => false,
    });

    assert.equal(status.active, false);
    assert.equal(status.processRunning, false);
    assert.equal(status.heartbeatStale, false);
    assert.match(status.message, /not running/);
    assert.equal(fs.existsSync(getManagerStatePath({ homeDir })), true);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
