export type TaskStatus = 'pending' | 'running' | 'ready_to_finalize' | 'finalizing' | 'completed' | 'failed' | 'failed_finalize' | 'stagnant';
export type TaskMergeStrategy = 'manual' | 'ours' | 'theirs';
export type StoryStatus = 'pending' | 'in_progress' | 'needs_repair' | 'passed' | 'failed';
export type FinalizeRepairFailureKind = 'merge_conflict' | 'quality_gate' | 'finalizer_error';
export type TaskRepairMode = 'finalize' | 'merge';
export type TaskAutoRecoveryKind = 'transient' | 'agent_context' | 'merge_repair' | 'finalize_repair' | 'stagnant' | 'story_repair' | 'baseline_repair';
export type TaskAutonomyRepairKind =
  | 'baseline_exhaustion'
  | 'baseline_supersession_migration'
  | 'failed_coordination_blocker'
  | 'generic_failed_worker'
  | 'stopped_merge_repair'
  | 'task_specific_finalize_repair'
  | 'deadlock_unblock';
export type TaskOperationalStatus =
  | 'queued'
  | 'running'
  | 'ready_to_finalize'
  | 'finalizing'
  | 'retrying_finalize'
  | 'repairing'
  | 'waiting_for_baseline_repair'
  | 'waiting_for_environment_repair'
  | 'needs_human_decision'
  | 'completed'
  | 'integrated';
export type FinalizeFailureClass =
  | 'quality_gate_timeout'
  | 'quality_gate_start_failure'
  | 'module_resolution'
  | 'dependency_bootstrap_environment'
  | 'toolchain_panic'
  | 'generated_type_drift'
  | 'enum_drift'
  | 'domain_type_mismatch'
  | 'typescript_diagnostics'
  | 'turbo_nested_quality_gate'
  | 'test_module_provider_drift'
  | 'deterministic_fixture_drift'
  | 'generated_artifact_missing'
  | 'quality_gate_failure'
  | 'unknown';
export type TaskErrorClass = 'transient_backend' | 'transport' | 'browser_automation' | 'agent_session' | 'semantic' | 'story_validation' | 'quality_gate' | 'merge_conflict' | 'stagnation' | 'orphaned_worker' | 'unknown';
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
  preparationCommands?: string[];
  validationCommands?: string[];
  parentCommand?: string;
  parentCwd?: string;
  exitCode?: number;
  timedOut?: boolean;
  startFailed?: boolean;
  diagnosticCount?: number;
  diagnosticSignature?: string;
  failedFiles?: string[];
  failedCodes?: string[];
  failedSymbols?: string[];
  failedTests?: string[];
  diagnostics?: FinalizeFailureDiagnostic[];
  nestedFailures?: PackageGateFailure[];
  rawMessage: string;
}

export interface PackageGateFailure {
  packageLabel: string;
  packageName?: string;
  gate: string;
  cwd: string;
  command: string;
  exitCode?: number;
  source: 'direct_package_script' | 'turbo_nested_failure' | 'root_script';
  rawMessage: string;
}

export interface FailureObservation {
  id: string;
  observedAt: number;
  kind: 'quality_gate' | 'merge_conflict' | 'finalizer_error';
  class?: FinalizeFailureClass;
  gate?: string;
  requestedGate?: string;
  packageLabel?: string;
  cwd?: string;
  command?: string;
  parentCommand?: string;
  parentCwd?: string;
  signature: string;
  rawMessage: string;
  nestedFailures?: PackageGateFailure[];
  failedFiles?: string[];
  failedTests?: string[];
  failedSymbols?: string[];
  diagnosticSignature?: string;
}

export interface TaskRepairContext {
  mode: TaskRepairMode;
  storyId: string;
  createdAt: number;
  reason: string;
}

export type BaselineQualityGateRootCause =
  | 'task_induced'
  | 'shared_baseline_code_debt'
  | 'generated_artifact_drift'
  | 'dependency_bootstrap_worktree_environment'
  | 'toolchain_flake'
  | 'unsafe_ambiguous';

export type BaselineRecoveryPhase =
  | 'classified'
  | 'task_env_self_heal'
  | 'task_env_repaired'
  | 'baseline_repair_enqueued'
  | 'waiting_for_baseline_repair'
  | 'baseline_repair_integrated'
  | 'stopped';

export interface BaselineQualityGateEnvironmentRepairState {
  attemptedAt: number;
  attempts: number;
  repaired: boolean;
  message: string;
  removedPaths?: string[];
  installRoot?: string;
  packageManager?: string;
}

export interface ToolchainEnvFingerprint {
  corepackHome?: string;
  pnpmHome?: string;
  xdgCacheHome?: string;
  prismaEnginesCacheDir?: string;
  packageManagerSpec?: string;
}

export interface BaselineQualityGateState {
  kind: 'baseline_quality_gate_failure' | 'task_quality_gate_failure' | 'baseline_probe_failed';
  failureObservationId?: string;
  observedAt: number;
  lastUpdatedAt?: number;
  targetBranch: string;
  gate: string;
  packageLabel: string;
  signature: string;
  latestFailureSignature?: string;
  taskFailureSignature?: string;
  baselineFailureSignature?: string;
  repairKey?: string;
  repairGroupKey?: string;
  repairComponentKey?: string;
  message: string;
  rootCause?: BaselineQualityGateRootCause;
  taskRootCause?: BaselineQualityGateRootCause;
  phase?: BaselineRecoveryPhase;
  confidence?: number;
  repairTaskId?: string;
  demandTaskIds?: string[];
  cycleId?: string;
  cycleTaskIds?: string[];
  supersededByRepairTaskId?: string;
  environmentFingerprint?: ToolchainEnvFingerprint;
  baselineFailure?: FinalizerFailureDetails;
  taskEnvRepair?: BaselineQualityGateEnvironmentRepairState;
  baselineEnvRepair?: BaselineQualityGateEnvironmentRepairState;
  stoppedAt?: number;
  stopReason?: string;
}

export interface BaselineRepairLinkState {
  repairKey: string;
  repairGroupKey?: string;
  repairComponentKey?: string;
  repairKeyAliases?: string[];
  coalescedFromRepairTaskIds?: string[];
  supersededByRepairTaskId?: string;
  supersededAt?: number;
  supersessionReason?: string;
  cycleId?: string;
  cycleTaskIds?: string[];
  discoveryCount?: number;
  lastDiscoveredFailureSignature?: string;
  lastDiscoveredGate?: string;
  generation?: number;
  generationStartedAt?: number;
  generationDeadlineAt?: number;
  generationTotalRequeues?: number;
  appliedRepairCommitShas?: string[];
  followupRepairTaskIds?: string[];
  lastPostRepairFailureSignature?: string;
  lastPostRepairClassification?: 'same_baseline' | 'new_baseline' | 'task_specific' | 'probe_ambiguous';
  dedicatedRepairTask?: boolean;
  rootCause?: BaselineQualityGateRootCause;
  targetBranch: string;
  gate: string;
  packageLabel: string;
  demandTaskIds: string[];
  repairTaskId?: string;
  repairPrdId?: string;
  startedAt: number;
  updatedAt: number;
  deadlineAt?: number;
  status?: 'pending' | 'waiting' | 'integrated' | 'failed' | 'superseded' | 'coalescing' | 'needs_more_repair';
  message?: string;
  appliedRepairCommitSha?: string;
  appliedRepairFiles?: string[];
  appliedToWorktreeAt?: number;
  applySkippedReason?: string;
  applyConflictFiles?: string[];
  applyReconcileAttempts?: number;
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
  worktreeReclaimedAt?: number;
  worktreeReclaimedBy?: 'manager' | 'watchdog' | 'manual';
  worktreeReclaimReason?: string;
  worktreeReclaimReportPath?: string;
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
  followupPrdIds?: string[];
  followupTaskIds?: string[];
  followupGeneratedAt?: number;
  followupReason?: string;
  followupGenerationLastSignature?: string;
  followupGenerationTotal?: number;
  followupGenerationHardCap?: number;
  autonomyRepairKind?: TaskAutonomyRepairKind;
  autonomyRepairStartedAt?: number;
  autonomyRepairDeadlineAt?: number;
  autonomyRepairTotalRequeues?: number;
  autonomyRepairConsecutiveNoProgress?: number;
  autonomyRepairLastSignature?: string;
  autonomyRepairLastProgressReason?: string;
  autonomyRepairLastRequeuedAt?: number;
  autonomyRepairNextEligibleAt?: number;
  autonomyRepairStoppedAt?: number;
  autonomyRepairStopReason?: string;
  autonomyRepairLastReason?: string;
  failedBlockerRecoveryStartedAt?: number;
  failedBlockerRecoveryDeadlineAt?: number;
  failedBlockerRecoveryTotalRequeues?: number;
  failedBlockerRecoveryLastSignature?: string;
  failedBlockerRecoveryStoppedAt?: number;
  failedBlockerRecoveryStopReason?: string;
  failedBlockerRecoveryDemandTaskIds?: string[];
  storyRepairRecoveryStartedAt?: number;
  storyRepairRecoveryDeadlineAt?: number;
  storyRepairRecoveryTotalRequeues?: number;
  storyRepairRecoveryLastSignature?: string;
  storyRepairRecoveryConsecutiveSameSignature?: number;
  storyRepairRecoveryStoppedAt?: number;
  storyRepairRecoveryStopReason?: string;
  storyRepairRecoveryDemandTaskIds?: string[];
  transientRecoveryStartedAt?: number;
  transientRecoveryDeadlineAt?: number;
  transientRecoveryTotalRequeues?: number;
  transientRecoveryConsecutiveSameSignature?: number;
  transientRecoveryLastFailureKind?: string;
  transientRecoveryLastFailureClass?: TaskErrorClass;
  transientRecoveryLastFailureSignature?: string;
  transientRecoveryLastFailureObservedAt?: number;
  transientRecoveryLastFailureStoryId?: string;
  transientRecoveryLastProgressReason?: string;
  transientRecoveryLastDelayMs?: number;
  transientRecoveryNextEligibleAt?: number;
  transientRecoveryStoppedAt?: number;
  transientRecoveryStopReason?: string;
  transientRecoveryLastRequeuedStoryId?: string;
  transientRecoveryLastHadObjectiveProgress?: boolean;
  agentContextRecoveryStartedAt?: number;
  agentContextRecoveryDeadlineAt?: number;
  agentContextRecoveryTotalRequeues?: number;
  agentContextRecoveryLastSignature?: string;
  agentContextRecoveryLastRequeuedStoryId?: string;
  agentContextRecoveryStoppedAt?: number;
  agentContextRecoveryStopReason?: string;
  finalizerCommitMessage?: string;
  finalizerCommitSha?: string;
  finalizerCommittedAt?: number;
  finalizerAttempts?: number;
  finalizerFailure?: FinalizerFailureDetails;
  latestFailure?: FailureObservation;
  failureHistory?: FailureObservation[];
  baselineQualityGate?: BaselineQualityGateState;
  baselineQualityGateHistory?: BaselineQualityGateState[];
  baselineRepair?: BaselineRepairLinkState;
  baselineRepairRole?: 'demand_task' | 'dedicated_repair_task';
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
