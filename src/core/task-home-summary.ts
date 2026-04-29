import { Task } from '../types/task';

const ACTIVE_QUEUE_STATUSES = new Set([
  'pending',
  'running',
  'ready_to_finalize',
  'finalizing',
  'failed_finalize',
]);

export function summarizeActiveRepoPaths(tasks: Task[]): {
  repoCount: number;
  mixedRepos: boolean;
  repoPaths: string[];
} {
  const repoPaths = [...new Set(
    tasks
      .filter((task) => ACTIVE_QUEUE_STATUSES.has(task.status))
      .map((task) => task.repoPath)
      .filter(Boolean)
      .sort()
  )];

  return {
    repoCount: repoPaths.length,
    mixedRepos: repoPaths.length > 1,
    repoPaths,
  };
}
