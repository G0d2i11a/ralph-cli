import { ConfigManager } from '../config/manager';
import { buildAutoRecoveryState, buildDeliveryState, buildTransientRetryState } from '../core/task-delivery';
import { buildCoordinationState } from '../core/task-coordination';
import { StateManager } from '../core/state';
import { isProcessRunning, formatDuration, loadTaskPRD, STAGNATION_THRESHOLDS } from '../utils/helpers';

interface StatusOptions {
  detailed?: boolean;
}

export async function statusCommand(taskId?: string, options?: StatusOptions): Promise<void> {
  try {
    const stateManager = new StateManager();
    const configManager = new ConfigManager();

    if (!taskId) {
      const tasks = await stateManager.listTasks('running');
      console.log(JSON.stringify({
        tasks: tasks.map((task) => ({
          coordinationStatus: buildCoordinationState(task)?.status,
          id: task.id,
          status: task.status,
          currentUS: task.currentUS,
          completedUS: task.completedUS.length,
          backend: task.backend,
          duration: formatDuration(Date.now() - task.startTime),
          running: task.pid ? isProcessRunning(task.pid) : false,
          lastErrorKind: task.lastErrorKind,
          lastErrorClass: task.lastErrorClass,
          transientRetryCount: task.transientRetryCount,
          integrationStatus: buildDeliveryState(task).integrationStatus,
          targetSyncStatus: buildDeliveryState(task).targetSyncStatus,
        }))
      }));
      return;
    }

    const task = await stateManager.loadTask(taskId);

    if (!task) {
      console.error(JSON.stringify({ error: `Task ${taskId} not found` }));
      process.exit(1);
    }

    const running = task.pid ? isProcessRunning(task.pid) : false;
    const duration = task.endTime
      ? formatDuration(task.endTime - task.startTime)
      : formatDuration(Date.now() - task.startTime);
    const delivery = buildDeliveryState(task);
    const coordination = buildCoordinationState(task);
    const transientRetry = buildTransientRetryState(task);
    const autoRecovery = buildAutoRecoveryState(task);

    const basicStatus = {
      id: task.id,
      status: task.status,
      agent: task.agent,
      backend: task.backend,
      prdPath: task.prdPath,
      prdId: task.prdId,
      prdTitle: task.prdTitle,
      prdDependencies: task.prdDependencies,
      prdSourceHash: task.prdSourceHash,
      enqueuedAt: task.enqueuedAt ? new Date(task.enqueuedAt).toISOString() : undefined,
      baseRef: task.baseRef,
      baseCommitSha: task.baseCommitSha,
      intendedMergeTarget: task.intendedMergeTarget,
      worktree: task.worktree,
      logPath: task.logPath,
      currentUS: task.currentUS,
      completedUS: task.completedUS,
      storyProgress: task.storyProgress,
      sessionId: task.sessionId,
      threadId: task.threadId,
      duration,
      running,
      pid: task.pid,
      leaseOwner: task.leaseOwner,
      leaseHeartbeatAt: task.leaseHeartbeatAt ? new Date(task.leaseHeartbeatAt).toISOString() : undefined,
      leaseExpiresAt: task.leaseExpiresAt ? new Date(task.leaseExpiresAt).toISOString() : undefined,
      finalizerCommitMessage: task.finalizerCommitMessage,
      finalizerCommittedAt: task.finalizerCommittedAt ? new Date(task.finalizerCommittedAt).toISOString() : undefined,
      integratedAt: task.integratedAt ? new Date(task.integratedAt).toISOString() : undefined,
      integrationStatus: delivery.integrationStatus,
      integrationCommitSha: task.integrationCommitSha,
      integrationBranch: task.integrationBranch,
      integrationWorktree: task.integrationWorktree,
      mergedAt: task.mergedAt ? new Date(task.mergedAt).toISOString() : undefined,
      mergeCommitSha: task.mergeCommitSha,
      mergeTargetBranch: task.mergeTargetBranch,
      mergeStrategy: task.mergeStrategy,
      mergeMessage: task.mergeMessage,
      mergeError: task.mergeError,
      targetSyncedAt: task.targetSyncedAt ? new Date(task.targetSyncedAt).toISOString() : undefined,
      targetSyncStatus: delivery.targetSyncStatus,
      targetSyncDeferredReason: task.targetSyncDeferredReason,
      lastError: task.lastError,
      lastErrorKind: task.lastErrorKind,
      lastErrorClass: task.lastErrorClass,
      lastErrorRetryable: task.lastErrorRetryable,
      lastErrorObservedAt: task.lastErrorObservedAt ? new Date(task.lastErrorObservedAt).toISOString() : undefined,
      finalizerFailure: task.finalizerFailure,
      repairContext: task.repairContext,
      transientRetryCount: task.transientRetryCount,
      transientRetryBudget: task.transientRetryBudget,
      transientRetryLastDelayMs: task.transientRetryLastDelayMs,
      autoRecovery,
      delivery,
      coordination,
      transientRetry,
    };

    if (!options?.detailed) {
      console.log(JSON.stringify(basicStatus));
      return;
    }

    let userStories: import('../types/prd').UserStory[] = [];

    try {
      userStories = loadTaskPRD(task).userStories;
    } catch {
      userStories = [];
    }

    const completedStoryIds = new Set(task.completedUS);
    const completedStories = userStories.filter((story) => completedStoryIds.has(story.id) || story.passes).length;
    const totalStories = userStories.length;

    const loopCount = task.loopCount || 0;
    const consecutiveNoProgress = task.consecutiveNoProgress || 0;
    const consecutiveErrors = task.consecutiveErrors || 0;
    const transientRetryActive = Boolean(
      task.lastErrorRetryable
      && (task.transientRetryCount ?? 0) > 0
      && (
        task.transientRetryBudget === undefined
        || (task.transientRetryCount ?? 0) < task.transientRetryBudget
      )
    );

    let isAtRisk = false;
    let riskReason: string | null = null;
    const configuredStagnationTimeoutSeconds = Number(configManager.get('runner.stagnationTimeout'));
    const configuredStagnationTimeoutMs = Number.isFinite(configuredStagnationTimeoutSeconds) && configuredStagnationTimeoutSeconds > 0
      ? configuredStagnationTimeoutSeconds * 1000
      : undefined;

    if (transientRetryActive) {
      isAtRisk = false;
      riskReason = null;
    } else if (configuredStagnationTimeoutMs && Date.now() - task.lastProgressTime >= configuredStagnationTimeoutMs * 0.8) {
      isAtRisk = true;
      riskReason = `No progress for ${Math.floor((Date.now() - task.lastProgressTime) / 1000)}s (threshold: ${Math.floor(configuredStagnationTimeoutMs / 1000)}s)`;
    } else if (consecutiveNoProgress >= STAGNATION_THRESHOLDS.NO_PROGRESS_THRESHOLD - 1) {
      isAtRisk = true;
      riskReason = `No file changes for ${consecutiveNoProgress} consecutive updates (threshold: ${STAGNATION_THRESHOLDS.NO_PROGRESS_THRESHOLD})`;
    } else if (!task.lastErrorRetryable && consecutiveErrors >= STAGNATION_THRESHOLDS.CONSECUTIVE_ERRORS_THRESHOLD - 1) {
      isAtRisk = true;
      riskReason = `${consecutiveErrors} consecutive errors (threshold: ${STAGNATION_THRESHOLDS.CONSECUTIVE_ERRORS_THRESHOLD})`;
    }

    console.log(JSON.stringify({
      ...basicStatus,
      progress: {
        completed: completedStories,
        total: totalStories,
        percentage: totalStories > 0 ? Math.round((completedStories / totalStories) * 100) : 0,
      },
      userStories: userStories.map((story) => ({
        id: story.id,
        title: story.title,
        passes: completedStoryIds.has(story.id) || Boolean(story.passes),
        priority: story.priority,
        notes: story.notes,
      })),
      stagnation: {
        loopCount,
        consecutiveNoProgress,
        consecutiveErrors,
        lastError: task.lastError,
        lastErrorKind: task.lastErrorKind,
        lastErrorClass: task.lastErrorClass,
        lastErrorRetryable: task.lastErrorRetryable,
        lastErrorObservedAt: task.lastErrorObservedAt ? new Date(task.lastErrorObservedAt).toISOString() : undefined,
        transientRetry,
        autoRecovery,
        transientRetryActive,
        isAtRisk,
        riskReason,
      },
      delivery,
      coordination,
    }));
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    }));
    process.exit(1);
  }
}
