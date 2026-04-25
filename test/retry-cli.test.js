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

test('retry resets failed_finalize tasks and exhausted story attempts', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-retry-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-retry-repo-'));
  const taskId = 'failed-finalize-task';
  const taskDir = path.join(homeDir, '.ralph', 'tasks', taskId);
  const prdPath = path.join(repoDir, 'prd.json');

  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(prdPath, JSON.stringify({
      id: 'retry-prd',
      title: 'Retry PRD',
      description: 'retry',
      dependencies: ['missing-prd'],
      userStories: [
        { id: 'US-001', title: 'One', description: 'one', acceptanceCriteria: ['done'] },
        { id: 'US-002', title: 'Two', description: 'two', acceptanceCriteria: ['done'] },
        { id: 'US-003', title: 'Three', description: 'three', acceptanceCriteria: ['done'] },
      ],
    }, null, 2));
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: taskId,
      prdPath,
      prdId: 'retry-prd',
      prdDependencies: ['missing-prd'],
      status: 'failed_finalize',
      startTime: Date.now(),
      endTime: Date.now(),
      completedUS: ['US-001', 'US-002'],
      worktree: path.join(repoDir, '.ralph-worktrees', taskId),
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      loopCount: 5,
      consecutiveNoProgress: 2,
      consecutiveErrors: 1,
      lastProgressTime: 1,
      lastFilesChanged: 1,
      finalizerCommitSha: 'abc123',
      finalizerAttempts: 2,
      mergeError: 'quality gate failed',
      finalizeRepairStartedAt: 10,
      finalizeRepairDeadlineAt: 20,
      finalizeRepairLastFailureSnapshot: {
        headSha: 'abc123',
        commitsAheadOfBase: 1,
        changedFiles: 1,
        worktreeDiffSignature: 'sig-1',
        failureKind: 'quality_gate',
        failureSignature: 'quality gate failed',
        capturedAt: 10,
      },
      finalizeRepairLastProgressAt: 11,
      finalizeRepairLastProgressReason: 'HEAD changed',
      finalizeRepairConsecutiveNoProgress: 1,
      finalizeRepairTotalRequeues: 3,
      finalizeRepairStoppedAt: 12,
      finalizeRepairStopReason: 'repair_no_progress',
      storyProgress: [
        { id: 'US-001', status: 'failed', attempts: 2, lastError: 'network failed', updatedAt: 1 },
        { id: 'US-002', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-003', status: 'needs_repair', attempts: 2, lastError: 'test failed', updatedAt: 1 },
      ],
    }, null, 2));

    const result = runCli(['retry', taskId], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf-8'));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.previousStatus, 'failed_finalize');
    assert.equal(output.currentStatus, 'pending');
    assert.deepEqual(output.resetStoryIds, ['US-001', 'US-003']);
    assert.deepEqual(state.completedUS, ['US-002']);
    assert.equal(state.finalizerCommitSha, undefined);
    assert.equal(state.finalizerAttempts, 0);
    assert.equal(state.mergeError, undefined);
    assert.equal(state.finalizeRepairStartedAt, undefined);
    assert.equal(state.finalizeRepairDeadlineAt, undefined);
    assert.equal(state.finalizeRepairLastFailureSnapshot, undefined);
    assert.equal(state.finalizeRepairLastProgressAt, undefined);
    assert.equal(state.finalizeRepairLastProgressReason, undefined);
    assert.equal(state.finalizeRepairConsecutiveNoProgress, 0);
    assert.equal(state.finalizeRepairTotalRequeues, 0);
    assert.equal(state.finalizeRepairStoppedAt, undefined);
    assert.equal(state.finalizeRepairStopReason, undefined);
    assert.equal(state.storyProgress[0].status, 'pending');
    assert.equal(state.storyProgress[0].attempts, 0);
    assert.equal(state.storyProgress[2].status, 'pending');
    assert.equal(state.storyProgress[2].attempts, 0);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
