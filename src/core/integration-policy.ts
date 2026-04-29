import { ConfigManager } from '../config/manager';
import { MergeStrategy } from './merge';

type ConfigLike = Pick<ConfigManager, 'get'>;

export interface IntegrationPolicy {
  autoIntegrate: boolean;
  publishTargetBranch: boolean;
  allowDestructiveAutoResolve: boolean;
  targetBranch: string;
  strategy: MergeStrategy;
  pullLatest: boolean;
  useIntegrationWorktree: boolean;
  integrationWorktreeDir?: string;
  syncTargetBranch: boolean;
}

export function resolveMergeStrategy(value: unknown): MergeStrategy {
  return value === 'ours' || value === 'theirs' || value === 'manual'
    ? value
    : 'manual';
}

export function resolveMergeTargetBranch(value: unknown): string {
  if (typeof value !== 'string') {
    return 'main';
  }

  const trimmed = value.trim();
  return trimmed || 'main';
}

export function resolveAutoIntegrate(configManager: ConfigLike): boolean {
  const configured = configManager.get('merge.autoIntegrate');
  if (typeof configured === 'boolean') {
    return configured;
  }

  return configManager.get('merge.useIntegrationWorktree') !== false;
}

export function resolveIntegrationPolicy(configManager: ConfigLike): IntegrationPolicy {
  const useIntegrationWorktree = configManager.get('merge.useIntegrationWorktree') !== false;
  const configuredIntegrationDir = configManager.get('merge.integrationWorktreeDir');
  const integrationWorktreeDir = typeof configuredIntegrationDir === 'string' && configuredIntegrationDir.trim()
    ? configuredIntegrationDir.trim()
    : undefined;
  const publishTargetBranch = Boolean(configManager.get('autoMerge'));

  return {
    autoIntegrate: resolveAutoIntegrate(configManager),
    publishTargetBranch,
    allowDestructiveAutoResolve: Boolean(configManager.get('merge.allowDestructiveAutoResolve')),
    targetBranch: resolveMergeTargetBranch(configManager.get('merge.targetBranch')),
    strategy: resolveMergeStrategy(configManager.get('merge.strategy')),
    pullLatest: configManager.get('merge.pullLatest') !== false,
    useIntegrationWorktree,
    integrationWorktreeDir,
    syncTargetBranch: publishTargetBranch && configManager.get('merge.syncTargetBranch') !== false,
  };
}

export function shouldAttemptAutomaticIntegration(policy: IntegrationPolicy): boolean {
  return policy.publishTargetBranch || (policy.autoIntegrate && policy.useIntegrationWorktree);
}
