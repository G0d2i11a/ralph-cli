import { createHash } from 'crypto';
import {
  MergeProofSourceKind,
  MergeResult,
  MergeabilityProbeResult,
  WorktreeMergeStateKind,
} from './merge';
import {
  TaskMergeRepairDisplayStatus,
  TaskMergeRepairProof,
  TaskMergeStrategy,
  TaskTargetSyncStatus,
} from '../types/task';

function deriveTargetSyncStatus(result: Pick<MergeResult, 'targetSynced' | 'targetSyncMessage'>): TaskTargetSyncStatus | undefined {
  if (result.targetSynced === true) {
    return 'synced';
  }

  if (result.targetSynced === false) {
    if (/disabled/i.test(result.targetSyncMessage || '')) {
      return 'disabled';
    }

    if (/sync deferred/i.test(result.targetSyncMessage || '')) {
      return 'deferred_dirty_checkout';
    }

    return 'failed';
  }

  return undefined;
}

export function deriveMergeRepairDisplayStatus(
  probeResult: Pick<MergeabilityProbeResult, 'mergeable' | 'alreadyIntegrated' | 'sourceKind' | 'worktreeMergeState'>,
): TaskMergeRepairDisplayStatus {
  if (probeResult.worktreeMergeState?.kind === 'resolved_pending_commit') {
    return 'resolved_pending_finalize';
  }

  if (probeResult.alreadyIntegrated || probeResult.mergeable) {
    return probeResult.sourceKind === 'resolved_pending_merge'
      ? 'resolved_pending_finalize'
      : 'probe_mergeable';
  }

  return 'unresolved';
}

export function buildMergeRepairProof(
  probeResult: Pick<
    MergeabilityProbeResult,
    'message' | 'conflictFiles' | 'integrationBranch' | 'sourceKind' | 'worktreeMergeState'
  >,
  observedAt = Date.now(),
): TaskMergeRepairProof {
  return {
    observedAt,
    sourceKind: probeResult.sourceKind,
    worktreeMergeKind: probeResult.worktreeMergeState?.kind,
    message: probeResult.message,
    conflictFiles: probeResult.conflictFiles,
    changedFiles: probeResult.worktreeMergeState?.changedFiles,
    integrationBranch: probeResult.integrationBranch,
  };
}

export function buildMergeRepairObservationSignature(
  probeResult: Pick<
    MergeabilityProbeResult,
    'mergeable' | 'alreadyIntegrated' | 'message' | 'conflictFiles' | 'integrationBranch' | 'sourceKind' | 'worktreeMergeState'
  >,
): string {
  const payload = {
    mergeable: probeResult.mergeable,
    alreadyIntegrated: probeResult.alreadyIntegrated,
    sourceKind: (probeResult.sourceKind || 'branch_head') as MergeProofSourceKind,
    integrationBranch: probeResult.integrationBranch || '',
    message: probeResult.message || '',
    conflictFiles: [...new Set(probeResult.conflictFiles || [])].sort(),
    worktreeMergeKind: (probeResult.worktreeMergeState?.kind || 'none') as WorktreeMergeStateKind,
    headSha: probeResult.worktreeMergeState?.headSha || '',
    statusSignature: probeResult.worktreeMergeState?.statusSignature || '',
    changedFiles: [...new Set(probeResult.worktreeMergeState?.changedFiles || [])].sort(),
    unmergedFiles: [...new Set(probeResult.worktreeMergeState?.unmergedFiles || [])].sort(),
  };

  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function buildSuccessfulMergeTaskUpdates(
  result: MergeResult,
  targetBranch: string,
  strategy: TaskMergeStrategy,
) {
  const targetSyncStatus = deriveTargetSyncStatus(result);

  return {
    mergedAt: Date.now(),
    integratedAt: Date.now(),
    integrationStatus: 'integrated' as const,
    mergeCommitSha: result.commitSha,
    integrationCommitSha: result.commitSha,
    integrationBranch: result.integrationBranch,
    integrationWorktree: result.integrationWorktree,
    mergeTargetBranch: targetBranch,
    mergeStrategy: strategy,
    mergeMessage: result.message,
    mergeError: undefined,
    mergeConflictFiles: undefined,
    mergeConflictAt: undefined,
    postFinalizeMergeProbeRequired: undefined,
    targetSyncedAt: result.targetSynced ? Date.now() : undefined,
    targetSyncStatus,
    targetSyncDeferredReason: result.targetSynced === false ? result.targetSyncMessage : undefined,
    coordinationStatus: undefined,
    coordinationPhase: undefined,
    coordinationBlockers: undefined,
    coordinationReason: undefined,
    mergeRepairDisplayStatus: undefined,
    mergeRepairProof: undefined,
    mergeRepairRecoveryLastObservationSignature: undefined,
  };
}

export function buildFailedMergeTaskUpdates(
  result: MergeResult,
  targetBranch: string,
  strategy: TaskMergeStrategy,
) {
  return {
    mergedAt: undefined,
    integratedAt: undefined,
    mergeCommitSha: undefined,
    integrationCommitSha: undefined,
    mergeTargetBranch: targetBranch,
    mergeStrategy: strategy,
    mergeMessage: undefined,
    mergeError: result.message,
    integrationStatus: result.hasConflicts ? 'blocked_conflict' as const : 'failed' as const,
    integrationBranch: result.integrationBranch,
    integrationWorktree: result.integrationWorktree,
    postFinalizeMergeProbeRequired: result.hasConflicts ? true : undefined,
    targetSyncedAt: undefined,
    targetSyncStatus: 'not_requested' as const,
    targetSyncDeferredReason: undefined,
    mergeConflictFiles: result.conflictFiles,
    mergeConflictAt: result.hasConflicts ? Date.now() : undefined,
    coordinationStatus: undefined,
    coordinationPhase: undefined,
    coordinationBlockers: undefined,
    coordinationReason: undefined,
    mergeRepairDisplayStatus: result.hasConflicts ? 'unresolved' as const : undefined,
  };
}
