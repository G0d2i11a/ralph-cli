const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');

function createAgentRunnersFixture(rootDir) {
  const agentRunnersPath = path.join(rootDir, 'agent-runners', 'dist', 'cli.js');
  fs.mkdirSync(path.dirname(agentRunnersPath), { recursive: true });
  fs.writeFileSync(agentRunnersPath, '#!/usr/bin/env node\n');
  return agentRunnersPath;
}

function createMockChild({ exitCode = 0, stdoutLines = [], closeOnKill = true, killExitCode } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killSignals = [];
  child.kill = (signal = 'SIGTERM') => {
    child.killSignals.push(signal);
    if (closeOnKill) {
      const closeCode = killExitCode ?? (signal === 'SIGKILL' ? 137 : 124);
      process.nextTick(() => child.emit('close', closeCode));
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

function captureRunnerEnv() {
  return {
    agentRunnersCli: process.env.RALPH_AGENT_RUNNERS_CLI,
    sdkRunnerCli: process.env.RALPH_SDK_RUNNER_CLI,
  };
}

function restoreRunnerEnv(previous) {
  if (previous.agentRunnersCli === undefined) {
    delete process.env.RALPH_AGENT_RUNNERS_CLI;
  } else {
    process.env.RALPH_AGENT_RUNNERS_CLI = previous.agentRunnersCli;
  }

  if (previous.sdkRunnerCli === undefined) {
    delete process.env.RALPH_SDK_RUNNER_CLI;
  } else {
    process.env.RALPH_SDK_RUNNER_CLI = previous.sdkRunnerCli;
  }
}

test('AgentRunner defaults Codex to the direct CLI backend', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-agent-codex-'));
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-agent-worktree-'));
  const logPath = path.join(tempRoot, 'agent.log');
  const previousHome = process.env.HOME;
  const previousRunnerEnv = captureRunnerEnv();
  const originalSpawn = childProcess.spawn;

  let captured;

  try {
    process.env.HOME = tempRoot;
    delete process.env.RALPH_AGENT_RUNNERS_CLI;
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
    assert.match(captured.args[1], /Ralph Worktree Boundary/);
    assert.match(captured.args[1], /only editable project checkout/);
    assert.equal(captured.args[2], '--full-auto');
    const cdIndex = captured.args.indexOf('--cd');
    assert.notEqual(cdIndex, -1);
    assert.equal(captured.args[cdIndex + 1], worktreePath);
    assert.equal(captured.options.cwd, worktreePath);
    assert.equal(captured.options.detached, process.platform !== 'win32');
    assert.equal(captured.options.env.XDG_CACHE_HOME, path.join(worktreePath, '.ralph-cache'));
    assert.equal(captured.options.env.PRISMA_ENGINES_CACHE_DIR, path.join(worktreePath, '.ralph-cache', 'prisma'));
    assert.equal(captured.options.env.PRISMA_HIDE_UPDATE_MESSAGE, 'true');
    assert.equal(fs.existsSync(path.join(worktreePath, '.ralph-cache', 'prisma')), true);
    assert.ok(!captured.args.includes('--cwd'));
    assert.ok(!captured.args.includes('--log'));
  } finally {
    childProcess.spawn = originalSpawn;
    process.env.HOME = previousHome;
    restoreRunnerEnv(previousRunnerEnv);
    await cleanupPath(tempRoot);
    await cleanupPath(worktreePath);
    delete require.cache[require.resolve('../dist/core/agent.js')];
  }
});

test('AgentRunner prefers .git-local metadata when the worktree provides it', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-agent-git-local-'));
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-agent-worktree-'));
  const logPath = path.join(tempRoot, 'agent.log');
  const previousHome = process.env.HOME;
  const previousRunnerEnv = captureRunnerEnv();
  const originalSpawn = childProcess.spawn;

  let captured;

  try {
    fs.mkdirSync(path.join(worktreePath, '.git-local'), { recursive: true });
    process.env.HOME = tempRoot;
    delete process.env.RALPH_AGENT_RUNNERS_CLI;
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
        title: 'Git metadata smoke',
        description: 'Keep git writes inside the local worktree metadata.',
        acceptanceCriteria: ['Reply with OK in the summary.'],
      },
      worktreePath,
      'codex',
      logPath,
    );

    assert.equal(result.success, true);
    assert.ok(captured, 'spawn should be called');
    assert.equal(captured.options.env.GIT_DIR, path.join(worktreePath, '.git-local'));
    assert.equal(captured.options.env.GIT_WORK_TREE, worktreePath);
  } finally {
    childProcess.spawn = originalSpawn;
    process.env.HOME = previousHome;
    restoreRunnerEnv(previousRunnerEnv);
    await cleanupPath(tempRoot);
    await cleanupPath(worktreePath);
    delete require.cache[require.resolve('../dist/core/agent.js')];
  }
});

test('AgentRunner gives Codex write access to linked worktree git metadata', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-agent-linked-git-'));
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-agent-worktree-'));
  const logPath = path.join(tempRoot, 'agent.log');
  const repoGitDir = path.join(tempRoot, 'repo', '.git');
  const linkedGitDir = path.join(repoGitDir, 'worktrees', 'task-1');
  const previousHome = process.env.HOME;
  const previousRunnerEnv = captureRunnerEnv();
  const originalSpawn = childProcess.spawn;

  let captured;

  try {
    fs.mkdirSync(linkedGitDir, { recursive: true });
    fs.writeFileSync(path.join(linkedGitDir, 'commondir'), '../..');
    fs.writeFileSync(path.join(worktreePath, '.git'), `gitdir: ${linkedGitDir}\n`);
    process.env.HOME = tempRoot;
    delete process.env.RALPH_AGENT_RUNNERS_CLI;
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
        title: 'Linked git metadata smoke',
        description: 'Allow git merge to write linked worktree metadata.',
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
    assert.ok(!captured.args.includes('--full-auto'));
    const sandboxIndex = captured.args.indexOf('--sandbox');
    assert.notEqual(sandboxIndex, -1);
    assert.equal(captured.args[sandboxIndex + 1], 'workspace-write');
    const cdIndex = captured.args.indexOf('--cd');
    assert.notEqual(cdIndex, -1);
    assert.equal(captured.args[cdIndex + 1], worktreePath);
    const addDirIndex = captured.args.indexOf('--add-dir');
    assert.notEqual(addDirIndex, -1);
    assert.equal(captured.args[addDirIndex + 1], repoGitDir);
  } finally {
    childProcess.spawn = originalSpawn;
    process.env.HOME = previousHome;
    restoreRunnerEnv(previousRunnerEnv);
    await cleanupPath(tempRoot);
    await cleanupPath(worktreePath);
    delete require.cache[require.resolve('../dist/core/agent.js')];
  }
});

test('AgentRunner persists and resumes Codex thread ids via agent-runners CLI', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-agent-codex-thread-'));
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-agent-worktree-'));
  const logPath = path.join(tempRoot, 'agent.log');
  const previousHome = process.env.HOME;
  const previousRunnerEnv = captureRunnerEnv();
  const originalSpawn = childProcess.spawn;
  const capturedCalls = [];

  try {
    process.env.HOME = tempRoot;
    process.env.RALPH_AGENT_RUNNERS_CLI = createAgentRunnersFixture(tempRoot);
    delete process.env.RALPH_SDK_RUNNER_CLI;
    fs.mkdirSync(path.join(tempRoot, '.ralph'), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, '.ralph', 'config.json'),
      JSON.stringify({
        agent: {
          agentRunnersPath: process.env.RALPH_AGENT_RUNNERS_CLI,
          codexConversationScope: 'task',
        },
      }),
    );
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
      'agent-runners',
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
      'agent-runners',
      { threadId: first.threadId },
    );

    assert.equal(first.success, true);
    assert.equal(first.threadId, 'codex-thread-1');
    assert.equal(second.success, true);
    assert.equal(second.threadId, 'codex-thread-1');
    assert.equal(capturedCalls.length, 2);
    assert.deepEqual(capturedCalls[0].args.slice(0, 2), [process.env.RALPH_AGENT_RUNNERS_CLI, 'codex']);
    assert.ok(!capturedCalls[0].args.includes('--resume-thread'));
    assert.deepEqual(capturedCalls[1].args.slice(0, 2), [process.env.RALPH_AGENT_RUNNERS_CLI, 'codex']);
    assert.ok(capturedCalls[1].args.includes('--resume-thread'));
    assert.ok(capturedCalls[1].args.includes('codex-thread-1'));
  } finally {
    childProcess.spawn = originalSpawn;
    process.env.HOME = previousHome;
    restoreRunnerEnv(previousRunnerEnv);
    await cleanupPath(tempRoot);
    await cleanupPath(worktreePath);
    delete require.cache[require.resolve('../dist/core/agent.js')];
  }
});

test('AgentRunner does not resume Codex thread across stories by default', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-agent-codex-story-scope-'));
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-agent-worktree-'));
  const logPath = path.join(tempRoot, 'agent.log');
  const previousHome = process.env.HOME;
  const previousRunnerEnv = captureRunnerEnv();
  const originalSpawn = childProcess.spawn;
  const capturedCalls = [];

  try {
    process.env.HOME = tempRoot;
    process.env.RALPH_AGENT_RUNNERS_CLI = createAgentRunnersFixture(tempRoot);
    delete process.env.RALPH_SDK_RUNNER_CLI;
    childProcess.spawn = (command, args, options) => {
      capturedCalls.push({ command, args, options });
      return createMockChild({
        stdoutLines: [JSON.stringify({ kind: 'final', payload: { threadId: 'codex-thread-2' } })],
      });
    };

    const { AgentRunner } = require('../dist/core/agent.js');
    const runner = new AgentRunner();

    await runner.runUserStory(
      {
        id: 'US-2',
        title: 'Codex story scoped thread',
        description: 'Do not resume another story thread.',
        acceptanceCriteria: ['Reply with OK in the summary.'],
      },
      worktreePath,
      'codex',
      logPath,
      'agent-runners',
      {
        threadId: 'codex-thread-1',
        threadStoryId: 'US-1',
        storyId: 'US-2',
      },
    );

    assert.equal(capturedCalls.length, 1);
    assert.ok(!capturedCalls[0].args.includes('--resume-thread'));
  } finally {
    childProcess.spawn = originalSpawn;
    process.env.HOME = previousHome;
    restoreRunnerEnv(previousRunnerEnv);
    await cleanupPath(tempRoot);
    await cleanupPath(worktreePath);
    delete require.cache[require.resolve('../dist/core/agent.js')];
  }
});

test('AgentRunner preserves Claude agent-runners model and resume args', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-agent-claude-'));
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-agent-worktree-'));
  const logPath = path.join(tempRoot, 'agent.log');
  const previousHome = process.env.HOME;
  const previousRunnerEnv = captureRunnerEnv();
  const originalSpawn = childProcess.spawn;

  let captured;

  try {
    process.env.HOME = tempRoot;
    process.env.RALPH_AGENT_RUNNERS_CLI = createAgentRunnersFixture(tempRoot);
    delete process.env.RALPH_SDK_RUNNER_CLI;
    fs.mkdirSync(path.join(tempRoot, '.ralph'), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, '.ralph', 'config.json'),
      JSON.stringify({
        agent: {
          path: 'codex',
          agentRunnersPath: process.env.RALPH_AGENT_RUNNERS_CLI,
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
      'agent-runners',
      { sessionId: 'resume-session-123' },
    );

    assert.equal(result.success, true);
    assert.equal(result.sessionId, 'claude-session-1');
    assert.equal(captured.command, 'node');
    assert.deepEqual(captured.args.slice(0, 2), [process.env.RALPH_AGENT_RUNNERS_CLI, 'claude']);
    assert.ok(captured.args.includes('--model'));
    assert.ok(captured.args.includes('claude-test-model'));
    assert.ok(captured.args.includes('--resume'));
    assert.ok(captured.args.includes('resume-session-123'));
  } finally {
    childProcess.spawn = originalSpawn;
    process.env.HOME = previousHome;
    restoreRunnerEnv(previousRunnerEnv);
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
  const previousRunnerEnv = captureRunnerEnv();
  const originalSpawn = childProcess.spawn;

  let child;

  try {
    process.env.HOME = tempRoot;
    process.env.RALPH_AGENT_RUNNERS_CLI = createAgentRunnersFixture(tempRoot);
    delete process.env.RALPH_SDK_RUNNER_CLI;
    fs.mkdirSync(path.join(tempRoot, '.ralph'), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, '.ralph', 'config.json'),
      JSON.stringify({
        agent: {
          agentRunnersPath: process.env.RALPH_AGENT_RUNNERS_CLI,
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
      'agent-runners',
    );

    assert.equal(result.success, false);
    assert.ok(child.killSignals.includes('SIGTERM'));
    assert.match(result.output, /Timed out after/);
  } finally {
    childProcess.spawn = originalSpawn;
    process.env.HOME = previousHome;
    restoreRunnerEnv(previousRunnerEnv);
    await cleanupPath(tempRoot);
    await cleanupPath(worktreePath);
    delete require.cache[require.resolve('../dist/core/agent.js')];
  }
});

test('AgentRunner treats configured timeout as idle timeout and refreshes on output', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-agent-idle-timeout-'));
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-agent-worktree-'));
  const logPath = path.join(tempRoot, 'agent.log');
  const previousHome = process.env.HOME;
  const previousRunnerEnv = captureRunnerEnv();
  const originalSpawn = childProcess.spawn;

  let child;
  const timers = [];

  try {
    process.env.HOME = tempRoot;
    process.env.RALPH_AGENT_RUNNERS_CLI = createAgentRunnersFixture(tempRoot);
    delete process.env.RALPH_SDK_RUNNER_CLI;
    fs.mkdirSync(path.join(tempRoot, '.ralph'), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, '.ralph', 'config.json'),
      JSON.stringify({
        agent: {
          agentRunnersPath: process.env.RALPH_AGENT_RUNNERS_CLI,
          timeout: 0.05,
        },
      }),
    );

    childProcess.spawn = () => {
      child = createMockChild({ exitCode: null, closeOnKill: true });
      timers.push(setTimeout(() => child.stdout.emit('data', Buffer.from('still working 1\n')), 20));
      timers.push(setTimeout(() => child.stderr.emit('data', Buffer.from('still working 2\n')), 55));
      timers.push(setTimeout(() => child.emit('close', 0), 85));
      return child;
    };

    const { AgentRunner } = require('../dist/core/agent.js');
    const runner = new AgentRunner();

    const result = await runner.runUserStory(
      {
        id: 'US-idle-timeout',
        title: 'Idle timeout smoke',
        description: 'Keep running while output continues.',
        acceptanceCriteria: ['Finish after multiple output chunks.'],
      },
      worktreePath,
      'codex',
      logPath,
      'agent-runners',
    );

    assert.equal(result.success, true);
    assert.equal(result.timedOut, false);
    assert.deepEqual(child.killSignals, []);
    assert.match(result.output, /still working 1/);
    assert.match(result.output, /still working 2/);
  } finally {
    for (const timer of timers) {
      clearTimeout(timer);
    }
    childProcess.spawn = originalSpawn;
    process.env.HOME = previousHome;
    restoreRunnerEnv(previousRunnerEnv);
    await cleanupPath(tempRoot);
    await cleanupPath(worktreePath);
    delete require.cache[require.resolve('../dist/core/agent.js')];
  }
});

test('AgentRunner extends idle timeout while long-running build command is active', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-agent-build-extension-'));
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-agent-worktree-'));
  const logPath = path.join(tempRoot, 'agent.log');
  const previousHome = process.env.HOME;
  const previousRunnerEnv = captureRunnerEnv();
  const originalSpawn = childProcess.spawn;
  const originalExecFileSync = childProcess.execFileSync;

  let child;
  const timers = [];

  try {
    process.env.HOME = tempRoot;
    process.env.RALPH_AGENT_RUNNERS_CLI = createAgentRunnersFixture(tempRoot);
    delete process.env.RALPH_SDK_RUNNER_CLI;
    fs.mkdirSync(path.join(tempRoot, '.ralph'), { recursive: true });
    fs.mkdirSync(path.join(worktreePath, 'apps', 'web'), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, '.ralph', 'config.json'),
      JSON.stringify({
        agent: {
          agentRunnersPath: process.env.RALPH_AGENT_RUNNERS_CLI,
          timeout: 0.05,
        },
      }),
    );

    childProcess.execFileSync = (command, args) => {
      if (command === 'ps' && args.includes('-axo')) {
        return `12345 node ${path.join(worktreePath, 'apps', 'web', 'node_modules', '.bin', 'next')} build\n`;
      }

      if (command === 'ps' && args[0] === '-p') {
        return `1 1 node ${path.join(worktreePath, 'apps', 'web', 'node_modules', '.bin', 'next')} build\n`;
      }

      if (command === 'lsof') {
        return `n${path.join(worktreePath, 'apps', 'web')}\n`;
      }

      return originalExecFileSync(command, args);
    };

    childProcess.spawn = () => {
      child = createMockChild({ exitCode: null, closeOnKill: true });
      timers.push(setTimeout(() => child.emit('close', 0), 120));
      return child;
    };

    const { AgentRunner } = require('../dist/core/agent.js');
    const runner = new AgentRunner();

    const result = await runner.runUserStory(
      {
        id: 'US-build-extension',
        title: 'Build extension smoke',
        description: 'Keep waiting while a build process is active.',
        acceptanceCriteria: ['Finish after the build process exits.'],
      },
      worktreePath,
      'codex',
      logPath,
      'agent-runners',
    );

    assert.equal(result.success, true);
    assert.equal(result.timedOut, false);
    assert.deepEqual(child.killSignals, []);
    assert.match(result.output, /long-running command is active/);
  } finally {
    for (const timer of timers) {
      clearTimeout(timer);
    }
    childProcess.spawn = originalSpawn;
    childProcess.execFileSync = originalExecFileSync;
    process.env.HOME = previousHome;
    restoreRunnerEnv(previousRunnerEnv);
    await cleanupPath(tempRoot);
    await cleanupPath(worktreePath);
    delete require.cache[require.resolve('../dist/core/agent.js')];
    delete require.cache[require.resolve('../dist/core/worktree-process-cleanup.js')];
  }
});

test('AgentRunner treats timeout as failure even when child exits zero after SIGTERM', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-agent-timeout-zero-'));
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-agent-worktree-'));
  const logPath = path.join(tempRoot, 'agent.log');
  const previousHome = process.env.HOME;
  const previousRunnerEnv = captureRunnerEnv();
  const originalSpawn = childProcess.spawn;

  let child;

  try {
    process.env.HOME = tempRoot;
    process.env.RALPH_AGENT_RUNNERS_CLI = createAgentRunnersFixture(tempRoot);
    delete process.env.RALPH_SDK_RUNNER_CLI;
    fs.mkdirSync(path.join(tempRoot, '.ralph'), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, '.ralph', 'config.json'),
      JSON.stringify({
        agent: {
          agentRunnersPath: process.env.RALPH_AGENT_RUNNERS_CLI,
          timeout: 0.01,
        },
      }),
    );

    childProcess.spawn = () => {
      child = createMockChild({ exitCode: null, closeOnKill: true, killExitCode: 0 });
      return child;
    };

    const { AgentRunner } = require('../dist/core/agent.js');
    const runner = new AgentRunner();

    const result = await runner.runUserStory(
      {
        id: 'US-timeout-zero',
        title: 'Timeout zero exit smoke',
        description: 'Ensure timeout state wins over process close code.',
        acceptanceCriteria: ['Finish quickly.'],
      },
      worktreePath,
      'codex',
      logPath,
      'agent-runners',
    );

    assert.equal(result.success, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, 0);
    assert.ok(child.killSignals.includes('SIGTERM'));
    assert.match(result.output, /Timed out after/);
  } finally {
    childProcess.spawn = originalSpawn;
    process.env.HOME = previousHome;
    restoreRunnerEnv(previousRunnerEnv);
    await cleanupPath(tempRoot);
    await cleanupPath(worktreePath);
    delete require.cache[require.resolve('../dist/core/agent.js')];
  }
});
