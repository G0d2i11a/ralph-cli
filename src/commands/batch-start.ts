import { resolve } from 'path';
import {
  assessPrdPaths,
  enqueueTaskFromPrd,
  PrdPreflightResult,
} from '../core/task-intake';
import { DEFAULT_AGENT, resolveAgentType } from '../core/agent';
import { assertNoDuplicateRepoManagers } from '../core/repo-manager-registry';
import { StateManager } from '../core/state';

interface BatchStartOptions {
  repo?: string;
  agent?: string;
  backend?: string;
  allowDuplicate?: boolean;
  allowUmbrellaPrd?: boolean;
}

function formatPreflightResult(result: PrdPreflightResult) {
  return {
    prdPath: result.prdPath,
    absolutePrdPath: result.absolutePrdPath,
    prdId: result.prdId,
    title: result.title,
    action: result.decision,
    success: false,
    reasons: result.issues.map((issue) => issue.kind),
    issues: result.issues,
    activeDuplicates: result.activeDuplicates,
    completedDuplicates: result.completedDuplicates,
    missingDependencies: result.missingDependencies,
    blockedBatchDependencies: result.blockedBatchDependencies,
    writeSurfaceOverlaps: result.writeSurfaceOverlaps,
  };
}

export async function batchStartCommand(prdPaths: string[], options: BatchStartOptions) {
  const repo = options.repo ? resolve(options.repo) : process.cwd();
  const agent = resolveAgentType(options.agent || DEFAULT_AGENT);
  const stateManager = new StateManager();
  assertNoDuplicateRepoManagers({
    repoPath: repo,
    operation: 'batch-start Ralph tasks',
  });
  const preflightResults = await assessPrdPaths(prdPaths, {
    repoPath: repo,
    stateManager,
    allowUmbrellaPrd: options.allowUmbrellaPrd,
  });

  const results: Array<{
    prdPath: string;
    absolutePrdPath?: string;
    prdId?: string;
    title?: string;
    action?: string;
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
  const enqueued: unknown[] = [];
  const blocked = preflightResults
    .filter((result) => result.decision === 'blocked')
    .map(formatPreflightResult);
  const skipped = preflightResults
    .filter((result) => result.decision === 'skipped')
    .map(formatPreflightResult);
  const errors: unknown[] = [];

  for (const preflight of preflightResults.filter((result) => result.decision === 'ready')) {
    try {
      const queuedTask = await enqueueTaskFromPrd(preflight.absolutePrdPath, {
        repoPath: repo,
        agent,
        backend: options.backend,
        allowDuplicate: options.allowDuplicate,
        allowUmbrellaPrd: options.allowUmbrellaPrd,
        stateManager,
      });

      const enqueuedResult = {
        prdPath: preflight.prdPath,
        absolutePrdPath: preflight.absolutePrdPath,
        prdId: preflight.prdId,
        title: preflight.title,
        action: 'enqueued',
        success: true,
        taskId: queuedTask.taskId,
        worktree: queuedTask.latestTask.worktree,
        logPath: queuedTask.latestTask.logPath,
        status: queuedTask.latestTask.status,
        backend: queuedTask.latestTask.backend,
        sessionId: queuedTask.latestTask.sessionId,
        threadId: queuedTask.latestTask.threadId,
        ...(queuedTask.alreadyExists ? { existing: true } : {}),
      };
      enqueued.push(enqueuedResult);
      results.push(enqueuedResult);
    } catch (error) {
      const failedResult = {
        prdPath: preflight.prdPath,
        absolutePrdPath: preflight.absolutePrdPath,
        prdId: preflight.prdId,
        title: preflight.title,
        action: 'failed',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
      errors.push(failedResult);
      results.push(failedResult);
    }
  }

  results.push(...blocked, ...skipped);

  // Output results as JSON
  console.log(JSON.stringify({
    total: prdPaths.length,
    successful: enqueued.length,
    failed: blocked.length + skipped.length + errors.length,
    enqueued,
    blocked,
    skipped,
    errors,
    results,
  }));

  if (blocked.length > 0 || skipped.length > 0 || errors.length > 0) {
    process.exit(1);
  }
}
