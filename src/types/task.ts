export type TaskStatus = 'pending' | 'running' | 'ready_to_finalize' | 'finalizing' | 'completed' | 'failed' | 'failed_finalize' | 'stagnant';
export type TaskMergeStrategy = 'manual' | 'ours' | 'theirs';
export type StoryStatus = 'pending' | 'in_progress' | 'needs_repair' | 'passed' | 'failed';
export type FinalizeRepairFailureKind = 'merge_conflict' | 'quality_gate' | 'finalizer_error';

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
  conflictSignature?: string;
  capturedAt: number;
}

export interface Task {
  id: string;
  prdPath: string;
  prdId?: string;
  prdTitle?: string;
  prdDependencies?: string[];
  prdSourceHash?: string;
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
  // Stagnation detection
  loopCount: number;
  consecutiveNoProgress: number;
  consecutiveErrors: number;
  lastProgressTime: number;
  lastError?: string;
  lastFilesChanged: number;
  finalizerCommitMessage?: string;
  finalizerCommitSha?: string;
  finalizerCommittedAt?: number;
  finalizerAttempts?: number;
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
  integrationCommitSha?: string;
  integrationBranch?: string;
  integrationWorktree?: string;
  targetSyncedAt?: number;
  targetSyncDeferredReason?: string;
  mergeCommitSha?: string;
  mergeTargetBranch?: string;
  mergeStrategy?: TaskMergeStrategy;
  mergeMessage?: string;
  mergeError?: string;
  mergeConflictFiles?: string[];
  mergeConflictAt?: number;
  mergeRepairAttempts?: number;
  mergeRepairBranch?: string;
  mergeRepairWorktree?: string;
}
