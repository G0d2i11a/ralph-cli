const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  mergeBranch,
  probeTaskMergeability,
  probeTaskWorktreeMergeability,
  syncTargetBranchIfSafe,
} = require('../dist/core/merge.js');

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitWithEnv(args, cwd, env) {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, ...env },
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
    fs.mkdirSync(path.join(repoDir, '.ralph-cli-home'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, '.ralph-cli-home', 'state.json'), '{}\n');

    const result = await mergeBranch(task, 'main', 'manual', { pullLatest: false });

    assert.equal(result.success, true, result.message);
    assert.equal(result.integrationBranch, 'ralph/integration/main');
    assert.equal(result.targetSynced, false);
    assert.match(result.targetSyncMessage, /sync deferred/);
    assert.match(result.targetSyncMessage, /\?\? dirty\.txt/);
    assert.doesNotMatch(result.targetSyncMessage, /\.ralph-cli-home/);
    assert.equal(git(['rev-parse', 'main'], repoDir), originalMain);
    assert.match(git(['show', 'ralph/integration/main:feature.txt'], repoDir), /task change/);
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir), 'main');
    assert.equal(fs.readFileSync(path.join(repoDir, 'dirty.txt'), 'utf-8'), 'dirty\n');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('mergeBranch ignores Ralph operational artifacts when syncing clean target checkout', async () => {
  const repoDir = createRepo();

  try {
    const task = createTask(repoDir, 'task-sync-target-with-ralph-artifacts');
    fs.mkdirSync(path.join(repoDir, '.ralph-cli-home', 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, '.ralph-cli-home', 'state.json'), '{}\n');
    fs.mkdirSync(path.join(repoDir, '.ralph', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, '.ralph', 'logs', 'manager.log'), 'log\n');
    fs.mkdirSync(path.join(repoDir, '.turbo'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, '.turbo', 'turbo.log'), 'cache\n');

    const result = await mergeBranch(task, 'main', 'manual', { pullLatest: false });

    assert.equal(result.success, true, result.message);
    assert.equal(result.targetSynced, true);
    assert.match(git(['show', 'main:feature.txt'], repoDir), /task change/);
    assert.equal(fs.readFileSync(path.join(repoDir, '.ralph-cli-home', 'state.json'), 'utf-8'), '{}\n');
    assert.equal(fs.readFileSync(path.join(repoDir, '.ralph', 'logs', 'manager.log'), 'utf-8'), 'log\n');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('mergeBranch keeps real dirty paths with spaces as target sync blockers', async () => {
  const repoDir = createRepo();

  try {
    const task = createTask(repoDir, 'task-sync-target-real-space-dirty');
    fs.writeFileSync(path.join(repoDir, 'real dirty file.txt'), 'dirty\n');
    fs.mkdirSync(path.join(repoDir, '.ralph-cli-home', 'path with spaces'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, '.ralph-cli-home', 'path with spaces', 'state.json'), '{}\n');

    const result = await mergeBranch(task, 'main', 'manual', { pullLatest: false });

    assert.equal(result.success, true, result.message);
    assert.equal(result.targetSynced, false);
    assert.match(result.targetSyncMessage, /sync deferred/);
    assert.match(result.targetSyncMessage, /real dirty file\.txt/);
    assert.doesNotMatch(result.targetSyncMessage, /\.ralph-cli-home/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('syncTargetBranchIfSafe marks dirty checkout synced when target already contains commit', () => {
  const repoDir = createRepo();

  try {
    const commitSha = git(['rev-parse', 'main'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'dirty.txt'), 'dirty\n');

    const result = syncTargetBranchIfSafe(repoDir, 'main', commitSha);

    assert.equal(result.synced, true);
    assert.match(result.message, /main already contains/);
    assert.equal(fs.readFileSync(path.join(repoDir, 'dirty.txt'), 'utf-8'), 'dirty\n');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('mergeBranch blocks target sync on mixed real and operational renames', async () => {
  const repoDir = createRepo();

  try {
    const task = createTask(repoDir, 'task-sync-target-rename-dirty');
    fs.writeFileSync(path.join(repoDir, 'rename-source.txt'), 'tracked\n');
    git(['add', 'rename-source.txt'], repoDir);
    git(['commit', '-m', 'chore: add rename source'], repoDir);
    fs.mkdirSync(path.join(repoDir, '.ralph-cli-home'), { recursive: true });
    git(['mv', 'rename-source.txt', '.ralph-cli-home/rename-source.txt'], repoDir);

    const result = await mergeBranch(task, 'main', 'manual', { pullLatest: false });

    assert.equal(result.success, true, result.message);
    assert.equal(result.targetSynced, false);
    assert.match(result.targetSyncMessage, /sync deferred/);
    assert.match(result.targetSyncMessage, /rename-source\.txt/);
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

test('syncTargetBranchIfSafe fast-forwards an unchecked-out target ref', () => {
  const repoDir = createRepo();

  try {
    git(['checkout', '-b', 'integration'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'integrated.txt'), 'integrated\n');
    git(['add', 'integrated.txt'], repoDir);
    git(['commit', '-m', 'feat: integrated'], repoDir);
    const integrationSha = git(['rev-parse', 'HEAD'], repoDir);
    git(['checkout', '-b', 'operator'], repoDir);

    const result = syncTargetBranchIfSafe(repoDir, 'main', integrationSha);

    assert.equal(result.synced, true, result.message);
    assert.match(result.message, /main updated/);
    assert.equal(git(['rev-parse', 'main'], repoDir), integrationSha);
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir), 'operator');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('syncTargetBranchIfSafe refuses non-fast-forward unchecked-out target ref updates', () => {
  const repoDir = createRepo();

  try {
    git(['checkout', '-b', 'integration'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'integrated.txt'), 'integrated\n');
    git(['add', 'integrated.txt'], repoDir);
    git(['commit', '-m', 'feat: integrated'], repoDir);
    const integrationSha = git(['rev-parse', 'HEAD'], repoDir);

    git(['checkout', 'main'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'main-only.txt'), 'main\n');
    git(['add', 'main-only.txt'], repoDir);
    git(['commit', '-m', 'feat: main only'], repoDir);
    const mainSha = git(['rev-parse', 'main'], repoDir);
    git(['checkout', '-b', 'operator'], repoDir);

    const result = syncTargetBranchIfSafe(repoDir, 'main', integrationSha);

    assert.equal(result.synced, false);
    assert.match(result.message, /not an ancestor/);
    assert.equal(git(['rev-parse', 'main'], repoDir), mainSha);
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir), 'operator');
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

test('probeTaskMergeability confirms a clean merge and leaves the integration worktree clean', async () => {
  const repoDir = createRepo();

  try {
    const task = createTask(repoDir, 'task-probe-clean');

    const result = await probeTaskMergeability(task, 'main', { pullLatest: false });

    assert.equal(result.mergeable, true, result.message);
    assert.equal(result.alreadyIntegrated, false);
    assert.equal(result.integrationBranch, 'ralph/integration/main');
    assert.equal(git(['status', '--porcelain'], result.integrationWorktree), '');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('probeTaskMergeability reports exact conflicts and leaves the integration worktree clean', async () => {
  const repoDir = createRepo();

  try {
    const worktreePath = path.join(repoDir, '.ralph-worktrees', 'task-probe-conflict');
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(['worktree', 'add', '-b', 'ralph/task-probe-conflict', worktreePath, 'main'], repoDir);
    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'task side\n');
    git(['add', 'feature.txt'], worktreePath);
    git(['commit', '-m', 'feat: task side'], worktreePath);

    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'main side\n');
    git(['add', 'feature.txt'], repoDir);
    git(['commit', '-m', 'feat: main side'], repoDir);

    const task = {
      id: 'task-probe-conflict',
      prdPath: path.join(repoDir, 'prd.json'),
      status: 'completed',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(repoDir, '.ralph', 'tasks', 'task-probe-conflict', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      baseCommitSha: git(['rev-parse', 'main~1'], repoDir),
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 1,
    };

    const result = await probeTaskMergeability(task, 'main', { pullLatest: false });

    assert.equal(result.mergeable, false);
    assert.equal(result.alreadyIntegrated, false);
    assert.deepEqual(result.conflictFiles, ['feature.txt']);
    assert.match(result.message, /Merge conflicts detected/);
    assert.equal(git(['status', '--porcelain'], result.integrationWorktree), '');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('probeTaskWorktreeMergeability labels integration branch sync conflicts separately', async () => {
  const repoDir = createRepo();

  try {
    git(['branch', 'ralph/integration/main', 'main'], repoDir);
    const integrationWorktree = path.join(repoDir, '.ralph-integration', 'main');
    fs.mkdirSync(path.dirname(integrationWorktree), { recursive: true });
    git(['worktree', 'add', integrationWorktree, 'ralph/integration/main'], repoDir);
    fs.writeFileSync(path.join(integrationWorktree, 'feature.txt'), 'integration side\n');
    git(['add', 'feature.txt'], integrationWorktree);
    git(['commit', '-m', 'feat: integration side'], integrationWorktree);

    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'main side\n');
    git(['add', 'feature.txt'], repoDir);
    git(['commit', '-m', 'feat: main side'], repoDir);

    const worktreePath = path.join(repoDir, '.ralph-worktrees', 'task-probe-sync-conflict');
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(['worktree', 'add', '-b', 'ralph/task-probe-sync-conflict', worktreePath, 'main'], repoDir);
    fs.writeFileSync(path.join(worktreePath, 'task.txt'), 'task side\n');
    git(['add', 'task.txt'], worktreePath);
    git(['commit', '-m', 'feat: task side'], worktreePath);

    const task = {
      id: 'task-probe-sync-conflict',
      prdPath: path.join(repoDir, 'prd.json'),
      status: 'running',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(repoDir, '.ralph', 'tasks', 'task-probe-sync-conflict', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      baseCommitSha: git(['rev-parse', 'main'], repoDir),
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 1,
    };

    const result = await probeTaskWorktreeMergeability(task, 'main', { pullLatest: false });

    assert.equal(result.mergeable, false);
    assert.equal(result.alreadyIntegrated, false);
    assert.equal(result.failurePhase, 'integration_sync');
    assert.deepEqual(result.conflictFiles, ['feature.txt']);
    assert.match(result.message, /Integration branch sync failed/);
    assert.equal(git(['status', '--porcelain'], result.integrationWorktree), '');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('probeTaskWorktreeMergeability includes uncommitted worktree changes instead of stale branch HEAD', async () => {
  const repoDir = createRepo();

  try {
    const worktreePath = path.join(repoDir, '.ralph-worktrees', 'task-probe-worktree');
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(['worktree', 'add', '-b', 'ralph/task-probe-worktree', worktreePath, 'main'], repoDir);

    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'task side\n');
    fs.writeFileSync(path.join(repoDir, 'other.txt'), 'main side\n');
    git(['add', 'other.txt'], repoDir);
    git(['commit', '-m', 'feat: main side'], repoDir);

    const task = {
      id: 'task-probe-worktree',
      prdPath: path.join(repoDir, 'prd.json'),
      status: 'running',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(repoDir, '.ralph', 'tasks', 'task-probe-worktree', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      baseCommitSha: git(['rev-parse', 'main~1'], repoDir),
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 1,
    };

    const branchProbe = await probeTaskMergeability(task, 'main', { pullLatest: false });
    const worktreeProbe = await probeTaskWorktreeMergeability(task, 'main', { pullLatest: false });

    assert.equal(branchProbe.alreadyIntegrated, true);
    assert.equal(worktreeProbe.alreadyIntegrated, false);
    assert.equal(worktreeProbe.mergeable, true, worktreeProbe.message);
    assert.match(worktreeProbe.message, /worktree snapshot/);
    assert.equal(worktreeProbe.sourceKind, 'worktree_snapshot');
    assert.equal(worktreeProbe.worktreeMergeState.kind, 'none');
    assert.equal(git(['status', '--porcelain'], worktreeProbe.integrationWorktree), '');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('probeTaskWorktreeMergeability ignores Ralph probe/admin helper paths', async () => {
  const repoDir = createRepo();

  try {
    const worktreePath = path.join(repoDir, '.ralph-worktrees', 'task-probe-internal-paths');
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(['worktree', 'add', '-b', 'ralph/task-probe-internal-paths', worktreePath, 'main'], repoDir);

    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'task side\n');
    fs.mkdirSync(path.join(worktreePath, '.ralph-integration-probe'), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, '.ralph-integration-probe', 'main'), 'probe state\n');
    fs.mkdirSync(path.join(worktreePath, '.git-local-admin'), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, '.git-local-admin', 'index'), 'admin state\n');
    fs.mkdirSync(path.join(worktreePath, '.git-local-objects', 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, '.git-local-objects', 'tmp', 'pack'), 'object state\n');

    const task = {
      id: 'task-probe-internal-paths',
      prdPath: path.join(repoDir, 'prd.json'),
      status: 'running',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(repoDir, '.ralph', 'tasks', 'task-probe-internal-paths', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      baseCommitSha: git(['rev-parse', 'main'], repoDir),
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 1,
    };

    const result = await probeTaskWorktreeMergeability(task, 'main', { pullLatest: false });

    assert.equal(result.mergeable, true, result.message);
    assert.equal(result.alreadyIntegrated, false);
    assert.match(result.message, /worktree snapshot/);
    assert.equal(result.sourceKind, 'worktree_snapshot');
    assert.equal(git(['status', '--porcelain'], result.integrationWorktree), '');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('mergeBranch excludes tracked turbo cache artifacts from integration proof', async () => {
  const repoDir = createRepo();

  try {
    fs.writeFileSync(path.join(repoDir, '.gitignore'), '**/.turbo\n');
    git(['add', '.gitignore'], repoDir);
    git(['commit', '-m', 'chore: ignore turbo cache'], repoDir);

    const worktreePath = path.join(repoDir, '.ralph-worktrees', 'task-probe-turbo-cache');
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(['worktree', 'add', '-b', 'ralph/task-probe-turbo-cache', worktreePath, 'main'], repoDir);

    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'base\ntask side\n');
    fs.mkdirSync(path.join(worktreePath, 'packages', 'control-plane', '.turbo'), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, 'packages', 'control-plane', '.turbo', 'turbo-test.log'), 'cache\n');
    git(['add', 'feature.txt'], worktreePath);
    git(['add', '-f', 'packages/control-plane/.turbo/turbo-test.log'], worktreePath);
    git(['commit', '-m', 'feat: task side with cache artifact'], worktreePath);

    fs.writeFileSync(path.join(repoDir, 'other.txt'), 'main side\n');
    git(['add', 'other.txt'], repoDir);
    git(['commit', '-m', 'feat: main side'], repoDir);

    const task = {
      id: 'task-probe-turbo-cache',
      prdPath: path.join(repoDir, 'prd.json'),
      status: 'running',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(repoDir, '.ralph', 'tasks', 'task-probe-turbo-cache', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      baseCommitSha: git(['rev-parse', 'main~1'], repoDir),
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 1,
    };

    const probeResult = await probeTaskWorktreeMergeability(task, 'main', { pullLatest: false });
    assert.equal(probeResult.mergeable, true, probeResult.message);

    const mergeResult = await mergeBranch(task, 'main', 'manual', { pullLatest: false });
    assert.equal(mergeResult.success, true, mergeResult.message);
    assert.match(git(['show', 'main:feature.txt'], repoDir), /task side/);
    assert.throws(
      () => git(['cat-file', '-e', 'main:packages/control-plane/.turbo/turbo-test.log'], repoDir)
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('mergeBranch is idempotent for sanitized branch heads after deferred target sync', async () => {
  const repoDir = createRepo();

  try {
    fs.writeFileSync(path.join(repoDir, '.gitignore'), '**/.turbo\n');
    git(['add', '.gitignore'], repoDir);
    git(['commit', '-m', 'chore: ignore turbo cache'], repoDir);

    const worktreePath = path.join(repoDir, '.ralph-worktrees', 'task-sanitized-idempotent');
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(['worktree', 'add', '-b', 'ralph/task-sanitized-idempotent', worktreePath, 'main'], repoDir);

    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'base\ntask side\n');
    fs.mkdirSync(path.join(worktreePath, 'packages', 'control-plane', '.turbo'), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, 'packages', 'control-plane', '.turbo', 'turbo-test.log'), 'cache\n');
    git(['add', 'feature.txt'], worktreePath);
    git(['add', '-f', 'packages/control-plane/.turbo/turbo-test.log'], worktreePath);
    git(['commit', '-m', 'feat: task side with cache artifact'], worktreePath);

    fs.writeFileSync(path.join(repoDir, 'dirty.txt'), 'dirty\n');

    const task = {
      id: 'task-sanitized-idempotent',
      prdPath: path.join(repoDir, 'prd.json'),
      status: 'running',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(repoDir, '.ralph', 'tasks', 'task-sanitized-idempotent', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      baseCommitSha: git(['rev-parse', 'main'], repoDir),
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 1,
    };

    const first = await mergeBranch(task, 'main', 'manual', { pullLatest: false });
    assert.equal(first.success, true, first.message);
    assert.equal(first.targetSynced, false);
    const integrationHead = git(['rev-parse', 'ralph/integration/main'], repoDir);

    const second = await mergeBranch(task, 'main', 'manual', { pullLatest: false });
    assert.equal(second.success, true, second.message);
    assert.equal(second.alreadyMerged, true);
    assert.equal(git(['rev-parse', 'ralph/integration/main'], repoDir), integrationHead);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('mergeBranch reports target sync failure without failing completed integration', async () => {
  const repoDir = createRepo();

  try {
    const task = createTask(repoDir, 'task-target-sync-failure');
    fs.writeFileSync(path.join(repoDir, '.git', 'index.lock'), 'locked\n');

    const result = await mergeBranch(task, 'main', 'manual', { pullLatest: false });

    assert.equal(result.success, true, result.message);
    assert.equal(result.targetSynced, false);
    assert.match(result.targetSyncMessage, /target sync failed after integration/);
    assert.match(git(['show', 'ralph/integration/main:feature.txt'], repoDir), /task change/);
    assert.doesNotMatch(git(['show', 'main:feature.txt'], repoDir), /task change/);
  } finally {
    fs.rmSync(path.join(repoDir, '.git', 'index.lock'), { force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('probeTaskWorktreeMergeability honors .git-local merge state when conflicts are already resolved there', async () => {
  const repoDir = createRepo();

  try {
    const worktreePath = path.join(repoDir, '.ralph-worktrees', 'task-probe-git-local-merge');
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(['worktree', 'add', '-b', 'ralph/task-probe-git-local-merge', worktreePath, 'main'], repoDir);

    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'task side\n');
    git(['add', 'feature.txt'], worktreePath);
    git(['commit', '-m', 'feat: task side'], worktreePath);

    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'main side\n');
    git(['add', 'feature.txt'], repoDir);
    git(['commit', '-m', 'feat: main side'], repoDir);

    const actualGitDir = git(['rev-parse', '--path-format=absolute', '--git-dir'], worktreePath);
    const localGitDir = path.join(worktreePath, '.git-local');
    fs.symlinkSync(actualGitDir, localGitDir, 'dir');
    const localEnv = {
      GIT_DIR: localGitDir,
      GIT_WORK_TREE: worktreePath,
    };

    try {
      gitWithEnv(['merge', 'main'], worktreePath, localEnv);
    } catch {
      // expected conflict
    }

    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'task side\nmain side\n');
    gitWithEnv(['add', 'feature.txt'], worktreePath, localEnv);

    const task = {
      id: 'task-probe-git-local-merge',
      prdPath: path.join(repoDir, 'prd.json'),
      status: 'running',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(repoDir, '.ralph', 'tasks', 'task-probe-git-local-merge', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      baseCommitSha: git(['rev-parse', 'main~1'], repoDir),
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 1,
    };

    const result = await probeTaskWorktreeMergeability(task, 'main', { pullLatest: false });

    assert.equal(result.mergeable, true, result.message);
    assert.equal(result.alreadyIntegrated, false);
    assert.match(result.message, /Resolved pending merge/);
    assert.equal(result.sourceKind, 'resolved_pending_merge');
    assert.equal(result.worktreeMergeState.kind, 'resolved_pending_commit');
    assert.deepEqual(result.worktreeMergeState.unmergedFiles, []);
    assert.equal(gitWithEnv(['diff', '--name-only', '--diff-filter=U'], worktreePath, localEnv), '');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('probeTaskWorktreeMergeability can probe private .git-local commits not present in the main object store', async () => {
  const repoDir = createRepo();

  try {
    const worktreePath = path.join(repoDir, '.ralph-worktrees', 'task-probe-private-git-local');
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(['worktree', 'add', '-b', 'ralph/task-probe-private-git-local', worktreePath, 'main'], repoDir);

    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'task side\n');
    git(['add', 'feature.txt'], worktreePath);
    git(['commit', '-m', 'feat: task side'], worktreePath);

    const localGitDir = path.join(worktreePath, '.git-local');
    git(['init', '--bare', localGitDir], repoDir);
    const localEnv = {
      GIT_DIR: localGitDir,
      GIT_WORK_TREE: worktreePath,
    };
    gitWithEnv(['config', 'user.name', 'Ralph Test'], worktreePath, localEnv);
    gitWithEnv(['config', 'user.email', 'ralph@example.com'], worktreePath, localEnv);
    gitWithEnv(
      ['fetch', repoDir, 'ralph/task-probe-private-git-local:refs/heads/ralph/task-probe-private-git-local'],
      worktreePath,
      localEnv
    );
    gitWithEnv(['symbolic-ref', 'HEAD', 'refs/heads/ralph/task-probe-private-git-local'], worktreePath, localEnv);
    gitWithEnv(['reset', '--hard'], worktreePath, localEnv);

    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'task side\nprivate finalizer\n');
    gitWithEnv(['add', 'feature.txt'], worktreePath, localEnv);
    gitWithEnv(['commit', '-m', 'feat: private local finalizer'], worktreePath, localEnv);
    const privateHead = gitWithEnv(['rev-parse', 'HEAD'], worktreePath, localEnv);

    assert.throws(() => git(['cat-file', '-t', privateHead], repoDir), /could not get object info|Not a valid object/);
    assert.equal(gitWithEnv(['cat-file', '-t', privateHead], worktreePath, localEnv), 'commit');

    fs.writeFileSync(path.join(repoDir, 'other.txt'), 'main side\n');
    git(['add', 'other.txt'], repoDir);
    git(['commit', '-m', 'feat: main side'], repoDir);

    const task = {
      id: 'task-probe-private-git-local',
      prdPath: path.join(repoDir, 'prd.json'),
      status: 'running',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(repoDir, '.ralph', 'tasks', 'task-probe-private-git-local', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      baseCommitSha: git(['rev-parse', 'main~1'], repoDir),
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 1,
    };

    const result = await probeTaskWorktreeMergeability(task, 'main', { pullLatest: false });

    assert.equal(result.mergeable, true, result.message);
    assert.equal(result.alreadyIntegrated, false);
    assert.equal(result.sourceKind, 'worktree_snapshot');
    assert.match(result.message, /local head/);
    assert.equal(git(['cat-file', '-t', privateHead], repoDir), 'commit');
    assert.equal(git(['status', '--porcelain'], result.integrationWorktree), '');

    const mergeResult = await mergeBranch(task, 'main', 'manual', { pullLatest: false });
    assert.equal(mergeResult.success, true, mergeResult.message);
    assert.match(git(['show', 'main:feature.txt'], repoDir), /private finalizer/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('probeTaskWorktreeMergeability rejects unresolved .git-local merges before requeueing the agent', async () => {
  const repoDir = createRepo();

  try {
    const worktreePath = path.join(repoDir, '.ralph-worktrees', 'task-probe-git-local-unresolved');
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(['worktree', 'add', '-b', 'ralph/task-probe-git-local-unresolved', worktreePath, 'main'], repoDir);

    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'task side\n');
    git(['add', 'feature.txt'], worktreePath);
    git(['commit', '-m', 'feat: task side'], worktreePath);

    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'main side\n');
    git(['add', 'feature.txt'], repoDir);
    git(['commit', '-m', 'feat: main side'], repoDir);

    const actualGitDir = git(['rev-parse', '--path-format=absolute', '--git-dir'], worktreePath);
    const localGitDir = path.join(worktreePath, '.git-local');
    fs.symlinkSync(actualGitDir, localGitDir, 'dir');
    const localEnv = {
      GIT_DIR: localGitDir,
      GIT_WORK_TREE: worktreePath,
    };

    try {
      gitWithEnv(['merge', 'main'], worktreePath, localEnv);
    } catch {
      // expected conflict
    }

    const task = {
      id: 'task-probe-git-local-unresolved',
      prdPath: path.join(repoDir, 'prd.json'),
      status: 'running',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(repoDir, '.ralph', 'tasks', 'task-probe-git-local-unresolved', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      baseCommitSha: git(['rev-parse', 'main~1'], repoDir),
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 1,
    };

    const result = await probeTaskWorktreeMergeability(task, 'main', { pullLatest: false });

    assert.equal(result.mergeable, false);
    assert.equal(result.alreadyIntegrated, false);
    assert.equal(result.sourceKind, 'worktree_snapshot');
    assert.equal(result.worktreeMergeState.kind, 'unresolved');
    assert.deepEqual(result.conflictFiles, ['feature.txt']);
    assert.match(result.message, /unresolved merge entries/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('probeTaskWorktreeMergeability preserves MERGE_HEAD even when the resolved merge matches HEAD tree', async () => {
  const repoDir = createRepo();

  try {
    const worktreePath = path.join(repoDir, '.ralph-worktrees', 'task-probe-git-local-no-diff-merge');
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(['worktree', 'add', '-b', 'ralph/task-probe-git-local-no-diff-merge', worktreePath, 'main'], repoDir);

    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'task side\n');
    git(['add', 'feature.txt'], worktreePath);
    git(['commit', '-m', 'feat: task side'], worktreePath);

    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'main side\n');
    git(['add', 'feature.txt'], repoDir);
    git(['commit', '-m', 'feat: main side'], repoDir);

    const actualGitDir = git(['rev-parse', '--path-format=absolute', '--git-dir'], worktreePath);
    const localGitDir = path.join(worktreePath, '.git-local');
    fs.symlinkSync(actualGitDir, localGitDir, 'dir');
    const localEnv = {
      GIT_DIR: localGitDir,
      GIT_WORK_TREE: worktreePath,
    };

    try {
      gitWithEnv(['merge', 'main'], worktreePath, localEnv);
    } catch {
      // expected conflict
    }

    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'task side\n');
    gitWithEnv(['add', 'feature.txt'], worktreePath, localEnv);

    const task = {
      id: 'task-probe-git-local-no-diff-merge',
      prdPath: path.join(repoDir, 'prd.json'),
      status: 'running',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(repoDir, '.ralph', 'tasks', 'task-probe-git-local-no-diff-merge', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      baseCommitSha: git(['rev-parse', 'main~1'], repoDir),
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 1,
    };

    const result = await probeTaskWorktreeMergeability(task, 'main', { pullLatest: false });

    assert.equal(result.mergeable, true, result.message);
    assert.equal(result.sourceKind, 'resolved_pending_merge');
    assert.equal(result.worktreeMergeState.kind, 'resolved_pending_commit');
    assert.equal(result.worktreeMergeState.changedFiles.length, 0);
    assert.match(result.message, /Resolved pending merge/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
