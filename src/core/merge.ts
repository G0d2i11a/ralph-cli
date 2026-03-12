import { execSync } from 'child_process';
import { Task } from '../types/task';

export type MergeStrategy = 'ours' | 'theirs' | 'manual';

export interface MergeResult {
  success: boolean;
  hasConflicts: boolean;
  message: string;
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

export async function mergeBranch(
  task: Task,
  targetBranch: string = 'main',
  strategy: MergeStrategy = 'manual'
): Promise<MergeResult> {
  try {
    const repoPath = task.repoPath;
    
    // Switch to target branch
    execSync(`git checkout ${targetBranch}`, { cwd: repoPath });
    
    // Pull latest
    execSync('git pull', { cwd: repoPath });
    
    // Get branch name from worktree
    const branchName = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: task.worktree,
      encoding: 'utf-8'
    }).trim();
    
    // Try to merge
    try {
      execSync(`git merge ${branchName} --no-ff`, { cwd: repoPath });
      return {
        success: true,
        hasConflicts: false,
        message: `Successfully merged ${branchName} into ${targetBranch}`
      };
    } catch (error) {
      // Merge conflict detected
      if (strategy === 'manual') {
        return {
          success: false,
          hasConflicts: true,
          message: 'Merge conflicts detected. Manual resolution required.'
        };
      }
      
      // Auto-resolve conflicts
      if (strategy === 'ours') {
        execSync('git checkout --ours .', { cwd: repoPath });
      } else if (strategy === 'theirs') {
        execSync('git checkout --theirs .', { cwd: repoPath });
      }
      
      // Stage resolved files
      execSync('git add .', { cwd: repoPath });
      
      // Complete merge
      execSync(`git commit -m "feat: merge ${branchName} (auto-resolved with ${strategy})"`, {
        cwd: repoPath
      });
      
      return {
        success: true,
        hasConflicts: true,
        message: `Merged ${branchName} with conflicts auto-resolved using ${strategy} strategy`
      };
    }
  } catch (error) {
    return {
      success: false,
      hasConflicts: false,
      message: `Merge failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

export function detectConflicts(repoPath: string): string[] {
  try {
    const output = execSync('git diff --name-only --diff-filter=U', {
      cwd: repoPath,
      encoding: 'utf-8'
    });
    return output.trim().split('\n').filter(line => line.length > 0);
  } catch {
    return [];
  }
}
