import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager } from '../config/manager';
import { StateManager } from '../core/state';
import { appendTaskEvent } from './events';
import { FinalizeResult, finalizeTaskOutput } from './finalizer';
import { isQualityGateFailure } from './finalize-failure-classifier';
import { assertRalphHomeIsolation } from './home-isolation';
import { resolveTaskIntegrationStatus, resolveTaskTargetSyncStatus } from './task-delivery';
import {
  resolveIntegrationPolicy,
  resolveMergeTargetBranch,
  shouldAttemptAutomaticIntegration,
} from './integration-policy';
import { withIntegrationLaneLock, withTaskFinalizeLock } from './locks';
import { mergeBranch, MergeStrategy } from './merge';
import {
  buildMergeFailureUpdates,
  createMergeFailureError,
  formatDestructiveAutoResolveError,
  getTaskUpdatesFromError,
  isDestructiveMergeStrategy,
} from './merge-policy';
import {
  buildSuccessfulMergeTaskUpdates,
  buildMergeRepairObservationSignature,
  buildMergeRepairProof,
  deriveMergeRepairDisplayStatus,
} from './merge-task-updates';
import {
  decideFinalizeRepairRequeue,
  evaluateFinalizeRepairFailure,
  resolveFinalizeRepairConfig,
} from './finalize-repair-policy';
import { buildMergeRepairReason, buildTaskRepairContext } from './repair-context';
import {
  captureObservedTaskSurface,
  findCoordinationBlockers,
  resolveTaskIntegrationLane,
} from './task-coordination';
import { buildFinalizeRetryReset } from './task-reset';
import { evaluateFailedTaskForFinalizeRecovery } from './soft-success';
import {
  buildStoryCompletionInvariantFailureUpdates,
  evaluateTaskStoryCompletion,
  formatStoryCompletionInvariantMessage,
} from './story-completion';
import { DEFAULT_AGENT, resolveAgentBackend, resolveAgentType, resolveConfiguredBackend } from './agent';
import { classifyAgentFailureOutput, ErrorClassification } from './error-classifier';
import {
  resolveAgentContextRecoveryConfig,
  resolveAutonomyRepairConfig,
  resolveFailedBlockerRecoveryConfig,
  resolveStoryRepairRecoveryConfig,
  isTransientTaskErrorClass,
  resolveTransientRecoveryConfig,
  resolveTransientRecoveryDelayMs,
} from './auto-recovery-policy';
import { evaluateAutoRecovery, resolveTaskRecoveryKind } from './auto-recovery-state';
import { AutonomyRepairController } from './autonomy-repair';
import { enqueueFollowupPrd } from './followup-prd';
import {
  DEFAULT_EZ4IELTS_PATTERN,
  DEFAULT_EZ4IELTS_SETTLE_MS,
  PrdAutoIngestor,
} from './prd-auto-ingest';
import {
  buildBaselineQualityGateState,
  classifyBaselineQualityGateFailure,
  deriveBaselineRepairGroupKey,
  isBaselineQualityGateStateCurrent,
} from './baseline-quality-gate';
import { ensureBaselineRepairTask, isDedicatedBaselineRepairTask } from './baseline-repair';
import { coalesceBaselineRepairGraph } from './baseline-repair-graph';
import { repairTaskWorktreeDependencyBootstrap } from './baseline-environment-repair';
import {
  appendFailureObservation,
  buildFailureObservationFromTask,
} from './failure-observation';
import { TaskScheduler } from './scheduler';
import { BaselineQualityGateEnvironmentRepairState, BaselineQualityGateState, Task } from '../types/task';
import { probeTaskMergeability, probeTaskWorktreeMergeability } from './merge';
import {
  cleanupWorktreeProcesses,
  resolveConfiguredWorktreeCleanupLockGlobs,
  WorktreeCleanupResult,
} from './worktree-process-cleanup';
import { ReclamationMode, ReclamationService } from './reclamation';

export interface WatchCommandOptions {
  interval?: number;
  repo?: string;
  agent?: string;
  backend?: string;
  allowMixedHome?: boolean;
  autoIngestEz4ielts?: boolean;
  ingestExistingEz4ielts?: boolean;
  ez4ieltsDir?: string;
}

interface DependencyWatcherDeps {
  stateManager?: StateManager;
  scheduler?: TaskScheduler;
  configManager?: Pick<ConfigManager, 'get'>;
  autoIngestor?: Pick<PrdAutoIngestor, 'initialize' | 'scan'>;
  detectAlreadyIntegratedTask?: (task: Task, targetBranch: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<typeof console, 'log' | 'error'>;
  finalizer?: typeof finalizeTaskOutput;
  mergeTask?: typeof mergeBranch;
  probeMergeability?: typeof probeTaskMergeability;
  probeWorktreeMergeability?: typeof probeTaskWorktreeMergeability;
  classifyBaselineQualityGateFailure?: typeof classifyBaselineQualityGateFailure;
  ensureBaselineRepairTask?: typeof ensureBaselineRepairTask;
  repairTaskWorktreeDependencyBootstrap?: typeof repairTaskWorktreeDependencyBootstrap;
  cleanupWorktreeProcesses?: typeof cleanupWorktreeProcesses;
  reclamationService?: Pick<ReclamationService, 'run' | 'isAutomaticReclamationEnabled' | 'getIntervalMs' | 'getStartupDelayMs'>;
  lifecycle?: DependencyWatcherLifecycleHooks;
}

interface DependencyWatcherLifecycleHooks {
  onStarted?: () => void | Promise<void>;
  onLoopStarted?: () => void | Promise<void>;
  onLoopCompleted?: () => void | Promise<void>;
  onLoopError?: (error: unknown) => void | Promise<void>;
  onStopped?: () => void | Promise<void>;
}

function resolveConfiguredPollIntervalMs(value: unknown): number {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return 30000;
  }

  return numericValue * 1000;
}

function resolveAutoMergeDelayMs(value: unknown): number {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return 0;
  }

  return numericValue >= 1000 ? numericValue : numericValue * 1000;
}

function resolveFinalizerLeaseTimeoutMs(value: unknown): number {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return 30 * 60 * 1000;
  }

  return numericValue * 1000;
}

function hasMergeConflict(task: Task): boolean {
  if (task.mergeConflictFiles && task.mergeConflictFiles.length > 0) {
    return true;
  }

  const message = task.mergeError || task.lastError || '';
  return /Merge conflicts detected/i.test(message);
}

function requiresPostFinalizeMergeProbe(task: Task): boolean {
  return task.postFinalizeMergeProbeRequired === true
    || task.repairContext?.mode === 'merge'
    || Boolean(task.mergeRepairAttempts && task.mergeRepairAttempts > 0)
    || Boolean(task.mergeConflictFiles?.length)
    || /Merge conflicts detected/i.test(task.mergeError || '');
}

function requiresMergeRepairProof(task: Pick<Task, 'postFinalizeMergeProbeRequired' | 'repairContext' | 'mergeRepairAttempts' | 'mergeConflictFiles' | 'mergeError' | 'lastError'>): boolean {
  return task.postFinalizeMergeProbeRequired === true
    || task.repairContext?.mode === 'merge'
    || Boolean(task.mergeConflictFiles?.length)
    || /Merge conflicts detected/i.test(task.mergeError || task.lastError || '');
}

function normalizeErrorSignature(message?: string): string | undefined {
  const normalized = (message || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);

  return normalized || undefined;
}

function buildMergeConflictSignature(conflictFiles?: string[]): string | undefined {
  if (!conflictFiles || conflictFiles.length === 0) {
    return undefined;
  }

  return [...new Set(conflictFiles)].sort().join('\n');
}

function isResolvedPendingMergeProof(
  probeResult?: Pick<Awaited<ReturnType<typeof probeTaskWorktreeMergeability>>, 'sourceKind' | 'worktreeMergeState'>,
): boolean {
  return probeResult?.sourceKind === 'resolved_pending_merge'
    || probeResult?.worktreeMergeState?.kind === 'resolved_pending_commit';
}

function selectRecoveryStoryId(task: Pick<Task, 'repairContext' | 'storyProgress' | 'completedUS'>): string | undefined {
  if (task.repairContext?.storyId) {
    return task.repairContext.storyId;
  }

  const failedStory = task.storyProgress
    ?.slice()
    .reverse()
    .find((story) => story.status === 'failed' || story.status === 'needs_repair');

  if (failedStory) {
    return failedStory.id;
  }

  return task.storyProgress?.[task.storyProgress.length - 1]?.id
    || task.completedUS[task.completedUS.length - 1];
}

function selectStagnantRecoveryStoryId(
  task: Pick<Task, 'currentUS' | 'repairContext' | 'storyProgress' | 'completedUS'>,
): string | undefined {
  const inProgressStory = task.storyProgress
    ?.slice()
    .reverse()
    .find((story) => story.status === 'in_progress');

  return inProgressStory?.id
    || task.repairContext?.storyId
    || task.currentUS
    || task.storyProgress
      ?.slice()
      .reverse()
      .find((story) => story.status === 'needs_repair' || story.status === 'pending')
      ?.id
    || selectRecoveryStoryId(task);
}

function buildRetryableFailureSignature(
  task: Pick<Task, 'lastErrorSignature' | 'lastErrorKind' | 'lastErrorClass' | 'lastError' | 'mergeError'>,
  classification?: Pick<ErrorClassification, 'signature'>,
): string {
  return task.lastErrorSignature
    || classification?.signature
    || (task.lastErrorKind && task.lastErrorClass
      ? `${task.lastErrorClass}:${task.lastErrorKind}`
      : undefined)
    || normalizeErrorSignature(task.lastError || task.mergeError)
    || 'unknown_failure';
}

function resolveRetryableTransientFailure(
  task: Pick<Task, 'lastError' | 'mergeError' | 'lastErrorKind' | 'lastErrorClass' | 'lastErrorRetryable' | 'lastErrorSignature'>,
): {
  kind: string;
  class: Task['lastErrorClass'];
  signature: string;
  message: string;
  backfill: Partial<Task>;
} | undefined {
  const message = task.lastError || task.mergeError || '';
  const classified = classifyAgentFailureOutput(message);

  if (task.lastErrorRetryable && isTransientTaskErrorClass(task.lastErrorClass)) {
    return {
      kind: task.lastErrorKind || classified.kind,
      class: task.lastErrorClass,
      signature: buildRetryableFailureSignature(task, classified),
      message,
      backfill: {
        lastErrorKind: task.lastErrorKind || classified.kind,
        lastErrorClass: task.lastErrorClass,
        lastErrorRetryable: true,
        lastErrorSignature: buildRetryableFailureSignature(task, classified),
      },
    };
  }

  if (!classified.explicit || !classified.retryable || !isTransientTaskErrorClass(classified.class)) {
    return undefined;
  }

  return {
    kind: classified.kind,
    class: classified.class,
    signature: buildRetryableFailureSignature(task, classified),
    message: task.lastError || classified.message,
    backfill: {
      lastErrorKind: classified.kind,
      lastErrorClass: classified.class,
      lastErrorRetryable: true,
      lastErrorSignature: buildRetryableFailureSignature(task, classified),
    },
  };
}

function readLogTail(logPath?: string, maxBytes = 20_000): string {
  if (!logPath) {
    return '';
  }

  try {
    const stats = fs.statSync(logPath);
    const length = Math.min(maxBytes, stats.size);
    if (length <= 0) {
      return '';
    }

    const fd = fs.openSync(logPath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, stats.size - length);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function buildAgentContextFailureMessage(
  task: Pick<Task, 'lastError' | 'mergeError' | 'storyProgress' | 'logPath'>,
): string {
  return [
    task.lastError,
    task.mergeError,
    ...(task.storyProgress || [])
      .map((story) => story.lastError)
      .filter((message): message is string => Boolean(message)),
    readLogTail(task.logPath),
  ]
    .filter((message): message is string => Boolean(message))
    .join('\n');
}

function resolveAgentContextWindowFailure(
  task: Pick<Task, 'lastError' | 'mergeError' | 'lastErrorKind' | 'lastErrorSignature' | 'storyProgress' | 'logPath'>,
): {
  kind: 'agent_context_window_exhausted';
  class: Task['lastErrorClass'];
  signature: string;
  message: string;
  backfill: Partial<Task>;
} | undefined {
  const message = buildAgentContextFailureMessage(task);
  const classified = classifyAgentFailureOutput(message);

  if (classified.kind !== 'agent_context_window_exhausted') {
    return undefined;
  }

  const signature = task.lastErrorSignature && task.lastErrorSignature !== 'unknown_no_progress'
    ? task.lastErrorSignature
    : classified.signature || 'agent_context_window_exhausted';

  return {
    kind: classified.kind,
    class: classified.class,
    signature,
    message: message || classified.message,
    backfill: {
      lastErrorKind: classified.kind,
      lastErrorClass: classified.class,
      lastErrorRetryable: true,
      lastErrorSignature: signature,
    },
  };
}

function resetSingleStory(
  task: Pick<Task, 'storyProgress' | 'completedUS'>,
  storyId: string,
  {
    status,
    updatedAt,
    message,
  }: {
    status: 'pending' | 'needs_repair';
    updatedAt: number;
    message: string;
  },
): {
  completedUS: string[];
  storyProgress: Task['storyProgress'];
} {
  return {
    completedUS: task.completedUS.filter((candidate) => candidate !== storyId),
    storyProgress: (task.storyProgress || []).map((story) => story.id === storyId
      ? {
          ...story,
          status,
          attempts: 0,
          lastError: message,
          updatedAt,
          history: [
            ...(story.history || []),
            {
              attempt: story.attempts,
              status,
              message,
              updatedAt,
            },
          ],
        }
      : story),
  };
}

function hasIntegrationOrMergeMarker(
  task: Pick<Task, 'integratedAt' | 'integrationStatus' | 'integrationCommitSha' | 'mergedAt' | 'mergeCommitSha'>,
): boolean {
  return Boolean(
    task.integratedAt
    || task.integrationStatus === 'integrated'
    || task.integrationCommitSha
    || task.mergedAt
    || task.mergeCommitSha
  );
}

function hasSafeIntegratedTargetSync(
  task: Pick<Task, 'targetSyncStatus' | 'targetSyncedAt' | 'targetSyncDeferredReason' | 'mergeMessage'>,
): boolean {
  const targetSyncStatus = resolveTaskTargetSyncStatus(task);
  return targetSyncStatus !== 'failed' && targetSyncStatus !== 'deferred_dirty_checkout';
}

function isRetryableTargetSyncFailure(
  task: Pick<Task, 'targetSyncStatus' | 'targetSyncedAt' | 'targetSyncDeferredReason' | 'mergeMessage'>,
): boolean {
  if (resolveTaskTargetSyncStatus(task) !== 'failed') {
    return false;
  }

  const message = `${task.targetSyncDeferredReason || ''}\n${task.mergeMessage || ''}`.toLowerCase();
  return /git fetch|operation timed out|connection timed out|ssh_dispatch_run_fatal|econnreset|enotfound|network is unreachable|temporary failure/.test(message)
    || /sync deferred/.test(message);
}

function shouldReconcileTargetSync(
  task: Pick<Task, 'targetSyncStatus' | 'targetSyncedAt' | 'targetSyncDeferredReason' | 'mergeMessage'>,
): boolean {
  const targetSyncStatus = resolveTaskTargetSyncStatus(task);
  return targetSyncStatus === 'deferred_dirty_checkout' || isRetryableTargetSyncFailure(task);
}

function hasCompletedStoryEvidence(task: Pick<Task, 'storyProgress' | 'completedUS'>): boolean {
  if (task.storyProgress?.length) {
    return evaluateTaskStoryCompletion(task).allStoriesPassed;
  }

  return task.completedUS.length > 0;
}

function shouldNormalizeIntegratedProductTask(task: Task): boolean {
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

  if (resolveTaskIntegrationStatus(task) !== 'integrated' || !hasIntegrationOrMergeMarker(task)) {
    return false;
  }

  return hasSafeIntegratedTargetSync(task) && hasCompletedStoryEvidence(task);
}

function buildIntegratedProductTaskNormalizationUpdates(task: Task, now: number): Partial<Task> {
  const message = 'Normalized already integrated product task from finalize/autonomy state to completed';
  const baselineHistory = task.baselineQualityGate
    ? [
        ...(task.baselineQualityGateHistory ?? []),
        {
          ...task.baselineQualityGate,
          phase: 'stopped' as const,
          lastUpdatedAt: now,
          stoppedAt: task.baselineQualityGate.stoppedAt ?? now,
          stopReason: task.baselineQualityGate.stopReason ?? 'already_integrated_product_task',
        },
      ]
    : task.baselineQualityGateHistory;

  return {
    status: 'completed',
    endTime: task.endTime ?? task.integratedAt ?? task.mergedAt ?? now,
    pid: undefined,
    leaseOwner: undefined,
    leaseHeartbeatAt: undefined,
    leaseExpiresAt: undefined,
    currentUS: undefined,
    coordinationStatus: undefined,
    coordinationPhase: undefined,
    coordinationBlockers: undefined,
    coordinationReason: undefined,
    repairContext: undefined,
    lastError: undefined,
    lastErrorKind: undefined,
    lastErrorClass: undefined,
    lastErrorRetryable: undefined,
    lastErrorObservedAt: undefined,
    lastErrorSignature: undefined,
    mergeError: undefined,
    mergeConflictFiles: undefined,
    mergeConflictPhase: undefined,
    mergeConflictAt: undefined,
    autoRecoveryKind: undefined,
    autoRecoveryNextEligibleAt: undefined,
    autoRecoveryStoppedAt: undefined,
    autoRecoveryStopReason: undefined,
    autoRecoveryLastReason: message,
    autonomyRepairKind: undefined,
    autonomyRepairNextEligibleAt: undefined,
    autonomyRepairStoppedAt: undefined,
    autonomyRepairStopReason: undefined,
    autonomyRepairLastReason: message,
    finalizeRepairStoppedAt: undefined,
    finalizeRepairStopReason: undefined,
    finalizerFailure: undefined,
    latestFailure: undefined,
    baselineQualityGate: undefined,
    baselineQualityGateHistory: baselineHistory,
    baselineRepair: task.baselineRepair
      ? {
          ...task.baselineRepair,
          status: 'integrated',
          updatedAt: now,
          supersededByRepairTaskId: undefined,
          supersededAt: undefined,
          supersessionReason: undefined,
          message,
        }
      : undefined,
    postFinalizeMergeProbeRequired: undefined,
  };
}

function shouldRefreshExpiredFinalizeRepairWindow(task: Task, config: ReturnType<typeof resolveFinalizeRepairConfig>, now: number): boolean {
  return Boolean(
    config.repairPolicy === 'progress'
    && task.finalizeRepairDeadlineAt
    && task.finalizeRepairDeadlineAt <= now
    && task.finalizeRepairLastFailureSnapshot?.capturedAt
    && task.finalizeRepairLastFailureSnapshot.capturedAt > task.finalizeRepairDeadlineAt
  );
}

function shouldDeferFailedFinalizeToCurrentBaselineGate(task: Task): boolean {
  const baseline = task.baselineQualityGate;
  if (!baseline || !isBaselineQualityGateStateCurrent(task)) {
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

function hasStoryRepairUnsafeDeliveryMarker(
  task: Pick<
    Task,
    | 'integratedAt'
    | 'integrationStatus'
    | 'integrationCommitSha'
    | 'mergedAt'
    | 'mergeCommitSha'
    | 'finalizerCommitSha'
    | 'finalizerCommittedAt'
    | 'repairContext'
    | 'mergeConflictFiles'
    | 'postFinalizeMergeProbeRequired'
    | 'mergeRepairAttempts'
  >,
): boolean {
  return hasIntegrationOrMergeMarker(task)
    || Boolean(task.finalizerCommitSha)
    || Boolean(task.finalizerCommittedAt)
    || task.repairContext?.mode === 'merge'
    || Boolean(task.mergeConflictFiles?.length)
    || task.postFinalizeMergeProbeRequired === true
    || Boolean(task.mergeRepairAttempts && task.mergeRepairAttempts > 0);
}

function isTimeoutLikeTransient(kind: string): boolean {
  return kind === 'transport_timeout'
    || kind === 'transport_reconnecting';
}

function hasTransientProgressEvidence(
  task: Pick<Task, 'lastErrorHadObjectiveProgress' | 'lastFilesChanged'>,
): boolean {
  return task.lastErrorHadObjectiveProgress === true
    || (task.lastFilesChanged ?? 0) > 0;
}

function buildTransientProgressReason(
  task: Pick<Task, 'lastErrorHadObjectiveProgress' | 'lastFilesChanged'>,
  storyId: string,
): string | undefined {
  if (task.lastErrorHadObjectiveProgress) {
    return `Worker reported objective progress for ${storyId}`;
  }

  if ((task.lastFilesChanged ?? 0) > 0) {
    return `${task.lastFilesChanged} file(s) changed before transient failure`;
  }

  return undefined;
}

function hasTransientRecoveryUnsafeDeliveryMarker(
  task: Pick<
    Task,
    | 'integratedAt'
    | 'integrationStatus'
    | 'integrationCommitSha'
    | 'mergedAt'
    | 'mergeCommitSha'
    | 'finalizerCommitSha'
    | 'finalizerCommittedAt'
  >,
): boolean {
  return Boolean(
    task.integratedAt
    || task.integrationStatus === 'integrated'
    || task.integrationCommitSha
    || task.mergedAt
    || task.mergeCommitSha
    || task.finalizerCommitSha
    || task.finalizerCommittedAt
  );
}

function buildFailedBlockerRecoverySignature(
  task: Pick<Task, 'lastErrorSignature' | 'lastErrorKind' | 'lastError' | 'storyProgress'>,
): string {
  return task.lastErrorSignature
    || (task.lastErrorKind
      ? `${task.lastErrorKind}:${normalizeErrorSignature(task.lastError) || 'unknown'}`
      : undefined)
    || (task.storyProgress || [])
      .map((story) => `${story.id}:${story.status}:${story.attempts}`)
      .join('|')
    || 'story_incomplete';
}

function isNoObjectiveEvidenceFailure(task: Pick<Task, 'lastErrorKind' | 'lastError' | 'storyProgress'>): boolean {
  if (task.lastErrorKind === 'no_objective_evidence') {
    return true;
  }

  const noObjectiveEvidencePattern = /no objective diff or commit evidence/i;
  return noObjectiveEvidencePattern.test(task.lastError || '')
    || (task.storyProgress || []).some((story) => noObjectiveEvidencePattern.test(story.lastError || ''));
}

function isStoryRepairEligibleFailure(task: Pick<Task, 'lastErrorKind' | 'lastError' | 'storyProgress'>): boolean {
  return task.lastErrorKind === 'story_incomplete'
    || isNoObjectiveEvidenceFailure(task);
}

function buildStoryRepairRecoverySignature(
  task: Pick<Task, 'lastErrorSignature' | 'lastErrorKind' | 'lastError' | 'storyProgress'>,
): string {
  if (isNoObjectiveEvidenceFailure(task)) {
    const story = (task.storyProgress || []).find((candidate) => (
      /no objective diff or commit evidence/i.test(candidate.lastError || '')
    ));
    return task.lastErrorSignature
      || `${story?.id || 'unknown'}:no_objective_evidence`;
  }

  return buildFailedBlockerRecoverySignature(task);
}

function selectFailedBlockerResettableStoryIds(task: Pick<Task, 'storyProgress'>): string[] {
  return (task.storyProgress || [])
    .filter((story) => story.status !== 'passed')
    .map((story) => story.id);
}

function selectStoryRepairResettableStoryIds(task: Pick<Task, 'completedUS' | 'currentUS' | 'lastErrorSignature' | 'lastErrorKind' | 'lastError' | 'storyProgress'>): string[] {
  const storyProgress = task.storyProgress || [];

  if (isNoObjectiveEvidenceFailure(task)) {
    const signatureStoryId = /^([^:]+):no_objective_evidence$/.exec(task.lastErrorSignature || '')?.[1];
    const story = storyProgress.find((candidate) => (
      candidate.id === signatureStoryId
      || /no objective diff or commit evidence/i.test(candidate.lastError || '')
    ));
    const fallbackStory = storyProgress.find((candidate) => candidate.status === 'failed')
      || storyProgress.find((candidate) => candidate.status !== 'passed')
      || (task.currentUS ? storyProgress.find((candidate) => candidate.id === task.currentUS) : undefined);
    return [story?.id || fallbackStory?.id].filter((storyId): storyId is string => Boolean(storyId));
  }

  const completedStories = new Set(task.completedUS || []);
  return storyProgress
    .filter((story) => story.status !== 'passed' || !completedStories.has(story.id))
    .map((story) => story.id);
}

function resetIncompleteStoriesForFailedBlocker(
  task: Pick<Task, 'storyProgress' | 'completedUS'>,
  storyIds: string[],
  {
    updatedAt,
    message,
  }: {
    updatedAt: number;
    message: string;
  },
): {
  completedUS: string[];
  storyProgress: Task['storyProgress'];
} {
  const resettable = new Set(storyIds);

  return {
    completedUS: task.completedUS.filter((candidate) => !resettable.has(candidate)),
    storyProgress: (task.storyProgress || []).map((story) => resettable.has(story.id)
      ? {
          ...story,
          status: 'pending' as const,
          attempts: 0,
          lastError: message,
          updatedAt,
          history: [
            ...(story.history || []),
            {
              attempt: story.attempts,
              status: 'pending' as const,
              message,
              updatedAt,
            },
          ],
        }
      : story),
  };
}

function mergeDemandTaskIds(existing: string[] | undefined, demandTaskIds: string[]): string[] {
  return [...new Set([...(existing || []), ...demandTaskIds])].sort();
}

function buildCompletedConflictRepairReset(task: Task, repairStoryId: string): {
  updatedAt: number;
  completedUS: string[];
  storyProgress: Task['storyProgress'];
  repairContext: Task['repairContext'];
} {
  const updatedAt = Date.now();
  const repairMessage = buildMergeRepairReason(task);

  return {
    updatedAt,
    completedUS: task.completedUS.filter((storyId) => storyId !== repairStoryId),
    storyProgress: (task.storyProgress || []).map((story) => story.id === repairStoryId
      ? {
          ...story,
          status: 'pending' as const,
          attempts: 0,
          lastError: repairMessage,
          updatedAt,
          history: [
            ...(story.history || []),
            {
              attempt: story.attempts,
              status: 'pending' as const,
              message: 'Automatically reset for merge repair',
              updatedAt,
            },
          ],
        }
      : story),
    repairContext: buildTaskRepairContext({
      mode: 'merge',
      storyId: repairStoryId,
      reason: repairMessage,
      createdAt: updatedAt,
    }),
  };
}

function selectFinalizeRepairStoryId(task: Task, mergeConflict: boolean): string | undefined {
  if (mergeConflict) {
    const needsRepairStory = (task.storyProgress || [])
      .slice()
      .reverse()
      .find((story) => story.status === 'needs_repair');
    if (needsRepairStory) {
      return needsRepairStory.id;
    }

    return task.storyProgress?.[task.storyProgress.length - 1]?.id
      || task.completedUS[task.completedUS.length - 1];
  }

  return task.completedUS[task.completedUS.length - 1]
    || task.storyProgress?.[task.storyProgress.length - 1]?.id;
}

function resolveTaskBranchName(task: Pick<Task, 'id'>): string {
  return `ralph/${task.id}`;
}

function resolveTaskIntegrationBranch(task: Pick<Task, 'integrationBranch' | 'integrationLane' | 'intendedMergeTarget' | 'mergeTargetBranch'>, targetBranch: string): string {
  if (typeof task.integrationBranch === 'string' && task.integrationBranch.trim()) {
    return task.integrationBranch.trim();
  }

  return `ralph/integration/${resolveTaskIntegrationLane(task, targetBranch)}`;
}

function isTaskAlreadyIntegrated(task: Task, targetBranch: string): boolean {
  const integrationBranch = resolveTaskIntegrationBranch(task, targetBranch);

  try {
    execFileSync('git', ['merge-base', '--is-ancestor', resolveTaskBranchName(task), integrationBranch], {
      cwd: task.repoPath,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function isAutoRepairableBaselineRootCause(rootCause: string | undefined): boolean {
  return rootCause === 'shared_baseline_code_debt'
    || rootCause === 'generated_artifact_drift';
}

interface BaselineRepairWorktreeApplyResult {
  applied: boolean;
  commitSha?: string;
  files?: string[];
  message: string;
  conflictFiles?: string[];
  equivalentFiles?: string[];
  strategy?: 'already_equivalent' | 'three_way_apply';
  requiresOperator?: boolean;
}

function gitOutput(repoPath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function listCommitChangedFiles(repoPath: string, commitSha: string): string[] {
  return gitOutput(repoPath, ['diff-tree', '--no-commit-id', '--name-only', '-r', commitSha])
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function pathHasWorktreeChanges(worktreePath: string, relativePath: string): boolean {
  return gitOutput(worktreePath, ['status', '--porcelain', '--', relativePath]).length > 0;
}

function commitParentOrEmptyTree(repoPath: string, commitSha: string): string {
  try {
    return gitOutput(repoPath, ['rev-parse', `${commitSha}^`]);
  } catch {
    return '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  }
}

function readCommitBlob(repoPath: string, commitSha: string, relativePath: string): Buffer | undefined {
  try {
    return execFileSync('git', ['show', `${commitSha}:${relativePath}`], {
      cwd: repoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return undefined;
  }
}

function isWorktreePathEquivalentToCommit(worktreePath: string, repoPath: string, commitSha: string, relativePath: string): boolean {
  const commitBlob = readCommitBlob(repoPath, commitSha, relativePath);
  const worktreeFile = path.join(worktreePath, relativePath);

  if (!fs.existsSync(worktreeFile)) {
    return commitBlob === undefined;
  }

  if (!fs.statSync(worktreeFile).isFile()) {
    return false;
  }

  if (commitBlob === undefined) {
    return false;
  }

  return fs.readFileSync(worktreeFile).equals(commitBlob);
}

function writeRepairBlobToWorktree(worktreePath: string, repoPath: string, commitSha: string, relativePath: string): void {
  const repairBlob = readCommitBlob(repoPath, commitSha, relativePath);
  const worktreeFile = path.join(worktreePath, relativePath);

  if (repairBlob === undefined) {
    fs.rmSync(worktreeFile, { force: true });
    return;
  }

  fs.mkdirSync(path.dirname(worktreeFile), { recursive: true });
  fs.writeFileSync(worktreeFile, repairBlob);
}

function mergeDirtyWorktreeFileWithRepairCommit(
  worktreePath: string,
  repoPath: string,
  commitSha: string,
  relativePath: string,
): boolean {
  const parentSha = commitParentOrEmptyTree(repoPath, commitSha);
  const baseBlob = readCommitBlob(repoPath, parentSha, relativePath);
  const repairBlob = readCommitBlob(repoPath, commitSha, relativePath);
  const worktreeFile = path.join(worktreePath, relativePath);

  if (baseBlob === undefined || repairBlob === undefined || !fs.existsSync(worktreeFile)) {
    return false;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-baseline-merge-'));
  try {
    const currentPath = path.join(tempDir, 'current');
    const basePath = path.join(tempDir, 'base');
    const repairPath = path.join(tempDir, 'repair');
    fs.writeFileSync(currentPath, fs.readFileSync(worktreeFile));
    fs.writeFileSync(basePath, baseBlob);
    fs.writeFileSync(repairPath, repairBlob);
    const merged = execFileSync('git', ['merge-file', '-p', currentPath, basePath, repairPath], {
      cwd: worktreePath,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    fs.writeFileSync(worktreeFile, merged);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function applyBaselineRepairCommitToTaskWorktree(task: Task, repairTask: Task): BaselineRepairWorktreeApplyResult {
  const commitSha = repairTask.finalizerCommitSha || repairTask.integrationCommitSha || repairTask.mergeCommitSha;
  if (!commitSha) {
    return {
      applied: false,
      message: `baseline repair task ${repairTask.id} has no repair commit to apply`,
      requiresOperator: true,
    };
  }

  if (!task.worktree || !fs.existsSync(task.worktree)) {
    return {
      applied: false,
      commitSha,
      message: `task worktree does not exist; cannot apply baseline repair commit ${commitSha}`,
      requiresOperator: true,
    };
  }

  const changedFiles = listCommitChangedFiles(task.repoPath, commitSha);
  if (changedFiles.length === 0) {
    return {
      applied: false,
      commitSha,
      files: [],
      message: `baseline repair commit ${commitSha} has no file changes to apply`,
    };
  }

  const conflictFiles = changedFiles.filter((changedFile) => pathHasWorktreeChanges(task.worktree, changedFile));
  const equivalentFiles = changedFiles.filter((changedFile) => (
    isWorktreePathEquivalentToCommit(task.worktree, task.repoPath, commitSha, changedFile)
  ));
  const filesToApply = changedFiles.filter((changedFile) => !equivalentFiles.includes(changedFile));
  const nonEquivalentConflictFiles = conflictFiles.filter((changedFile) => !equivalentFiles.includes(changedFile));

  if (filesToApply.length === 0) {
    return {
      applied: false,
      commitSha,
      files: changedFiles,
      equivalentFiles,
      strategy: 'already_equivalent',
      message: `baseline repair commit ${commitSha} is already present in task worktree`,
    };
  }

  const cleanFiles = filesToApply.filter((changedFile) => !nonEquivalentConflictFiles.includes(changedFile));

  for (const cleanFile of cleanFiles) {
    writeRepairBlobToWorktree(task.worktree, task.repoPath, commitSha, cleanFile);
  }

  for (const conflictFile of nonEquivalentConflictFiles) {
    if (!mergeDirtyWorktreeFileWithRepairCommit(task.worktree, task.repoPath, commitSha, conflictFile)) {
      return {
        applied: false,
        commitSha,
        files: changedFiles,
        conflictFiles: nonEquivalentConflictFiles,
        equivalentFiles,
        message: `baseline repair commit ${commitSha} could not be applied with a safe 3-way merge`,
        requiresOperator: true,
      };
    }
  }

  execFileSync('git', ['add', '--all', '--', ...filesToApply], {
    cwd: task.worktree,
    stdio: 'ignore',
  });

  return {
    applied: true,
    commitSha,
    files: changedFiles,
    conflictFiles: nonEquivalentConflictFiles.length > 0 ? nonEquivalentConflictFiles : undefined,
    equivalentFiles,
    strategy: 'three_way_apply',
    message: nonEquivalentConflictFiles.length > 0
      ? `applied baseline repair commit ${commitSha} to task worktree with safe 3-way merge`
      : `applied baseline repair commit ${commitSha} to task worktree`,
  };
}

function shouldClassifyBaselineQualityGateTask(task: Task, autoRemediate: boolean): boolean {
  if (
    task.status !== 'failed_finalize'
    || !['quality_gate_failure', 'baseline_quality_gate_failure'].includes(task.lastErrorKind ?? '')
    || !task.finalizerFailure
  ) {
    return false;
  }

  const baseline = task.baselineQualityGate;
  if (
    !baseline
    && (
      task.baselineRepair?.status === 'integrated'
      || task.baselineRepair?.status === 'needs_more_repair'
    )
    && task.baselineRepair.repairTaskId
    && task.repairContext?.mode === 'finalize'
  ) {
    return false;
  }

  if (!baseline) {
    return true;
  }

  if (!isBaselineQualityGateStateCurrent(task)) {
    return true;
  }

  if (!baseline.rootCause || !baseline.repairKey || !baseline.taskFailureSignature) {
    return true;
  }

  if (
    baseline.kind === 'baseline_quality_gate_failure'
    && baseline.phase === 'baseline_repair_integrated'
    && baseline.taskRootCause === 'dependency_bootstrap_worktree_environment'
  ) {
    return true;
  }

  return baseline.kind === 'baseline_quality_gate_failure'
    && autoRemediate
    && isAutoRepairableBaselineRootCause(baseline.rootCause)
    && !baseline.repairTaskId;
}

function appendBaselineQualityGateHistory(
  history: BaselineQualityGateState[] | undefined,
  baseline: BaselineQualityGateState | undefined,
): BaselineQualityGateState[] | undefined {
  if (!baseline) {
    return history;
  }

  const existing = history ?? [];
  const last = existing[existing.length - 1];
  if (
    last?.taskFailureSignature === baseline.taskFailureSignature
    && last?.baselineFailureSignature === baseline.baselineFailureSignature
    && last?.repairKey === baseline.repairKey
  ) {
    return existing;
  }

  return [...existing, baseline].slice(-20);
}

function getPositiveNumber(value: unknown, fallback: number): number {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0
    ? numericValue
    : fallback;
}

export class DependencyWatcher {
  private readonly scheduler: TaskScheduler;
  private readonly pollInterval: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Pick<typeof console, 'log' | 'error'>;
  private readonly autoIngestor?: Pick<PrdAutoIngestor, 'initialize' | 'scan'>;
  private readonly stateManager: StateManager;
  private readonly configManager: Pick<ConfigManager, 'get'>;
  private readonly detectAlreadyIntegratedTask: (task: Task, targetBranch: string) => boolean;
  private readonly finalizer: typeof finalizeTaskOutput;
  private readonly mergeTask: typeof mergeBranch;
  private readonly probeMergeability: typeof probeTaskMergeability;
  private readonly probeWorktreeMergeability: typeof probeTaskWorktreeMergeability;
  private readonly classifyBaselineQualityGateFailureFn: typeof classifyBaselineQualityGateFailure;
  private readonly ensureBaselineRepairTaskFn: typeof ensureBaselineRepairTask;
  private readonly repairTaskWorktreeDependencyBootstrapFn: typeof repairTaskWorktreeDependencyBootstrap;
  private readonly cleanupWorktreeProcessesFn: typeof cleanupWorktreeProcesses;
  private readonly reclamationService: Pick<ReclamationService, 'run' | 'isAutomaticReclamationEnabled' | 'getIntervalMs' | 'getStartupDelayMs'>;
  private readonly lifecycle?: DependencyWatcherLifecycleHooks;
  private readonly autoIngestEnabled: boolean;
  private readonly autoIngestExistingOnStartupEnabled: boolean;
  private nextReclamationAtMs: number;
  private hasRunStartupReclamation = false;
  private isRunning = false;

  constructor(
    options: WatchCommandOptions = {},
    deps: DependencyWatcherDeps = {}
  ) {
    const stateManager = deps.stateManager ?? new StateManager();
    const configManager = deps.configManager ?? new ConfigManager();

    this.stateManager = stateManager;
    this.configManager = configManager;
    this.detectAlreadyIntegratedTask = deps.detectAlreadyIntegratedTask ?? isTaskAlreadyIntegrated;
    this.finalizer = deps.finalizer ?? finalizeTaskOutput;
    this.mergeTask = deps.mergeTask ?? mergeBranch;
    this.probeMergeability = deps.probeMergeability ?? probeTaskMergeability;
    this.probeWorktreeMergeability = deps.probeWorktreeMergeability ?? probeTaskWorktreeMergeability;
    this.classifyBaselineQualityGateFailureFn = deps.classifyBaselineQualityGateFailure ?? classifyBaselineQualityGateFailure;
    this.ensureBaselineRepairTaskFn = deps.ensureBaselineRepairTask ?? ensureBaselineRepairTask;
    this.repairTaskWorktreeDependencyBootstrapFn = deps.repairTaskWorktreeDependencyBootstrap ?? repairTaskWorktreeDependencyBootstrap;
    this.cleanupWorktreeProcessesFn = deps.cleanupWorktreeProcesses ?? cleanupWorktreeProcesses;
    this.reclamationService = deps.reclamationService ?? new ReclamationService({ stateManager, configManager });
    this.nextReclamationAtMs = Date.now() + this.reclamationService.getStartupDelayMs();
    this.scheduler = deps.scheduler ?? new TaskScheduler({ stateManager, managerOwnedScheduling: true });
    this.pollInterval = Number.isFinite(options.interval) && Number(options.interval) > 0
      ? Number(options.interval)
      : resolveConfiguredPollIntervalMs(configManager.get('runner.pollInterval'));
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.logger = deps.logger ?? console;
    this.lifecycle = deps.lifecycle;

    this.autoIngestEnabled = options.autoIngestEz4ielts
      ?? Boolean(configManager.get('ingestion.ez4ielts.enabled'));
    this.autoIngestExistingOnStartupEnabled = options.ingestExistingEz4ielts
      ?? Boolean(configManager.get('ingestion.ez4ielts.ingestExistingOnStartup'));

    if (deps.autoIngestor) {
      this.autoIngestor = deps.autoIngestor;
      return;
    }

    if (this.autoIngestEnabled) {
      const settleMs = Number(configManager.get('ingestion.ez4ielts.settleMs'));
      const configuredPattern = configManager.get('ingestion.ez4ielts.pattern');
      const configuredWatchDir = configManager.get('ingestion.ez4ielts.watchDir');
      const watchDir = options.ez4ieltsDir || configuredWatchDir || process.env.RALPH_EZ4IELTS_WATCH_DIR;

      if (!watchDir || !String(watchDir).trim()) {
        throw new Error('ez4ielts auto-ingest requires a watch directory. Pass `--ez4ielts-dir` or set `ingestion.ez4ielts.watchDir` / `RALPH_EZ4IELTS_WATCH_DIR`.');
      }

      const repoPath = options.repo || path.dirname(path.resolve(watchDir));
      const backend = options.backend
        ? resolveAgentBackend(options.backend)
        : resolveConfiguredBackend(configManager);

      this.autoIngestor = new PrdAutoIngestor({
        repoPath,
        agent: resolveAgentType(options.agent || DEFAULT_AGENT),
        backend,
        watchDir,
        pattern: typeof configuredPattern === 'string' ? configuredPattern : DEFAULT_EZ4IELTS_PATTERN,
        settleMs: Number.isFinite(settleMs) && settleMs >= 0 ? settleMs : DEFAULT_EZ4IELTS_SETTLE_MS,
        ingestExistingOnStartup: this.autoIngestExistingOnStartupEnabled,
        logger: (message) => this.logger.log(message),
      }, {
        stateManager,
        scheduler: this.scheduler,
      });
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.log('Dependency watcher is already running');
      return;
    }

    this.isRunning = true;
    await this.autoIngestor?.initialize();
    this.logger.log(`Dependency watcher started (polling every ${this.pollInterval / 1000}s)`);
    await this.invokeLifecycleHook('onStarted');

    while (this.isRunning) {
      await this.invokeLifecycleHook('onLoopStarted');
      try {
        await this.autoIngestor?.scan();
        await this.scheduler.recoverStaleTasks();
        await this.auditStoryCompletionInvariants();
        await this.recoverSoftFailedTasks();
        await this.recoverFailedWorkerMergeRepairTasks();
        await this.recoverFailedAgentContextTasks();
        await this.recoverFailedTransientTasks();
        await this.recoverStagnantTasks();
        await this.classifyBaselineQualityGateFailures();
        await this.coalesceBaselineRepairGraph();
        await this.recoverBaselineBlockedFinalizeTasks();
        await this.normalizeIntegratedProductTasks();
        await this.recoverBlockedAutonomyTasks();
        await this.recoverStoppedTransientTasks();
        await this.recoverStoppedAgentContextTasks();
        await this.recoverStoppedStoryRepairTasks();
        await this.recoverStoppedFinalizeRepairTasks();
        await this.recoverStoppedGenericRecoveryTasks();
        await this.recoverFailedFinalizeTasks();
        await this.recoverCompletedConflictTasks();
        await this.integrateCompletedTasks();
        await this.finalizeReadyTasks();
        await this.reconcileDeferredTargetSyncs();
        await this.recoverFailedStoryRepairTasks();
        await this.recoverFailedBlockers();
        await this.checkPendingTasks();
        await this.maybeRunReclamation();
        await this.invokeLifecycleHook('onLoopCompleted');
      } catch (error) {
        await this.invokeLoopErrorHook(error);
        this.logger.error('Error checking pending tasks:', error);
      }

      await this.sleep(this.pollInterval);
    }

    await this.invokeLifecycleHook('onStopped');
  }

  stop(): void {
    this.isRunning = false;
    this.logger.log('Dependency watcher stopped');
  }

  getPollIntervalMs(): number {
    return this.pollInterval;
  }

  private async maybeRunReclamation(): Promise<void> {
    if (!this.reclamationService.isAutomaticReclamationEnabled()) {
      return;
    }

    const now = Date.now();
    if (now < this.nextReclamationAtMs) {
      return;
    }

    const mode: ReclamationMode = this.hasRunStartupReclamation
      ? 'manager_periodic'
      : 'manager_startup';
    this.nextReclamationAtMs = now + this.reclamationService.getIntervalMs();
    this.hasRunStartupReclamation = true;

    try {
      const report = await this.reclamationService.run({ mode });
      if (report.removed > 0 || report.errors.length > 0) {
        this.logger.log(`Reclamation ${mode} removed ${report.removed} worktree(s), skipped ${report.worktrees.skipped}, errors ${report.errors.length}`);
      }
    } catch (error) {
      this.logger.error('Error running Ralph reclamation:', error);
    }
  }

  async normalizeIntegratedProductTasks(): Promise<void> {
    const tasks = (await this.stateManager.listTasks())
      .filter(shouldNormalizeIntegratedProductTask)
      .sort((a: Task, b: Task) => a.startTime - b.startTime);

    for (const task of tasks) {
      const now = Date.now();
      const updates = buildIntegratedProductTaskNormalizationUpdates(task, now);
      await this.stateManager.updateTask(task.id, updates);
      appendTaskEvent(task, {
        type: 'integrated_product_task_normalized',
        status: 'completed',
        message: updates.autoRecoveryLastReason,
        data: {
          previousStatus: task.status,
          integrationStatus: resolveTaskIntegrationStatus(task),
          targetSyncStatus: resolveTaskTargetSyncStatus(task),
          integratedAt: task.integratedAt,
          integrationCommitSha: task.integrationCommitSha,
          mergeCommitSha: task.mergeCommitSha,
        },
      });
      this.logger.log(`Task ${task.id} normalized to completed because it is already integrated`);
    }
  }

  isAutoIngestEnabled(): boolean {
    return this.autoIngestEnabled;
  }

  isAutoIngestExistingOnStartupEnabled(): boolean {
    return this.autoIngestExistingOnStartupEnabled;
  }

  private async refreshFailedFinalizeFailureState(task: Task): Promise<Task> {
    if (task.status !== 'failed_finalize' || !task.finalizerFailure) {
      return task;
    }

    const latestFailure = buildFailureObservationFromTask(task);
    const failureHistory = appendFailureObservation(task.failureHistory, latestFailure);
    const baselineIsCurrent = isBaselineQualityGateStateCurrent({
      ...task,
      latestFailure,
    });
    const updates: Partial<Task> = {};

    if (latestFailure && task.latestFailure?.signature !== latestFailure.signature) {
      updates.latestFailure = latestFailure;
      updates.failureHistory = failureHistory;
    } else if (latestFailure && !task.latestFailure) {
      updates.latestFailure = latestFailure;
    }

    if (task.baselineQualityGate && !baselineIsCurrent) {
      updates.baselineQualityGateHistory = appendBaselineQualityGateHistory(
        task.baselineQualityGateHistory,
        task.baselineQualityGate,
      );
      updates.baselineQualityGate = undefined;
      updates.baselineRepair = undefined;

      if (task.autoRecoveryKind === 'baseline_repair') {
        updates.autoRecoveryKind = undefined;
        updates.autoRecoveryStoppedAt = undefined;
        updates.autoRecoveryStopReason = undefined;
        updates.autoRecoveryLastReason = 'Cleared stale baseline recovery state after latest finalize failure changed';
      }

      updates.finalizeRepairStoppedAt = undefined;
      updates.finalizeRepairStopReason = undefined;
    }

    if (Object.keys(updates).length === 0) {
      return task;
    }

    await this.stateManager.updateTask(task.id, updates);
    if (task.baselineQualityGate && !baselineIsCurrent) {
      appendTaskEvent(task, {
        type: 'stale_baseline_quality_gate_cleared',
        status: 'failed_finalize',
        message: 'Moved stale baseline quality-gate state to history because the latest finalize failure signature changed',
        data: {
          previousTaskFailureSignature: task.baselineQualityGate.taskFailureSignature,
          latestFailureSignature: latestFailure?.signature,
          previousPackageLabel: task.baselineQualityGate.packageLabel,
          latestPackageLabel: latestFailure?.packageLabel,
        },
      });
    }

    return (await this.stateManager.loadTask(task.id)) ?? {
      ...task,
      ...updates,
    };
  }

  private async invokeLifecycleHook(
    hookName: Exclude<keyof DependencyWatcherLifecycleHooks, 'onLoopError'>
  ): Promise<void> {
    const hook = this.lifecycle?.[hookName];

    if (!hook) {
      return;
    }

    try {
      await hook();
    } catch (error) {
      this.logger.error(`Dependency watcher lifecycle hook ${hookName} failed:`, error);
    }
  }

  private async invokeLoopErrorHook(error: unknown): Promise<void> {
    if (!this.lifecycle?.onLoopError) {
      return;
    }

    try {
      await this.lifecycle.onLoopError(error);
    } catch (hookError) {
      this.logger.error('Dependency watcher lifecycle hook onLoopError failed:', hookError);
    }
  }

  async auditStoryCompletionInvariants(): Promise<void> {
    const tasks = (await this.stateManager.listTasks())
      .filter((task) => task.status === 'ready_to_finalize' || task.status === 'finalizing' || task.status === 'completed')
      .sort((a: Task, b: Task) => a.startTime - b.startTime);

    for (const task of tasks) {
      const storyCompletion = evaluateTaskStoryCompletion(task);
      if (storyCompletion.allStoriesPassed) {
        continue;
      }

      const observedAt = Date.now();
      const phase = task.status === 'completed' ? 'integrate' : 'finalize';
      const message = formatStoryCompletionInvariantMessage(task.id, phase, storyCompletion);
      await this.stateManager.updateTask(task.id, {
        status: 'failed',
        endTime: observedAt,
        pid: undefined,
        currentUS: undefined,
        leaseOwner: undefined,
        leaseHeartbeatAt: undefined,
        leaseExpiresAt: undefined,
        integratedAt: undefined,
        mergedAt: undefined,
        integrationCommitSha: undefined,
        mergeCommitSha: undefined,
        mergeMessage: undefined,
        postFinalizeMergeProbeRequired: undefined,
        repairContext: undefined,
        mergeRepairAttempts: 0,
        mergeRepairDisplayStatus: undefined,
        mergeRepairProof: undefined,
        mergeRepairRecoveryStartedAt: undefined,
        mergeRepairRecoveryDeadlineAt: undefined,
        mergeRepairRecoveryTotalRequeues: undefined,
        mergeRepairRecoveryConsecutiveNoProgress: undefined,
        mergeRepairRecoveryLastObservationSignature: undefined,
        mergeRepairRecoveryLastConflictSignature: undefined,
        mergeRepairRecoveryLastProbeMessage: undefined,
        mergeRepairRecoveryLastProgressReason: undefined,
        mergeRepairRecoveryStoppedAt: undefined,
        mergeRepairRecoveryStopReason: undefined,
        ...buildStoryCompletionInvariantFailureUpdates(message, observedAt),
      });
      appendTaskEvent(task, {
        type: 'story_completion_invariant_failed',
        status: 'failed',
        message,
        data: {
          phase,
          previousStatus: task.status,
          previousIntegrationStatus: task.integrationStatus,
          incompleteStories: storyCompletion.incompleteStories,
        },
      });
      this.logger.error(`Invalidated incomplete ${task.status} task ${task.id}: ${message}`);
    }
  }

  async recoverSoftFailedTasks(): Promise<void> {
    const failedTasks = (await this.stateManager.listTasks('failed'))
      .filter((task) => !task.followupTaskIds?.length)
      .filter((task) => task.lastErrorKind !== 'story_incomplete')
      .slice()
      .sort((a: Task, b: Task) => a.startTime - b.startTime);

    for (const task of failedTasks) {
      let mergeProofRecovery:
        | Awaited<ReturnType<typeof this.probeWorktreeMergeability>>
        | undefined;
      const needsMergeRepairProof = requiresMergeRepairProof(task);

      const decision = evaluateFailedTaskForFinalizeRecovery({
        logPath: task.logPath,
        worktreePath: task.worktree,
        baseCommitSha: task.baseCommitSha,
        lastFilesChanged: task.lastFilesChanged,
        storyProgress: task.storyProgress,
        lastError: task.lastError,
      });

      if (!decision.shouldTreatAsSuccess) {
        continue;
      }

      if (needsMergeRepairProof) {
        const integrationPolicy = resolveIntegrationPolicy(this.configManager);

        try {
          mergeProofRecovery = await this.probeWorktreeMergeability(task, integrationPolicy.targetBranch, {
            pullLatest: integrationPolicy.pullLatest,
            integrationWorktreeDir: integrationPolicy.integrationWorktreeDir,
            syncTargetBranch: false,
          });
        } catch (error) {
          this.logger.error(
            `Exact worktree mergeability probe failed for soft recovery task ${task.id}: ${error instanceof Error ? error.message : String(error)}`
          );
          continue;
        }

        if (!mergeProofRecovery.alreadyIntegrated && !mergeProofRecovery.mergeable) {
          this.logger.log(`Task ${task.id} soft recovery blocked by exact worktree mergeability probe`);
          continue;
        }
      }

      const updatedAt = Date.now();
      const completedUS = decision.recoverableStoryId && !task.completedUS.includes(decision.recoverableStoryId)
        ? [...task.completedUS, decision.recoverableStoryId]
        : task.completedUS;
      const storyProgress = decision.recoverableStoryId
        ? (task.storyProgress || []).map((story) => story.id === decision.recoverableStoryId
          ? {
              ...story,
              status: 'passed' as const,
              lastError: undefined,
              lastEvidence: story.lastEvidence || decision.reason,
              updatedAt,
              history: [
                ...(story.history || []),
                {
                  attempt: story.attempts,
                  status: 'passed' as const,
                  message: `Soft-recovered for finalization: ${decision.reason}`,
                  evidence: story.lastEvidence || decision.reason,
                  updatedAt,
                },
              ],
            }
          : story)
        : task.storyProgress;

      const storyCompletion = evaluateTaskStoryCompletion({
        ...task,
        completedUS,
        storyProgress,
      });
      if (!storyCompletion.allStoriesPassed) {
        const message = formatStoryCompletionInvariantMessage(task.id, 'finalize', storyCompletion);
        await this.stateManager.updateTask(task.id, {
          status: 'failed',
          completedUS,
          storyProgress,
          currentUS: undefined,
          pid: undefined,
          endTime: updatedAt,
          leaseOwner: undefined,
          leaseHeartbeatAt: undefined,
          leaseExpiresAt: undefined,
          ...buildStoryCompletionInvariantFailureUpdates(message, updatedAt),
        });
        appendTaskEvent(task, {
          type: 'story_completion_invariant_failed',
          status: 'failed',
          message,
          data: {
            phase: 'finalize',
            recoveredStoryId: decision.recoverableStoryId,
            incompleteStories: storyCompletion.incompleteStories,
          },
        });
        this.logger.error(`Refused soft recovery for incomplete task ${task.id}: ${message}`);
        continue;
      }

      await this.stateManager.updateTask(task.id, {
        status: 'ready_to_finalize',
        completedUS,
        storyProgress,
        currentUS: undefined,
        pid: undefined,
        endTime: undefined,
        lastError: undefined,
        lastErrorSignature: undefined,
        lastErrorHadObjectiveProgress: undefined,
        mergeError: undefined,
        mergeConflictFiles: undefined,
        mergeConflictPhase: undefined,
        mergeConflictAt: undefined,
        integrationBranch: mergeProofRecovery?.integrationBranch ?? task.integrationBranch,
        integrationWorktree: mergeProofRecovery?.integrationWorktree ?? task.integrationWorktree,
        mergeRepairDisplayStatus: mergeProofRecovery
          ? deriveMergeRepairDisplayStatus(mergeProofRecovery)
          : task.mergeRepairDisplayStatus,
        mergeRepairProof: mergeProofRecovery
          ? buildMergeRepairProof(mergeProofRecovery)
          : task.mergeRepairProof,
        postFinalizeMergeProbeRequired: needsMergeRepairProof
          ? true
          : task.postFinalizeMergeProbeRequired,
      });
      appendTaskEvent(task, {
        type: 'task_recovered_soft_failed',
        status: 'ready_to_finalize',
        message: decision.reason,
        data: {
          recoveredStoryId: decision.recoverableStoryId,
          exactProbeMessage: mergeProofRecovery?.message,
        },
      });
      this.logger.log(`Task ${task.id} recovered into ready_to_finalize (${decision.reason})`);
    }
  }

  async recoverFailedWorkerMergeRepairTasks(): Promise<void> {
    const repairConfig = resolveFinalizeRepairConfig(this.configManager);
    const integrationPolicy = resolveIntegrationPolicy(this.configManager);
    const failedTasks = (await this.stateManager.listTasks('failed'))
      .slice()
      .sort((a: Task, b: Task) => a.startTime - b.startTime);

    for (const task of failedTasks) {
      if (!requiresMergeRepairProof(task)) {
        continue;
      }

      if (resolveRetryableTransientFailure(task) && task.repairContext?.mode === 'merge') {
        continue;
      }

      const repairStoryId = selectRecoveryStoryId(task);
      if (!repairStoryId) {
        continue;
      }
      const repairStory = task.storyProgress?.find((story) => story.id === repairStoryId);
      if (task.repairContext?.mode !== 'merge' && repairStory?.status !== 'needs_repair') {
        continue;
      }

      let mergeProbeResult: Awaited<ReturnType<typeof probeTaskWorktreeMergeability>>;

      try {
        mergeProbeResult = await this.probeWorktreeMergeability(task, integrationPolicy.targetBranch, {
          pullLatest: integrationPolicy.pullLatest,
          integrationWorktreeDir: integrationPolicy.integrationWorktreeDir,
          syncTargetBranch: false,
        });
      } catch (error) {
        this.logger.error(
          `Exact worktree mergeability probe failed for worker merge-repair task ${task.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      const now = Date.now();
      const firstRecoveryObservation = task.mergeRepairRecoveryStartedAt === undefined
        && task.mergeRepairRecoveryTotalRequeues === undefined
        && task.mergeRepairRecoveryConsecutiveNoProgress === undefined;
      const initialStartedAt = task.mergeRepairRecoveryStartedAt
        ?? (firstRecoveryObservation
          ? now
          : task.repairContext?.createdAt
            ?? task.lastErrorObservedAt
            ?? now);
      const initialDeadlineAt = task.mergeRepairRecoveryDeadlineAt
        ?? initialStartedAt + (repairConfig.repairDeadlineSeconds * 1000);
      const currentTotalRequeues = task.mergeRepairRecoveryTotalRequeues ?? 0;
      const currentAutoRequeues = task.autoRecoveryTotalRequeues ?? 0;
      const stoppedReason = task.mergeRepairRecoveryStopReason ?? task.autoRecoveryStopReason;
      const canReviveStoppedMergeRepair = Boolean(task.mergeRepairRecoveryStoppedAt)
        && (
          stoppedReason === 'merge_repair_deadline_exhausted'
          || stoppedReason === 'merge_repair_same_unresolved_state'
        )
        && currentTotalRequeues < repairConfig.repairHardCap
        && currentAutoRequeues < repairConfig.repairHardCap;
      const deadlineExpired = initialDeadlineAt <= now;
      const shouldRefreshRecoveryWindow = (deadlineExpired || canReviveStoppedMergeRepair)
        && currentTotalRequeues < repairConfig.repairHardCap
        && currentAutoRequeues < repairConfig.repairHardCap;
      const startedAt = shouldRefreshRecoveryWindow ? now : initialStartedAt;
      const deadlineAt = shouldRefreshRecoveryWindow
        ? now + (repairConfig.repairDeadlineSeconds * 1000)
        : initialDeadlineAt;
      const currentObservationSignature = buildMergeRepairObservationSignature(mergeProbeResult);
      const previousSignature = task.mergeRepairRecoveryLastConflictSignature
        || buildMergeConflictSignature(task.mergeConflictFiles)
        || normalizeErrorSignature(task.mergeError || task.lastError)
        || 'merge_conflict';
      const currentSignature = buildMergeConflictSignature(mergeProbeResult.conflictFiles)
        || normalizeErrorSignature(mergeProbeResult.message)
        || 'merge_conflict';
      const previousObservationSignature = task.mergeRepairRecoveryLastObservationSignature;
      const resolvedPendingMergeProof = isResolvedPendingMergeProof(mergeProbeResult);
      const hasProgress = !firstRecoveryObservation && (
        resolvedPendingMergeProof
        || (previousObservationSignature
          ? previousObservationSignature !== currentObservationSignature
          : currentSignature !== previousSignature)
      );
      const nextConsecutiveNoProgress = firstRecoveryObservation
        ? 0
        : hasProgress
          ? 0
          : (task.mergeRepairRecoveryConsecutiveNoProgress ?? 0) + 1;
      const nextProgressReason = firstRecoveryObservation
        ? 'Initialized worker merge-repair recovery tracking'
        : hasProgress
          ? resolvedPendingMergeProof
            ? 'Observed resolved pending merge awaiting finalizer commit'
            : 'Merge-repair worktree observation changed'
          : task.mergeRepairRecoveryLastProgressReason;
      const commonUpdates: Partial<Task> = {
        lastError: mergeProbeResult.message,
        lastErrorKind: 'merge_conflict',
        lastErrorClass: 'merge_conflict',
        lastErrorRetryable: true,
        lastErrorObservedAt: now,
        lastErrorSignature: currentSignature,
        lastErrorHadObjectiveProgress: false,
        mergeError: mergeProbeResult.mergeable ? undefined : mergeProbeResult.message,
        mergeConflictFiles: mergeProbeResult.mergeable ? undefined : mergeProbeResult.conflictFiles,
        mergeConflictPhase: mergeProbeResult.mergeable ? undefined : mergeProbeResult.failurePhase,
        mergeConflictAt: mergeProbeResult.mergeable ? undefined : now,
        integrationBranch: mergeProbeResult.integrationBranch,
        integrationWorktree: mergeProbeResult.integrationWorktree,
        postFinalizeMergeProbeRequired: true,
        ...captureObservedTaskSurface(task),
        mergeRepairRecoveryStartedAt: startedAt,
        mergeRepairRecoveryDeadlineAt: deadlineAt,
        mergeRepairRecoveryConsecutiveNoProgress: nextConsecutiveNoProgress,
        mergeRepairRecoveryLastObservationSignature: currentObservationSignature,
        mergeRepairRecoveryLastConflictSignature: currentSignature,
        mergeRepairRecoveryLastProbeMessage: mergeProbeResult.message,
        mergeRepairRecoveryLastProgressReason: nextProgressReason,
        mergeRepairDisplayStatus: deriveMergeRepairDisplayStatus(mergeProbeResult),
        mergeRepairProof: buildMergeRepairProof(mergeProbeResult, now),
        autoRecoveryKind: 'merge_repair',
        autoRecoveryHardCap: repairConfig.repairHardCap,
      };

      if (mergeProbeResult.alreadyIntegrated || mergeProbeResult.mergeable) {
        const recoveryMessage = mergeProbeResult.alreadyIntegrated
          ? `Recovered merge repair because ${resolveTaskBranchName(task)} is already integrated in ${mergeProbeResult.integrationBranch}`
          : `Recovered merge repair because exact worktree mergeability probe passed against ${mergeProbeResult.integrationBranch}`;
        const completedUS = task.completedUS.includes(repairStoryId)
          ? task.completedUS
          : [...task.completedUS, repairStoryId];
        const storyProgress = (task.storyProgress || []).map((story) => story.id === repairStoryId
          ? {
              ...story,
              status: 'passed' as const,
              lastError: undefined,
              updatedAt: now,
              history: [
                ...(story.history || []),
                {
                  attempt: story.attempts,
                  status: 'passed' as const,
                  message: recoveryMessage,
                  updatedAt: now,
                },
              ],
            }
          : story);

        const storyCompletion = evaluateTaskStoryCompletion({
          ...task,
          completedUS,
          storyProgress,
        });
        if (!storyCompletion.allStoriesPassed) {
          const message = formatStoryCompletionInvariantMessage(task.id, 'finalize', storyCompletion);
          await this.stateManager.updateTask(task.id, {
            ...commonUpdates,
            status: 'failed',
            completedUS,
            storyProgress,
            currentUS: undefined,
            pid: undefined,
            endTime: now,
            leaseOwner: undefined,
            leaseHeartbeatAt: undefined,
            leaseExpiresAt: undefined,
            repairContext: undefined,
            autoRecoveryKind: undefined,
            autoRecoveryNextEligibleAt: undefined,
            autoRecoveryStoppedAt: now,
            autoRecoveryStopReason: 'story_incomplete',
            autoRecoveryLastReason: message,
            mergeRepairRecoveryStoppedAt: now,
            mergeRepairRecoveryStopReason: 'story_incomplete',
            mergeRepairDisplayStatus: undefined,
            mergeRepairProof: undefined,
            postFinalizeMergeProbeRequired: undefined,
            ...buildStoryCompletionInvariantFailureUpdates(message, now),
          });
          appendTaskEvent(task, {
            type: 'story_completion_invariant_failed',
            status: 'failed',
            storyId: repairStoryId,
            message,
            data: {
              phase: 'finalize',
              exactProbeMessage: mergeProbeResult.message,
              incompleteStories: storyCompletion.incompleteStories,
            },
          });
          this.logger.error(`Refused worker merge-repair recovery for incomplete task ${task.id}: ${message}`);
          continue;
        }

        await this.stateManager.updateTask(task.id, {
          ...commonUpdates,
          status: 'ready_to_finalize',
          completedUS,
          storyProgress,
          currentUS: undefined,
          pid: undefined,
          endTime: undefined,
          leaseOwner: undefined,
          leaseHeartbeatAt: undefined,
          leaseExpiresAt: undefined,
          lastError: undefined,
          lastErrorKind: undefined,
          lastErrorClass: undefined,
          lastErrorRetryable: undefined,
          lastErrorObservedAt: undefined,
          lastErrorSignature: undefined,
          lastErrorHadObjectiveProgress: undefined,
          mergeError: undefined,
          mergeConflictFiles: undefined,
          mergeConflictPhase: undefined,
          mergeConflictAt: undefined,
          repairContext: undefined,
          autoRecoveryKind: undefined,
          autoRecoveryNextEligibleAt: undefined,
          autoRecoveryStoppedAt: undefined,
          autoRecoveryStopReason: undefined,
          autoRecoveryLastReason: recoveryMessage,
          mergeRepairRecoveryStoppedAt: undefined,
          mergeRepairRecoveryStopReason: undefined,
        });
        appendTaskEvent(task, {
          type: 'merge_repair_recovered',
          status: 'ready_to_finalize',
          storyId: repairStoryId,
          message: recoveryMessage,
          data: {
            exactProbeMessage: mergeProbeResult.message,
            conflictFiles: mergeProbeResult.conflictFiles,
          },
        });
        this.logger.log(`Task ${task.id} recovered into ready_to_finalize after worker merge repair`);
        continue;
      }

      if (task.mergeRepairRecoveryStoppedAt && !canReviveStoppedMergeRepair) {
        continue;
      }

      const integrationSyncConflict = mergeProbeResult.failurePhase === 'integration_sync';
      let stopReason: string | undefined;
      let stopMessage: string | undefined;

      if (integrationSyncConflict) {
        stopReason = 'merge_repair_integration_sync_conflict';
        stopMessage = 'Integration branch sync conflict must be resolved before task merge repair can continue';
      } else if (currentTotalRequeues >= repairConfig.repairHardCap || currentAutoRequeues >= repairConfig.repairHardCap) {
        stopReason = 'merge_repair_hard_cap_reached';
        stopMessage = 'Worker merge repair hard cap reached';
      }

      if (stopReason && stopMessage) {
        await this.stateManager.updateTask(task.id, {
          ...commonUpdates,
          mergeRepairDisplayStatus: 'stopped',
          mergeRepairRecoveryStoppedAt: now,
          mergeRepairRecoveryStopReason: stopReason,
          autoRecoveryStoppedAt: now,
          autoRecoveryStopReason: stopReason,
          autoRecoveryLastReason: stopMessage,
        });
        appendTaskEvent(task, {
          type: 'merge_repair_stopped',
          status: 'failed',
          storyId: repairStoryId,
          message: stopMessage,
          data: {
            stopReason,
            failurePhase: mergeProbeResult.failurePhase,
            exactProbeMessage: mergeProbeResult.message,
            conflictFiles: mergeProbeResult.conflictFiles,
            consecutiveNoProgress: nextConsecutiveNoProgress,
            totalRequeues: currentTotalRequeues,
            deadlineAt,
          },
        });
        this.logger.log(`Task ${task.id} stopped worker merge-repair recovery (${stopMessage})`);
        continue;
      }

      const repairMessage = buildMergeRepairReason({
        ...task,
        mergeError: mergeProbeResult.message,
        mergeConflictFiles: mergeProbeResult.conflictFiles,
        mergeConflictPhase: mergeProbeResult.failurePhase,
        integrationBranch: mergeProbeResult.integrationBranch,
      });
      const resetState = resetSingleStory(task, repairStoryId, {
        status: 'needs_repair',
        updatedAt: now,
        message: repairMessage,
      });
      const nextMergeRepairRequeues = currentTotalRequeues + 1;
      const nextAutoRecoveryRequeues = currentAutoRequeues + 1;

      const autoRecoveryReason = shouldRefreshRecoveryWindow
        ? stoppedReason
          ? `Refreshed merge repair recovery window after ${stoppedReason}`
          : 'Refreshed merge repair recovery window after deadline exhaustion'
        : nextProgressReason || mergeProbeResult.message;

      await this.stateManager.updateTask(task.id, {
        ...commonUpdates,
        status: 'pending',
        completedUS: resetState.completedUS,
        storyProgress: resetState.storyProgress,
        currentUS: undefined,
        pid: undefined,
        endTime: undefined,
        leaseOwner: undefined,
        leaseHeartbeatAt: undefined,
        leaseExpiresAt: undefined,
        repairContext: buildTaskRepairContext({
          mode: 'merge',
          storyId: repairStoryId,
          reason: repairMessage,
          createdAt: now,
        }),
        mergeRepairAttempts: (task.mergeRepairAttempts ?? 0) + 1,
        mergeRepairRecoveryTotalRequeues: nextMergeRepairRequeues,
        mergeRepairRecoveryStoppedAt: undefined,
        mergeRepairRecoveryStopReason: undefined,
        mergeRepairDisplayStatus: 'requeued',
        autoRecoveryTotalRequeues: nextAutoRecoveryRequeues,
        autoRecoveryLastRequeuedAt: now,
        autoRecoveryNextEligibleAt: undefined,
        autoRecoveryStoppedAt: undefined,
        autoRecoveryStopReason: undefined,
        autoRecoveryLastReason: autoRecoveryReason,
      });
      appendTaskEvent(task, {
        type: 'merge_repair_auto_requeued',
        status: 'pending',
        storyId: repairStoryId,
        message: `Requeued ${repairStoryId} for bounded merge repair`,
        data: {
          exactProbeMessage: mergeProbeResult.message,
          conflictFiles: mergeProbeResult.conflictFiles,
          failurePhase: mergeProbeResult.failurePhase,
          consecutiveNoProgress: nextConsecutiveNoProgress,
          totalRequeues: nextMergeRepairRequeues,
          deadlineAt,
          previousDeadlineAt: shouldRefreshRecoveryWindow ? initialDeadlineAt : undefined,
          recoveryWindowRefreshed: shouldRefreshRecoveryWindow,
          revivedStoppedRecovery: canReviveStoppedMergeRepair,
          previousStopReason: canReviveStoppedMergeRepair ? stoppedReason : undefined,
          progressReason: nextProgressReason,
        },
      });
      this.logger.log(`Task ${task.id} returned to pending merge repair for ${repairStoryId}`);
    }
  }

  async recoverFailedAgentContextTasks(): Promise<void> {
    const recoveryConfig = resolveAgentContextRecoveryConfig(this.configManager);
    const failedTasks = (await this.stateManager.listTasks('failed'))
      .slice()
      .sort((a: Task, b: Task) => a.startTime - b.startTime);

    for (const task of failedTasks) {
      const contextFailure = resolveAgentContextWindowFailure(task);
      if (!contextFailure) {
        continue;
      }

      const repairStoryId = selectRecoveryStoryId(task);
      const now = Date.now();
      const currentContextRequeues = task.agentContextRecoveryTotalRequeues ?? 0;
      const currentAutoRequeues = task.autoRecoveryTotalRequeues ?? 0;
      const canRefreshNeverRequeuedDeadline = Boolean(
        task.agentContextRecoveryStoppedAt
        && task.agentContextRecoveryStopReason === 'agent_context_deadline_exhausted'
        && currentContextRequeues === 0
      );
      const canReviveRaisedBudget = Boolean(
        task.agentContextRecoveryStoppedAt
        && task.agentContextRecoveryStopReason === 'agent_context_budget_exhausted'
        && currentContextRequeues < recoveryConfig.maxAgentContextRecoveryRequeues
        && currentAutoRequeues < recoveryConfig.agentContextRecoveryHardCap
      );

      if (task.agentContextRecoveryStoppedAt && !canRefreshNeverRequeuedDeadline && !canReviveRaisedBudget) {
        continue;
      }

      const startedAt = canRefreshNeverRequeuedDeadline || canReviveRaisedBudget
        ? now
        : task.agentContextRecoveryStartedAt ?? now;
      const deadlineAt = task.agentContextRecoveryDeadlineAt
        && !canRefreshNeverRequeuedDeadline
        && !canReviveRaisedBudget
        ? task.agentContextRecoveryDeadlineAt
        : startedAt + (recoveryConfig.agentContextRecoveryDeadlineSeconds * 1000);
      const commonUpdates: Partial<Task> = {
        ...contextFailure.backfill,
        agentContextRecoveryStartedAt: startedAt,
        agentContextRecoveryDeadlineAt: deadlineAt,
        agentContextRecoveryLastSignature: contextFailure.signature,
        agentContextRecoveryStoppedAt: undefined,
        agentContextRecoveryStopReason: undefined,
        autoRecoveryKind: 'agent_context',
        autoRecoveryHardCap: recoveryConfig.agentContextRecoveryHardCap,
        autoRecoveryStoppedAt: undefined,
        autoRecoveryStopReason: undefined,
      };

      const stopRecovery = async (stopReason: string, stopMessage: string) => {
        await this.stateManager.updateTask(task.id, {
          ...commonUpdates,
          agentContextRecoveryStoppedAt: now,
          agentContextRecoveryStopReason: stopReason,
          autoRecoveryStoppedAt: now,
          autoRecoveryStopReason: stopReason,
          autoRecoveryLastReason: stopMessage,
        });
        appendTaskEvent(task, {
          type: 'agent_context_recovery_stopped',
          status: 'failed',
          storyId: repairStoryId,
          message: stopMessage,
          data: {
            stopReason,
            failureKind: contextFailure.kind,
            failureSignature: contextFailure.signature,
            totalRequeues: currentContextRequeues,
            deadlineAt,
          },
        });
        this.logger.log(`Task ${task.id} stopped agent-context auto-recovery (${stopMessage})`);
      };

      if (!recoveryConfig.autoRemediateAgentContextFailures) {
        await stopRecovery(
          'agent_context_recovery_disabled',
          'Agent context auto-recovery is disabled',
        );
        continue;
      }

      if (!repairStoryId) {
        await stopRecovery(
          'agent_context_no_resettable_story',
          'Task has no failed or incomplete story that can be retried in a fresh conversation',
        );
        continue;
      }

      if (typeof task.leaseExpiresAt === 'number' && task.leaseExpiresAt > now) {
        await stopRecovery(
          'agent_context_active_lease',
          'Task still has an active worker or finalizer lease; refusing automatic context reset',
        );
        continue;
      }

      if (deadlineAt <= now) {
        await stopRecovery(
          'agent_context_deadline_exhausted',
          'Agent context recovery deadline exhausted',
        );
        continue;
      }

      if (currentContextRequeues >= recoveryConfig.maxAgentContextRecoveryRequeues) {
        await stopRecovery(
          'agent_context_budget_exhausted',
          'Agent context recovery requeue budget exhausted',
        );
        continue;
      }

      if (currentAutoRequeues >= recoveryConfig.agentContextRecoveryHardCap) {
        await stopRecovery(
          'agent_context_hard_cap_reached',
          'Agent context recovery hard cap reached',
        );
        continue;
      }

      if (hasTransientRecoveryUnsafeDeliveryMarker(task)) {
        await stopRecovery(
          'agent_context_unsafe_delivery_marker',
          'Task has delivery, finalizer, or integration markers; refusing automatic context reset',
        );
        continue;
      }

      const hadObjectiveProgress = hasTransientProgressEvidence(task);
      const resetMessage = hadObjectiveProgress
        ? `Automatically requeued ${repairStoryId} after agent context-window exhaustion. Start a fresh conversation, continue from the existing worktree diff, do not redo passed stories, finish only ${repairStoryId}, then run targeted validation.`
        : `Automatically requeued ${repairStoryId} after agent context-window exhaustion. Start a fresh conversation and finish only ${repairStoryId}.`;
      const resetState = resetSingleStory(task, repairStoryId, {
        status: hadObjectiveProgress ? 'needs_repair' : 'pending',
        updatedAt: now,
        message: resetMessage,
      });
      const nextContextRequeues = currentContextRequeues + 1;
      const nextAutoRequeues = currentAutoRequeues + 1;

      await this.stateManager.updateTask(task.id, {
        ...commonUpdates,
        status: 'pending',
        completedUS: resetState.completedUS,
        storyProgress: resetState.storyProgress,
        currentUS: undefined,
        pid: undefined,
        endTime: undefined,
        leaseOwner: undefined,
        leaseHeartbeatAt: undefined,
        leaseExpiresAt: undefined,
        sessionId: undefined,
        threadId: undefined,
        threadStoryId: undefined,
        loopCount: 0,
        consecutiveNoProgress: 0,
        consecutiveErrors: 0,
        lastProgressTime: now,
        lastError: undefined,
        lastErrorKind: undefined,
        lastErrorClass: undefined,
        lastErrorRetryable: undefined,
        lastErrorObservedAt: undefined,
        lastErrorSignature: undefined,
        lastErrorHadObjectiveProgress: undefined,
        transientRetryCount: 0,
        transientRetryBudget: undefined,
        transientRetryLastDelayMs: undefined,
        agentContextRecoveryTotalRequeues: nextContextRequeues,
        agentContextRecoveryLastRequeuedStoryId: repairStoryId,
        agentContextRecoveryStoppedAt: undefined,
        agentContextRecoveryStopReason: undefined,
        autoRecoveryTotalRequeues: nextAutoRequeues,
        autoRecoveryLastRequeuedAt: now,
        autoRecoveryNextEligibleAt: undefined,
        autoRecoveryStoppedAt: undefined,
        autoRecoveryStopReason: undefined,
        autoRecoveryLastReason: resetMessage,
        ...(task.repairContext?.mode === 'merge'
          ? { postFinalizeMergeProbeRequired: true }
          : {}),
      });
      appendTaskEvent(task, {
        type: 'agent_context_recovery_auto_requeued',
        status: 'pending',
        storyId: repairStoryId,
        message: resetMessage,
        data: {
          failureKind: contextFailure.kind,
          failureSignature: contextFailure.signature,
          hadObjectiveProgress,
          totalRequeues: nextContextRequeues,
          clearedConversationState: true,
        },
      });
      this.logger.log(`Task ${task.id} returned to pending after agent-context auto-recovery`);
    }
  }

  private async isObsoleteBaselineRepairTask(task: Task): Promise<boolean> {
    if (!task.prdId?.startsWith('baseline-quality-gate:') || !task.baselineRepair?.demandTaskIds?.length) {
      return false;
    }

    for (const demandTaskId of task.baselineRepair.demandTaskIds) {
      const demandTask = await this.stateManager.loadTask(demandTaskId);
      if (
        demandTask?.status === 'failed_finalize'
        && (
          resolveTaskRecoveryKind(demandTask) === 'baseline_repair'
          || resolveTaskRecoveryKind(demandTask) === 'baseline_exhaustion'
          || resolveTaskRecoveryKind(demandTask) === 'baseline_supersession_migration'
        )
        && demandTask.baselineQualityGate?.kind === 'baseline_quality_gate_failure'
        && demandTask.baselineQualityGate.repairTaskId === task.id
        && isBaselineQualityGateStateCurrent(demandTask)
      ) {
        return false;
      }
    }

    return true;
  }

  async recoverFailedTransientTasks(): Promise<void> {
    const recoveryConfig = resolveTransientRecoveryConfig(this.configManager);
    const failedTasks = (await this.stateManager.listTasks('failed'))
      .slice()
      .sort((a: Task, b: Task) => a.startTime - b.startTime);

    for (const task of failedTasks) {
      const transientFailure = resolveRetryableTransientFailure(task);
      if (!transientFailure) {
        continue;
      }

      const repairStoryId = selectRecoveryStoryId(task);
      if (!repairStoryId) {
        continue;
      }

      const now = Date.now();
      if (await this.isObsoleteBaselineRepairTask(task)) {
        await this.stateManager.updateTask(task.id, {
          autoRecoveryKind: 'transient',
          autoRecoveryStoppedAt: now,
          autoRecoveryStopReason: 'obsolete_baseline_repair',
          autoRecoveryLastReason: 'Baseline repair task no longer matches any active baseline demand',
          transientRecoveryStoppedAt: now,
          transientRecoveryStopReason: 'obsolete_baseline_repair',
          transientRecoveryNextEligibleAt: undefined,
          autoRecoveryNextEligibleAt: undefined,
        });
        appendTaskEvent(task, {
          type: 'obsolete_baseline_repair_recovery_stopped',
          status: 'failed',
          storyId: repairStoryId,
          message: 'Stopped transient recovery because this baseline repair no longer matches any active demand task',
          data: {
            repairKey: task.baselineRepair?.repairKey,
            demandTaskIds: task.baselineRepair?.demandTaskIds,
            failureKind: transientFailure.kind,
            failureClass: transientFailure.class,
          },
        });
        this.logger.log(`Task ${task.id} stopped transient auto-recovery because its baseline repair demand is obsolete`);
        continue;
      }

      let startedAt = task.transientRecoveryStartedAt
        ?? task.lastErrorObservedAt
        ?? now;
      let deadlineAt = task.transientRecoveryDeadlineAt
        ?? startedAt + (recoveryConfig.transientRecoveryDeadlineSeconds * 1000);
      const currentFailureObservedAt = task.lastErrorObservedAt
        ?? task.endTime
        ?? task.updatedAt
        ?? now;
      const previousFailureStoryId = task.transientRecoveryLastFailureStoryId
        ?? task.transientRecoveryLastRequeuedStoryId;
      const storyChanged = Boolean(previousFailureStoryId && previousFailureStoryId !== repairStoryId);
      const previousSignature = task.transientRecoveryLastFailureSignature;
      const firstRecoveryObservation = previousSignature === undefined
        && task.transientRecoveryLastFailureObservedAt === undefined
        && previousFailureStoryId === undefined
        && task.transientRecoveryConsecutiveSameSignature === undefined;
      const isNewFailureObservation = firstRecoveryObservation
        || task.transientRecoveryLastFailureObservedAt !== currentFailureObservedAt
        || previousFailureStoryId !== repairStoryId
        || previousSignature !== transientFailure.signature;
      const nextConsecutiveSameSignature = !isNewFailureObservation
        ? task.transientRecoveryConsecutiveSameSignature ?? 0
        : firstRecoveryObservation || storyChanged || previousSignature !== transientFailure.signature
          ? 1
          : (task.transientRecoveryConsecutiveSameSignature ?? 0) + 1;
      const isTimeoutLike = isTimeoutLikeTransient(transientFailure.kind);
      const hadObjectiveProgress = hasTransientProgressEvidence(task);
      const progressReason = buildTransientProgressReason(task, repairStoryId);
      const stoppedReason = task.transientRecoveryStopReason || task.autoRecoveryStopReason;
      const stoppedAt = task.transientRecoveryStoppedAt || task.autoRecoveryStoppedAt;
      const currentTotalRequeues = task.transientRecoveryTotalRequeues ?? 0;
      const currentAutoRequeues = task.autoRecoveryTotalRequeues ?? 0;
      const canReviveStoppedSameSignature = Boolean(
        stoppedAt
        && stoppedReason === 'transient_same_signature_no_progress'
        && currentTotalRequeues < recoveryConfig.maxTransientRecoveryRequeues
        && currentAutoRequeues < recoveryConfig.autoRecoveryHardCap
        && recoveryConfig.transientRecoveryProgressAwareSameSignature
        && isTimeoutLike
        && (hadObjectiveProgress || storyChanged)
        && !hasTransientRecoveryUnsafeDeliveryMarker(task)
      );
      const openedFreshRevivalWindow = canReviveStoppedSameSignature && deadlineAt <= now;
      if (openedFreshRevivalWindow) {
        startedAt = now;
        deadlineAt = now + (recoveryConfig.transientRecoveryDeadlineSeconds * 1000);
      }
      const commonUpdates: Partial<Task> = {
        lastErrorKind: transientFailure.kind,
        lastErrorClass: transientFailure.class,
        lastErrorRetryable: true,
        lastErrorSignature: transientFailure.signature,
        lastErrorHadObjectiveProgress: hadObjectiveProgress,
        transientRecoveryStartedAt: startedAt,
        transientRecoveryDeadlineAt: deadlineAt,
        transientRecoveryConsecutiveSameSignature: nextConsecutiveSameSignature,
        transientRecoveryLastFailureKind: transientFailure.kind,
        transientRecoveryLastFailureClass: transientFailure.class,
        transientRecoveryLastFailureSignature: transientFailure.signature,
        transientRecoveryLastFailureObservedAt: currentFailureObservedAt,
        transientRecoveryLastFailureStoryId: repairStoryId,
        transientRecoveryLastProgressReason: progressReason,
        transientRecoveryLastHadObjectiveProgress: hadObjectiveProgress,
        autoRecoveryKind: 'transient',
        autoRecoveryHardCap: recoveryConfig.autoRecoveryHardCap,
      };

      const needsBackfill = task.lastErrorKind !== commonUpdates.lastErrorKind
        || task.lastErrorClass !== commonUpdates.lastErrorClass
        || task.lastErrorRetryable !== true
        || task.lastErrorSignature !== commonUpdates.lastErrorSignature
        || task.lastErrorHadObjectiveProgress === undefined;

      let stopReason: string | undefined;
      let stopMessage: string | undefined;
      if (deadlineAt <= now) {
        stopReason = 'transient_deadline_exhausted';
        stopMessage = 'Transient recovery deadline exhausted';
      } else if (currentTotalRequeues >= recoveryConfig.maxTransientRecoveryRequeues) {
        stopReason = 'transient_budget_exhausted';
        stopMessage = 'Transient recovery requeue budget exhausted';
      } else if (currentAutoRequeues >= recoveryConfig.autoRecoveryHardCap) {
        stopReason = 'auto_recovery_hard_cap_reached';
        stopMessage = 'Auto-recovery hard cap reached';
      } else if (hasTransientRecoveryUnsafeDeliveryMarker(task)) {
        stopReason = 'transient_unsafe_delivery_marker';
        stopMessage = 'Transient recovery is blocked by delivery/finalizer markers';
      } else if (
        nextConsecutiveSameSignature >= recoveryConfig.maxTransientRecoverySameSignature
        && (
          !recoveryConfig.transientRecoveryProgressAwareSameSignature
          || (!hadObjectiveProgress && !storyChanged)
        )
      ) {
        stopReason = 'transient_same_signature_no_progress';
        stopMessage = 'Transient recovery saw the same retryable failure signature repeatedly';
      }

      if (stopReason && !stoppedAt) {
        await this.stateManager.updateTask(task.id, {
          ...commonUpdates,
          transientRecoveryStoppedAt: now,
          transientRecoveryStopReason: stopReason,
          autoRecoveryStoppedAt: now,
          autoRecoveryStopReason: stopReason,
          autoRecoveryLastReason: stopMessage,
        });
        appendTaskEvent(task, {
          type: 'transient_recovery_stopped',
          status: 'failed',
          storyId: repairStoryId,
          message: stopMessage,
          data: {
            stopReason,
            failureKind: transientFailure.kind,
            failureClass: transientFailure.class,
            failureSignature: transientFailure.signature,
            consecutiveSameSignature: nextConsecutiveSameSignature,
            totalRequeues: currentTotalRequeues,
            deadlineAt,
          },
        });
        this.logger.log(`Task ${task.id} stopped transient auto-recovery (${stopMessage})`);
        continue;
      }

      if (stoppedAt && !canReviveStoppedSameSignature) {
        continue;
      }

      if (!canReviveStoppedSameSignature && !task.transientRecoveryNextEligibleAt) {
        const delayMs = resolveTransientRecoveryDelayMs(currentTotalRequeues + 1, recoveryConfig);
        const nextEligibleAt = now + delayMs;
        await this.stateManager.updateTask(task.id, {
          ...commonUpdates,
          transientRecoveryLastDelayMs: delayMs,
          transientRecoveryNextEligibleAt: nextEligibleAt,
          transientRecoveryStoppedAt: undefined,
          transientRecoveryStopReason: undefined,
          autoRecoveryNextEligibleAt: nextEligibleAt,
          autoRecoveryStoppedAt: undefined,
          autoRecoveryStopReason: undefined,
          autoRecoveryLastReason: `Scheduled transient auto-recovery for ${transientFailure.kind}`,
        });
        appendTaskEvent(task, {
          type: 'transient_recovery_scheduled',
          status: 'failed',
          storyId: repairStoryId,
          message: `Scheduled transient auto-recovery after ${transientFailure.kind}`,
          data: {
            failureKind: transientFailure.kind,
            failureClass: transientFailure.class,
            failureSignature: transientFailure.signature,
            delayMs,
            nextEligibleAt,
            needsBackfill,
          },
        });
        this.logger.log(`Task ${task.id} scheduled transient auto-recovery in ${delayMs}ms`);
        continue;
      }

      if (
        !canReviveStoppedSameSignature
        && task.transientRecoveryNextEligibleAt
        && task.transientRecoveryNextEligibleAt > now
      ) {
        if (needsBackfill) {
          await this.stateManager.updateTask(task.id, commonUpdates);
        }
        continue;
      }

      const progressAwareRepair = recoveryConfig.transientRecoveryProgressAwareSameSignature
        && isTimeoutLike
        && hadObjectiveProgress;
      const resetMessage = progressAwareRepair
        ? `Automatically requeued ${repairStoryId} after ${transientFailure.kind} with objective progress. Continue from the existing worktree diff, do not redo passed stories, finish only ${repairStoryId}, then run targeted validation.`
        : `Automatically requeued after retryable ${transientFailure.kind} failure`;
      const resetState = resetSingleStory(task, repairStoryId, {
        status: progressAwareRepair ? 'needs_repair' : 'pending',
        updatedAt: now,
        message: resetMessage,
      });
      const nextTransientRequeues = currentTotalRequeues + 1;
      const nextAutoRecoveryRequeues = currentAutoRequeues + 1;

      await this.stateManager.updateTask(task.id, {
        ...commonUpdates,
        status: 'pending',
        completedUS: resetState.completedUS,
        storyProgress: resetState.storyProgress,
        currentUS: undefined,
        pid: undefined,
        endTime: undefined,
        leaseOwner: undefined,
        leaseHeartbeatAt: undefined,
        leaseExpiresAt: undefined,
        loopCount: 0,
        consecutiveNoProgress: 0,
        consecutiveErrors: 0,
        lastProgressTime: now,
        transientRetryCount: 0,
        transientRetryBudget: undefined,
        transientRetryLastDelayMs: undefined,
        transientRecoveryTotalRequeues: nextTransientRequeues,
        transientRecoveryNextEligibleAt: undefined,
        transientRecoveryStoppedAt: undefined,
        transientRecoveryStopReason: undefined,
        transientRecoveryLastRequeuedStoryId: repairStoryId,
        autoRecoveryTotalRequeues: nextAutoRecoveryRequeues,
        autoRecoveryLastRequeuedAt: now,
        autoRecoveryNextEligibleAt: undefined,
        autoRecoveryStoppedAt: undefined,
        autoRecoveryStopReason: undefined,
        autoRecoveryLastReason: resetMessage,
      });
      appendTaskEvent(task, {
        type: progressAwareRepair
          ? 'transient_recovery_progress_auto_requeued'
          : 'transient_recovery_auto_requeued',
        status: 'pending',
        storyId: repairStoryId,
        message: resetMessage,
        data: {
          failureKind: transientFailure.kind,
          failureClass: transientFailure.class,
          failureSignature: transientFailure.signature,
          hadObjectiveProgress,
          progressReason,
          revivedStoppedRecovery: canReviveStoppedSameSignature,
          openedFreshRevivalWindow,
          totalRequeues: nextTransientRequeues,
        },
      });
      this.logger.log(`Task ${task.id} returned to pending after transient auto-recovery`);
    }
  }

  async recoverStagnantTasks(): Promise<void> {
    const recoveryConfig = resolveTransientRecoveryConfig(this.configManager);
    const stagnantTasks = (await this.stateManager.listTasks('stagnant'))
      .slice()
      .sort((a: Task, b: Task) => a.startTime - b.startTime);

    for (const task of stagnantTasks) {
      const now = Date.now();
      const currentAutoRequeues = task.autoRecoveryTotalRequeues ?? 0;
      const stopReason = 'stagnation_auto_recovery_hard_cap_reached';
      const stopMessage = 'Stagnation auto-recovery hard cap reached';

      if (currentAutoRequeues >= recoveryConfig.autoRecoveryHardCap) {
        if (task.autoRecoveryStopReason === stopReason && task.autoRecoveryStoppedAt) {
          continue;
        }

        await this.stateManager.updateTask(task.id, {
          autoRecoveryKind: 'stagnant',
          autoRecoveryHardCap: recoveryConfig.autoRecoveryHardCap,
          autoRecoveryStoppedAt: now,
          autoRecoveryStopReason: stopReason,
          autoRecoveryLastReason: stopMessage,
        });
        appendTaskEvent(task, {
          type: 'stagnant_recovery_stopped',
          status: 'stagnant',
          storyId: selectStagnantRecoveryStoryId(task),
          message: stopMessage,
          data: {
            stopReason,
            totalRequeues: currentAutoRequeues,
            hardCap: recoveryConfig.autoRecoveryHardCap,
          },
        });
        this.logger.log(`Task ${task.id} stopped stagnation auto-recovery (${stopMessage})`);
        continue;
      }

      const repairStoryId = selectStagnantRecoveryStoryId(task);
      const resetMessage = task.repairContext?.mode === 'merge'
        ? 'Automatically requeued merge repair after stagnation'
        : 'Automatically requeued after stagnation timeout';
      const storyStatus = task.repairContext?.mode === 'merge' ? 'needs_repair' : 'pending';
      const nextAutoRequeues = currentAutoRequeues + 1;
      const refreshedMergeRepairContext = task.repairContext?.mode === 'merge'
        ? buildTaskRepairContext({
            mode: 'merge',
            storyId: repairStoryId ?? task.repairContext.storyId,
            reason: buildMergeRepairReason(task),
            createdAt: now,
          })
        : undefined;
      const resetState = repairStoryId
        ? resetSingleStory(task, repairStoryId, {
            status: storyStatus,
            updatedAt: now,
            message: resetMessage,
          })
        : {
            completedUS: task.completedUS,
            storyProgress: task.storyProgress,
          };

      await this.stateManager.updateTask(task.id, {
        status: 'pending',
        completedUS: resetState.completedUS,
        storyProgress: resetState.storyProgress,
        currentUS: undefined,
        pid: undefined,
        endTime: undefined,
        leaseOwner: undefined,
        leaseHeartbeatAt: undefined,
        leaseExpiresAt: undefined,
        loopCount: 0,
        consecutiveNoProgress: 0,
        consecutiveErrors: 0,
        lastProgressTime: now,
        lastError: undefined,
        lastErrorKind: undefined,
        lastErrorClass: undefined,
        lastErrorRetryable: undefined,
        lastErrorObservedAt: undefined,
        lastErrorSignature: undefined,
        lastErrorHadObjectiveProgress: undefined,
        transientRetryCount: 0,
        transientRetryBudget: undefined,
        transientRetryLastDelayMs: undefined,
        autoRecoveryKind: 'stagnant',
        autoRecoveryTotalRequeues: nextAutoRequeues,
        autoRecoveryHardCap: recoveryConfig.autoRecoveryHardCap,
        autoRecoveryLastRequeuedAt: now,
        autoRecoveryNextEligibleAt: undefined,
        autoRecoveryStoppedAt: undefined,
        autoRecoveryStopReason: undefined,
        autoRecoveryLastReason: resetMessage,
        repairContext: refreshedMergeRepairContext ?? task.repairContext,
        ...(task.repairContext?.mode === 'merge'
          ? {
              postFinalizeMergeProbeRequired: true,
              ...captureObservedTaskSurface(task),
            }
          : {}),
        mergeRepairRecoveryStartedAt: undefined,
        mergeRepairRecoveryDeadlineAt: undefined,
        mergeRepairRecoveryTotalRequeues: undefined,
        mergeRepairRecoveryConsecutiveNoProgress: undefined,
        mergeRepairRecoveryLastConflictSignature: undefined,
        mergeRepairRecoveryLastProbeMessage: undefined,
        mergeRepairRecoveryLastProgressReason: undefined,
        mergeRepairRecoveryStoppedAt: undefined,
        mergeRepairRecoveryStopReason: undefined,
      });
      appendTaskEvent(task, {
        type: 'stagnant_recovery_auto_requeued',
        status: 'pending',
        storyId: repairStoryId,
        message: resetMessage,
        data: {
          repairMode: task.repairContext?.mode,
          totalRequeues: nextAutoRequeues,
          hardCap: recoveryConfig.autoRecoveryHardCap,
        },
      });
      this.logger.log(`Task ${task.id} returned to pending after stagnation auto-recovery`);
    }
  }

  async classifyBaselineQualityGateFailures(): Promise<void> {
    const autoClassify = this.configManager.get('runner.autoClassifyBaselineQualityGateFailures');
    if (autoClassify === false) {
      return;
    }

    const targetBranch = resolveMergeTargetBranch(this.configManager.get('merge.targetBranch'));
    const autoRemediate = this.configManager.get('runner.autoRemediateBaselineQualityGateFailures') === true;
    const failedFinalizeTasks = (await this.stateManager.listTasks('failed_finalize'))
      .slice()
      .sort((a: Task, b: Task) => a.startTime - b.startTime);

    for (const originalTask of failedFinalizeTasks) {
      const task = await this.refreshFailedFinalizeFailureState(originalTask);
      if (!shouldClassifyBaselineQualityGateTask(task, autoRemediate)) {
        continue;
      }
      const finalizerFailure = task.finalizerFailure;
      if (!finalizerFailure) {
        continue;
      }

      const classification = await this.classifyBaselineQualityGateFailureFn({
        task,
        configManager: this.configManager,
        targetBranch,
      });

      if (classification.kind === 'not_quality_gate_failure') {
        continue;
      }

      const observedAt = Date.now();
      const failureGate = task.latestFailure?.gate
        ?? classification.baselineFailure?.gate
        ?? finalizerFailure.gate;
      const failurePackageLabel = task.latestFailure?.packageLabel
        ?? classification.baselineFailure?.packageLabel
        ?? finalizerFailure.packageLabel;
      const repairGroupKey = classification.repairGroupKey ?? deriveBaselineRepairGroupKey({
        targetBranch,
        packageLabel: failurePackageLabel,
      });
      let repairTaskId: string | undefined;
      let demandTaskIds: string[] | undefined;
      let repairPrdId: string | undefined;
      let taskEnvRepair: BaselineQualityGateEnvironmentRepairState | undefined = task.baselineQualityGate?.taskEnvRepair;
      const envSelfHealEnabled = this.configManager.get('runner.baselineQualityGateEnvSelfHealEnabled') !== false;
      const envSelfHealMaxAttempts = Math.floor(
        getPositiveNumber(this.configManager.get('runner.baselineQualityGateEnvSelfHealMaxAttempts'), 3),
      );
      const previousEnvAttempts = task.baselineQualityGate?.taskEnvRepair?.attempts ?? 0;

      if (
        envSelfHealEnabled
        && classification.taskRootCause === 'dependency_bootstrap_worktree_environment'
        && previousEnvAttempts < envSelfHealMaxAttempts
      ) {
        taskEnvRepair = this.repairTaskWorktreeDependencyBootstrapFn(
          task,
          previousEnvAttempts + 1,
          { logger: this.logger },
        );
      }

      if (
        classification.kind === 'task_quality_gate_failure'
        && (
          taskEnvRepair?.repaired
          || (
            classification.taskRootCause === 'dependency_bootstrap_worktree_environment'
            && /Corepack|PNPM|toolchain/i.test(classification.message)
          )
        )
      ) {
        const baselineQualityGate = buildBaselineQualityGateState({
          task,
          classification,
          targetBranch,
          observedAt,
          phase: taskEnvRepair?.repaired ? 'task_env_repaired' : 'task_env_self_heal',
          taskEnvRepair,
        });
        const envRepairMessage = taskEnvRepair?.message
          ?? 'Normalized toolchain environment; finalization can retry without creating baseline product repair';

        await this.stateManager.updateTask(task.id, {
          status: 'ready_to_finalize',
          endTime: undefined,
          pid: undefined,
          currentUS: undefined,
          leaseOwner: undefined,
          leaseHeartbeatAt: undefined,
          leaseExpiresAt: undefined,
          lastErrorKind: 'quality_gate_failure',
          baselineQualityGate,
          autoRecoveryKind: undefined,
          autoRecoveryStoppedAt: undefined,
          autoRecoveryStopReason: undefined,
          autoRecoveryLastReason: envRepairMessage,
          finalizeRepairStoppedAt: undefined,
          finalizeRepairStopReason: undefined,
        });
        appendTaskEvent(task, {
          type: 'baseline_task_env_self_healed',
          status: 'ready_to_finalize',
          message: envRepairMessage,
          data: {
            rootCause: classification.taskRootCause,
            removedPaths: taskEnvRepair?.removedPaths,
            installRoot: taskEnvRepair?.installRoot,
            packageManager: taskEnvRepair?.packageManager,
          },
        });
        this.logger.log(`Task ${task.id} dependency bootstrap environment repaired; finalization can retry`);
        continue;
      }

      if (
        classification.kind === 'baseline_quality_gate_failure'
        && autoRemediate
        && isAutoRepairableBaselineRootCause(classification.rootCause)
        && (classification.baselineFailure || finalizerFailure)
      ) {
        const isRepairTask = isDedicatedBaselineRepairTask(task);
        const isSameGroupRepairTask = Boolean(
          isRepairTask
          && (
            task.baselineRepair?.repairGroupKey === repairGroupKey
            || (
              !task.baselineRepair?.repairGroupKey
              && task.baselineRepair?.targetBranch === targetBranch
              && task.baselineRepair?.packageLabel === failurePackageLabel
            )
          )
        );

        if (isSameGroupRepairTask) {
          const repairKey = classification.repairKey
            ?? classification.baselineFailureSignature
            ?? classification.signature
            ?? task.id;
          const repairKeyAliases = Array.from(new Set([
            task.baselineRepair?.repairKey,
            ...(task.baselineRepair?.repairKeyAliases ?? []),
            repairKey,
          ].filter((value): value is string => Boolean(value))));
          const repairStoryId = selectFinalizeRepairStoryId(task, false);
          const message = `Additional ${failurePackageLabel} baseline gate discovered: ${failureGate}; continuing canonical package baseline repair`;
          const reset = repairStoryId
            ? resetSingleStory(task, repairStoryId, {
                status: 'needs_repair',
                updatedAt: observedAt,
                message,
              })
            : {
                completedUS: task.completedUS,
                storyProgress: task.storyProgress,
              };
          const baselineQualityGate = buildBaselineQualityGateState({
            task,
            classification,
            targetBranch,
            observedAt,
            phase: 'classified',
            taskEnvRepair,
          });

          await this.stateManager.updateTask(task.id, {
            status: 'pending',
            endTime: undefined,
            pid: undefined,
            leaseOwner: undefined,
            leaseHeartbeatAt: undefined,
            leaseExpiresAt: undefined,
            currentUS: undefined,
            completedUS: reset.completedUS,
            storyProgress: reset.storyProgress,
            repairContext: repairStoryId
              ? buildTaskRepairContext({
                  mode: 'finalize',
                  storyId: repairStoryId,
                  reason: message,
                  createdAt: observedAt,
                })
              : task.repairContext,
            autoRecoveryKind: 'baseline_repair',
            autoRecoveryStoppedAt: undefined,
            autoRecoveryStopReason: undefined,
            autoRecoveryLastReason: message,
            finalizeRepairStoppedAt: undefined,
            finalizeRepairStopReason: undefined,
            baselineQualityGate: {
              ...baselineQualityGate,
              repairTaskId: undefined,
              repairGroupKey,
            },
            baselineRepair: task.baselineRepair
              ? {
                  ...task.baselineRepair,
                  repairGroupKey,
                  repairComponentKey: classification.repairComponentKey,
                  repairKeyAliases,
                  discoveryCount: (task.baselineRepair.discoveryCount ?? 0) + 1,
                  lastDiscoveredFailureSignature: classification.baselineFailureSignature
                    ?? classification.signature,
                  lastDiscoveredGate: failureGate,
                  updatedAt: observedAt,
                  status: 'needs_more_repair',
                  message,
                }
              : undefined,
          });
          appendTaskEvent(task, {
            type: 'baseline_repair_continued_in_place',
            status: 'pending',
            message,
            data: {
              repairGroupKey,
              repairKey,
              repairKeyAliases,
              gate: failureGate,
              packageLabel: failurePackageLabel,
            },
          });
          this.logger.log(`Task ${task.id} same-group baseline repair continued in place`);
          continue;
        }

        demandTaskIds = [task.id];
        const repairTask = await this.ensureBaselineRepairTaskFn({
          repoPath: task.repoPath,
          targetBranch,
          failure: classification.baselineFailure ?? finalizerFailure,
          signature: classification.baselineFailureSignature ?? classification.signature ?? task.id,
          repairKey: classification.repairKey ?? classification.baselineFailureSignature ?? classification.signature ?? task.id,
          repairGroupKey,
          rootCause: classification.rootCause,
          demandTaskIds,
          stateManager: this.stateManager,
          scheduler: this.scheduler,
          configManager: this.configManager,
        });
        repairTaskId = repairTask.taskId;
        repairPrdId = repairTask.prdId;
      }

      const baselineQualityGate = buildBaselineQualityGateState({
        task,
        classification,
        targetBranch,
        observedAt,
        repairTaskId,
        demandTaskIds,
        phase: repairTaskId ? 'waiting_for_baseline_repair' : 'classified',
        taskEnvRepair,
      });
      const updates: Partial<Task> = {
        baselineQualityGate,
      };

      if (classification.kind === 'baseline_quality_gate_failure') {
        updates.lastErrorKind = 'baseline_quality_gate_failure';
        updates.finalizeRepairStoppedAt = observedAt;
        updates.finalizeRepairStopReason = 'baseline_quality_gate_failure';

        if (repairTaskId) {
          const deadlineSeconds = getPositiveNumber(
            this.configManager.get('runner.baselineQualityGateRepairDeadlineSeconds'),
            7200,
          );
          updates.autoRecoveryKind = 'baseline_repair';
          updates.autoRecoveryStoppedAt = undefined;
          updates.autoRecoveryStopReason = undefined;
          updates.autoRecoveryLastReason = `Waiting for baseline repair task ${repairTaskId}`;
          updates.baselineRepair = {
            repairKey: classification.repairKey ?? classification.baselineFailureSignature ?? classification.signature ?? task.id,
            repairGroupKey,
            repairComponentKey: classification.repairComponentKey,
            rootCause: classification.rootCause,
            targetBranch,
            gate: failureGate,
            packageLabel: failurePackageLabel,
            demandTaskIds: demandTaskIds ?? [task.id],
            repairTaskId,
            repairPrdId,
            generation: task.baselineRepair?.generation ?? 1,
            generationStartedAt: task.baselineRepair?.generationStartedAt ?? observedAt,
            generationDeadlineAt: task.baselineRepair?.generationDeadlineAt,
            generationTotalRequeues: task.baselineRepair?.generationTotalRequeues ?? 0,
            startedAt: task.baselineRepair?.startedAt ?? observedAt,
            updatedAt: observedAt,
            deadlineAt: observedAt + deadlineSeconds * 1000,
            status: 'waiting',
            message: `Waiting for baseline repair task ${repairTaskId}`,
          };
          updates.baselineRepairRole = 'demand_task';
        } else {
          updates.autoRecoveryKind = undefined;
          updates.autoRecoveryStoppedAt = undefined;
          updates.autoRecoveryStopReason = undefined;
          updates.autoRecoveryLastReason = isAutoRepairableBaselineRootCause(classification.rootCause)
            ? classification.message
            : `Baseline root cause ${classification.rootCause ?? 'unknown'} is not safe for automatic product repair`;
        }
      }

      if (classification.kind === 'baseline_probe_failed') {
        updates.finalizeRepairStoppedAt = observedAt;
        updates.finalizeRepairStopReason = 'baseline_quality_gate_probe_failed';
        updates.autoRecoveryKind = undefined;
        updates.autoRecoveryStoppedAt = undefined;
        updates.autoRecoveryStopReason = undefined;
        updates.autoRecoveryLastReason = classification.message;
      }

      await this.stateManager.updateTask(task.id, updates);
      appendTaskEvent(task, {
        type: classification.kind === 'baseline_quality_gate_failure'
          ? 'baseline_quality_gate_failure_detected'
          : 'baseline_quality_gate_classified',
        status: 'failed_finalize',
        message: repairTaskId
          ? `${classification.message}; waiting for baseline repair task ${repairTaskId}`
          : classification.message,
        data: {
          kind: classification.kind,
          gate: failureGate,
          packageLabel: failurePackageLabel,
          signature: classification.signature,
          taskFailureSignature: classification.taskFailureSignature,
          baselineFailureSignature: classification.baselineFailureSignature,
          repairKey: classification.repairKey,
          rootCause: classification.rootCause,
          taskRootCause: classification.taskRootCause,
          repairTaskId,
        },
      });
      this.logger.log(`Task ${task.id} baseline quality gate classified as ${classification.kind}`);
    }
  }

  async coalesceBaselineRepairGraph(): Promise<void> {
    const tasks = await this.stateManager.listTasks();
    const result = await coalesceBaselineRepairGraph({
      tasks,
      stateManager: this.stateManager,
      logger: this.logger,
    });

    if (result.collapsed > 0) {
      this.logger.log(
        `Coalesced ${result.collapsed} baseline repair cycle(s): ${result.canonicalTaskIds.join(', ')}`,
      );
    }
  }

  async recoverBlockedAutonomyTasks(): Promise<void> {
    if (!resolveAutonomyRepairConfig(this.configManager).autoRecoverBlockedTasks) {
      return;
    }

    const controller = new AutonomyRepairController({
      stateManager: this.stateManager,
      configManager: this.configManager,
      logger: this.logger,
    });
    const result = await controller.run();

    if (result.repaired > 0 || result.stopped > 0) {
      this.logger.log(
        `Autonomy repair: resumed=${result.repaired} blocked=${result.stopped} tasks=${[
          ...result.repairedTaskIds,
          ...result.stoppedTaskIds,
        ].join(', ')}`,
      );
    }
  }

  private async enqueueStoppedRecoveryFollowups(input: {
    kind: 'transient' | 'agent_context' | 'story_repair' | 'finalize_repair';
    isCandidate: (task: Task) => boolean;
    reason: (task: Task) => string;
    recommendations: (task: Task) => string[];
  }): Promise<void> {
    const tasks = (await this.stateManager.listTasks())
      .filter(input.isCandidate)
      .filter((task) => !task.followupTaskIds?.length)
      .sort((a: Task, b: Task) => a.startTime - b.startTime);

    for (const task of tasks) {
      try {
        const result = await enqueueFollowupPrd({
          task,
          stateManager: this.stateManager,
          scheduler: this.scheduler,
          configManager: this.configManager,
          reason: input.reason(task),
          failure: task.latestFailure ?? buildFailureObservationFromTask(task),
          recommendedStories: input.recommendations(task),
          scope: task.declaredWriteSurface,
        });
        this.logger.log(`Task ${task.id} generated ${input.kind} follow-up PRD ${result.prdId} (${result.taskId})`);
      } catch (error) {
        if (error instanceof Error && /hard cap reached/.test(error.message)) {
          this.logger.log(`Task ${task.id} skipped ${input.kind} follow-up PRD generation: ${error.message}`);
          continue;
        }

        throw error;
      }
    }
  }

  async recoverStoppedTransientTasks(): Promise<void> {
    await this.enqueueStoppedRecoveryFollowups({
      kind: 'transient',
      isCandidate: (task) => task.status === 'failed' && Boolean(task.transientRecoveryStoppedAt),
      reason: (task) => task.transientRecoveryStopReason ?? task.autoRecoveryStopReason ?? 'transient recovery stopped',
      recommendations: (task) => [
        `Reproduce the transient failure for task ${task.id} and determine whether it is still current.`,
        'Implement a targeted fix, environment bootstrap, or smaller follow-up story so the original task can proceed.',
        'Run the command that previously failed and capture the passing evidence.',
      ],
    });
  }

  async recoverStoppedAgentContextTasks(): Promise<void> {
    await this.enqueueStoppedRecoveryFollowups({
      kind: 'agent_context',
      isCandidate: (task) => task.status === 'failed' && Boolean(task.agentContextRecoveryStoppedAt),
      reason: (task) => task.agentContextRecoveryStopReason ?? task.autoRecoveryStopReason ?? 'agent-context recovery stopped',
      recommendations: (task) => [
        `Split or narrow the failed story for task ${task.id} so it can complete inside a fresh agent context.`,
        'Preserve completed story behavior and only change the scope needed for the blocked story.',
        'Verify the reduced story and document any remaining follow-up scope.',
      ],
    });
  }

  async recoverStoppedStoryRepairTasks(): Promise<void> {
    await this.enqueueStoppedRecoveryFollowups({
      kind: 'story_repair',
      isCandidate: (task) => task.status === 'failed' && Boolean(
        task.storyRepairRecoveryStoppedAt
        || task.failedBlockerRecoveryStoppedAt
      ),
      reason: (task) => task.storyRepairRecoveryStopReason
        ?? task.failedBlockerRecoveryStopReason
        ?? task.autoRecoveryStopReason
        ?? 'story repair recovery stopped',
      recommendations: (task) => [
        `Repair or safely split the stopped story recovery for task ${task.id}.`,
        'Avoid resetting delivered or integrated work; preserve existing completed story behavior.',
        'Run the task-level verification and record the exact passing command.',
      ],
    });
  }

  async recoverStoppedFinalizeRepairTasks(): Promise<void> {
    await this.enqueueStoppedRecoveryFollowups({
      kind: 'finalize_repair',
      isCandidate: (task) => task.status === 'failed_finalize' && Boolean(task.finalizeRepairStoppedAt),
      reason: (task) => task.finalizeRepairStopReason ?? task.autoRecoveryStopReason ?? 'finalize repair stopped',
      recommendations: (task) => [
        `Reclassify the finalizer failure for task ${task.id} using current failure evidence.`,
        'Implement the smallest safe product, baseline, or environment repair needed to pass finalization.',
        'Rerun the finalizer quality gate and capture the result.',
      ],
    });
  }

  async recoverStoppedGenericRecoveryTasks(): Promise<void> {
    await this.enqueueStoppedRecoveryFollowups({
      kind: 'transient',
      isCandidate: (task) => task.status === 'failed'
        && Boolean(task.autoRecoveryStoppedAt)
        && !task.autoRecoveryKind
        && !task.transientRecoveryStoppedAt
        && !task.agentContextRecoveryStoppedAt
        && !task.storyRepairRecoveryStoppedAt
        && !task.failedBlockerRecoveryStoppedAt
        && !task.mergeRepairRecoveryStoppedAt
        && !task.finalizeRepairStoppedAt,
      reason: (task) => task.autoRecoveryStopReason ?? 'generic recovery stopped',
      recommendations: (task) => [
        `Reconstruct the stopped recovery path for task ${task.id} from the latest task failure and agent log.`,
        'Implement the smallest safe follow-up repair or split that lets the original objective proceed.',
        'Run the relevant task-level verification and record objective passing evidence.',
      ],
    });
  }

  async recoverBaselineBlockedFinalizeTasks(): Promise<void> {
    const repairConfig = resolveFinalizeRepairConfig(this.configManager);
    const failedFinalizeTasks = (await this.stateManager.listTasks('failed_finalize'))
      .slice()
      .sort((a: Task, b: Task) => a.startTime - b.startTime);

    for (const originalTask of failedFinalizeTasks) {
      const task = await this.refreshFailedFinalizeFailureState(originalTask);
      const baseline = task.baselineQualityGate;
      const isRecoverableStoppedBaselineApplyFailure = Boolean(
        baseline?.phase === 'stopped'
        && baseline.stopReason === 'baseline_repair_apply_failed'
        && task.autoRecoveryStopReason === 'baseline_repair_apply_failed'
      );
      if (
        baseline?.kind !== 'baseline_quality_gate_failure'
        || !baseline.repairTaskId
        || (
          task.autoRecoveryKind !== 'baseline_repair'
          && baseline.phase !== 'baseline_repair_integrated'
          && !isRecoverableStoppedBaselineApplyFailure
        )
      ) {
        continue;
      }

      const repairTask = await this.stateManager.loadTask(baseline.repairTaskId);
      if (!repairTask) {
        continue;
      }

      const repairIntegrated = repairTask.status === 'completed'
        && resolveTaskIntegrationStatus(repairTask) === 'integrated';
      const repairRecovering = evaluateAutoRecovery(repairTask).active;
      const repairFailed = repairTask.status === 'failed'
        || repairTask.status === 'failed_finalize'
        || repairTask.status === 'stagnant'
        || (repairTask.status === 'completed' && resolveTaskIntegrationStatus(repairTask) !== 'integrated');
      const now = Date.now();

      if (repairIntegrated) {
        const worktreeApply = applyBaselineRepairCommitToTaskWorktree(task, repairTask);
        const sameIntegratedRepairAlreadyRetried = Boolean(
          baseline.phase === 'baseline_repair_integrated'
          && task.baselineRepair?.repairTaskId === repairTask.id
          && worktreeApply.commitSha
          && task.baselineRepair?.appliedRepairCommitSha === worktreeApply.commitSha
          && !worktreeApply.applied
        );

        if (sameIntegratedRepairAlreadyRetried) {
          const stopMessage = [
            `Baseline repair task ${repairTask.id} was already integrated into this task worktree.`,
            'The finalizer still fails after retrying, so Ralph is reclassifying the current failure through autonomy repair.',
          ].join(' ');
          const autonomyRepairSignature = task.latestFailure?.signature
            ?? baseline.latestFailureSignature
            ?? baseline.taskFailureSignature
            ?? baseline.signature
            ?? task.id;
          await this.stateManager.updateTask(task.id, {
            autoRecoveryKind: undefined,
            autoRecoveryStoppedAt: undefined,
            autoRecoveryStopReason: undefined,
            autoRecoveryLastReason: stopMessage,
            autonomyRepairKind: 'baseline_exhaustion',
            autonomyRepairStartedAt: task.autonomyRepairStartedAt ?? now,
            autonomyRepairDeadlineAt: task.autonomyRepairDeadlineAt,
            autonomyRepairTotalRequeues: task.autonomyRepairTotalRequeues ?? 0,
            autonomyRepairLastSignature: autonomyRepairSignature,
            autonomyRepairLastProgressReason: stopMessage,
            autonomyRepairLastRequeuedAt: now,
            autonomyRepairNextEligibleAt: undefined,
            autonomyRepairStoppedAt: undefined,
            autonomyRepairStopReason: undefined,
            autonomyRepairLastReason: stopMessage,
            baselineQualityGate: {
              ...baseline,
              phase: 'stopped',
              lastUpdatedAt: now,
              stoppedAt: now,
              stopReason: 'baseline_repair_exhausted',
            },
            baselineRepair: task.baselineRepair
              ? {
                  ...task.baselineRepair,
                  updatedAt: now,
                  status: 'needs_more_repair',
                  message: stopMessage,
                  appliedRepairCommitSha: worktreeApply.commitSha,
                  appliedRepairFiles: worktreeApply.files,
                  applySkippedReason: worktreeApply.message,
                }
              : undefined,
          });
          appendTaskEvent(task, {
            type: 'baseline_repair_exhaustion_handed_to_autonomy_repair',
            status: 'failed_finalize',
            message: stopMessage,
            data: {
              repairTaskId: repairTask.id,
              commitSha: worktreeApply.commitSha,
              skippedReason: worktreeApply.message,
              autonomyRepairKind: 'baseline_exhaustion',
            },
          });
          this.logger.log(`Task ${task.id} baseline repair task ${repairTask.id} handed to autonomy reclassification after finalizer retry`);
          continue;
        }

        if (worktreeApply.requiresOperator) {
          const reconcileAttempts = task.baselineRepair?.applyReconcileAttempts ?? 0;
          const repairStoryId = selectFinalizeRepairStoryId(task, false);
          const canRequeueReconcile = Boolean(
            repairStoryId
            && worktreeApply.conflictFiles?.length
            && reconcileAttempts < Math.max(1, repairConfig.maxRepairAttempts),
          );

          if (canRequeueReconcile && repairStoryId) {
            const repairMessage = [
              `Baseline repair task ${repairTask.id} integrated but could not be applied automatically.`,
              worktreeApply.message,
              'Reconcile the baseline repair into this task worktree without dropping task behavior.',
            ].join(' ');
            const storyProgress = (task.storyProgress || []).map((story) => story.id === repairStoryId
              ? {
                  ...story,
                  status: 'needs_repair' as const,
                  attempts: 0,
                  lastError: repairMessage,
                  updatedAt: now,
                  history: [
                    ...(story.history || []),
                    {
                      attempt: story.attempts,
                      status: 'needs_repair' as const,
                      message: repairMessage,
                      updatedAt: now,
                    },
                  ],
                }
              : story);

            await this.stateManager.updateTask(task.id, {
              status: 'pending',
              completedUS: task.completedUS.filter((storyId) => storyId !== repairStoryId),
              storyProgress,
              currentUS: undefined,
              pid: undefined,
              endTime: undefined,
              leaseOwner: undefined,
              leaseHeartbeatAt: undefined,
              leaseExpiresAt: undefined,
              repairContext: buildTaskRepairContext({
                mode: 'finalize',
                storyId: repairStoryId,
                reason: repairMessage,
                createdAt: now,
              }),
              autoRecoveryKind: 'baseline_repair',
              autoRecoveryStoppedAt: undefined,
              autoRecoveryStopReason: undefined,
              autoRecoveryLastReason: `Requeued baseline repair reconciliation for ${repairStoryId}`,
              finalizeRepairStoppedAt: undefined,
              finalizeRepairStopReason: undefined,
              finalizeRepairTotalRequeues: (task.finalizeRepairTotalRequeues ?? 0) + 1,
              baselineQualityGate: {
                ...baseline,
                phase: 'baseline_repair_integrated',
                lastUpdatedAt: now,
                stoppedAt: undefined,
                stopReason: undefined,
              },
              baselineRepair: task.baselineRepair
                ? {
                    ...task.baselineRepair,
                    updatedAt: now,
                    status: 'waiting',
                    message: repairMessage,
                    appliedRepairCommitSha: worktreeApply.commitSha,
                    appliedRepairFiles: worktreeApply.files,
                    applySkippedReason: worktreeApply.message,
                    applyConflictFiles: worktreeApply.conflictFiles,
                    applyReconcileAttempts: reconcileAttempts + 1,
                  }
                : undefined,
            });
            appendTaskEvent(task, {
              type: 'baseline_repair_reconcile_started',
              status: 'pending',
              storyId: repairStoryId,
              message: repairMessage,
              data: {
                repairTaskId: repairTask.id,
                commitSha: worktreeApply.commitSha,
                conflictFiles: worktreeApply.conflictFiles,
                reconcileAttempts: reconcileAttempts + 1,
                repairLimit: repairConfig.maxRepairAttempts,
              },
            });
            this.logger.log(`Task ${task.id} returned to pending baseline repair reconciliation for ${repairStoryId}`);
            continue;
          }

          await this.stateManager.updateTask(task.id, {
            autoRecoveryKind: undefined,
            autoRecoveryStoppedAt: now,
            autoRecoveryStopReason: 'baseline_repair_apply_failed',
            autoRecoveryLastReason: worktreeApply.message,
            baselineQualityGate: {
              ...baseline,
              phase: 'stopped',
              lastUpdatedAt: now,
              stoppedAt: now,
              stopReason: 'baseline_repair_apply_failed',
            },
            baselineRepair: task.baselineRepair
              ? {
                  ...task.baselineRepair,
                  updatedAt: now,
                  status: 'failed',
                  message: worktreeApply.message,
                  appliedRepairCommitSha: worktreeApply.commitSha,
                  appliedRepairFiles: worktreeApply.files,
                  applySkippedReason: worktreeApply.message,
                  applyConflictFiles: worktreeApply.conflictFiles,
                }
              : undefined,
          });
          appendTaskEvent(task, {
            type: 'baseline_repair_apply_failed',
            status: 'failed_finalize',
            message: worktreeApply.message,
            data: {
              repairTaskId: repairTask.id,
              commitSha: worktreeApply.commitSha,
              conflictFiles: worktreeApply.conflictFiles,
            },
          });
          this.logger.error(`Task ${task.id} could not apply baseline repair task ${repairTask.id}: ${worktreeApply.message}`);
          continue;
        }

        let taskEnvRepair = baseline.taskEnvRepair;
        const envSelfHealEnabled = this.configManager.get('runner.baselineQualityGateEnvSelfHealEnabled') !== false;
        const envSelfHealMaxAttempts = Math.floor(
          getPositiveNumber(this.configManager.get('runner.baselineQualityGateEnvSelfHealMaxAttempts'), 3),
        );
        const previousEnvAttempts = baseline.taskEnvRepair?.attempts ?? 0;

        if (
          envSelfHealEnabled
          && baseline.taskRootCause === 'dependency_bootstrap_worktree_environment'
          && previousEnvAttempts < envSelfHealMaxAttempts
        ) {
          taskEnvRepair = this.repairTaskWorktreeDependencyBootstrapFn(
            task,
            previousEnvAttempts + 1,
            { logger: this.logger },
          );
        }

        await this.stateManager.updateTask(task.id, {
          status: 'ready_to_finalize',
          endTime: undefined,
          pid: undefined,
          currentUS: undefined,
          leaseOwner: undefined,
          leaseHeartbeatAt: undefined,
          leaseExpiresAt: undefined,
          lastErrorKind: 'quality_gate_failure',
          autoRecoveryKind: undefined,
          autoRecoveryStoppedAt: undefined,
          autoRecoveryStopReason: undefined,
          autoRecoveryLastReason: `Baseline repair task ${repairTask.id} integrated`,
          finalizeRepairStoppedAt: undefined,
          finalizeRepairStopReason: undefined,
          baselineQualityGate: {
            ...baseline,
            phase: 'baseline_repair_integrated',
            lastUpdatedAt: now,
            taskEnvRepair,
            stoppedAt: undefined,
            stopReason: undefined,
          },
          baselineRepair: task.baselineRepair
            ? {
                ...task.baselineRepair,
                updatedAt: now,
                status: 'integrated',
                message: worktreeApply.applied
                  ? `Baseline repair task ${repairTask.id} integrated and applied to task worktree`
                  : `Baseline repair task ${repairTask.id} integrated`,
                appliedRepairCommitSha: worktreeApply.commitSha,
                appliedRepairFiles: worktreeApply.files,
                appliedToWorktreeAt: worktreeApply.applied ? now : undefined,
                applySkippedReason: worktreeApply.applied ? undefined : worktreeApply.message,
              }
            : undefined,
        });
        appendTaskEvent(task, {
          type: 'baseline_quality_gate_recovered',
          status: 'ready_to_finalize',
          message: worktreeApply.applied
            ? `Baseline repair task ${repairTask.id} integrated and applied to task worktree; finalization can retry`
            : `Baseline repair task ${repairTask.id} integrated; finalization can retry`,
          data: {
            repairTaskId: repairTask.id,
            commitSha: worktreeApply.commitSha,
            files: worktreeApply.files,
          },
        });
        this.logger.log(`Task ${task.id} recovered after baseline repair task ${repairTask.id}`);
        continue;
      }

      if (repairRecovering) {
        await this.stateManager.updateTask(task.id, {
          autoRecoveryKind: 'baseline_repair',
          autoRecoveryStoppedAt: undefined,
          autoRecoveryStopReason: undefined,
          autoRecoveryLastReason: `Waiting for baseline repair task ${repairTask.id} auto-recovery`,
          baselineQualityGate: {
            ...baseline,
            phase: 'waiting_for_baseline_repair',
            lastUpdatedAt: now,
            stoppedAt: undefined,
            stopReason: undefined,
          },
          baselineRepair: task.baselineRepair
            ? {
                ...task.baselineRepair,
                updatedAt: now,
                status: 'waiting',
                message: `Waiting for baseline repair task ${repairTask.id} auto-recovery`,
              }
            : undefined,
        });
        appendTaskEvent(task, {
          type: 'baseline_repair_waiting',
          status: task.status,
          message: `Waiting for baseline repair task ${repairTask.id} auto-recovery`,
          data: {
            repairTaskId: repairTask.id,
            repairStatus: repairTask.status,
            repairAutoRecoveryKind: repairTask.autoRecoveryKind,
          },
        });
        this.logger.log(`Task ${task.id} waiting for baseline repair task ${repairTask.id} auto-recovery`);
        continue;
      }

      if (repairFailed) {
        await this.stateManager.updateTask(task.id, {
          autoRecoveryStoppedAt: now,
          autoRecoveryStopReason: 'baseline_repair_failed',
          autoRecoveryLastReason: `Baseline repair task ${repairTask.id} is ${repairTask.status}`,
          baselineQualityGate: {
            ...baseline,
            phase: 'stopped',
            lastUpdatedAt: now,
            stoppedAt: now,
            stopReason: 'baseline_repair_failed',
          },
          baselineRepair: task.baselineRepair
            ? {
                ...task.baselineRepair,
                updatedAt: now,
                status: 'failed',
                message: `Baseline repair task ${repairTask.id} is ${repairTask.status}`,
              }
            : undefined,
        });
        appendTaskEvent(task, {
          type: 'baseline_repair_failed',
          status: 'failed_finalize',
          message: `Baseline repair task ${repairTask.id} is ${repairTask.status}`,
          data: {
            repairTaskId: repairTask.id,
            repairStatus: repairTask.status,
          },
        });
        this.logger.log(`Task ${task.id} baseline repair task ${repairTask.id} failed`);
      }
    }
  }

  async recoverFailedFinalizeTasks(): Promise<void> {
    const repairConfig = resolveFinalizeRepairConfig(this.configManager);
    const transientConfig = resolveTransientRecoveryConfig(this.configManager);
    const integrationPolicy = resolveIntegrationPolicy(this.configManager);
    const targetBranch = resolveMergeTargetBranch(this.configManager.get('merge.targetBranch'));
    const failedFinalizeTasks = (await this.stateManager.listTasks('failed_finalize'))
      .slice()
      .sort((a: Task, b: Task) => a.startTime - b.startTime);

    for (const task of failedFinalizeTasks) {
      let activeTask = await this.refreshFailedFinalizeFailureState(task);
      const mergeConflict = hasMergeConflict(activeTask);
      let backfilledFinalizeRepairState = false;

      if (
        !activeTask.finalizeRepairStartedAt
        || !activeTask.finalizeRepairDeadlineAt
        || !activeTask.finalizeRepairLastFailureSnapshot
      ) {
        backfilledFinalizeRepairState = true;
        const backfilledRepairState = evaluateFinalizeRepairFailure({
          ...activeTask,
          lastError: activeTask.lastError || activeTask.mergeError,
          mergeError: activeTask.mergeError || activeTask.lastError,
        }, repairConfig);
        const normalizedLastProgressAt = activeTask.finalizeRepairLastProgressAt
          ?? backfilledRepairState.lastProgressAt;
        const normalizedLastProgressReason = activeTask.finalizeRepairLastProgressReason
          ?? backfilledRepairState.lastProgressReason;
        const normalizedConsecutiveNoProgress = activeTask.finalizeRepairConsecutiveNoProgress
          ?? backfilledRepairState.consecutiveNoProgress;
        await this.stateManager.updateTask(activeTask.id, {
          finalizeRepairStartedAt: backfilledRepairState.startedAt,
          finalizeRepairDeadlineAt: backfilledRepairState.deadlineAt,
          finalizeRepairLastFailureSnapshot: backfilledRepairState.snapshot,
          finalizeRepairLastProgressAt: normalizedLastProgressAt,
          finalizeRepairLastProgressReason: normalizedLastProgressReason,
          finalizeRepairConsecutiveNoProgress: normalizedConsecutiveNoProgress,
          finalizeRepairTotalRequeues: activeTask.finalizeRepairTotalRequeues ?? 0,
        });
        appendTaskEvent(activeTask, {
          type: 'finalize_repair_state_backfilled',
          status: 'failed_finalize',
          message: 'Backfilled finalize repair state for legacy failed_finalize task',
          data: {
            repairPolicy: repairConfig.repairPolicy,
            consecutiveNoProgress: normalizedConsecutiveNoProgress,
            deadlineAt: backfilledRepairState.deadlineAt,
            progressReason: normalizedLastProgressReason,
          },
        });
        activeTask = {
          ...activeTask,
          finalizeRepairStartedAt: backfilledRepairState.startedAt,
          finalizeRepairDeadlineAt: backfilledRepairState.deadlineAt,
          finalizeRepairLastFailureSnapshot: backfilledRepairState.snapshot,
          finalizeRepairLastProgressAt: normalizedLastProgressAt,
          finalizeRepairLastProgressReason: normalizedLastProgressReason,
          finalizeRepairConsecutiveNoProgress: normalizedConsecutiveNoProgress,
          finalizeRepairTotalRequeues: activeTask.finalizeRepairTotalRequeues ?? 0,
        };
      }

      if (shouldDeferFailedFinalizeToCurrentBaselineGate(activeTask)) {
        continue;
      }

      if (
        !activeTask.baselineQualityGate
        && activeTask.lastErrorKind === 'quality_gate_failure'
        && activeTask.finalizerFailure
        && this.configManager.get('runner.autoClassifyBaselineQualityGateFailures') !== false
      ) {
        await this.classifyBaselineQualityGateFailures();
        const latestTask = await this.stateManager.loadTask(activeTask.id);
        activeTask = latestTask ?? activeTask;

        if (shouldDeferFailedFinalizeToCurrentBaselineGate(activeTask)) {
          this.logger.log(`Task ${activeTask.id} blocked by baseline quality gate classification`);
          continue;
        }
      }

      const repairStoryId = selectFinalizeRepairStoryId(activeTask, mergeConflict);
      const transientFinalizeFailure = !mergeConflict && !activeTask.finalizerFailure
        ? resolveRetryableTransientFailure(activeTask)
        : undefined;

      if (transientFinalizeFailure) {
        const now = Date.now();
        const startedAt = activeTask.transientRecoveryStartedAt ?? now;
        const deadlineAt = activeTask.transientRecoveryDeadlineAt
          ?? startedAt + (transientConfig.transientRecoveryDeadlineSeconds * 1000);
        const currentTotalRequeues = activeTask.transientRecoveryTotalRequeues ?? 0;
        const nextEligibleAt = activeTask.transientRecoveryNextEligibleAt;

        if (now > deadlineAt) {
          await this.stateManager.updateTask(activeTask.id, {
            ...transientFinalizeFailure.backfill,
            transientRecoveryStartedAt: startedAt,
            transientRecoveryDeadlineAt: deadlineAt,
            transientRecoveryStoppedAt: now,
            transientRecoveryStopReason: 'transient_deadline_exhausted',
            autoRecoveryKind: 'transient',
            autoRecoveryStoppedAt: now,
            autoRecoveryStopReason: 'transient_deadline_exhausted',
            autoRecoveryLastReason: 'Transient finalizer retry deadline exhausted',
          });
          appendTaskEvent(activeTask, {
            type: 'transient_finalizer_retry_stopped',
            status: 'failed_finalize',
            message: 'Transient finalizer retry deadline exhausted',
            data: {
              failureKind: transientFinalizeFailure.kind,
              failureClass: transientFinalizeFailure.class,
              failureSignature: transientFinalizeFailure.signature,
              deadlineAt,
            },
          });
          continue;
        }

        if (currentTotalRequeues >= transientConfig.maxTransientRecoveryRequeues) {
          await this.stateManager.updateTask(activeTask.id, {
            ...transientFinalizeFailure.backfill,
            transientRecoveryStartedAt: startedAt,
            transientRecoveryDeadlineAt: deadlineAt,
            transientRecoveryStoppedAt: now,
            transientRecoveryStopReason: 'transient_budget_exhausted',
            autoRecoveryKind: 'transient',
            autoRecoveryStoppedAt: now,
            autoRecoveryStopReason: 'transient_budget_exhausted',
            autoRecoveryLastReason: 'Transient finalizer retry budget exhausted',
          });
          appendTaskEvent(activeTask, {
            type: 'transient_finalizer_retry_stopped',
            status: 'failed_finalize',
            message: 'Transient finalizer retry budget exhausted',
            data: {
              failureKind: transientFinalizeFailure.kind,
              failureClass: transientFinalizeFailure.class,
              failureSignature: transientFinalizeFailure.signature,
              totalRequeues: currentTotalRequeues,
            },
          });
          continue;
        }

        if (nextEligibleAt && nextEligibleAt > now) {
          continue;
        }

        if (!nextEligibleAt) {
          const delayMs = resolveTransientRecoveryDelayMs(currentTotalRequeues + 1, transientConfig);
          const scheduledAt = now + delayMs;
          await this.stateManager.updateTask(activeTask.id, {
            ...transientFinalizeFailure.backfill,
            transientRecoveryStartedAt: startedAt,
            transientRecoveryDeadlineAt: deadlineAt,
            transientRecoveryLastFailureKind: transientFinalizeFailure.kind,
            transientRecoveryLastFailureClass: transientFinalizeFailure.class,
            transientRecoveryLastFailureSignature: transientFinalizeFailure.signature,
            transientRecoveryLastFailureObservedAt: activeTask.lastErrorObservedAt ?? now,
            transientRecoveryLastFailureStoryId: repairStoryId,
            transientRecoveryLastProgressReason: 'finalizer transient failure',
            transientRecoveryLastDelayMs: delayMs,
            transientRecoveryNextEligibleAt: scheduledAt,
            transientRecoveryStoppedAt: undefined,
            transientRecoveryStopReason: undefined,
            autoRecoveryKind: 'transient',
            autoRecoveryHardCap: transientConfig.autoRecoveryHardCap,
            autoRecoveryNextEligibleAt: scheduledAt,
            autoRecoveryStoppedAt: undefined,
            autoRecoveryStopReason: undefined,
            autoRecoveryLastReason: `Scheduled transient finalizer retry for ${transientFinalizeFailure.kind}`,
            repairContext: undefined,
            finalizerFailure: undefined,
          });
          appendTaskEvent(activeTask, {
            type: 'transient_finalizer_retry_scheduled',
            status: 'failed_finalize',
            message: `Scheduled transient finalizer retry after ${transientFinalizeFailure.kind}`,
            data: {
              failureKind: transientFinalizeFailure.kind,
              failureClass: transientFinalizeFailure.class,
              failureSignature: transientFinalizeFailure.signature,
              delayMs,
              nextEligibleAt: scheduledAt,
            },
          });
          continue;
        }

        const nextTotalRequeues = currentTotalRequeues + 1;
        await this.stateManager.updateTask(activeTask.id, {
          status: 'ready_to_finalize',
          endTime: undefined,
          currentUS: undefined,
          pid: undefined,
          leaseOwner: undefined,
          leaseHeartbeatAt: undefined,
          leaseExpiresAt: undefined,
          repairContext: undefined,
          finalizerFailure: undefined,
          finalizerAttempts: activeTask.finalizerAttempts,
          transientRetryCount: 0,
          transientRetryBudget: undefined,
          transientRetryLastDelayMs: undefined,
          transientRecoveryTotalRequeues: nextTotalRequeues,
          transientRecoveryNextEligibleAt: undefined,
          transientRecoveryStoppedAt: undefined,
          transientRecoveryStopReason: undefined,
          transientRecoveryLastRequeuedStoryId: repairStoryId,
          autoRecoveryKind: 'transient',
          autoRecoveryTotalRequeues: (activeTask.autoRecoveryTotalRequeues ?? 0) + 1,
          autoRecoveryNextEligibleAt: undefined,
          autoRecoveryStoppedAt: undefined,
          autoRecoveryStopReason: undefined,
          autoRecoveryLastReason: `Retrying finalizer after ${transientFinalizeFailure.kind}`,
        });
        appendTaskEvent(activeTask, {
          type: 'transient_finalizer_retry_ready',
          status: 'ready_to_finalize',
          message: `Retrying finalizer after ${transientFinalizeFailure.kind}`,
          data: {
            failureKind: transientFinalizeFailure.kind,
            failureClass: transientFinalizeFailure.class,
            failureSignature: transientFinalizeFailure.signature,
            totalRequeues: nextTotalRequeues,
          },
        });
        continue;
      }

      let mergeProbeResult: Awaited<ReturnType<typeof probeTaskWorktreeMergeability>> | undefined;

      if (mergeConflict) {
        try {
          mergeProbeResult = await this.probeWorktreeMergeability(activeTask, targetBranch, {
            pullLatest: integrationPolicy.pullLatest,
            integrationWorktreeDir: integrationPolicy.integrationWorktreeDir,
            syncTargetBranch: false,
          });
        } catch (error) {
          this.logger.error(
            `Exact mergeability probe failed for ${activeTask.id}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      if (mergeConflict && mergeProbeResult) {
        const shouldRefreshConflictState = mergeProbeResult.alreadyIntegrated
          || mergeProbeResult.mergeable
          || mergeProbeResult.message !== activeTask.mergeError
          || JSON.stringify(mergeProbeResult.conflictFiles || []) !== JSON.stringify(activeTask.mergeConflictFiles || [])
          || mergeProbeResult.integrationBranch !== activeTask.integrationBranch
          || mergeProbeResult.integrationWorktree !== activeTask.integrationWorktree;

        if (shouldRefreshConflictState) {
          const refreshedConflictState = {
            mergeError: mergeProbeResult.mergeable ? undefined : mergeProbeResult.message,
            mergeConflictFiles: mergeProbeResult.mergeable ? undefined : mergeProbeResult.conflictFiles,
            mergeConflictAt: mergeProbeResult.mergeable ? undefined : Date.now(),
            integrationBranch: mergeProbeResult.integrationBranch,
            integrationWorktree: mergeProbeResult.integrationWorktree,
            mergeRepairDisplayStatus: deriveMergeRepairDisplayStatus(mergeProbeResult),
            mergeRepairProof: buildMergeRepairProof(mergeProbeResult),
          };
          await this.stateManager.updateTask(activeTask.id, refreshedConflictState);
          activeTask = {
            ...activeTask,
            ...refreshedConflictState,
          };
        }
      }

      if (
        mergeConflict
        && (
          mergeProbeResult?.alreadyIntegrated
          || mergeProbeResult?.mergeable
          || this.detectAlreadyIntegratedTask(activeTask, targetBranch)
        )
      ) {
        const updatedAt = Date.now();
        const completedUS = repairStoryId && !activeTask.completedUS.includes(repairStoryId)
          ? [...activeTask.completedUS, repairStoryId]
          : activeTask.completedUS;
        const recoveryMessage = mergeProbeResult?.alreadyIntegrated
          ? `Recovered finalize conflict because ${resolveTaskBranchName(activeTask)} is already integrated in ${resolveTaskIntegrationBranch(activeTask, targetBranch)}`
          : mergeProbeResult?.mergeable
            ? isResolvedPendingMergeProof(mergeProbeResult)
              ? `Recovered finalize conflict because the task worktree is a resolved pending merge awaiting finalizer commit against ${resolveTaskIntegrationBranch(activeTask, targetBranch)}`
              : `Recovered finalize conflict because exact worktree mergeability probe passed against ${resolveTaskIntegrationBranch(activeTask, targetBranch)}`
            : `Recovered finalize conflict because ${resolveTaskBranchName(activeTask)} is already integrated in ${resolveTaskIntegrationBranch(activeTask, targetBranch)}`;
        const storyProgress = repairStoryId
          ? (activeTask.storyProgress || []).map((story) => story.id === repairStoryId
            ? {
                ...story,
                status: 'passed' as const,
                lastError: undefined,
                updatedAt,
                history: [
                  ...(story.history || []),
                  {
                    attempt: story.attempts,
                    status: 'passed' as const,
                    message: recoveryMessage,
                    updatedAt,
                  },
                ],
              }
            : story)
          : task.storyProgress;

        const storyCompletion = evaluateTaskStoryCompletion({
          ...activeTask,
          completedUS,
          storyProgress,
        });
        if (!storyCompletion.allStoriesPassed) {
          const message = formatStoryCompletionInvariantMessage(activeTask.id, 'finalize', storyCompletion);
          await this.stateManager.updateTask(task.id, {
            status: 'failed',
            completedUS,
            storyProgress,
            currentUS: undefined,
            pid: undefined,
            endTime: updatedAt,
            leaseOwner: undefined,
            leaseHeartbeatAt: undefined,
            leaseExpiresAt: undefined,
            finalizerFailure: undefined,
            repairContext: undefined,
            postFinalizeMergeProbeRequired: undefined,
            finalizeRepairStartedAt: undefined,
            finalizeRepairDeadlineAt: undefined,
            finalizeRepairLastFailureSnapshot: undefined,
            finalizeRepairLastProgressAt: undefined,
            finalizeRepairLastProgressReason: undefined,
            finalizeRepairConsecutiveNoProgress: 0,
            finalizeRepairStoppedAt: updatedAt,
            finalizeRepairStopReason: 'story_incomplete',
            mergeRepairDisplayStatus: undefined,
            mergeRepairProof: undefined,
            ...buildStoryCompletionInvariantFailureUpdates(message, updatedAt),
          });
          appendTaskEvent(activeTask, {
            type: 'story_completion_invariant_failed',
            status: 'failed',
            storyId: repairStoryId,
            message,
            data: {
              phase: 'finalize',
              finalizerAttempts: activeTask.finalizerAttempts,
              mergeRepairAttempts: activeTask.mergeRepairAttempts,
              incompleteStories: storyCompletion.incompleteStories,
              exactProbeMessage: mergeProbeResult?.message,
            },
          });
          this.logger.error(`Refused failed-finalize recovery for incomplete task ${activeTask.id}: ${message}`);
          continue;
        }

        await this.stateManager.updateTask(task.id, {
          status: 'ready_to_finalize',
          completedUS,
          storyProgress,
          currentUS: undefined,
          pid: undefined,
          endTime: undefined,
          leaseOwner: undefined,
          leaseHeartbeatAt: undefined,
          leaseExpiresAt: undefined,
          lastError: undefined,
          mergeError: undefined,
          mergeConflictFiles: undefined,
          mergeConflictPhase: undefined,
          mergeConflictAt: undefined,
          finalizerFailure: undefined,
          repairContext: undefined,
          postFinalizeMergeProbeRequired: true,
          finalizeRepairStartedAt: undefined,
          finalizeRepairDeadlineAt: undefined,
          finalizeRepairLastFailureSnapshot: undefined,
          finalizeRepairLastProgressAt: undefined,
          finalizeRepairLastProgressReason: undefined,
          finalizeRepairConsecutiveNoProgress: 0,
          finalizeRepairStoppedAt: undefined,
          finalizeRepairStopReason: undefined,
          mergeRepairDisplayStatus: mergeProbeResult
            ? deriveMergeRepairDisplayStatus(mergeProbeResult)
            : activeTask.mergeRepairDisplayStatus,
          mergeRepairProof: mergeProbeResult
            ? buildMergeRepairProof(mergeProbeResult)
            : activeTask.mergeRepairProof,
        });
        appendTaskEvent(activeTask, {
          type: 'task_recovered_failed_finalize',
          status: 'ready_to_finalize',
          storyId: repairStoryId,
          message: recoveryMessage,
          data: {
            finalizerAttempts: activeTask.finalizerAttempts,
            mergeRepairAttempts: activeTask.mergeRepairAttempts,
            repairPolicy: repairConfig.repairPolicy,
            conflictFiles: activeTask.mergeConflictFiles,
            exactProbeMessage: mergeProbeResult?.message,
          },
        });
        this.logger.log(`Task ${activeTask.id} recovered into ready_to_finalize after mergeability recovery`);
        continue;
      }

      if (!repairStoryId) {
        continue;
      }

      const windowRefreshAt = Date.now();
      if (
        !backfilledFinalizeRepairState
        && shouldRefreshExpiredFinalizeRepairWindow(activeTask, repairConfig, windowRefreshAt)
      ) {
        const refreshedRepairWindow = {
          finalizeRepairStartedAt: windowRefreshAt,
          finalizeRepairDeadlineAt: windowRefreshAt + (repairConfig.repairDeadlineSeconds * 1000),
          finalizeRepairLastProgressAt: windowRefreshAt,
          finalizeRepairLastProgressReason: 'Opened fresh finalize repair window for new post-deadline finalizer failure',
          finalizeRepairConsecutiveNoProgress: 0,
          finalizeRepairStoppedAt: undefined,
          finalizeRepairStopReason: undefined,
        };
        await this.stateManager.updateTask(activeTask.id, refreshedRepairWindow);
        appendTaskEvent(activeTask, {
          type: 'finalize_repair_window_refreshed',
          status: 'failed_finalize',
          storyId: repairStoryId,
          message: refreshedRepairWindow.finalizeRepairLastProgressReason,
          data: {
            previousDeadlineAt: activeTask.finalizeRepairDeadlineAt,
            latestFailureCapturedAt: activeTask.finalizeRepairLastFailureSnapshot?.capturedAt,
            nextDeadlineAt: refreshedRepairWindow.finalizeRepairDeadlineAt,
          },
        });
        activeTask = {
          ...activeTask,
          ...refreshedRepairWindow,
        };
      }

      const repairStory = activeTask.storyProgress?.find((story) => story.id === repairStoryId);
      const hasUnrunMergeRepair = Boolean(
        mergeConflict
        && repairStory?.status === 'needs_repair'
        && !activeTask.completedUS.includes(repairStoryId)
      );
      const decision = decideFinalizeRepairRequeue({
        task: activeTask,
        config: repairConfig,
        mergeConflict,
        hasUnrunMergeRepair,
      });

      if (!decision.shouldRequeue) {
        if (decision.stopReason && !activeTask.finalizeRepairStoppedAt) {
          const stoppedAt = Date.now();
          await this.stateManager.updateTask(activeTask.id, {
            finalizeRepairStoppedAt: stoppedAt,
            finalizeRepairStopReason: decision.stopReason,
          });
          appendTaskEvent(activeTask, {
            type: 'finalize_repair_stopped',
            status: 'failed_finalize',
            storyId: repairStoryId,
            message: decision.reason,
            data: {
              repairPolicy: repairConfig.repairPolicy,
              stopReason: decision.stopReason,
              consecutiveNoProgress: activeTask.finalizeRepairConsecutiveNoProgress,
              totalRequeues: activeTask.finalizeRepairTotalRequeues,
              deadlineAt: activeTask.finalizeRepairDeadlineAt,
              conflictFiles: activeTask.mergeConflictFiles,
            },
          });
          this.logger.log(`Task ${activeTask.id} stopped finalize repair recovery (${decision.reason})`);
        }
        continue;
      }

      const updatedAt = Date.now();
      const repairMessage = mergeConflict
        ? buildMergeRepairReason(activeTask)
        : activeTask.lastError || activeTask.mergeError || 'Finalizer failed; repair required';
      const repairContext = buildTaskRepairContext({
        storyId: repairStoryId,
        mode: mergeConflict ? 'merge' : 'finalize',
        reason: repairMessage,
        createdAt: updatedAt,
      });
      const completedUS = activeTask.completedUS.filter((storyId) => storyId !== repairStoryId);
      const storyProgress = (activeTask.storyProgress || []).map((story) => story.id === repairStoryId
        ? {
            ...story,
            status: 'needs_repair' as const,
            attempts: 0,
            lastError: repairMessage,
            updatedAt,
            history: [
              ...(story.history || []),
              {
                attempt: story.attempts,
                status: 'needs_repair' as const,
                message: repairMessage,
                updatedAt,
              },
            ],
          }
        : story);
      const nextMergeRepairAttempts = mergeConflict
        ? (hasUnrunMergeRepair ? (activeTask.mergeRepairAttempts ?? 0) : (activeTask.mergeRepairAttempts ?? 0) + 1)
        : undefined;
      const nextTotalRequeues = repairConfig.repairPolicy === 'progress'
        ? (activeTask.finalizeRepairTotalRequeues ?? 0) + 1
        : activeTask.finalizeRepairTotalRequeues;

        await this.stateManager.updateTask(activeTask.id, {
          status: 'pending',
          completedUS,
        storyProgress,
        currentUS: undefined,
        pid: undefined,
        endTime: undefined,
        repairContext,
          leaseOwner: undefined,
          leaseHeartbeatAt: undefined,
          leaseExpiresAt: undefined,
          postFinalizeMergeProbeRequired: mergeConflict
            ? true
            : activeTask.postFinalizeMergeProbeRequired,
          mergeRepairDisplayStatus: mergeConflict ? 'requeued' : activeTask.mergeRepairDisplayStatus,
          mergeRepairProof: mergeProbeResult
            ? buildMergeRepairProof(mergeProbeResult, updatedAt)
            : activeTask.mergeRepairProof,
          ...(mergeConflict ? { mergeRepairAttempts: nextMergeRepairAttempts } : {}),
          ...(repairConfig.repairPolicy === 'progress'
            ? {
              finalizeRepairTotalRequeues: nextTotalRequeues,
              finalizeRepairStoppedAt: undefined,
              finalizeRepairStopReason: undefined,
            }
          : {}),
          autoRecoveryKind: mergeConflict ? 'merge_repair' : 'finalize_repair',
          autoRecoveryTotalRequeues: (activeTask.autoRecoveryTotalRequeues ?? 0) + 1,
          autoRecoveryHardCap: mergeConflict
            ? Math.max(repairConfig.maxRepairAttempts, 1)
            : repairConfig.repairHardCap,
          autoRecoveryLastRequeuedAt: updatedAt,
          autoRecoveryNextEligibleAt: undefined,
          autoRecoveryStoppedAt: undefined,
          autoRecoveryStopReason: undefined,
          autoRecoveryLastReason: mergeConflict
            ? `Returned ${repairStoryId} to merge repair after conflict`
            : `Returned ${repairStoryId} to repair after failed finalizer attempt`,
      });
      appendTaskEvent(activeTask, {
        type: mergeConflict ? 'merge_repair_started' : 'task_recovered_failed_finalize',
        status: 'pending',
        storyId: repairStoryId,
        message: mergeConflict && hasUnrunMergeRepair
          ? `Requeued unrun merge repair for ${repairStoryId}`
          : mergeConflict
          ? `Returned ${repairStoryId} to merge repair after conflict`
          : `Returned ${repairStoryId} to repair after failed finalizer attempt`,
        data: {
          repairMode: repairContext.mode,
          finalizerAttempts: task.finalizerAttempts,
          mergeRepairAttempts: nextMergeRepairAttempts,
          repairPolicy: repairConfig.repairPolicy,
          repairLimit: repairConfig.maxRepairAttempts,
          maxNoProgressRepairRounds: repairConfig.maxNoProgressRepairRounds,
          repairHardCap: repairConfig.repairHardCap,
          totalRequeues: nextTotalRequeues,
          consecutiveNoProgress: task.finalizeRepairConsecutiveNoProgress,
          deadlineAt: task.finalizeRepairDeadlineAt,
          progressReason: decision.reason,
          conflictFiles: task.mergeConflictFiles,
        },
      });
      this.logger.log(mergeConflict
        ? `Task ${activeTask.id} returned to pending merge repair for ${repairStoryId}`
        : `Task ${activeTask.id} returned to pending repair for ${repairStoryId}`);
    }
  }

  async recoverCompletedConflictTasks(): Promise<void> {
    const integrationPolicy = resolveIntegrationPolicy(this.configManager);
    const targetBranch = resolveMergeTargetBranch(this.configManager.get('merge.targetBranch'));
    const completedConflictTasks = (await this.stateManager.listTasks('completed'))
      .filter((task) => resolveTaskIntegrationStatus(task) === 'blocked_conflict' && hasMergeConflict(task))
      .slice()
      .sort((a: Task, b: Task) => a.startTime - b.startTime);

    for (const task of completedConflictTasks) {
      const integrationLane = resolveTaskIntegrationLane(task, targetBranch);

      await withIntegrationLaneLock(task.repoPath, integrationLane, async () => {
        const latestTask = await this.stateManager.loadTask(task.id);
        if (!latestTask || latestTask.status !== 'completed') {
          return;
        }

        if (resolveTaskIntegrationStatus(latestTask) !== 'blocked_conflict' || !hasMergeConflict(latestTask)) {
          return;
        }

        let mergeProbeResult: Awaited<ReturnType<typeof probeTaskWorktreeMergeability>> | undefined;

        try {
          mergeProbeResult = await this.probeWorktreeMergeability(latestTask, targetBranch, {
            pullLatest: integrationPolicy.pullLatest,
            integrationWorktreeDir: integrationPolicy.integrationWorktreeDir,
            syncTargetBranch: false,
          });
        } catch (error) {
          this.logger.error(
            `Exact mergeability probe failed for completed blocked_conflict task ${latestTask.id}: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        if (mergeProbeResult?.alreadyIntegrated) {
          const storyCompletion = evaluateTaskStoryCompletion(latestTask);
          if (!storyCompletion.allStoriesPassed) {
            const message = formatStoryCompletionInvariantMessage(latestTask.id, 'integrate', storyCompletion);
            await this.stateManager.updateTask(task.id, {
              ...buildStoryCompletionInvariantFailureUpdates(message),
            });
            appendTaskEvent(latestTask, {
              type: 'merge_failed',
              status: 'completed',
              message,
            });
            this.logger.error(`Refused blocked-conflict integration recovery for incomplete task ${latestTask.id}: ${message}`);
            return;
          }

          const recoveredAt = Date.now();
          const message = `Recovered blocked integration conflict because ${resolveTaskBranchName(latestTask)} is already integrated in ${resolveTaskIntegrationBranch(latestTask, targetBranch)}`;

          await this.stateManager.updateTask(task.id, {
            integratedAt: recoveredAt,
            integrationStatus: 'integrated',
            mergeError: undefined,
            mergeConflictFiles: undefined,
            mergeConflictPhase: undefined,
            mergeConflictAt: undefined,
            postFinalizeMergeProbeRequired: undefined,
            integrationBranch: mergeProbeResult.integrationBranch,
            integrationWorktree: mergeProbeResult.integrationWorktree,
            coordinationStatus: undefined,
            coordinationPhase: undefined,
            coordinationBlockers: undefined,
            coordinationReason: undefined,
            mergeRepairDisplayStatus: undefined,
            mergeRepairProof: undefined,
          });
          appendTaskEvent(latestTask, {
            type: 'task_recovered_failed_finalize',
            status: 'completed',
            message,
            data: {
              exactProbeMessage: mergeProbeResult.message,
              conflictFiles: latestTask.mergeConflictFiles,
            },
          });
          this.logger.log(`Task ${latestTask.id} marked integrated after blocked_conflict recovery`);
          return;
        }

        if (mergeProbeResult?.mergeable) {
          const storyCompletion = evaluateTaskStoryCompletion(latestTask);
          if (!storyCompletion.allStoriesPassed) {
            const phase = mergeProbeResult.sourceKind === 'branch_head' ? 'integrate' : 'finalize';
            const message = formatStoryCompletionInvariantMessage(latestTask.id, phase, storyCompletion);
            await this.stateManager.updateTask(task.id, {
              status: 'failed',
              endTime: Date.now(),
              ...buildStoryCompletionInvariantFailureUpdates(message),
              mergeRepairDisplayStatus: undefined,
              mergeRepairProof: undefined,
              postFinalizeMergeProbeRequired: undefined,
            });
            appendTaskEvent(latestTask, {
              type: 'story_completion_invariant_failed',
              status: 'failed',
              message,
              data: {
                phase,
                exactProbeMessage: mergeProbeResult.message,
                incompleteStories: storyCompletion.incompleteStories,
              },
            });
            this.logger.error(`Refused blocked-conflict recovery for incomplete task ${latestTask.id}: ${message}`);
            return;
          }

          if (mergeProbeResult.sourceKind === 'branch_head') {
            const message = `Recovered blocked integration conflict because exact mergeability probe passed against ${resolveTaskIntegrationBranch(latestTask, targetBranch)}`;

            await this.stateManager.updateTask(task.id, {
              integratedAt: undefined,
              integrationStatus: 'not_started',
              integrationCommitSha: undefined,
              integrationBranch: undefined,
              integrationWorktree: undefined,
              mergedAt: undefined,
              mergeCommitSha: undefined,
              mergeMessage: undefined,
              mergeError: undefined,
              mergeConflictFiles: undefined,
              mergeConflictPhase: undefined,
              mergeConflictAt: undefined,
              postFinalizeMergeProbeRequired: undefined,
              targetSyncedAt: undefined,
              targetSyncStatus: 'not_requested',
              targetSyncDeferredReason: undefined,
              coordinationStatus: undefined,
              coordinationPhase: undefined,
              coordinationBlockers: undefined,
              coordinationReason: undefined,
              mergeRepairDisplayStatus: undefined,
              mergeRepairProof: undefined,
            });
            appendTaskEvent(latestTask, {
              type: 'task_recovered_failed_finalize',
              status: 'completed',
              message,
              data: {
                exactProbeMessage: mergeProbeResult.message,
                conflictFiles: latestTask.mergeConflictFiles,
              },
            });
            this.logger.log(`Task ${latestTask.id} cleared blocked_conflict after exact mergeability recovery`);
            return;
          }

          const readyMessage = isResolvedPendingMergeProof(mergeProbeResult)
            ? `Recovered blocked integration conflict because the task worktree is a resolved pending merge awaiting finalizer commit against ${resolveTaskIntegrationBranch(latestTask, targetBranch)}`
            : `Recovered blocked integration conflict because the task worktree now passes the exact mergeability probe against ${resolveTaskIntegrationBranch(latestTask, targetBranch)}`;

          await this.stateManager.updateTask(task.id, {
            status: 'ready_to_finalize',
            endTime: undefined,
            pid: undefined,
            currentUS: undefined,
            leaseOwner: undefined,
            leaseHeartbeatAt: undefined,
            leaseExpiresAt: undefined,
            lastError: undefined,
            lastErrorKind: undefined,
            lastErrorClass: undefined,
            lastErrorRetryable: undefined,
            lastErrorObservedAt: undefined,
            lastErrorSignature: undefined,
            lastErrorHadObjectiveProgress: undefined,
            mergeError: undefined,
            mergeConflictFiles: undefined,
            mergeConflictPhase: undefined,
            mergeConflictAt: undefined,
            postFinalizeMergeProbeRequired: true,
            repairContext: undefined,
            integrationBranch: mergeProbeResult.integrationBranch,
            integrationWorktree: mergeProbeResult.integrationWorktree,
            mergeRepairDisplayStatus: deriveMergeRepairDisplayStatus(mergeProbeResult),
            mergeRepairProof: buildMergeRepairProof(mergeProbeResult),
          });
          appendTaskEvent(latestTask, {
            type: 'task_recovered_failed_finalize',
            status: 'ready_to_finalize',
            message: readyMessage,
            data: {
              exactProbeMessage: mergeProbeResult.message,
              conflictFiles: latestTask.mergeConflictFiles,
            },
          });
          this.logger.log(`Task ${latestTask.id} recovered into ready_to_finalize from completed blocked_conflict`);
          return;
        }

        const repairStoryId = selectFinalizeRepairStoryId(latestTask, true);
        if (!repairStoryId) {
          return;
        }

        const repairReset = buildCompletedConflictRepairReset(latestTask, repairStoryId);

        await this.stateManager.updateTask(task.id, {
          status: 'pending',
          endTime: undefined,
          pid: undefined,
          currentUS: undefined,
          completedUS: repairReset.completedUS,
          storyProgress: repairReset.storyProgress,
          leaseOwner: undefined,
          leaseHeartbeatAt: undefined,
          leaseExpiresAt: undefined,
          loopCount: 0,
          consecutiveNoProgress: 0,
          consecutiveErrors: 0,
          lastProgressTime: repairReset.updatedAt,
          lastError: undefined,
          lastErrorKind: undefined,
          lastErrorClass: undefined,
          lastErrorRetryable: undefined,
          lastErrorObservedAt: undefined,
          lastErrorSignature: undefined,
          lastErrorHadObjectiveProgress: undefined,
          transientRetryCount: 0,
          transientRetryBudget: undefined,
          transientRetryLastDelayMs: undefined,
          ...buildFinalizeRetryReset(),
          postFinalizeMergeProbeRequired: true,
          repairContext: repairReset.repairContext,
          mergeRepairDisplayStatus: 'requeued',
          mergeRepairProof: mergeProbeResult
            ? buildMergeRepairProof(mergeProbeResult)
            : latestTask.mergeRepairProof,
        });
        appendTaskEvent(latestTask, {
          type: 'merge_repair_started',
          status: 'pending',
          storyId: repairStoryId,
          message: `Returned ${repairStoryId} to merge repair after completed delivery conflict`,
          data: {
            repairMode: 'merge',
            exactProbeMessage: mergeProbeResult?.message,
            conflictFiles: mergeProbeResult?.conflictFiles || latestTask.mergeConflictFiles,
          },
        });
        this.logger.log(`Task ${latestTask.id} returned to pending merge repair from completed blocked_conflict`);
      });
    }
  }

  private async autoMergeTaskIfEnabled(task: Task): Promise<Partial<Task>> {
    const policy = resolveIntegrationPolicy(this.configManager);
    if (!shouldAttemptAutomaticIntegration(policy)) {
      return {};
    }

    const targetBranch = policy.targetBranch;
    const strategy = policy.strategy;
    const storyCompletion = evaluateTaskStoryCompletion(task);
    if (!storyCompletion.allStoriesPassed) {
      throw new Error(formatStoryCompletionInvariantMessage(task.id, 'integrate', storyCompletion));
    }

    if (
      isDestructiveMergeStrategy(strategy)
      && !policy.allowDestructiveAutoResolve
    ) {
      throw new Error(formatDestructiveAutoResolveError(strategy));
    }

    const delayMs = policy.publishTargetBranch
      ? resolveAutoMergeDelayMs(this.configManager.get('autoMergeDelay'))
      : 0;
    if (delayMs > 0) {
      this.logger.log(`Task ${task.id} waiting ${delayMs}ms before auto-merge`);
      await this.sleep(delayMs);
    }

    this.logger.log(`Task ${task.id} auto-merging into ${targetBranch} (${strategy})`);
    appendTaskEvent(task, {
      type: 'merge_started',
      message: `Merging into ${targetBranch} (${strategy})`,
      data: { targetBranch, strategy },
    });
    const result = await this.mergeTask(task, targetBranch, strategy, {
      pullLatest: policy.pullLatest,
      useIntegrationWorktree: policy.useIntegrationWorktree,
      integrationWorktreeDir: policy.integrationWorktreeDir,
      syncTargetBranch: policy.syncTargetBranch,
    });

    if (!result.success) {
      const failureUpdates = buildMergeFailureUpdates(result, targetBranch, strategy);
      appendTaskEvent(task, {
        type: 'merge_failed',
        message: result.message,
        data: {
          targetBranch,
          strategy,
          hasConflicts: result.hasConflicts,
          conflictFiles: result.conflictFiles,
        },
      });
      throw createMergeFailureError(result, failureUpdates);
    }

    appendTaskEvent(task, {
      type: 'merge_completed',
      message: result.message,
      data: { targetBranch, strategy, commitSha: result.commitSha },
    });

    return buildSuccessfulMergeTaskUpdates(
      result,
      targetBranch,
      strategy,
    );
  }

  private async markCompletedTaskIntegrationFailure(
    task: Task,
    failureUpdates: Partial<Task>,
    message: string,
    strategy: MergeStrategy,
    targetBranch: string,
    hasConflicts: boolean,
  ): Promise<void> {
    await this.stateManager.updateTask(task.id, failureUpdates);
    appendTaskEvent(task, {
      type: 'merge_failed',
      message,
      data: {
        targetBranch,
        strategy,
        hasConflicts,
        conflictFiles: failureUpdates.mergeConflictFiles,
      },
    });
    this.logger.error(`Failed to integrate completed task ${task.id}: ${message}`);
  }

  private buildGenericIntegrationFailureUpdates(
    targetBranch: string,
    strategy: MergeStrategy,
    message: string,
  ): Partial<Task> {
    return {
      mergeTargetBranch: targetBranch,
      mergeStrategy: strategy,
      mergeMessage: undefined,
      mergeError: message,
      mergeConflictFiles: undefined,
      mergeConflictPhase: undefined,
      mergeConflictAt: undefined,
      integrationStatus: 'failed',
      targetSyncStatus: 'not_requested',
      targetSyncDeferredReason: undefined,
      coordinationStatus: undefined,
      coordinationPhase: undefined,
      coordinationBlockers: undefined,
      coordinationReason: undefined,
    };
  }

  private isCommitReachableFromTarget(repoPath: string, targetBranch: string, commitSha: string): boolean {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', commitSha, targetBranch], {
        cwd: repoPath,
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  }

  async integrateCompletedTasks(): Promise<void> {
    const policy = resolveIntegrationPolicy(this.configManager);
    if (!shouldAttemptAutomaticIntegration(policy)) {
      return;
    }

    const completedTasks = (await this.stateManager.listTasks('completed'))
      .filter((task) => {
        const integrationStatus = resolveTaskIntegrationStatus(task);
        return integrationStatus !== 'integrated' && integrationStatus !== 'blocked_conflict';
      })
      .slice()
      .sort((a: Task, b: Task) => a.startTime - b.startTime);

    for (const task of completedTasks) {
      await withIntegrationLaneLock(task.repoPath, resolveTaskIntegrationLane(task, policy.targetBranch), async () => {
        const latestTask = await this.stateManager.loadTask(task.id);
        const latestIntegrationStatus = latestTask ? resolveTaskIntegrationStatus(latestTask) : undefined;
        if (!latestTask || latestTask.status !== 'completed' || latestIntegrationStatus === 'integrated' || latestIntegrationStatus === 'blocked_conflict') {
          return;
        }

        const storyCompletion = evaluateTaskStoryCompletion(latestTask);
        if (!storyCompletion.allStoriesPassed) {
          const message = formatStoryCompletionInvariantMessage(latestTask.id, 'integrate', storyCompletion);
          await this.stateManager.updateTask(task.id, {
            ...buildStoryCompletionInvariantFailureUpdates(message),
          });
          appendTaskEvent(latestTask, {
            type: 'merge_failed',
            status: 'completed',
            message,
          });
          this.logger.error(`Refused to integrate incomplete task ${latestTask.id}: ${message}`);
          return;
        }

        const coordinationState = findCoordinationBlockers(
          latestTask,
          await this.stateManager.listTasks(),
          'merge',
          { targetBranch: policy.targetBranch },
        );
        await this.stateManager.updateTask(task.id, {
          integrationLane: resolveTaskIntegrationLane(latestTask, policy.targetBranch),
          ...coordinationState.taskUpdates,
        });
        if (coordinationState.blocked) {
          return;
        }

        try {
          const mergeUpdates = await this.autoMergeTaskIfEnabled(latestTask);
          if (Object.keys(mergeUpdates).length === 0) {
            return;
          }

          await this.stateManager.updateTask(task.id, mergeUpdates);
          this.logger.log(`Task ${task.id} integrated into ${policy.targetBranch}`);
        } catch (error) {
          if (error instanceof Error && /Unattended autoMerge/.test(error.message)) {
            await this.markCompletedTaskIntegrationFailure(
              latestTask,
              this.buildGenericIntegrationFailureUpdates(policy.targetBranch, policy.strategy, error.message),
              error.message,
              policy.strategy,
              policy.targetBranch,
              false,
            );
            return;
          }

          const failureUpdates = getTaskUpdatesFromError(error);
          const failureMessage = error instanceof Error ? error.message : String(error);
          const normalizedFailureUpdates = Object.keys(failureUpdates).length > 0
            ? failureUpdates
            : this.buildGenericIntegrationFailureUpdates(policy.targetBranch, policy.strategy, failureMessage);
          await this.markCompletedTaskIntegrationFailure(
            latestTask,
            normalizedFailureUpdates,
            failureMessage,
            policy.strategy,
            policy.targetBranch,
            Boolean(normalizedFailureUpdates.mergeConflictFiles?.length),
          );
        }
      });
    }
  }

  async reconcileDeferredTargetSyncs(): Promise<void> {
    const policy = resolveIntegrationPolicy(this.configManager);
    const deferredTasks = (await this.stateManager.listTasks('completed'))
      .filter((task) =>
        resolveTaskIntegrationStatus(task) === 'integrated'
        && shouldReconcileTargetSync(task)
      )
      .slice()
      .sort((a: Task, b: Task) => a.startTime - b.startTime);

    for (const task of deferredTasks) {
      await withIntegrationLaneLock(task.repoPath, resolveTaskIntegrationLane(task, policy.targetBranch), async () => {
        const latestTask = await this.stateManager.loadTask(task.id);
        if (
          !latestTask
          || latestTask.status !== 'completed'
          || resolveTaskIntegrationStatus(latestTask) !== 'integrated'
          || !shouldReconcileTargetSync(latestTask)
        ) {
          return;
        }

        if (!policy.publishTargetBranch || !policy.syncTargetBranch) {
          const commitSha = latestTask.integrationCommitSha || latestTask.mergeCommitSha;
          const alreadyAtTarget = commitSha
            ? this.isCommitReachableFromTarget(latestTask.repoPath, policy.targetBranch, commitSha)
            : false;
          const updates: Partial<Task> = alreadyAtTarget
            ? {
                targetSyncStatus: 'synced',
                targetSyncedAt: Date.now(),
                targetSyncDeferredReason: undefined,
              }
            : {
                targetSyncStatus: 'disabled',
                targetSyncDeferredReason: `target sync disabled by policy: autoMerge=${policy.publishTargetBranch}, merge.syncTargetBranch=${policy.syncTargetBranch}`,
              };

          await this.stateManager.updateTask(task.id, updates);
          appendTaskEvent(latestTask, {
            type: alreadyAtTarget ? 'target_sync_already_reconciled' : 'target_sync_disabled_by_policy',
            status: latestTask.status,
            message: alreadyAtTarget
              ? `${policy.targetBranch} already contains ${commitSha}`
              : updates.targetSyncDeferredReason,
            data: {
              targetBranch: policy.targetBranch,
              targetSyncStatus: updates.targetSyncStatus,
              targetSyncedAt: updates.targetSyncedAt,
            },
          });
          return;
        }

        try {
          const mergeUpdates = await this.autoMergeTaskIfEnabled(latestTask);
          if (Object.keys(mergeUpdates).length === 0) {
            return;
          }

          await this.stateManager.updateTask(task.id, mergeUpdates);
          appendTaskEvent(latestTask, {
            type: mergeUpdates.targetSyncStatus === 'synced'
              ? 'target_sync_completed'
              : 'target_sync_retry_deferred',
            status: latestTask.status,
            message: mergeUpdates.targetSyncDeferredReason
              || mergeUpdates.mergeMessage
              || `Retried ${policy.targetBranch} target sync`,
            data: {
              targetBranch: mergeUpdates.mergeTargetBranch || policy.targetBranch,
              targetSyncStatus: mergeUpdates.targetSyncStatus,
              targetSyncedAt: mergeUpdates.targetSyncedAt,
            },
          });

          if (mergeUpdates.targetSyncStatus === 'synced') {
            this.logger.log(`Task ${task.id} target sync completed for ${policy.targetBranch}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.stateManager.updateTask(task.id, {
            targetSyncStatus: 'failed',
            targetSyncDeferredReason: `target sync retry failed: ${message}`,
          });
          appendTaskEvent(latestTask, {
            type: 'target_sync_retry_failed',
            status: latestTask.status,
            message,
            data: {
              targetBranch: policy.targetBranch,
            },
          });
          this.logger.error(`Task ${task.id} target sync retry failed: ${message}`);
        }
      });
    }
  }

  private getWorktreeCleanupLockGlobs(): string[] | undefined {
    return resolveConfiguredWorktreeCleanupLockGlobs(this.configManager);
  }

  private async cleanupTaskWorktreeProcesses(
    task: Pick<Task, 'id' | 'worktree' | 'logPath' | 'eventLogPath' | 'status'>,
    reason: string,
    protectedPids: number[] = [process.pid],
  ): Promise<WorktreeCleanupResult> {
    const result = await this.cleanupWorktreeProcessesFn({
      taskId: task.id,
      worktreePath: task.worktree,
      reason,
      protectedPids,
      allowProtectedDescendantCleanup: true,
      lockGlobs: this.getWorktreeCleanupLockGlobs(),
    });

    if (result.killed.length > 0 || result.skipped.length > 0) {
      const message = result.killed.length > 0
        ? `Cleaned ${result.killed.length} worktree lock holder process(es): ${reason}`
        : `Skipped ${result.skipped.length} worktree lock holder process(es): ${reason}`;
      this.logger.error(`Task ${task.id}: ${message}`);
      appendTaskEvent(task, {
        type: 'worktree_process_cleanup',
        status: task.status,
        message,
        data: {
          reason,
          worktree: task.worktree,
          lockPaths: result.lockPaths,
          killed: result.killed.map((entry) => ({
            pid: entry.pid,
            pgid: entry.pgid,
            signalPid: entry.signalPid,
            signalScope: entry.signalScope,
            cwd: entry.cwd,
            command: entry.command,
            lockPath: entry.lockPath,
          })),
          skipped: result.skipped,
        },
      });
    }

    return result;
  }

  async finalizeReadyTasks(): Promise<void> {
    const readyTasks = (await this.stateManager.listTasks('ready_to_finalize'))
      .slice()
      .sort((a: Task, b: Task) => a.startTime - b.startTime);

    for (const task of readyTasks) {
      await withTaskFinalizeLock(task.id, async () => {
        const integrationPolicy = resolveIntegrationPolicy(this.configManager);
        const targetBranch = integrationPolicy.targetBranch;
        const integrationLane = resolveTaskIntegrationLane(task, targetBranch);

        await withIntegrationLaneLock(task.repoPath, integrationLane, async () => {
        let finalizeResult: FinalizeResult | undefined;
        let finalizerCommittedAt: number | undefined;

        try {
          const latestTask = await this.stateManager.loadTask(task.id);
          if (!latestTask || (latestTask.status !== 'ready_to_finalize' && latestTask.status !== 'failed_finalize')) {
            return;
          }

          const coordinationState = findCoordinationBlockers(
            latestTask,
            await this.stateManager.listTasks(),
            'finalize',
            { targetBranch },
          );
          await this.stateManager.updateTask(task.id, {
            integrationLane,
            ...coordinationState.taskUpdates,
          });
          if (coordinationState.blocked) {
            appendTaskEvent(latestTask, {
              type: 'coordination_blocked',
              status: latestTask.status,
              message: coordinationState.reason,
              data: {
                phase: coordinationState.phase,
                blockers: coordinationState.blockers,
                lane: coordinationState.lane,
              },
            });
            this.logger.log(`Task ${task.id} waiting for overlapping task(s): ${coordinationState.blockers.join(', ')}`);
            return;
          }

          const storyCompletion = evaluateTaskStoryCompletion(latestTask);
          if (!storyCompletion.allStoriesPassed) {
            const observedAt = Date.now();
            const message = formatStoryCompletionInvariantMessage(latestTask.id, 'finalize', storyCompletion);
            await this.stateManager.updateTask(task.id, {
              status: 'failed',
              endTime: observedAt,
              pid: undefined,
              currentUS: undefined,
              leaseOwner: undefined,
              leaseHeartbeatAt: undefined,
              leaseExpiresAt: undefined,
              ...buildStoryCompletionInvariantFailureUpdates(message, observedAt),
            });
            appendTaskEvent(latestTask, {
              type: 'story_completion_invariant_failed',
              status: 'failed',
              message,
              data: {
                phase: 'finalize',
                incompleteStories: storyCompletion.incompleteStories,
              },
            });
            this.logger.error(`Refused to finalize incomplete task ${latestTask.id}: ${message}`);
            return;
          }

          await this.cleanupTaskWorktreeProcesses(latestTask, 'before_finalizer_quality_gates');

          const finalizingAt = Date.now();
          const leaseTimeoutMs = resolveFinalizerLeaseTimeoutMs(
            this.configManager.get('finalizer.leaseTimeout') ?? this.configManager.get('finalizer.qualityGateTimeout')
          );

          await this.stateManager.updateTask(task.id, {
            status: 'finalizing',
            pid: undefined,
            currentUS: undefined,
            endTime: undefined,
            leaseOwner: `finalizer:${process.pid}`,
            leaseHeartbeatAt: finalizingAt,
            leaseExpiresAt: finalizingAt + leaseTimeoutMs,
          });
          appendTaskEvent(latestTask, {
            type: 'finalizer_started',
            status: 'finalizing',
            message: 'Restricted finalizer started',
          });

          const taskToFinalize = await this.stateManager.loadTask(task.id);
          if (!taskToFinalize) {
            throw new Error(`Task ${task.id} disappeared before finalization`);
          }

          finalizeResult = this.finalizer(taskToFinalize);
          finalizerCommittedAt = finalizeResult.committed ? Date.now() : undefined;

          if (requiresPostFinalizeMergeProbe(taskToFinalize)) {
            const mergeProbeResult = await this.probeWorktreeMergeability(taskToFinalize, targetBranch, {
              pullLatest: integrationPolicy.pullLatest,
              integrationWorktreeDir: integrationPolicy.integrationWorktreeDir,
              syncTargetBranch: false,
            });

            if (!mergeProbeResult.alreadyIntegrated && !mergeProbeResult.mergeable) {
              const mergeFailureResult = {
                success: false,
                hasConflicts: Boolean(mergeProbeResult.conflictFiles?.length),
                message: mergeProbeResult.message,
                conflictFiles: mergeProbeResult.conflictFiles,
                integrationBranch: mergeProbeResult.integrationBranch,
                integrationWorktree: mergeProbeResult.integrationWorktree,
                sourceBranch: resolveTaskBranchName(taskToFinalize),
                targetBranch: resolveTaskIntegrationBranch(taskToFinalize, targetBranch),
                baseCommitSha: taskToFinalize.baseCommitSha,
              };

              throw createMergeFailureError(
                mergeFailureResult,
                buildMergeFailureUpdates(mergeFailureResult, targetBranch, integrationPolicy.strategy),
              );
            }
          }

          await this.stateManager.updateTask(task.id, {
            status: 'completed',
            endTime: Date.now(),
            lastError: undefined,
            finalizerCommitMessage: finalizeResult.commitMessage,
            finalizerCommitSha: finalizeResult.commitSha,
            finalizerCommittedAt,
            mergeError: undefined,
            mergeConflictFiles: undefined,
            mergeConflictPhase: undefined,
            mergeConflictAt: undefined,
            postFinalizeMergeProbeRequired: undefined,
            finalizerFailure: undefined,
            repairContext: undefined,
            finalizeRepairStartedAt: undefined,
            finalizeRepairDeadlineAt: undefined,
            finalizeRepairLastFailureSnapshot: undefined,
            finalizeRepairLastProgressAt: undefined,
            finalizeRepairLastProgressReason: undefined,
            finalizeRepairConsecutiveNoProgress: 0,
            finalizeRepairTotalRequeues: 0,
            finalizeRepairStoppedAt: undefined,
            finalizeRepairStopReason: undefined,
            lastErrorKind: undefined,
            lastErrorClass: undefined,
            lastErrorRetryable: undefined,
            lastErrorObservedAt: undefined,
            leaseOwner: undefined,
            leaseHeartbeatAt: undefined,
            leaseExpiresAt: undefined,
            integrationLane,
            ...coordinationState.taskUpdates,
          });
          appendTaskEvent(taskToFinalize, {
            type: 'finalizer_completed',
            status: 'completed',
            message: finalizeResult.message,
            data: {
              committed: finalizeResult.committed,
              commitSha: finalizeResult.commitSha,
              commitMessage: finalizeResult.commitMessage,
            },
          });

          let mergeSuffix = '';
          try {
            const mergeUpdates = await this.autoMergeTaskIfEnabled(taskToFinalize);
            if (Object.keys(mergeUpdates).length > 0) {
              await this.stateManager.updateTask(task.id, mergeUpdates);
              mergeSuffix = mergeUpdates.mergedAt
                ? `; merged into ${mergeUpdates.mergeTargetBranch}`
                : '';
            }
          } catch (error) {
            if (error instanceof Error && /Unattended autoMerge/.test(error.message)) {
              await this.markCompletedTaskIntegrationFailure(
                taskToFinalize,
                this.buildGenericIntegrationFailureUpdates(
                  integrationPolicy.targetBranch,
                  integrationPolicy.strategy,
                  error.message,
                ),
                error.message,
                integrationPolicy.strategy,
                integrationPolicy.targetBranch,
                false,
              );
              this.logger.log(`Task ${task.id} finalized (${finalizeResult.message}; integration failed)`);
              return;
            }

            const failureUpdates = getTaskUpdatesFromError(error);
            const failureMessage = error instanceof Error ? error.message : String(error);
            const normalizedFailureUpdates = Object.keys(failureUpdates).length > 0
              ? failureUpdates
              : this.buildGenericIntegrationFailureUpdates(
                  integrationPolicy.targetBranch,
                  integrationPolicy.strategy,
                  failureMessage,
                );
            await this.markCompletedTaskIntegrationFailure(
              taskToFinalize,
              normalizedFailureUpdates,
              failureMessage,
              integrationPolicy.strategy,
              integrationPolicy.targetBranch,
              Boolean(normalizedFailureUpdates.mergeConflictFiles?.length),
            );
            this.logger.log(`Task ${task.id} finalized (${finalizeResult.message}; integration failed)`);
            return;
          }

          this.logger.log(`Task ${task.id} finalized (${finalizeResult.message}${mergeSuffix})`);
        } catch (error) {
          const latestTask = await this.stateManager.loadTask(task.id);
          const finalizerAttempts = (latestTask?.finalizerAttempts ?? task.finalizerAttempts ?? 0) + 1;
          const failureUpdates = getTaskUpdatesFromError(error);
          const finalizerFailure = isQualityGateFailure(error) ? error.details : undefined;
          const failureMessage = error instanceof Error ? error.message : String(error);
          const observedAt = Date.now();
          const transientFailure = !finalizerFailure && !failureUpdates.mergeConflictFiles?.length
            ? resolveRetryableTransientFailure({
              ...(latestTask ?? task),
              lastError: failureMessage,
              mergeError: failureMessage,
              lastErrorKind: undefined,
              lastErrorClass: undefined,
              lastErrorRetryable: undefined,
              lastErrorSignature: undefined,
            })
            : undefined;

          if (transientFailure) {
            const transientConfig = resolveTransientRecoveryConfig(this.configManager);
            const startedAt = latestTask?.transientRecoveryStartedAt
              ?? task.transientRecoveryStartedAt
              ?? observedAt;
            const deadlineAt = latestTask?.transientRecoveryDeadlineAt
              ?? task.transientRecoveryDeadlineAt
              ?? startedAt + (transientConfig.transientRecoveryDeadlineSeconds * 1000);
            const currentTotalRequeues = latestTask?.transientRecoveryTotalRequeues
              ?? task.transientRecoveryTotalRequeues
              ?? 0;
            const delayMs = resolveTransientRecoveryDelayMs(currentTotalRequeues + 1, transientConfig);
            const nextEligibleAt = observedAt + delayMs;

            await this.stateManager.updateTask(task.id, {
              status: 'failed_finalize',
              endTime: observedAt,
              lastError: failureMessage,
              mergeError: failureMessage,
              ...transientFailure.backfill,
              lastErrorObservedAt: observedAt,
              lastErrorHadObjectiveProgress: Boolean(finalizeResult?.commitSha || finalizerCommittedAt),
              finalizerCommitMessage: finalizeResult?.commitMessage,
              finalizerCommitSha: finalizeResult?.commitSha,
              finalizerCommittedAt,
              finalizerAttempts,
              finalizerFailure: undefined,
              repairContext: undefined,
              pid: undefined,
              currentUS: undefined,
              leaseOwner: undefined,
              leaseHeartbeatAt: undefined,
              leaseExpiresAt: undefined,
              transientRecoveryStartedAt: startedAt,
              transientRecoveryDeadlineAt: deadlineAt,
              transientRecoveryLastFailureKind: transientFailure.kind,
              transientRecoveryLastFailureClass: transientFailure.class,
              transientRecoveryLastFailureSignature: transientFailure.signature,
              transientRecoveryLastFailureObservedAt: observedAt,
              transientRecoveryLastProgressReason: 'finalizer transient failure',
              transientRecoveryLastDelayMs: delayMs,
              transientRecoveryNextEligibleAt: nextEligibleAt,
              transientRecoveryStoppedAt: undefined,
              transientRecoveryStopReason: undefined,
              autoRecoveryKind: 'transient',
              autoRecoveryHardCap: transientConfig.autoRecoveryHardCap,
              autoRecoveryNextEligibleAt: nextEligibleAt,
              autoRecoveryStoppedAt: undefined,
              autoRecoveryStopReason: undefined,
              autoRecoveryLastReason: `Scheduled transient finalizer retry for ${transientFailure.kind}`,
              mergeRepairDisplayStatus: undefined,
              mergeRepairProof: undefined,
              ...failureUpdates,
            });
            appendTaskEvent(task, {
              type: 'transient_finalizer_retry_scheduled',
              status: 'failed_finalize',
              message: `Scheduled transient finalizer retry after ${transientFailure.kind}`,
              data: {
                finalizerAttempts,
                failureKind: transientFailure.kind,
                failureClass: transientFailure.class,
                failureSignature: transientFailure.signature,
                delayMs,
                nextEligibleAt,
              },
            });
            this.logger.log(`Task ${task.id} finalizer hit retryable ${transientFailure.kind}; scheduled retry in ${delayMs}ms`);
            return;
          }

          const lastErrorKind = finalizerFailure
            ? 'quality_gate_failure'
            : failureUpdates.mergeConflictFiles?.length
              ? 'merge_conflict'
              : 'finalizer_failed';
          const lastErrorClass = finalizerFailure
            ? 'quality_gate'
            : failureUpdates.mergeConflictFiles?.length
              ? 'merge_conflict'
              : 'unknown';
          const staleMergeRepairProofUpdates = failureUpdates.mergeConflictFiles?.length
            ? {}
            : {
                mergeRepairDisplayStatus: undefined,
                mergeRepairProof: undefined,
              };
          const repairConfig = resolveFinalizeRepairConfig(this.configManager);
          const repairFailureState = evaluateFinalizeRepairFailure({
            ...(latestTask ?? task),
            lastError: failureMessage,
            mergeError: failureMessage,
            finalizerFailure,
            ...failureUpdates,
          }, repairConfig);
          const repairStoryId = selectFinalizeRepairStoryId({
            ...(latestTask ?? task),
            mergeError: failureMessage,
            mergeConflictFiles: failureUpdates.mergeConflictFiles ?? latestTask?.mergeConflictFiles ?? task.mergeConflictFiles,
          }, Boolean(failureUpdates.mergeConflictFiles?.length));
          const mergeConflict = Boolean(failureUpdates.mergeConflictFiles?.length);
          const autoRecoveryKind = mergeConflict ? 'merge_repair' : 'finalize_repair';
          const repairContext = repairStoryId
            ? buildTaskRepairContext({
                storyId: repairStoryId,
                mode: mergeConflict ? 'merge' : 'finalize',
                reason: failureMessage,
                createdAt: observedAt,
              })
            : undefined;
          const latestFailure = finalizerFailure
            ? buildFailureObservationFromTask({
                ...(latestTask ?? task),
                finalizerFailure,
                lastError: failureMessage,
                lastErrorObservedAt: observedAt,
              }, observedAt)
            : undefined;
          await this.stateManager.updateTask(task.id, {
            status: 'failed_finalize',
            endTime: Date.now(),
            lastError: failureMessage,
            lastErrorKind,
            lastErrorClass,
            lastErrorRetryable: false,
            lastErrorObservedAt: observedAt,
            finalizerCommitMessage: finalizeResult?.commitMessage,
            finalizerCommitSha: finalizeResult?.commitSha,
            finalizerCommittedAt,
            finalizerAttempts,
            mergeError: failureMessage,
            finalizerFailure,
            latestFailure,
            failureHistory: appendFailureObservation(latestTask?.failureHistory ?? task.failureHistory, latestFailure),
            repairContext,
            postFinalizeMergeProbeRequired: failureUpdates.postFinalizeMergeProbeRequired
              ?? latestTask?.postFinalizeMergeProbeRequired
              ?? task.postFinalizeMergeProbeRequired,
            pid: undefined,
            currentUS: undefined,
            leaseOwner: undefined,
            leaseHeartbeatAt: undefined,
            leaseExpiresAt: undefined,
            autoRecoveryKind,
            autoRecoveryHardCap: mergeConflict
              ? Math.max(repairConfig.maxRepairAttempts, 1)
              : repairConfig.repairHardCap,
            autoRecoveryNextEligibleAt: undefined,
            autoRecoveryStoppedAt: undefined,
            autoRecoveryStopReason: undefined,
            autoRecoveryLastReason: mergeConflict
              ? 'Finalizer failed with merge conflict; waiting for merge repair'
              : 'Finalizer failed; waiting for finalize repair',
            finalizeRepairStartedAt: repairFailureState.startedAt,
            finalizeRepairDeadlineAt: repairFailureState.deadlineAt,
            finalizeRepairLastFailureSnapshot: repairFailureState.snapshot,
            finalizeRepairLastProgressAt: repairFailureState.lastProgressAt,
            finalizeRepairLastProgressReason: repairFailureState.lastProgressReason,
            finalizeRepairConsecutiveNoProgress: repairFailureState.consecutiveNoProgress,
            ...staleMergeRepairProofUpdates,
            ...failureUpdates,
          });
          appendTaskEvent(task, {
            type: 'finalizer_failed',
            status: 'failed_finalize',
            message: failureMessage,
            data: {
              finalizerAttempts,
              repairPolicy: repairConfig.repairPolicy,
              consecutiveNoProgress: repairFailureState.consecutiveNoProgress,
              progressReason: repairFailureState.lastProgressReason,
              finalizerFailureClass: finalizerFailure?.class,
              finalizerFailureGate: finalizerFailure?.gate,
              finalizerFailurePackage: finalizerFailure?.packageLabel,
              repairMode: repairContext?.mode,
              repairStoryId,
              diagnosticCount: finalizerFailure?.diagnosticCount,
              conflictFiles: failureUpdates.mergeConflictFiles,
            },
          });
          this.logger.error(`Failed to finalize task ${task.id}:`, error);
        }
        });
      });
    }
  }

  async recoverFailedStoryRepairTasks(): Promise<void> {
    const recoveryConfig = resolveStoryRepairRecoveryConfig(this.configManager);
    if (!recoveryConfig.autoRemediateStoryFailures) {
      return;
    }

    const failedTasks = (await this.stateManager.listTasks('failed'))
      .filter((task) => isStoryRepairEligibleFailure(task))
      .sort((a: Task, b: Task) => a.startTime - b.startTime);

    for (const task of failedTasks) {
      if (
        task.storyRepairRecoveryStoppedAt
        || task.failedBlockerRecoveryStoppedAt
        || task.mergeRepairRecoveryStoppedAt
        || task.finalizeRepairStoppedAt
      ) {
        continue;
      }

      const now = Date.now();
      const signature = buildStoryRepairRecoverySignature(task);
      const startedAt = task.storyRepairRecoveryStartedAt ?? now;
      const deadlineAt = task.storyRepairRecoveryDeadlineAt
        ?? startedAt + (recoveryConfig.storyRepairRecoveryDeadlineSeconds * 1000);
      const currentStoryRepairRequeues = task.storyRepairRecoveryTotalRequeues ?? 0;
      const currentAutoRequeues = task.autoRecoveryTotalRequeues ?? 0;
      const previousSignature = task.storyRepairRecoveryLastSignature;
      const consecutiveSameSignature = previousSignature === signature
        ? (task.storyRepairRecoveryConsecutiveSameSignature ?? 0) + 1
        : 1;

      const stopRecovery = async (stopReason: string, stopMessage: string) => {
        await this.stateManager.updateTask(task.id, {
          storyRepairRecoveryStartedAt: startedAt,
          storyRepairRecoveryDeadlineAt: deadlineAt,
          storyRepairRecoveryLastSignature: signature,
          storyRepairRecoveryConsecutiveSameSignature: consecutiveSameSignature,
          storyRepairRecoveryStoppedAt: now,
          storyRepairRecoveryStopReason: stopReason,
          autoRecoveryKind: 'story_repair',
          autoRecoveryHardCap: recoveryConfig.storyRepairRecoveryHardCap,
          autoRecoveryStoppedAt: now,
          autoRecoveryStopReason: stopReason,
          autoRecoveryLastReason: stopMessage,
        });
        appendTaskEvent(task, {
          type: 'story_repair_recovery_stopped',
          status: 'failed',
          message: stopMessage,
          data: {
            stopReason,
            signature,
            totalRequeues: currentStoryRepairRequeues,
            deadlineAt,
          },
        });
        this.logger.log(`Task ${task.id} stopped story repair auto-recovery (${stopMessage})`);
      };

      if (hasStoryRepairUnsafeDeliveryMarker(task)) {
        await stopRecovery(
          'story_repair_unsafe_delivery_marker',
          'Task has delivery, finalizer, or merge-repair markers; refusing automatic story reset',
        );
        continue;
      }

      if (typeof task.leaseExpiresAt === 'number' && task.leaseExpiresAt > now) {
        await stopRecovery(
          'story_repair_active_lease',
          'Task still has an active worker or finalizer lease; refusing automatic story reset',
        );
        continue;
      }

      if (deadlineAt <= now) {
        await stopRecovery(
          'story_repair_deadline_exhausted',
          'Story repair recovery deadline exhausted',
        );
        continue;
      }

      if (currentStoryRepairRequeues >= recoveryConfig.maxStoryRepairRequeues) {
        await stopRecovery(
          'story_repair_budget_exhausted',
          'Story repair requeue budget exhausted',
        );
        continue;
      }

      if (currentAutoRequeues >= recoveryConfig.storyRepairRecoveryHardCap) {
        await stopRecovery(
          'story_repair_hard_cap_reached',
          'Story repair recovery hard cap reached',
        );
        continue;
      }

      const resettableStoryIds = selectStoryRepairResettableStoryIds(task);
      if (resettableStoryIds.length === 0) {
        await stopRecovery(
          'story_repair_no_resettable_stories',
          'Task has no incomplete stories that can be reset safely',
        );
        continue;
      }

      const resetMessage = isNoObjectiveEvidenceFailure(task)
        ? 'Automatically requeued story repair because Ralph rejected the previous pass without objective diff or commit evidence'
        : 'Automatically requeued incomplete story work before finalization';
      const resetState = resetIncompleteStoriesForFailedBlocker(task, resettableStoryIds, {
        updatedAt: now,
        message: resetMessage,
      });
      const nextStoryRepairRequeues = currentStoryRepairRequeues + 1;
      const nextAutoRequeues = currentAutoRequeues + 1;

      await this.stateManager.updateTask(task.id, {
        status: 'pending',
        completedUS: resetState.completedUS,
        storyProgress: resetState.storyProgress,
        currentUS: undefined,
        pid: undefined,
        endTime: undefined,
        leaseOwner: undefined,
        leaseHeartbeatAt: undefined,
        leaseExpiresAt: undefined,
        loopCount: 0,
        consecutiveNoProgress: 0,
        consecutiveErrors: 0,
        lastProgressTime: now,
        lastError: undefined,
        lastErrorKind: undefined,
        lastErrorClass: undefined,
        lastErrorRetryable: undefined,
        lastErrorObservedAt: undefined,
        lastErrorSignature: undefined,
        lastErrorHadObjectiveProgress: undefined,
        transientRetryCount: 0,
        transientRetryBudget: undefined,
        transientRetryLastDelayMs: undefined,
        finalizerFailure: undefined,
        repairContext: undefined,
        finalizeRepairStoppedAt: undefined,
        finalizeRepairStopReason: undefined,
        mergeError: undefined,
        mergeConflictFiles: undefined,
        mergeConflictPhase: undefined,
        mergeConflictAt: undefined,
        mergeRepairDisplayStatus: undefined,
        mergeRepairProof: undefined,
        postFinalizeMergeProbeRequired: undefined,
        integrationStatus: 'not_started',
        targetSyncStatus: 'not_requested',
        targetSyncDeferredReason: undefined,
        coordinationStatus: undefined,
        coordinationPhase: undefined,
        coordinationBlockers: undefined,
        coordinationReason: undefined,
        storyRepairRecoveryStartedAt: startedAt,
        storyRepairRecoveryDeadlineAt: deadlineAt,
        storyRepairRecoveryTotalRequeues: nextStoryRepairRequeues,
        storyRepairRecoveryLastSignature: signature,
        storyRepairRecoveryConsecutiveSameSignature: consecutiveSameSignature,
        storyRepairRecoveryStoppedAt: undefined,
        storyRepairRecoveryStopReason: undefined,
        autoRecoveryKind: 'story_repair',
        autoRecoveryHardCap: recoveryConfig.storyRepairRecoveryHardCap,
        autoRecoveryTotalRequeues: nextAutoRequeues,
        autoRecoveryLastRequeuedAt: now,
        autoRecoveryNextEligibleAt: undefined,
        autoRecoveryStoppedAt: undefined,
        autoRecoveryStopReason: undefined,
        autoRecoveryLastReason: resetMessage,
      });
      appendTaskEvent(task, {
        type: 'story_repair_auto_requeued',
        status: 'pending',
        storyId: resettableStoryIds[0],
        message: resetMessage,
        data: {
          resetStoryIds: resettableStoryIds,
          signature,
          totalRequeues: nextStoryRepairRequeues,
          deadlineAt,
        },
      });
      this.logger.log(`Task ${task.id} returned to pending for automatic story repair`);
    }
  }

  async recoverFailedBlockers(): Promise<void> {
    const recoveryConfig = resolveFailedBlockerRecoveryConfig(this.configManager);
    if (!recoveryConfig.autoRemediateFailedBlockers) {
      return;
    }

    const pendingTasks = (await this.stateManager.listTasks('pending'))
      .slice()
      .sort((a: Task, b: Task) => a.startTime - b.startTime);
    const demandByBlockerId = new Map<string, Set<string>>();

    for (const pendingTask of pendingTasks) {
      const pendingState = await this.scheduler.describePendingTask(pendingTask);

      for (const blocker of pendingState.dependencyBlockers || []) {
        if (blocker.taskId && blocker.actionRequired) {
          if (!demandByBlockerId.has(blocker.taskId)) {
            demandByBlockerId.set(blocker.taskId, new Set());
          }
          demandByBlockerId.get(blocker.taskId)?.add(pendingTask.id);
        }
      }

      for (const blockerId of pendingState.failedBlockers || []) {
        if (!demandByBlockerId.has(blockerId)) {
          demandByBlockerId.set(blockerId, new Set());
        }
        demandByBlockerId.get(blockerId)?.add(pendingTask.id);
      }
    }

    if (demandByBlockerId.size === 0) {
      return;
    }

    await this.recoverBlockedAutonomyTasks();

    const tasksById = new Map((await this.stateManager.listTasks()).map((task) => [task.id, task]));
    const blockers = [...demandByBlockerId.keys()]
      .map((blockerId) => tasksById.get(blockerId))
      .filter((task): task is Task => Boolean(task))
      .sort((a, b) => a.startTime - b.startTime);

    for (const blocker of blockers) {
      const demandTaskIds = [...(demandByBlockerId.get(blocker.id) || new Set<string>())].sort();

      if (blocker.status !== 'failed' || blocker.lastErrorKind !== 'story_incomplete') {
        continue;
      }

      if (blocker.failedBlockerRecoveryStoppedAt || blocker.storyRepairRecoveryStoppedAt) {
        continue;
      }

      const now = Date.now();
      const signature = buildFailedBlockerRecoverySignature(blocker);
      const startedAt = blocker.failedBlockerRecoveryStartedAt
        ?? now;
      const deadlineAt = blocker.failedBlockerRecoveryDeadlineAt
        ?? startedAt + (recoveryConfig.failedBlockerRecoveryDeadlineSeconds * 1000);
      const currentFailedBlockerRequeues = blocker.failedBlockerRecoveryTotalRequeues ?? 0;
      const demandIds = mergeDemandTaskIds(blocker.failedBlockerRecoveryDemandTaskIds, demandTaskIds);

      const stopRecovery = async (stopReason: string, stopMessage: string) => {
        await this.stateManager.updateTask(blocker.id, {
          failedBlockerRecoveryStartedAt: startedAt,
          failedBlockerRecoveryDeadlineAt: deadlineAt,
          failedBlockerRecoveryLastSignature: signature,
          failedBlockerRecoveryStoppedAt: now,
          failedBlockerRecoveryStopReason: stopReason,
          failedBlockerRecoveryDemandTaskIds: demandIds,
          storyRepairRecoveryStartedAt: blocker.storyRepairRecoveryStartedAt ?? startedAt,
          storyRepairRecoveryDeadlineAt: blocker.storyRepairRecoveryDeadlineAt ?? deadlineAt,
          storyRepairRecoveryLastSignature: signature,
          storyRepairRecoveryStoppedAt: now,
          storyRepairRecoveryStopReason: stopReason,
          storyRepairRecoveryDemandTaskIds: demandIds,
          autoRecoveryKind: 'story_repair',
          autoRecoveryHardCap: recoveryConfig.failedBlockerRecoveryHardCap,
          autoRecoveryStoppedAt: now,
          autoRecoveryStopReason: stopReason,
          autoRecoveryLastReason: stopMessage,
        });
        appendTaskEvent(blocker, {
          type: 'failed_blocker_recovery_stopped',
          status: 'failed',
          message: stopMessage,
          data: {
            stopReason,
            demandTaskIds,
            signature,
            totalRequeues: currentFailedBlockerRequeues,
            deadlineAt,
          },
        });
        this.logger.log(`Task ${blocker.id} stopped failed-blocker auto-remediation (${stopMessage})`);
      };

      if (hasIntegrationOrMergeMarker(blocker)) {
        await stopRecovery(
          'failed_blocker_unsafe_integrated_marker',
          'Failed blocker has integration or merge markers; refusing automatic story reset',
        );
        continue;
      }

      if (deadlineAt <= now) {
        await stopRecovery(
          'failed_blocker_deadline_exhausted',
          'Failed blocker story repair deadline exhausted',
        );
        continue;
      }

      if (currentFailedBlockerRequeues >= recoveryConfig.maxFailedBlockerStoryRequeues) {
        await stopRecovery(
          'failed_blocker_story_budget_exhausted',
          'Failed blocker story repair requeue budget exhausted',
        );
        continue;
      }

      if (currentFailedBlockerRequeues >= recoveryConfig.failedBlockerRecoveryHardCap) {
        await stopRecovery(
          'failed_blocker_recovery_hard_cap_reached',
          'Failed blocker recovery hard cap reached',
        );
        continue;
      }

      const resettableStoryIds = selectFailedBlockerResettableStoryIds(blocker);
      if (resettableStoryIds.length === 0) {
        await stopRecovery(
          'failed_blocker_no_resettable_stories',
          'Failed blocker has no incomplete stories that can be reset safely',
        );
        continue;
      }

      const resetMessage = `Automatically requeued incomplete story work because pending task(s) are blocked: ${demandTaskIds.join(', ')}`;
      const resetState = resetIncompleteStoriesForFailedBlocker(blocker, resettableStoryIds, {
        updatedAt: now,
        message: resetMessage,
      });
      const nextFailedBlockerRequeues = currentFailedBlockerRequeues + 1;
      const currentAutoRequeues = blocker.autoRecoveryTotalRequeues ?? 0;
      const nextAutoRequeues = currentAutoRequeues + 1;

      await this.stateManager.updateTask(blocker.id, {
        status: 'pending',
        completedUS: resetState.completedUS,
        storyProgress: resetState.storyProgress,
        currentUS: undefined,
        pid: undefined,
        endTime: undefined,
        leaseOwner: undefined,
        leaseHeartbeatAt: undefined,
        leaseExpiresAt: undefined,
        loopCount: 0,
        consecutiveNoProgress: 0,
        consecutiveErrors: 0,
        lastProgressTime: now,
        lastError: undefined,
        lastErrorKind: undefined,
        lastErrorClass: undefined,
        lastErrorRetryable: undefined,
        lastErrorObservedAt: undefined,
        lastErrorSignature: undefined,
        lastErrorHadObjectiveProgress: undefined,
        transientRetryCount: 0,
        transientRetryBudget: undefined,
        transientRetryLastDelayMs: undefined,
        finalizerFailure: undefined,
        repairContext: undefined,
        finalizeRepairStoppedAt: undefined,
        finalizeRepairStopReason: undefined,
        mergeError: undefined,
        mergeConflictFiles: undefined,
        mergeConflictPhase: undefined,
        mergeConflictAt: undefined,
        mergeRepairDisplayStatus: undefined,
        mergeRepairProof: undefined,
        postFinalizeMergeProbeRequired: undefined,
        integrationStatus: 'not_started',
        targetSyncStatus: 'not_requested',
        targetSyncDeferredReason: undefined,
        coordinationStatus: undefined,
        coordinationPhase: undefined,
        coordinationBlockers: undefined,
        coordinationReason: undefined,
        failedBlockerRecoveryStartedAt: startedAt,
        failedBlockerRecoveryDeadlineAt: deadlineAt,
        failedBlockerRecoveryTotalRequeues: nextFailedBlockerRequeues,
        failedBlockerRecoveryLastSignature: signature,
        failedBlockerRecoveryStoppedAt: undefined,
        failedBlockerRecoveryStopReason: undefined,
        failedBlockerRecoveryDemandTaskIds: demandIds,
        storyRepairRecoveryStartedAt: blocker.storyRepairRecoveryStartedAt ?? startedAt,
        storyRepairRecoveryDeadlineAt: blocker.storyRepairRecoveryDeadlineAt ?? deadlineAt,
        storyRepairRecoveryTotalRequeues: (blocker.storyRepairRecoveryTotalRequeues ?? 0) + 1,
        storyRepairRecoveryLastSignature: signature,
        storyRepairRecoveryConsecutiveSameSignature: 1,
        storyRepairRecoveryStoppedAt: undefined,
        storyRepairRecoveryStopReason: undefined,
        storyRepairRecoveryDemandTaskIds: demandIds,
        autoRecoveryKind: 'story_repair',
        autoRecoveryHardCap: recoveryConfig.failedBlockerRecoveryHardCap,
        autoRecoveryTotalRequeues: nextAutoRequeues,
        autoRecoveryLastRequeuedAt: now,
        autoRecoveryNextEligibleAt: undefined,
        autoRecoveryStoppedAt: undefined,
        autoRecoveryStopReason: undefined,
        autoRecoveryLastReason: resetMessage,
      });
      appendTaskEvent(blocker, {
        type: 'failed_blocker_story_repair_auto_requeued',
        status: 'pending',
        storyId: resettableStoryIds[0],
        message: resetMessage,
        data: {
          resetStoryIds: resettableStoryIds,
          demandTaskIds,
          signature,
          totalRequeues: nextFailedBlockerRequeues,
          deadlineAt,
        },
      });
      this.logger.log(`Task ${blocker.id} returned to pending for failed-blocker story repair`);
    }
  }

  async checkPendingTasks(): Promise<void> {
    const startedTasks = await this.scheduler.schedulePendingTasks();

    for (const task of startedTasks) {
      appendTaskEvent(task, {
        type: 'manager_started_task',
        status: task.status,
        message: `Manager started task ${task.id}`,
        data: { pid: task.pid },
      });
      this.logger.log(`Task ${task.id} started (PID: ${task.pid})`);
    }
  }
}

export async function watchCommand(options: WatchCommandOptions): Promise<void> {
  try {
    await assertRalphHomeIsolation({
      repoPath: options.repo,
      allowMixedHome: options.allowMixedHome,
      operation: 'start the Ralph watcher',
    });

    const watcher = new DependencyWatcher(options);

    process.on('SIGINT', () => {
      console.log('\nReceived SIGINT, stopping watcher...');
      watcher.stop();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.log('\nReceived SIGTERM, stopping watcher...');
      watcher.stop();
      process.exit(0);
    });

    await watcher.start();
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exit(1);
  }
}
