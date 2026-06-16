import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { PRD } from '../types/prd';
import type { Task } from '../types/task';

export const DEPENDENCY_REPAIR_PRIORITY_CLASS = 'dependency_repair';
const gitCommonDirCache = new Map<string, string | undefined>();

export interface DependencyRepairIdentity {
  priorityClass: typeof DEPENDENCY_REPAIR_PRIORITY_CLASS;
  repairOf: {
    prdId: string;
    taskId?: string;
    reason?: string;
  };
  releasesDependenciesFor: string[];
  effectiveDependencyPrdId: string;
}

function normalizeIdentity(value?: string): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function canonicalizePath(value: string): string {
  const resolved = path.resolve(value);

  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function isDependencyRepairPriority(priorityClass?: string): boolean {
  return priorityClass === DEPENDENCY_REPAIR_PRIORITY_CLASS;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function resolveGitCommonDir(repoPath: string): string | undefined {
  const cacheKey = canonicalizePath(repoPath);
  if (gitCommonDirCache.has(cacheKey)) {
    return gitCommonDirCache.get(cacheKey);
  }

  try {
    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: cacheKey,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    if (!commonDir) {
      gitCommonDirCache.set(cacheKey, undefined);
      return undefined;
    }

    const resolvedCommonDir = canonicalizePath(path.isAbsolute(commonDir)
      ? commonDir
      : path.resolve(cacheKey, commonDir));
    gitCommonDirCache.set(cacheKey, resolvedCommonDir);
    return resolvedCommonDir;
  } catch {
    gitCommonDirCache.set(cacheKey, undefined);
    return undefined;
  }
}

export function sameRepoPath(left?: string, right?: string): boolean {
  if (!left || !right) {
    return false;
  }

  const resolvedLeft = canonicalizePath(left);
  const resolvedRight = canonicalizePath(right);

  if (resolvedLeft === resolvedRight) {
    return true;
  }

  const leftCommonDir = resolveGitCommonDir(resolvedLeft);
  const rightCommonDir = resolveGitCommonDir(resolvedRight);

  return Boolean(leftCommonDir && rightCommonDir && leftCommonDir === rightCommonDir);
}

function isHardCapRepairReason(value?: string): boolean {
  return /(?:^|_)hard_cap_reached$/i.test(value || '');
}

export function resolveEffectiveDependencyPrdIdFromPrd(prd: Pick<
  PRD,
  'id' | 'priorityClass' | 'repairOf' | 'releasesDependenciesFor'
>): string {
  if (!isDependencyRepairPriority(prd.priorityClass)) {
    return prd.id;
  }

  return normalizeIdentity(prd.repairOf?.prdId)
    ?? normalizeIdentity(prd.releasesDependenciesFor?.[0])
    ?? prd.id;
}

export function resolveEffectiveDependencyPrdIdFromTask(task: Pick<
  Task,
  'prdId' | 'priorityClass' | 'repairOf' | 'releasesDependenciesFor' | 'effectiveDependencyPrdId'
>): string | undefined {
  if (!isDependencyRepairPriority(task.priorityClass)) {
    return normalizeIdentity(task.prdId);
  }

  return normalizeIdentity(task.repairOf?.prdId)
    ?? normalizeIdentity(task.releasesDependenciesFor?.[0])
    ?? normalizeIdentity(task.effectiveDependencyPrdId)
    ?? normalizeIdentity(task.prdId);
}

function explicitDependencyRepairIdentity(task: Pick<
  Task,
  'id' | 'prdId' | 'priorityClass' | 'repairOf' | 'releasesDependenciesFor' | 'effectiveDependencyPrdId'
>): DependencyRepairIdentity | undefined {
  const repairedPrdId = normalizeIdentity(task.repairOf?.prdId)
    ?? normalizeIdentity(task.releasesDependenciesFor?.[0])
    ?? (isDependencyRepairPriority(task.priorityClass)
      ? normalizeIdentity(task.effectiveDependencyPrdId)
      : undefined);

  if (!repairedPrdId) {
    return undefined;
  }

  if (
    !isDependencyRepairPriority(task.priorityClass)
    && !task.repairOf
    && (!task.releasesDependenciesFor || task.releasesDependenciesFor.length === 0)
  ) {
    return undefined;
  }

  return {
    priorityClass: DEPENDENCY_REPAIR_PRIORITY_CLASS,
    repairOf: {
      prdId: repairedPrdId,
      taskId: normalizeIdentity(task.repairOf?.taskId),
      reason: normalizeIdentity(task.repairOf?.reason),
    },
    releasesDependenciesFor: uniqueStrings([
      repairedPrdId,
      ...(task.releasesDependenciesFor || []),
    ]),
    effectiveDependencyPrdId: repairedPrdId,
  };
}

function isGeneratedPrdPathForSource(task: Pick<Task, 'prdPath'>, source: Pick<Task, 'id'>): boolean {
  return typeof task.prdPath === 'string'
    && task.prdPath.includes('/generated-prds/')
    && task.prdPath.includes(`/${source.id}/`);
}

function legacyFollowupRepairIdentity(
  task: Task,
  candidates: Task[],
): DependencyRepairIdentity | undefined {
  if (
    task.status !== 'pending'
    && task.status !== 'running'
    && task.status !== 'ready_to_finalize'
    && task.status !== 'finalizing'
    && task.status !== 'failed_finalize'
    && task.status !== 'completed'
  ) {
    return undefined;
  }

  for (const source of candidates) {
    if (source.id === task.id || !sameRepoPath(source.repoPath, task.repoPath)) {
      continue;
    }

    const sourcePrdId = normalizeIdentity(source.prdId);
    if (!sourcePrdId || (source.status !== 'failed' && source.status !== 'stagnant')) {
      continue;
    }

    const linkedByTaskId = source.followupTaskIds?.includes(task.id) === true;
    const linkedByPrdId = Boolean(task.prdId && source.followupPrdIds?.includes(task.prdId));
    const linkedByPath = isGeneratedPrdPathForSource(task, source);
    if (!linkedByTaskId && !linkedByPrdId && !linkedByPath) {
      continue;
    }

    const reason = normalizeIdentity(source.followupReason)
      ?? normalizeIdentity(source.storyRepairRecoveryStopReason)
      ?? normalizeIdentity(source.failedBlockerRecoveryStopReason)
      ?? normalizeIdentity(source.autoRecoveryStopReason);
    if (!isHardCapRepairReason(reason)) {
      continue;
    }

    return {
      priorityClass: DEPENDENCY_REPAIR_PRIORITY_CLASS,
      repairOf: {
        prdId: sourcePrdId,
        taskId: source.id,
        reason,
      },
      releasesDependenciesFor: [sourcePrdId],
      effectiveDependencyPrdId: sourcePrdId,
    };
  }

  return undefined;
}

export function inferDependencyRepairIdentityFromTask(
  task: Task,
  candidates: Task[] = [],
): DependencyRepairIdentity | undefined {
  return explicitDependencyRepairIdentity(task) ?? legacyFollowupRepairIdentity(task, candidates);
}

export function buildDependencyRepairIdentityUpdates(
  task: Task,
  candidates: Task[] = [],
): Partial<Task> | undefined {
  const identity = inferDependencyRepairIdentityFromTask(task, candidates);
  if (!identity) {
    return undefined;
  }

  const updates: Partial<Task> = {};
  if (task.priorityClass !== identity.priorityClass) {
    updates.priorityClass = identity.priorityClass;
  }
  if (task.repairOf?.prdId !== identity.repairOf.prdId || task.repairOf?.taskId !== identity.repairOf.taskId) {
    updates.repairOf = identity.repairOf;
  }
  if ((task.releasesDependenciesFor || []).join('\n') !== identity.releasesDependenciesFor.join('\n')) {
    updates.releasesDependenciesFor = identity.releasesDependenciesFor;
  }
  if (task.effectiveDependencyPrdId !== identity.effectiveDependencyPrdId) {
    updates.effectiveDependencyPrdId = identity.effectiveDependencyPrdId;
  }

  return Object.keys(updates).length > 0 ? updates : undefined;
}
