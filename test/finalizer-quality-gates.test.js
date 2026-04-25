const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { finalizeTaskOutput } = require('../dist/core/finalizer.js');

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

test('finalizeTaskOutput runs available quality gates before commit', () => {
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

test('finalizeTaskOutput validates existing task commits instead of silently treating them as no-op', () => {
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

test('finalizeTaskOutput enforces configured quality gate timeouts', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalizer-timeout-'));
  const prdPath = path.join(repoDir, 'prd.json');
  const previousHome = process.env.HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalizer-home-'));

  try {
    process.env.HOME = tempHome;
    fs.mkdirSync(path.join(tempHome, '.ralph'), { recursive: true });
    fs.writeFileSync(path.join(tempHome, '.ralph', 'config.json'), JSON.stringify({
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
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }

    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('finalizeTaskOutput scopes quality gates to changed workspace packages', () => {
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

test('finalizeTaskOutput scopes quality gates using pnpm-workspace.yaml patterns', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalizer-pnpm-workspace-'));
  const prdPath = path.join(repoDir, 'prd.json');

  try {
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
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
