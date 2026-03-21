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
    assert.equal(fs.existsSync(path.join(worktreePath, 'build.txt')), true);
    assert.match(git(['log', '--oneline', '-1'], worktreePath), /feat\(ralph\): complete quality gates task/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
