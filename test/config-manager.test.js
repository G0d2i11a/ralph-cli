const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function withTempHome(testFn) {
  return async () => {
    const previousHome = process.env.HOME;
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-config-home-'));

    try {
      process.env.HOME = homeDir;
      await testFn(homeDir);
    } finally {
      process.env.HOME = previousHome;
      fs.rmSync(homeDir, { recursive: true, force: true });
      delete require.cache[require.resolve('../dist/config/manager.js')];
      delete require.cache[require.resolve('../dist/core/agent.js')];
    }
  };
}

test('ConfigManager ignores legacy notification config blocks', withTempHome(async (homeDir) => {
  const configDir = path.join(homeDir, '.ralph');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      runner: {
        maxConcurrent: 2,
      },
      notification: {
        enabled: true,
        channel: 'feishu',
        target: 'demo',
      },
    }, null, 2),
  );

  const { ConfigManager } = require('../dist/config/manager.js');
  const manager = new ConfigManager();

  assert.equal(manager.get('runner.maxConcurrent'), 2);
  assert.equal(manager.get('notification.enabled'), undefined);
  assert.equal('notification' in manager.getAll(), false);
}));

test('ConfigManager defaults agent.backend to cli', withTempHome(async () => {
  const { ConfigManager } = require('../dist/config/manager.js');
  const { resolveConfiguredBackend } = require('../dist/core/agent.js');
  const manager = new ConfigManager();

  assert.equal(manager.get('agent.backend'), 'cli');
  assert.equal(manager.has('agent.backend'), true);
  assert.equal(resolveConfiguredBackend(manager), 'cli');
}));

test('resolveConfiguredBackend maps legacy sdk-runner configs to agent-runners', withTempHome(async (homeDir) => {
  const configDir = path.join(homeDir, '.ralph');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      agent: {
        sdkRunnerPath: '/tmp/agent-runners/dist/cli.js',
      },
    }, null, 2),
  );

  const { ConfigManager } = require('../dist/config/manager.js');
  const { resolveConfiguredBackend } = require('../dist/core/agent.js');
  const manager = new ConfigManager();

  assert.equal(manager.get('agent.backend'), 'cli');
  assert.equal(manager.has('agent.backend'), false);
  assert.equal(resolveConfiguredBackend(manager), 'agent-runners');
}));

test('resolveConfiguredBackend still accepts legacy sdk-runner env hints', withTempHome(async (homeDir) => {
  const configDir = path.join(homeDir, '.ralph');
  const previousAgentRunnersCli = process.env.RALPH_AGENT_RUNNERS_CLI;
  const previousSdkRunnerCli = process.env.RALPH_SDK_RUNNER_CLI;

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      agent: {},
    }, null, 2),
  );

  try {
    delete process.env.RALPH_AGENT_RUNNERS_CLI;
    process.env.RALPH_SDK_RUNNER_CLI = '/tmp/agent-runners/dist/cli.js';

    const { ConfigManager } = require('../dist/config/manager.js');
    const { resolveConfiguredBackend } = require('../dist/core/agent.js');
    const manager = new ConfigManager();

    assert.equal(manager.has('agent.backend'), false);
    assert.equal(resolveConfiguredBackend(manager), 'agent-runners');
  } finally {
    if (previousAgentRunnersCli === undefined) {
      delete process.env.RALPH_AGENT_RUNNERS_CLI;
    } else {
      process.env.RALPH_AGENT_RUNNERS_CLI = previousAgentRunnersCli;
    }

    if (previousSdkRunnerCli === undefined) {
      delete process.env.RALPH_SDK_RUNNER_CLI;
    } else {
      process.env.RALPH_SDK_RUNNER_CLI = previousSdkRunnerCli;
    }
  }
}));
