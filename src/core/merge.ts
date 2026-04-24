import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Task } from '../types/task';
import { withRepoMergeLock } from './locks';

export type MergeStrategy = 'ours' | 'theirs' | 'manual';

export interface MergeResult {
  success: boolean;
  hasConflicts: boolean;
  message: string;
  commitSha?: string;
  alreadyMerged?: boolean;
  integrationBranch?: string;
  integrationWorktree?: string;
  targetSynced?: boolean;
  targetSyncMessage?: string;
}

export interface MergeOptions {
  pullLatest?: boolean;
  useIntegrationWorktree?: boolean;
  integrationWorktreeDir?: string;
  syncTargetBranch?: boolean;
}

interface GitWorktree {
  path: string;
  branch?: string;
}

export class MergeQueue {
  private queue: string[] = [];
  private processing = false;

  add(taskId: string): void {
    if (!this.queue.includes(taskId)) {
      this.queue.push(taskId);
    }
  }

  remove(taskId: string): void {
    this.queue = this.queue.filter(id => id !== taskId);
  }

  getNext(): string | null {
    return this.queue[0] || null;
  }

  isProcessing(): boolean {
    return this.processing;
  }

  setProcessing(value: boolean): void {
    this.processing = value;
  }

  getQueue(): string[] {
    return [...this.queue];
  }
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryRunGit(cwd: string, args: string[]): string | null {
  try {
    return runGit(cwd, args);
  } catch {
    return null;
  }
}

function normalizeBranchName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '').trim();
}

function sanitizePathSegment(value: string): string {
  return normalizeBranchName(value).replace(/[^A-Za-z0-9._-]+/g, '-');
}

function getHeadCommit(repoPath: string): string | undefined {
  return tryRunGit(repoPath, ['rev-parse', 'HEAD']) || undefined;
}

function getCurrentBranch(repoPath: string): string | undefined {
  return tryRunGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']) || undefined;
}

function getPorcelainStatus(repoPath: string): string {
  const status = tryRunGit(repoPath, ['status', '--porcelain']) || '';
  return status
    .split('\n')
    .filter((line) => {
      const filePath = line.slice(3);
      return filePath
        && !filePath.startsWith('.ralph-worktrees/')
        && !filePath.startsWith('.ralph-integration/')
        && !filePath.startsWith('.ralph/');
    })
    .join('\n');
}

function hasUpstream(repoPath: string): boolean {
  return Boolean(tryRunGit(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']));
}

function tryAbortMerge(repoPath: string): void {
  try {
    runGit(repoPath, ['merge', '--abort']);
  } catch {
    // Ignore when no merge is active.
  }
}

function branchExists(repoPath: string, branchName: string): boolean {
  return tryRunGit(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]) !== null;
}

function isGitWorktree(worktreePath: string): boolean {
  return tryRunGit(worktreePath, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

function listWorktrees(repoPath: string): GitWorktree[] {
  const output = tryRunGit(repoPath, ['worktree', 'list', '--porcelain']) || '';
  const worktrees: GitWorktree[] = [];
  let current: GitWorktree | null = null;

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) {
        worktrees.push(current);
      }
      current = { path: line.slice('worktree '.length) };
      continue;
    }

    if (current && line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length);
    }
  }

  if (current) {
    worktrees.push(current);
  }

  return worktrees;
}

function ensureIntegrationWorktree(
  repoPath: string,
  targetBranch: string,
  integrationWorktreeDir: string,
): { integrationBranch: string; integrationWorktree: string } {
  const normalizedTarget = normalizeBranchName(targetBranch);
  const integrationBranch = `ralph/integration/${normalizedTarget}`;
  const integrationRoot = path.isAbsolute(integrationWorktreeDir)
    ? integrationWorktreeDir
    : path.join(repoPath, integrationWorktreeDir);
  const integrationWorktree = path.join(integrationRoot, sanitizePathSegment(normalizedTarget));
  const currentWorktree = listWorktrees(repoPath).find((worktree) => worktree.path === integrationWorktree);

  fs.mkdirSync(path.dirname(integrationWorktree), { recursive: true });

  if (currentWorktree && currentWorktree.branch !== integrationBranch) {
    runGit(repoPath, ['worktree', 'remove', '--force', integrationWorktree]);
  } else if (fs.existsSync(integrationWorktree) && !isGitWorktree(integrationWorktree)) {
    fs.rmSync(integrationWorktree, { recursive: true, force: true });
  }

  if (!branchExists(repoPath, integrationBranch)) {
    runGit(repoPath, ['branch', integrationBranch, normalizedTarget]);
  }

  if (!fs.existsSync(integrationWorktree) || !isGitWorktree(integrationWorktree)) {
    runGit(repoPath, ['worktree', 'add', integrationWorktree, integrationBranch]);
  }

  return { integrationBranch, integrationWorktree };
}

function resetIntegrationWorktree(integrationWorktree: string): void {
  tryAbortMerge(integrationWorktree);
  runGit(integrationWorktree, ['reset', '--hard']);
  runGit(integrationWorktree, ['clean', '-fd']);
}

function mergeIntoIntegration(
  integrationWorktree: string,
  sourceRef: string,
  message: string,
): void {
  try {
    runGit(integrationWorktree, ['merge', '--ff-only', sourceRef]);
  } catch {
    runGit(integrationWorktree, ['merge', sourceRef, '--no-ff', '-m', message]);
  }
}

function syncTargetBranchIfSafe(
  repoPath: string,
  targetBranch: string,
  commitSha: string,
): { synced: boolean; message: string } {
  const normalizedTarget = normalizeBranchName(targetBranch);
  const targetCheckouts = listWorktrees(repoPath).filter((worktree) => worktree.branch === normalizedTarget);

  if (targetCheckouts.length === 0) {
    const currentTarget = tryRunGit(repoPath, ['rev-parse', normalizedTarget]);
    if (currentTarget) {
      runGit(repoPath, ['update-ref', `refs/heads/${normalizedTarget}`, commitSha, currentTarget]);
    } else {
      runGit(repoPath, ['update-ref', `refs/heads/${normalizedTarget}`, commitSha]);
    }

    return {
      synced: true,
      message: `${normalizedTarget} updated to ${commitSha}`,
    };
  }

  const dirtyCheckout = targetCheckouts.find((worktree) => getPorcelainStatus(worktree.path));
  if (dirtyCheckout) {
    return {
      synced: false,
      message: `${normalizedTarget} sync deferred: checkout ${dirtyCheckout.path} has uncommitted changes`,
    };
  }

  for (const worktree of targetCheckouts) {
    runGit(worktree.path, ['merge', '--ff-only', commitSha]);
  }

  return {
    synced: true,
    message: `${normalizedTarget} fast-forwarded to ${commitSha}`,
  };
}

function mergeConflictResult(
  repoPath: string,
  conflicts: string[],
): MergeResult {
  tryAbortMerge(repoPath);
  return {
    success: false,
    hasConflicts: true,
    message: `Merge conflicts detected: ${conflicts.join(', ')}`,
  };
}

async function mergeBranchInLiveCheckout(
  task: Task,
  targetBranch: string,
  strategy: MergeStrategy,
  options: MergeOptions,
): Promise<MergeResult> {
  const repoPath = task.repoPath;
  const originalBranch = getCurrentBranch(repoPath);
  let mergeInProgress = false;

  try {
    const pullLatest = options.pullLatest !== false;
    const dirtyStatus = getPorcelainStatus(repoPath);

    if (dirtyStatus) {
      return {
        success: false,
        hasConflicts: false,
        message: 'Merge refused: repository working tree has uncommitted changes',
      };
    }

    runGit(repoPath, ['checkout', targetBranch]);

    if (pullLatest && hasUpstream(repoPath)) {
      runGit(repoPath, ['pull', '--ff-only']);
    }

    const branchName = runGit(task.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);

    try {
      runGit(repoPath, ['merge-base', '--is-ancestor', branchName, 'HEAD']);
      return {
        success: true,
        hasConflicts: false,
        alreadyMerged: true,
        commitSha: getHeadCommit(repoPath),
        targetSynced: true,
        message: `${branchName} is already merged into ${targetBranch}`,
      };
    } catch {
      // Not merged yet.
    }

    try {
      mergeInProgress = true;
      runGit(repoPath, ['merge', branchName, '--no-ff']);
      mergeInProgress = false;
      return {
        success: true,
        hasConflicts: false,
        commitSha: getHeadCommit(repoPath),
        targetSynced: true,
        message: `Successfully merged ${branchName} into ${targetBranch}`,
      };
    } catch (error) {
      const conflicts = detectConflicts(repoPath);

      if (conflicts.length === 0) {
        return {
          success: false,
          hasConflicts: false,
          message: `Merge failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      if (strategy === 'manual') {
        mergeInProgress = false;
        return mergeConflictResult(repoPath, conflicts);
      }

      if (strategy === 'ours') {
        runGit(repoPath, ['checkout', '--ours', '.']);
      } else {
        runGit(repoPath, ['checkout', '--theirs', '.']);
      }

      runGit(repoPath, ['add', '.']);
      runGit(repoPath, ['commit', '-m', `feat: merge ${branchName} (auto-resolved with ${strategy})`]);
      mergeInProgress = false;

      return {
        success: true,
        hasConflicts: true,
        commitSha: getHeadCommit(repoPath),
        targetSynced: true,
        message: `Merged ${branchName} with conflicts auto-resolved using ${strategy} strategy`,
      };
    }
  } catch (error) {
    return {
      success: false,
      hasConflicts: false,
      message: `Merge failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (mergeInProgress) {
      tryAbortMerge(repoPath);
    }

    const currentBranch = getCurrentBranch(repoPath);
    if (originalBranch && currentBranch && currentBranch !== originalBranch) {
      tryRunGit(repoPath, ['checkout', originalBranch]);
    }
  }
}

async function mergeBranchInIntegrationWorktree(
  task: Task,
  targetBranch: string,
  strategy: MergeStrategy,
  options: MergeOptions,
): Promise<MergeResult> {
  const normalizedTarget = normalizeBranchName(targetBranch);
  const repoPath = task.repoPath;
  const branchName = runGit(task.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const integration = ensureIntegrationWorktree(
    repoPath,
    normalizedTarget,
    options.integrationWorktreeDir || '.ralph-integration',
  );
  let mergeInProgress = false;

  try {
    resetIntegrationWorktree(integration.integrationWorktree);

    if (options.pullLatest !== false && hasUpstream(repoPath)) {
      runGit(integration.integrationWorktree, ['fetch']);
    }

    try {
      mergeIntoIntegration(
        integration.integrationWorktree,
        normalizedTarget,
        `chore: sync ${normalizedTarget} into ${integration.integrationBranch}`,
      );
    } catch (error) {
      const conflicts = detectConflicts(integration.integrationWorktree);
      if (conflicts.length > 0) {
        return {
          ...mergeConflictResult(integration.integrationWorktree, conflicts),
          integrationBranch: integration.integrationBranch,
          integrationWorktree: integration.integrationWorktree,
        };
      }

      return {
        success: false,
        hasConflicts: false,
        integrationBranch: integration.integrationBranch,
        integrationWorktree: integration.integrationWorktree,
        message: `Integration branch sync failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    try {
      runGit(integration.integrationWorktree, ['merge-base', '--is-ancestor', branchName, 'HEAD']);
      const commitSha = getHeadCommit(integration.integrationWorktree);
      const targetSync = options.syncTargetBranch === false || !commitSha
        ? { synced: false, message: 'target sync disabled' }
        : syncTargetBranchIfSafe(repoPath, normalizedTarget, commitSha);

      return {
        success: true,
        hasConflicts: false,
        alreadyMerged: true,
        commitSha,
        integrationBranch: integration.integrationBranch,
        integrationWorktree: integration.integrationWorktree,
        targetSynced: targetSync.synced,
        targetSyncMessage: targetSync.message,
        message: `${branchName} is already integrated in ${integration.integrationBranch}; ${targetSync.message}`,
      };
    } catch {
      // Not merged yet.
    }

    try {
      mergeInProgress = true;
      runGit(integration.integrationWorktree, ['merge', branchName, '--no-ff']);
      mergeInProgress = false;
    } catch (error) {
      const conflicts = detectConflicts(integration.integrationWorktree);

      if (conflicts.length === 0) {
        return {
          success: false,
          hasConflicts: false,
          integrationBranch: integration.integrationBranch,
          integrationWorktree: integration.integrationWorktree,
          message: `Merge failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      if (strategy === 'manual') {
        mergeInProgress = false;
        return {
          ...mergeConflictResult(integration.integrationWorktree, conflicts),
          integrationBranch: integration.integrationBranch,
          integrationWorktree: integration.integrationWorktree,
        };
      }

      if (strategy === 'ours') {
        runGit(integration.integrationWorktree, ['checkout', '--ours', '.']);
      } else {
        runGit(integration.integrationWorktree, ['checkout', '--theirs', '.']);
      }

      runGit(integration.integrationWorktree, ['add', '.']);
      runGit(integration.integrationWorktree, ['commit', '-m', `feat: merge ${branchName} (auto-resolved with ${strategy})`]);
      mergeInProgress = false;
    }

    const commitSha = getHeadCommit(integration.integrationWorktree);
    const targetSync = options.syncTargetBranch === false || !commitSha
      ? { synced: false, message: 'target sync disabled' }
      : syncTargetBranchIfSafe(repoPath, normalizedTarget, commitSha);
    const syncSuffix = targetSync.synced
      ? `; ${targetSync.message}`
      : `; ${targetSync.message}`;

    return {
      success: true,
      hasConflicts: false,
      commitSha,
      integrationBranch: integration.integrationBranch,
      integrationWorktree: integration.integrationWorktree,
      targetSynced: targetSync.synced,
      targetSyncMessage: targetSync.message,
      message: `Integrated ${branchName} into ${integration.integrationBranch}${syncSuffix}`,
    };
  } catch (error) {
    return {
      success: false,
      hasConflicts: false,
      integrationBranch: integration.integrationBranch,
      integrationWorktree: integration.integrationWorktree,
      message: `Merge failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (mergeInProgress) {
      tryAbortMerge(integration.integrationWorktree);
    }
  }
}

export async function mergeBranch(
  task: Task,
  targetBranch: string = 'main',
  strategy: MergeStrategy = 'manual',
  options: MergeOptions = {}
): Promise<MergeResult> {
  return withRepoMergeLock(task.repoPath, async () => {
    if (options.useIntegrationWorktree === false) {
      return mergeBranchInLiveCheckout(task, targetBranch, strategy, options);
    }

    return mergeBranchInIntegrationWorktree(task, targetBranch, strategy, options);
  });
}

export function detectConflicts(repoPath: string): string[] {
  try {
    const output = runGit(repoPath, ['diff', '--name-only', '--diff-filter=U']);
    return output.trim().split('\n').filter(line => line.length > 0);
  } catch {
    return [];
  }
}
