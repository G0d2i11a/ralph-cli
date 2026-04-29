import { Task, FinalizeRepairFailureKind, FinalizeRepairSnapshot } from '../types/task';
import {
  getChangedFilesCount,
  getCommitCountAheadOfBase,
  getDiffFilesCountFromBase,
  getLatestCommitSHA,
  getWorktreeDiffSignature,
} from './worktree-progress';

export type FinalizeRepairPolicyMode = 'fixed' | 'progress';

export interface FinalizeRepairConfig {
  repairPolicy: FinalizeRepairPolicyMode;
  maxRepairAttempts: number;
  maxNoProgressRepairRounds: number;
  repairDeadlineSeconds: number;
  repairHardCap: number;
}

export interface FinalizeRepairFailureState {
  snapshot: FinalizeRepairSnapshot;
  startedAt: number;
  deadlineAt: number;
  consecutiveNoProgress: number;
  lastProgressAt?: number;
  lastProgressReason?: string;
}

export interface FinalizeRepairDecision {
  shouldRequeue: boolean;
  reason: string;
  stopReason?: string;
}

interface FinalizeRepairComparison {
  hasProgress: boolean;
  reason: string;
}

const DEFAULT_MAX_REPAIR_ATTEMPTS = 1;
const DEFAULT_MAX_NO_PROGRESS_ROUNDS = 2;
const DEFAULT_REPAIR_DEADLINE_SECONDS = 7200;
const DEFAULT_REPAIR_HARD_CAP = 20;

export function resolveFinalizeRepairConfig(config: Pick<{ get(key: string): unknown }, 'get'>): FinalizeRepairConfig {
  const repairPolicy = config.get('finalizer.repairPolicy') === 'fixed'
    ? 'fixed'
    : 'progress';
  const maxRepairAttempts = sanitizeCount(config.get('finalizer.maxRepairAttempts'), DEFAULT_MAX_REPAIR_ATTEMPTS);
  const maxNoProgressRepairRounds = sanitizeCount(
    config.get('finalizer.maxNoProgressRepairRounds'),
    DEFAULT_MAX_NO_PROGRESS_ROUNDS
  );
  const repairDeadlineSeconds = sanitizeCount(
    config.get('finalizer.repairDeadlineSeconds'),
    DEFAULT_REPAIR_DEADLINE_SECONDS
  );
  const repairHardCap = sanitizeCount(config.get('finalizer.repairHardCap'), DEFAULT_REPAIR_HARD_CAP);

  return {
    repairPolicy,
    maxRepairAttempts,
    maxNoProgressRepairRounds,
    repairDeadlineSeconds,
    repairHardCap,
  };
}

export function captureFinalizeRepairSnapshot(
  task: Pick<Task, 'worktree' | 'baseCommitSha' | 'mergeConflictFiles' | 'mergeError' | 'lastError' | 'finalizerFailure'>,
  capturedAt = Date.now()
): FinalizeRepairSnapshot {
  const changedFilesInWorktree = getChangedFilesCount(task.worktree);
  const changedFilesFromBase = getDiffFilesCountFromBase(task.worktree, task.baseCommitSha);
  const finalizerFailure = task.finalizerFailure;

  return {
    headSha: getLatestCommitSHA(task.worktree) || undefined,
    commitsAheadOfBase: getCommitCountAheadOfBase(task.worktree, task.baseCommitSha),
    changedFiles: Math.max(changedFilesInWorktree, changedFilesFromBase),
    worktreeDiffSignature: getWorktreeDiffSignature(task.worktree),
    failureKind: detectFinalizeRepairFailureKind(task),
    failureSignature: normalizeFailureSignature(task),
    failureClass: finalizerFailure?.class,
    gate: finalizerFailure?.gate,
    packageLabel: finalizerFailure?.packageLabel,
    diagnosticCount: finalizerFailure?.diagnosticCount,
    diagnosticSignature: finalizerFailure?.diagnosticSignature,
    failedFilesSignature: buildListSignature(finalizerFailure?.failedFiles),
    failedCodesSignature: buildListSignature(finalizerFailure?.failedCodes),
    failedSymbolsSignature: buildListSignature(finalizerFailure?.failedSymbols),
    conflictSignature: buildConflictSignature(task.mergeConflictFiles),
    capturedAt,
  };
}

export function evaluateFinalizeRepairFailure(
  task: Pick<
    Task,
    | 'worktree'
    | 'baseCommitSha'
    | 'mergeConflictFiles'
    | 'mergeError'
    | 'lastError'
    | 'finalizerFailure'
    | 'finalizeRepairStartedAt'
    | 'finalizeRepairDeadlineAt'
    | 'finalizeRepairLastFailureSnapshot'
    | 'finalizeRepairLastProgressAt'
    | 'finalizeRepairLastProgressReason'
    | 'finalizeRepairConsecutiveNoProgress'
  >,
  config: FinalizeRepairConfig,
  now = Date.now()
): FinalizeRepairFailureState {
  const snapshot = captureFinalizeRepairSnapshot(task, now);
  const startedAt = task.finalizeRepairStartedAt ?? now;
  const deadlineAt = task.finalizeRepairDeadlineAt ?? startedAt + (config.repairDeadlineSeconds * 1000);
  const previousSnapshot = task.finalizeRepairLastFailureSnapshot;

  if (config.repairPolicy !== 'progress') {
    return {
      snapshot,
      startedAt,
      deadlineAt,
      consecutiveNoProgress: task.finalizeRepairConsecutiveNoProgress ?? 0,
      lastProgressAt: task.finalizeRepairLastProgressAt,
      lastProgressReason: task.finalizeRepairLastProgressReason,
    };
  }

  if (!previousSnapshot) {
    return {
      snapshot,
      startedAt,
      deadlineAt,
      consecutiveNoProgress: 0,
      lastProgressAt: now,
      lastProgressReason: 'Initial failed finalize captured',
    };
  }

  const comparison = compareFinalizeRepairSnapshots(previousSnapshot, snapshot);

  if (comparison.hasProgress) {
    return {
      snapshot,
      startedAt,
      deadlineAt,
      consecutiveNoProgress: 0,
      lastProgressAt: now,
      lastProgressReason: comparison.reason,
    };
  }

  return {
    snapshot,
    startedAt,
    deadlineAt,
    consecutiveNoProgress: (task.finalizeRepairConsecutiveNoProgress ?? 0) + 1,
    lastProgressAt: task.finalizeRepairLastProgressAt,
    lastProgressReason: task.finalizeRepairLastProgressReason,
  };
}

export function decideFinalizeRepairRequeue(input: {
  task: Pick<
    Task,
    | 'finalizerAttempts'
    | 'mergeRepairAttempts'
    | 'finalizeRepairStoppedAt'
    | 'finalizeRepairStopReason'
    | 'finalizeRepairStartedAt'
    | 'finalizeRepairDeadlineAt'
    | 'finalizeRepairConsecutiveNoProgress'
    | 'finalizeRepairTotalRequeues'
    | 'finalizeRepairLastProgressReason'
  >;
  config: FinalizeRepairConfig;
  mergeConflict: boolean;
  hasUnrunMergeRepair: boolean;
  now?: number;
}): FinalizeRepairDecision {
  if (input.config.repairPolicy === 'fixed') {
    const attempts = input.mergeConflict
      ? (input.task.mergeRepairAttempts ?? 0)
      : (input.task.finalizerAttempts ?? 0);
    const limitReached = input.mergeConflict
      ? attempts >= input.config.maxRepairAttempts
      : attempts > input.config.maxRepairAttempts;

    if (limitReached && !input.hasUnrunMergeRepair) {
      return {
        shouldRequeue: false,
        reason: 'Finalize repair limit reached',
        stopReason: 'repair_limit_reached',
      };
    }

    return {
      shouldRequeue: true,
      reason: input.hasUnrunMergeRepair
        ? 'Requeued pending merge repair'
        : 'Within legacy finalize repair limit',
    };
  }

  if (input.task.finalizeRepairStoppedAt) {
    return {
      shouldRequeue: false,
      reason: input.task.finalizeRepairStopReason || 'Finalize repair already stopped',
      stopReason: input.task.finalizeRepairStopReason || 'repair_stopped',
    };
  }

  const now = input.now ?? Date.now();
  const startedAt = input.task.finalizeRepairStartedAt ?? now;
  const deadlineAt = input.task.finalizeRepairDeadlineAt ?? startedAt + (input.config.repairDeadlineSeconds * 1000);
  if (deadlineAt <= now) {
    return {
      shouldRequeue: false,
      reason: 'Finalize repair deadline exhausted',
      stopReason: 'repair_deadline_exhausted',
    };
  }

  const totalRequeues = input.task.finalizeRepairTotalRequeues ?? 0;
  if (totalRequeues >= input.config.repairHardCap) {
    return {
      shouldRequeue: false,
      reason: 'Finalize repair hard cap reached',
      stopReason: 'repair_hard_cap_reached',
    };
  }

  if (input.hasUnrunMergeRepair) {
    return {
      shouldRequeue: true,
      reason: 'Requeued pending merge repair',
    };
  }

  if ((input.task.finalizeRepairConsecutiveNoProgress ?? 0) >= input.config.maxNoProgressRepairRounds) {
    return {
      shouldRequeue: false,
      reason: 'Finalize repair made no objective progress',
      stopReason: 'repair_no_progress',
    };
  }

  return {
    shouldRequeue: true,
    reason: input.task.finalizeRepairLastProgressReason || 'Finalize repair retry allowed',
  };
}

function sanitizeCount(value: unknown, fallback: number): number {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return fallback;
  }

  return Math.floor(numericValue);
}

function detectFinalizeRepairFailureKind(
  task: Pick<Task, 'mergeConflictFiles' | 'mergeError' | 'lastError' | 'finalizerFailure'>
): FinalizeRepairFailureKind {
  if (task.mergeConflictFiles?.length || /merge conflicts detected/i.test(task.mergeError || task.lastError || '')) {
    return 'merge_conflict';
  }

  if (task.finalizerFailure?.failureKind) {
    return task.finalizerFailure.failureKind;
  }

  if (/quality gate/i.test(task.mergeError || task.lastError || '')) {
    return 'quality_gate';
  }

  return 'finalizer_error';
}

function normalizeFailureSignature(
  task: Pick<Task, 'mergeError' | 'lastError' | 'finalizerFailure'>
): string {
  if (task.finalizerFailure?.diagnosticSignature) {
    return task.finalizerFailure.diagnosticSignature.slice(0, 500);
  }

  if (task.finalizerFailure) {
    return [
      task.finalizerFailure.class,
      task.finalizerFailure.gate,
      task.finalizerFailure.packageLabel,
      task.finalizerFailure.rawMessage,
    ]
      .filter(Boolean)
      .join(' | ')
      .slice(0, 500);
  }

  return (task.mergeError || task.lastError || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function buildListSignature(entries?: string[]): string | undefined {
  if (!entries || entries.length === 0) {
    return undefined;
  }

  return [...new Set(entries)].sort().join('\n');
}

function buildConflictSignature(conflictFiles?: string[]): string | undefined {
  if (!conflictFiles || conflictFiles.length === 0) {
    return undefined;
  }

  return [...new Set(conflictFiles)].sort().join('\n');
}

function compareFinalizeRepairSnapshots(
  previous: FinalizeRepairSnapshot,
  current: FinalizeRepairSnapshot
): FinalizeRepairComparison {
  const reasons: string[] = [];
  const mergeConflictLoop = previous.failureKind === 'merge_conflict'
    && current.failureKind === 'merge_conflict';
  const hasStructuredDiagnostics = (
    previous.diagnosticCount !== undefined
    || current.diagnosticCount !== undefined
    || Boolean(previous.diagnosticSignature)
    || Boolean(current.diagnosticSignature)
  );

  if (mergeConflictLoop) {
    if (didConflictSetShrink(previous.conflictSignature, current.conflictSignature)) {
      reasons.push('conflict file set shrank');
    }
  } else if (hasStructuredDiagnostics) {
    if (
      previous.diagnosticCount !== undefined
      && current.diagnosticCount !== undefined
      && current.diagnosticCount < previous.diagnosticCount
    ) {
      reasons.push(`diagnostic count ${previous.diagnosticCount} -> ${current.diagnosticCount}`);
    }

    if (didListShrink(previous.failedFilesSignature, current.failedFilesSignature)) {
      reasons.push('failed file set shrank');
    }

    if (didListShrink(previous.failedCodesSignature, current.failedCodesSignature)) {
      reasons.push('failed diagnostic code set shrank');
    }

    if (didListShrink(previous.failedSymbolsSignature, current.failedSymbolsSignature)) {
      reasons.push('failed symbol set shrank');
    }

    if (
      previous.diagnosticSignature
      && current.diagnosticSignature
      && previous.diagnosticSignature !== current.diagnosticSignature
    ) {
      reasons.push('diagnostic signature changed');
    }

    if (previous.gate && current.gate && previous.gate !== current.gate) {
      reasons.push(`quality gate advanced ${previous.gate} -> ${current.gate}`);
    }
  } else {
    if (previous.headSha && current.headSha && previous.headSha !== current.headSha) {
      reasons.push('HEAD changed');
    }

    if (
      previous.worktreeDiffSignature
      && current.worktreeDiffSignature
      && previous.worktreeDiffSignature !== current.worktreeDiffSignature
    ) {
      reasons.push('worktree diff changed');
    }

    if (previous.changedFiles !== current.changedFiles) {
      reasons.push(`changed files ${previous.changedFiles} -> ${current.changedFiles}`);
    }

    if (previous.commitsAheadOfBase !== current.commitsAheadOfBase) {
      reasons.push(`commits ahead of base ${previous.commitsAheadOfBase} -> ${current.commitsAheadOfBase}`);
    }
  }

  if (!mergeConflictLoop && didConflictSetShrink(previous.conflictSignature, current.conflictSignature)) {
    reasons.push('conflict file set shrank');
  }

  if (getFailureKindRank(current.failureKind) > getFailureKindRank(previous.failureKind)) {
    reasons.push(`failure kind advanced ${previous.failureKind} -> ${current.failureKind}`);
  }

  return {
    hasProgress: reasons.length > 0,
    reason: reasons.join('; '),
  };
}

function didConflictSetShrink(previous?: string, current?: string): boolean {
  return didListShrink(previous, current);
}

function didListShrink(previous?: string, current?: string): boolean {
  if (!previous || !current) {
    return false;
  }

  const previousEntries = previous.split('\n').filter(Boolean);
  const currentEntries = current.split('\n').filter(Boolean);

  if (currentEntries.length >= previousEntries.length) {
    return false;
  }

  const previousSet = new Set(previousEntries);
  return currentEntries.every((entry) => previousSet.has(entry));
}

function getFailureKindRank(kind: FinalizeRepairFailureKind): number {
  switch (kind) {
    case 'merge_conflict':
      return 0;
    case 'quality_gate':
    case 'finalizer_error':
      return 1;
    default:
      return 0;
  }
}
