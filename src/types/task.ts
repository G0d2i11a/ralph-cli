export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'stagnant';

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
}
