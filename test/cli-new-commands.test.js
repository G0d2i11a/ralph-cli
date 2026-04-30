const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

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

function writeRiskPrdFile(dir, id, overrides = {}) {
  const prdPath = path.join(dir, `${id}.json`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(prdPath, JSON.stringify({
    id,
    title: `${id} title`,
    description: '',
    dependencies: [],
    userStories: [
      {
        id: 'US-001',
        title: 'First story',
        description: '',
        acceptanceCriteria: [],
      },
    ],
    ...overrides,
  }, null, 2));
  return prdPath;
}

function writeRiskTaskState(homeDir, taskId, overrides = {}) {
  const taskDir = path.join(homeDir, '.ralph', 'tasks', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
    id: taskId,
    prdPath: overrides.prdPath || `/tmp/${taskId}.json`,
    prdId: overrides.prdId || taskId,
    status: overrides.status || 'pending',
    startTime: overrides.startTime || 100,
    enqueuedAt: overrides.enqueuedAt || overrides.startTime || 100,
    completedUS: [],
    worktree: overrides.worktree || '',
    logPath: path.join(taskDir, 'agent.log'),
    agent: 'codex',
    repoPath: overrides.repoPath || '/tmp/repo',
    loopCount: 0,
    consecutiveNoProgress: 0,
    consecutiveErrors: 0,
    lastProgressTime: overrides.startTime || 100,
    lastFilesChanged: 0,
    ...overrides,
  }, null, 2));
}

function writeMarkdownPrd(
  filePath,
  id,
  dependencies = ['missing-upstream-prd'],
  writeSurface = ['src/utils/helpers.ts']
) {
  const dependencyFrontmatter = dependencies.length > 0
    ? `dependencies:\n${dependencies.map((dependency) => `  - ${dependency}`).join('\n')}`
    : 'dependencies: []';
  const writeSurfaceFrontmatter = writeSurface.length > 0
    ? `writeSurface:\n${writeSurface.map((entry) => `  - ${entry}`).join('\n')}`
    : 'writeSurface: []';

  fs.writeFileSync(filePath, `---
id: ${id}
title: ${id} title
${dependencyFrontmatter}
${writeSurfaceFrontmatter}
userStories:
  - id: US-001
    title: Implement ${id}
    description: Implement the markdown PRD
    acceptanceCriteria:
      - The PRD is accepted by intake
---

## Notes

The missing dependency keeps the CLI test from launching a worker.
`);
}

test('start and batch-start enqueue markdown PRDs with valid frontmatter', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-cli-markdown-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-cli-markdown-repo-'));
  const startPrd = path.join(repoDir, 'start-prd.md');
  const batchPrd = path.join(repoDir, 'batch-prd.md');
  const env = {
    HOME: homeDir,
    RALPH_HOME: path.join(homeDir, '.ralph'),
  };

  try {
    fs.mkdirSync(path.join(homeDir, '.ralph'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.ralph', 'config.json'), JSON.stringify({
      runner: {
        maxConcurrent: 1,
      },
    }, null, 2));
    writeRiskTaskState(homeDir, 'running-slot', {
      status: 'running',
      pid: process.pid,
      prdPath: path.join(repoDir, 'running-slot.json'),
      prdId: 'running-slot-prd',
      repoPath: repoDir,
      declaredWriteSurface: ['src/occupied-slot.ts'],
      startTime: 50,
      enqueuedAt: 50,
      lastProgressTime: Date.now(),
    });

    writeMarkdownPrd(startPrd, 'cli-start-prd');
    writeMarkdownPrd(batchPrd, 'cli-batch-prd', [], ['src/commands/start.ts']);

    const startResult = runCli(['start', startPrd, '--repo', repoDir], env);
    assert.equal(startResult.status, 0, startResult.stderr);
    const startOutput = JSON.parse(startResult.stdout);
    assert.equal(startOutput.status, 'pending');
    assert.deepEqual(startOutput.dependencies, ['missing-upstream-prd']);

    const batchResult = runCli(['batch-start', batchPrd, '--repo', repoDir], env);
    assert.equal(batchResult.status, 0, batchResult.stderr);
    const batchOutput = JSON.parse(batchResult.stdout);
    assert.equal(batchOutput.successful, 1);
    assert.equal(batchOutput.failed, 0);
    assert.equal(batchOutput.results[0].success, true);
    assert.equal(batchOutput.results[0].status, 'pending');
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
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
    assert.equal(output.repoCount, 1);
    assert.equal(output.mixedRepos, false);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue command reports coordination blockers for overlapping pending tasks', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-coordination-home-'));

  try {
    const firstTaskDir = path.join(homeDir, '.ralph', 'tasks', 'first-task');
    const secondTaskDir = path.join(homeDir, '.ralph', 'tasks', 'second-task');
    fs.mkdirSync(firstTaskDir, { recursive: true });
    fs.mkdirSync(secondTaskDir, { recursive: true });

    fs.writeFileSync(path.join(firstTaskDir, 'state.json'), JSON.stringify({
      id: 'first-task',
      prdPath: '/tmp/first.json',
      prdId: 'first-prd',
      prdDependencies: [],
      status: 'pending',
      startTime: 100,
      enqueuedAt: 100,
      completedUS: [],
      worktree: '',
      logPath: path.join(firstTaskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      declaredConflictDomains: ['contracts-index'],
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 0,
    }, null, 2));
    fs.writeFileSync(path.join(secondTaskDir, 'state.json'), JSON.stringify({
      id: 'second-task',
      prdPath: '/tmp/second.json',
      prdId: 'second-prd',
      prdDependencies: [],
      status: 'pending',
      startTime: 200,
      enqueuedAt: 200,
      completedUS: [],
      worktree: '',
      logPath: path.join(secondTaskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      declaredConflictDomains: ['contracts-index'],
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 200,
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['queue'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const secondTask = output.tasks.find((task) => task.id === 'second-task');

    assert.equal(result.status, 0, result.stderr);
    assert.equal(secondTask.reason, 'coordination');
    assert.deepEqual(secondTask.blockers, ['first-task']);
    assert.match(secondTask.nextAction, /earlier overlapping task/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue command marks pending tasks blocked by failed dependencies as attention', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-failed-dep-home-'));

  try {
    const depTaskDir = path.join(homeDir, '.ralph', 'tasks', 'failed-dependency');
    const childTaskDir = path.join(homeDir, '.ralph', 'tasks', 'blocked-child');
    fs.mkdirSync(depTaskDir, { recursive: true });
    fs.mkdirSync(childTaskDir, { recursive: true });

    fs.writeFileSync(path.join(depTaskDir, 'state.json'), JSON.stringify({
      id: 'failed-dependency',
      prdPath: '/tmp/dep.json',
      prdId: 'dep-prd',
      prdDependencies: [],
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001'],
      worktree: '/tmp/dep',
      logPath: path.join(depTaskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      lastError: 'dependency story did not pass',
      lastErrorKind: 'story_incomplete',
      lastErrorRetryable: false,
      autoRecoveryKind: 'stagnant',
      autoRecoveryLastReason: 'stale recovery residue',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 0,
    }, null, 2));
    fs.writeFileSync(path.join(childTaskDir, 'state.json'), JSON.stringify({
      id: 'blocked-child',
      prdPath: '/tmp/child.json',
      prdId: 'child-prd',
      prdDependencies: ['dep-prd'],
      status: 'pending',
      startTime: 200,
      completedUS: [],
      worktree: '',
      logPath: path.join(childTaskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 200,
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['queue'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const childTask = output.tasks.find((task) => task.id === 'blocked-child');
    const failedTask = output.tasks.find((task) => task.id === 'failed-dependency');
    const childAttention = output.attention.find((task) => task.id === 'blocked-child');

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.summary.totalAttention, 2);
    assert.equal(output.summary.autoRecoveryActive, 0);
    assert.equal(failedTask.attention.needed, true);
    assert.equal(failedTask.autoRecovery.active, false);
    assert.equal(failedTask.autoRecovery.staleInvalidReason, 'semantic_story_incomplete_is_not_auto_recovering');
    assert.equal(childTask.reason, 'dependencies');
    assert.deepEqual(childTask.failedDependencies, ['dep-prd']);
    assert.deepEqual(childTask.recoveringDependencies, []);
    assert.equal(childTask.attention.needed, true);
    assert.equal(childTask.attention.reason, 'blocked_failed_dependency');
    assert.match(childTask.nextAction, /blocked by failed dependencies: dep-prd/);
    assert.deepEqual(childAttention.blockers, ['dep-prd']);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue command marks pending tasks blocked by failed coordination owners as attention', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-failed-coordination-home-'));

  try {
    const failedOwnerDir = path.join(homeDir, '.ralph', 'tasks', 'failed-owner');
    const laterTaskDir = path.join(homeDir, '.ralph', 'tasks', 'later-task');
    fs.mkdirSync(failedOwnerDir, { recursive: true });
    fs.mkdirSync(laterTaskDir, { recursive: true });

    fs.writeFileSync(path.join(failedOwnerDir, 'state.json'), JSON.stringify({
      id: 'failed-owner',
      prdPath: '/tmp/owner.json',
      prdId: 'owner-prd',
      prdDependencies: [],
      status: 'failed',
      startTime: 100,
      enqueuedAt: 100,
      completedUS: ['US-001'],
      worktree: '/tmp/owner',
      logPath: path.join(failedOwnerDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      declaredWriteSurface: ['packages/contracts/src/index.ts'],
      observedWriteSurface: ['packages/contracts/src/index.ts'],
      mergeConflictFiles: ['packages/contracts/src/index.ts'],
      repairContext: {
        mode: 'merge',
        storyId: 'US-003',
        createdAt: 123,
        reason: 'Merge repair required by Ralph.',
      },
      lastError: 'merge repair did not converge',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 0,
    }, null, 2));
    fs.writeFileSync(path.join(laterTaskDir, 'state.json'), JSON.stringify({
      id: 'later-task',
      prdPath: '/tmp/later.json',
      prdId: 'later-prd',
      prdDependencies: [],
      status: 'pending',
      startTime: 200,
      enqueuedAt: 200,
      completedUS: [],
      worktree: '',
      logPath: path.join(laterTaskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      declaredWriteSurface: ['packages/contracts/src/index.ts'],
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 200,
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['queue'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const laterTask = output.tasks.find((task) => task.id === 'later-task');
    const laterAttention = output.attention.find((task) => task.id === 'later-task');

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.summary.totalAttention, 2);
    assert.equal(laterTask.reason, 'coordination');
    assert.deepEqual(laterTask.blockers, ['failed-owner']);
    assert.deepEqual(laterTask.quarantinedBlockers, ['failed-owner']);
    assert.deepEqual(laterTask.failedBlockers, []);
    assert.equal(laterTask.attention.needed, true);
    assert.equal(laterTask.attention.reason, 'blocked_merge_repair_quarantine');
    assert.match(laterTask.nextAction, /merge-repair quarantine/);
    assert.deepEqual(laterAttention.blockers, ['failed-owner']);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('demote command releases merge-repair quarantine with an auditable queue reason', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-demote-home-'));

  try {
    const taskDir = path.join(homeDir, '.ralph', 'tasks', 'failed-owner');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: 'failed-owner',
      prdPath: '/tmp/owner.json',
      prdId: 'owner-prd',
      prdDependencies: [],
      status: 'failed',
      startTime: 100,
      enqueuedAt: 100,
      completedUS: ['US-001'],
      worktree: '/tmp/owner',
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      declaredWriteSurface: ['packages/contracts/src/index.ts'],
      observedWriteSurface: ['packages/contracts/src/index.ts'],
      mergeConflictFiles: ['packages/contracts/src/index.ts'],
      repairContext: {
        mode: 'merge',
        storyId: 'US-003',
        createdAt: 123,
        reason: 'Merge repair required by Ralph.',
      },
      lastError: 'merge repair did not converge',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli([
      'demote',
      'failed-owner',
      '--reason',
      'superseded by smaller fix',
      '--to',
      'later-task',
    ], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const queueResult = runCli(['queue'], { HOME: homeDir });
    const queueOutput = JSON.parse(queueResult.stdout);
    const task = queueOutput.tasks.find((entry) => entry.id === 'failed-owner');
    const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf-8'));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.quarantineReleased, true);
    assert.equal(state.quarantineExitKind, 'demote');
    assert.equal(state.quarantineReleaseReason, 'superseded by smaller fix');
    assert.equal(state.quarantineTransferredTo, 'later-task');
    assert.equal(queueResult.status, 0, queueResult.stderr);
    assert.equal(task.attention.reason, 'merge_repair_quarantine_released');
    assert.equal(task.quarantine.reason, 'superseded by smaller fix');
    assert.match(task.nextAction, /released by demotion/);
    assert.match(task.nextAction, /later-task/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('stop command releases running merge-repair quarantine with a queue reason', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-stop-quarantine-home-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });

  try {
    const taskDir = path.join(homeDir, '.ralph', 'tasks', 'running-owner');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: 'running-owner',
      prdPath: '/tmp/owner.json',
      prdId: 'owner-prd',
      prdDependencies: [],
      status: 'running',
      startTime: 100,
      enqueuedAt: 100,
      completedUS: ['US-001'],
      worktree: '/tmp/owner',
      logPath: path.join(taskDir, 'agent.log'),
      pid: child.pid,
      agent: 'codex',
      repoPath: '/tmp/repo',
      declaredWriteSurface: ['packages/contracts/src/index.ts'],
      observedWriteSurface: ['packages/contracts/src/index.ts'],
      mergeConflictFiles: ['packages/contracts/src/index.ts'],
      repairContext: {
        mode: 'merge',
        storyId: 'US-003',
        createdAt: 123,
        reason: 'Merge repair required by Ralph.',
      },
      currentUS: 'US-003',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli([
      'stop',
      'running-owner',
      '--reason',
      'operator stopped stale repair',
    ], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf-8'));
    const queueResult = runCli(['queue'], { HOME: homeDir });
    const queueOutput = JSON.parse(queueResult.stdout);
    const task = queueOutput.tasks.find((entry) => entry.id === 'running-owner');

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.quarantineReleased, true);
    assert.equal(state.status, 'stopped');
    assert.equal(state.pid, undefined);
    assert.equal(state.quarantineExitKind, 'stop');
    assert.equal(state.quarantineReleaseReason, 'operator stopped stale repair');
    assert.equal(queueResult.status, 0, queueResult.stderr);
    assert.equal(task.attention.reason, 'merge_repair_quarantine_released');
    assert.match(task.nextAction, /released by stop/);
    assert.match(task.nextAction, /operator stopped stale repair/);
  } finally {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {}
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue command honors the global --home option', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-global-home-'));
  const customHome = path.join(homeDir, 'custom-ralph-home');

  try {
    const taskDir = path.join(customHome, 'tasks', 'pending-task');
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

    const result = runCli(['--home', customHome, 'queue'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.ralphHome, customHome);
    assert.equal(output.tasks.length, 1);
    assert.equal(output.tasks[0].id, 'pending-task');
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue command includes completed tasks that still block integration', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-completed-blocker-home-'));

  try {
    const taskDir = path.join(homeDir, '.ralph', 'tasks', 'completed-blocker');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: 'completed-blocker',
      prdPath: '/tmp/prd.json',
      prdId: 'completed-prd',
      prdDependencies: [],
      status: 'completed',
      startTime: Date.now(),
      completedUS: ['US-001'],
      worktree: '',
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      integrationStatus: 'not_started',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['queue'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.tasks.length, 1);
    assert.equal(output.tasks[0].id, 'completed-blocker');
    assert.equal(output.tasks[0].status, 'completed');
    assert.match(output.tasks[0].nextAction, /manager should integrate this completed task/i);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue command includes manager state and aggregate summary in one snapshot', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-manager-summary-home-'));
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

    const runningTaskDir = path.join(homeDir, '.ralph', 'tasks', 'running-task');
    fs.mkdirSync(runningTaskDir, { recursive: true });
    fs.writeFileSync(path.join(runningTaskDir, 'state.json'), JSON.stringify({
      id: 'running-task',
      prdPath: '/tmp/a.json',
      prdId: 'running-prd',
      status: 'running',
      pid: process.pid,
      startTime: Date.now(),
      completedUS: [],
      currentUS: 'US-001',
      worktree: '/tmp/a',
      logPath: path.join(runningTaskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/repo-a',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['queue'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.manager.active, true);
    assert.equal(output.manager.state.pid, process.pid);
    assert.equal(output.summary.totalActive, 1);
    assert.equal(output.summary.byStatus.running, 1);
    assert.ok(Array.isArray(output.attention));
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue command compact mode trims heavy task payload fields', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-compact-home-'));

  try {
    const taskDir = path.join(homeDir, '.ralph', 'tasks', 'compact-task');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: 'compact-task',
      prdId: 'compact-prd',
      prdTitle: 'Compact Queue Payload',
      prdPath: '/tmp/compact.json',
      status: 'ready_to_finalize',
      startTime: Date.now(),
      updatedAt: Date.now(),
      currentUS: 'US-001',
      completedUS: ['US-000'],
      storyProgress: [
        {
          id: 'US-001',
          status: 'in_progress',
          attempts: 2,
          updatedAt: Date.now(),
          history: [
            {
              attempt: 1,
              status: 'failed',
              message: 'first try',
              evidence: 'verbose details',
              updatedAt: Date.now(),
            },
          ],
          lastEvidence: 'long evidence',
          lastError: 'long error',
        },
      ],
      repairContext: {
        mode: 'finalize',
        storyId: 'US-001',
        createdAt: Date.now(),
        reason: 'very long reason that should be stripped from compact mode',
      },
      worktree: '/tmp/worktree',
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      coordinationStatus: 'blocked_observed_overlap',
      coordinationPhase: 'finalize',
      coordinationBlockers: ['task-a'],
      coordinationConflicts: [{
        taskId: 'task-a',
        overlapKinds: ['write_surface'],
        overlappingDomains: [],
        overlappingPaths: ['packages/app/src/index.ts'],
      }],
      coordinationReason: 'shared writes',
      integrationLane: 'main',
      declaredWriteSurface: ['packages/app/src'],
      declaredConflictDomains: ['contracts'],
      observedWriteSurface: ['packages/app/src/index.ts'],
      observedPackageSurface: ['packages/app'],
      surfaceCapturedAt: Date.now(),
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 1,
    }, null, 2));

    const result = runCli(['queue', '--compact'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const task = output.tasks[0];

    assert.equal(result.status, 0, result.stderr);
    assert.equal(task.prdTitle, 'Compact Queue Payload');
    assert.equal(task.worktree, '/tmp/worktree');
    assert.equal(task.completedUS, 1);
    assert.deepEqual(task.storyProgress, [{
      id: 'US-001',
      status: 'in_progress',
      attempts: 2,
      updatedAt: task.storyProgress[0].updatedAt,
    }]);
    assert.deepEqual(task.repairContext, {
      mode: 'finalize',
      storyId: 'US-001',
      createdAt: task.repairContext.createdAt,
    });
    assert.equal(task.integrationStatus, 'not_started');
    assert.equal(task.coordination.status, 'blocked_observed_overlap');
    assert.equal(task.coordination.owner, 'task-a');
    assert.equal(task.coordination.phase, 'finalize');
    assert.equal(task.coordination.lane, 'main');
    assert.equal(task.coordination.reason, 'shared writes');
    assert.deepEqual(task.coordination.blockers, ['task-a']);
    assert.deepEqual(task.coordination.conflicts, [{
      taskId: 'task-a',
      overlapKinds: ['write_surface'],
      overlappingDomains: [],
      overlappingPaths: ['packages/app/src/index.ts'],
    }]);
    assert.equal(task.coordination.observedWriteSurface, undefined);
    assert.equal(task.coordination.declaredConflictDomains, undefined);
    assert.equal(task.storyProgress[0].history, undefined);
    assert.equal(task.repairContext.reason, undefined);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue command suppresses attention for auto-recovering merge repairs already resolved for finalize', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-resolved-merge-repair-home-'));

  try {
    const taskDir = path.join(homeDir, '.ralph', 'tasks', 'resolved-repair-task');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: 'resolved-repair-task',
      prdPath: '/tmp/prd.json',
      prdId: 'resolved-prd',
      status: 'failed_finalize',
      startTime: Date.now(),
      completedUS: ['US-001'],
      worktree: '/tmp/worktree',
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      integrationStatus: 'blocked_conflict',
      autoRecoveryKind: 'merge_repair',
      mergeRepairDisplayStatus: 'resolved_pending_finalize',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['queue'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.summary.totalAttention, 0);
    assert.equal(output.tasks.length, 1);
    assert.equal(output.tasks[0].attention.needed, false);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('queue command includes recent integrated tasks within the configured window', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-queue-recent-completed-home-'));

  try {
    const now = Date.now();
    const recentTaskDir = path.join(homeDir, '.ralph', 'tasks', 'recent-completed');
    const oldTaskDir = path.join(homeDir, '.ralph', 'tasks', 'old-completed');
    fs.mkdirSync(recentTaskDir, { recursive: true });
    fs.mkdirSync(oldTaskDir, { recursive: true });
    fs.writeFileSync(path.join(recentTaskDir, 'state.json'), JSON.stringify({
      id: 'recent-completed',
      prdPath: '/tmp/recent.json',
      prdId: 'recent-prd',
      status: 'completed',
      startTime: now - 10_000,
      completedUS: ['US-001'],
      worktree: '/tmp/recent',
      logPath: path.join(recentTaskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      integrationStatus: 'integrated',
      updatedAt: now - 5_000,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: now - 5_000,
      lastFilesChanged: 1,
    }, null, 2));
    fs.writeFileSync(path.join(oldTaskDir, 'state.json'), JSON.stringify({
      id: 'old-completed',
      prdPath: '/tmp/old.json',
      prdId: 'old-prd',
      status: 'completed',
      startTime: now - 100_000,
      completedUS: ['US-001'],
      worktree: '/tmp/old',
      logPath: path.join(oldTaskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      integrationStatus: 'integrated',
      updatedAt: now - 50_000,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: now - 50_000,
      lastFilesChanged: 1,
    }, null, 2));

    const result = runCli([
      'queue',
      '--recent-completed-window-seconds',
      '10',
      '--recent-completed-limit',
      '3',
    ], { HOME: homeDir });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.summary.recentCompletedCount, 1);
    assert.equal(output.recentCompleted.length, 1);
    assert.equal(output.recentCompleted[0].id, 'recent-completed');
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('batch-start separates skipped blocked and enqueued PRDs during preflight', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-batch-risk-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-batch-risk-repo-'));
  const prdDir = path.join(repoDir, 'prds');

  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
    fs.mkdirSync(path.join(homeDir, '.ralph'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.ralph', 'config.json'), JSON.stringify({
      runner: {
        maxConcurrent: 1,
      },
    }, null, 2));

    const readyPrd = writeRiskPrdFile(prdDir, 'ready-prd');
    const missingDependencyPrd = writeRiskPrdFile(prdDir, 'missing-dependency-prd', {
      dependencies: ['not-enqueued'],
    });
    const activeDuplicatePrd = writeRiskPrdFile(prdDir, 'active-duplicate-prd');
    const completedDuplicatePrd = writeRiskPrdFile(prdDir, 'completed-duplicate-prd');
    const overlapPrd = writeRiskPrdFile(prdDir, 'overlap-prd', {
      writeSurface: ['src/auth/routes.ts'],
    });

    writeRiskTaskState(homeDir, 'active-duplicate-task', {
      prdPath: activeDuplicatePrd,
      prdId: 'active-duplicate-prd',
      status: 'running',
      pid: process.pid,
      repoPath: repoDir,
      worktree: path.join(repoDir, '.ralph-worktrees', 'active-duplicate-task'),
      startTime: 100,
      enqueuedAt: 100,
      lastProgressTime: Date.now(),
    });
    writeRiskTaskState(homeDir, 'completed-duplicate-task', {
      prdPath: completedDuplicatePrd,
      prdId: 'completed-duplicate-prd',
      status: 'completed',
      repoPath: repoDir,
      completedUS: ['US-001'],
      startTime: 50,
      enqueuedAt: 50,
    });
    writeRiskTaskState(homeDir, 'surface-owner-task', {
      prdPath: path.join(prdDir, 'surface-owner.json'),
      prdId: 'surface-owner-prd',
      status: 'running',
      pid: process.pid,
      repoPath: repoDir,
      worktree: path.join(repoDir, '.ralph-worktrees', 'surface-owner-task'),
      declaredWriteSurface: ['src/auth'],
      startTime: 10,
      enqueuedAt: 10,
      lastProgressTime: Date.now(),
    });

    const result = runCli([
      'batch-start',
      readyPrd,
      missingDependencyPrd,
      activeDuplicatePrd,
      completedDuplicatePrd,
      overlapPrd,
      '--repo',
      repoDir,
    ], { HOME: homeDir });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 1, result.stderr);
    assert.equal(output.enqueued.length, 1);
    assert.equal(output.enqueued[0].prdId, 'ready-prd');
    assert.equal(output.blocked.length, 2);
    assert.equal(output.skipped.length, 2);

    const blockedById = new Map(output.blocked.map((entry) => [entry.prdId, entry]));
    const skippedById = new Map(output.skipped.map((entry) => [entry.prdId, entry]));
    assert.deepEqual(blockedById.get('missing-dependency-prd').missingDependencies, ['not-enqueued']);
    assert.ok(blockedById.get('overlap-prd').writeSurfaceOverlaps.length > 0);
    assert.deepEqual(skippedById.get('active-duplicate-prd').activeDuplicates, ['active-duplicate-task']);
    assert.deepEqual(skippedById.get('completed-duplicate-prd').completedDuplicates, ['completed-duplicate-task']);

    const taskIds = fs.readdirSync(path.join(homeDir, '.ralph', 'tasks')).sort();
    assert.equal(taskIds.length, 4);
    assert.ok(taskIds.includes(output.enqueued[0].taskId));
    assert.equal(fs.existsSync(path.join(homeDir, '.ralph', 'tasks', output.enqueued[0].taskId, 'state.json')), true);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('doctor warns when overlap backlog exists but unattended integration is disabled', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-liveness-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-liveness-repo-'));

  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
    fs.mkdirSync(path.join(homeDir, '.ralph', 'tasks', 'completed-blocker'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.ralph', 'tasks', 'completed-blocker', 'state.json'), JSON.stringify({
      id: 'completed-blocker',
      prdPath: '/tmp/prd.json',
      status: 'completed',
      startTime: Date.now(),
      completedUS: ['US-001'],
      worktree: '',
      logPath: path.join(homeDir, '.ralph', 'tasks', 'completed-blocker', 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      integrationStatus: 'not_started',
      coordinationStatus: 'blocked_observed_overlap',
      coordinationBlockers: ['older-task'],
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 0,
    }, null, 2));
    fs.mkdirSync(path.join(homeDir, '.ralph'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.ralph', 'config.json'), JSON.stringify({
      autoMerge: false,
      merge: {
        autoIntegrate: false,
        useIntegrationWorktree: true,
      },
    }, null, 2));

    const result = runCli(['doctor', '--repo', repoDir], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const livenessCheck = output.checks.find((check) => check.name === 'config.integration-liveness');

    assert.equal(result.status, 1);
    assert.equal(livenessCheck.ok, false);
    assert.match(livenessCheck.message, /completed tasks can stall unattended progress/i);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
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

test('doctor command scans a PRD folder for stale status and active duplicates', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-prd-folder-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-prd-folder-repo-'));
  const prdDir = path.join(repoDir, 'prds');

  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
    const activePrd = writeRiskPrdFile(prdDir, 'folder-active-prd');
    const completedStatusPrd = writeRiskPrdFile(prdDir, 'folder-completed-status-prd', {
      status: 'completed',
    });
    const completedDuplicatePrd = writeRiskPrdFile(prdDir, 'folder-completed-duplicate-prd');
    writeRiskPrdFile(prdDir, 'folder-ready-prd');

    writeRiskTaskState(homeDir, 'folder-active-task', {
      prdPath: activePrd,
      prdId: 'folder-active-prd',
      status: 'running',
      pid: process.pid,
      repoPath: repoDir,
      worktree: path.join(repoDir, '.ralph-worktrees', 'folder-active-task'),
      lastProgressTime: Date.now(),
    });
    writeRiskTaskState(homeDir, 'folder-completed-task', {
      prdPath: completedDuplicatePrd,
      prdId: 'folder-completed-duplicate-prd',
      status: 'completed',
      repoPath: repoDir,
      completedUS: ['US-001'],
    });

    const result = runCli([
      'doctor',
      '--repo',
      repoDir,
      '--prd-dir',
      prdDir,
    ], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const prdFolderCheck = output.checks.find((check) => check.name === 'prd.folder');

    assert.equal(result.status, 1, result.stderr);
    assert.equal(prdFolderCheck.ok, false);
    assert.equal(output.prdFolder.total, 4);
    assert.equal(output.prdFolder.ready.length, 1);
    assert.equal(output.prdFolder.activeDuplicates.length, 1);
    assert.equal(output.prdFolder.completedDuplicates.length, 1);
    assert.ok(output.prdFolder.stale.some((entry) => entry.prdId === 'folder-completed-status-prd'));
    assert.ok(output.prdFolder.stale.some((entry) => entry.prdId === 'folder-completed-duplicate-prd'));
    assert.deepEqual(output.prdFolder.activeDuplicates[0].activeDuplicates, ['folder-active-task']);
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
    const taskDirA = path.join(homeDir, '.ralph', 'tasks', 'task-a');
    const taskDirB = path.join(homeDir, '.ralph', 'tasks', 'task-b');
    fs.mkdirSync(taskDirA, { recursive: true });
    fs.mkdirSync(taskDirB, { recursive: true });
    fs.writeFileSync(path.join(taskDirA, 'state.json'), JSON.stringify({
      id: 'task-a',
      prdPath: '/tmp/a.json',
      prdId: 'task-a',
      status: 'running',
      startTime: 1,
      completedUS: [],
      worktree: '/tmp/a',
      logPath: path.join(taskDirA, 'agent.log'),
      agent: 'codex',
      repoPath: '/repo-a',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 1,
      lastFilesChanged: 0,
    }, null, 2));
    fs.writeFileSync(path.join(taskDirB, 'state.json'), JSON.stringify({
      id: 'task-b',
      prdPath: '/tmp/b.json',
      prdId: 'task-b',
      status: 'pending',
      startTime: 2,
      completedUS: [],
      worktree: '',
      logPath: path.join(taskDirB, 'agent.log'),
      agent: 'codex',
      repoPath: '/repo-b',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 2,
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['manager-status'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.ok, true);
    assert.equal(output.active, true);
    assert.equal(output.state.agent, 'codex');
    assert.equal(output.state.backend, 'cli');
    assert.equal(output.mixedRepos, true);
    assert.equal(output.repoCount, 2);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('manager-status command marks outdated manager code as not ok', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-manager-status-drift-home-'));
  const managerDir = path.join(homeDir, '.ralph', 'manager');
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-manager-status-drift-repo-'));
  const distDir = path.join(repoDir, 'dist');
  const entryPath = path.join(distDir, 'cli.js');
  const dependencyPath = path.join(distDir, 'core', 'finalize-repair-policy.js');

  try {
    fs.mkdirSync(managerDir, { recursive: true });
    fs.mkdirSync(path.dirname(dependencyPath), { recursive: true });
    fs.writeFileSync(entryPath, 'console.log("entry");\n');
    fs.writeFileSync(dependencyPath, 'console.log("dep");\n');
    fs.utimesSync(entryPath, 1, 1);
    fs.utimesSync(dependencyPath, 5, 5);
    fs.writeFileSync(path.join(managerDir, 'state.json'), JSON.stringify({
      pid: process.pid,
      status: 'running',
      startedAt: 2000,
      updatedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      pollIntervalMs: 10000,
      autoIngestEnabled: false,
      repo: '/tmp/repo',
      agent: 'codex',
      backend: 'cli',
      hostname: 'test-host',
      argv: ['node', entryPath, 'manager'],
    }, null, 2));

    const result = runCli(['manager-status'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.ok, false);
    assert.equal(output.codeDriftDetected, true);
    assert.equal(output.managerCodeLatestPath, dependencyPath);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('doctor command reports mixed active repos in the Ralph home', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-mixed-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-mixed-repo-'));

  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
    const taskDirA = path.join(homeDir, '.ralph', 'tasks', 'task-a');
    const taskDirB = path.join(homeDir, '.ralph', 'tasks', 'task-b');
    fs.mkdirSync(taskDirA, { recursive: true });
    fs.mkdirSync(taskDirB, { recursive: true });
    fs.writeFileSync(path.join(taskDirA, 'state.json'), JSON.stringify({
      id: 'task-a',
      prdPath: '/tmp/a.json',
      prdId: 'task-a',
      status: 'running',
      startTime: 1,
      completedUS: [],
      worktree: '/tmp/a',
      logPath: path.join(taskDirA, 'agent.log'),
      agent: 'codex',
      repoPath: '/repo-a',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 1,
      lastFilesChanged: 0,
    }, null, 2));
    fs.writeFileSync(path.join(taskDirB, 'state.json'), JSON.stringify({
      id: 'task-b',
      prdPath: '/tmp/b.json',
      prdId: 'task-b',
      status: 'pending',
      startTime: 2,
      completedUS: [],
      worktree: '',
      logPath: path.join(taskDirB, 'agent.log'),
      agent: 'codex',
      repoPath: '/repo-b',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 2,
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['doctor', '--repo', repoDir], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const repoCheck = output.checks.find((check) => check.name === 'ralph.home.repos');

    assert.equal(result.status, 1, result.stderr);
    assert.equal(output.mixedRepos, true);
    assert.equal(output.repoCount, 2);
    assert.equal(repoCheck.ok, false);
    assert.match(repoCheck.message, /multiple repos/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('doctor command fails when the Ralph home is already active for a different repo', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-foreign-home-'));
  const repoA = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-foreign-a-'));
  const repoB = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-foreign-b-'));

  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoA, stdio: 'ignore' });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoB, stdio: 'ignore' });
    const taskDir = path.join(homeDir, '.ralph', 'tasks', 'task-a');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: 'task-a',
      prdPath: path.join(repoA, 'a.json'),
      prdId: 'task-a',
      status: 'running',
      startTime: 1,
      completedUS: [],
      worktree: path.join(repoA, '.ralph-worktrees', 'task-a'),
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: repoA,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 1,
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['doctor', '--repo', repoB], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const repoCheck = output.checks.find((check) => check.name === 'ralph.home.repos');

    assert.equal(result.status, 1, result.stderr);
    assert.equal(output.mixedRepos, false);
    assert.equal(output.repoCount, 1);
    assert.equal(repoCheck.ok, false);
    assert.match(repoCheck.message, /different repo/i);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoA, { recursive: true, force: true });
    fs.rmSync(repoB, { recursive: true, force: true });
  }
});

test('manager command refuses to start when the Ralph home mixes active repos', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-manager-mixed-home-'));

  try {
    const taskDirA = path.join(homeDir, '.ralph', 'tasks', 'task-a');
    const taskDirB = path.join(homeDir, '.ralph', 'tasks', 'task-b');
    fs.mkdirSync(taskDirA, { recursive: true });
    fs.mkdirSync(taskDirB, { recursive: true });
    fs.writeFileSync(path.join(taskDirA, 'state.json'), JSON.stringify({
      id: 'task-a',
      prdPath: '/tmp/a.json',
      prdId: 'task-a',
      status: 'running',
      startTime: 1,
      completedUS: [],
      worktree: '/tmp/a',
      logPath: path.join(taskDirA, 'agent.log'),
      agent: 'codex',
      repoPath: '/repo-a',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 1,
      lastFilesChanged: 0,
    }, null, 2));
    fs.writeFileSync(path.join(taskDirB, 'state.json'), JSON.stringify({
      id: 'task-b',
      prdPath: '/tmp/b.json',
      prdId: 'task-b',
      status: 'pending',
      startTime: 2,
      completedUS: [],
      worktree: '',
      logPath: path.join(taskDirB, 'agent.log'),
      agent: 'codex',
      repoPath: '/repo-b',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 2,
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli(['manager', '--repo', '/repo-a'], { HOME: homeDir });
    const output = JSON.parse(result.stderr);

    assert.equal(result.status, 1);
    assert.match(output.error, /active tasks from multiple repos/i);
    assert.match(output.error, /--allow-mixed-home/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('doctor command fails when manager code is older than current dist on disk', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-drift-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-doctor-drift-repo-'));
  const managerDir = path.join(homeDir, '.ralph', 'manager');
  const distDir = path.join(repoDir, 'dist');
  const entryPath = path.join(distDir, 'cli.js');
  const dependencyPath = path.join(distDir, 'core', 'dependency-watcher.js');

  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
    fs.mkdirSync(managerDir, { recursive: true });
    fs.mkdirSync(path.dirname(dependencyPath), { recursive: true });
    fs.writeFileSync(entryPath, 'console.log("entry");\n');
    fs.writeFileSync(dependencyPath, 'console.log("dep");\n');
    fs.utimesSync(entryPath, 1, 1);
    fs.utimesSync(dependencyPath, 5, 5);
    fs.writeFileSync(path.join(managerDir, 'state.json'), JSON.stringify({
      pid: process.pid,
      status: 'running',
      startedAt: 2000,
      updatedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      pollIntervalMs: 10000,
      autoIngestEnabled: false,
      repo: repoDir,
      agent: 'codex',
      backend: 'cli',
      hostname: 'test-host',
      argv: ['node', entryPath, 'manager'],
    }, null, 2));

    const result = runCli(['doctor', '--repo', repoDir], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const managerCheck = output.checks.find((check) => check.name === 'manager');

    assert.equal(result.status, 1);
    assert.equal(output.ok, false);
    assert.equal(output.manager.codeDriftDetected, true);
    assert.match(managerCheck.message, /older than current code on disk/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('finalize command keeps task ready_to_finalize when blocked by an earlier overlapping task', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalize-coordination-home-'));

  try {
    const taskDirA = path.join(homeDir, '.ralph', 'tasks', 'task-a');
    const taskDirB = path.join(homeDir, '.ralph', 'tasks', 'task-b');
    fs.mkdirSync(taskDirA, { recursive: true });
    fs.mkdirSync(taskDirB, { recursive: true });

    fs.writeFileSync(path.join(taskDirA, 'state.json'), JSON.stringify({
      id: 'task-a',
      prdPath: '/tmp/a.json',
      prdId: 'task-a',
      status: 'ready_to_finalize',
      startTime: 100,
      enqueuedAt: 100,
      completedUS: ['US-001'],
      observedWriteSurface: ['packages/contracts/src/index.ts'],
      worktree: '',
      logPath: path.join(taskDirA, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
    }, null, 2));
    fs.writeFileSync(path.join(taskDirB, 'state.json'), JSON.stringify({
      id: 'task-b',
      prdPath: '/tmp/b.json',
      prdId: 'task-b',
      status: 'ready_to_finalize',
      startTime: 200,
      enqueuedAt: 200,
      completedUS: ['US-001'],
      observedWriteSurface: ['packages/contracts/src/index.ts'],
      worktree: '',
      logPath: path.join(taskDirB, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 200,
      lastFilesChanged: 1,
    }, null, 2));

    const result = runCli(['finalize', 'task-b'], { HOME: homeDir });
    const output = JSON.parse(result.stderr);
    const state = JSON.parse(fs.readFileSync(path.join(taskDirB, 'state.json'), 'utf-8'));

    assert.equal(result.status, 1);
    assert.equal(output.blocked, true);
    assert.deepEqual(output.blockers, ['task-a']);
    assert.equal(state.status, 'ready_to_finalize');
    assert.equal(state.coordinationStatus, 'blocked_observed_overlap');
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('merge command blocks completed task when an earlier overlapping task is not yet integrated', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-merge-coordination-home-'));

  try {
    const taskDirA = path.join(homeDir, '.ralph', 'tasks', 'task-a');
    const taskDirB = path.join(homeDir, '.ralph', 'tasks', 'task-b');
    fs.mkdirSync(taskDirA, { recursive: true });
    fs.mkdirSync(taskDirB, { recursive: true });

    fs.writeFileSync(path.join(taskDirA, 'state.json'), JSON.stringify({
      id: 'task-a',
      prdPath: '/tmp/a.json',
      prdId: 'task-a',
      status: 'completed',
      startTime: 100,
      enqueuedAt: 100,
      completedUS: ['US-001'],
      observedWriteSurface: ['packages/contracts/src/index.ts'],
      worktree: '',
      logPath: path.join(taskDirA, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
    }, null, 2));
    fs.writeFileSync(path.join(taskDirB, 'state.json'), JSON.stringify({
      id: 'task-b',
      prdPath: '/tmp/b.json',
      prdId: 'task-b',
      status: 'completed',
      startTime: 200,
      enqueuedAt: 200,
      completedUS: ['US-001'],
      observedWriteSurface: ['packages/contracts/src/index.ts'],
      worktree: '',
      logPath: path.join(taskDirB, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 200,
      lastFilesChanged: 1,
    }, null, 2));

    const result = runCli(['merge', 'task-b'], { HOME: homeDir });
    const output = JSON.parse(result.stderr.trim().split('\n').pop());
    const state = JSON.parse(fs.readFileSync(path.join(taskDirB, 'state.json'), 'utf-8'));

    assert.equal(result.status, 1);
    assert.equal(output.blocked, true);
    assert.deepEqual(output.blockers, ['task-a']);
    assert.equal(state.status, 'completed');
    assert.equal(state.coordinationStatus, 'blocked_observed_overlap');
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

test('manager-install defaults to a home-specific label and log paths for custom Ralph homes', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-manager-install-custom-home-'));
  const customHome = path.join(homeDir, 'custom-ralph-home');
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-manager-install-custom-repo-'));

  try {
    const result = runCli([
      '--home',
      customHome,
      'manager-install',
      '--dry-run',
      '--repo',
      repoDir,
      '--disable-auto-ingest-ez4ielts',
    ], { HOME: homeDir });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.ralphHome, customHome);
    assert.match(output.label, /^com\.ralph\.manager\.[0-9a-f]{8}$/);
    assert.equal(output.stdoutPath, path.join(customHome, 'logs', 'manager.out.log'));
    assert.equal(output.stderrPath, path.join(customHome, 'logs', 'manager.err.log'));
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

test('prove-integration clears completed blocked_conflict via exact mergeability without resetting unrelated stories', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-proof-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-proof-repo-'));
  const taskId = 'completed-proof-task';
  const worktreePath = path.join(repoDir, '.ralph-worktrees', taskId);
  const taskDir = path.join(homeDir, '.ralph', 'tasks', taskId);

  try {
    git(repoDir, ['init', '-b', 'main']);
    git(repoDir, ['config', 'user.name', 'Ralph Test']);
    git(repoDir, ['config', 'user.email', 'ralph@example.com']);
    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'base\n');
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-m', 'base']);
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(repoDir, ['worktree', 'add', '-b', `ralph/${taskId}`, worktreePath, 'main']);
    fs.appendFileSync(path.join(worktreePath, 'feature.txt'), 'task change\n');
    git(worktreePath, ['add', 'feature.txt']);
    git(worktreePath, ['commit', '-m', 'feat: task change']);
    fs.writeFileSync(path.join(repoDir, 'other.txt'), 'main change\n');
    git(repoDir, ['add', 'other.txt']);
    git(repoDir, ['commit', '-m', 'feat: main change']);

    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: taskId,
      prdPath: path.join(repoDir, 'prd.json'),
      prdId: 'proof-prd',
      status: 'completed',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-002', status: 'needs_repair', attempts: 2, lastError: 'merge conflict', updatedAt: 1 },
      ],
      worktree: worktreePath,
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      integrationStatus: 'blocked_conflict',
      integrationBranch: 'ralph/integration/main',
      integrationWorktree: path.join(repoDir, '.ralph-integration', 'main'),
      mergeError: 'Merge conflicts detected: feature.txt',
      mergeConflictFiles: ['feature.txt'],
      repairContext: {
        mode: 'merge',
        storyId: 'US-002',
        createdAt: 123,
        reason: 'Merge repair required by Ralph.',
      },
      quarantineExitKind: 'demote',
      quarantineReleasedAt: 456,
      quarantineReleaseReason: 'old release marker',
    }, null, 2));

    const result = runCli(['prove-integration', taskId, '--target', 'main'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf-8'));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.outcome, 'exact_mergeability');
    assert.equal(state.status, 'completed');
    assert.equal(state.integrationStatus, 'not_started');
    assert.deepEqual(state.completedUS, ['US-001', 'US-002']);
    assert.equal(state.storyProgress[0].status, 'passed');
    assert.equal(state.storyProgress[0].attempts, 1);
    assert.equal(state.storyProgress[1].status, 'passed');
    assert.equal(state.storyProgress[1].attempts, 2);
    assert.equal(state.mergeError, undefined);
    assert.equal(state.mergeConflictFiles, undefined);
    assert.equal(state.repairContext, undefined);
    assert.equal(state.quarantineExitKind, undefined);
    assert.equal(state.quarantineReleasedAt, undefined);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('prove-integration marks already-integrated quarantine owners integrated', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-proof-integrated-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-proof-integrated-repo-'));
  const taskId = 'already-integrated-proof-task';
  const worktreePath = path.join(repoDir, '.ralph-worktrees', taskId);
  const taskDir = path.join(homeDir, '.ralph', 'tasks', taskId);

  try {
    git(repoDir, ['init', '-b', 'main']);
    git(repoDir, ['config', 'user.name', 'Ralph Test']);
    git(repoDir, ['config', 'user.email', 'ralph@example.com']);
    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'base\n');
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-m', 'base']);
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(repoDir, ['worktree', 'add', '-b', `ralph/${taskId}`, worktreePath, 'main']);
    fs.appendFileSync(path.join(worktreePath, 'feature.txt'), 'task change\n');
    git(worktreePath, ['add', 'feature.txt']);
    git(worktreePath, ['commit', '-m', 'feat: task change']);
    git(repoDir, ['branch', 'ralph/integration/main', `ralph/${taskId}`]);

    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: taskId,
      prdPath: path.join(repoDir, 'prd.json'),
      prdId: 'integrated-proof-prd',
      status: 'failed',
      startTime: 100,
      completedUS: ['US-001'],
      storyProgress: [
        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
      ],
      worktree: worktreePath,
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: repoDir,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 1,
      integrationStatus: 'blocked_conflict',
      mergeError: 'Merge conflicts detected: feature.txt',
      mergeConflictFiles: ['feature.txt'],
      repairContext: {
        mode: 'merge',
        storyId: 'US-001',
        createdAt: 123,
        reason: 'Merge repair required by Ralph.',
      },
    }, null, 2));

    const result = runCli(['prove-integration', taskId, '--target', 'main'], { HOME: homeDir });
    const output = JSON.parse(result.stdout);
    const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf-8'));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.outcome, 'already_integrated');
    assert.equal(state.status, 'completed');
    assert.equal(state.integrationStatus, 'integrated');
    assert.equal(typeof state.integratedAt, 'number');
    assert.equal(state.mergeError, undefined);
    assert.equal(state.mergeConflictFiles, undefined);
    assert.equal(state.repairContext, undefined);
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
