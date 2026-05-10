const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  decideWatchdogRestart,
} = require('../dist/commands/watchdog.js');

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

function createSnapshot(overrides = {}) {
  return {
    manager: {
      codeDriftDetected: false,
      heartbeatStale: false,
      heartbeatStaleSuppressed: false,
      stateExists: true,
      state: {
        status: 'running',
      },
      processRunning: true,
      ...overrides.manager,
    },
    summary: {
      running: 0,
      recovering: 0,
      waitingRecovery: 0,
      ...overrides.summary,
    },
    tasks: overrides.tasks || [],
  };
}

test('watchdog restarts managers with code drift', () => {
  const decision = decideWatchdogRestart(createSnapshot({
    manager: {
      codeDriftDetected: true,
    },
  }));

  assert.equal(decision.needed, true);
  assert.deepEqual(decision.reasons, ['manager_code_drift']);
  assert.equal(decision.deferredReason, undefined);
});

test('watchdog defers restarts while a manager-owned finalizer is active', () => {
  const decision = decideWatchdogRestart(createSnapshot({
    manager: {
      codeDriftDetected: true,
    },
    tasks: [
      {
        id: 'task-finalizing',
        status: 'finalizing',
      },
    ],
  }));

  assert.equal(decision.needed, true);
  assert.deepEqual(decision.reasons, ['manager_code_drift']);
  assert.equal(decision.deferredReason, 'manager_owned_finalizer_active');
});

test('watchdog defers code-drift restarts while work is in flight', () => {
  const decision = decideWatchdogRestart(createSnapshot({
    manager: {
      codeDriftDetected: true,
    },
    summary: {
      running: 2,
      recovering: 1,
      waitingRecovery: 0,
    },
    tasks: [
      {
        id: 'running-task',
        status: 'running',
      },
    ],
  }));

  assert.equal(decision.needed, true);
  assert.deepEqual(decision.reasons, ['manager_code_drift']);
  assert.equal(decision.deferredReason, 'active_tasks_in_flight');
});

test('watchdog does not defer code-drift restarts for stopped recovery display states', () => {
  const decision = decideWatchdogRestart(createSnapshot({
    manager: {
      codeDriftDetected: true,
    },
    summary: {
      running: 0,
      recovering: 3,
      waitingRecovery: 1,
    },
    tasks: [
      {
        id: 'stopped-recovery',
        status: 'failed',
        queueState: {
          phase: 'recovering',
          recovery: {
            active: false,
          },
        },
      },
    ],
  }));

  assert.equal(decision.needed, true);
  assert.deepEqual(decision.reasons, ['manager_code_drift']);
  assert.equal(decision.deferredReason, undefined);
});

test('watchdog once reports queue actions and writes JSONL event log', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-watchdog-home-'));
  const ralphHome = path.join(homeDir, '.ralph-target');
  const taskDir = path.join(ralphHome, 'tasks', 'failed-task');
  const logPath = path.join(homeDir, 'watchdog.jsonl');

  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: 'failed-task',
      prdPath: '/tmp/prd.json',
      prdId: 'prd-failed',
      prdDependencies: [],
      status: 'failed',
      startTime: 100,
      completedUS: [],
      worktree: '/tmp/worktree',
      logPath: path.join(taskDir, 'agent.log'),
      agent: 'codex',
      repoPath: '/tmp/repo',
      lastErrorKind: 'semantic_failure',
      lastErrorRetryable: false,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 100,
      lastFilesChanged: 0,
    }, null, 2));

    const result = runCli([
      'watchdog',
      '--once',
      '--home-path',
      ralphHome,
      '--log',
      logPath,
      '--no-restart-code-drift',
      '--no-restart-stale',
    ], { HOME: homeDir });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.targetCount, 1);
    assert.equal(output.results[0].totalActions, 1);

    const events = fs.readFileSync(logPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'queue_action_detected');
    assert.equal(events[0].actions[0].id, 'failed-task');
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
