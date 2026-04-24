const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

function runCli(args, env = {}) {
  return spawnSync('node', ['dist/cli.js', ...args], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...env,
    },
  });
}

test('queue command reports active queue state', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-home-'));

  try {
    const taskDir = path.join(homeDir, '.ralph', 'tasks', 'pending-task');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: 'pending-task',
      prdPath: '/tmp/prd.json',
      prdId: 'pending-prd',
      prdDependencies: [],
      status: 'pending',
      startTime: Date.now(),
      completedUS: [],
      worktree: '',
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['queue'], { HOME: homeDir });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.tasks.length, 1);
    assert.equal(output.tasks[0].id, 'pending-task');
    assert.equal(output.tasks[0].nextAction, 'start when a concurrency slot is available');
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('doctor command returns preflight JSON', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-repo-'));

  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
    const result = runCli(['doctor', '--repo', repoDir], { HOME: homeDir });
    const output = JSON.parse(result.stdout);

    assert.equal(output.repoPath, repoDir);
    assert.equal(output.backend, 'cli');
    assert.ok(Array.isArray(output.checks));
    assert.ok(output.checks.some((check) => check.name === 'repo'));
    assert.ok(output.checks.some((check) => check.name === 'manager'));
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('manager-status command reports persisted manager heartbeat', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-manager-status-home-'));
  const managerDir = path.join(homeDir, '.ralph', 'manager');

  try {
    fs.mkdirSync(managerDir, { recursive: true });
    fs.writeFileSync(path.join(managerDir, 'state.json'), JSON.stringify({
      pid: process.pid,
      status: 'running',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      pollIntervalMs: 10000,
      autoIngestEnabled: false,
      repo: '/tmp/repo',
      agent: 'codex',
      backend: 'cli',
      hostname: 'test-host',
      argv: ['ralph', 'manager'],
    }, null, 2));

    const result = runCli(['manager-status'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.ok, true);
    assert.equal(output.active, true);
    assert.equal(output.state.agent, 'codex');
    assert.equal(output.state.backend, 'cli');
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('manager-install dry-run resolves launchd manager config without writing plist', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-manager-install-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-manager-install-repo-'));
  const plistPath = path.join(homeDir, 'LaunchAgents', 'com.test.ralph.manager.plist');

  try {
    const result = runCli([
      'manager-install',
      '--dry-run',
      '--label',
      'com.test.ralph.manager',
      '--plist',
      plistPath,
      '--repo',
      repoDir,
      '--interval',
      '12345',
      '--disable-auto-ingest-ez4ielts',
    ], { HOME: homeDir });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.dryRun, true);
    assert.equal(output.loaded, false);
    assert.equal(output.label, 'com.test.ralph.manager');
    assert.equal(output.plistPath, plistPath);
    assert.deepEqual(output.managerArgs.slice(0, 5), [
      'manager',
      '--interval',
      '12345',
      '--repo',
      repoDir,
    ]);
    assert.ok(output.managerArgs.includes('--disable-auto-ingest-ez4ielts'));
    assert.equal(fs.existsSync(plistPath), false);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('doctor command respects configured codex CLI path', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-path-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-path-repo-'));
  const fakeCodex = path.join(homeDir, 'bin', 'fake-codex');

  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
    fs.mkdirSync(path.dirname(fakeCodex), { recursive: true });
    fs.writeFileSync(fakeCodex, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(fakeCodex, 0o755);
    fs.mkdirSync(path.join(homeDir, '.ralph'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.ralph', 'config.json'), JSON.stringify({
      agent: {
        path: fakeCodex,
      },
    }));

    const result = runCli(['doctor', '--repo', repoDir], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const codexCheck = output.checks.find((check) => check.name === 'codex');

    assert.equal(result.status, 0, result.stderr);
    assert.equal(codexCheck.ok, true);
    assert.match(codexCheck.message, /fake-codex is available/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('doctor command treats dirty repos as ok with integration worktree mode', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-integration-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-integration-repo-'));
  const fakeCodex = path.join(homeDir, 'bin', 'fake-codex');

  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Ralph Test'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'ralph@example.com'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repoDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(repoDir, 'dirty.txt'), 'dirty\n');

    fs.mkdirSync(path.dirname(fakeCodex), { recursive: true });
    fs.writeFileSync(fakeCodex, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(fakeCodex, 0o755);
    fs.mkdirSync(path.join(homeDir, '.ralph'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.ralph', 'config.json'), JSON.stringify({
      agent: {
        path: fakeCodex,
      },
      merge: {
        useIntegrationWorktree: true,
      },
    }));

    const result = runCli(['doctor', '--repo', repoDir], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const cleanCheck = output.checks.find((check) => check.name === 'repo.clean');

    assert.equal(result.status, 0, result.stderr);
    assert.equal(cleanCheck.ok, true);
    assert.match(cleanCheck.message, /integration worktree mode/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('cleanup command dry-runs old terminal worktrees', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-cleanup-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-cleanup-repo-'));
  const worktreePath = path.join(repoDir, '.ralph-worktrees', 'completed-task');

  try {
    fs.mkdirSync(worktreePath, { recursive: true });
    const taskDir = path.join(homeDir, '.ralph', 'tasks', 'completed-task');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: 'completed-task',
      prdPath: '/tmp/prd.json',
      status: 'completed',
      startTime: 1,
      endTime: 1,
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 1,
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['cleanup', '--older-than-hours', '0', '--dry-run'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.dryRun, true);
    assert.equal(output.candidates.length, 1);
    assert.equal(output.candidates[0].removed, false);
    assert.equal(fs.existsSync(worktreePath), true);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
