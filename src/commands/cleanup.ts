import { ReclamationCandidateReport, ReclamationService } from '../core/reclamation';

interface CleanupOptions {
  olderThanHours?: string;
  dryRun?: boolean;
  includeOrphans?: boolean;
  includeDirtyFailed?: boolean;
  includeDirtyOrphans?: boolean;
  archiveDirty?: boolean;
  reclaimArchivedDirty?: boolean;
  abandonRetryable?: boolean;
  repo?: string;
  maxRemovals?: string;
}

function parseNonNegativeNumber(value: string | undefined, fallback: number): number {
  const numeric = Number(value ?? fallback);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
}

function toCleanupCandidate(candidate: ReclamationCandidateReport): {
  taskId?: string;
  status?: ReclamationCandidateReport['status'];
  worktree: string;
  existed: boolean;
  removed: boolean;
  kind: ReclamationCandidateReport['kind'];
  reason?: string;
  attentionState?: ReclamationCandidateReport['attentionState'];
  decisionAction?: ReclamationCandidateReport['decisionAction'];
  evidencePath?: string;
  evidenceManifestPath?: string;
  evidenceComplete?: boolean;
} {
  return {
    taskId: candidate.taskId,
    status: candidate.status,
    worktree: candidate.worktree,
    existed: candidate.existed,
    removed: candidate.removed,
    kind: candidate.kind,
    reason: candidate.reason,
    attentionState: candidate.attentionState,
    decisionAction: candidate.decisionAction,
    evidencePath: candidate.evidencePath,
    evidenceManifestPath: candidate.evidenceManifestPath,
    evidenceComplete: candidate.evidenceComplete,
  };
}

export async function cleanupCommand(options: CleanupOptions = {}): Promise<void> {
  const olderThanHours = parseNonNegativeNumber(options.olderThanHours, 24);
  const service = new ReclamationService();
  const report = await service.run({
    mode: 'manual',
    dryRun: Boolean(options.dryRun),
    olderThanHours,
    repoPath: options.repo,
    includeOrphanWorktrees: Boolean(options.includeOrphans),
    maxRemovals: parsePositiveInteger(options.maxRemovals),
    dirtyTerminalModeOverride: options.includeDirtyFailed || options.reclaimArchivedDirty
      ? 'archive_then_reclaim'
      : options.archiveDirty
        ? 'archive_only'
        : undefined,
    dirtyOrphanModeOverride: options.includeDirtyOrphans
      ? (options.reclaimArchivedDirty ? 'archive_then_reclaim' : 'archive_only')
      : undefined,
    includeDirtyOrphanWorktrees: Boolean(options.includeDirtyOrphans),
    abandonRetryable: Boolean(options.abandonRetryable),
  });

  console.log(JSON.stringify({
    ...report,
    dryRun: Boolean(options.dryRun),
    olderThanHours,
    removed: report.removed,
    candidates: report.candidates.map(toCleanupCandidate),
    skipped: report.skipped.map(toCleanupCandidate),
  }));
}
