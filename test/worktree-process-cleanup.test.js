const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  cleanupWorktreeProcesses,
  findKnownWorktreeLockPaths,
  listWorktreeProcessCandidatePids,
  resolveConfiguredWorktreeCleanupLockGlobs,
} = require('../dist/core/worktree-process-cleanup.js');

test('findKnownWorktreeLockPaths discovers Next build locks without scanning node_modules', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-worktree-locks-'));

  try {
    const lockPath = path.join(root, 'apps', 'web', '.next', 'lock');
    const staleLockPath = path.join(root, 'apps', 'web', '.next.stale-build-20260508_022301', 'lock');
    const ignoredLockPath = path.join(root, 'node_modules', 'pkg', '.next', 'lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.mkdirSync(path.dirname(staleLockPath), { recursive: true });
    fs.mkdirSync(path.dirname(ignoredLockPath), { recursive: true });
    fs.writeFileSync(lockPath, '');
    fs.writeFileSync(staleLockPath, '');
    fs.writeFileSync(ignoredLockPath, '');

    assert.deepEqual(findKnownWorktreeLockPaths(root).sort(), [lockPath, staleLockPath].sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findKnownWorktreeLockPaths honors configured safe relative lock globs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-worktree-lock-globs-'));

  try {
    const customLockPath = path.join(root, 'packages', 'api', '.framework-cache', 'lock');
    const ignoredAbsolutePath = path.join(root, 'tmp', 'absolute-lock');
    fs.mkdirSync(path.dirname(customLockPath), { recursive: true });
    fs.mkdirSync(path.dirname(ignoredAbsolutePath), { recursive: true });
    fs.writeFileSync(customLockPath, '');
    fs.writeFileSync(ignoredAbsolutePath, '');

    assert.deepEqual(
      findKnownWorktreeLockPaths(root, ['**/.framework-cache/lock', '/tmp/absolute-lock', '../outside/lock']),
      [customLockPath],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveConfiguredWorktreeCleanupLockGlobs parses array and comma-separated config', () => {
  assert.deepEqual(
    resolveConfiguredWorktreeCleanupLockGlobs({ get: () => ['**/.next/lock', ' ', 42, '**/.vite/lock'] }),
    ['**/.next/lock', '**/.vite/lock'],
  );
  assert.deepEqual(
    resolveConfiguredWorktreeCleanupLockGlobs({ get: () => '**/.next/lock, **/.turbo/lock' }),
    ['**/.next/lock', '**/.turbo/lock'],
  );
  assert.equal(resolveConfiguredWorktreeCleanupLockGlobs({ get: () => undefined }), undefined);
});

test('cleanupWorktreeProcesses kills verified worktree lock holders and skips protected descendants', async () => {
  const worktreePath = '/repo/.ralph-worktrees/task-1';
  const lockPath = path.join(worktreePath, 'apps', 'web', '.next', 'lock');
  const alive = new Set([200, 300, 400]);
  const processInfo = new Map([
    [100, { ppid: 1, pgid: 100, command: 'node dist/worker.js task-1', cwd: worktreePath }],
    [200, { ppid: 1, pgid: 150, command: `node ${worktreePath}/apps/web/node_modules/.bin/next build`, cwd: path.join(worktreePath, 'apps', 'web') }],
    [300, { ppid: 100, pgid: 100, command: `node ${worktreePath}/scripts/build.js`, cwd: path.join(worktreePath, 'apps', 'web') }],
    [400, { ppid: 1, pgid: 400, command: 'node /tmp/other/next build', cwd: '/tmp/other' }],
  ]);
  const signals = [];

  const result = await cleanupWorktreeProcesses({
    taskId: 'task-1',
    worktreePath,
    reason: 'test_cleanup',
    protectedPids: [100],
    lockPaths: [lockPath],
    graceMs: 1,
  }, {
    listLockHolderPids: () => [200, 300, 400],
    listProcessCandidatePids: () => [],
    getProcessInfo: (pid) => processInfo.get(pid),
    isProcessRunning: (pid) => alive.has(pid),
    terminateProcess: (pid, signal) => {
      signals.push({ pid, signal });
      if (pid === -150 || pid === 200) {
        alive.delete(200);
      }
    },
    now: () => Date.now(),
    sleep: async () => {},
  });

  assert.equal(result.killed.length, 1);
  assert.equal(result.killed[0].pid, 200);
  assert.equal(result.killed[0].signalPid, -150);
  assert.equal(result.killed[0].signalScope, 'process_group');
  assert.deepEqual(result.skipped.map((entry) => [entry.pid, entry.reason]), [
    [300, 'protected'],
    [400, 'outside_worktree'],
  ]);
  assert.deepEqual(signals, [{ pid: -150, signal: 'SIGTERM' }]);
});

test('cleanupWorktreeProcesses can kill protected descendants by pid without killing their process group', async () => {
  const worktreePath = '/repo/.ralph-worktrees/task-1';
  const lockPath = path.join(worktreePath, 'apps', 'web', '.next', 'lock');
  const alive = new Set([100, 300]);
  const processInfo = new Map([
    [100, { ppid: 1, pgid: 100, command: 'node dist/worker.js task-1', cwd: worktreePath }],
    [300, { ppid: 100, pgid: 100, command: `node ${worktreePath}/apps/web/node_modules/.bin/next build`, cwd: path.join(worktreePath, 'apps', 'web') }],
  ]);
  const signals = [];

  const result = await cleanupWorktreeProcesses({
    taskId: 'task-1',
    worktreePath,
    reason: 'test_cleanup',
    protectedPids: [100],
    allowProtectedDescendantCleanup: true,
    lockPaths: [lockPath],
    graceMs: 1,
  }, {
    listLockHolderPids: () => [300],
    listProcessCandidatePids: () => [],
    getProcessInfo: (pid) => processInfo.get(pid),
    isProcessRunning: (pid) => alive.has(pid),
    terminateProcess: (pid, signal) => {
      signals.push({ pid, signal });
      if (pid === 300) {
        alive.delete(300);
      }
    },
    now: () => Date.now(),
    sleep: async () => {},
  });

  assert.equal(result.killed.length, 1);
  assert.equal(result.killed[0].pid, 300);
  assert.equal(result.killed[0].signalPid, 300);
  assert.equal(result.killed[0].signalScope, 'process');
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(signals, [{ pid: 300, signal: 'SIGTERM' }]);
});

test('cleanupWorktreeProcesses kills verified worktree build processes discovered by command scan', async () => {
  const worktreePath = '/repo/.ralph-worktrees/task-1';
  const alive = new Set([500, 600]);
  const processInfo = new Map([
    [500, { ppid: 1, pgid: 500, command: `node ${worktreePath}/apps/web/node_modules/.bin/next build`, cwd: path.join(worktreePath, 'apps', 'web') }],
    [600, { ppid: 1, pgid: 600, command: 'node /other/apps/web/node_modules/.bin/next build', cwd: '/other/apps/web' }],
  ]);
  const signals = [];

  const result = await cleanupWorktreeProcesses({
    taskId: 'task-1',
    worktreePath,
    reason: 'test_process_scan',
    lockPaths: [],
    graceMs: 1,
  }, {
    listLockHolderPids: () => [],
    listProcessCandidatePids: () => [500, 600],
    getProcessInfo: (pid) => processInfo.get(pid),
    isProcessRunning: (pid) => alive.has(pid),
    terminateProcess: (pid, signal) => {
      signals.push({ pid, signal });
      if (pid === -500 || pid === 500) {
        alive.delete(500);
      }
    },
    now: () => Date.now(),
    sleep: async () => {},
  });

  assert.equal(result.killed.length, 1);
  assert.equal(result.killed[0].pid, 500);
  assert.equal(result.killed[0].lockPath, '(process scan)');
  assert.equal(result.killed[0].source, 'process_scan');
  assert.deepEqual(result.skipped.map((entry) => [entry.pid, entry.reason, entry.source]), [
    [600, 'outside_worktree', 'process_scan'],
  ]);
  assert.deepEqual(signals, [{ pid: -500, signal: 'SIGTERM' }]);
});

test('listWorktreeProcessCandidatePids returns process ids matching build command patterns', () => {
  const candidates = listWorktreeProcessCandidatePids('/repo/.ralph-worktrees/task-1', ['unlikely-ralph-test-pattern']);
  assert.deepEqual(candidates, []);
});
