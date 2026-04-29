import { enqueueTaskFromPrd } from '../core/task-intake';

export async function startCommand(
  prdPath: string,
  options: { repo?: string; agent?: string; backend?: string; allowDuplicate?: boolean }
): Promise<void> {
  try {
    const { taskId, latestTask, pendingState, alreadyExists } = await enqueueTaskFromPrd(prdPath, {
      repoPath: options.repo,
      agent: options.agent,
      backend: options.backend,
      allowDuplicate: options.allowDuplicate,
    });

    if (alreadyExists) {
      console.log(JSON.stringify({
        taskId,
        status: latestTask.status,
        existing: true,
        worktree: latestTask.worktree,
        logPath: latestTask.logPath,
        backend: latestTask.backend,
        message: 'An active task for this PRD already exists; pass --allow-duplicate to enqueue another one',
      }));
      return;
    }

    if (latestTask.status === 'running') {
      console.log(JSON.stringify({
        taskId,
        status: 'started',
        worktree: latestTask.worktree,
        logPath: latestTask.logPath,
        backend: latestTask.backend,
        sessionId: latestTask.sessionId,
        threadId: latestTask.threadId,
      }));
      return;
    }

    if (latestTask.status !== 'pending' || !pendingState) {
      throw new Error(`Task ${taskId} could not be scheduled (status: ${latestTask.status})`);
    }

    console.log(JSON.stringify({
      taskId,
      status: 'pending',
      reason: pendingState.reason === 'dependencies'
        ? pendingState.failedDependencies?.length
          ? 'blocked by failed dependencies'
          : 'waiting for dependencies'
        : pendingState.reason === 'coordination'
          ? pendingState.failedBlockers?.length
            ? 'blocked by failed overlapping tasks'
            : 'waiting for overlapping task integration'
          : 'queued',
      backend: latestTask.backend,
      dependencies: pendingState.dependencies,
      failedDependencies: pendingState.failedDependencies,
      recoveringDependencies: pendingState.recoveringDependencies,
      blockers: pendingState.blockers,
      failedBlockers: pendingState.failedBlockers,
      recoveringBlockers: pendingState.recoveringBlockers,
      coordinationReason: pendingState.coordinationReason,
      integrationLane: pendingState.integrationLane,
      concurrencyLimit: pendingState.maxConcurrent,
      message: pendingState.reason === 'dependencies'
        ? pendingState.failedDependencies?.length
          ? 'Task is blocked until failed dependency PRDs are retried or repaired'
          : 'Task will start automatically when dependencies are completed'
        : pendingState.reason === 'coordination'
          ? pendingState.failedBlockers?.length
            ? 'Task is blocked until failed overlapping task(s) are retried or repaired'
            : 'Task will start automatically after earlier overlapping tasks integrate'
        : 'Task queued and will start automatically when capacity is available',
    }));
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exit(1);
  }
}
