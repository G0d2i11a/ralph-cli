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
import {
  assertPrdHasExplicitTitle,
  assertPrdIsExecutable,
  generateTaskId,
  parsePRD,
  saveTaskPRD,
} from '../utils/helpers';
import { Task, TaskStatus } from '../types/task';
import { appendTaskEvent } from './events';
import { getRalphPaths, RalphHomeOptions } from './paths';
import { resolveEffectiveDependencyPrdIdFromPrd } from './dependency-identity';

type TaskStateStore = Pick<StateManager, 'saveTask' | 'loadTask' | 'listTasks'> & Partial<Pick<StateManager, 'getTaskDirPath'>>;

export interface EnqueueTaskOptions extends RalphHomeOptions {
  repoPath?: string;
  agent?: string;
  backend?: string;
  allowMixedHome?: boolean;
  dedupeByPrdPath?: boolean;
  allowDuplicate?: boolean;
  allowUmbrellaPrd?: boolean;
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

const COMPLETED_TASK_STATUSES = new Set<TaskStatus>(['completed']);

export interface PrdIntakeIssue {
  kind: string;
  reason: string;
  taskIds?: string[];
  prdIds?: string[];
  paths?: string[];
}

export class PrdIntakeRefusalError extends Error {
  readonly issue: PrdIntakeIssue;

  constructor(issue: PrdIntakeIssue, message: string = issue.reason) {
    super(message);
    this.name = 'PrdIntakeRefusalError';
    this.issue = issue;
  }
}

export interface PrdPreflightResult {
  prdPath: string;
  absolutePrdPath: string;
  prdId?: string;
  title?: string;
  decision: 'ready' | 'blocked' | 'skipped';
  issues: PrdIntakeIssue[];
  activeDuplicates: string[];
  completedDuplicates: string[];
  missingDependencies: string[];
  blockedBatchDependencies: string[];
  writeSurfaceOverlaps: Array<{
    taskId: string;
    paths: string[];
  }>;
}

function normalizeSurfaceEntry(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '');
}

function surfacesOverlap(left: string, right: string): boolean {
  const a = normalizeSurfaceEntry(left);
  const b = normalizeSurfaceEntry(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function findSurfaceOverlaps(left: string[] = [], right: string[] = []): string[] {
  const overlaps = new Set<string>();
  for (const leftEntry of left) {
    for (const rightEntry of right) {
      if (surfacesOverlap(leftEntry, rightEntry)) {
        overlaps.add(leftEntry.length >= rightEntry.length ? leftEntry : rightEntry);
      }
    }
  }
  return [...overlaps].sort();
}

function isSameRepoTask(task: Task, repoPath: string): boolean {
  return path.resolve(task.repoPath) === path.resolve(repoPath);
}

function isTerminalPrdStatus(status: string | undefined): boolean {
  return status === 'completed' || status === 'archived' || status === 'done';
}

function toPreflightResult(input: {
  prdPath: string;
  absolutePrdPath: string;
  prdId?: string;
  title?: string;
  issues: PrdIntakeIssue[];
  activeDuplicates?: string[];
  completedDuplicates?: string[];
  missingDependencies?: string[];
  blockedBatchDependencies?: string[];
  writeSurfaceOverlaps?: Array<{ taskId: string; paths: string[] }>;
}): PrdPreflightResult {
  const skippedKinds = new Set(['active_duplicate', 'completed_duplicate', 'stale_status', 'umbrella', 'parse_error']);
  const blockedKinds = new Set(['missing_dependency', 'blocked_batch_dependency', 'write_surface_overlap']);
  const hasBlockedIssue = input.issues.some((issue) => blockedKinds.has(issue.kind));
  const hasSkippedIssue = input.issues.some((issue) => skippedKinds.has(issue.kind));

  return {
    prdPath: input.prdPath,
    absolutePrdPath: input.absolutePrdPath,
    prdId: input.prdId,
    title: input.title,
    decision: hasSkippedIssue ? 'skipped' : hasBlockedIssue ? 'blocked' : 'ready',
    issues: input.issues,
    activeDuplicates: input.activeDuplicates ?? [],
    completedDuplicates: input.completedDuplicates ?? [],
    missingDependencies: input.missingDependencies ?? [],
    blockedBatchDependencies: input.blockedBatchDependencies ?? [],
    writeSurfaceOverlaps: input.writeSurfaceOverlaps ?? [],
  };
}

export function listPrdFiles(prdDir: string): string[] {
  if (!fs.existsSync(prdDir)) {
    throw new Error(`PRD directory not found: ${prdDir}`);
  }

  const files: string[] = [];
  for (const entry of fs.readdirSync(prdDir, { withFileTypes: true })) {
    const entryPath = path.join(prdDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listPrdFiles(entryPath));
      continue;
    }

    if (entry.isFile() && /\.(json|md|markdown)$/i.test(entry.name)) {
      files.push(entryPath);
    }
  }

  return files.sort();
}

export async function assessPrdPaths(
  prdPaths: string[],
  options: {
    repoPath?: string;
    stateManager?: TaskStateStore;
    allowUmbrellaPrd?: boolean;
  } = {},
): Promise<PrdPreflightResult[]> {
  const repoPath = path.resolve(options.repoPath || process.cwd());
  const stateManager = options.stateManager ?? new StateManager();
  const tasks = await stateManager.listTasks();
  const parsed = prdPaths.map((prdPath) => {
    const absolutePrdPath = path.resolve(prdPath);
    try {
      assertPrdHasExplicitTitle(absolutePrdPath);
      const prd = parsePRD(absolutePrdPath);
      return { prdPath, absolutePrdPath, prd };
    } catch (error) {
      return {
        prdPath,
        absolutePrdPath,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  const batchPrdIds = new Set(parsed.map((entry) => entry.prd?.id).filter((id): id is string => Boolean(id)));

  return parsed.map((entry) => {
    if (!entry.prd) {
      return toPreflightResult({
        prdPath: entry.prdPath,
        absolutePrdPath: entry.absolutePrdPath,
        issues: [{ kind: 'parse_error', reason: entry.error ?? 'Unable to parse PRD' }],
      });
    }

    const { prd } = entry;
    const issues: PrdIntakeIssue[] = [];
    const activeDuplicates: string[] = [];
    const completedDuplicates: string[] = [];
    const missingDependencies: string[] = [];
    const blockedBatchDependencies: string[] = [];
    const writeSurfaceOverlaps: Array<{ taskId: string; paths: string[] }> = [];

    if (!options.allowUmbrellaPrd) {
      try {
        assertPrdIsExecutable(prd, entry.absolutePrdPath);
      } catch (error) {
        issues.push({
          kind: 'umbrella',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const task of tasks) {
      if (!isSameRepoTask(task, repoPath)) {
        continue;
      }

      const samePrd = task.prdId === prd.id || path.resolve(task.prdPath) === entry.absolutePrdPath;
      if (samePrd && ACTIVE_TASK_STATUSES.has(task.status)) {
        activeDuplicates.push(task.id);
      }
      if (samePrd && COMPLETED_TASK_STATUSES.has(task.status)) {
        completedDuplicates.push(task.id);
      }

      if (ACTIVE_TASK_STATUSES.has(task.status) || task.status === 'running' || task.status === 'ready_to_finalize' || task.status === 'finalizing') {
        const overlapPaths = findSurfaceOverlaps(prd.writeSurface, [
          ...(task.declaredWriteSurface ?? []),
          ...(task.observedWriteSurface ?? []),
        ]);
        if (overlapPaths.length > 0) {
          writeSurfaceOverlaps.push({ taskId: task.id, paths: overlapPaths });
        }
      }
    }

    if (activeDuplicates.length > 0) {
      issues.push({
        kind: 'active_duplicate',
        reason: 'An active task already exists for this PRD.',
        taskIds: activeDuplicates,
      });
    }

    if (completedDuplicates.length > 0) {
      issues.push({
        kind: 'completed_duplicate',
        reason: 'A completed task already exists for this PRD.',
        taskIds: completedDuplicates,
      });
    }

    if (isTerminalPrdStatus(prd.status)) {
      issues.push({
        kind: 'stale_status',
        reason: `PRD status is ${prd.status}.`,
      });
    }

    for (const dependency of prd.dependencies ?? []) {
      const dependencyTask = tasks.find((task) => (
        isSameRepoTask(task, repoPath)
        && task.prdId === dependency
        && task.status === 'completed'
        && (task.integratedAt || task.integrationCommitSha || task.mergedAt || task.mergeCommitSha || task.integrationStatus === 'integrated')
      ));
      if (dependencyTask) {
        continue;
      }

      if (batchPrdIds.has(dependency)) {
        blockedBatchDependencies.push(dependency);
      } else {
        missingDependencies.push(dependency);
      }
    }

    if (missingDependencies.length > 0) {
      issues.push({
        kind: 'missing_dependency',
        reason: 'Required dependency PRDs are not integrated or present in this batch.',
        prdIds: missingDependencies,
      });
    }

    if (blockedBatchDependencies.length > 0) {
      issues.push({
        kind: 'blocked_batch_dependency',
        reason: 'Required dependency PRDs are in this batch and must be enqueued first.',
        prdIds: blockedBatchDependencies,
      });
    }

    if (writeSurfaceOverlaps.length > 0) {
      issues.push({
        kind: 'write_surface_overlap',
        reason: 'PRD write surface overlaps active work.',
        taskIds: writeSurfaceOverlaps.map((overlap) => overlap.taskId),
      });
    }

    return toPreflightResult({
      prdPath: entry.prdPath,
      absolutePrdPath: entry.absolutePrdPath,
      prdId: prd.id,
      title: prd.title,
      issues,
      activeDuplicates,
      completedDuplicates,
      missingDependencies,
      blockedBatchDependencies,
      writeSurfaceOverlaps,
    });
  });
}

export function summarizePrdFolderPreflight(prdDir: string, results: PrdPreflightResult[]) {
  const stale = results.filter((result) => (
    result.issues.some((issue) => issue.kind === 'stale_status')
    || result.completedDuplicates.length > 0
  ));

  return {
    path: prdDir,
    ok: results.every((result) => result.decision === 'ready') && stale.length === 0,
    total: results.length,
    ready: results.filter((result) => result.decision === 'ready'),
    blocked: results.filter((result) => result.decision === 'blocked'),
    skipped: results.filter((result) => result.decision === 'skipped'),
    stale,
    activeDuplicates: results.filter((result) => result.activeDuplicates.length > 0),
    completedDuplicates: results.filter((result) => result.completedDuplicates.length > 0),
  };
}

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
  if (!options.allowUmbrellaPrd) {
    try {
      assertPrdIsExecutable(prd, resolvedPrdPath);
    } catch (error) {
      throw new PrdIntakeRefusalError({
        kind: 'umbrella',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const declaredCoordination = extractDeclaredCoordination(prd);
  const effectiveDependencyPrdId = resolveEffectiveDependencyPrdIdFromPrd(prd);
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
    priorityClass: prd.priorityClass,
    repairOf: prd.repairOf,
    releasesDependenciesFor: prd.releasesDependenciesFor,
    schedulerHints: prd.schedulerHints,
    effectiveDependencyPrdId: effectiveDependencyPrdId !== prd.id
      ? effectiveDependencyPrdId
      : undefined,
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
