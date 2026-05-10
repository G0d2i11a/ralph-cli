import { ConfigManager } from '../config/manager';
import { resolveAutoIntegrate } from '../core/integration-policy';
import { getManagerStatus, ManagerStatus } from '../core/manager-state';
import { buildPrdInventory } from '../core/prd-inventory';
import { buildCoordinationState, hasHotConflictReservation } from '../core/task-coordination';
import {
  buildAutoRecoveryState,
  buildDeliveryState,
  buildTransientRetryState,
  resolveTaskIntegrationStatus,
  resolveTaskTargetSyncStatus,
} from '../core/task-delivery';
import { evaluateAutoRecovery, resolveTaskRecoveryKind } from '../core/auto-recovery-state';
import { isBaselineQualityGateStateCurrent } from '../core/baseline-quality-gate';
import { isDedicatedBaselineRepairTask } from '../core/baseline-repair';
import { buildFailureObservationFromTask } from '../core/failure-observation';
import { StateManager } from '../core/state';
import { TaskScheduler } from '../core/scheduler';
import { Task } from '../types/task';
import { resolveRalphHome } from '../core/paths';
import { detectDuplicateRepoManagers, DuplicateRepoManagerReport } from '../core/repo-manager-registry';

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

export type QueuePhase =
  | 'queued'
  | 'running'
  | 'finalizing'
  | 'recovering'
  | 'blocked'
  | 'awaiting_approval'
  | 'blocked_by_policy'
  | 'diagnostics'
  | 'completed';

export type QueueStateDetail =
  | 'waiting_for_slot'
  | 'worker_running'
  | 'finalizer_running'
  | 'ready_to_finalize'
  | 'completed_integrated'
  | 'completed_pending_integration'
  | 'completed_pending_target_sync'
  | 'retrying_transient'
  | 'retrying_agent_context'
  | 'auto_repairing_story'
  | 'auto_repairing_merge'
  | 'auto_repairing_finalize'
  | 'auto_repairing_baseline'
  | 'auto_repairing_stagnation'
  | 'reclassifying_baseline_failure'
  | 'generating_followup_prd'
  | 'generating_repo_health_prd'
  | 'splitting_story'
  | 'blocked_by_dependency'
  | 'blocked_by_coordination'
  | 'blocked_by_baseline'
  | 'blocked_by_environment'
  | 'blocked_by_manager_ownership'
  | 'blocked_by_ingestion_config'
  | 'blocked_by_deadlock'
  | 'awaiting_destructive_merge_approval'
  | 'awaiting_target_publish_approval'
  | 'awaiting_worktree_overwrite_approval'
  | 'awaiting_baseline_reconcile_approval'
  | 'policy_destructive_merge_disabled'
  | 'policy_target_sync_disabled'
  | 'policy_unsafe_ambiguous_baseline'
  | 'policy_unresolved_merge_conflict'
  | 'policy_active_lease'
  | 'policy_delivery_marker_reset_unsafe'
  | 'policy_duplicate_managers'
  | 'policy_out_of_scope_write'
  | 'policy_unclassified_unsafe_failure'
  | 'diagnosing_failure'
  | 'diagnosing_baseline_probe'
  | 'diagnosing_integration_failure';

export interface QueueRecoveryState {
  kind?: string;
  active?: boolean;
  startedAt?: string;
  deadlineAt?: string;
  nextEligibleAt?: string;
  totalRequeues?: number;
  hardCap?: number;
  stoppedAt?: string;
  stopReason?: string;
  lastReason?: string;
}

export interface QueueApprovalState {
  approvalId: string;
  kind: 'destructive_merge' | 'target_publish' | 'worktree_overwrite' | 'baseline_reconcile';
  risk: string;
  command: string;
  scope?: string[];
}

export interface QueuePolicyState {
  reason: string;
  prohibitedAction: string;
  configKey?: string;
  overridePath?: 'change_config' | 'change_prd' | 'manual_repair' | 'stop_duplicate_manager';
}

export interface QueueState {
  phase: QueuePhase;
  detail: QueueStateDetail;
  reason?: string;
  nextAction: string;
  autonomous: boolean;
  blockers?: string[];
  recovery?: QueueRecoveryState;
  approval?: QueueApprovalState;
  policy?: QueuePolicyState;
}

interface QueueActionItem {
  id: string;
  status: string;
  prdId?: string;
  repoPath?: string;
  queueState: QueueState;
  reason?: string;
  blockers?: string[];
  nextAction: string;
}

interface SystemBlockItem {
  id: string;
  scope: 'system';
  phase: Extract<QueuePhase, 'blocked' | 'awaiting_approval' | 'blocked_by_policy' | 'diagnostics'>;
  detail: QueueStateDetail;
  reason: string;
  repoPath?: string;
  blockers?: string[];
  nextAction: string;
  policy?: QueuePolicyState;
  approval?: QueueApprovalState;
}

interface QueueActionability {
  status: 'idle' | 'runnable' | 'running' | 'recovering' | 'awaiting_approval' | 'blocked' | 'blocked_by_policy' | 'diagnostics' | 'ingestion_backlog';
  reason?: string;
  principalBlocker?: string;
  nextAction?: string;
}

interface QueueStateContext {
  activeBaselineRepairTaskIds?: Set<string>;
  obsoleteBaselineRepairTaskIds?: Set<string>;
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
  if (task.status === 'failed_finalize' && task.finalizerFailure?.failureKind === 'quality_gate') {
    return false;
  }

  if (task.status === 'failed_finalize' && task.repairContext?.mode === 'finalize') {
    return false;
  }

  return task.mergeRepairDisplayStatus === 'resolved_pending_finalize'
    || task.mergeRepairDisplayStatus === 'probe_mergeable';
}

function isIntegratedCompletion(task: Task): boolean {
  return task.status === 'completed' && resolveTaskIntegrationStatus(task) === 'integrated';
}

function isDeliveryPendingCompletion(task: Task): boolean {
  if (!isIntegratedCompletion(task)) {
    return false;
  }

  const targetSyncStatus = resolveTaskTargetSyncStatus(task);
  return targetSyncStatus === 'deferred_dirty_checkout' || targetSyncStatus === 'failed';
}

function isRetryableIntegrationFailure(
  task: Pick<Task, 'integrationStatus' | 'mergeError' | 'mergeMessage'> & { delivery?: { integrationStatus?: string } },
): boolean {
  const integrationStatus = task.delivery?.integrationStatus ?? resolveTaskIntegrationStatus(task);
  if (integrationStatus !== 'failed') {
    return false;
  }

  const message = `${task.mergeError || ''}\n${task.mergeMessage || ''}`.toLowerCase();
  return /git fetch|operation timed out|connection timed out|ssh_dispatch_run_fatal|econnreset|enotfound|network is unreachable|temporary failure/.test(message);
}

function summarizeSnapshotRepoPaths(tasks: Pick<Task, 'repoPath'>[]): {
  repoCount: number;
  mixedRepos: boolean;
  repoPaths: string[];
} {
  const repoPaths = [...new Set(
    tasks
      .map((task) => task.repoPath)
      .filter((repoPath): repoPath is string => Boolean(repoPath))
      .sort()
  )];

  return {
    repoCount: repoPaths.length,
    mixedRepos: repoPaths.length > 1,
    repoPaths,
  };
}

function hasStoppedRecoveryState(task: Task): boolean {
  return Boolean(
    task.autoRecoveryStoppedAt
    || task.mergeRepairRecoveryStoppedAt
    || task.transientRecoveryStoppedAt
    || task.agentContextRecoveryStoppedAt
    || task.failedBlockerRecoveryStoppedAt
    || task.storyRepairRecoveryStoppedAt
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

  if (task.transientRecoveryStoppedAt) {
    return 'transient_recovery_stopped';
  }

  if (task.agentContextRecoveryStoppedAt) {
    return 'agent_context_recovery_stopped';
  }

  if (task.failedBlockerRecoveryStoppedAt) {
    return 'failed_blocker_recovery_stopped';
  }

  if (task.storyRepairRecoveryStoppedAt) {
    return 'story_repair_stopped';
  }

  if (task.lastErrorKind === 'story_incomplete') {
    return 'story_incomplete';
  }

  if (task.finalizeRepairStoppedAt) {
    return 'finalize_repair_stopped';
  }

  if (task.autoRecoveryStoppedAt) {
    return 'generic_recovery_stopped';
  }

  return 'task_failed';
}

function hasActiveBaselineRepair(task: Task, context?: QueueStateContext): boolean {
  const repairTaskId = task.baselineQualityGate?.repairTaskId;
  return Boolean(repairTaskId && context?.activeBaselineRepairTaskIds?.has(repairTaskId));
}

function isSupersededBaselineRepairTask(task: Task): boolean {
  return Boolean(
    task.prdId?.startsWith('baseline-quality-gate:')
    && (
      task.baselineRepair?.status === 'superseded'
      || task.baselineRepair?.supersededByRepairTaskId
    )
  );
}

function hasCurrentBaselineQualityGate(task: Task): boolean {
  return Boolean(task.baselineQualityGate && isBaselineQualityGateStateCurrent(task));
}

function isCurrentBaselineGateStillBlocking(task: Task): boolean {
  const baseline = task.baselineQualityGate;
  if (!baseline || !hasCurrentBaselineQualityGate(task)) {
    return false;
  }

  if (baseline.kind === 'baseline_probe_failed') {
    return true;
  }

  if (baseline.kind !== 'baseline_quality_gate_failure') {
    return false;
  }

  if (baseline.phase === 'baseline_repair_integrated') {
    return false;
  }

  if (baseline.phase === 'stopped' && baseline.stopReason === 'baseline_repair_exhausted') {
    return !Boolean(task.finalizerFailure || task.latestFailure || task.repairContext?.mode === 'finalize');
  }

  return true;
}

function hasIntegrationMarker(task: Task): boolean {
  return Boolean(
    task.integratedAt
    || task.integrationStatus === 'integrated'
    || task.integrationCommitSha
    || task.mergedAt
    || task.mergeCommitSha
  );
}

function allTrackedStoriesPassed(task: Task): boolean {
  if (!task.storyProgress?.length) {
    return task.completedUS.length > 0;
  }

  const completed = new Set(task.completedUS || []);
  return task.storyProgress.every((story) => story.status === 'passed' && completed.has(story.id));
}

function isSafeIntegratedProductState(task: Task): boolean {
  if (isDedicatedBaselineRepairTask(task)) {
    return false;
  }

  if (
    task.status !== 'failed_finalize'
    && task.status !== 'finalizing'
    && task.status !== 'ready_to_finalize'
    && task.status !== 'failed'
  ) {
    return false;
  }

  if (resolveTaskIntegrationStatus(task) !== 'integrated' || !hasIntegrationMarker(task)) {
    return false;
  }

  const targetSyncStatus = resolveTaskTargetSyncStatus(task);
  return targetSyncStatus !== 'failed'
    && targetSyncStatus !== 'deferred_dirty_checkout'
    && allTrackedStoriesPassed(task);
}

function deriveQueueBlockReason(
  task: Task,
  pendingState?: PendingSummary,
  context?: QueueStateContext,
): { blocked: boolean; reason?: string } {
  const integrationStatus = resolveTaskIntegrationStatus(task);
  const autoRecovery = evaluateAutoRecovery(task);
  const autoRecoveryActive = autoRecovery.active;
  const recoveryKind = resolveTaskRecoveryKind(task);
  const mergeRepairRecovered = hasResolvedMergeRepair(task);
  const hasBlockedConflict = Boolean(task.mergeConflictFiles?.length || integrationStatus === 'blocked_conflict');

  if (isSafeIntegratedProductState(task)) {
    return { blocked: false };
  }

  if (task.status === 'pending') {
    if (pendingState?.failedDependencies?.length) {
      return { blocked: true, reason: 'blocked_failed_dependency' };
    }

    if (pendingState?.failedBlockers?.length) {
      return { blocked: true, reason: 'blocked_failed_coordination' };
    }
  }

  if (task.status === 'failed') {
    if (context?.obsoleteBaselineRepairTaskIds?.has(task.id)) {
      return { blocked: false };
    }

    return autoRecoveryActive
      ? { blocked: false }
      : { blocked: true, reason: stoppedFailedReason(task) };
  }

  if (task.status === 'stagnant') {
    return autoRecoveryActive
      ? { blocked: false }
      : { blocked: true, reason: hasStoppedRecoveryState(task) ? 'stagnant_recovery_stopped' : 'task_stagnant' };
  }

  if (task.status === 'failed_finalize') {
    if (isSupersededBaselineRepairTask(task)) {
      return { blocked: false };
    }

    if (
      (recoveryKind === 'finalize_repair' || recoveryKind === 'task_specific_finalize_repair')
      && autoRecoveryActive
      && !hasBlockedConflict
    ) {
      return { blocked: false };
    }

    if (
      task.baselineQualityGate?.kind === 'baseline_quality_gate_failure'
      && isCurrentBaselineGateStillBlocking(task)
    ) {
      if (hasActiveBaselineRepair(task, context)) {
        return { blocked: false };
      }

      if (isBaselineRecoveryKind(recoveryKind) && autoRecoveryActive) {
        return { blocked: false };
      }

      if (task.autoRecoveryStoppedAt || task.baselineQualityGate.stoppedAt || autoRecovery.stoppedAt) {
        const stopReason = task.baselineQualityGate.stopReason
          ?? autoRecovery.stopReason
          ?? task.autoRecoveryStopReason;
        return {
          blocked: true,
          reason: stopReason === 'baseline_repair_exhausted'
            ? 'baseline_repair_exhausted'
            : 'baseline_repair_failed',
        };
      }

      return { blocked: true, reason: 'baseline_quality_gate_failure' };
    }

    if (
      task.baselineQualityGate?.kind === 'baseline_probe_failed'
      && isCurrentBaselineGateStillBlocking(task)
    ) {
      return { blocked: true, reason: 'baseline_quality_gate_probe_failed' };
    }

    if (mergeRepairRecovered || (hasBlockedConflict && autoRecoveryActive)) {
      return { blocked: false };
    }

    return {
      blocked: true,
      reason: hasBlockedConflict ? 'finalize_blocked_conflict' : 'finalize_failed',
    };
  }

  if (task.status === 'completed') {
    if (integrationStatus === 'integrated') {
      const targetSyncStatus = resolveTaskTargetSyncStatus(task);

      if (targetSyncStatus === 'failed') {
        return { blocked: true, reason: 'target_sync_failed' };
      }

      if (targetSyncStatus === 'deferred_dirty_checkout') {
        return { blocked: true, reason: 'target_sync_deferred_dirty_checkout' };
      }
    }

    if (integrationStatus === 'failed') {
      if (isRetryableIntegrationFailure(task)) {
        return { blocked: false };
      }

      return { blocked: true, reason: 'integration_failed' };
    }

    if (integrationStatus === 'blocked_conflict') {
      return mergeRepairRecovered || autoRecoveryActive
        ? { blocked: false }
        : { blocked: true, reason: 'integration_blocked_conflict' };
    }
  }

  return { blocked: false };
}

function toIsoTimestamp(value?: number): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}

function buildQueueRecoveryState(task: Task, active: boolean): QueueRecoveryState | undefined {
  if (
    !task.autoRecoveryKind
    && !task.autonomyRepairKind
    && !task.autoRecoveryStoppedAt
    && !task.autonomyRepairStoppedAt
    && !task.autoRecoveryNextEligibleAt
    && !task.autonomyRepairNextEligibleAt
  ) {
    return undefined;
  }

  const recoveryKind = resolveTaskRecoveryKind(task);

  return {
    kind: recoveryKind,
    active,
    startedAt: toIsoTimestamp(task.autonomyRepairStartedAt),
    deadlineAt: toIsoTimestamp(task.autonomyRepairDeadlineAt),
    nextEligibleAt: toIsoTimestamp(task.autoRecoveryNextEligibleAt ?? task.autonomyRepairNextEligibleAt),
    totalRequeues: task.autoRecoveryTotalRequeues ?? task.autonomyRepairTotalRequeues,
    hardCap: task.autoRecoveryHardCap,
    stoppedAt: toIsoTimestamp(task.autoRecoveryStoppedAt ?? task.autonomyRepairStoppedAt),
    stopReason: task.autoRecoveryStopReason ?? task.autonomyRepairStopReason,
    lastReason: task.autoRecoveryLastReason ?? task.autonomyRepairLastReason,
  };
}

function recoveryDetailForTask(task: Task): QueueStateDetail {
  switch (resolveTaskRecoveryKind(task)) {
  case 'agent_context':
    return 'retrying_agent_context';
  case 'merge_repair':
  case 'stopped_merge_repair':
    return 'auto_repairing_merge';
  case 'finalize_repair':
  case 'task_specific_finalize_repair':
    return 'auto_repairing_finalize';
  case 'stagnant':
    return 'auto_repairing_stagnation';
  case 'story_repair':
    return 'auto_repairing_story';
  case 'baseline_repair':
  case 'baseline_supersession_migration':
    return 'auto_repairing_baseline';
  case 'baseline_exhaustion':
    return 'reclassifying_baseline_failure';
  case 'failed_coordination_blocker':
    return 'generating_followup_prd';
  case 'deadlock_unblock':
    return 'blocked_by_deadlock';
  case 'generic_failed_worker':
  case 'transient':
  default:
    return 'retrying_transient';
  }
}

function isBaselineRecoveryKind(kind?: string): boolean {
  return kind === 'baseline_repair'
    || kind === 'baseline_exhaustion'
    || kind === 'baseline_supersession_migration';
}

function buildQueuePolicy(
  detail: QueueStateDetail,
  reason: string,
): QueuePolicyState | undefined {
  switch (detail) {
  case 'policy_duplicate_managers':
    return {
      reason,
      prohibitedAction: 'multiple managers controlling the same repo',
      overridePath: 'stop_duplicate_manager',
    };
  case 'policy_unresolved_merge_conflict':
    return {
      reason,
      prohibitedAction: 'automatic conflict winner selection',
      overridePath: 'manual_repair',
    };
  case 'policy_target_sync_disabled':
    return {
      reason,
      prohibitedAction: 'publishing to target branch while policy is disabled',
      configKey: 'merge.syncTargetBranch',
      overridePath: 'change_config',
    };
  case 'policy_delivery_marker_reset_unsafe':
    return {
      reason,
      prohibitedAction: 'automatic story reset after delivery markers exist',
      overridePath: 'manual_repair',
    };
  case 'policy_unsafe_ambiguous_baseline':
  case 'policy_unclassified_unsafe_failure':
    return {
      reason,
      prohibitedAction: 'unclassified unsafe repair',
      overridePath: 'manual_repair',
    };
  default:
    return undefined;
  }
}

function blockersForQueueState(task: Task, pendingState?: PendingSummary): string[] | undefined {
  const blockers = pendingState?.failedDependencies?.length
    ? pendingState.failedDependencies
    : pendingState?.failedBlockers?.length
      ? pendingState.failedBlockers
      : pendingState?.recoveringDependencies?.length
        ? pendingState.recoveringDependencies
        : pendingState?.recoveringBlockers?.length
          ? pendingState.recoveringBlockers
          : pendingState?.reason === 'dependencies'
            ? pendingState.dependencies
            : pendingState?.blockers?.length
              ? pendingState.blockers
              : task.coordinationBlockers;

  return blockers?.length ? blockers : undefined;
}

function queueStateFromBlockReason(input: {
  task: Task;
  pendingState?: PendingSummary;
  reason: string;
  nextAction: string;
  autoRecoveryActive: boolean;
}): QueueState {
  const { task, pendingState, reason, nextAction, autoRecoveryActive } = input;
  const recovery = buildQueueRecoveryState(task, autoRecoveryActive);
  const blockers = blockersForQueueState(task, pendingState);

  const state = (
    phase: QueuePhase,
    detail: QueueStateDetail,
    autonomous: boolean,
    extra: Partial<QueueState> = {},
  ): QueueState => ({
    phase,
    detail,
    reason,
    nextAction,
    autonomous,
    blockers,
    recovery,
    ...extra,
  });

  switch (reason) {
  case 'blocked_failed_dependency':
    return state('blocked', 'blocked_by_dependency', false);
  case 'blocked_failed_coordination':
    return state('blocked', 'blocked_by_coordination', false);
  case 'integration_sync_conflict':
  case 'merge_repair_stopped':
    return state('blocked_by_policy', 'policy_unresolved_merge_conflict', false, {
      policy: buildQueuePolicy('policy_unresolved_merge_conflict', reason),
    });
  case 'transient_recovery_stopped':
    return state('recovering', 'retrying_agent_context', true);
  case 'agent_context_recovery_stopped':
  case 'story_repair_stopped':
    return state('recovering', 'splitting_story', true);
  case 'failed_blocker_recovery_stopped':
  case 'generic_recovery_stopped':
    return state('recovering', 'generating_followup_prd', true);
  case 'story_incomplete':
    return state('recovering', 'auto_repairing_story', true);
  case 'stagnant_recovery_stopped':
  case 'task_stagnant':
    return state('recovering', 'auto_repairing_stagnation', true);
  case 'baseline_repair_exhausted':
    return state('recovering', 'reclassifying_baseline_failure', true);
  case 'baseline_repair_failed':
    {
      const hasBaselineRecovery = hasActiveBaselineRepair(task) || isBaselineRecoveryKind(resolveTaskRecoveryKind(task));
      return state(
        hasBaselineRecovery ? 'recovering' : 'blocked',
        hasBaselineRecovery ? 'auto_repairing_baseline' : 'blocked_by_baseline',
        hasBaselineRecovery,
      );
    }
  case 'baseline_quality_gate_failure':
    if (task.baselineQualityGate?.rootCause === 'unsafe_ambiguous') {
      return state('blocked_by_policy', 'policy_unsafe_ambiguous_baseline', false, {
        policy: buildQueuePolicy('policy_unsafe_ambiguous_baseline', reason),
      });
    }
    return state('recovering', 'auto_repairing_baseline', true);
  case 'baseline_quality_gate_probe_failed':
    return state('diagnostics', 'diagnosing_baseline_probe', true);
  case 'finalize_blocked_conflict':
  case 'integration_blocked_conflict':
    return state('recovering', 'auto_repairing_merge', true);
  case 'finalize_repair_stopped':
    return state('diagnostics', 'diagnosing_failure', true);
  case 'finalize_failed':
    return state('recovering', 'auto_repairing_finalize', true);
  case 'target_sync_failed':
  case 'target_sync_deferred_dirty_checkout':
    return state('blocked', 'blocked_by_environment', false);
  case 'integration_failed':
    return state('diagnostics', 'diagnosing_integration_failure', true);
  case 'task_failed':
  default:
    return state('diagnostics', 'diagnosing_failure', true);
  }
}

export function deriveQueueState(
  task: Task,
  pendingState?: PendingSummary,
  context?: QueueStateContext,
  autoIntegrateEnabled: boolean = false,
): QueueState {
  const integrationStatus = resolveTaskIntegrationStatus(task);
  const targetSyncStatus = resolveTaskTargetSyncStatus(task);
  const autoRecovery = evaluateAutoRecovery(task);
  const nextAction = resolveNextAction(task, pendingState, autoIntegrateEnabled, context);
  const recovery = buildQueueRecoveryState(task, autoRecovery.active);
  const blockers = blockersForQueueState(task, pendingState);

  const state = (
    phase: QueuePhase,
    detail: QueueStateDetail,
    autonomous: boolean,
    extra: Partial<QueueState> = {},
  ): QueueState => ({
    phase,
    detail,
    nextAction,
    autonomous,
    blockers,
    recovery,
    ...extra,
  });

  if (isSupersededBaselineRepairTask(task)) {
    return state('completed', 'completed_pending_integration', true, {
      reason: 'baseline_repair_superseded',
    });
  }

  if (isSafeIntegratedProductState(task)) {
    return state('completed', 'completed_integrated', true);
  }

  if (task.status === 'pending') {
    if (pendingState?.failedDependencies?.length) {
      return state('blocked', 'blocked_by_dependency', false, {
        reason: 'blocked_failed_dependency',
      });
    }

    if (pendingState?.failedBlockers?.length) {
      return state('blocked', 'blocked_by_coordination', false, {
        reason: 'blocked_failed_coordination',
      });
    }

    if (pendingState?.recoveringDependencies?.length) {
      return state('recovering', 'blocked_by_dependency', true, {
        reason: 'waiting_for_dependency_recovery',
      });
    }

    if (pendingState?.recoveringBlockers?.length) {
      return state('recovering', 'blocked_by_coordination', true, {
        reason: 'waiting_for_coordination_recovery',
      });
    }

    if (pendingState?.reason === 'dependencies') {
      return state('queued', 'blocked_by_dependency', true, {
        reason: 'waiting_for_dependency',
      });
    }

    if (pendingState?.reason === 'coordination') {
      return state('queued', 'blocked_by_coordination', true, {
        reason: 'waiting_for_coordination',
      });
    }

    return state('queued', 'waiting_for_slot', true);
  }

  if (task.status === 'running') {
    return state('running', 'worker_running', true);
  }

  if (task.status === 'ready_to_finalize') {
    return state('finalizing', 'ready_to_finalize', true);
  }

  if (task.status === 'finalizing') {
    return state('finalizing', 'finalizer_running', true);
  }

  if (task.status === 'failed_finalize' && hasResolvedMergeRepair(task)) {
    return state('finalizing', 'ready_to_finalize', true, {
      reason: 'merge_repair_resolved',
    });
  }

  if (
    task.status === 'failed_finalize'
    && task.baselineQualityGate?.kind === 'baseline_quality_gate_failure'
    && isCurrentBaselineGateStillBlocking(task)
    && hasActiveBaselineRepair(task, context)
  ) {
    return state('blocked', 'blocked_by_baseline', false, {
      reason: 'baseline_quality_gate_failure',
    });
  }

  if (autoRecovery.active && task.status !== 'completed') {
    return state('recovering', recoveryDetailForTask(task), true, {
      reason: autoRecovery.reason ?? task.autoRecoveryLastReason,
    });
  }

  const blockReason = deriveQueueBlockReason(task, pendingState, context);
  if (blockReason.blocked && blockReason.reason) {
    return queueStateFromBlockReason({
      task,
      pendingState,
      reason: blockReason.reason,
      nextAction,
      autoRecoveryActive: autoRecovery.active,
    });
  }

  if (task.status === 'completed') {
    if (integrationStatus === 'integrated') {
      if (targetSyncStatus === 'failed' || targetSyncStatus === 'deferred_dirty_checkout') {
        return state('blocked', 'blocked_by_environment', false, {
          reason: targetSyncStatus === 'failed' ? 'target_sync_failed' : 'target_sync_deferred_dirty_checkout',
        });
      }

      return state('completed', 'completed_integrated', true);
    }

    if (integrationStatus === 'failed' && isRetryableIntegrationFailure(task)) {
      return state('recovering', 'retrying_transient', true, {
        reason: 'retryable_integration_failure',
      });
    }

    if (integrationStatus === 'blocked_conflict') {
      return state('blocked_by_policy', 'policy_unresolved_merge_conflict', false, {
        reason: 'integration_blocked_conflict',
        policy: buildQueuePolicy('policy_unresolved_merge_conflict', 'integration_blocked_conflict'),
      });
    }

    return state('completed', 'completed_pending_integration', autoIntegrateEnabled);
  }

  if (task.status === 'failed' || task.status === 'stagnant' || task.status === 'failed_finalize') {
    return state('diagnostics', 'diagnosing_failure', true, {
      reason: task.status,
    });
  }

  return state('completed', 'completed_integrated', true);
}

export function isActionItem(queueState: QueueState): boolean {
  return queueState.phase === 'blocked'
    || queueState.phase === 'awaiting_approval'
    || queueState.phase === 'blocked_by_policy'
    || queueState.phase === 'diagnostics';
}

function isActiveQueueState(queueState: QueueState): boolean {
  return queueState.phase === 'queued'
    || queueState.phase === 'running'
    || queueState.phase === 'finalizing'
    || queueState.phase === 'recovering'
    || isActionItem(queueState);
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

function buildMergeRepairState(task: Task) {
  const conflictFiles = task.mergeRepairProof?.conflictFiles ?? task.mergeConflictFiles;
  const hasMergeRepairState = Boolean(
    task.repairContext?.mode === 'merge'
    || task.mergeRepairDisplayStatus
    || task.mergeRepairProof
    || conflictFiles?.length
    || task.mergeRepairRecoveryStartedAt !== undefined
    || task.mergeRepairRecoveryStoppedAt !== undefined
  );

  if (!hasMergeRepairState) {
    return undefined;
  }

  return {
    status: task.mergeRepairDisplayStatus,
    storyId: task.repairContext?.mode === 'merge' ? task.repairContext.storyId : undefined,
    attempts: task.mergeRepairAttempts ?? 0,
    integrationBranch: task.mergeRepairProof?.integrationBranch ?? task.integrationBranch,
    conflictCount: conflictFiles?.length ?? 0,
    conflictFiles,
    proof: task.mergeRepairProof,
    recovery: {
      startedAt: task.mergeRepairRecoveryStartedAt
        ? new Date(task.mergeRepairRecoveryStartedAt).toISOString()
        : undefined,
      deadlineAt: task.mergeRepairRecoveryDeadlineAt
        ? new Date(task.mergeRepairRecoveryDeadlineAt).toISOString()
        : undefined,
      totalRequeues: task.mergeRepairRecoveryTotalRequeues ?? 0,
      consecutiveNoProgress: task.mergeRepairRecoveryConsecutiveNoProgress ?? 0,
      lastProgressReason: task.mergeRepairRecoveryLastProgressReason,
      stoppedAt: task.mergeRepairRecoveryStoppedAt
        ? new Date(task.mergeRepairRecoveryStoppedAt).toISOString()
        : undefined,
      stopReason: task.mergeRepairRecoveryStopReason,
    },
  };
}

function compactTaskSummary(taskSummary: Record<string, any>) {
  const summary: Record<string, any> = {
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
    latestFailure: taskSummary.latestFailure,
    baselineQualityGateHistoryCount: taskSummary.baselineQualityGateHistoryCount,
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
    mergeConflict: taskSummary.mergeConflict,
    mergeRepair: taskSummary.mergeRepair,
    baselineQualityGate: taskSummary.baselineQualityGate,
    delivery: compactDeliveryState(taskSummary.delivery),
    coordination: compactCoordinationState(taskSummary.coordination),
    queueState: taskSummary.queueState,
    nextAction: taskSummary.nextAction,
  };

  return summary;
}

function summarizeTask(
  task: Task,
  pendingState?: PendingSummary,
  autoIntegrateEnabled: boolean = false,
  compact: boolean = false,
  queueStateContext?: QueueStateContext,
) {
  const delivery = buildDeliveryState(task);
  const coordination = buildCoordinationState(task);
  const transientRetry = buildTransientRetryState(task);
  const autoRecovery = buildAutoRecoveryState(task);
  const queueState = deriveQueueState(task, pendingState, queueStateContext, autoIntegrateEnabled);
  const latestFailure = task.latestFailure ?? buildFailureObservationFromTask(task);

  const taskSummary: Record<string, any> = {
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
    latestFailure,
    baselineQualityGateHistory: task.baselineQualityGateHistory,
    baselineQualityGateHistoryCount: task.baselineQualityGateHistory?.length ?? 0,
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
    mergeRepair: buildMergeRepairState(task),
    failure: task.lastError
      ? {
          message: task.lastError,
          kind: task.lastErrorKind,
          class: task.lastErrorClass,
          retryable: task.lastErrorRetryable,
          observedAt: task.lastErrorObservedAt ? new Date(task.lastErrorObservedAt).toISOString() : undefined,
          latestFailure,
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
    baselineQualityGate: task.baselineQualityGate,
    transientRetry,
    autoRecovery,
    delivery,
    coordination,
    queueState,
    nextAction: queueState.nextAction,
  };

  return compact ? compactTaskSummary(taskSummary) : taskSummary;
}

export function resolveNextAction(
  task: Task,
  pendingState?: PendingSummary,
  autoIntegrateEnabled: boolean = false,
  context?: QueueStateContext,
): string {
  const integrationStatus = resolveTaskIntegrationStatus(task);

  if (isSupersededBaselineRepairTask(task)) {
    return task.baselineRepair?.supersededByRepairTaskId
      ? `superseded by canonical baseline repair task ${task.baselineRepair.supersededByRepairTaskId}`
      : 'superseded by canonical baseline repair task';
  }

  if (isSafeIntegratedProductState(task)) {
    return 'manager will normalize this already integrated product task to completed';
  }

  if (task.followupTaskIds?.length) {
    return `follow-up task ${task.followupTaskIds[0]} is carrying this recovery path`;
  }

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

  const recoveryEvaluation = evaluateAutoRecovery(task);
  const recoveryKind = resolveTaskRecoveryKind(task);

  if (task.status === 'failed' && recoveryEvaluation.active) {
    if (recoveryKind === 'agent_context') {
      return 'manager will retry the failed story in a fresh agent conversation';
    }

    const nextEligibleAt = task.autoRecoveryNextEligibleAt ?? task.autonomyRepairNextEligibleAt;
    if (nextEligibleAt && nextEligibleAt > Date.now()) {
      return `wait for ${recoveryKind} recovery cooldown`;
    }

    return `wait for ${recoveryKind} recovery requeue`;
  }

  if (task.status === 'failed') {
    if (context?.obsoleteBaselineRepairTaskIds?.has(task.id)) {
      return 'obsolete baseline repair was superseded by a newer package-specific repair';
    }

    if (task.mergeConflictPhase === 'integration_sync') {
      return 'resolve the integration branch sync conflict, then retry the blocked task';
    }

    if (task.mergeRepairRecoveryStoppedAt || task.mergeRepairDisplayStatus === 'stopped') {
      return 'manual merge repair required; resolve conflicts in the task worktree or explicitly reset/requeue the repair story';
    }

    if (task.storyRepairRecoveryStoppedAt) {
      return 'inspect stopped story repair auto-recovery and explicitly retry, repair, or archive';
    }

    if (task.lastErrorKind === 'story_incomplete') {
      return 'repair or reset incomplete stories before finalization can be retried';
    }

    if (task.transientRecoveryStoppedAt) {
      return 'inspect stopped transient recovery and explicitly retry or repair';
    }

    if (task.agentContextRecoveryStoppedAt) {
      return 'split or reduce the story, then retry agent-context recovery';
    }

    if (task.failedBlockerRecoveryStoppedAt) {
      return 'inspect stopped failed-blocker recovery and explicitly retry, repair, or archive';
    }

    if (task.autoRecoveryStoppedAt) {
      return 'manager will generate a follow-up PRD for the stopped recovery state';
    }

    return 'inspect failure and explicitly retry, repair, or archive';
  }

  if (task.status === 'stagnant' && !evaluateAutoRecovery(task).active) {
    return 'inspect stagnant task and explicitly retry, repair, or archive';
  }

  if (task.status === 'completed') {
    if (integrationStatus === 'integrated') {
      const targetSyncStatus = resolveTaskTargetSyncStatus(task);

      if (targetSyncStatus === 'deferred_dirty_checkout') {
        return 'clean the checked-out target branch; manager will retry if target sync is enabled, otherwise it will mark the stale deferment disabled by policy';
      }

      if (targetSyncStatus === 'disabled') {
        return 'target sync is disabled by policy; integration branch contains the completed work';
      }

      if (targetSyncStatus === 'failed') {
        return 'inspect target sync failure; local target branch was not updated';
      }
    }

    if (
      task.mergeConflictFiles?.length
      || integrationStatus === 'blocked_conflict'
    ) {
      return 'resolve integration conflict to unblock later tasks';
    }

    if (integrationStatus === 'failed') {
      if (isRetryableIntegrationFailure(task)) {
        return 'manager will retry transient integration failure; current failure was network/git fetch related';
      }

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
    task.status === 'failed_finalize'
    && task.baselineQualityGate?.kind === 'baseline_quality_gate_failure'
    && isCurrentBaselineGateStillBlocking(task)
  ) {
    if (hasActiveBaselineRepair(task, context)) {
      return task.baselineQualityGate.repairTaskId
        ? `wait for shared baseline repair task ${task.baselineQualityGate.repairTaskId}; root cause: ${task.baselineQualityGate.rootCause ?? 'shared_baseline_code_debt'}`
        : `wait for shared baseline repair; root cause: ${task.baselineQualityGate.rootCause ?? 'shared_baseline_code_debt'}`;
    }

    if (
      recoveryEvaluation.active
      && (recoveryKind === 'baseline_repair' || recoveryKind === 'baseline_supersession_migration')
    ) {
      return task.baselineQualityGate.repairTaskId
        ? `wait for shared baseline repair task ${task.baselineQualityGate.repairTaskId}; root cause: ${task.baselineQualityGate.rootCause ?? 'shared_baseline_code_debt'}`
        : `wait for shared baseline repair; root cause: ${task.baselineQualityGate.rootCause ?? 'shared_baseline_code_debt'}`;
    }

    if (recoveryEvaluation.active && recoveryKind === 'baseline_exhaustion') {
      return 'manager is reclassifying the baseline repair exhaustion against the current finalizer failure';
    }

    if (task.autoRecoveryStoppedAt || task.baselineQualityGate.stoppedAt) {
      const stopReason = task.baselineQualityGate.stopReason ?? task.autoRecoveryStopReason;
      if (stopReason === 'baseline_repair_exhausted') {
        return task.baselineQualityGate.repairTaskId
          ? `baseline repair exhausted after retry; manager will run autonomy repair to reclassify the current failure before policy review of ${task.baselineQualityGate.repairTaskId}`
          : 'baseline repair exhausted after retry; manager will run autonomy repair to reclassify the current failure before policy review';
      }
      return task.baselineQualityGate.repairTaskId
        ? `baseline repair failed; inspect repair task ${task.baselineQualityGate.repairTaskId}`
        : 'baseline repair failed; inspect repair task';
    }

    if (
      task.baselineQualityGate.rootCause === 'toolchain_flake'
      || task.baselineQualityGate.rootCause === 'unsafe_ambiguous'
      || task.baselineQualityGate.rootCause === 'dependency_bootstrap_worktree_environment'
    ) {
      return `baseline quality gate root cause is ${task.baselineQualityGate.rootCause}; inspect before product repair`;
    }

    return 'baseline quality gate also fails on target; Ralph should enqueue or reuse a shared baseline repair task';
  }

  if (
    task.status === 'failed_finalize'
    && task.baselineQualityGate?.kind === 'baseline_probe_failed'
    && isCurrentBaselineGateStillBlocking(task)
  ) {
    return 'inspect baseline quality-gate probe failure; Ralph could not prove whether the failure is shared or task-specific';
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

function resolveIngestionNextAction(input: {
  watchDir?: string;
  managerActive: boolean;
  configuredEnabled: boolean;
  managerAutoIngestEnabled: boolean;
  notIngestedCount: number;
  changedSinceIngestedCount: number;
}): string {
  if (!input.watchDir) {
    return 'configure ingestion.ez4ielts.watchDir or RALPH_EZ4IELTS_WATCH_DIR';
  }

  if (input.changedSinceIngestedCount > 0) {
    return 'review changed PRD files and explicitly enqueue updated work when intended';
  }

  if (input.notIngestedCount > 0) {
    if (!input.managerActive) {
      return 'start the manager with ez4ielts auto-ingest enabled, or batch-start the existing PRDs';
    }

    if (!input.managerAutoIngestEnabled) {
      return 'manager is running without auto-ingest; restart with --auto-ingest-ez4ielts or batch-start existing PRDs';
    }

    return 'auto-ingest watches new files only by default; batch-start existing PRDs or enable startup backlog ingestion';
  }

  if (!input.configuredEnabled && !input.managerAutoIngestEnabled) {
    return 'auto-ingest is off; no unqueued PRDs were found';
  }

  return 'auto-ingest inventory is clear';
}

function hasActiveDeadlockCandidate(task: Record<string, any>): boolean {
  if (task.status === 'pending') {
    return task.reason === 'dependencies' || task.reason === 'coordination';
  }

  if (task.status === 'ready_to_finalize' || task.status === 'failed_finalize') {
    return Boolean(task.coordination?.status)
      || (
        task.status === 'failed_finalize'
        && task.autoRecovery?.active === true
        && task.autoRecovery?.kind === 'baseline_repair'
      );
  }

  return false;
}

function hasInFlightTask(tasks: Record<string, any>[]): boolean {
  return tasks.some((task) => task.status === 'running' || task.status === 'finalizing');
}

function isWaitingForRecoveryQueueTask(task: Record<string, any>): boolean {
  return task.status === 'pending'
    && task.queueState?.phase === 'recovering'
    && (
      task.queueState.detail === 'blocked_by_dependency'
      || task.queueState.detail === 'blocked_by_coordination'
    )
    && (
      task.queueState.reason === 'waiting_for_dependency_recovery'
      || task.queueState.reason === 'waiting_for_coordination_recovery'
    );
}

function isRecoveryPlanningQueueTask(task: Record<string, any>): boolean {
  return task.queueState?.phase === 'recovering'
    && (
      task.queueState.detail === 'generating_followup_prd'
      || task.queueState.detail === 'splitting_story'
    );
}

function resolveDeadlockReason(tasks: Record<string, any>[]): {
  reason: string;
  principalBlocker?: string;
  nextAction: string;
} {
  const blockedBaselineRepair = tasks.find((task) => (
    task.baselineQualityGate === undefined
    && task.autoRecovery?.baselineRepair !== undefined
    && task.autoRecovery.baselineRepair?.repairTaskId === task.id
    && task.coordination?.status === 'blocked_observed_overlap'
  ));
  if (blockedBaselineRepair) {
    return {
      reason: 'baseline_repair_ordering',
      principalBlocker: blockedBaselineRepair.id,
      nextAction: `prioritize baseline repair barrier ${blockedBaselineRepair.id}; non-running overlapping demand tasks should wait for it`,
    };
  }

  const failedFinalizeWaitingForRepair = tasks.find((task) => (
    task.status === 'failed_finalize'
    && task.autoRecovery?.active === true
    && task.autoRecovery?.kind === 'baseline_repair'
    && task.baselineQualityGate?.repairTaskId
  ));
  if (failedFinalizeWaitingForRepair) {
    return {
      reason: 'waiting_for_baseline_repair',
      principalBlocker: failedFinalizeWaitingForRepair.baselineQualityGate.repairTaskId,
      nextAction: `complete shared baseline repair task ${failedFinalizeWaitingForRepair.baselineQualityGate.repairTaskId}`,
    };
  }

  const blockedTask = tasks.find((task) => task.coordination?.status || task.reason === 'dependencies');
  if (blockedTask?.coordination?.status) {
    return {
      reason: blockedTask.coordination.status,
      principalBlocker: blockedTask.coordination.blockers?.[0],
      nextAction: blockedTask.nextAction,
    };
  }

  if (blockedTask?.reason === 'dependencies') {
    return {
      reason: 'waiting_for_dependencies',
      principalBlocker: blockedTask.blockers?.[0],
      nextAction: blockedTask.nextAction,
    };
  }

  return {
    reason: 'no_runnable_next_action',
    nextAction: 'inspect active tasks; manager has capacity but no runnable queue item',
  };
}

function isActiveBaselineRepairTask(task: Task): boolean {
  if (!task.prdId?.startsWith('baseline-quality-gate:')) {
    return false;
  }

  if (isSupersededBaselineRepairTask(task)) {
    return false;
  }

  if (
    task.status === 'pending'
    || task.status === 'running'
    || task.status === 'ready_to_finalize'
    || task.status === 'finalizing'
  ) {
    return true;
  }

  if (task.status === 'completed') {
    return resolveTaskIntegrationStatus(task) !== 'integrated';
  }

  return (task.status === 'failed' || task.status === 'stagnant')
    && evaluateAutoRecovery(task).active;
}

function buildQueueStateContext(tasks: Task[]): QueueStateContext {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const obsoleteBaselineRepairTaskIds = new Set<string>();

  for (const task of tasks) {
    if (isSupersededBaselineRepairTask(task)) {
      obsoleteBaselineRepairTaskIds.add(task.id);
      continue;
    }

    if (!task.prdId?.startsWith('baseline-quality-gate:') || !task.baselineRepair?.demandTaskIds?.length) {
      continue;
    }

    const hasCurrentDemand = task.baselineRepair.demandTaskIds.some((demandTaskId) => {
      const demandTask = tasksById.get(demandTaskId);
      const demandRecoveryKind = demandTask ? resolveTaskRecoveryKind(demandTask) : undefined;
      return Boolean(
        demandTask?.status === 'failed_finalize'
        && isBaselineRecoveryKind(demandRecoveryKind)
        && demandTask.baselineQualityGate?.kind === 'baseline_quality_gate_failure'
        && demandTask.baselineQualityGate.repairTaskId === task.id
        && isBaselineQualityGateStateCurrent(demandTask),
      );
    });

    if (!hasCurrentDemand) {
      obsoleteBaselineRepairTaskIds.add(task.id);
    }
  }

  return {
    activeBaselineRepairTaskIds: new Set(
      tasks
        .filter(isActiveBaselineRepairTask)
        .map((task) => task.id),
    ),
    obsoleteBaselineRepairTaskIds,
  };
}

function buildFollowupShadowedTaskIds(tasks: Task[]): Set<string> {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const shadowedTaskIds = new Set<string>();

  for (const task of tasks) {
    if (!task.followupTaskIds?.length) {
      continue;
    }

    const hasGeneratedFollowup = task.followupTaskIds.some((followupTaskId) => tasksById.has(followupTaskId));

    if (hasGeneratedFollowup) {
      shadowedTaskIds.add(task.id);
    }
  }

  return shadowedTaskIds;
}

export function buildSystemBlocks(input: {
  repoPath?: string;
  duplicateManagers?: DuplicateRepoManagerReport;
  ingestion: {
    managerActive: boolean;
    managerAutoIngestEnabled: boolean;
    notIngestedCount: number;
    nextAction: string;
  };
  taskActionCount: number;
  tasks: Record<string, any>[];
  capacity: {
    running: number;
    available: number;
    queuedRunnable: number;
  };
}): SystemBlockItem[] {
  const items: SystemBlockItem[] = [];

  if (input.duplicateManagers?.duplicateRepoManagers) {
    items.push({
      id: 'repo-manager-ownership',
      scope: 'system',
      phase: 'blocked_by_policy',
      detail: 'policy_duplicate_managers',
      reason: 'duplicate_repo_managers',
      repoPath: input.duplicateManagers.repoPath,
      blockers: input.duplicateManagers.otherActiveClaims.map((claim) => claim.ralphHome),
      nextAction: 'stop duplicate Ralph managers for this repo and keep one canonical Ralph home',
      policy: buildQueuePolicy('policy_duplicate_managers', 'duplicate_repo_managers'),
    });
  }

  if (
    input.ingestion.notIngestedCount > 0
    && (!input.ingestion.managerActive || !input.ingestion.managerAutoIngestEnabled)
  ) {
    items.push({
      id: 'ez4ielts-auto-ingest',
      scope: 'system',
      phase: 'blocked',
      detail: 'blocked_by_ingestion_config',
      reason: 'ingestion_disabled_with_backlog',
      repoPath: input.repoPath,
      nextAction: input.ingestion.nextAction,
    });
  }

  const activeDeadlock = input.taskActionCount === 0
    && input.capacity.running === 0
    && !hasInFlightTask(input.tasks)
    && input.capacity.available > 0
    && input.capacity.queuedRunnable === 0
    && input.tasks.some(hasActiveDeadlockCandidate);
  if (activeDeadlock) {
    const deadlock = resolveDeadlockReason(input.tasks);
    const noRunnableInvariant = deadlock.reason === 'no_runnable_next_action';
    items.push({
      id: 'queue-actionability',
      scope: 'system',
      phase: noRunnableInvariant ? 'diagnostics' : 'blocked',
      detail: noRunnableInvariant
        ? 'diagnosing_failure'
        : deadlock.reason === 'waiting_for_baseline_repair'
          ? 'blocked_by_baseline'
          : deadlock.reason === 'waiting_for_dependencies'
            ? 'blocked_by_dependency'
            : deadlock.reason === 'blocked_observed_overlap'
              ? 'blocked_by_coordination'
              : 'blocked_by_deadlock',
      reason: `blocked_deadlock:${deadlock.reason}`,
      repoPath: input.repoPath,
      blockers: deadlock.principalBlocker ? [deadlock.principalBlocker] : undefined,
      nextAction: deadlock.nextAction,
    });
  }

  return items;
}

export function resolveActionability(input: {
  tasks: Record<string, any>[];
  actions: QueueActionItem[];
  systemBlocks: SystemBlockItem[];
  capacity: {
    running: number;
    available: number;
    queuedRunnable: number;
  };
}): QueueActionability {
  const policyBlock = [
    ...input.systemBlocks.filter((item) => item.phase === 'blocked_by_policy'),
    ...input.actions.filter((item) => item.queueState.phase === 'blocked_by_policy'),
  ][0];
  if (policyBlock) {
    return {
      status: 'blocked_by_policy',
      reason: policyBlock.reason,
      principalBlocker: policyBlock.blockers?.[0] ?? ('id' in policyBlock ? policyBlock.id : undefined),
      nextAction: policyBlock.nextAction,
    };
  }

  const approval = [
    ...input.systemBlocks.filter((item) => item.phase === 'awaiting_approval'),
    ...input.actions.filter((item) => item.queueState.phase === 'awaiting_approval'),
  ][0];
  if (approval) {
    return {
      status: 'awaiting_approval',
      reason: approval.reason,
      principalBlocker: approval.blockers?.[0] ?? ('id' in approval ? approval.id : undefined),
      nextAction: approval.nextAction,
    };
  }

  const diagnostic = [
    ...input.systemBlocks.filter((item) => item.phase === 'diagnostics'),
    ...input.actions.filter((item) => item.queueState.phase === 'diagnostics'),
  ][0];
  if (diagnostic) {
    return {
      status: 'diagnostics',
      reason: diagnostic.reason,
      principalBlocker: diagnostic.blockers?.[0] ?? ('id' in diagnostic ? diagnostic.id : undefined),
      nextAction: diagnostic.nextAction,
    };
  }

  const ingestion = input.systemBlocks.find((item) => item.reason === 'ingestion_disabled_with_backlog');
  if (ingestion) {
    return {
      status: 'ingestion_backlog',
      reason: ingestion.reason,
      nextAction: ingestion.nextAction,
    };
  }

  const blocked = [
    ...input.systemBlocks.filter((item) => item.phase === 'blocked'),
    ...input.actions.filter((item) => item.queueState.phase === 'blocked'),
  ][0];
  if (blocked) {
    return {
      status: 'blocked',
      reason: blocked.reason,
      principalBlocker: blocked.blockers?.[0] ?? ('id' in blocked ? blocked.id : undefined),
      nextAction: blocked.nextAction,
    };
  }

  if (input.capacity.running > 0 || input.capacity.queuedRunnable > 0 || hasInFlightTask(input.tasks)) {
    const finalizerRunning = input.capacity.running === 0
      && input.capacity.queuedRunnable === 0
      && hasInFlightTask(input.tasks);
    return {
      status: 'runnable',
      reason: finalizerRunning
        ? 'finalizer_running'
        : input.capacity.running > 0
          ? 'workers_running'
          : 'queued_tasks_ready',
      nextAction: finalizerRunning
        ? 'wait for finalizer completion'
        : input.capacity.running > 0
          ? 'wait for worker progress'
          : 'manager should start queued tasks',
    };
  }

  const recovering = input.tasks.find((task) => (
    (task.queueState?.phase === 'recovering' && !isRecoveryPlanningQueueTask(task))
    || task.autoRecovery?.active === true
  ));
  if (recovering) {
    return {
      status: 'recovering',
      reason: recovering.queueState?.reason ?? recovering.queueState?.detail ?? recovering.autoRecovery?.kind,
      principalBlocker: recovering.id,
      nextAction: recovering.nextAction,
    };
  }

  const planning = input.tasks.find(isRecoveryPlanningQueueTask);
  if (planning) {
    return {
      status: 'runnable',
      reason: planning.queueState?.detail,
      principalBlocker: planning.id,
      nextAction: planning.nextAction,
    };
  }

  const retryableIntegration = input.tasks.find((task) => isRetryableIntegrationFailure(task as Task & Record<string, any>));
  if (retryableIntegration) {
    return {
      status: 'recovering',
      reason: 'retryable_integration_failure',
      principalBlocker: retryableIntegration.id,
      nextAction: retryableIntegration.nextAction,
    };
  }

  return {
    status: input.tasks.length === 0 ? 'idle' : 'blocked',
    reason: input.tasks.length === 0 ? 'no_active_tasks' : 'no_runnable_tasks',
    nextAction: input.tasks.length === 0 ? 'queue is idle' : 'inspect active task dependencies',
  };
}

export async function buildQueueSnapshot(
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
  const queueStateContext = buildQueueStateContext(tasks);
  const followupShadowedTaskIds = buildFollowupShadowedTaskIds(tasks);
  const manager = adjustManagerStatusForFinalizerLease(
    getManagerStatus({ ralphHome, staleAfterMs, now: () => snapshotNow }),
    findFreshFinalizerLease(tasks, snapshotNow),
  );
  const activeTasks = tasks.filter((task) => {
    if (isSupersededBaselineRepairTask(task)) {
      return false;
    }

    if (
      queueStateContext.obsoleteBaselineRepairTaskIds?.has(task.id)
      && !hasHotConflictReservation(task)
    ) {
      return false;
    }

    if (
      followupShadowedTaskIds.has(task.id)
      && task.status !== 'running'
      && task.status !== 'finalizing'
      && !hasHotConflictReservation(task)
    ) {
      return false;
    }

    if (
      task.status === 'pending'
      || task.status === 'running'
      || task.status === 'ready_to_finalize'
      || task.status === 'finalizing'
      || task.status === 'failed_finalize'
    ) {
      return true;
    }

    if (task.status === 'completed') {
      return resolveTaskIntegrationStatus(task) !== 'integrated' || isDeliveryPendingCompletion(task);
    }

    if (task.status === 'failed' || task.status === 'stagnant') {
      return isActiveQueueState(deriveQueueState(task, undefined, queueStateContext, autoIntegrateEnabled))
        || evaluateAutoRecovery(task).active
        || hasStoppedRecoveryState(task);
    }

    return false;
  });

  const pendingStates = new Map<string, PendingSummary>();
  for (const task of activeTasks) {
    if (task.status !== 'pending') {
      continue;
    }

    pendingStates.set(task.id, await scheduler.describePendingTask(task, { readOnly: true }));
  }

  const output: any[] = [];
  for (const task of activeTasks) {
    const pendingState = pendingStates.get(task.id);
    output.push(summarizeTask(
      task,
      pendingState,
      autoIntegrateEnabled,
      compact,
      queueStateContext,
    ));
  }
  const repoSummary = summarizeSnapshotRepoPaths(activeTasks);
  const recentCompletedThreshold = snapshotNow - (recentCompletedWindowSeconds * 1000);
  const recentCompleted = tasks
    .filter((task) => isIntegratedCompletion(task) && (task.updatedAt ?? 0) >= recentCompletedThreshold)
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
    .slice(0, recentCompletedLimit)
    .map((task) => summarizeTask(
      task,
      undefined,
      autoIntegrateEnabled,
      compact,
      queueStateContext,
    ));
  const totalCompletedCount = tasks.filter(isIntegratedCompletion).length;
  const actions = output
    .filter((task) => task.queueState && isActionItem(task.queueState))
    .map((task) => ({
      id: task.id,
      status: task.status,
      prdId: task.prdId,
      repoPath: task.repoPath,
      queueState: task.queueState,
      reason: task.queueState.reason,
      blockers: task.queueState.blockers,
      nextAction: task.queueState.nextAction,
    }));
  const byStatus = output.reduce<Record<string, number>>((counts, task) => {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
    return counts;
  }, {});
  const maxConcurrent = scheduler.getConcurrencyLimit();
  const running = tasks.filter((task) => task.status === 'running').length;
  const delivery = {
    completedIntegrated: tasks.filter(isIntegratedCompletion).length,
    completedPendingTargetSync: tasks.filter((task) => (
      isIntegratedCompletion(task)
      && resolveTaskTargetSyncStatus(task) === 'deferred_dirty_checkout'
    )).length,
    completedTargetSyncFailed: tasks.filter((task) => (
      isIntegratedCompletion(task)
      && resolveTaskTargetSyncStatus(task) === 'failed'
    )).length,
  };
  const prdInventory = await buildPrdInventory({
    watchDir: configManager.get('ingestion.ez4ielts.watchDir') || process.env.RALPH_EZ4IELTS_WATCH_DIR,
    pattern: configManager.get('ingestion.ez4ielts.pattern'),
    repoPath: manager.state?.repo,
    stateManager,
  });
  const ingestionWatchDir = prdInventory.watchDir
    ?? (configManager.get('ingestion.ez4ielts.watchDir') || process.env.RALPH_EZ4IELTS_WATCH_DIR || undefined);
  const managerAutoIngestEnabled = manager.state?.autoIngestEnabled ?? false;
  const configuredEnabled = Boolean(configManager.get('ingestion.ez4ielts.enabled'));
  const ingestExistingOnStartup = manager.state?.autoIngestExistingOnStartup
    ?? Boolean(configManager.get('ingestion.ez4ielts.ingestExistingOnStartup'));
  const ingestion = {
    configuredEnabled,
    managerAutoIngestEnabled,
    watchDir: ingestionWatchDir,
    pattern: prdInventory.pattern,
    startupMode: ingestExistingOnStartup ? 'ingest_existing_on_startup' : 'new_only',
    notIngestedCount: prdInventory.notIngestedCount,
    changedSinceIngestedCount: prdInventory.changedSinceIngestedCount,
    nextAction: resolveIngestionNextAction({
      watchDir: ingestionWatchDir,
      managerActive: manager.active,
      configuredEnabled,
      managerAutoIngestEnabled,
      notIngestedCount: prdInventory.notIngestedCount,
      changedSinceIngestedCount: prdInventory.changedSinceIngestedCount,
    }),
  };
  const queueRepoPath = manager.state?.repo ?? (repoSummary.repoPaths.length === 1 ? repoSummary.repoPaths[0] : undefined);
  const duplicateManagers = queueRepoPath
    ? detectDuplicateRepoManagers({ repoPath: queueRepoPath, currentRalphHome: ralphHome })
    : undefined;
  const capacity = {
    maxConcurrent,
    running,
    available: Math.max(0, maxConcurrent - running),
    queuedRunnable: [...pendingStates.values()].filter((state) => state.reason === 'queued').length,
    queuedBlockedByDependencies: [...pendingStates.values()].filter((state) => state.reason === 'dependencies').length,
    queuedBlockedByCoordination: [...pendingStates.values()].filter((state) => state.reason === 'coordination').length,
  };
  const systemBlocks = buildSystemBlocks({
    repoPath: queueRepoPath,
    duplicateManagers,
    ingestion: {
      managerActive: manager.active,
      managerAutoIngestEnabled,
      notIngestedCount: prdInventory.notIngestedCount,
      nextAction: ingestion.nextAction,
    },
    taskActionCount: actions.length,
    tasks: output,
    capacity,
  });
  const actionability = resolveActionability({
    tasks: output,
    actions,
    systemBlocks,
    capacity,
  });
  const phaseCount = (phase: QueuePhase) => output.filter((task) => task.queueState?.phase === phase).length;
  const waitingRecoveryCount = output.filter(isWaitingForRecoveryQueueTask).length;
  const planningCount = output.filter(isRecoveryPlanningQueueTask).length;
  const recoveringCount = output.filter((task) => (
    task.queueState?.phase === 'recovering'
    && !isWaitingForRecoveryQueueTask(task)
    && !isRecoveryPlanningQueueTask(task)
  )).length;
  const recoveryActiveCount = activeTasks.filter((task) => evaluateAutoRecovery(task).active).length;
  const autonomyRepairActiveCount = activeTasks.filter((task) => (
    Boolean(task.autonomyRepairKind) && evaluateAutoRecovery(task).active
  )).length;

  const summary = {
    totalActive: output.length,
    running: output.filter((task) => task.queueState?.phase === 'running' || task.queueState?.phase === 'finalizing').length,
    recovering: recoveringCount,
    waitingRecovery: waitingRecoveryCount,
    awaitingApproval: phaseCount('awaiting_approval') + systemBlocks.filter((item) => item.phase === 'awaiting_approval').length,
    blocked: phaseCount('blocked') + systemBlocks.filter((item) => item.phase === 'blocked').length,
    blockedByPolicy: phaseCount('blocked_by_policy') + systemBlocks.filter((item) => item.phase === 'blocked_by_policy').length,
    diagnostics: phaseCount('diagnostics') + systemBlocks.filter((item) => item.phase === 'diagnostics').length,
    queued: phaseCount('queued'),
    planning: planningCount,
    recentCompletedCount: recentCompleted.length,
    totalCompletedCount,
    autoRecoveryActive: recoveryActiveCount,
    recoveryActive: recoveryActiveCount,
    autonomyRepairActive: autonomyRepairActiveCount,
    blockedConflict: output.filter((task) => task.delivery.integrationStatus === 'blocked_conflict').length,
    capacity,
    delivery,
    byStatus,
  };

  const snapshot: Record<string, any> = {
    schemaVersion: 2,
    snapshotAt: new Date().toISOString(),
    ralphHome,
    ...repoSummary,
    manager,
    actionability,
    summary,
    actions,
    systemBlocks,
    repoManagerOwnership: duplicateManagers,
    recentCompleted,
    ingestion,
    prdInventory,
    tasks: output,
  };

  return snapshot;
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
