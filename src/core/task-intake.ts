import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveAgentType } from './agent';
import { TaskScheduler, PendingTaskState } from './scheduler';
import { StateManager } from './state';
import { generateTaskId, parsePRD } from '../utils/helpers';
import { Task } from '../types/task';

export interface EnqueueTaskOptions {
  repoPath?: string;
  agent?: string;
  dedupeByPrdPath?: boolean;
  stateManager?: StateManager;
  scheduler?: TaskScheduler;
  now?: () => number;
}

export interface EnqueueTaskResult {
  taskId: string;
  latestTask: Task;
  pendingState: PendingTaskState | null;
  alreadyExists: boolean;
}

export async function enqueueTaskFromPrd(
  prdPath: string,
  options: EnqueueTaskOptions = {}
): Promise<EnqueueTaskResult> {
  const resolvedPrdPath = path.resolve(prdPath);
  const repoPath = path.resolve(options.repoPath || process.cwd());
  const agent = resolveAgentType(options.agent);
  const stateManager = options.stateManager ?? new StateManager();
  const scheduler = options.scheduler ?? new TaskScheduler({ stateManager });
  const now = options.now ?? (() => Date.now());

  parsePRD(resolvedPrdPath);

  if (options.dedupeByPrdPath) {
    const existingTask = await stateManager.getTaskByPrdPath(resolvedPrdPath);

    if (existingTask) {
      return {
        taskId: existingTask.id,
        latestTask: existingTask,
        pendingState: existingTask.status === 'pending'
          ? await scheduler.describePendingTask(existingTask)
          : null,
        alreadyExists: true,
      };
    }
  }

  const taskId = generateTaskId();
  const logDir = path.join(os.homedir(), '.ralph', 'tasks', taskId);
  const logPath = path.join(logDir, 'agent.log');

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const task: Task = {
    id: taskId,
    prdPath: resolvedPrdPath,
    status: 'pending',
    startTime: now(),
    completedUS: [],
    worktree: '',
    logPath,
    agent,
    repoPath,
    loopCount: 0,
    consecutiveNoProgress: 0,
    consecutiveErrors: 0,
    lastProgressTime: now(),
    lastFilesChanged: 0,
  };

  await stateManager.saveTask(task);
  await scheduler.schedulePendingTasks();

  const latestTask = await stateManager.loadTask(taskId);
  if (!latestTask) {
    throw new Error(`Task ${taskId} not found after scheduling`);
  }

  return {
    taskId,
    latestTask,
    pendingState: latestTask.status === 'pending'
      ? await scheduler.describePendingTask(latestTask)
      : null,
    alreadyExists: false,
  };
}
