const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  captureProgressBaseline,
  detectProgress,
} = require('../dist/worker.js');

function git(cwd, args) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('detectProgress notices changed diff content when changed file count stays constant', () => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-worker-progress-'));

  try {
    git(repoPath, ['init']);
    git(repoPath, ['config', 'user.email', 'test@example.com']);
    git(repoPath, ['config', 'user.name', 'Test User']);

    const filePath = path.join(repoPath, 'tracked.txt');
    fs.writeFileSync(filePath, 'base\n');
    git(repoPath, ['add', 'tracked.txt']);
    git(repoPath, ['commit', '-m', 'initial']);

    fs.writeFileSync(filePath, 'first change\n');
    const baseline = captureProgressBaseline(repoPath);

    fs.writeFileSync(filePath, 'second change\n');
    const progress = detectProgress(repoPath, path.join(repoPath, 'agent.log'), baseline);

    assert.equal(progress.hasProgress, true);
    assert.equal(progress.reason, 'working tree diff content changed');
    assert.equal(progress.filesChanged, 1);
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
});
