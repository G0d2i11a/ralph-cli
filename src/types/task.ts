export type TaskStatus = 'pending' | 'running' | 'ready_to_finalize' | 'finalizing' | 'completed' | 'failed' | 'failed_finalize' | 'stagnant';

export interface Task {
  id: string;
  prdPath: string;
  status: TaskStatus;
  startTime: number;
  endTime?: number;
  currentUS?: string;
  completedUS: string[];
  worktree: string;
  logPath: string;
  pid?: number;
  agent: string;
  repoPath: string;
  // Stagnation detection
  loopCount: number;
  consecutiveNoProgress: number;
  consecutiveErrors: number;
  lastProgressTime: number;
  lastError?: string;
  lastFilesChanged: number;
  finalizerCommitMessage?: string;
  finalizerCommittedAt?: number;
}
