import * as fs from 'fs';
import { StateManager } from '../core/state';
import { WorktreeManager } from '../core/worktree';
import { Task } from '../types/task';

interface CleanupOptions {
  olderThanHours?: string;
  dryRun?: boolean;
}

const TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'failed_finalize',
  'stagnant',
]);

function isCleanupCandidate(task: Task, cutoffTime: number): boolean {
  if (!TERMINAL_STATUSES.has(task.status)) {
    return false;
  }

  const finishedAt = task.endTime ?? task.updatedAt ?? task.startTime;
  return finishedAt <= cutoffTime && Boolean(task.worktree);
}

export async function cleanupCommand(options: CleanupOptions = {}): Promise<void> {
  const olderThanHours = Number(options.olderThanHours ?? 24);
  const cutoffTime = Date.now() - (Number.isFinite(olderThanHours) && olderThanHours >= 0 ? olderThanHours : 24) * 60 * 60 * 1000;
  const stateManager = new StateManager();
  const worktreeManager = new WorktreeManager();
  const tasks = await stateManager.listTasks();
  const candidates = tasks.filter((task) => isCleanupCandidate(task, cutoffTime));
  const results = [];

  for (const task of candidates) {
    const existed = fs.existsSync(task.worktree);

    if (existed && !options.dryRun) {
      await worktreeManager.removeWorktree(task.repoPath, task.worktree);
    }

    results.push({
      taskId: task.id,
      status: task.status,
      worktree: task.worktree,
      existed,
      removed: existed && !options.dryRun,
    });
  }

  console.log(JSON.stringify({
    dryRun: Boolean(options.dryRun),
    olderThanHours,
    removed: results.filter((result) => result.removed).length,
    candidates: results,
  }));
}
