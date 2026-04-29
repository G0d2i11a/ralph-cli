import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { ConfigManager } from '../config/manager';
import { resolveAgentBackend, resolveAgentType, resolveConfiguredBackend } from './agent';
import { assertRalphHomeIsolation } from './home-isolation';
import { extractDeclaredCoordination } from './task-coordination';
import { TaskScheduler, PendingTaskState } from './scheduler';
import { StateManager } from './state';
import { assertPrdHasExplicitTitle, generateTaskId, parsePRD, saveTaskPRD } from '../utils/helpers';
import { Task, TaskStatus } from '../types/task';
import { appendTaskEvent } from './events';
import { getRalphPaths, RalphHomeOptions } from './paths';

type TaskStateStore = Pick<StateManager, 'saveTask' | 'loadTask' | 'listTasks'> & Partial<Pick<StateManager, 'getTaskDirPath'>>;

export interface EnqueueTaskOptions extends RalphHomeOptions {
  repoPath?: string;
  agent?: string;
  backend?: string;
  allowMixedHome?: boolean;
  dedupeByPrdPath?: boolean;
  allowDuplicate?: boolean;
  stateManager?: TaskStateStore;
  scheduler?: TaskScheduler;
  configManager?: Pick<ConfigManager, 'get'> & Partial<Pick<ConfigManager, 'has'>>;
  now?: () => number;
}

export interface EnqueueTaskResult {
  taskId: string;
  latestTask: Task;
  pendingState: PendingTaskState | null;
  alreadyExists: boolean;
}

const ACTIVE_TASK_STATUSES = new Set<TaskStatus>([
  'pending',
  'running',
  'ready_to_finalize',
  'finalizing',
  'failed_finalize',
]);

function hashFile(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function runGit(repoPath: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return undefined;
  }
}

function resolveBaseRef(repoPath: string): { baseRef?: string; baseCommitSha?: string } {
  const currentBranch = runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const baseCommitSha = runGit(repoPath, ['rev-parse', 'HEAD']);

  return {
    baseRef: currentBranch && currentBranch !== 'HEAD' ? currentBranch : baseCommitSha,
    baseCommitSha,
  };
}

function resolveIntendedMergeTarget(configManager: Pick<ConfigManager, 'get'>): string {
  const configuredTarget = configManager.get('merge.targetBranch');
  return typeof configuredTarget === 'string' && configuredTarget.trim()
    ? configuredTarget.trim()
    : 'main';
}

async function findActiveDuplicateTask(input: {
  stateManager: TaskStateStore;
  repoPath: string;
  prdId: string;
  prdPath: string;
}): Promise<Task | null> {
  const resolvedRepoPath = path.resolve(input.repoPath);
  const resolvedPrdPath = path.resolve(input.prdPath);
  const tasks = await input.stateManager.listTasks();

  for (const task of tasks) {
    if (!ACTIVE_TASK_STATUSES.has(task.status)) {
      continue;
    }

    if (path.resolve(task.repoPath) !== resolvedRepoPath) {
      continue;
    }

    if (task.prdId === input.prdId || path.resolve(task.prdPath) === resolvedPrdPath) {
      return task;
    }
  }

  return null;
}

export async function enqueueTaskFromPrd(
  prdPath: string,
  options: EnqueueTaskOptions = {}
): Promise<EnqueueTaskResult> {
  const resolvedPrdPath = path.resolve(prdPath);
  const repoPath = path.resolve(options.repoPath || process.cwd());
  const agent = resolveAgentType(options.agent);
  const configManager = options.configManager ?? new ConfigManager(options);
  const backend = options.backend
    ? resolveAgentBackend(options.backend)
    : resolveConfiguredBackend(configManager);
  const stateManager = options.stateManager ?? new StateManager(options);
  const schedulerStateManager = stateManager instanceof StateManager
    ? stateManager
    : new StateManager(options);
  const scheduler = options.scheduler ?? new TaskScheduler({
    stateManager: schedulerStateManager,
    ralphHome: options.ralphHome,
    homeDir: options.homeDir,
  });
  const now = options.now ?? (() => Date.now());

  await assertRalphHomeIsolation({
    repoPath,
    ralphHome: options.ralphHome,
    homeDir: options.homeDir,
    allowMixedHome: options.allowMixedHome,
    stateManager,
    operation: 'enqueue tasks',
  });

  assertPrdHasExplicitTitle(resolvedPrdPath);
  const prd = parsePRD(resolvedPrdPath);
  const declaredCoordination = extractDeclaredCoordination(prd);
  const sourceHash = hashFile(resolvedPrdPath);
  const base = resolveBaseRef(repoPath);
  const enqueuedAt = now();

  if (!options.allowDuplicate) {
    const existingTask = await findActiveDuplicateTask({
      stateManager,
      repoPath,
      prdId: prd.id,
      prdPath: resolvedPrdPath,
    });

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
  const logDir = typeof stateManager.getTaskDirPath === 'function'
    ? stateManager.getTaskDirPath(taskId)
    : path.join(getRalphPaths(options).tasksDir, taskId);
  const logPath = path.join(logDir, 'agent.log');
  const eventLogPath = path.join(logDir, 'events.jsonl');

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const task: Task = {
    id: taskId,
    prdPath: resolvedPrdPath,
    prdId: prd.id,
    prdTitle: prd.title,
    prdDependencies: prd.dependencies || [],
    prdSourceHash: sourceHash,
    declaredWriteSurface: declaredCoordination.declaredWriteSurface,
    declaredConflictDomains: declaredCoordination.declaredConflictDomains,
    integrationLane: declaredCoordination.integrationLane,
    enqueuedAt,
    baseRef: base.baseRef,
    baseCommitSha: base.baseCommitSha,
    intendedMergeTarget: resolveIntendedMergeTarget(configManager),
    status: 'pending',
    startTime: enqueuedAt,
    completedUS: [],
    storyProgress: prd.userStories.map((story) => ({
      id: story.id,
      status: 'pending',
      attempts: 0,
      updatedAt: enqueuedAt,
    })),
    worktree: '',
    logPath,
    eventLogPath,
    agent,
    backend,
    repoPath,
    loopCount: 0,
    consecutiveNoProgress: 0,
    consecutiveErrors: 0,
    lastProgressTime: enqueuedAt,
    lastFilesChanged: 0,
  };

  saveTaskPRD(task, prd);
  await stateManager.saveTask(task);
  appendTaskEvent(task, {
    type: 'task_enqueued',
    message: `Task enqueued for PRD ${prd.id}`,
    data: {
      prdId: prd.id,
      repoPath,
      baseRef: task.baseRef,
      baseCommitSha: task.baseCommitSha,
      dependencies: task.prdDependencies,
    },
  });
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
