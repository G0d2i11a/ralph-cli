import { StateManager } from '../core/state';
import { TaskScheduler } from '../core/scheduler';
import { Task } from '../types/task';
import { resolveRalphHome } from '../core/paths';

interface PendingSummary {
  reason: 'dependencies' | 'queued';
  dependencies: string[];
  maxConcurrent: number;
  running: number;
}

function summarizeTask(task: Task, pendingState?: PendingSummary) {
  return {
    id: task.id,
    status: task.status,
    prdId: task.prdId,
    prdPath: task.prdPath,
    repoPath: task.repoPath,
    currentUS: task.currentUS,
    completedUS: task.completedUS.length,
    storyProgress: task.storyProgress,
    reason: pendingState?.reason,
    blockers: pendingState?.dependencies ?? [],
    slotUsage: pendingState
      ? {
          running: pendingState.running,
          maxConcurrent: pendingState.maxConcurrent,
        }
      : undefined,
    lease: task.leaseOwner
      ? {
          owner: task.leaseOwner,
          heartbeatAt: task.leaseHeartbeatAt ? new Date(task.leaseHeartbeatAt).toISOString() : undefined,
          expiresAt: task.leaseExpiresAt ? new Date(task.leaseExpiresAt).toISOString() : undefined,
        }
      : undefined,
    mergeConflict: task.mergeConflictFiles?.length
      ? {
          files: task.mergeConflictFiles,
          at: task.mergeConflictAt ? new Date(task.mergeConflictAt).toISOString() : undefined,
          repairAttempts: task.mergeRepairAttempts ?? 0,
          error: task.mergeError,
        }
      : undefined,
    nextAction: resolveNextAction(task, pendingState),
  };
}

function resolveNextAction(task: Task, pendingState?: PendingSummary): string {
  if (task.status === 'pending') {
    if (pendingState?.reason === 'dependencies') {
      return `wait for integrated dependencies: ${pendingState.dependencies.join(', ')}`;
    }

    return 'start when a concurrency slot is available';
  }

  if (task.status === 'running') {
    return 'wait for worker completion or stale lease recovery';
  }

  if (task.status === 'failed_finalize' && task.mergeConflictFiles?.length) {
    return 'merge conflict repair should run before retrying finalizer';
  }

  if (task.status === 'ready_to_finalize' || task.status === 'failed_finalize') {
    return 'manager/finalize should run restricted finalizer';
  }

  if (task.status === 'finalizing') {
    return 'wait for finalizer completion or stale lease recovery';
  }

  return 'terminal';
}

export async function queueCommand(): Promise<void> {
  const stateManager = new StateManager();
  const scheduler = new TaskScheduler({ stateManager });
  const ralphHome = resolveRalphHome();
  await scheduler.recoverStaleTasks();

  const tasks = await stateManager.listTasks();
  const activeTasks = tasks.filter((task) => (
    task.status === 'pending'
    || task.status === 'running'
    || task.status === 'ready_to_finalize'
    || task.status === 'finalizing'
    || task.status === 'failed_finalize'
  ));

  const output = [];
  for (const task of activeTasks) {
    const pendingState = task.status === 'pending'
      ? await scheduler.describePendingTask(task)
      : undefined;
    output.push(summarizeTask(task, pendingState));
  }

  console.log(JSON.stringify({
    ralphHome,
    tasks: output,
  }));
}
