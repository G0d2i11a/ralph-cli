import * as fs from 'fs';
import * as path from 'path';
import { getRalphPaths, RalphHomeOptions } from '../core/paths';

export type RalphMergeStrategy = 'manual' | 'ours' | 'theirs';

export interface RalphConfig {
  agent: {
    backend: string;
    path: string;
    agentRunnersPath: string;
    sdkRunnerPath: string;
    timeout: number;
    extendIdleTimeoutForLongRunningCommands: boolean;
    longRunningCommandPatterns: string[];
    model: string;
    codexConversationScope: 'attempt' | 'story' | 'task';
  };
  runner: {
    maxConcurrent: number;
    stagnationTimeout: number;
    pollInterval: number;
    leaseTimeout: number;
    maxStoryAttempts: number;
    maxTransientRetriesPerStory: number;
    transientRetryBaseDelaySeconds: number;
    transientRetryMaxDelaySeconds: number;
    maxTransientRecoveryRequeues: number;
    transientRecoveryBaseDelaySeconds: number;
    transientRecoveryMaxDelaySeconds: number;
    transientRecoveryDeadlineSeconds: number;
    maxTransientRecoverySameSignature: number;
    transientRecoveryProgressAwareSameSignature: boolean;
    autoRecoveryHardCap: number;
    autoRemediateFailedBlockers: boolean;
    maxFailedBlockerStoryRequeues: number;
    failedBlockerRecoveryDeadlineSeconds: number;
    failedBlockerRecoveryHardCap: number;
    autoRemediateStoryFailures: boolean;
    maxStoryRepairRequeues: number;
    storyRepairRecoveryDeadlineSeconds: number;
    storyRepairRecoveryHardCap: number;
    autoRemediateAgentContextFailures: boolean;
    maxAgentContextRecoveryRequeues: number;
    agentContextRecoveryDeadlineSeconds: number;
    agentContextRecoveryHardCap: number;
    autoClassifyBaselineQualityGateFailures: boolean;
    autoRemediateBaselineQualityGateFailures: boolean;
    baselineQualityGateRepairHardCap: number;
    baselineQualityGateEnvSelfHealEnabled: boolean;
    baselineQualityGateEnvSelfHealMaxAttempts: number;
    baselineQualityGateProbeMaxAttempts: number;
    baselineQualityGateRepairDeadlineSeconds: number;
    baselineQualityGateMaxSameSignatureNoProgress: number;
    baselineQualityGateTreatProbeBufferOverflowAsProbeFailure: boolean;
    autoRecoverBlockedTasks: boolean;
    autonomyRepairDeadlineSeconds: number;
    autonomyRepairHardCap: number;
    autonomyRepairCooldownBaseSeconds: number;
    autonomyRepairCooldownMaxSeconds: number;
    deadlockAutoUnblockEnabled: boolean;
    deadlockAutoUnblockRequiresObservedDisjointSurface: boolean;
    worktreeCleanupLockGlobs: string[];
  };
  reclamation: {
    enabled: boolean;
    intervalSeconds: number;
    startupDelaySeconds: number;
    maxRunSeconds: number;
    diskPressure: {
      enabled: boolean;
      checkIntervalSeconds: number;
      minFreePercent: number;
      minFreeBytes: number;
      targetFreeBytes: number;
      emergencyFreeBytes: number;
    };
    worktrees: {
      enabled: boolean;
      completedRetentionHours: number;
      failedRetentionHours: number;
      failedFinalizeRetentionHours: number;
      stagnantRetentionHours: number;
      targetSyncDeferredRetentionHours: number;
      orphanRetentionHours: number;
      cleanupOrphans: boolean;
      keepNewestPerRepo: number;
      maxRemovalsPerRun: number;
      removeDirtyFailedWorktrees: boolean;
      dirtyFailedRetentionHours: number;
      pruneBranches: boolean;
      pruneGitWorktreeMetadata: boolean;
    };
    tempDirs: {
      enabled: boolean;
      roots: string[];
      markedRetentionHours: number;
      legacyRetentionHours: number;
      pressureMarkedRetentionHours: number;
      pressureLegacyRetentionHours: number;
      cleanupLegacyUnmarked: boolean;
      legacyNamePatterns: string[];
      maxRemovalsPerRun: number;
    };
    reporting: {
      logJsonl: boolean;
      logPath: string;
      writeLastRun: boolean;
      emitTaskEvents: boolean;
    };
  };
  ingestion: {
    ez4ielts: {
      enabled: boolean;
      watchDir: string;
      pattern: string;
      settleMs: number;
      ingestExistingOnStartup: boolean;
    };
  };
  autoMerge: boolean;
  autoMergeDelay: number;
  merge: {
    autoIntegrate: boolean;
    targetBranch: string;
    strategy: RalphMergeStrategy;
    pullLatest: boolean;
    useIntegrationWorktree: boolean;
    integrationWorktreeDir: string;
    syncTargetBranch: boolean;
    allowDestructiveAutoResolve: boolean;
  };
  finalizer: {
    qualityGateTimeout: number;
    leaseTimeout: number;
    qualityGates: string[];
    repairPolicy: 'fixed' | 'progress';
    maxRepairAttempts: number;
    maxNoProgressRepairRounds: number;
    repairDeadlineSeconds: number;
    repairHardCap: number;
  };
}

interface ConfigManagerOptions extends RalphHomeOptions {
  configPath?: string;
}

const DEFAULT_CONFIG: RalphConfig = {
  agent: {
    backend: 'cli',
    path: 'codex',
    agentRunnersPath: process.env.RALPH_AGENT_RUNNERS_CLI || process.env.RALPH_SDK_RUNNER_CLI || '',
    sdkRunnerPath: process.env.RALPH_SDK_RUNNER_CLI || '',
    timeout: 600,
    extendIdleTimeoutForLongRunningCommands: true,
    longRunningCommandPatterns: ['next build', 'pnpm run build', 'npm run build', 'yarn build', 'turbo build', 'tsc'],
    model: 'claude-opus-4-6-thinking-xchai',
    codexConversationScope: 'story',
  },
  runner: {
    maxConcurrent: 3,
    stagnationTimeout: 1800,
    pollInterval: 10,
    leaseTimeout: 300,
    maxStoryAttempts: 2,
    maxTransientRetriesPerStory: 3,
    transientRetryBaseDelaySeconds: 15,
    transientRetryMaxDelaySeconds: 180,
    maxTransientRecoveryRequeues: 5,
    transientRecoveryBaseDelaySeconds: 120,
    transientRecoveryMaxDelaySeconds: 900,
    transientRecoveryDeadlineSeconds: 7200,
    maxTransientRecoverySameSignature: 3,
    transientRecoveryProgressAwareSameSignature: true,
    autoRecoveryHardCap: 20,
    autoRemediateFailedBlockers: true,
    maxFailedBlockerStoryRequeues: 1,
    failedBlockerRecoveryDeadlineSeconds: 7200,
    failedBlockerRecoveryHardCap: 2,
    autoRemediateStoryFailures: true,
    maxStoryRepairRequeues: 1,
    storyRepairRecoveryDeadlineSeconds: 7200,
    storyRepairRecoveryHardCap: 2,
    autoRemediateAgentContextFailures: true,
    maxAgentContextRecoveryRequeues: 1,
    agentContextRecoveryDeadlineSeconds: 7200,
    agentContextRecoveryHardCap: 2,
    autoClassifyBaselineQualityGateFailures: true,
    autoRemediateBaselineQualityGateFailures: true,
    baselineQualityGateRepairHardCap: 3,
    baselineQualityGateEnvSelfHealEnabled: true,
    baselineQualityGateEnvSelfHealMaxAttempts: 3,
    baselineQualityGateProbeMaxAttempts: 2,
    baselineQualityGateRepairDeadlineSeconds: 21600,
    baselineQualityGateMaxSameSignatureNoProgress: 2,
    baselineQualityGateTreatProbeBufferOverflowAsProbeFailure: true,
    autoRecoverBlockedTasks: true,
    autonomyRepairDeadlineSeconds: 86400,
    autonomyRepairHardCap: 10,
    autonomyRepairCooldownBaseSeconds: 60,
    autonomyRepairCooldownMaxSeconds: 1800,
    deadlockAutoUnblockEnabled: true,
    deadlockAutoUnblockRequiresObservedDisjointSurface: true,
    worktreeCleanupLockGlobs: ['**/.next/lock', '**/.next.stale-build*/lock'],
  },
  reclamation: {
    enabled: true,
    intervalSeconds: 900,
    startupDelaySeconds: 30,
    maxRunSeconds: 30,
    diskPressure: {
      enabled: true,
      checkIntervalSeconds: 60,
      minFreePercent: 10,
      minFreeBytes: 10 * 1024 * 1024 * 1024,
      targetFreeBytes: 30 * 1024 * 1024 * 1024,
      emergencyFreeBytes: 5 * 1024 * 1024 * 1024,
    },
    worktrees: {
      enabled: true,
      completedRetentionHours: 24,
      failedRetentionHours: 168,
      failedFinalizeRetentionHours: 168,
      stagnantRetentionHours: 168,
      targetSyncDeferredRetentionHours: 72,
      orphanRetentionHours: 24,
      cleanupOrphans: true,
      keepNewestPerRepo: 5,
      maxRemovalsPerRun: 25,
      removeDirtyFailedWorktrees: false,
      dirtyFailedRetentionHours: 336,
      pruneBranches: false,
      pruneGitWorktreeMetadata: true,
    },
    tempDirs: {
      enabled: true,
      roots: ['/private/tmp'],
      markedRetentionHours: 24,
      legacyRetentionHours: 24,
      pressureMarkedRetentionHours: 1,
      pressureLegacyRetentionHours: 1,
      cleanupLegacyUnmarked: true,
      legacyNamePatterns: ['ralph-*', 'ez4ielts-*', 'content-gen-*'],
      maxRemovalsPerRun: 500,
    },
    reporting: {
      logJsonl: true,
      logPath: '',
      writeLastRun: true,
      emitTaskEvents: true,
    },
  },
  ingestion: {
    ez4ielts: {
      enabled: false,
      watchDir: process.env.RALPH_EZ4IELTS_WATCH_DIR || '',
      pattern: 'ez4ielts-*.json',
      settleMs: 2000,
      ingestExistingOnStartup: false,
    },
  },
  autoMerge: false,
  autoMergeDelay: 0,
  merge: {
    autoIntegrate: true,
    targetBranch: 'main',
    strategy: 'manual',
    pullLatest: true,
    useIntegrationWorktree: true,
    integrationWorktreeDir: '.ralph-integration',
    syncTargetBranch: true,
    allowDestructiveAutoResolve: false,
  },
  finalizer: {
    qualityGateTimeout: 600,
    leaseTimeout: 1800,
    qualityGates: ['typecheck', 'lint', 'test', 'build'],
    repairPolicy: 'progress',
    maxRepairAttempts: 1,
    maxNoProgressRepairRounds: 2,
    repairDeadlineSeconds: 7200,
    repairHardCap: 20,
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneConfig<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mergeConfig<T extends Record<string, any>>(defaults: T, overrides: Partial<T>): T {
  const merged: Record<string, unknown> = { ...defaults };
  const overrideRecord: Record<string, unknown> = isPlainObject(overrides) ? overrides : {};

  for (const [key, defaultValue] of Object.entries(defaults)) {
    const overrideValue = overrideRecord[key];

    if (overrideValue === undefined) {
      continue;
    }

    if (isPlainObject(defaultValue) && isPlainObject(overrideValue)) {
      merged[key] = mergeConfig(defaultValue, overrideValue);
      continue;
    }

    merged[key] = overrideValue;
  }

  return merged as T;
}

function hasNestedKey(value: unknown, parts: string[]): boolean {
  let current: unknown = value;

  for (const part of parts) {
    if (!isPlainObject(current) || !(part in current)) {
      return false;
    }

    current = current[part];
  }

  return true;
}

export class ConfigManager {
  private configPath: string;
  private config: RalphConfig;
  private rawConfig: Record<string, unknown> = {};

  constructor(options: ConfigManagerOptions = {}) {
    const paths = getRalphPaths(options);
    const ralphDir = paths.ralphHome;
    if (!fs.existsSync(ralphDir)) {
      fs.mkdirSync(ralphDir, { recursive: true });
    }
    this.configPath = options.configPath
      ? path.resolve(options.configPath)
      : paths.configPath;
    this.config = this.load();
  }

  private load(): RalphConfig {
    if (!fs.existsSync(this.configPath)) {
      const config = cloneConfig(DEFAULT_CONFIG);
      this.rawConfig = cloneConfig(config) as unknown as Record<string, unknown>;
      this.save(config);
      return config;
    }

    try {
      const content = fs.readFileSync(this.configPath, 'utf-8');
      const parsed = JSON.parse(content);
      this.rawConfig = isPlainObject(parsed) ? parsed : {};
      const merged = mergeConfig(DEFAULT_CONFIG, this.rawConfig as Partial<RalphConfig>);

      if (!hasNestedKey(this.rawConfig, ['merge', 'autoIntegrate'])) {
        merged.merge.autoIntegrate = merged.merge.useIntegrationWorktree;
      }

      return merged;
    } catch (error) {
      console.error('Failed to load config, using defaults:', error);
      this.rawConfig = {};
      return cloneConfig(DEFAULT_CONFIG);
    }
  }

  private save(config: RalphConfig): void {
    const tempPath = `${this.configPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(config, null, 2));
    fs.renameSync(tempPath, this.configPath);
    this.rawConfig = cloneConfig(config) as unknown as Record<string, unknown>;
  }

  get(key: string): any {
    const parts = key.split('.');
    let value: any = this.config;

    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = value[part];
      } else {
        return undefined;
      }
    }

    return value;
  }

  set(key: string, value: any): void {
    const parts = key.split('.');
    let target: any = this.config;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!(part in target) || !isPlainObject(target[part])) {
        target[part] = {};
      }
      target = target[part];
    }

    const lastPart = parts[parts.length - 1];
    target[lastPart] = value;

    this.save(this.config);
  }

  has(key: string): boolean {
    const parts = key.split('.');
    let value: unknown = this.rawConfig;

    for (const part of parts) {
      if (!isPlainObject(value) || !(part in value)) {
        return false;
      }

      value = value[part];
    }

    return true;
  }

  list(): RalphConfig {
    return this.config;
  }

  getAll(): RalphConfig {
    return this.config;
  }
}
