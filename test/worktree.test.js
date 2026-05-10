const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { WorktreeManager } = require('../dist/core/worktree.js');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createRepo() {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-worktree-repo-'));
  git(repoPath, ['init']);
  git(repoPath, ['config', 'user.email', 'ralph-test@example.com']);
  git(repoPath, ['config', 'user.name', 'Ralph Test']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), 'test\n');
  git(repoPath, ['add', 'README.md']);
  git(repoPath, ['commit', '-m', 'initial']);
  return repoPath;
}

test('createWorktree preserves stale unregistered paths and reuses existing task branch', async () => {
  const repoPath = createRepo();
  const taskId = 'task-stale-path';
  const worktreePath = path.join(repoPath, '.ralph-worktrees', taskId);
  const staleFile = path.join(worktreePath, 'probe-write-file');

  git(repoPath, ['branch', `ralph/${taskId}`]);
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(staleFile, 'stale evidence\n');

  const manager = new WorktreeManager();
  const createdPath = await manager.createWorktree(repoPath, taskId, 'HEAD');
  const staleSiblings = fs.readdirSync(path.dirname(worktreePath))
    .filter((entry) => entry.startsWith(`${taskId}.stale-`));

  assert.equal(createdPath, worktreePath);
  assert.equal(git(worktreePath, ['branch', '--show-current']), `ralph/${taskId}`);
  assert.equal(
    fs.realpathSync(git(worktreePath, ['rev-parse', '--show-toplevel'])),
    fs.realpathSync(worktreePath)
  );
  assert.equal(staleSiblings.length, 1);
  assert.equal(
    fs.readFileSync(path.join(path.dirname(worktreePath), staleSiblings[0], 'probe-write-file'), 'utf-8'),
    'stale evidence\n'
  );
});
