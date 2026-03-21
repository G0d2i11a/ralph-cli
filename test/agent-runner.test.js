const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');

function createSdkRunnerFixture(rootDir) {
  const sdkRunnerPath = path.join(rootDir, 'sdk-runners', 'dist', 'cli.js');
  fs.mkdirSync(path.dirname(sdkRunnerPath), { recursive: true });
  fs.writeFileSync(sdkRunnerPath, '#!/usr/bin/env node\n');
  return sdkRunnerPath;
}

function createMockChild({ exitCode = 0, stdoutLines = [], closeOnKill = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killSignals = [];
  child.kill = (signal = 'SIGTERM') => {
    child.killSignals.push(signal);
    if (closeOnKill) {
      process.nextTick(() => child.emit('close', signal === 'SIGKILL' ? 137 : 124));
    }
  };

  if (exitCode !== null) {
    process.nextTick(() => {
      for (const line of stdoutLines) {
        child.stdout.emit('data', Buffer.from(`${line}\n`));
      }
      child.emit('close', exitCode);
    });
  }

  return child;
}

async function cleanupPath(targetPath) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await fs.promises.rm(targetPath, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20,
      });
      return;
    } catch (error) {
      if (attempt === 9) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

test('AgentRunner defaults Codex to the direct CLI backend', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-agent-codex-'));
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-agent-worktree-'));
  const logPath = path.join(tempRoot, 'agent.log');
  const previousHome = process.env.HOME;
  const previousRunnerPath = process.env.RALPH_SDK_RUNNER_CLI;
  const originalSpawn = childProcess.spawn;

  let captured;

  try {
    process.env.HOME = tempRoot;
    delete process.env.RALPH_SDK_RUNNER_CLI;
    childProcess.spawn = (command, args, options) => {
      captured = { command, args, options };
      return createMockChild({
        stdoutLines: [JSON.stringify({ kind: 'final', payload: { status: 'success' } })],
      });
    };

    const { AgentRunner } = require('../dist/core/agent.js');
    const runner = new AgentRunner();

    const result = await runner.runUserStory(
      {
        id: 'US-1',
        title: 'Codex smoke',
        description: 'Use the unified runner path.',
        acceptanceCriteria: ['Reply with OK in the summary.'],
      },
      worktreePath,
      'codex',
      logPath,
    );

    assert.equal(result.success, true);
    assert.ok(captured, 'spawn should be called');
    assert.equal(captured.command, 'codex');
    assert.equal(captured.args[0], 'exec');
    assert.match(captured.args[1], /Codex smoke/);
    assert.equal(captured.args[2], '--full-auto');
    assert.equal(captured.options.cwd, worktreePath);
    assert.ok(!captured.args.includes('--cwd'));
    assert.ok(!captured.args.includes('--log'));
  } finally {
    childProcess.spawn = originalSpawn;
    process.env.HOME = previousHome;
    if (previousRunnerPath === undefined) {
      delete process.env.RALPH_SDK_RUNNER_CLI;
    } else {
      process.env.RALPH_SDK_RUNNER_CLI = previousRunnerPath;
    }
    await cleanupPath(tempRoot);
    await cleanupPath(worktreePath);
    delete require.cache[require.resolve('../dist/core/agent.js')];
  }
});

test('AgentRunner persists and resumes Codex thread ids via sdk-runners CLI', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-agent-codex-thread-'));
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-agent-worktree-'));
  const logPath = path.join(tempRoot, 'agent.log');
  const previousHome = process.env.HOME;
  const previousRunnerPath = process.env.RALPH_SDK_RUNNER_CLI;
  const originalSpawn = childProcess.spawn;
  const capturedCalls = [];

  try {
    process.env.HOME = tempRoot;
    process.env.RALPH_SDK_RUNNER_CLI = createSdkRunnerFixture(tempRoot);
    childProcess.spawn = (command, args, options) => {
      capturedCalls.push({ command, args, options });
      return createMockChild({
        stdoutLines: [JSON.stringify({ kind: 'final', payload: { threadId: 'codex-thread-1' } })],
      });
    };

    const { AgentRunner } = require('../dist/core/agent.js');
    const runner = new AgentRunner();

    const first = await runner.runUserStory(
      {
        id: 'US-1',
        title: 'Codex thread capture',
        description: 'Capture and return the Codex thread id.',
        acceptanceCriteria: ['Reply with OK in the summary.'],
      },
      worktreePath,
      'codex',
      logPath,
      'sdk-runner',
    );

    const second = await runner.runUserStory(
      {
        id: 'US-2',
        title: 'Codex thread resume',
        description: 'Resume the previously captured Codex thread.',
        acceptanceCriteria: ['Reply with OK in the summary.'],
      },
      worktreePath,
      'codex',
      logPath,
      'sdk-runner',
      { threadId: first.threadId },
    );

    assert.equal(first.success, true);
    assert.equal(first.threadId, 'codex-thread-1');
    assert.equal(second.success, true);
    assert.equal(second.threadId, 'codex-thread-1');
    assert.equal(capturedCalls.length, 2);
    assert.deepEqual(capturedCalls[0].args.slice(0, 2), [process.env.RALPH_SDK_RUNNER_CLI, 'codex']);
    assert.ok(!capturedCalls[0].args.includes('--resume-thread'));
    assert.deepEqual(capturedCalls[1].args.slice(0, 2), [process.env.RALPH_SDK_RUNNER_CLI, 'codex']);
    assert.ok(capturedCalls[1].args.includes('--resume-thread'));
    assert.ok(capturedCalls[1].args.includes('codex-thread-1'));
  } finally {
    childProcess.spawn = originalSpawn;
    process.env.HOME = previousHome;
    if (previousRunnerPath === undefined) {
      delete process.env.RALPH_SDK_RUNNER_CLI;
    } else {
      process.env.RALPH_SDK_RUNNER_CLI = previousRunnerPath;
    }
    await cleanupPath(tempRoot);
    await cleanupPath(worktreePath);
    delete require.cache[require.resolve('../dist/core/agent.js')];
  }
});

test('AgentRunner preserves Claude sdk-runner model and resume args', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-agent-claude-'));
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-agent-worktree-'));
  const logPath = path.join(tempRoot, 'agent.log');
  const previousHome = process.env.HOME;
  const previousRunnerPath = process.env.RALPH_SDK_RUNNER_CLI;
  const originalSpawn = childProcess.spawn;

  let captured;

  try {
    process.env.HOME = tempRoot;
    process.env.RALPH_SDK_RUNNER_CLI = createSdkRunnerFixture(tempRoot);
    fs.mkdirSync(path.join(tempRoot, '.ralph'), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, '.ralph', 'config.json'),
      JSON.stringify({
        agent: {
          path: 'codex',
          sdkRunnerPath: process.env.RALPH_SDK_RUNNER_CLI,
          timeout: 600,
          model: 'claude-test-model',
        },
      }),
    );

    childProcess.spawn = (command, args, options) => {
      captured = { command, args, options };
      return createMockChild({
        stdoutLines: [JSON.stringify({ kind: 'final', payload: { sessionId: 'claude-session-1' } })],
      });
    };

    const { AgentRunner } = require('../dist/core/agent.js');
    const runner = new AgentRunner();

    const result = await runner.runUserStory(
      {
        id: 'US-2',
        title: 'Claude smoke',
        description: 'Keep existing behavior.',
        acceptanceCriteria: ['Reply with OK in the summary.'],
      },
      worktreePath,
      'claude',
      logPath,
      'sdk-runner',
      { sessionId: 'resume-session-123' },
    );

    assert.equal(result.success, true);
    assert.equal(result.sessionId, 'claude-session-1');
    assert.equal(captured.command, 'node');
    assert.deepEqual(captured.args.slice(0, 2), [process.env.RALPH_SDK_RUNNER_CLI, 'claude']);
    assert.ok(captured.args.includes('--model'));
    assert.ok(captured.args.includes('claude-test-model'));
    assert.ok(captured.args.includes('--resume'));
    assert.ok(captured.args.includes('resume-session-123'));
  } finally {
    childProcess.spawn = originalSpawn;
    process.env.HOME = previousHome;
    if (previousRunnerPath === undefined) {
      delete process.env.RALPH_SDK_RUNNER_CLI;
    } else {
      process.env.RALPH_SDK_RUNNER_CLI = previousRunnerPath;
    }
    await cleanupPath(tempRoot);
    await cleanupPath(worktreePath);
    delete require.cache[require.resolve('../dist/core/agent.js')];
  }
});

test('AgentRunner enforces configured timeout', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-agent-timeout-'));
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-agent-worktree-'));
  const logPath = path.join(tempRoot, 'agent.log');
  const previousHome = process.env.HOME;
  const previousRunnerPath = process.env.RALPH_SDK_RUNNER_CLI;
  const originalSpawn = childProcess.spawn;

  let child;

  try {
    process.env.HOME = tempRoot;
    process.env.RALPH_SDK_RUNNER_CLI = createSdkRunnerFixture(tempRoot);
    fs.mkdirSync(path.join(tempRoot, '.ralph'), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, '.ralph', 'config.json'),
      JSON.stringify({
        agent: {
          sdkRunnerPath: process.env.RALPH_SDK_RUNNER_CLI,
          timeout: 0.01,
        },
      }),
    );

    childProcess.spawn = () => {
      child = createMockChild({ exitCode: null, closeOnKill: true });
      return child;
    };

    const { AgentRunner } = require('../dist/core/agent.js');
    const runner = new AgentRunner();

    const result = await runner.runUserStory(
      {
        id: 'US-3',
        title: 'Timeout smoke',
        description: 'Ensure timeouts terminate the run.',
        acceptanceCriteria: ['Finish quickly.'],
      },
      worktreePath,
      'codex',
      logPath,
      'sdk-runner',
    );

    assert.equal(result.success, false);
    assert.ok(child.killSignals.includes('SIGTERM'));
    assert.match(result.output, /Timed out after/);
  } finally {
    childProcess.spawn = originalSpawn;
    process.env.HOME = previousHome;
    if (previousRunnerPath === undefined) {
      delete process.env.RALPH_SDK_RUNNER_CLI;
    } else {
      process.env.RALPH_SDK_RUNNER_CLI = previousRunnerPath;
    }
    await cleanupPath(tempRoot);
    await cleanupPath(worktreePath);
    delete require.cache[require.resolve('../dist/core/agent.js')];
  }
});
