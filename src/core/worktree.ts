import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export interface WorktreeInspection {
  path: string;
  exists: boolean;
  registered: boolean;
  branch?: string;
  head?: string;
  dirty: boolean;
  statusPorcelain?: string;
  statusPorcelainV2?: string;
  changedFileCount?: number;
  untrackedFileCount?: number;
  hasStagedChanges?: boolean;
  hasUnstagedChanges?: boolean;
  hasUntrackedFiles?: boolean;
  hasUnmergedPaths?: boolean;
  hasSubmoduleChanges?: boolean;
  statusError?: string;
  pathInsideRalphWorktrees: boolean;
}

export interface WorktreeRemovalResult {
  removed: boolean;
  dryRun: boolean;
  error?: string;
}

interface ParsedGitWorktree {
  path: string;
  head?: string;
  branch?: string;
}

function parseGitWorktreeList(output: string): ParsedGitWorktree[] {
  const worktrees: ParsedGitWorktree[] = [];
  let current: ParsedGitWorktree | undefined;

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: path.resolve(line.substring('worktree '.length)) };
      worktrees.push(current);
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith('HEAD ')) {
      current.head = line.substring('HEAD '.length);
      continue;
    }

    if (line.startsWith('branch ')) {
      current.branch = line.substring('branch '.length);
    }
  }

  return worktrees;
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function runGitString(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 100 * 1024 * 1024,
  });
}

function pathExists(worktreePath: string): boolean {
  return fs.existsSync(worktreePath);
}

function branchExists(repoPath: string, branchName: string): boolean {
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], {
      cwd: repoPath,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function uniqueStalePath(worktreePath: string): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  let candidate = `${worktreePath}.stale-${timestamp}`;
  let suffix = 1;

  while (fs.existsSync(candidate)) {
    candidate = `${worktreePath}.stale-${timestamp}-${suffix++}`;
  }

  return candidate;
}

function summarizeStatusPorcelain(status: string): Pick<
  WorktreeInspection,
  | 'changedFileCount'
  | 'untrackedFileCount'
  | 'hasStagedChanges'
  | 'hasUnstagedChanges'
  | 'hasUntrackedFiles'
  | 'hasUnmergedPaths'
  | 'hasSubmoduleChanges'
> {
  const lines = status.split('\n').filter((line) => line.length > 0);
  let changedFileCount = 0;
  let untrackedFileCount = 0;
  let hasStagedChanges = false;
  let hasUnstagedChanges = false;
  let hasUntrackedFiles = false;
  let hasUnmergedPaths = false;
  let hasSubmoduleChanges = false;

  for (const line of lines) {
    if (line.startsWith('??')) {
      untrackedFileCount += 1;
      hasUntrackedFiles = true;
      continue;
    }

    changedFileCount += 1;
    const indexStatus = line[0] || ' ';
    const worktreeStatus = line[1] || ' ';

    if (indexStatus !== ' ' && indexStatus !== '?') {
      hasStagedChanges = true;
    }

    if (worktreeStatus !== ' ' && worktreeStatus !== '?') {
      hasUnstagedChanges = true;
    }

    if (indexStatus === 'U' || worktreeStatus === 'U' || (indexStatus === 'A' && worktreeStatus === 'A') || (indexStatus === 'D' && worktreeStatus === 'D')) {
      hasUnmergedPaths = true;
    }

    if (line.includes(' S') || line.includes(' m') || line.includes(' ?')) {
      hasSubmoduleChanges = true;
    }
  }

  return {
    changedFileCount,
    untrackedFileCount,
    hasStagedChanges,
    hasUnstagedChanges,
    hasUntrackedFiles,
    hasUnmergedPaths,
    hasSubmoduleChanges,
  };
}

export class WorktreeManager {
  async createWorktree(repoPath: string, taskId: string, baseRef?: string): Promise<string> {
    const worktreePath = path.join(repoPath, '.ralph-worktrees', taskId);

    // Ensure worktrees directory exists
    const worktreesDir = path.join(repoPath, '.ralph-worktrees');
    if (!fs.existsSync(worktreesDir)) {
      fs.mkdirSync(worktreesDir, { recursive: true });
    }

    const registeredWorktree = this.getGitWorktreeInfo(repoPath, worktreePath);
    if (registeredWorktree) {
      return worktreePath;
    }

    if (pathExists(worktreePath)) {
      const resolvedWorktreesDir = path.resolve(worktreesDir);
      const resolvedWorktreePath = path.resolve(worktreePath);

      if (!isPathInside(resolvedWorktreesDir, resolvedWorktreePath) || resolvedWorktreePath === resolvedWorktreesDir) {
        throw new Error(`Refusing to move stale worktree path outside Ralph worktrees root: ${worktreePath}`);
      }

      const stalePath = uniqueStalePath(worktreePath);
      fs.renameSync(worktreePath, stalePath);
    }

    const resolvedBaseRef = baseRef || execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf-8'
    }).trim();

    // Create worktree
    const branchName = `ralph/${taskId}`;
    const args = branchExists(repoPath, branchName)
      ? ['worktree', 'add', worktreePath, branchName]
      : ['worktree', 'add', '-b', branchName, worktreePath, resolvedBaseRef];

    execFileSync('git', args, {
      cwd: repoPath,
      stdio: 'inherit'
    });

    return worktreePath;
  }

  async removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
    try {
      execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], {
        cwd: repoPath,
        stdio: 'inherit'
      });
    } catch (error) {
      console.error(`Failed to remove worktree: ${error}`);
    }
  }

  async removeWorktreeSafe(
    repoPath: string,
    worktreePath: string,
    options: { dryRun?: boolean; force?: boolean } = {},
  ): Promise<WorktreeRemovalResult> {
    if (options.dryRun) {
      return { removed: false, dryRun: true };
    }

    try {
      const args = ['worktree', 'remove'];
      if (options.force) {
        args.push('--force');
      }
      args.push(worktreePath);
      execFileSync('git', args, {
        cwd: repoPath,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { removed: true, dryRun: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { removed: false, dryRun: false, error: message };
    }
  }

  async inspectWorktree(repoPath: string, worktreePath: string): Promise<WorktreeInspection> {
    const resolvedRepoPath = path.resolve(repoPath);
    const resolvedWorktreePath = path.resolve(worktreePath);
    const worktreesRoot = path.join(resolvedRepoPath, '.ralph-worktrees');
    const exists = fs.existsSync(resolvedWorktreePath);
    let pathInsideRalphWorktrees = isPathInside(worktreesRoot, resolvedWorktreePath);

    if (exists) {
      try {
        const realRoot = fs.existsSync(worktreesRoot) ? fs.realpathSync(worktreesRoot) : worktreesRoot;
        const realWorktree = fs.realpathSync(resolvedWorktreePath);
        pathInsideRalphWorktrees = isPathInside(realRoot, realWorktree);
      } catch {
        pathInsideRalphWorktrees = false;
      }
    }

    const gitWorktree = this.getGitWorktreeInfo(resolvedRepoPath, resolvedWorktreePath);
    let dirty = false;
    let statusError: string | undefined;

    if (exists && !gitWorktree) {
      let changedFileCount = 0;
      try {
        changedFileCount = fs.readdirSync(resolvedWorktreePath).length;
        dirty = changedFileCount > 0;
      } catch (error) {
        statusError = error instanceof Error ? error.message : String(error);
      }

      return {
        path: resolvedWorktreePath,
        exists,
        registered: false,
        dirty,
        changedFileCount,
        statusError: statusError || 'Path exists but is not registered as a git worktree',
        pathInsideRalphWorktrees,
      };
    }

    if (exists) {
      try {
        const status = runGitString(resolvedWorktreePath, ['status', '--porcelain']);
        dirty = status.trim().length > 0;
        const summary = summarizeStatusPorcelain(status);
        return {
          path: resolvedWorktreePath,
          exists,
          registered: Boolean(gitWorktree),
          branch: gitWorktree?.branch,
          head: gitWorktree?.head,
          dirty,
          statusPorcelain: status,
          ...summary,
          pathInsideRalphWorktrees,
        };
      } catch (error) {
        statusError = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      path: resolvedWorktreePath,
      exists,
      registered: Boolean(gitWorktree),
      branch: gitWorktree?.branch,
      head: gitWorktree?.head,
      dirty,
      statusError,
      pathInsideRalphWorktrees,
    };
  }

  async getWorktreeStatusPorcelainV2(worktreePath: string): Promise<string> {
    return runGitString(worktreePath, ['status', '--porcelain=v2', '--branch']);
  }

  async getWorktreeStatusShort(worktreePath: string): Promise<string> {
    return runGitString(worktreePath, ['status', '--short', '--branch']);
  }

  async getWorktreeDiffPatch(worktreePath: string): Promise<string> {
    return runGitString(worktreePath, ['diff', '--binary', '--full-index']);
  }

  async getWorktreeCachedDiffPatch(worktreePath: string): Promise<string> {
    return runGitString(worktreePath, ['diff', '--cached', '--binary', '--full-index']);
  }

  async listUntrackedFiles(worktreePath: string): Promise<string[]> {
    const output = runGitString(worktreePath, ['ls-files', '--others', '--exclude-standard']);
    return output.split('\n').map((line) => line.trim()).filter(Boolean);
  }

  async listTrackedAndOtherFiles(worktreePath: string): Promise<string[]> {
    const output = runGitString(worktreePath, ['ls-files', '-co', '--exclude-standard']);
    return output.split('\n').map((line) => line.trim()).filter(Boolean);
  }

  async getWorktreeListPorcelain(repoPath: string): Promise<string> {
    return runGitString(repoPath, ['worktree', 'list', '--porcelain']);
  }

  async pruneWorktreeMetadata(repoPath: string): Promise<void> {
    try {
      execFileSync('git', ['worktree', 'prune'], {
        cwd: repoPath,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      // Best effort only.
    }
  }

  async checkWorktreeStatus(worktreePath: string): Promise<boolean> {
    return fs.existsSync(worktreePath);
  }

  async listWorktrees(repoPath: string): Promise<string[]> {
    try {
      const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: repoPath,
        encoding: 'utf-8'
      });

      const worktrees: string[] = [];
      for (const worktree of parseGitWorktreeList(output)) {
        worktrees.push(worktree.path);
      }

      return worktrees;
    } catch (error) {
      return [];
    }
  }

  private getGitWorktreeInfo(repoPath: string, worktreePath: string): ParsedGitWorktree | undefined {
    try {
      const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const resolvedWorktreePath = path.resolve(worktreePath);
      return parseGitWorktreeList(output)
        .find((entry) => path.resolve(entry.path) === resolvedWorktreePath);
    } catch {
      return undefined;
    }
  }
}
