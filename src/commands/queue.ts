import { ConfigManager } from '../config/manager';
import { resolveAutoIntegrate } from '../core/integration-policy';
import { getManagerStatus, ManagerStatus } from '../core/manager-state';
import { buildCoordinationState } from '../core/task-coordination';
import { summarizeActiveRepoPaths } from '../core/task-home-summary';
import { buildAutoRecoveryState, buildDeliveryState, buildTransientRetryState, resolveTaskIntegrationStatus } from '../core/task-delivery';
import { evaluateAutoRecovery } from '../core/auto-recovery-state';
import { StateManager } from '../core/state';
import { TaskScheduler } from '../core/scheduler';
import { Task } from '../types/task';
import { resolveRalphHome } from '../core/paths';

interface PendingSummary {
  reason: 'dependencies' | 'coordination' | 'queued';
  dependencies: string[];
  dependencyBlockers?: unknown[];
  failedDependencies?: string[];
  recoveringDependencies?: string[];
  missingDependencies?: string[];
  blockers: string[];
  failedBlockers?: string[];
  recoveringBlockers?: string[];
  coordinationReason?: string;
  integrationLane?: string;
  maxConcurrent: number;
  running: number;
}

interface QueueCommandOptions {
  watch?: boolean;
  interval?: string | number;
  staleAfterMs?: string | number;
  recentCompletedWindowSeconds?: string | number;
  recentCompletedLimit?: string | number;
  compact?: boolean;
}

interface QueueManagerStatus extends ManagerStatus {
  heartbeatStaleSuppressed?: boolean;
  heartbeatStaleSuppressedReason?: string;
  finalizerLease?: {
    taskId: string;
    owner?: string;
    heartbeatAt?: string;
    expiresAt: string;
  };
}

function parsePositiveNumber(value: string | number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : undefined;
}

export function findFreshFinalizerLease(tasks: Task[], now: number): Task | undefined {
  return tasks
    .filter((task) => (
      task.status === 'finalizing'
      && typeof task.leaseExpiresAt === 'number'
      && task.leaseExpiresAt > now
    ))
    .sort((left, right) => (right.leaseExpiresAt ?? 0) - (left.leaseExpiresAt ?? 0))[0];
}

export function adjustManagerStatusForFinalizerLease(
  manager: ManagerStatus,
  finalizerTask: Task | undefined,
): QueueManagerStatus {
  if (
    !finalizerTask
    || !manager.heartbeatStale
    || manager.processRunning === false
  ) {
    return manager;
  }

  return {
    ...manager,
    heartbeatStale: false,
    heartbeatStaleSuppressed: true,
    heartbeatStaleSuppressedReason: 'active_finalizer_lease',
    message: `manager heartbeat is stale, but task ${finalizerTask.id} has an active finalizer lease`,
    finalizerLease: {
      taskId: finalizerTask.id,
      owner: finalizerTask.leaseOwner,
      heartbeatAt: finalizerTask.leaseHeartbeatAt
        ? new Date(finalizerTask.leaseHeartbeatAt).toISOString()
        : undefined,
      expiresAt: new Date(finalizerTask.leaseExpiresAt as number).toISOString(),
    },
  };
}

function hasResolvedMergeRepair(task: Task): boolean {
  return task.mergeRepairDisplayStatus === 'resolved_pending_finalize'
    || task.mergeRepairDisplayStatus === 'probe_mergeable';
}

function isIntegratedCompletion(task: Task): boolean {
  return task.status === 'completed' && resolveTaskIntegrationStatus(task) === 'integrated';
}

function hasStoppedRecoveryState(task: Task): boolean {
  return Boolean(
    task.autoRecoveryStoppedAt
    || task.mergeRepairRecoveryStoppedAt
    || task.transientRecoveryStoppedAt
    || task.failedBlockerRecoveryStoppedAt
    || task.finalizeRepairStoppedAt
    || task.mergeRepairDisplayStatus === 'stopped'
  );
}

function stoppedFailedReason(task: Task): string {
  if (task.mergeConflictPhase === 'integration_sync') {
    return 'integration_sync_conflict';
  }

  if (task.mergeRepairRecoveryStoppedAt || task.mergeRepairDisplayStatus === 'stopped') {
    return 'merge_repair_stopped';
  }

  if (task.lastErrorKind === 'story_incomplete') {
    return 'story_incomplete';
  }

  if (task.transientRecoveryStoppedAt) {
    return 'transient_recovery_stopped';
  }

  if (task.failedBlockerRecoveryStoppedAt) {
    return 'failed_blocker_recovery_stopped';
  }

  if (task.finalizeRepairStoppedAt) {
    return 'finalize_repair_stopped';
  }

  return 'task_failed';
}

export function deriveAttention(task: Task, pendingState?: PendingSummary): { needed: boolean; reason?: string } {
  const integrationStatus = resolveTaskIntegrationStatus(task);
  const autoRecoveryActive = evaluateAutoRecovery(task).active;
  const mergeRepairRecovered = hasResolvedMergeRepair(task);
  const hasBlockedConflict = Boolean(task.mergeConflictFiles?.length || integrationStatus === 'blocked_conflict');

  if (task.status === 'pending') {
    if (pendingState?.failedDependencies?.length) {
      return { needed: true, reason: 'blocked_failed_dependency' };
    }

    if (pendingState?.failedBlockers?.length) {
      return { needed: true, reason: 'blocked_failed_coordination' };
    }
  }

  if (task.status === 'failed') {
    return autoRecoveryActive
      ? { needed: false }
      : { needed: true, reason: stoppedFailedReason(task) };
  }

  if (task.status === 'stagnant') {
    return autoRecoveryActive
      ? { needed: false }
      : { needed: true, reason: hasStoppedRecoveryState(task) ? 'stagnant_recovery_stopped' : 'task_stagnant' };
  }

  if (task.status === 'failed_finalize') {
    if (mergeRepairRecovered || (hasBlockedConflict && autoRecoveryActive)) {
      return { needed: false };
    }

    return {
      needed: true,
      reason: hasBlockedConflict ? 'finalize_blocked_conflict' : 'finalize_failed',
    };
  }

  if (task.status === 'completed') {
    if (integrationStatus === 'failed') {
      return { needed: true, reason: 'integration_failed' };
    }

    if (integrationStatus === 'blocked_conflict') {
      return mergeRepairRecovered || autoRecoveryActive
        ? { needed: false }
        : { needed: true, reason: 'integration_blocked_conflict' };
    }
  }

  return { needed: false };
}

function toCompactStoryProgress(
  storyProgress: Task['storyProgress'],
) {
  return storyProgress?.map((story) => ({
    id: story.id,
    status: story.status,
    attempts: story.attempts,
    updatedAt: story.updatedAt,
  }));
}

function toCompactRepairContext(repairContext: Task['repairContext']) {
  if (!repairContext) {
    return undefined;
  }

  return {
    mode: repairContext.mode,
    storyId: repairContext.storyId,
    createdAt: repairContext.createdAt,
  };
}

function compactDeliveryState(delivery: ReturnType<typeof buildDeliveryState>) {
  return {
    integrationStatus: delivery.integrationStatus,
    integrationStatusSource: delivery.integrationStatusSource,
    integrationInconsistent: delivery.integrationInconsistent,
    hasIntegrationMarker: delivery.hasIntegrationMarker,
    integratedAt: delivery.integratedAt,
    integrationBranch: delivery.integrationBranch,
    targetSyncStatus: delivery.targetSyncStatus,
    mergeTargetBranch: delivery.mergeTargetBranch,
    mergeStrategy: delivery.mergeStrategy,
  };
}

function compactCoordinationState(coordination: ReturnType<typeof buildCoordinationState>) {
  if (!coordination) {
    return undefined;
  }

  return {
    status: coordination.status,
    phase: coordination.phase,
    blockers: coordination.blockers,
    reason: coordination.reason,
    lane: coordination.lane,
  };
}

function compactTaskSummary(taskSummary: Record<string, any>) {
  return {
    id: taskSummary.id,
    status: taskSummary.status,
    prdId: taskSummary.prdId,
    prdTitle: taskSummary.prdTitle,
    prdPath: taskSummary.prdPath,
    repoPath: taskSummary.repoPath,
    worktree: taskSummary.worktree,
    integrationStatus: taskSummary.delivery?.integrationStatus,
    updatedAt: taskSummary.updatedAt,
    currentUS: taskSummary.currentUS,
    completedUS: taskSummary.completedUS,
    storyProgress: toCompactStoryProgress(taskSummary.storyProgress),
    repairContext: toCompactRepairContext(taskSummary.repairContext),
    errorMessage: taskSummary.errorMessage,
    mergeError: taskSummary.mergeError,
    reason: taskSummary.reason,
    blockers: taskSummary.blockers,
    failedDependencies: taskSummary.failedDependencies,
    recoveringDependencies: taskSummary.recoveringDependencies,
    missingDependencies: taskSummary.missingDependencies,
    failedBlockers: taskSummary.failedBlockers,
    recoveringBlockers: taskSummary.recoveringBlockers,
    slotUsage: taskSummary.slotUsage,
    lease: taskSummary.lease,
    transientRetry: taskSummary.transientRetry,
    autoRecovery: taskSummary.autoRecovery,
    delivery: compactDeliveryState(taskSummary.delivery),
    coordination: compactCoordinationState(taskSummary.coordination),
    attention: taskSummary.attention,
    attentionReason: taskSummary.attentionReason,
    nextAction: taskSummary.nextAction,
  };
}

function summarizeTask(
  task: Task,
  pendingState?: PendingSummary,
  autoIntegrateEnabled: boolean = false,
  compact: boolean = false,
) {
  const delivery = buildDeliveryState(task);
  const coordination = buildCoordinationState(task);
  const transientRetry = buildTransientRetryState(task);
  const autoRecovery = buildAutoRecoveryState(task);
  const attention = deriveAttention(task, pendingState);

  const taskSummary = {
    id: task.id,
    status: task.status,
    prdId: task.prdId,
    prdTitle: task.prdTitle,
    prdPath: task.prdPath,
    repoPath: task.repoPath,
    worktree: task.worktree,
    updatedAt: task.updatedAt,
    currentUS: task.currentUS,
    completedUS: task.completedUS.length,
    storyProgress: task.storyProgress,
    repairContext: task.repairContext,
    errorMessage: task.lastError,
    mergeError: task.mergeError,
    reason: pendingState?.reason,
    dependencyBlockers: pendingState?.dependencyBlockers,
    failedDependencies: pendingState?.failedDependencies,
    recoveringDependencies: pendingState?.recoveringDependencies,
    missingDependencies: pendingState?.missingDependencies,
    blockers: pendingState?.reason === 'dependencies'
      ? pendingState.dependencies
      : pendingState?.blockers ?? [],
    failedBlockers: pendingState?.failedBlockers,
    recoveringBlockers: pendingState?.recoveringBlockers,
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
    failure: task.lastError
      ? {
          message: task.lastError,
          kind: task.lastErrorKind,
          class: task.lastErrorClass,
          retryable: task.lastErrorRetryable,
          observedAt: task.lastErrorObservedAt ? new Date(task.lastErrorObservedAt).toISOString() : undefined,
          finalizerFailure: task.finalizerFailure
            ? {
                class: task.finalizerFailure.class,
                gate: task.finalizerFailure.gate,
                requestedGate: task.finalizerFailure.requestedGate,
                packageLabel: task.finalizerFailure.packageLabel,
                diagnosticCount: task.finalizerFailure.diagnosticCount,
                failedFiles: task.finalizerFailure.failedFiles,
                failedCodes: task.finalizerFailure.failedCodes,
                failedSymbols: task.finalizerFailure.failedSymbols,
              }
            : undefined,
        }
      : undefined,
    transientRetry,
    autoRecovery,
    delivery,
    coordination,
    attention,
    attentionReason: attention.reason,
    nextAction: resolveNextAction(task, pendingState, autoIntegrateEnabled),
  };

  return compact ? compactTaskSummary(taskSummary) : taskSummary;
}

export function resolveNextAction(task: Task, pendingState?: PendingSummary, autoIntegrateEnabled: boolean = false): string {
  const integrationStatus = resolveTaskIntegrationStatus(task);

  if (task.status === 'pending') {
    if (pendingState?.reason === 'dependencies') {
      if (pendingState.failedDependencies?.length) {
        return `blocked by failed dependencies: ${pendingState.failedDependencies.join(', ')}; retry or repair those PRDs before this can start`;
      }

      if (pendingState.recoveringDependencies?.length) {
        return `wait for dependency auto-recovery: ${pendingState.recoveringDependencies.join(', ')}`;
      }

      return `wait for integrated dependencies: ${pendingState.dependencies.join(', ')}`;
    }

    if (pendingState?.reason === 'coordination') {
      if (pendingState.failedBlockers?.length) {
        return `blocked by failed overlapping task(s): ${pendingState.failedBlockers.join(', ')}; retry or repair the blocker before this can start`;
      }

      if (pendingState.recoveringBlockers?.length) {
        return `wait for overlapping task auto-recovery: ${pendingState.recoveringBlockers.join(', ')}`;
      }

      return `wait for earlier overlapping task(s) to integrate: ${pendingState.blockers.join(', ')}`;
    }

    if (task.repairContext?.mode === 'merge') {
      return `start merge repair anchored to ${task.repairContext.storyId}`;
    }

    if (task.repairContext?.mode === 'finalize') {
      return `start finalize repair anchored to ${task.repairContext.storyId}`;
    }

    return 'start when a concurrency slot is available';
  }

  if (task.status === 'running') {
    if (task.lastErrorRetryable && (task.transientRetryCount ?? 0) > 0) {
      const budget = task.transientRetryBudget ?? '?';
      return `wait for transient retry (${task.transientRetryCount}/${budget}) or worker completion`;
    }

    if (task.currentUS) {
      if (task.repairContext?.storyId === task.currentUS) {
        return `${task.repairContext.mode} repair is executing on ${task.currentUS}`;
      }

      return `worker is executing ${task.currentUS}`;
    }

    return 'wait for worker completion or stale lease recovery';
  }

  if (task.status === 'failed' && evaluateAutoRecovery(task).active) {
    if (task.autoRecoveryNextEligibleAt && task.autoRecoveryNextEligibleAt > Date.now()) {
      return `wait for ${task.autoRecoveryKind} auto-recovery cooldown`;
    }

    return `wait for ${task.autoRecoveryKind} auto-recovery requeue`;
  }

  if (task.status === 'failed') {
    if (task.mergeConflictPhase === 'integration_sync') {
      return 'resolve the integration branch sync conflict, then retry the blocked task';
    }

    if (task.mergeRepairRecoveryStoppedAt || task.mergeRepairDisplayStatus === 'stopped') {
      return 'manual merge repair required; resolve conflicts in the task worktree or explicitly reset/requeue the repair story';
    }

    if (task.lastErrorKind === 'story_incomplete') {
      return 'repair or reset incomplete stories before finalization can be retried';
    }

    if (task.transientRecoveryStoppedAt) {
      return 'inspect stopped transient recovery and explicitly retry or repair';
    }

    if (task.failedBlockerRecoveryStoppedAt) {
      return 'inspect stopped failed-blocker recovery and explicitly retry, repair, or archive';
    }

    return 'inspect failure and explicitly retry, repair, or archive';
  }

  if (task.status === 'stagnant' && !evaluateAutoRecovery(task).active) {
    return 'inspect stagnant task and explicitly retry, repair, or archive';
  }

  if (task.status === 'completed') {
    if (
      task.mergeConflictFiles?.length
      || integrationStatus === 'blocked_conflict'
    ) {
      return 'resolve integration conflict to unblock later tasks';
    }

    if (integrationStatus === 'failed') {
      return 'inspect integration failure before later overlapping tasks can finalize';
    }

    if (integrationStatus !== 'integrated') {
      return autoIntegrateEnabled
        ? 'manager should integrate this completed task into the integration worktree'
        : 'integrate or merge this completed task before later overlapping work can finalize';
    }

    return 'terminal';
  }

  if (
    task.status === 'failed_finalize'
    && (
      task.mergeConflictFiles?.length
      || integrationStatus === 'blocked_conflict'
    )
  ) {
    return 'resolve integration conflict or let manager run merge repair, then rerun finalizer';
  }

  if (task.status === 'failed_finalize' && integrationStatus === 'failed') {
    return 'inspect integration failure, then rerun finalizer';
  }

  if (
    (task.status === 'ready_to_finalize' || task.status === 'failed_finalize')
    && task.coordinationStatus === 'blocked_observed_overlap'
    && task.coordinationBlockers?.length
  ) {
    return `wait for earlier overlapping task(s) to integrate: ${task.coordinationBlockers.join(', ')}`;
  }

  if (task.status === 'ready_to_finalize' || task.status === 'failed_finalize') {
    return 'manager/finalize should run restricted finalizer';
  }

  if (task.status === 'finalizing') {
    return 'wait for finalizer completion or stale lease recovery';
  }

  return 'terminal';
}

async function buildQueueSnapshot(
  staleAfterMs?: number,
  recentCompletedWindowSeconds: number = 7200,
  recentCompletedLimit: number = 5,
  compact: boolean = false,
) {
  const stateManager = new StateManager();
  const scheduler = new TaskScheduler({ stateManager });
  const configManager = new ConfigManager();
  const ralphHome = resolveRalphHome();
  const autoIntegrateEnabled = resolveAutoIntegrate(configManager);
  const snapshotNow = Date.now();
  const tasks = await stateManager.listTasks();
  const manager = adjustManagerStatusForFinalizerLease(
    getManagerStatus({ ralphHome, staleAfterMs, now: () => snapshotNow }),
    findFreshFinalizerLease(tasks, snapshotNow),
  );
  const activeTasks = tasks.filter((task) => (
    task.status === 'pending'
    || task.status === 'running'
    || task.status === 'ready_to_finalize'
    || task.status === 'finalizing'
    || task.status === 'failed_finalize'
    || (
      (task.status === 'failed' || task.status === 'stagnant')
      && (
        deriveAttention(task).needed
        || evaluateAutoRecovery(task).active
        || hasStoppedRecoveryState(task)
      )
    )
    || (task.status === 'completed' && resolveTaskIntegrationStatus(task) !== 'integrated')
  ));

  const output = [];
  for (const task of activeTasks) {
    const pendingState = task.status === 'pending'
      ? await scheduler.describePendingTask(task, { readOnly: true })
      : undefined;
    output.push(summarizeTask(task, pendingState, autoIntegrateEnabled, compact));
  }
  const repoSummary = summarizeActiveRepoPaths(activeTasks);
  const recentCompletedThreshold = snapshotNow - (recentCompletedWindowSeconds * 1000);
  const recentCompleted = tasks
    .filter((task) => isIntegratedCompletion(task) && (task.updatedAt ?? 0) >= recentCompletedThreshold)
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
    .slice(0, recentCompletedLimit)
    .map((task) => summarizeTask(task, undefined, autoIntegrateEnabled, compact));
  const attention = output
    .filter((task) => task.attention.needed)
    .map((task) => ({
      id: task.id,
      status: task.status,
      prdId: task.prdId,
      repoPath: task.repoPath,
      reason: task.attention.reason,
      blockers: task.failedDependencies?.length
        ? task.failedDependencies
        : task.failedBlockers?.length
          ? task.failedBlockers
          : task.blockers,
      nextAction: task.nextAction,
    }));
  const byStatus = output.reduce<Record<string, number>>((counts, task) => {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
    return counts;
  }, {});
  const summary = {
    totalActive: output.length,
    totalAttention: attention.length,
    recentCompletedCount: recentCompleted.length,
    autoRecoveryActive: activeTasks.filter((task) => evaluateAutoRecovery(task).active).length,
    blockedConflict: output.filter((task) => task.delivery.integrationStatus === 'blocked_conflict').length,
    byStatus,
  };

  return {
    snapshotAt: new Date().toISOString(),
    ralphHome,
    ...repoSummary,
    manager,
    summary,
    attention,
    recentCompleted,
    tasks: output,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function queueCommand(options: QueueCommandOptions = {}): Promise<void> {
  const staleAfterMs = parsePositiveNumber(options.staleAfterMs);
  const intervalMs = parsePositiveNumber(options.interval) ?? 10000;
  const recentCompletedWindowSeconds = parsePositiveNumber(options.recentCompletedWindowSeconds) ?? 7200;
  const recentCompletedLimit = parsePositiveNumber(options.recentCompletedLimit) ?? 5;
  const compact = Boolean(options.compact);

  if (!options.watch) {
    console.log(JSON.stringify(await buildQueueSnapshot(
      staleAfterMs,
      recentCompletedWindowSeconds,
      recentCompletedLimit,
      compact,
    )));
    return;
  }

  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    while (!stopped) {
      console.log(JSON.stringify(await buildQueueSnapshot(
        staleAfterMs,
        recentCompletedWindowSeconds,
        recentCompletedLimit,
        compact,
      )));
      if (stopped) {
        break;
      }
      await sleep(intervalMs);
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
