import { TaskErrorClass } from '../types/task';

export interface TransientRecoveryConfig {
  maxTransientRecoveryRequeues: number;
  transientRecoveryBaseDelaySeconds: number;
  transientRecoveryMaxDelaySeconds: number;
  transientRecoveryDeadlineSeconds: number;
  maxTransientRecoverySameSignature: number;
  transientRecoveryProgressAwareSameSignature: boolean;
  autoRecoveryHardCap: number;
}

export interface FailedBlockerRecoveryConfig {
  autoRemediateFailedBlockers: boolean;
  maxFailedBlockerStoryRequeues: number;
  failedBlockerRecoveryDeadlineSeconds: number;
  failedBlockerRecoveryHardCap: number;
}

export interface StoryRepairRecoveryConfig {
  autoRemediateStoryFailures: boolean;
  maxStoryRepairRequeues: number;
  storyRepairRecoveryDeadlineSeconds: number;
  storyRepairRecoveryHardCap: number;
}

export interface AgentContextRecoveryConfig {
  autoRemediateAgentContextFailures: boolean;
  maxAgentContextRecoveryRequeues: number;
  agentContextRecoveryDeadlineSeconds: number;
  agentContextRecoveryHardCap: number;
}

export interface AutonomyRepairConfig {
  autoRecoverBlockedTasks: boolean;
  autonomyRepairDeadlineSeconds: number;
  autonomyRepairHardCap: number;
  autonomyRepairCooldownBaseSeconds: number;
  autonomyRepairCooldownMaxSeconds: number;
}

const DEFAULT_MAX_TRANSIENT_RECOVERY_REQUEUES = 5;
const DEFAULT_TRANSIENT_RECOVERY_BASE_DELAY_SECONDS = 120;
const DEFAULT_TRANSIENT_RECOVERY_MAX_DELAY_SECONDS = 900;
const DEFAULT_TRANSIENT_RECOVERY_DEADLINE_SECONDS = 7200;
const DEFAULT_MAX_TRANSIENT_RECOVERY_SAME_SIGNATURE = 3;
const DEFAULT_TRANSIENT_RECOVERY_PROGRESS_AWARE_SAME_SIGNATURE = true;
const DEFAULT_AUTO_RECOVERY_HARD_CAP = 20;
const DEFAULT_AUTO_REMEDIATE_FAILED_BLOCKERS = true;
const DEFAULT_MAX_FAILED_BLOCKER_STORY_REQUEUES = 1;
const DEFAULT_FAILED_BLOCKER_RECOVERY_DEADLINE_SECONDS = 7200;
const DEFAULT_FAILED_BLOCKER_RECOVERY_HARD_CAP = 2;
const DEFAULT_AUTO_REMEDIATE_STORY_FAILURES = true;
const DEFAULT_MAX_STORY_REPAIR_REQUEUES = 1;
const DEFAULT_STORY_REPAIR_RECOVERY_DEADLINE_SECONDS = 7200;
const DEFAULT_STORY_REPAIR_RECOVERY_HARD_CAP = 2;
const DEFAULT_AUTO_REMEDIATE_AGENT_CONTEXT_FAILURES = true;
const DEFAULT_MAX_AGENT_CONTEXT_RECOVERY_REQUEUES = 1;
const DEFAULT_AGENT_CONTEXT_RECOVERY_DEADLINE_SECONDS = 7200;
const DEFAULT_AGENT_CONTEXT_RECOVERY_HARD_CAP = 2;
const DEFAULT_AUTO_RECOVER_BLOCKED_TASKS = true;
const DEFAULT_AUTONOMY_REPAIR_DEADLINE_SECONDS = 86400;
const DEFAULT_AUTONOMY_REPAIR_HARD_CAP = 10;
const DEFAULT_AUTONOMY_REPAIR_COOLDOWN_BASE_SECONDS = 60;
const DEFAULT_AUTONOMY_REPAIR_COOLDOWN_MAX_SECONDS = 1800;

export function isTransientTaskErrorClass(
  value?: TaskErrorClass,
): value is 'transient_backend' | 'transport' | 'browser_automation' {
  return value === 'transient_backend'
    || value === 'transport'
    || value === 'browser_automation';
}

export function resolveTransientRecoveryConfig(
  config: Pick<{ get(key: string): unknown }, 'get'>,
): TransientRecoveryConfig {
  return {
    maxTransientRecoveryRequeues: sanitizeCount(
      config.get('runner.maxTransientRecoveryRequeues'),
      DEFAULT_MAX_TRANSIENT_RECOVERY_REQUEUES,
    ),
    transientRecoveryBaseDelaySeconds: sanitizeCount(
      config.get('runner.transientRecoveryBaseDelaySeconds'),
      DEFAULT_TRANSIENT_RECOVERY_BASE_DELAY_SECONDS,
    ),
    transientRecoveryMaxDelaySeconds: sanitizeCount(
      config.get('runner.transientRecoveryMaxDelaySeconds'),
      DEFAULT_TRANSIENT_RECOVERY_MAX_DELAY_SECONDS,
    ),
    transientRecoveryDeadlineSeconds: sanitizeCount(
      config.get('runner.transientRecoveryDeadlineSeconds'),
      DEFAULT_TRANSIENT_RECOVERY_DEADLINE_SECONDS,
    ),
    maxTransientRecoverySameSignature: sanitizeCount(
      config.get('runner.maxTransientRecoverySameSignature'),
      DEFAULT_MAX_TRANSIENT_RECOVERY_SAME_SIGNATURE,
    ),
    transientRecoveryProgressAwareSameSignature: sanitizeBoolean(
      config.get('runner.transientRecoveryProgressAwareSameSignature'),
      DEFAULT_TRANSIENT_RECOVERY_PROGRESS_AWARE_SAME_SIGNATURE,
    ),
    autoRecoveryHardCap: sanitizeCount(
      config.get('runner.autoRecoveryHardCap'),
      DEFAULT_AUTO_RECOVERY_HARD_CAP,
    ),
  };
}

export function resolveFailedBlockerRecoveryConfig(
  config: Pick<{ get(key: string): unknown }, 'get'>,
): FailedBlockerRecoveryConfig {
  return {
    autoRemediateFailedBlockers: sanitizeBoolean(
      config.get('runner.autoRemediateFailedBlockers'),
      DEFAULT_AUTO_REMEDIATE_FAILED_BLOCKERS,
    ),
    maxFailedBlockerStoryRequeues: sanitizeCount(
      config.get('runner.maxFailedBlockerStoryRequeues'),
      DEFAULT_MAX_FAILED_BLOCKER_STORY_REQUEUES,
    ),
    failedBlockerRecoveryDeadlineSeconds: sanitizeCount(
      config.get('runner.failedBlockerRecoveryDeadlineSeconds'),
      DEFAULT_FAILED_BLOCKER_RECOVERY_DEADLINE_SECONDS,
    ),
    failedBlockerRecoveryHardCap: sanitizeCount(
      config.get('runner.failedBlockerRecoveryHardCap'),
      DEFAULT_FAILED_BLOCKER_RECOVERY_HARD_CAP,
    ),
  };
}

export function resolveStoryRepairRecoveryConfig(
  config: Pick<{ get(key: string): unknown }, 'get'>,
): StoryRepairRecoveryConfig {
  return {
    autoRemediateStoryFailures: sanitizeBoolean(
      config.get('runner.autoRemediateStoryFailures'),
      DEFAULT_AUTO_REMEDIATE_STORY_FAILURES,
    ),
    maxStoryRepairRequeues: sanitizeCount(
      config.get('runner.maxStoryRepairRequeues'),
      DEFAULT_MAX_STORY_REPAIR_REQUEUES,
    ),
    storyRepairRecoveryDeadlineSeconds: sanitizeCount(
      config.get('runner.storyRepairRecoveryDeadlineSeconds'),
      DEFAULT_STORY_REPAIR_RECOVERY_DEADLINE_SECONDS,
    ),
    storyRepairRecoveryHardCap: sanitizeCount(
      config.get('runner.storyRepairRecoveryHardCap'),
      DEFAULT_STORY_REPAIR_RECOVERY_HARD_CAP,
    ),
  };
}

export function resolveAgentContextRecoveryConfig(
  config: Pick<{ get(key: string): unknown }, 'get'>,
): AgentContextRecoveryConfig {
  return {
    autoRemediateAgentContextFailures: sanitizeBoolean(
      config.get('runner.autoRemediateAgentContextFailures'),
      DEFAULT_AUTO_REMEDIATE_AGENT_CONTEXT_FAILURES,
    ),
    maxAgentContextRecoveryRequeues: sanitizeCount(
      config.get('runner.maxAgentContextRecoveryRequeues'),
      DEFAULT_MAX_AGENT_CONTEXT_RECOVERY_REQUEUES,
    ),
    agentContextRecoveryDeadlineSeconds: sanitizeCount(
      config.get('runner.agentContextRecoveryDeadlineSeconds'),
      DEFAULT_AGENT_CONTEXT_RECOVERY_DEADLINE_SECONDS,
    ),
    agentContextRecoveryHardCap: sanitizeCount(
      config.get('runner.agentContextRecoveryHardCap'),
      DEFAULT_AGENT_CONTEXT_RECOVERY_HARD_CAP,
    ),
  };
}

export function resolveAutonomyRepairConfig(
  config: Pick<{ get(key: string): unknown }, 'get'>,
): AutonomyRepairConfig {
  const autoRecoverBlockedTasks = sanitizeBoolean(
    config.get('runner.autoRecoverBlockedTasks'),
    DEFAULT_AUTO_RECOVER_BLOCKED_TASKS,
  );
  const autonomyRepairDeadlineSeconds = sanitizeCount(
    config.get('runner.autonomyRepairDeadlineSeconds'),
    DEFAULT_AUTONOMY_REPAIR_DEADLINE_SECONDS,
  );
  const autonomyRepairHardCap = sanitizeCount(
    config.get('runner.autonomyRepairHardCap'),
    DEFAULT_AUTONOMY_REPAIR_HARD_CAP,
  );
  const autonomyRepairCooldownBaseSeconds = sanitizeCount(
    config.get('runner.autonomyRepairCooldownBaseSeconds'),
    DEFAULT_AUTONOMY_REPAIR_COOLDOWN_BASE_SECONDS,
  );
  const autonomyRepairCooldownMaxSeconds = sanitizeCount(
    config.get('runner.autonomyRepairCooldownMaxSeconds'),
    DEFAULT_AUTONOMY_REPAIR_COOLDOWN_MAX_SECONDS,
  );

  return {
    autoRecoverBlockedTasks,
    autonomyRepairDeadlineSeconds,
    autonomyRepairHardCap,
    autonomyRepairCooldownBaseSeconds,
    autonomyRepairCooldownMaxSeconds,
  };
}

export function resolveTransientRecoveryDelayMs(
  requeueCount: number,
  config: TransientRecoveryConfig,
): number {
  const exponent = Math.max(requeueCount - 1, 0);
  const computedSeconds = Math.min(
    config.transientRecoveryBaseDelaySeconds * (2 ** exponent),
    config.transientRecoveryMaxDelaySeconds,
  );

  return Math.max(1000, computedSeconds * 1000);
}

export function resolveAutonomyRepairDelayMs(
  requeueCount: number,
  config: AutonomyRepairConfig,
): number {
  const exponent = Math.max(requeueCount - 1, 0);
  const computedSeconds = Math.min(
    config.autonomyRepairCooldownBaseSeconds * (2 ** exponent),
    config.autonomyRepairCooldownMaxSeconds,
  );

  return Math.max(1000, computedSeconds * 1000);
}

function sanitizeCount(value: unknown, fallback: number): number {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return fallback;
  }

  return Math.floor(numericValue);
}

function sanitizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }

  return fallback;
}
