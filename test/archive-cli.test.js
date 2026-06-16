const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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

function writeTask(homeDir, taskId, overrides = {}) {
  const taskDir = path.join(homeDir, '.ralph', 'tasks', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
    id: taskId,
    prdPath: '/tmp/archive-prd.json',
    prdId: 'archive-prd',
    prdDependencies: [],
    status: 'failed',
    startTime: Date.now(),
    endTime: Date.now(),
    completedUS: [],
    storyProgress: [],
    worktree: '',
    logPath: path.join(taskDir, 'agent.log'),
    eventLogPath: path.join(taskDir, 'events.jsonl'),
    agent: 'codex',
    repoPath: '/tmp/repo',
    loopCount: 0,
    consecutiveNoProgress: 0,
    consecutiveErrors: 0,
    lastProgressTime: Date.now(),
    lastFilesChanged: 0,
    lastError: 'fatal: not a git repository',
    ...overrides,
  }, null, 2));
  return taskDir;
}

test('archive marks a failed task as archived and removes queue diagnostics blocker', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-archive-home-'));
  const taskId = 'failed-duplicate-task';

  try {
    const taskDir = writeTask(homeDir, taskId);

    const beforeQueue = runCli(['queue'], { HOME: homeDir });
    assert.equal(beforeQueue.status, 0, beforeQueue.stderr);
    const beforeOutput = JSON.parse(beforeQueue.stdout);
    assert.equal(beforeOutput.actionability.status, 'diagnostics');
    assert.equal(beforeOutput.actionability.principalBlocker, taskId);

    const archiveResult = runCli([
      'archive',
      taskId,
      '--reason',
      'duplicate task superseded by completed retry',
    ], { HOME: homeDir });
    assert.equal(archiveResult.status, 0, archiveResult.stderr);
    const archiveOutput = JSON.parse(archiveResult.stdout);
    assert.equal(archiveOutput.success, true);
    assert.equal(archiveOutput.previousStatus, 'failed');
    assert.equal(archiveOutput.currentStatus, 'archived');

    const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf-8'));
    assert.equal(state.status, 'archived');
    assert.equal(state.archivedFromStatus, 'failed');
    assert.equal(state.archivedReason, 'duplicate task superseded by completed retry');
    assert.ok(state.archivedAt);

    const events = fs.readFileSync(path.join(taskDir, 'events.jsonl'), 'utf-8');
    assert.match(events, /task_archived/);

    const afterQueue = runCli(['queue'], { HOME: homeDir });
    assert.equal(afterQueue.status, 0, afterQueue.stderr);
    const afterOutput = JSON.parse(afterQueue.stdout);
    assert.notEqual(afterOutput.actionability.status, 'diagnostics');
    assert.equal(afterOutput.summary.diagnostics, 0);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('archive refuses non-terminal active task states', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-archive-refuse-home-'));
  const taskId = 'running-task';

  try {
    writeTask(homeDir, taskId, {
      status: 'running',
      pid: process.pid,
      worktree: '/tmp/running-worktree',
    });

    const result = runCli(['archive', taskId], { HOME: homeDir });
    assert.notEqual(result.status, 0);
    const output = JSON.parse(result.stderr);
    assert.match(output.error, /Cannot archive task with status 'running'/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
