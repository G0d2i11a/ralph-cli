const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { mergeBranch } = require('../dist/core/merge.js');

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-merge-repo-'));
  git(['init', '-b', 'main'], repoDir);
  git(['config', 'user.name', 'Ralph Test'], repoDir);
  git(['config', 'user.email', 'ralph@example.com'], repoDir);
  fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'base\n');
  git(['add', '.'], repoDir);
  git(['commit', '-m', 'base'], repoDir);
  return repoDir;
}

function createTask(repoDir, taskId = 'task-merge') {
  const worktreePath = path.join(repoDir, '.ralph-worktrees', taskId);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(['worktree', 'add', '-b', `ralph/${taskId}`, worktreePath, 'main'], repoDir);
  fs.appendFileSync(path.join(worktreePath, 'feature.txt'), 'task change\n');
  git(['add', 'feature.txt'], worktreePath);
  git(['commit', '-m', 'feat: task change'], worktreePath);

  return {
    id: taskId,
    prdPath: path.join(repoDir, 'prd.json'),
    status: 'completed',
    startTime: Date.now(),
    completedUS: [],
    worktree: worktreePath,
    logPath: path.join(repoDir, '.ralph', 'tasks', taskId, 'agent.log'),
    agent: 'codex',
    repoPath: repoDir,
    loopCount: 0,
    consecutiveNoProgress: 0,
    consecutiveErrors: 0,
    lastProgressTime: Date.now(),
    lastFilesChanged: 1,
  };
}

test('mergeBranch integrates through dedicated worktree when live checkout is dirty', async () => {
  const repoDir = createRepo();

  try {
    const task = createTask(repoDir);
    const originalMain = git(['rev-parse', 'main'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'dirty.txt'), 'dirty\n');

    const result = await mergeBranch(task, 'main', 'manual', { pullLatest: false });

    assert.equal(result.success, true, result.message);
    assert.equal(result.integrationBranch, 'ralph/integration/main');
    assert.equal(result.targetSynced, false);
    assert.match(result.targetSyncMessage, /sync deferred/);
    assert.match(result.targetSyncMessage, /\?\? dirty\.txt/);
    assert.equal(git(['rev-parse', 'main'], repoDir), originalMain);
    assert.match(git(['show', 'ralph/integration/main:feature.txt'], repoDir), /task change/);
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir), 'main');
    assert.equal(fs.readFileSync(path.join(repoDir, 'dirty.txt'), 'utf-8'), 'dirty\n');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('mergeBranch fast-forwards clean target checkout after integration merge', async () => {
  const repoDir = createRepo();

  try {
    const task = createTask(repoDir, 'task-sync-target');

    const result = await mergeBranch(task, 'main', 'manual', { pullLatest: false });

    assert.equal(result.success, true, result.message);
    assert.equal(result.targetSynced, true);
    assert.match(git(['show', 'main:feature.txt'], repoDir), /task change/);
    assert.match(fs.readFileSync(path.join(repoDir, 'feature.txt'), 'utf-8'), /task change/);
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir), 'main');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('mergeBranch restores the original branch after a successful merge', async () => {
  const repoDir = createRepo();

  try {
    const task = createTask(repoDir, 'task-restore-branch');
    git(['checkout', '-b', 'develop'], repoDir);

    const result = await mergeBranch(task, 'main', 'manual', { pullLatest: false });

    assert.equal(result.success, true, result.message);
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir), 'develop');
    assert.match(git(['show', 'main:feature.txt'], repoDir), /task change/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('mergeBranch can still refuse dirty live checkout when integration worktree is disabled', async () => {
  const repoDir = createRepo();

  try {
    const task = createTask(repoDir, 'task-live-guard');
    fs.writeFileSync(path.join(repoDir, 'dirty.txt'), 'dirty\n');

    const result = await mergeBranch(task, 'main', 'manual', {
      pullLatest: false,
      useIntegrationWorktree: false,
    });

    assert.equal(result.success, false);
    assert.match(result.message, /uncommitted changes/);
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir), 'main');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('mergeBranch reports structured conflicts without updating main', async () => {
  const repoDir = createRepo();

  try {
    const worktreePath = path.join(repoDir, '.ralph-worktrees', 'task-conflict');
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(['worktree', 'add', '-b', 'ralph/task-conflict', worktreePath, 'main'], repoDir);
    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'task side\n');
    git(['add', 'feature.txt'], worktreePath);
    git(['commit', '-m', 'feat: task side'], worktreePath);

    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'main side\n');
    git(['add', 'feature.txt'], repoDir);
    git(['commit', '-m', 'feat: main side'], repoDir);
    const mainBeforeMerge = git(['rev-parse', 'main'], repoDir);

    const task = {
      id: 'task-conflict',
      prdPath: path.join(repoDir, 'prd.json'),
      status: 'completed',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(repoDir, '.ralph', 'tasks', 'task-conflict', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      baseCommitSha: git(['rev-parse', 'main~1'], repoDir),
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 1,
    };

    const result = await mergeBranch(task, 'main', 'manual', { pullLatest: false });

    assert.equal(result.success, false);
    assert.equal(result.hasConflicts, true);
    assert.deepEqual(result.conflictFiles, ['feature.txt']);
    assert.equal(result.integrationBranch, 'ralph/integration/main');
    assert.equal(result.sourceBranch, 'ralph/task-conflict');
    assert.equal(result.targetBranch, 'ralph/integration/main');
    assert.equal(git(['rev-parse', 'main'], repoDir), mainBeforeMerge);
    assert.equal(fs.readFileSync(path.join(repoDir, 'feature.txt'), 'utf-8'), 'main side\n');
    const integrationStatus = git(['status', '--porcelain'], result.integrationWorktree);
    assert.equal(integrationStatus, '');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
