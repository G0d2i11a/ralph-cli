import { enqueueTaskFromPrd } from '../core/task-intake';

export async function startCommand(
  prdPath: string,
  options: { repo?: string; agent?: string; backend?: string }
): Promise<void> {
  try {
    const { taskId, latestTask, pendingState } = await enqueueTaskFromPrd(prdPath, {
      repoPath: options.repo,
      agent: options.agent,
      backend: options.backend,
    });

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
      reason: pendingState.reason === 'dependencies' ? 'waiting for dependencies' : 'queued',
      backend: latestTask.backend,
      dependencies: pendingState.dependencies,
      concurrencyLimit: pendingState.maxConcurrent,
      message: pendingState.reason === 'dependencies'
        ? 'Task will start automatically when dependencies are completed'
        : 'Task queued and will start automatically when capacity is available',
    }));
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exit(1);
  }
}
