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

test('manager state paths use RALPH_HOME directly when provided', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-manager-custom-home-'));
  const ralphHome = path.join(tempDir, 'custom-home');

  try {
    writeManagerState({
      pid: 777,
      status: 'running',
      startedAt: 1000,
      updatedAt: 1000,
      lastHeartbeatAt: 1000,
      pollIntervalMs: 1000,
      autoIngestEnabled: false,
      hostname: 'test-host',
      argv: ['ralph', 'manager'],
    }, { ralphHome });

    const status = getManagerStatus({
      ralphHome,
      now: () => 2000,
      isProcessRunning: () => false,
    });

    assert.equal(status.ralphHome, ralphHome);
    assert.equal(status.statePath, path.join(ralphHome, 'manager', 'state.json'));
    assert.equal(status.lockDir, path.join(ralphHome, 'manager.lock'));
    assert.equal(fs.existsSync(getManagerStatePath({ ralphHome })), true);
    assert.equal(fs.existsSync(path.join(ralphHome, '.ralph', 'manager', 'state.json')), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('getManagerStatus detects manager code drift when dist files changed after startup', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-manager-drift-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-manager-drift-repo-'));
  const distDir = path.join(repoDir, 'dist');
  const entryPath = path.join(distDir, 'cli.js');
  const dependencyPath = path.join(distDir, 'core', 'dependency-watcher.js');

  try {
    fs.mkdirSync(path.dirname(dependencyPath), { recursive: true });
    fs.writeFileSync(entryPath, 'console.log("entry");\n');
    fs.writeFileSync(dependencyPath, 'console.log("dep");\n');
    fs.utimesSync(entryPath, 1, 1);
    fs.utimesSync(dependencyPath, 5, 5);

    writeManagerState({
      pid: 99999,
      status: 'running',
      startedAt: 2000,
      updatedAt: 3000,
      lastHeartbeatAt: 3000,
      pollIntervalMs: 1000,
      autoIngestEnabled: false,
      hostname: 'test-host',
      argv: ['node', entryPath, 'manager'],
    }, { homeDir });

    const status = getManagerStatus({
      homeDir,
      now: () => 4000,
      staleAfterMs: 5000,
      isProcessRunning: () => true,
    });

    assert.equal(status.active, true);
    assert.equal(status.codeDriftDetected, true);
    assert.equal(status.managerEntryPath, entryPath);
    assert.equal(status.managerCodeRootPath, distDir);
    assert.equal(status.managerCodeLatestPath, dependencyPath);
    assert.match(status.message, /older than current code on disk/);
    assert.match(status.codeDriftReason, /dependency-watcher\.js/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
