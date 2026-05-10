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

export class WorktreeManager {
  async createWorktree(repoPath: string, taskId: string, baseRef?: string): Promise<string> {
    const worktreePath = path.join(repoPath, '.ralph-worktrees', taskId);

    // Ensure worktrees directory exists
    const worktreesDir = path.join(repoPath, '.ralph-worktrees');
    if (!fs.existsSync(worktreesDir)) {
      fs.mkdirSync(worktreesDir, { recursive: true });
    }

    const resolvedBaseRef = baseRef || execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf-8'
    }).trim();

    // Create worktree
    const branchName = `ralph/${taskId}`;
    execFileSync('git', ['worktree', 'add', '-b', branchName, worktreePath, resolvedBaseRef], {
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

    if (exists) {
      try {
        const status = execFileSync('git', ['status', '--porcelain'], {
          cwd: resolvedWorktreePath,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        dirty = status.trim().length > 0;
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
