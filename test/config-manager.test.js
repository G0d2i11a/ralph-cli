const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function withTempHome(testFn) {
  return async () => {
    const previousHome = process.env.HOME;
    const previousRalphHome = process.env.RALPH_HOME;
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-config-home-'));

    try {
      process.env.HOME = homeDir;
      delete process.env.RALPH_HOME;
      await testFn(homeDir);
    } finally {
      process.env.HOME = previousHome;
      if (previousRalphHome === undefined) {
        delete process.env.RALPH_HOME;
      } else {
        process.env.RALPH_HOME = previousRalphHome;
      }
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
  const {
    resolveAutonomyRepairConfig,
    resolveTransientRecoveryConfig,
  } = require('../dist/core/auto-recovery-policy.js');
  const manager = new ConfigManager();

  assert.equal(manager.get('agent.backend'), 'cli');
  assert.equal(manager.get('agent.codexConversationScope'), 'story');
  assert.equal(manager.has('agent.backend'), true);
  assert.equal(resolveConfiguredBackend(manager), 'cli');
  assert.equal(manager.get('autoMerge'), false);
  assert.equal(manager.get('merge.autoIntegrate'), true);
  assert.equal(manager.get('merge.targetBranch'), 'main');
  assert.equal(manager.get('merge.useIntegrationWorktree'), true);
  assert.equal(manager.get('merge.integrationWorktreeDir'), '.ralph-integration');
  assert.equal(manager.get('merge.syncTargetBranch'), true);
  assert.equal(manager.get('finalizer.qualityGateTimeout'), 600);
  assert.equal(manager.get('finalizer.repairPolicy'), 'progress');
  assert.equal(manager.get('finalizer.maxNoProgressRepairRounds'), 2);
  assert.equal(manager.get('finalizer.repairDeadlineSeconds'), 7200);
  assert.equal(manager.get('finalizer.repairHardCap'), 20);
  assert.equal(manager.get('runner.maxTransientRetriesPerStory'), 3);
  assert.equal(manager.get('runner.transientRetryBaseDelaySeconds'), 15);
  assert.equal(manager.get('runner.transientRetryMaxDelaySeconds'), 180);
  assert.equal(manager.get('runner.maxTransientRecoveryRequeues'), 5);
  assert.equal(manager.get('runner.transientRecoveryBaseDelaySeconds'), 120);
  assert.equal(manager.get('runner.transientRecoveryMaxDelaySeconds'), 900);
  assert.equal(manager.get('runner.transientRecoveryDeadlineSeconds'), 7200);
  assert.equal(manager.get('runner.maxTransientRecoverySameSignature'), 3);
  assert.equal(manager.get('runner.transientRecoveryProgressAwareSameSignature'), true);
  assert.equal(manager.get('runner.autoRecoveryHardCap'), 20);
  assert.equal(manager.get('runner.autoRemediateFailedBlockers'), true);
  assert.equal(manager.get('runner.maxFailedBlockerStoryRequeues'), 1);
  assert.equal(manager.get('runner.failedBlockerRecoveryDeadlineSeconds'), 7200);
  assert.equal(manager.get('runner.failedBlockerRecoveryHardCap'), 2);
  assert.equal(manager.get('runner.autoRemediateStoryFailures'), true);
  assert.equal(manager.get('runner.maxStoryRepairRequeues'), 1);
  assert.equal(manager.get('runner.storyRepairRecoveryDeadlineSeconds'), 7200);
  assert.equal(manager.get('runner.storyRepairRecoveryHardCap'), 2);
  assert.equal(manager.get('runner.autoRemediateAgentContextFailures'), true);
  assert.equal(manager.get('runner.maxAgentContextRecoveryRequeues'), 1);
  assert.equal(manager.get('runner.agentContextRecoveryDeadlineSeconds'), 7200);
  assert.equal(manager.get('runner.agentContextRecoveryHardCap'), 2);
  assert.equal(manager.get('runner.autoClassifyBaselineQualityGateFailures'), true);
  assert.equal(manager.get('runner.autoRemediateBaselineQualityGateFailures'), true);
  assert.equal(manager.get('runner.baselineQualityGateRepairHardCap'), 3);
  assert.equal(manager.get('runner.baselineQualityGateEnvSelfHealEnabled'), true);
  assert.equal(manager.get('runner.baselineQualityGateEnvSelfHealMaxAttempts'), 3);
  assert.equal(manager.get('runner.baselineQualityGateProbeMaxAttempts'), 2);
  assert.equal(manager.get('runner.baselineQualityGateRepairDeadlineSeconds'), 21600);
  assert.equal(manager.get('runner.baselineQualityGateMaxSameSignatureNoProgress'), 2);
  assert.equal(manager.get('runner.baselineQualityGateTreatProbeBufferOverflowAsProbeFailure'), true);
  assert.equal(manager.get('runner.autoRecoverBlockedTasks'), true);
  assert.equal(manager.get('runner.autonomyRepairDeadlineSeconds'), 86400);
  assert.equal(manager.get('runner.autonomyRepairHardCap'), 10);
  assert.equal(manager.get('runner.autonomyRepairCooldownBaseSeconds'), 60);
  assert.equal(manager.get('runner.autonomyRepairCooldownMaxSeconds'), 1800);
  assert.equal(manager.get('runner.deadlockAutoUnblockEnabled'), true);
  assert.equal(manager.get('runner.deadlockAutoUnblockRequiresObservedDisjointSurface'), true);
  assert.deepEqual(manager.get('runner.worktreeCleanupLockGlobs'), ['**/.next/lock', '**/.next.stale-build*/lock']);
  assert.equal(manager.get('reclamation.enabled'), true);
  assert.equal(manager.get('reclamation.intervalSeconds'), 900);
  assert.equal(manager.get('reclamation.startupDelaySeconds'), 30);
  assert.equal(manager.get('reclamation.maxRunSeconds'), 30);
  assert.equal(manager.get('reclamation.worktrees.enabled'), true);
  assert.equal(manager.get('reclamation.worktrees.completedRetentionHours'), 24);
  assert.equal(manager.get('reclamation.worktrees.failedRetentionHours'), 168);
  assert.equal(manager.get('reclamation.worktrees.cleanupOrphans'), true);
  assert.equal(manager.get('reclamation.worktrees.keepNewestPerRepo'), 5);
  assert.equal(manager.get('reclamation.worktrees.maxRemovalsPerRun'), 25);
  assert.equal(manager.get('reclamation.worktrees.removeDirtyFailedWorktrees'), false);
  assert.equal(manager.get('reclamation.worktrees.dirtyTerminalMode'), 'archive_only');
  assert.equal(manager.get('reclamation.worktrees.dirtyOrphanMode'), 'retain');
  assert.equal(manager.get('reclamation.worktrees.dirtyFailedRetentionHours'), 336);
  assert.equal(manager.get('reclamation.worktrees.dirtyFailedFinalizeRetentionHours'), 336);
  assert.equal(manager.get('reclamation.worktrees.dirtyStagnantRetentionHours'), 336);
  assert.equal(manager.get('reclamation.worktrees.dirtyOrphanRetentionHours'), 720);
  assert.equal(manager.get('reclamation.worktrees.skipDirtyIfRetryableFailure'), true);
  assert.equal(manager.get('reclamation.worktrees.maxDirtyRemovalsPerRun'), 5);
  assert.equal(manager.get('reclamation.worktrees.maxDirtyArchivesPerRun'), 10);
  assert.equal(manager.get('reclamation.worktrees.pruneGitWorktreeMetadata'), true);
  assert.equal(manager.get('reclamation.evidence.enabled'), true);
  assert.equal(manager.get('reclamation.evidence.requireForDirtyReclaim'), true);
  assert.equal(manager.get('reclamation.evidence.includePatches'), true);
  assert.equal(manager.get('reclamation.evidence.maxUntrackedFiles'), 500);
  assert.equal(manager.get('reclamation.tempDirs.enabled'), true);
  assert.deepEqual(manager.get('reclamation.tempDirs.roots'), ['/private/tmp']);
  assert.equal(manager.get('reclamation.reporting.logJsonl'), true);
  assert.equal(manager.get('reclamation.reporting.writeLastRun'), true);
  assert.equal(manager.get('ingestion.ez4ielts.enabled'), false);
  assert.equal(manager.get('ingestion.ez4ielts.ingestExistingOnStartup'), false);
  assert.equal(resolveTransientRecoveryConfig(manager).transientRecoveryProgressAwareSameSignature, true);
  assert.deepEqual(resolveAutonomyRepairConfig(manager), {
    autoRecoverBlockedTasks: true,
    autonomyRepairDeadlineSeconds: 86400,
    autonomyRepairHardCap: 10,
    autonomyRepairCooldownBaseSeconds: 60,
    autonomyRepairCooldownMaxSeconds: 1800,
  });
}));

test('resolveAutonomyRepairConfig reads autonomy repair keys', withTempHome(async (homeDir) => {
  const configDir = path.join(homeDir, '.ralph');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      runner: {
        autoRecoverBlockedTasks: true,
        autonomyRepairDeadlineSeconds: 900,
        autonomyRepairHardCap: 8,
        autonomyRepairCooldownBaseSeconds: 30,
        autonomyRepairCooldownMaxSeconds: 300,
      },
    }, null, 2),
  );

  const { ConfigManager } = require('../dist/config/manager.js');
  const { resolveAutonomyRepairConfig } = require('../dist/core/auto-recovery-policy.js');
  const manager = new ConfigManager();

  assert.deepEqual(resolveAutonomyRepairConfig(manager), {
    autoRecoverBlockedTasks: true,
    autonomyRepairDeadlineSeconds: 900,
    autonomyRepairHardCap: 8,
    autonomyRepairCooldownBaseSeconds: 30,
    autonomyRepairCooldownMaxSeconds: 300,
  });
}));

test('ConfigManager can disable progress-aware transient same-signature recovery', withTempHome(async (homeDir) => {
  const configDir = path.join(homeDir, '.ralph');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      runner: {
        transientRecoveryProgressAwareSameSignature: false,
      },
    }, null, 2),
  );

  const { ConfigManager } = require('../dist/config/manager.js');
  const { resolveTransientRecoveryConfig } = require('../dist/core/auto-recovery-policy.js');
  const manager = new ConfigManager();

  assert.equal(manager.get('runner.transientRecoveryProgressAwareSameSignature'), false);
  assert.equal(resolveTransientRecoveryConfig(manager).transientRecoveryProgressAwareSameSignature, false);
}));

test('ConfigManager uses RALPH_HOME without appending an extra .ralph segment', withTempHome(async (homeDir) => {
  const customHome = path.join(homeDir, 'custom-home');
  process.env.RALPH_HOME = customHome;

  const { ConfigManager } = require('../dist/config/manager.js');
  const manager = new ConfigManager();

  assert.equal(fs.existsSync(path.join(customHome, 'config.json')), true);
  assert.equal(fs.existsSync(path.join(customHome, '.ralph', 'config.json')), false);
  assert.equal(manager.get('agent.backend'), 'cli');
}));

test('ConfigManager loads auto-merge settings from config', withTempHome(async (homeDir) => {
  const configDir = path.join(homeDir, '.ralph');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      autoMerge: true,
      autoMergeDelay: 5,
      merge: {
        autoIntegrate: false,
        targetBranch: 'develop',
        strategy: 'theirs',
        pullLatest: false,
        useIntegrationWorktree: false,
        integrationWorktreeDir: '.custom-integration',
        syncTargetBranch: false,
      },
      finalizer: {
        qualityGateTimeout: 45,
        repairPolicy: 'fixed',
        maxNoProgressRepairRounds: 4,
        repairDeadlineSeconds: 90,
        repairHardCap: 8,
      },
    }, null, 2),
  );

  const { ConfigManager } = require('../dist/config/manager.js');
  const manager = new ConfigManager();

  assert.equal(manager.get('autoMerge'), true);
  assert.equal(manager.get('autoMergeDelay'), 5);
  assert.equal(manager.get('merge.autoIntegrate'), false);
  assert.equal(manager.get('merge.targetBranch'), 'develop');
  assert.equal(manager.get('merge.strategy'), 'theirs');
  assert.equal(manager.get('merge.pullLatest'), false);
  assert.equal(manager.get('merge.useIntegrationWorktree'), false);
  assert.equal(manager.get('merge.integrationWorktreeDir'), '.custom-integration');
  assert.equal(manager.get('merge.syncTargetBranch'), false);
  assert.equal(manager.get('finalizer.qualityGateTimeout'), 45);
  assert.equal(manager.get('finalizer.repairPolicy'), 'fixed');
  assert.equal(manager.get('finalizer.maxNoProgressRepairRounds'), 4);
  assert.equal(manager.get('finalizer.repairDeadlineSeconds'), 90);
  assert.equal(manager.get('finalizer.repairHardCap'), 8);
  assert.equal(manager.get('runner.maxTransientRetriesPerStory'), 3);
  assert.equal(manager.get('runner.maxTransientRecoveryRequeues'), 5);
}));

test('ConfigManager derives merge.autoIntegrate from useIntegrationWorktree when not explicitly configured', withTempHome(async (homeDir) => {
  const configDir = path.join(homeDir, '.ralph');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      merge: {
        useIntegrationWorktree: false,
      },
    }, null, 2),
  );

  const { ConfigManager } = require('../dist/config/manager.js');
  const manager = new ConfigManager();

  assert.equal(manager.get('merge.useIntegrationWorktree'), false);
  assert.equal(manager.get('merge.autoIntegrate'), false);
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

test('resolveConfiguredBackend keeps configured codex binary paths on cli backend', withTempHome(async (homeDir) => {
  const configDir = path.join(homeDir, '.ralph');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      agent: {
        path: '/usr/local/bin/codex',
      },
    }, null, 2),
  );

  const { ConfigManager } = require('../dist/config/manager.js');
  const { resolveConfiguredBackend } = require('../dist/core/agent.js');
  const manager = new ConfigManager();

  assert.equal(manager.has('agent.backend'), false);
  assert.equal(resolveConfiguredBackend(manager), 'cli');
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
