import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

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
      const lines = output.split('\n');
      
      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          worktrees.push(line.substring(9));
        }
      }

      return worktrees;
    } catch (error) {
      return [];
    }
  }
}
