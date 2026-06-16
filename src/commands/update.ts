import { StateManager } from '../core/state';
import { updateTaskPRDStory } from '../utils/helpers';

interface UpdateOptions {
  passes?: boolean;
  notes?: string;
  storyId?: string;
}

export async function updateCommand(taskId: string, options: UpdateOptions) {
  const stateManager = new StateManager();

  try {
    if (!options.storyId) {
      console.error(JSON.stringify({ error: '--story-id is required' }));
      process.exit(1);
    }

    const task = await stateManager.loadTask(taskId);
    if (!task) {
      console.error(JSON.stringify({ error: `Task ${taskId} not found` }));
      process.exit(1);
    }

    const prd = updateTaskPRDStory(task, options.storyId, {
      passes: options.passes,
      notes: options.notes,
    });
    const story = prd.userStories.find((entry) => entry.id === options.storyId);

    if (!story) {
      throw new Error(`Story ${options.storyId} not found in PRD`);
    }

    const completedUS = new Set(task.completedUS);
    const updatedAt = Date.now();
    const progressEvidence = options.notes || 'Marked passing via ralph update';
    const storyProgress = task.storyProgress?.map((progress) => {
      if (progress.id !== options.storyId) {
        return progress;
      }

      if (options.passes === true) {
        return {
          ...progress,
          status: 'passed' as const,
          lastEvidence: progressEvidence,
          updatedAt,
          history: [
            ...(progress.history || []),
            {
              attempt: progress.attempts,
              status: 'passed' as const,
              message: progressEvidence,
              evidence: progressEvidence,
              updatedAt,
            },
          ],
        };
      }

      if (options.passes === false) {
        return {
          ...progress,
          status: 'pending' as const,
          lastEvidence: undefined,
          updatedAt,
          history: [
            ...(progress.history || []),
            {
              attempt: progress.attempts,
              status: 'pending' as const,
              message: options.notes || 'Marked not passing via ralph update',
              updatedAt,
            },
          ],
        };
      }

      return progress;
    });

    if (options.passes === true) {
      completedUS.add(options.storyId);
    } else if (options.passes === false) {
      completedUS.delete(options.storyId);
    }

    await stateManager.updateTask(taskId, {
      completedUS: [...completedUS],
      storyProgress,
    });

    console.log(JSON.stringify({
      success: true,
      taskId,
      storyId: options.storyId,
      passes: story.passes,
      notes: story.notes
    }));
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    }));
    process.exit(1);
  }
}
