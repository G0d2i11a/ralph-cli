import { Task } from '../types/task';
import { MergeResult, MergeStrategy } from './merge';

export type MergeFailureError = Error & {
  mergeResult?: MergeResult;
  taskUpdates?: Partial<Task>;
};

export function isDestructiveMergeStrategy(strategy: MergeStrategy): boolean {
  return strategy === 'ours' || strategy === 'theirs';
}

export function formatDestructiveAutoResolveError(strategy: MergeStrategy): string {
  return `Unattended autoMerge with '${strategy}' is disabled because it can silently drop one side of a conflict. Use manual merge repair or set merge.allowDestructiveAutoResolve=true explicitly.`;
}

export function buildMergeFailureUpdates(
  result: MergeResult,
  targetBranch: string,
  strategy: MergeStrategy
): Partial<Task> {
  return {
    mergeTargetBranch: targetBranch,
    mergeStrategy: strategy,
    mergeError: result.message,
    integrationBranch: result.integrationBranch,
    integrationWorktree: result.integrationWorktree,
    mergeConflictFiles: result.conflictFiles,
    mergeConflictAt: result.hasConflicts ? Date.now() : undefined,
  };
}

export function createMergeFailureError(
  result: MergeResult,
  updates: Partial<Task>
): MergeFailureError {
  const error = new Error(result.message) as MergeFailureError;
  error.mergeResult = result;
  error.taskUpdates = updates;
  return error;
}

export function getTaskUpdatesFromError(error: unknown): Partial<Task> {
  if (error && typeof error === 'object' && 'taskUpdates' in error) {
    const updates = (error as MergeFailureError).taskUpdates;
    if (updates) {
      return updates;
    }
  }

  return {};
}
