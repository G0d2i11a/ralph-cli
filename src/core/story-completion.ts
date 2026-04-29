import { Task, StoryStatus } from '../types/task';

export interface StoryCompletionIssue {
  id: string;
  status: StoryStatus | 'missing';
  attempts: number;
  completed: boolean;
}

export interface StoryCompletionSummary {
  allStoriesPassed: boolean;
  totalStories: number;
  incompleteStories: StoryCompletionIssue[];
}

export function evaluateTaskStoryCompletion(
  task: Pick<Task, 'completedUS' | 'storyProgress'>,
  expectedStoryIds?: string[],
): StoryCompletionSummary {
  const completedStories = new Set(task.completedUS || []);
  const storyProgress = task.storyProgress || [];
  const progressById = new Map(storyProgress.map((story) => [story.id, story]));
  const trackedIds = expectedStoryIds && expectedStoryIds.length > 0
    ? expectedStoryIds
    : storyProgress.map((story) => story.id);
  const uniqueTrackedIds = [...new Set(trackedIds)];

  const incompleteStories = uniqueTrackedIds
    .map((storyId) => {
      const progress = progressById.get(storyId);
      const status = progress?.status ?? 'missing';
      const attempts = progress?.attempts ?? 0;
      const completed = completedStories.has(storyId);

      if (status === 'passed' && completed) {
        return null;
      }

      return {
        id: storyId,
        status,
        attempts,
        completed,
      };
    })
    .filter((story): story is StoryCompletionIssue => Boolean(story));

  return {
    allStoriesPassed: incompleteStories.length === 0,
    totalStories: uniqueTrackedIds.length,
    incompleteStories,
  };
}

export function formatStoryCompletionInvariantMessage(
  taskId: string,
  phase: 'finalize' | 'integrate',
  summary: StoryCompletionSummary,
): string {
  const details = summary.incompleteStories
    .slice(0, 5)
    .map((story) => `${story.id}:${story.status}:${story.attempts}`)
    .join(', ');
  const suffix = summary.incompleteStories.length > 5
    ? ` (+${summary.incompleteStories.length - 5} more)`
    : '';

  return `Task ${taskId} cannot ${phase}: ${summary.incompleteStories.length}/${summary.totalStories} stories are incomplete (${details}${suffix})`;
}

export function buildStoryCompletionInvariantFailureUpdates(
  message: string,
  observedAt = Date.now(),
): Partial<Task> {
  return {
    integrationStatus: 'failed',
    mergeError: message,
    mergeConflictFiles: undefined,
    mergeConflictAt: undefined,
    targetSyncStatus: 'not_requested',
    targetSyncDeferredReason: undefined,
    coordinationStatus: undefined,
    coordinationPhase: undefined,
    coordinationBlockers: undefined,
    coordinationReason: undefined,
    lastError: message,
    lastErrorKind: 'story_incomplete',
    lastErrorClass: 'semantic',
    lastErrorRetryable: false,
    lastErrorObservedAt: observedAt,
    lastErrorSignature: undefined,
    lastErrorHadObjectiveProgress: undefined,
    autoRecoveryNextEligibleAt: undefined,
    autoRecoveryStoppedAt: observedAt,
    autoRecoveryStopReason: 'story_incomplete',
    autoRecoveryLastReason: message,
  };
}
