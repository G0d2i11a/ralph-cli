import { ConfigManager } from '../config/manager';
import { Task, TaskExecutionMode, TaskMergeStrategy } from '../types/task';

type ExecutionModeConfig = Pick<ConfigManager, 'get'>;

export function resolveRunnerExecutionMode(
  configManager: ExecutionModeConfig,
): TaskExecutionMode {
  const configured = configManager.get('runner.executionMode');

  if (configured === 'direct') {
    return 'direct';
  }

  return 'worktree';
}

export function resolveTaskExecutionMode(
  task: Pick<Task, 'executionMode' | 'worktree' | 'repoPath'>,
  configManager: ExecutionModeConfig,
): TaskExecutionMode {
  if (task.executionMode === 'direct' || task.executionMode === 'worktree') {
    return task.executionMode;
  }

  if (task.worktree && task.worktree !== task.repoPath) {
    return 'worktree';
  }

  return resolveRunnerExecutionMode(configManager);
}

export function isDirectExecutionTask(
  task: Pick<Task, 'executionMode'>,
): boolean {
  return task.executionMode === 'direct';
}

export function buildDirectExecutionIntegrationUpdates(
  task: Pick<Task, 'repoPath'>,
  targetBranch: string,
  strategy: TaskMergeStrategy,
  commitSha?: string,
): Partial<Task> {
  const now = Date.now();

  return {
    mergedAt: now,
    integratedAt: now,
    integrationStatus: 'integrated',
    mergeCommitSha: commitSha,
    integrationCommitSha: commitSha,
    integrationBranch: targetBranch,
    integrationWorktree: task.repoPath,
    mergeTargetBranch: targetBranch,
    mergeStrategy: strategy,
    mergeMessage: 'Direct execution committed in the target checkout; no task-branch merge was required',
    mergeError: undefined,
    mergeConflictFiles: undefined,
    mergeConflictPhase: undefined,
    mergeConflictAt: undefined,
    postFinalizeMergeProbeRequired: undefined,
    targetSyncedAt: now,
    targetSyncStatus: 'synced',
    targetSyncDeferredReason: undefined,
    coordinationStatus: undefined,
    coordinationPhase: undefined,
    coordinationBlockers: undefined,
    coordinationReason: undefined,
    mergeRepairDisplayStatus: undefined,
    mergeRepairProof: undefined,
    mergeRepairRecoveryLastObservationSignature: undefined,
  };
}
