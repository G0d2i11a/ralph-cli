export type TaskStatus = 'pending' | 'running' | 'ready_to_finalize' | 'finalizing' | 'completed' | 'failed' | 'failed_finalize' | 'stagnant';
export type TaskMergeStrategy = 'manual' | 'ours' | 'theirs';
export type StoryStatus = 'pending' | 'in_progress' | 'needs_repair' | 'passed' | 'failed';
export type FinalizeRepairFailureKind = 'merge_conflict' | 'quality_gate' | 'finalizer_error';
export type TaskRepairMode = 'finalize' | 'merge';
export type TaskAutoRecoveryKind = 'transient' | 'merge_repair' | 'finalize_repair' | 'stagnant' | 'story_repair';
export type FinalizeFailureClass =
  | 'quality_gate_timeout'
  | 'quality_gate_start_failure'
  | 'generated_type_drift'
  | 'enum_drift'
  | 'domain_type_mismatch'
  | 'typescript_diagnostics'
  | 'quality_gate_failure'
  | 'unknown';
export type TaskErrorClass = 'transient_backend' | 'transport' | 'browser_automation' | 'semantic' | 'quality_gate' | 'merge_conflict' | 'stagnation' | 'unknown';
export type TaskIntegrationStatus = 'not_started' | 'integrated' | 'blocked_conflict' | 'failed';
export type TaskTargetSyncStatus = 'not_requested' | 'synced' | 'deferred_dirty_checkout' | 'disabled' | 'failed';
export type TaskCoordinationStatus = 'clear' | 'blocked_predicted_overlap' | 'blocked_observed_overlap';
export type TaskCoordinationPhase = 'start' | 'finalize' | 'merge';
export type TaskMergeRepairDisplayStatus = 'unresolved' | 'resolved_pending_finalize' | 'probe_mergeable' | 'requeued' | 'stopped';
export type TaskMergeProofSourceKind = 'branch_head' | 'worktree_snapshot' | 'resolved_pending_merge';
export type TaskWorktreeMergeStateKind = 'none' | 'unresolved' | 'resolved_pending_commit';
export type TaskMergeConflictPhase = 'integration_sync' | 'source_merge' | 'worktree_unresolved';

export interface StoryProgress {
  id: string;
  status: StoryStatus;
  attempts: number;
  history?: Array<{
    attempt: number;
    status: StoryStatus;
    message?: string;
    evidence?: string;
    updatedAt: number;
  }>;
  lastEvidence?: string;
  lastError?: string;
  updatedAt: number;
}

export interface FinalizeRepairSnapshot {
  headSha?: string;
  commitsAheadOfBase: number;
  changedFiles: number;
  worktreeDiffSignature: string;
  failureKind: FinalizeRepairFailureKind;
  failureSignature: string;
  failureClass?: FinalizeFailureClass;
  gate?: string;
  packageLabel?: string;
  diagnosticCount?: number;
  diagnosticSignature?: string;
  failedFilesSignature?: string;
  failedCodesSignature?: string;
  failedSymbolsSignature?: string;
  conflictSignature?: string;
  capturedAt: number;
}

export interface FinalizeFailureDiagnostic {
  file?: string;
  line?: number;
  column?: number;
  severity: 'error' | 'warning';
  code?: string;
  symbol?: string;
  message: string;
}

export interface FinalizerFailureDetails {
  failureKind: FinalizeRepairFailureKind;
  class: FinalizeFailureClass;
  gate: string;
  requestedGate: string;
  packageLabel: string;
  cwd: string;
  command: string;
  exitCode?: number;
  timedOut?: boolean;
  startFailed?: boolean;
  diagnosticCount?: number;
  diagnosticSignature?: string;
  failedFiles?: string[];
  failedCodes?: string[];
  failedSymbols?: string[];
  diagnostics?: FinalizeFailureDiagnostic[];
  rawMessage: string;
}

export interface TaskRepairContext {
  mode: TaskRepairMode;
  storyId: string;
  createdAt: number;
  reason: string;
}

export interface TaskMergeRepairProof {
  observedAt: number;
  sourceKind?: TaskMergeProofSourceKind;
  worktreeMergeKind?: TaskWorktreeMergeStateKind;
  failurePhase?: TaskMergeConflictPhase;
  message: string;
  conflictFiles?: string[];
  changedFiles?: string[];
  integrationBranch?: string;
}

export interface Task {
  id: string;
  prdPath: string;
  prdId?: string;
  prdTitle?: string;
  prdDependencies?: string[];
  prdSourceHash?: string;
  declaredWriteSurface?: string[];
  declaredConflictDomains?: string[];
  integrationLane?: string;
  enqueuedAt?: number;
  baseRef?: string;
  intendedMergeTarget?: string;
  status: TaskStatus;
  revision?: number;
  updatedAt?: number;
  startTime: number;
  endTime?: number;
  currentUS?: string;
  completedUS: string[];
  storyProgress?: StoryProgress[];
  worktree: string;
  logPath: string;
  eventLogPath?: string;
  pid?: number;
  leaseOwner?: string;
  leaseHeartbeatAt?: number;
  leaseExpiresAt?: number;
  agent: string;
  backend?: string;
  repoPath: string;
  baseCommitSha?: string;
  sessionId?: string;
  threadId?: string;
  threadStoryId?: string;
  // Stagnation detection
  loopCount: number;
  consecutiveNoProgress: number;
  consecutiveErrors: number;
  lastProgressTime: number;
  lastError?: string;
  lastErrorKind?: string;
  lastErrorClass?: TaskErrorClass;
  lastErrorRetryable?: boolean;
  lastErrorObservedAt?: number;
  lastErrorSignature?: string;
  lastErrorHadObjectiveProgress?: boolean;
  lastFilesChanged: number;
  transientRetryCount?: number;
  transientRetryBudget?: number;
  transientRetryLastDelayMs?: number;
  autoRecoveryKind?: TaskAutoRecoveryKind;
  autoRecoveryTotalRequeues?: number;
  autoRecoveryHardCap?: number;
  autoRecoveryLastRequeuedAt?: number;
  autoRecoveryNextEligibleAt?: number;
  autoRecoveryStoppedAt?: number;
  autoRecoveryStopReason?: string;
  autoRecoveryLastReason?: string;
  failedBlockerRecoveryStartedAt?: number;
  failedBlockerRecoveryDeadlineAt?: number;
  failedBlockerRecoveryTotalRequeues?: number;
  failedBlockerRecoveryLastSignature?: string;
  failedBlockerRecoveryStoppedAt?: number;
  failedBlockerRecoveryStopReason?: string;
  failedBlockerRecoveryDemandTaskIds?: string[];
  transientRecoveryStartedAt?: number;
  transientRecoveryDeadlineAt?: number;
  transientRecoveryTotalRequeues?: number;
  transientRecoveryConsecutiveSameSignature?: number;
  transientRecoveryLastFailureKind?: string;
  transientRecoveryLastFailureClass?: TaskErrorClass;
  transientRecoveryLastFailureSignature?: string;
  transientRecoveryLastDelayMs?: number;
  transientRecoveryNextEligibleAt?: number;
  transientRecoveryStoppedAt?: number;
  transientRecoveryStopReason?: string;
  transientRecoveryLastRequeuedStoryId?: string;
  transientRecoveryLastHadObjectiveProgress?: boolean;
  finalizerCommitMessage?: string;
  finalizerCommitSha?: string;
  finalizerCommittedAt?: number;
  finalizerAttempts?: number;
  finalizerFailure?: FinalizerFailureDetails;
  repairContext?: TaskRepairContext;
  finalizeRepairStartedAt?: number;
  finalizeRepairDeadlineAt?: number;
  finalizeRepairLastFailureSnapshot?: FinalizeRepairSnapshot;
  finalizeRepairLastProgressAt?: number;
  finalizeRepairLastProgressReason?: string;
  finalizeRepairConsecutiveNoProgress?: number;
  finalizeRepairTotalRequeues?: number;
  finalizeRepairStoppedAt?: number;
  finalizeRepairStopReason?: string;
  mergedAt?: number;
  integratedAt?: number;
  integrationStatus?: TaskIntegrationStatus;
  integrationCommitSha?: string;
  integrationBranch?: string;
  integrationWorktree?: string;
  targetSyncedAt?: number;
  targetSyncStatus?: TaskTargetSyncStatus;
  targetSyncDeferredReason?: string;
  observedWriteSurface?: string[];
  observedPackageSurface?: string[];
  surfaceCapturedAt?: number;
  coordinationStatus?: TaskCoordinationStatus;
  coordinationPhase?: TaskCoordinationPhase;
  coordinationBlockers?: string[];
  coordinationReason?: string;
  mergeCommitSha?: string;
  mergeTargetBranch?: string;
  mergeStrategy?: TaskMergeStrategy;
  mergeMessage?: string;
  mergeError?: string;
  mergeConflictFiles?: string[];
  mergeConflictPhase?: TaskMergeConflictPhase;
  mergeConflictAt?: number;
  mergeRepairAttempts?: number;
  mergeRepairBranch?: string;
  mergeRepairWorktree?: string;
  mergeRepairDisplayStatus?: TaskMergeRepairDisplayStatus;
  mergeRepairProof?: TaskMergeRepairProof;
  mergeRepairRecoveryStartedAt?: number;
  mergeRepairRecoveryDeadlineAt?: number;
  mergeRepairRecoveryTotalRequeues?: number;
  mergeRepairRecoveryConsecutiveNoProgress?: number;
  mergeRepairRecoveryLastObservationSignature?: string;
  mergeRepairRecoveryLastConflictSignature?: string;
  mergeRepairRecoveryLastProbeMessage?: string;
  mergeRepairRecoveryLastProgressReason?: string;
  mergeRepairRecoveryStoppedAt?: number;
  mergeRepairRecoveryStopReason?: string;
  postFinalizeMergeProbeRequired?: boolean;
}
