import { TaskErrorClass } from '../types/task';

export interface TransientRecoveryConfig {
  maxTransientRecoveryRequeues: number;
  transientRecoveryBaseDelaySeconds: number;
  transientRecoveryMaxDelaySeconds: number;
  transientRecoveryDeadlineSeconds: number;
  maxTransientRecoverySameSignature: number;
  autoRecoveryHardCap: number;
}

export interface FailedBlockerRecoveryConfig {
  autoRemediateFailedBlockers: boolean;
  maxFailedBlockerStoryRequeues: number;
  failedBlockerRecoveryDeadlineSeconds: number;
  failedBlockerRecoveryHardCap: number;
}

const DEFAULT_MAX_TRANSIENT_RECOVERY_REQUEUES = 5;
const DEFAULT_TRANSIENT_RECOVERY_BASE_DELAY_SECONDS = 120;
const DEFAULT_TRANSIENT_RECOVERY_MAX_DELAY_SECONDS = 900;
const DEFAULT_TRANSIENT_RECOVERY_DEADLINE_SECONDS = 7200;
const DEFAULT_MAX_TRANSIENT_RECOVERY_SAME_SIGNATURE = 3;
const DEFAULT_AUTO_RECOVERY_HARD_CAP = 20;
const DEFAULT_AUTO_REMEDIATE_FAILED_BLOCKERS = true;
const DEFAULT_MAX_FAILED_BLOCKER_STORY_REQUEUES = 1;
const DEFAULT_FAILED_BLOCKER_RECOVERY_DEADLINE_SECONDS = 7200;
const DEFAULT_FAILED_BLOCKER_RECOVERY_HARD_CAP = 2;

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
