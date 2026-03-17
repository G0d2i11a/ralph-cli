import { resolve } from 'path';
import { enqueueTaskFromPrd } from '../core/task-intake';
import { DEFAULT_AGENT, resolveAgentType } from '../core/agent';

interface BatchStartOptions {
  repo?: string;
  agent?: string;
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
    error?: string;
  }> = [];

  for (const prdPath of prdPaths) {
    try {
      const absolutePrdPath = resolve(prdPath);

      const queuedTask = await enqueueTaskFromPrd(absolutePrdPath, {
        repoPath: repo,
        agent,
      });

      results.push({
        prdPath,
        success: true,
        taskId: queuedTask.taskId,
        worktree: queuedTask.latestTask.worktree,
        logPath: queuedTask.latestTask.logPath,
        status: queuedTask.latestTask.status,
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
