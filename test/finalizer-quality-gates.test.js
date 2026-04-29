const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { finalizeTaskOutput } = require('../dist/core/finalizer.js');

const originalRalphHome = process.env.RALPH_HOME;
let activeRalphHomeRoot;

test.beforeEach(() => {
  activeRalphHomeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalizer-home-'));
  process.env.RALPH_HOME = path.join(activeRalphHomeRoot, '.ralph');
});

test.afterEach(() => {
  if (originalRalphHome === undefined) {
    delete process.env.RALPH_HOME;
  } else {
    process.env.RALPH_HOME = originalRalphHome;
  }

  if (activeRalphHomeRoot) {
    fs.rmSync(activeRalphHomeRoot, { recursive: true, force: true });
    activeRalphHomeRoot = undefined;
  }
});

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
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function prependFakePnpmToPath(rootDir) {
  const binDir = path.join(rootDir, 'fake-bin');
  const pnpmPath = path.join(binDir, 'pnpm');
  const previousPath = process.env.PATH;
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(pnpmPath, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const result = spawnSync('npm', process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
`);
  fs.chmodSync(pnpmPath, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ''}`;

  return () => {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  };
}

test('finalizeTaskOutput runs available quality gates before commit', { concurrency: false }, () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalizer-'));
  const prdPath = path.join(repoDir, 'prd.json');

  try {
    git(['init'], repoDir);
    git(['checkout', '-b', 'main'], repoDir);
    git(['config', 'user.name', 'Ralph Test'], repoDir);
    git(['config', 'user.email', 'ralph@example.com'], repoDir);

    fs.writeFileSync(prdPath, JSON.stringify({
      id: 'prd-1',
      title: 'Quality Gates Task',
      description: 'Run finalize quality gates',
      userStories: [],
      dependencies: [],
    }, null, 2));

    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      scripts: {
        typecheck: `node -e "require('fs').writeFileSync('typecheck.txt','ok')"`,
        lint: `node -e "require('fs').writeFileSync('lint.txt','ok')"`,
        test: `node -e "require('fs').writeFileSync('test.txt','ok')"`,
        build: `node -e "require('fs').writeFileSync('build.txt','ok')"`,
      },
    }, null, 2));
    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'base\n');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'feat: initial'], repoDir);

    const worktreePath = path.join(repoDir, '.ralph-worktrees', 'task-1');
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(['worktree', 'add', '-b', 'ralph/task-1', worktreePath, 'main'], repoDir);

    fs.appendFileSync(path.join(worktreePath, 'feature.txt'), 'change\n');

    const task = {
      id: 'task-1',
      prdPath,
      status: 'ready_to_finalize',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(repoDir, '.ralph', 'tasks', 'task-1', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 1,
    };

    const result = finalizeTaskOutput(task);

    assert.equal(result.success, true);
    assert.equal(result.committed, true);
    assert.match(result.message, /quality gates/);
    assert.equal(fs.existsSync(path.join(worktreePath, 'typecheck.txt')), true);
    assert.equal(fs.existsSync(path.join(worktreePath, 'lint.txt')), true);
    assert.equal(fs.existsSync(path.join(worktreePath, 'test.txt')), true);
    assert.equal(fs.existsSync(path.join(worktreePath, 'build.txt')), true);
    assert.match(git(['log', '--oneline', '-1'], worktreePath), /feat\(ralph\): complete quality gates task/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('finalizeTaskOutput validates existing task commits instead of silently treating them as no-op', { concurrency: false }, () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalizer-existing-'));
  const prdPath = path.join(repoDir, 'prd.json');

  try {
    git(['init'], repoDir);
    git(['checkout', '-b', 'main'], repoDir);
    git(['config', 'user.name', 'Ralph Test'], repoDir);
    git(['config', 'user.email', 'ralph@example.com'], repoDir);

    fs.writeFileSync(prdPath, JSON.stringify({
      id: 'prd-2',
      title: 'Existing Commit Task',
      description: 'Validate direct agent commits',
      userStories: [],
      dependencies: [],
    }, null, 2));

    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      scripts: {
        typecheck: 'node -e ""',
        lint: 'node -e ""',
        test: 'node -e ""',
        build: 'node -e ""',
      },
    }, null, 2));
    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'base\n');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'feat: initial'], repoDir);
    const baseCommitSha = git(['rev-parse', 'HEAD'], repoDir);

    const worktreePath = path.join(repoDir, '.ralph-worktrees', 'task-2');
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(['worktree', 'add', '-b', 'ralph/task-2', worktreePath, 'main'], repoDir);

    fs.appendFileSync(path.join(worktreePath, 'feature.txt'), 'agent-change\n');
    git(['add', 'feature.txt'], worktreePath);
    git(['commit', '-m', 'feat: agent direct commit'], worktreePath);
    const agentCommitSha = git(['rev-parse', 'HEAD'], worktreePath);

    const task = {
      id: 'task-2',
      prdPath,
      status: 'ready_to_finalize',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(repoDir, '.ralph', 'tasks', 'task-2', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      baseCommitSha,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 1,
    };

    const result = finalizeTaskOutput(task);

    assert.equal(result.success, true);
    assert.equal(result.committed, false);
    assert.match(result.message, /Validated existing task commits/);
    assert.equal(result.commitSha, agentCommitSha);
    assert.match(result.commitMessage, /feat: agent direct commit/);
    assert.equal(git(['rev-parse', 'HEAD'], worktreePath), agentCommitSha);
    assert.equal(git(['status', '--porcelain'], worktreePath), '');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('finalizeTaskOutput commits resolved local merges before validating existing commits', { concurrency: false }, () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalizer-local-merge-'));
  const prdPath = path.join(repoDir, 'prd.json');

  try {
    git(['init'], repoDir);
    git(['checkout', '-b', 'main'], repoDir);
    git(['config', 'user.name', 'Ralph Test'], repoDir);
    git(['config', 'user.email', 'ralph@example.com'], repoDir);

    fs.writeFileSync(prdPath, JSON.stringify({
      id: 'prd-local-merge',
      title: 'Resolved Local Merge Task',
      description: 'Finalize resolved local merge state',
      userStories: [],
      dependencies: [],
    }, null, 2));
    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'base\n');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'feat: initial'], repoDir);
    const baseCommitSha = git(['rev-parse', 'HEAD'], repoDir);

    const worktreePath = path.join(repoDir, '.ralph-worktrees', 'task-local-merge');
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(['worktree', 'add', '-b', 'ralph/task-local-merge', worktreePath, 'main'], repoDir);

    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'task side\n');
    git(['add', 'feature.txt'], worktreePath);
    git(['commit', '-m', 'feat: task side'], worktreePath);
    const taskCommitSha = git(['rev-parse', 'HEAD'], worktreePath);

    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'main side\n');
    git(['add', 'feature.txt'], repoDir);
    git(['commit', '-m', 'feat: main side'], repoDir);
    const mainCommitSha = git(['rev-parse', 'HEAD'], repoDir);

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
      id: 'task-local-merge',
      prdPath,
      status: 'ready_to_finalize',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(repoDir, '.ralph', 'tasks', 'task-local-merge', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      baseCommitSha,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 1,
    };

    const result = finalizeTaskOutput(task);
    const parents = git(['show', '--no-patch', '--pretty=%P', 'HEAD'], worktreePath).split(' ');

    assert.equal(result.success, true);
    assert.equal(result.committed, true);
    assert.match(result.message, /Committed resolved local merge/);
    assert.equal(parents.includes(taskCommitSha), true);
    assert.equal(parents.includes(mainCommitSha), true);
    assert.equal(fs.existsSync(path.join(localGitDir, 'MERGE_HEAD')), false);

    git(['checkout', 'main'], repoDir);
    git(['merge', '--no-ff', 'ralph/task-local-merge', '-m', 'merge task'], repoDir);
    assert.match(fs.readFileSync(path.join(repoDir, 'feature.txt'), 'utf-8'), /main side/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('finalizeTaskOutput rejects existing task commits that contain git-internal artifacts', { concurrency: false }, () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalizer-existing-internal-'));
  const prdPath = path.join(repoDir, 'prd.json');

  try {
    git(['init'], repoDir);
    git(['checkout', '-b', 'main'], repoDir);
    git(['config', 'user.name', 'Ralph Test'], repoDir);
    git(['config', 'user.email', 'ralph@example.com'], repoDir);

    fs.writeFileSync(prdPath, JSON.stringify({
      id: 'prd-existing-internal',
      title: 'Existing Internal Commit Task',
      description: 'Reject git-internal artifacts in committed task branches',
      userStories: [],
      dependencies: [],
    }, null, 2));

    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'base\n');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'feat: initial'], repoDir);
    const baseCommitSha = git(['rev-parse', 'HEAD'], repoDir);

    const worktreePath = path.join(repoDir, '.ralph-worktrees', 'task-existing-internal');
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(['worktree', 'add', '-b', 'ralph/task-existing-internal', worktreePath, 'main'], repoDir);

    fs.mkdirSync(path.join(worktreePath, '.git-local'), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, '.git-local', 'MERGE_HEAD'), 'bad metadata\n');
    git(['add', '.git-local/MERGE_HEAD'], worktreePath);
    git(['commit', '-m', 'feat: invalid metadata commit'], worktreePath);

    const task = {
      id: 'task-existing-internal',
      prdPath,
      status: 'ready_to_finalize',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(repoDir, '.ralph', 'tasks', 'task-existing-internal', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      baseCommitSha,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 1,
    };

    assert.throws(
      () => finalizeTaskOutput(task),
      /Existing task commit contains git-internal artifacts/
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('finalizeTaskOutput ignores git-internal worktree artifacts when no product files changed', { concurrency: false }, () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalizer-git-internal-'));
  const prdPath = path.join(repoDir, 'prd.json');

  try {
    git(['init'], repoDir);
    git(['checkout', '-b', 'main'], repoDir);
    git(['config', 'user.name', 'Ralph Test'], repoDir);
    git(['config', 'user.email', 'ralph@example.com'], repoDir);

    fs.writeFileSync(prdPath, JSON.stringify({
      id: 'prd-git-internal',
      title: 'Git Internal Artifact Task',
      description: 'Ignore .git-local artifacts',
      userStories: [],
      dependencies: [],
    }, null, 2));

    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'base\n');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'feat: initial'], repoDir);
    const baseCommitSha = git(['rev-parse', 'HEAD'], repoDir);

    const worktreePath = path.join(repoDir, '.ralph-worktrees', 'task-git-internal');
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(['worktree', 'add', '-b', 'ralph/task-git-internal', worktreePath, 'main'], repoDir);

    fs.mkdirSync(path.join(worktreePath, '.git-local'), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, '.git-local', 'HEAD'), 'detached metadata\n');
    fs.writeFileSync(path.join(worktreePath, '.git-local', 'MERGE_HEAD'), 'merge metadata\n');

    const task = {
      id: 'task-git-internal',
      prdPath,
      status: 'ready_to_finalize',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(repoDir, '.ralph', 'tasks', 'task-git-internal', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      baseCommitSha,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 0,
    };

    const result = finalizeTaskOutput(task);

    assert.equal(result.success, true);
    assert.equal(result.committed, false);
    assert.equal(result.message, 'No changes to commit');
    assert.equal(git(['rev-parse', 'HEAD'], worktreePath), baseCommitSha);
    assert.match(git(['status', '--porcelain'], worktreePath), /\.git-local/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('finalizeTaskOutput excludes turbo cache artifacts from task commits', { concurrency: false }, () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalizer-turbo-cache-'));
  const prdPath = path.join(repoDir, 'prd.json');

  try {
    git(['init'], repoDir);
    git(['checkout', '-b', 'main'], repoDir);
    git(['config', 'user.name', 'Ralph Test'], repoDir);
    git(['config', 'user.email', 'ralph@example.com'], repoDir);

    fs.writeFileSync(prdPath, JSON.stringify({
      id: 'prd-turbo-cache',
      title: 'Turbo Cache Artifact Task',
      description: 'Ignore turbo cache artifacts',
      userStories: [],
      dependencies: [],
    }, null, 2));

    fs.writeFileSync(path.join(repoDir, '.gitignore'), '**/.turbo\n');
    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'base\n');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'feat: initial'], repoDir);
    const baseCommitSha = git(['rev-parse', 'HEAD'], repoDir);

    const worktreePath = path.join(repoDir, '.ralph-worktrees', 'task-turbo-cache');
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(['worktree', 'add', '-b', 'ralph/task-turbo-cache', worktreePath, 'main'], repoDir);

    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'base\ntask change\n');
    fs.mkdirSync(path.join(worktreePath, 'packages', 'control-plane', '.turbo'), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, 'packages', 'control-plane', '.turbo', 'turbo-test.log'), 'cache\n');

    const task = {
      id: 'task-turbo-cache',
      prdPath,
      status: 'ready_to_finalize',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(repoDir, '.ralph', 'tasks', 'task-turbo-cache', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      baseCommitSha,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 1,
    };

    const result = finalizeTaskOutput(task);

    assert.equal(result.success, true);
    assert.equal(result.committed, true);
    assert.match(git(['show', '--name-only', '--pretty=', 'HEAD'], worktreePath), /feature\.txt/);
    assert.throws(
      () => git(['cat-file', '-e', 'HEAD:packages/control-plane/.turbo/turbo-test.log'], worktreePath)
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('finalizeTaskOutput enforces configured quality gate timeouts', { concurrency: false }, () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalizer-timeout-'));
  const prdPath = path.join(repoDir, 'prd.json');
  const previousRalphHome = process.env.RALPH_HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalizer-home-'));
  const ralphHome = path.join(tempHome, '.ralph');

  try {
    process.env.RALPH_HOME = ralphHome;
    fs.mkdirSync(ralphHome, { recursive: true });
    fs.writeFileSync(path.join(ralphHome, 'config.json'), JSON.stringify({
      finalizer: {
        qualityGateTimeout: 0.05,
      },
    }, null, 2));

    git(['init'], repoDir);
    git(['checkout', '-b', 'main'], repoDir);
    git(['config', 'user.name', 'Ralph Test'], repoDir);
    git(['config', 'user.email', 'ralph@example.com'], repoDir);

    fs.writeFileSync(prdPath, JSON.stringify({
      id: 'prd-timeout',
      title: 'Timeout Quality Gate Task',
      description: 'Timeout quality gate execution',
      userStories: [],
      dependencies: [],
    }, null, 2));

    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      scripts: {
        typecheck: `node -e "setTimeout(() => {}, 1000)"`,
      },
    }, null, 2));
    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'base\n');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'feat: initial'], repoDir);

    const worktreePath = path.join(repoDir, '.ralph-worktrees', 'task-timeout');
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(['worktree', 'add', '-b', 'ralph/task-timeout', worktreePath, 'main'], repoDir);

    fs.appendFileSync(path.join(worktreePath, 'feature.txt'), 'change\n');

    const task = {
      id: 'task-timeout',
      prdPath,
      status: 'ready_to_finalize',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(repoDir, '.ralph', 'tasks', 'task-timeout', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 1,
    };

    assert.throws(
      () => finalizeTaskOutput(task),
      /Quality gate "typecheck" timed out after 0\.05s/
    );
  } finally {
    if (previousRalphHome === undefined) {
      delete process.env.RALPH_HOME;
    } else {
      process.env.RALPH_HOME = previousRalphHome;
    }

    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('finalizeTaskOutput isolates quality gate HOME and RALPH_HOME from live Ralph home', { concurrency: false }, () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalizer-env-isolation-'));
  const liveHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-live-home-'));
  const liveRalphHome = path.join(liveHome, 'live-ralph-home');
  const prdPath = path.join(repoDir, 'prd.json');
  const previousHome = process.env.HOME;
  const previousRalphHome = process.env.RALPH_HOME;

  try {
    process.env.HOME = liveHome;
    process.env.RALPH_HOME = liveRalphHome;
    fs.mkdirSync(liveRalphHome, { recursive: true });

    git(['init'], repoDir);
    git(['checkout', '-b', 'main'], repoDir);
    git(['config', 'user.name', 'Ralph Test'], repoDir);
    git(['config', 'user.email', 'ralph@example.com'], repoDir);

    fs.writeFileSync(prdPath, JSON.stringify({
      id: 'prd-env-isolation',
      title: 'Environment Isolation Task',
      description: 'Keep quality gates away from the live Ralph home',
      userStories: [],
      dependencies: [],
    }, null, 2));
    fs.writeFileSync(path.join(repoDir, 'gate-script.js'), `
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync('gate-env.json', JSON.stringify({
  HOME: process.env.HOME,
  RALPH_HOME: process.env.RALPH_HOME,
  RALPH_QUALITY_GATE_HOME: process.env.RALPH_QUALITY_GATE_HOME,
}, null, 2));
fs.mkdirSync(path.join(process.env.RALPH_HOME, 'manager'), { recursive: true });
fs.writeFileSync(path.join(process.env.RALPH_HOME, 'manager', 'state.json'), 'fake-manager');
fs.mkdirSync(path.join(process.env.HOME, '.ralph', 'tasks'), { recursive: true });
fs.writeFileSync(path.join(process.env.HOME, '.ralph', 'tasks', 'fake-task.json'), '{}');
`);
    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      scripts: {
        test: 'node gate-script.js',
      },
    }, null, 2));
    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'base\n');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'feat: initial'], repoDir);

    const worktreePath = path.join(repoDir, '.ralph-worktrees', 'task-env-isolation');
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(['worktree', 'add', '-b', 'ralph/task-env-isolation', worktreePath, 'main'], repoDir);
    fs.appendFileSync(path.join(worktreePath, 'feature.txt'), 'change\n');

    const task = {
      id: 'task-env-isolation',
      prdPath,
      status: 'ready_to_finalize',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(repoDir, '.ralph', 'tasks', 'task-env-isolation', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 1,
    };

    const result = finalizeTaskOutput(task);
    const gateEnv = JSON.parse(fs.readFileSync(path.join(worktreePath, 'gate-env.json'), 'utf-8'));

    assert.equal(result.success, true);
    assert.notEqual(gateEnv.HOME, liveHome);
    assert.notEqual(gateEnv.RALPH_HOME, liveRalphHome);
    assert.equal(gateEnv.RALPH_HOME, gateEnv.RALPH_QUALITY_GATE_HOME);
    assert.equal(fs.existsSync(path.join(liveRalphHome, 'manager', 'state.json')), false);
    assert.equal(fs.existsSync(path.join(liveHome, '.ralph', 'tasks', 'fake-task.json')), false);
  } finally {
    process.env.HOME = previousHome;
    if (previousRalphHome === undefined) {
      delete process.env.RALPH_HOME;
    } else {
      process.env.RALPH_HOME = previousRalphHome;
    }
    fs.rmSync(liveHome, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('finalizeTaskOutput kills descendant quality gate processes on timeout', { concurrency: false }, () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalizer-timeout-tree-'));
  const prdPath = path.join(repoDir, 'prd.json');
  const previousRalphHome = process.env.RALPH_HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalizer-home-'));
  const ralphHome = path.join(tempHome, '.ralph');

  try {
    process.env.RALPH_HOME = ralphHome;
    fs.mkdirSync(ralphHome, { recursive: true });
    fs.writeFileSync(path.join(ralphHome, 'config.json'), JSON.stringify({
      finalizer: {
        qualityGateTimeout: 1,
        qualityGates: ['typecheck'],
      },
    }, null, 2));

    git(['init'], repoDir);
    git(['checkout', '-b', 'main'], repoDir);
    git(['config', 'user.name', 'Ralph Test'], repoDir);
    git(['config', 'user.email', 'ralph@example.com'], repoDir);

    fs.writeFileSync(prdPath, JSON.stringify({
      id: 'prd-timeout-tree',
      title: 'Timeout Process Tree Task',
      description: 'Kill timeout descendants',
      userStories: [],
      dependencies: [],
    }, null, 2));
    fs.writeFileSync(path.join(repoDir, 'spawn-child.js'), `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync('child.pid', String(child.pid));
setInterval(() => {}, 1000);
`);
    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      scripts: {
        typecheck: 'node spawn-child.js',
      },
    }, null, 2));
    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'base\n');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'feat: initial'], repoDir);

    const worktreePath = path.join(repoDir, '.ralph-worktrees', 'task-timeout-tree');
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(['worktree', 'add', '-b', 'ralph/task-timeout-tree', worktreePath, 'main'], repoDir);
    fs.appendFileSync(path.join(worktreePath, 'feature.txt'), 'change\n');

    const task = {
      id: 'task-timeout-tree',
      prdPath,
      status: 'ready_to_finalize',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(repoDir, '.ralph', 'tasks', 'task-timeout-tree', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 1,
    };

    assert.throws(
      () => finalizeTaskOutput(task),
      /Quality gate "typecheck" timed out after 1s/
    );

    const childPid = Number(fs.readFileSync(path.join(worktreePath, 'child.pid'), 'utf-8'));
    for (let attempt = 0; attempt < 20 && isProcessRunning(childPid); attempt += 1) {
      sleepSync(50);
    }
    assert.equal(isProcessRunning(childPid), false);
  } finally {
    if (previousRalphHome === undefined) {
      delete process.env.RALPH_HOME;
    } else {
      process.env.RALPH_HOME = previousRalphHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('finalizeTaskOutput prefers lint:check over mutating lint scripts', { concurrency: false }, () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalizer-lint-check-'));
  const prdPath = path.join(repoDir, 'prd.json');

  try {
    git(['init'], repoDir);
    git(['checkout', '-b', 'main'], repoDir);
    git(['config', 'user.name', 'Ralph Test'], repoDir);
    git(['config', 'user.email', 'ralph@example.com'], repoDir);

    fs.writeFileSync(prdPath, JSON.stringify({
      id: 'prd-lint-check',
      title: 'Lint Check Preference Task',
      description: 'Prefer lint:check over lint',
      userStories: [],
      dependencies: [],
    }, null, 2));

    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      scripts: {
        lint: `node -e "require('fs').writeFileSync('lint-fix.txt','ran')"`,
        'lint:check': `node -e "require('fs').writeFileSync('lint-check.txt','ran')"`,
      },
    }, null, 2));
    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'base\n');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'feat: initial'], repoDir);

    const worktreePath = path.join(repoDir, '.ralph-worktrees', 'task-lint-check');
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(['worktree', 'add', '-b', 'ralph/task-lint-check', worktreePath, 'main'], repoDir);
    fs.appendFileSync(path.join(worktreePath, 'feature.txt'), 'change\n');

    const task = {
      id: 'task-lint-check',
      prdPath,
      status: 'ready_to_finalize',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(repoDir, '.ralph', 'tasks', 'task-lint-check', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 1,
    };

    const result = finalizeTaskOutput(task);

    assert.equal(result.success, true);
    assert.equal(fs.existsSync(path.join(worktreePath, 'lint-check.txt')), true);
    assert.equal(fs.existsSync(path.join(worktreePath, 'lint-fix.txt')), false);
    assert.match(result.message, /lint:check/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('finalizeTaskOutput suppresses package lint debt when only unchanged files fail', { concurrency: false }, () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalizer-legacy-lint-'));
  const prdPath = path.join(repoDir, 'prd.json');

  try {
    git(['init'], repoDir);
    git(['checkout', '-b', 'main'], repoDir);
    git(['config', 'user.name', 'Ralph Test'], repoDir);
    git(['config', 'user.email', 'ralph@example.com'], repoDir);

    fs.writeFileSync(prdPath, JSON.stringify({
      id: 'prd-legacy-lint',
      title: 'Legacy Lint Debt Task',
      description: 'Allow finalize when only unchanged files fail lint',
      userStories: [],
      dependencies: [],
    }, null, 2));

    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      scripts: {
        'lint:check': `node -e "const fs=require('fs'); const path=require('path'); fs.writeFileSync('lint-check.txt','ran'); console.error(path.join(process.cwd(),'legacy.ts')); console.error('  1:1  error  Legacy debt  no-undef'); process.exit(1)"`,
      },
    }, null, 2));
    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'base\n');
    fs.writeFileSync(path.join(repoDir, 'legacy.ts'), 'export const legacy = 1;\n');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'feat: initial'], repoDir);

    const worktreePath = path.join(repoDir, '.ralph-worktrees', 'task-legacy-lint');
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(['worktree', 'add', '-b', 'ralph/task-legacy-lint', worktreePath, 'main'], repoDir);
    fs.appendFileSync(path.join(worktreePath, 'feature.txt'), 'change\n');

    const task = {
      id: 'task-legacy-lint',
      prdPath,
      status: 'ready_to_finalize',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(repoDir, '.ralph', 'tasks', 'task-legacy-lint', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 1,
    };

    const result = finalizeTaskOutput(task);
    const logContent = fs.readFileSync(task.logPath, 'utf-8');

    assert.equal(result.success, true);
    assert.equal(fs.existsSync(path.join(worktreePath, 'lint-check.txt')), true);
    assert.match(logContent, /legacy debt/i);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('finalizeTaskOutput suppresses warning-only lint output when diagnostics are emitted on stdout', { concurrency: false }, () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalizer-warning-stdout-'));
  const prdPath = path.join(repoDir, 'prd.json');

  try {
    git(['init'], repoDir);
    git(['checkout', '-b', 'main'], repoDir);
    git(['config', 'user.name', 'Ralph Test'], repoDir);
    git(['config', 'user.email', 'ralph@example.com'], repoDir);

    fs.writeFileSync(prdPath, JSON.stringify({
      id: 'prd-warning-stdout',
      title: 'Lint Warning Stdout Task',
      description: 'Allow finalize when lint only reports warnings via stdout',
      userStories: [],
      dependencies: [],
    }, null, 2));

    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      scripts: {
        'lint:check': `node -e "const fs=require('fs'); const path=require('path'); fs.writeFileSync('lint-check.txt','ran'); console.log('web:lint: ' + path.join(process.cwd(),'legacy.ts')); console.log('web:lint:   1:1  warning  Legacy warning  no-console'); console.error('web:lint: ESLint found too many warnings (maximum: 0).'); process.exit(1)"`,
      },
    }, null, 2));
    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'base\n');
    fs.writeFileSync(path.join(repoDir, 'legacy.ts'), 'export const legacy = 1;\n');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'feat: initial'], repoDir);

    const worktreePath = path.join(repoDir, '.ralph-worktrees', 'task-warning-stdout');
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(['worktree', 'add', '-b', 'ralph/task-warning-stdout', worktreePath, 'main'], repoDir);
    fs.appendFileSync(path.join(worktreePath, 'feature.txt'), 'change\n');

    const task = {
      id: 'task-warning-stdout',
      prdPath,
      status: 'ready_to_finalize',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(repoDir, '.ralph', 'tasks', 'task-warning-stdout', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 1,
    };

    const result = finalizeTaskOutput(task);
    const logContent = fs.readFileSync(task.logPath, 'utf-8');

    assert.equal(result.success, true);
    assert.equal(fs.existsSync(path.join(worktreePath, 'lint-check.txt')), true);
    assert.match(logContent, /legacy debt/i);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('finalizeTaskOutput still fails lint when changed files have hard errors', { concurrency: false }, () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalizer-changed-lint-'));
  const prdPath = path.join(repoDir, 'prd.json');

  try {
    git(['init'], repoDir);
    git(['checkout', '-b', 'main'], repoDir);
    git(['config', 'user.name', 'Ralph Test'], repoDir);
    git(['config', 'user.email', 'ralph@example.com'], repoDir);

    fs.writeFileSync(prdPath, JSON.stringify({
      id: 'prd-changed-lint',
      title: 'Changed File Lint Failure Task',
      description: 'Keep changed-file hard errors task-fatal',
      userStories: [],
      dependencies: [],
    }, null, 2));

    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      scripts: {
        'lint:check': `node -e "const path=require('path'); console.error(path.join(process.cwd(),'feature.txt')); console.error('  2:1  error  Changed file regression  no-undef'); process.exit(1)"`,
      },
    }, null, 2));
    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'base\n');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'feat: initial'], repoDir);

    const worktreePath = path.join(repoDir, '.ralph-worktrees', 'task-changed-lint');
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(['worktree', 'add', '-b', 'ralph/task-changed-lint', worktreePath, 'main'], repoDir);
    fs.appendFileSync(path.join(worktreePath, 'feature.txt'), 'change\n');

    const task = {
      id: 'task-changed-lint',
      prdPath,
      status: 'ready_to_finalize',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(repoDir, '.ralph', 'tasks', 'task-changed-lint', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 1,
    };

    assert.throws(
      () => finalizeTaskOutput(task),
      /Quality gate "lint:check" failed/
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('finalizeTaskOutput refreshes Prisma client before root typecheck when schema changes', { concurrency: false }, () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalizer-prisma-prep-'));
  const prdPath = path.join(repoDir, 'prd.json');

  try {
    git(['init'], repoDir);
    git(['checkout', '-b', 'main'], repoDir);
    git(['config', 'user.name', 'Ralph Test'], repoDir);
    git(['config', 'user.email', 'ralph@example.com'], repoDir);

    fs.writeFileSync(prdPath, JSON.stringify({
      id: 'prd-prisma-prep',
      title: 'Prisma Preparation Task',
      description: 'Refresh generated Prisma artifacts before typecheck',
      userStories: [],
      dependencies: [],
    }, null, 2));

    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
      name: 'workspace-fixture',
      private: true,
      workspaces: ['packages/*'],
      scripts: {
        typecheck: `node -e "const fs=require('fs'); if (!fs.existsSync('packages/db/generated-client.txt')) { throw new Error('missing generated client'); } fs.writeFileSync('typecheck.txt','ok')"`,
      },
    }, null, 2));
    fs.mkdirSync(path.join(repoDir, 'packages', 'db', 'prisma'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'apps', 'api'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'packages', 'db', 'package.json'), JSON.stringify({
      name: '@repo/db',
      scripts: {
        'db:generate:safe': `node -e "require('fs').writeFileSync('generated-client.txt','ok')"`,
      },
    }, null, 2));
    fs.writeFileSync(path.join(repoDir, 'packages', 'db', 'prisma', 'schema.prisma'), 'model Example { id String @id }\n');
    fs.writeFileSync(path.join(repoDir, 'apps', 'api', 'feature.txt'), 'base\n');
    fs.writeFileSync(path.join(repoDir, 'docs', 'TODO.md'), 'base\n');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'feat: initial'], repoDir);

    const worktreePath = path.join(repoDir, '.ralph-worktrees', 'task-prisma-prep');
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(['worktree', 'add', '-b', 'ralph/task-prisma-prep', worktreePath, 'main'], repoDir);

    fs.appendFileSync(path.join(worktreePath, 'packages', 'db', 'prisma', 'schema.prisma'), '\nmodel Extra { id String @id }\n');
    fs.appendFileSync(path.join(worktreePath, 'apps', 'api', 'feature.txt'), 'change\n');
    fs.appendFileSync(path.join(worktreePath, 'docs', 'TODO.md'), 'change\n');

    const task = {
      id: 'task-prisma-prep',
      prdPath,
      status: 'ready_to_finalize',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(repoDir, '.ralph', 'tasks', 'task-prisma-prep', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 3,
    };

    const result = finalizeTaskOutput(task);

    assert.equal(result.success, true);
    assert.equal(result.committed, true);
    assert.equal(fs.existsSync(path.join(worktreePath, 'packages', 'db', 'generated-client.txt')), true);
    assert.equal(fs.existsSync(path.join(worktreePath, 'typecheck.txt')), true);
    assert.match(result.message, /typecheck/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('finalizeTaskOutput repairs missing workspace install symlinks before Prisma preparation', { concurrency: false }, () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalizer-prisma-bootstrap-'));
  const prdPath = path.join(repoDir, 'prd.json');
  let restorePath = () => {};

  try {
    restorePath = prependFakePnpmToPath(repoDir);
    git(['init'], repoDir);
    git(['checkout', '-b', 'main'], repoDir);
    git(['config', 'user.name', 'Ralph Test'], repoDir);
    git(['config', 'user.email', 'ralph@example.com'], repoDir);

    fs.writeFileSync(prdPath, JSON.stringify({
      id: 'prd-prisma-bootstrap',
      title: 'Prisma Bootstrap Task',
      description: 'Repair workspace dependency symlinks before Prisma generation',
      userStories: [],
      dependencies: [],
    }, null, 2));

    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
      name: 'workspace-fixture',
      private: true,
      workspaces: ['packages/*'],
      scripts: {
        typecheck: `node -e "require('fs').accessSync('packages/db/generated-client.txt'); require('fs').writeFileSync('typecheck.txt','ok')"`,
      },
    }, null, 2));
    fs.writeFileSync(path.join(repoDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    fs.mkdirSync(path.join(repoDir, 'node_modules', '.pnpm'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'packages', 'db', 'prisma'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'packages', 'db', 'node_modules', '.bin'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'packages', 'db', 'package.json'), JSON.stringify({
      name: '@repo/db',
      scripts: {
        'db:generate:safe': 'node prisma/generate-safe.mjs',
      },
    }, null, 2));
    fs.writeFileSync(path.join(repoDir, 'packages', 'db', 'prisma', 'generate-safe.mjs'), `
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const prismaBin = path.join(process.cwd(), 'node_modules', '.bin', 'prisma');
const result = spawnSync(prismaBin, ['generate'], { stdio: 'inherit', shell: false });
if (result.error) {
  console.error(result.error);
}
process.exit(result.status ?? 1);
`);
    fs.writeFileSync(path.join(repoDir, 'packages', 'db', 'node_modules', '.bin', 'prisma'), `#!/usr/bin/env node
require('fs').writeFileSync(require('node:path').join(process.cwd(), 'generated-client.txt'), 'ok');
`);
    fs.chmodSync(path.join(repoDir, 'packages', 'db', 'node_modules', '.bin', 'prisma'), 0o755);
    fs.writeFileSync(path.join(repoDir, 'packages', 'db', 'prisma', 'schema.prisma'), 'model Example { id String @id }\n');
    fs.writeFileSync(path.join(repoDir, 'docs', 'TODO.md'), 'base\n');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'feat: initial'], repoDir);

    const worktreePath = path.join(repoDir, '.ralph-worktrees', 'task-prisma-bootstrap');
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(['worktree', 'add', '-b', 'ralph/task-prisma-bootstrap', worktreePath, 'main'], repoDir);

    fs.appendFileSync(path.join(worktreePath, 'packages', 'db', 'prisma', 'schema.prisma'), '\nmodel Extra { id String @id }\n');
    fs.appendFileSync(path.join(worktreePath, 'docs', 'TODO.md'), 'change\n');
    fs.rmSync(path.join(worktreePath, 'node_modules'), { recursive: true, force: true });
    fs.rmSync(path.join(worktreePath, 'packages', 'db', 'node_modules'), { recursive: true, force: true });

    const task = {
      id: 'task-prisma-bootstrap',
      prdPath,
      status: 'ready_to_finalize',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(repoDir, '.ralph', 'tasks', 'task-prisma-bootstrap', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 2,
    };

    const result = finalizeTaskOutput(task);

    assert.equal(result.success, true);
    assert.equal(result.committed, true);
    assert.equal(fs.lstatSync(path.join(worktreePath, 'node_modules')).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(path.join(worktreePath, 'packages', 'db', 'node_modules')).isSymbolicLink(), true);
    assert.equal(fs.existsSync(path.join(worktreePath, 'packages', 'db', 'generated-client.txt')), true);
    assert.equal(fs.existsSync(path.join(worktreePath, 'typecheck.txt')), true);
  } finally {
    restorePath();
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('finalizeTaskOutput scopes quality gates to changed workspace packages', { concurrency: false }, () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalizer-workspace-'));
  const prdPath = path.join(repoDir, 'prd.json');

  try {
    git(['init'], repoDir);
    git(['checkout', '-b', 'main'], repoDir);
    git(['config', 'user.name', 'Ralph Test'], repoDir);
    git(['config', 'user.email', 'ralph@example.com'], repoDir);

    fs.writeFileSync(prdPath, JSON.stringify({
      id: 'prd-workspace',
      title: 'Workspace Gate Task',
      description: 'Scope gates to changed workspaces',
      userStories: [],
      dependencies: [],
    }, null, 2));

    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
      name: 'workspace-fixture',
      private: true,
      workspaces: ['packages/*'],
      scripts: {
        test: `node -e "process.exit(9)"`,
      },
    }, null, 2));
    fs.writeFileSync(path.join(repoDir, 'package-lock.json'), '{}\n');
    fs.mkdirSync(path.join(repoDir, 'packages', 'changed'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'packages', 'unchanged'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'packages', 'changed', 'package.json'), JSON.stringify({
      name: 'changed',
      scripts: {
        test: `node -e "require('fs').writeFileSync('changed-test.txt','ok')"`,
      },
    }, null, 2));
    fs.writeFileSync(path.join(repoDir, 'packages', 'unchanged', 'package.json'), JSON.stringify({
      name: 'unchanged',
      scripts: {
        test: `node -e "process.exit(8)"`,
      },
    }, null, 2));
    fs.writeFileSync(path.join(repoDir, 'packages', 'changed', 'feature.txt'), 'base\n');
    fs.writeFileSync(path.join(repoDir, 'packages', 'unchanged', 'feature.txt'), 'base\n');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'feat: initial'], repoDir);

    const worktreePath = path.join(repoDir, '.ralph-worktrees', 'task-workspace');
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(['worktree', 'add', '-b', 'ralph/task-workspace', worktreePath, 'main'], repoDir);

    fs.appendFileSync(path.join(worktreePath, 'packages', 'changed', 'feature.txt'), 'change\n');

    const task = {
      id: 'task-workspace',
      prdPath,
      status: 'ready_to_finalize',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(repoDir, '.ralph', 'tasks', 'task-workspace', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 1,
    };

    const result = finalizeTaskOutput(task);

    assert.equal(result.success, true);
    assert.equal(result.committed, true);
    assert.equal(fs.existsSync(path.join(worktreePath, 'packages', 'changed', 'changed-test.txt')), true);
    assert.equal(fs.existsSync(path.join(worktreePath, 'packages', 'unchanged', 'changed-test.txt')), false);
    assert.match(result.message, /packages\/changed:test/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('finalizeTaskOutput uses baseCommitSha to scope quality gates for already-committed task changes', { concurrency: false }, () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalizer-base-aware-'));
  const prdPath = path.join(repoDir, 'prd.json');

  try {
    git(['init'], repoDir);
    git(['checkout', '-b', 'main'], repoDir);
    git(['config', 'user.name', 'Ralph Test'], repoDir);
    git(['config', 'user.email', 'ralph@example.com'], repoDir);

    fs.writeFileSync(prdPath, JSON.stringify({
      id: 'prd-base-aware',
      title: 'Base Aware Workspace Task',
      description: 'Use base commit for changed workspace detection',
      userStories: [],
      dependencies: [],
    }, null, 2));

    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
      name: 'workspace-fixture',
      private: true,
      workspaces: ['packages/*'],
      scripts: {
        test: `node -e "process.exit(9)"`,
      },
    }, null, 2));
    fs.writeFileSync(path.join(repoDir, 'package-lock.json'), '{}\n');
    fs.mkdirSync(path.join(repoDir, 'packages', 'changed'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'packages', 'unchanged'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'packages', 'changed', 'package.json'), JSON.stringify({
      name: 'changed',
      scripts: {
        test: `node -e "require('fs').writeFileSync('changed-test.txt','ok')"`,
      },
    }, null, 2));
    fs.writeFileSync(path.join(repoDir, 'packages', 'unchanged', 'package.json'), JSON.stringify({
      name: 'unchanged',
      scripts: {
        test: `node -e "process.exit(8)"`,
      },
    }, null, 2));
    fs.writeFileSync(path.join(repoDir, 'packages', 'changed', 'feature.txt'), 'base\n');
    fs.writeFileSync(path.join(repoDir, 'packages', 'unchanged', 'feature.txt'), 'base\n');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'feat: initial'], repoDir);
    const baseCommitSha = git(['rev-parse', 'HEAD'], repoDir);

    const worktreePath = path.join(repoDir, '.ralph-worktrees', 'task-base-aware');
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(['worktree', 'add', '-b', 'ralph/task-base-aware', worktreePath, 'main'], repoDir);

    fs.appendFileSync(path.join(worktreePath, 'packages', 'changed', 'feature.txt'), 'committed change\n');
    git(['add', 'packages/changed/feature.txt'], worktreePath);
    git(['commit', '-m', 'feat: committed change'], worktreePath);

    const task = {
      id: 'task-base-aware',
      prdPath,
      status: 'ready_to_finalize',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(repoDir, '.ralph', 'tasks', 'task-base-aware', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      baseCommitSha,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 1,
    };

    const result = finalizeTaskOutput(task);

    assert.equal(result.success, true);
    assert.equal(result.committed, false);
    assert.equal(fs.existsSync(path.join(worktreePath, 'packages', 'changed', 'changed-test.txt')), true);
    assert.equal(fs.existsSync(path.join(worktreePath, 'packages', 'unchanged', 'changed-test.txt')), false);
    assert.match(result.message, /Validated existing task commits/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('finalizeTaskOutput scopes quality gates using pnpm-workspace.yaml patterns', { concurrency: false }, () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalizer-pnpm-workspace-'));
  const prdPath = path.join(repoDir, 'prd.json');
  let restorePath = () => {};

  try {
    restorePath = prependFakePnpmToPath(repoDir);
    git(['init'], repoDir);
    git(['checkout', '-b', 'main'], repoDir);
    git(['config', 'user.name', 'Ralph Test'], repoDir);
    git(['config', 'user.email', 'ralph@example.com'], repoDir);

    fs.writeFileSync(prdPath, JSON.stringify({
      id: 'prd-pnpm-workspace',
      title: 'Workspace Gate Task',
      description: 'Scope gates to changed pnpm workspaces',
      userStories: [],
      dependencies: [],
    }, null, 2));

    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
      name: 'workspace-fixture',
      private: true,
      scripts: {
        test: `node -e "process.exit(9)"`,
      },
    }, null, 2));
    fs.writeFileSync(path.join(repoDir, 'pnpm-lock.yaml'), '\n');
    fs.writeFileSync(path.join(repoDir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    fs.mkdirSync(path.join(repoDir, 'packages', 'changed'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'packages', 'unchanged'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'packages', 'changed', 'package.json'), JSON.stringify({
      name: 'changed',
      scripts: {
        test: `node -e "require('fs').writeFileSync('changed-test.txt','ok')"`,
      },
    }, null, 2));
    fs.writeFileSync(path.join(repoDir, 'packages', 'unchanged', 'package.json'), JSON.stringify({
      name: 'unchanged',
      scripts: {
        test: `node -e "process.exit(8)"`,
      },
    }, null, 2));
    fs.writeFileSync(path.join(repoDir, 'packages', 'changed', 'feature.txt'), 'base\n');
    fs.writeFileSync(path.join(repoDir, 'packages', 'unchanged', 'feature.txt'), 'base\n');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'feat: initial'], repoDir);

    const worktreePath = path.join(repoDir, '.ralph-worktrees', 'task-pnpm-workspace');
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(['worktree', 'add', '-b', 'ralph/task-pnpm-workspace', worktreePath, 'main'], repoDir);

    fs.appendFileSync(path.join(worktreePath, 'packages', 'changed', 'feature.txt'), 'change\n');

    const task = {
      id: 'task-pnpm-workspace',
      prdPath,
      status: 'ready_to_finalize',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath: path.join(repoDir, '.ralph', 'tasks', 'task-pnpm-workspace', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 1,
    };

    const result = finalizeTaskOutput(task);

    assert.equal(result.success, true);
    assert.equal(result.committed, true);
    assert.equal(fs.existsSync(path.join(worktreePath, 'packages', 'changed', 'changed-test.txt')), true);
    assert.equal(fs.existsSync(path.join(worktreePath, 'packages', 'unchanged', 'changed-test.txt')), false);
    assert.match(result.message, /packages\/changed:test/);
  } finally {
    restorePath();
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
