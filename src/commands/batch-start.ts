import { resolve } from 'path';
import { enqueueTaskFromPrd } from '../core/task-intake';
import { DEFAULT_AGENT, resolveAgentType } from '../core/agent';

interface BatchStartOptions {
  repo?: string;
  agent?: string;
  backend?: string;
}

export async function batchStartCommand(prdPaths: string[], options: BatchStartOptions) {
  const repo = options.repo ? resolve(options.repo) : process.cwd();
  const agent = resolveAgentType(options.agent || DEFAULT_AGENT);

  const results: Array<{
    prdPath: string;
    success: boolean;
    taskId?: string;
    worktree?: string;
    logPath?: string;
    status?: string;
    backend?: string;
    sessionId?: string;
    threadId?: string;
    error?: string;
  }> = [];

  for (const prdPath of prdPaths) {
    try {
      const absolutePrdPath = resolve(prdPath);

      const queuedTask = await enqueueTaskFromPrd(absolutePrdPath, {
        repoPath: repo,
        agent,
        backend: options.backend,
      });

      results.push({
        prdPath,
        success: true,
        taskId: queuedTask.taskId,
        worktree: queuedTask.latestTask.worktree,
        logPath: queuedTask.latestTask.logPath,
        status: queuedTask.latestTask.status,
        backend: queuedTask.latestTask.backend,
        sessionId: queuedTask.latestTask.sessionId,
        threadId: queuedTask.latestTask.threadId,
      });
    } catch (error) {
      results.push({
        prdPath,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Output results as JSON
  console.log(JSON.stringify({
    total: prdPaths.length,
    successful: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    results,
  }));

  if (results.some(r => !r.success)) {
    process.exit(1);
  }
}
