const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { StateManager } = require('../dist/core/state.js');
const { getTaskPRDPath, loadTaskPRD } = require('../dist/utils/helpers.js');
const { updateCommand } = require('../dist/commands/update.js');
const { statusCommand } = require('../dist/commands/status.js');

function createTask(homeDir, prdPath) {
  const taskId = 'task-test-prd';
  return {
    id: taskId,
    prdPath,
    status: 'pending',
    startTime: Date.now(),
    completedUS: [],
    worktree: '',
    logPath: path.join(homeDir, '.ralph', 'tasks', taskId, 'agent.log'),
    agent: 'codex',
    repoPath: homeDir,
    loopCount: 0,
    consecutiveNoProgress: 0,
    consecutiveErrors: 0,
    lastProgressTime: Date.now(),
    lastFilesChanged: 0,
  };
}

test('task PRD snapshot powers update and detailed status', async () => {
  const previousHome = process.env.HOME;
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-home-'));
  const prdPath = path.join(homeDir, 'prd.md');
  const originalConsoleLog = console.log;
  const output = [];

  fs.writeFileSync(prdPath, `---
id: prd-auth
title: User Authentication System
description: Implement secure user authentication with JWT
userStories:
  - id: US-001
    title: User Registration
    description: As a new user, I want to register an account
    acceptanceCriteria:
      - Email validation
dependencies: []
---
`);

  try {
    process.env.HOME = homeDir;
    console.log = (message) => output.push(String(message));

    const stateManager = new StateManager();
    const task = createTask(homeDir, prdPath);
    await stateManager.saveTask(task);

    const loadedPrd = loadTaskPRD(task);
    assert.equal(loadedPrd.userStories.length, 1);
    assert.equal(fs.existsSync(getTaskPRDPath(task)), true);

    await updateCommand(task.id, {
      storyId: 'US-001',
      passes: true,
      notes: 'Validated manually',
    });

    const updatedTask = await stateManager.loadTask(task.id);
    assert.deepEqual(updatedTask.completedUS, ['US-001']);

    const snapshotPrd = JSON.parse(fs.readFileSync(getTaskPRDPath(task), 'utf-8'));
    assert.equal(snapshotPrd.userStories[0].passes, true);
    assert.equal(snapshotPrd.userStories[0].notes, 'Validated manually');

    output.length = 0;
    await statusCommand(task.id, { detailed: true });
    const detailed = JSON.parse(output[0]);

    assert.deepEqual(detailed.progress, {
      completed: 1,
      total: 1,
      percentage: 100,
    });
    assert.equal(detailed.userStories[0].passes, true);
    assert.equal(detailed.userStories[0].notes, 'Validated manually');
  } finally {
    console.log = originalConsoleLog;
    process.env.HOME = previousHome;
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
