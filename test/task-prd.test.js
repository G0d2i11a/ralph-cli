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
    assert.equal(detailed.delivery.integrationStatus, 'not_started');
    assert.equal(detailed.delivery.targetSyncStatus, 'not_requested');
    assert.equal(detailed.userStories[0].passes, true);
    assert.equal(detailed.userStories[0].notes, 'Validated manually');
  } finally {
    console.log = originalConsoleLog;
    process.env.HOME = previousHome;
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('status command includes concise validation evidence summary', async () => {
  const previousHome = process.env.HOME;
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-status-evidence-home-'));
  const prdPath = path.join(homeDir, 'prd.json');
  const originalConsoleLog = console.log;
  const output = [];

  fs.writeFileSync(prdPath, JSON.stringify({
    id: 'prd-validation-summary',
    title: 'Validation Summary',
    description: 'Expose validation evidence in status output',
    userStories: [],
    dependencies: [],
  }, null, 2));

  try {
    process.env.HOME = homeDir;
    console.log = (message) => output.push(String(message));

    const stateManager = new StateManager();
    await stateManager.saveTask({
      ...createTask(homeDir, prdPath),
      id: 'task-validation-summary',
      status: 'completed',
      validationEvidence: {
        schemaVersion: 1,
        source: 'finalizer',
        taskId: 'task-validation-summary',
        generatedAt: 1_700_000_000_000,
        configuredGates: ['typecheck', 'lint'],
        summary: {
          total: 2,
          passed: 1,
          failed: 0,
          skipped: 1,
          classifications: {
            passed: 1,
            skipped: 1,
          },
        },
        runs: [
          {
            phase: 'quality_gate',
            requestedGate: 'typecheck',
            gate: 'typecheck',
            status: 'passed',
            classification: 'passed',
            packageLabel: 'app',
            command: 'npm run typecheck',
            exitCode: 0,
            durationMs: 42,
            stdoutSummary: { byteLength: 2048, lineCount: 80, truncated: true, excerpt: 'verbose output' },
          },
          {
            phase: 'quality_gate',
            requestedGate: 'lint',
            gate: 'lint',
            status: 'skipped',
            classification: 'skipped',
            packageLabel: 'app',
            reason: 'script "lint" is not defined for app',
          },
        ],
      },
    });

    await statusCommand('task-validation-summary');
    const status = JSON.parse(output[0]);

    assert.equal(status.validationEvidenceSummary.total, 2);
    assert.equal(status.validationEvidenceSummary.passed, 1);
    assert.equal(status.validationEvidenceSummary.skipped, 1);
    assert.deepEqual(status.validationEvidenceSummary.configuredGates, ['typecheck', 'lint']);
    assert.deepEqual(
      status.validationEvidenceSummary.gates.map((gate) => ({
        requestedGate: gate.requestedGate,
        status: gate.status,
      })),
      [
        { requestedGate: 'typecheck', status: 'passed' },
        { requestedGate: 'lint', status: 'skipped' },
      ],
    );
    assert.equal(status.validationEvidenceSummary.gates[0].stdoutSummary, undefined);
    assert.equal(status.validationEvidenceSummary.gates[1].reason, 'script "lint" is not defined for app');
  } finally {
    console.log = originalConsoleLog;
    process.env.HOME = previousHome;
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
