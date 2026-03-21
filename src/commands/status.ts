import { ConfigManager } from '../config/manager';
import { StateManager } from '../core/state';
import { isProcessRunning, formatDuration, loadTaskPRD, STAGNATION_THRESHOLDS } from '../utils/helpers';

interface StatusOptions {
  detailed?: boolean;
}

export async function statusCommand(taskId?: string, options?: StatusOptions): Promise<void> {
  try {
    const stateManager = new StateManager();
    const configManager = new ConfigManager();

    if (!taskId) {
      const tasks = await stateManager.listTasks('running');
      console.log(JSON.stringify({
        tasks: tasks.map((task) => ({
          id: task.id,
          status: task.status,
          currentUS: task.currentUS,
          completedUS: task.completedUS.length,
          backend: task.backend,
          duration: formatDuration(Date.now() - task.startTime),
          running: task.pid ? isProcessRunning(task.pid) : false,
        }))
      }));
      return;
    }

    const task = await stateManager.loadTask(taskId);

    if (!task) {
      console.error(JSON.stringify({ error: `Task ${taskId} not found` }));
      process.exit(1);
    }

    const running = task.pid ? isProcessRunning(task.pid) : false;
    const duration = task.endTime
      ? formatDuration(task.endTime - task.startTime)
      : formatDuration(Date.now() - task.startTime);

    const basicStatus = {
      id: task.id,
      status: task.status,
      agent: task.agent,
      backend: task.backend,
      prdPath: task.prdPath,
      worktree: task.worktree,
      logPath: task.logPath,
      currentUS: task.currentUS,
      completedUS: task.completedUS,
      sessionId: task.sessionId,
      threadId: task.threadId,
      duration,
      running,
      pid: task.pid,
    };

    if (!options?.detailed) {
      console.log(JSON.stringify(basicStatus));
      return;
    }

    let userStories: import('../types/prd').UserStory[] = [];

    try {
      userStories = loadTaskPRD(task).userStories;
    } catch {
      userStories = [];
    }

    const completedStoryIds = new Set(task.completedUS);
    const completedStories = userStories.filter((story) => completedStoryIds.has(story.id) || story.passes).length;
    const totalStories = userStories.length;

    const loopCount = task.loopCount || 0;
    const consecutiveNoProgress = task.consecutiveNoProgress || 0;
    const consecutiveErrors = task.consecutiveErrors || 0;

    let isAtRisk = false;
    let riskReason: string | null = null;
    const configuredStagnationTimeoutSeconds = Number(configManager.get('runner.stagnationTimeout'));
    const configuredStagnationTimeoutMs = Number.isFinite(configuredStagnationTimeoutSeconds) && configuredStagnationTimeoutSeconds > 0
      ? configuredStagnationTimeoutSeconds * 1000
      : undefined;

    if (configuredStagnationTimeoutMs && Date.now() - task.lastProgressTime >= configuredStagnationTimeoutMs * 0.8) {
      isAtRisk = true;
      riskReason = `No progress for ${Math.floor((Date.now() - task.lastProgressTime) / 1000)}s (threshold: ${Math.floor(configuredStagnationTimeoutMs / 1000)}s)`;
    } else if (consecutiveNoProgress >= STAGNATION_THRESHOLDS.NO_PROGRESS_THRESHOLD - 1) {
      isAtRisk = true;
      riskReason = `No file changes for ${consecutiveNoProgress} consecutive updates (threshold: ${STAGNATION_THRESHOLDS.NO_PROGRESS_THRESHOLD})`;
    } else if (consecutiveErrors >= STAGNATION_THRESHOLDS.CONSECUTIVE_ERRORS_THRESHOLD - 1) {
      isAtRisk = true;
      riskReason = `${consecutiveErrors} consecutive errors (threshold: ${STAGNATION_THRESHOLDS.CONSECUTIVE_ERRORS_THRESHOLD})`;
    }

    console.log(JSON.stringify({
      ...basicStatus,
      progress: {
        completed: completedStories,
        total: totalStories,
        percentage: totalStories > 0 ? Math.round((completedStories / totalStories) * 100) : 0,
      },
      userStories: userStories.map((story) => ({
        id: story.id,
        title: story.title,
        passes: completedStoryIds.has(story.id) || Boolean(story.passes),
        priority: story.priority,
        notes: story.notes,
      })),
      stagnation: {
        loopCount,
        consecutiveNoProgress,
        consecutiveErrors,
        lastError: task.lastError,
        isAtRisk,
        riskReason,
      }
    }));
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    }));
    process.exit(1);
  }
}
