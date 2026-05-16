import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { findInstallRoot } from './bootstrap';
import { filterGitInternalPaths } from './git-internal-paths';
import { resolveWorkspacePackageDirs } from './workspaces';
import { PRD } from '../types/prd';
import {
  Task,
  TaskCoordinationConflict,
  TaskCoordinationPhase,
  TaskCoordinationStatus,
} from '../types/task';
import { resolveTaskIntegrationStatus } from './task-delivery';
import { resolveTaskRecoveryKind } from './auto-recovery-state';
import {
  isDependencyRepairPriority,
  resolveEffectiveDependencyPrdIdFromTask,
} from './dependency-identity';
import { pendingTaskHasHigherPriorityThanCandidate } from './scheduler-priority';
import { isQuarantineOwnershipReleased } from './quarantine';

export interface TaskCoordinationState {
  status: TaskCoordinationStatus;
  phase?: TaskCoordinationPhase;
  owner?: string;
  blockers?: string[];
  conflicts?: TaskCoordinationConflict[];
  reason?: string;
  lane?: string;
  declaredWriteSurface?: string[];
  declaredConflictDomains?: string[];
  observedWriteSurface?: string[];
  observedPackageSurface?: string[];
  surfaceCapturedAt?: string;
}

export type CoordinationOverlapMatch = TaskCoordinationConflict;

export interface CoordinationCheckResult {
  blocked: boolean;
  phase: TaskCoordinationPhase;
  status: TaskCoordinationStatus;
  blockers: string[];
  reason?: string;
  lane: string;
  matches: CoordinationOverlapMatch[];
  taskUpdates: Partial<Task>;
}

export type CoordinationBlockedError = Error & {
  blockerTaskIds: string[];
  taskUpdates?: Partial<Task>;
  coordination?: CoordinationCheckResult;
};

const BLOCKING_COORDINATION_STATUSES = new Set([
  'pending',
  'running',
  'ready_to_finalize',
  'finalizing',
  'failed_finalize',
  'completed',
]);

export function hasHotConflictReservation(task: Pick<
  Task,
  | 'repairContext'
  | 'integrationStatus'
  | 'postFinalizeMergeProbeRequired'
  | 'mergeRepairAttempts'
  | 'mergeConflictFiles'
  | 'mergeError'
  | 'lastError'
>): boolean {
  if (task.repairContext?.mode === 'merge') {
    return true;
  }

  if (task.integrationStatus === 'blocked_conflict') {
    return true;
  }

  if (task.postFinalizeMergeProbeRequired === true) {
    return true;
  }

  if (Boolean(task.mergeRepairAttempts && task.mergeRepairAttempts > 0)) {
    return true;
  }

  if (task.mergeConflictFiles && task.mergeConflictFiles.length > 0) {
    return true;
  }

  return /Merge conflicts detected/i.test(task.mergeError || task.lastError || '');
}

export function isHotConflictQuarantineOwner(task: Pick<
  Task,
  | 'status'
  | 'repairContext'
  | 'integrationStatus'
  | 'postFinalizeMergeProbeRequired'
  | 'mergeRepairAttempts'
  | 'mergeConflictFiles'
  | 'mergeError'
  | 'lastError'
  | 'quarantineExitKind'
  | 'quarantineReleasedAt'
>): boolean {
  if (isQuarantineOwnershipReleased(task)) {
    return false;
  }

  if (!hasHotConflictReservation(task)) {
    return false;
  }

  if (task.status === 'completed') {
    return task.integrationStatus === 'blocked_conflict';
  }

  return task.status === 'failed'
    || task.status === 'stagnant'
    || task.status === 'failed_finalize';
}

function normalizeSurfaceEntry(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

function normalizeSurfaceList(values?: string[]): string[] | undefined {
  if (!Array.isArray(values) || values.length === 0) {
    return undefined;
  }

  const normalized = [...new Set(
    filterGitInternalPaths(values
      .filter((value): value is string => typeof value === 'string')
      .map((value) => normalizeSurfaceEntry(value))
      .filter(Boolean))
  )].sort();

  return normalized.length > 0 ? normalized : undefined;
}

function sameRepoPath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function compareTaskOrder(left: Pick<Task, 'id' | 'enqueuedAt' | 'startTime'>, right: Pick<Task, 'id' | 'enqueuedAt' | 'startTime'>): number {
  const leftEnqueuedAt = left.enqueuedAt ?? left.startTime;
  const rightEnqueuedAt = right.enqueuedAt ?? right.startTime;

  if (leftEnqueuedAt !== rightEnqueuedAt) {
    return leftEnqueuedAt - rightEnqueuedAt;
  }

  if (left.startTime !== right.startTime) {
    return left.startTime - right.startTime;
  }

  return left.id.localeCompare(right.id);
}

function taskBlocksCoordination(task: Task): boolean {
  const hasHotReservation = hasHotConflictReservation(task);

  if (
    (
      task.baselineRepair?.repairTaskId === task.id
      || task.prdId?.startsWith('baseline-quality-gate:')
      || task.prdPath?.split(path.sep).includes('baseline-repairs')
    )
    && (
      task.baselineRepair?.status === 'superseded'
      || Boolean(task.baselineRepair?.supersededByRepairTaskId)
    )
  ) {
    return false;
  }

  if (!BLOCKING_COORDINATION_STATUSES.has(task.status)) {
    return (task.status === 'failed' || task.status === 'stagnant')
      ? isHotConflictQuarantineOwner(task)
      : false;
  }

  if (task.status === 'completed') {
    return hasHotReservation || resolveTaskIntegrationStatus(task) !== 'integrated';
  }

  return true;
}

function isBaselineRepairTask(task: Task): boolean {
  return Boolean(
    task.baselineRepair?.repairTaskId === task.id
    || task.prdId?.startsWith('baseline-quality-gate:')
    || task.prdPath?.split(path.sep).includes('baseline-repairs')
  );
}

function isSupersededBaselineRepairTask(task: Task): boolean {
  return isBaselineRepairTask(task)
    && (
      task.baselineRepair?.status === 'superseded'
      || Boolean(task.baselineRepair?.supersededByRepairTaskId)
    );
}

function isGeneratedFollowupTask(task: Task): boolean {
  return Boolean(
    task.prdId?.startsWith('followup:')
    || task.prdPath?.split(path.sep).includes('generated-prds')
  );
}

function shouldBypassCandidateForGeneratedFollowup(task: Task, candidate: Task): boolean {
  if (candidate.status === 'running' || candidate.status === 'finalizing') {
    return false;
  }

  if (candidate.followupTaskIds?.includes(task.id)) {
    return true;
  }

  return Boolean(
    isGeneratedFollowupTask(task)
    && candidate.followupTaskIds?.length
    && !hasHotConflictReservation(candidate)
  );
}

function normalizePrdId(value?: string): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function normalizePrdDependencyList(values?: string[]): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return [...new Set(values
    .map((value) => normalizePrdId(value))
    .filter((value): value is string => Boolean(value)))];
}

function getGeneratedDependencyRepairPrdIds(task: Task): string[] {
  if (!isDependencyRepairPriority(task.priorityClass)) {
    return [];
  }

  const taskPrdId = normalizePrdId(task.prdId);
  const resolvedPrdId = normalizePrdId(resolveEffectiveDependencyPrdIdFromTask(task));
  return [...new Set([
    normalizePrdId(task.repairOf?.prdId),
    ...normalizePrdDependencyList(task.releasesDependenciesFor),
    normalizePrdId(task.effectiveDependencyPrdId),
    resolvedPrdId && resolvedPrdId !== taskPrdId ? resolvedPrdId : undefined,
  ].filter((value): value is string => Boolean(value)))];
}

function isGeneratedDependencyRepairTask(task: Task): boolean {
  return getGeneratedDependencyRepairPrdIds(task).length > 0;
}

function taskDependsOnPrd(
  task: Task,
  targetPrdId: string,
  candidates: Task[],
): boolean {
  const byPrdId = new Map<string, Task>();
  for (const candidate of candidates) {
    const candidatePrdId = normalizePrdId(resolveEffectiveDependencyPrdIdFromTask(candidate));
    if (candidatePrdId && sameRepoPath(candidate.repoPath, task.repoPath)) {
      byPrdId.set(candidatePrdId, candidate);
    }
  }

  const visitedTaskIds = new Set<string>();
  const pending = [task];

  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || visitedTaskIds.has(current.id)) {
      continue;
    }
    visitedTaskIds.add(current.id);

    for (const dependencyPrdId of normalizePrdDependencyList(current.prdDependencies)) {
      if (dependencyPrdId === targetPrdId) {
        return true;
      }

      const dependencyTask = byPrdId.get(dependencyPrdId);
      if (dependencyTask && !visitedTaskIds.has(dependencyTask.id)) {
        pending.push(dependencyTask);
      }
    }
  }

  return false;
}

function shouldBypassCandidateForDependencyOrder(
  task: Task,
  candidate: Task,
  candidates: Task[],
): boolean {
  if (candidate.status !== 'pending') {
    return false;
  }

  const taskPrdId = normalizePrdId(resolveEffectiveDependencyPrdIdFromTask(task));
  if (!taskPrdId) {
    return false;
  }

  return taskDependsOnPrd(candidate, taskPrdId, candidates);
}

function isOrdinaryPendingDependencyRepairBypassCandidate(candidate: Task): boolean {
  if (candidate.status !== 'pending') {
    return false;
  }

  if (hasHotConflictReservation(candidate)) {
    return false;
  }

  return !isDependencyRepairPriority(candidate.priorityClass)
    && !isBaselineRepairTask(candidate)
    && !candidate.repairContext
    && !resolveTaskRecoveryKind(candidate);
}

function sharesDependencyRepairConflictCohort(
  taskConflictDomains: string[],
  candidate: Task,
  phase: TaskCoordinationPhase,
): boolean {
  if (taskConflictDomains.length === 0) {
    return false;
  }

  const hydratedCandidate = hydrateTaskForPhase(candidate, phase);
  const candidateConflictDomains = getEffectiveConflictDomains(hydratedCandidate, phase);
  return taskConflictDomains.some((domain) => candidateConflictDomains.includes(domain));
}

function shouldBypassCandidateForGeneratedDependencyRepair(
  task: Task,
  candidate: Task,
  candidates: Task[],
  phase: TaskCoordinationPhase,
  taskConflictDomains: string[],
): boolean {
  const repairedPrdIds = getGeneratedDependencyRepairPrdIds(task);
  if (repairedPrdIds.length === 0) {
    return false;
  }

  if (!isOrdinaryPendingDependencyRepairBypassCandidate(candidate)) {
    return false;
  }

  if (repairedPrdIds.some((repairedPrdId) => taskDependsOnPrd(candidate, repairedPrdId, candidates))) {
    return true;
  }

  return sharesDependencyRepairConflictCohort(taskConflictDomains, candidate, phase);
}

function shouldBypassCandidateForPendingPriority(task: Task, candidate: Task): boolean {
  if (isGeneratedDependencyRepairTask(task)) {
    return false;
  }

  return pendingTaskHasHigherPriorityThanCandidate(task, candidate);
}

function isActiveCoordinationConflict(task: Task): boolean {
  return task.status === 'running' || task.status === 'finalizing';
}

function shouldBypassCandidateForBaselineRepair(
  task: Task,
  candidate: Task,
  phase: TaskCoordinationPhase,
  candidates: Task[] = [],
): boolean {
  if (!isBaselineRepairTask(task)) {
    return false;
  }

  if (isSupersededBaselineRepairTask(candidate)) {
    return true;
  }

  const baselineRepair = task.baselineRepair;
  if (!baselineRepair) {
    return false;
  }

  if (candidate.status === 'running' || candidate.status === 'finalizing') {
    return false;
  }

  if (baselineRepair.demandTaskIds?.includes(candidate.id)) {
    return true;
  }

  const demandTaskIds = new Set(baselineRepair.demandTaskIds || []);
  if (
    candidate.status === 'failed_finalize'
    && isBaselineRepairTask(candidate)
    && baselineRepairWaitChainReachesDemand(candidate, demandTaskIds, candidates)
  ) {
    return true;
  }

  if (isBaselineRepairTask(candidate)) {
    return false;
  }

  if (
    (
      resolveTaskRecoveryKind(candidate) === 'baseline_repair'
      || resolveTaskRecoveryKind(candidate) === 'baseline_exhaustion'
      || resolveTaskRecoveryKind(candidate) === 'baseline_supersession_migration'
    )
    && candidate.baselineQualityGate?.repairTaskId === task.id
  ) {
    return true;
  }

  if (
    baselineRepair.repairKey
    && candidate.baselineQualityGate?.repairKey === baselineRepair.repairKey
  ) {
    return true;
  }

  // Baseline repair is a barrier task. Non-running ordinary overlap in the same
  // cohort must wait for the shared baseline repair, not block it.
  return phase === 'start' || phase === 'finalize';
}

function baselineRepairWaitChainReachesDemand(
  candidate: Task,
  demandTaskIds: Set<string>,
  candidates: Task[],
): boolean {
  if (demandTaskIds.size === 0) {
    return false;
  }

  const byId = new Map(candidates.map((task) => [task.id, task]));
  const visited = new Set<string>();
  const pending = [candidate.id];

  while (pending.length > 0) {
    const taskId = pending.shift();
    if (!taskId || visited.has(taskId)) {
      continue;
    }
    visited.add(taskId);

    if (demandTaskIds.has(taskId)) {
      return true;
    }

    const current = byId.get(taskId);
    if (!current || !isBaselineRepairTask(current)) {
      continue;
    }

    for (const nextTaskId of [
      current.baselineQualityGate?.repairTaskId,
      current.baselineRepair?.repairTaskId,
    ]) {
      if (nextTaskId && nextTaskId !== current.id && !visited.has(nextTaskId)) {
        pending.push(nextTaskId);
      }
    }
  }

  return false;
}

function isPrefixPath(prefix: string, candidate: string): boolean {
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

function findPathOverlaps(left: string[], right: string[]): string[] {
  const overlaps = new Set<string>();

  for (const leftEntry of left) {
    for (const rightEntry of right) {
      if (isPrefixPath(leftEntry, rightEntry) || isPrefixPath(rightEntry, leftEntry)) {
        overlaps.add(leftEntry.length <= rightEntry.length ? leftEntry : rightEntry);
      }
    }
  }

  return [...overlaps].sort();
}

function formatSurfaceList(values: string[]): string {
  const visibleValues = values
    .slice(0, 3)
    .map((value) => value === '<unknown-surface-during-hot-merge-repair>'
      ? 'hot merge repair surface'
      : value);
  const suffix = values.length > visibleValues.length
    ? `, +${values.length - visibleValues.length} more`
    : '';

  return `${visibleValues.join(', ')}${suffix}`;
}

export function formatCoordinationConflictSurface(match: CoordinationOverlapMatch): string {
  const parts: string[] = [];

  if (match.overlappingDomains.length > 0) {
    parts.push(`domains: ${formatSurfaceList(match.overlappingDomains)}`);
  }

  if (match.overlappingPaths.length > 0) {
    parts.push(`paths: ${formatSurfaceList(match.overlappingPaths)}`);
  }

  return parts.length > 0
    ? parts.join('; ')
    : match.overlapKinds.join(', ');
}

function formatCoordinationBlockReason(matches: CoordinationOverlapMatch[]): string {
  const ownerSummaries = matches.map((match) => (
    `${match.taskId} (${formatCoordinationConflictSurface(match)})`
  ));

  return `Earlier overlapping task(s) must integrate first: ${ownerSummaries.join(', ')}`;
}

function runGit(worktreePath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: worktreePath,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryRunGit(worktreePath: string, args: string[]): string {
  try {
    return runGit(worktreePath, args);
  } catch {
    return '';
  }
}

function readWorkspaceManifest(installRoot: string): { workspaces?: string[] | { packages?: string[] } } | null {
  const packageJsonPath = path.join(installRoot, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { workspaces?: string[] | { packages?: string[] } };
  } catch {
    return null;
  }
}

function listTrackedDiffFiles(worktreePath: string, baseCommitSha?: string): string[] {
  const args = baseCommitSha
    ? ['diff', '--name-only', baseCommitSha, '--']
    : ['diff', '--name-only', 'HEAD', '--'];

  return tryRunGit(worktreePath, args)
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function listUntrackedFiles(worktreePath: string): string[] {
  return tryRunGit(worktreePath, ['ls-files', '--others', '--exclude-standard'])
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function toIsoTimestamp(value?: number): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}

function getObservedPathSurface(task: Pick<Task, 'worktree' | 'repoPath' | 'baseCommitSha'>): {
  observedWriteSurface?: string[];
  observedPackageSurface?: string[];
} {
  if (!task.worktree || !fs.existsSync(task.worktree)) {
    return {};
  }

  const changedFiles = normalizeSurfaceList([
    ...listTrackedDiffFiles(task.worktree, task.baseCommitSha),
    ...listUntrackedFiles(task.worktree),
  ]);

  if (!changedFiles || changedFiles.length === 0) {
    return {};
  }

  const installRoot = findInstallRoot(task.worktree, task.repoPath);
  if (!installRoot) {
    return { observedWriteSurface: changedFiles };
  }

  const manifest = readWorkspaceManifest(installRoot);
  const workspaceDirs = resolveWorkspacePackageDirs(installRoot, manifest);
  if (workspaceDirs.length === 0) {
    return { observedWriteSurface: changedFiles };
  }

  const observedPackageSurface = normalizeSurfaceList(changedFiles.flatMap((changedFile) => {
    const matchingWorkspace = workspaceDirs.find((workspaceDir) => {
      const relativeWorkspacePath = normalizeSurfaceEntry(path.relative(task.worktree, workspaceDir));
      return changedFile === relativeWorkspacePath || changedFile.startsWith(`${relativeWorkspacePath}/`);
    });

    if (!matchingWorkspace) {
      return [];
    }

    return [path.relative(task.worktree, matchingWorkspace)];
  }));

  return {
    observedWriteSurface: changedFiles,
    observedPackageSurface,
  };
}

function getEffectiveConflictDomains(task: Task, phase: TaskCoordinationPhase): string[] {
  return phase === 'start'
    ? normalizeSurfaceList(task.declaredConflictDomains) ?? []
    : normalizeSurfaceList(task.declaredConflictDomains) ?? [];
}

function getEffectivePathSurface(task: Task, phase: TaskCoordinationPhase): string[] {
  const declared = task.declaredWriteSurface || [];
  const conflictFiles = task.mergeConflictFiles || [];

  return normalizeSurfaceList([
    ...declared,
    ...(task.observedWriteSurface || []),
    ...(task.observedPackageSurface || []),
    ...conflictFiles,
  ]) ?? [];
}

function hydrateTaskForPhase(task: Task, phase: TaskCoordinationPhase): Task {
  if (phase === 'start') {
    return {
      ...task,
      declaredWriteSurface: normalizeSurfaceList(task.declaredWriteSurface),
      declaredConflictDomains: normalizeSurfaceList(task.declaredConflictDomains),
    };
  }

  return {
    ...task,
    declaredWriteSurface: normalizeSurfaceList(task.declaredWriteSurface),
    declaredConflictDomains: normalizeSurfaceList(task.declaredConflictDomains),
    ...captureObservedTaskSurface(task),
  };
}

export function extractDeclaredCoordination(prd: PRD): Pick<Task, 'declaredWriteSurface' | 'declaredConflictDomains' | 'integrationLane'> {
  return {
    declaredWriteSurface: normalizeSurfaceList(prd.writeSurface),
    declaredConflictDomains: normalizeSurfaceList(prd.conflictDomains),
    integrationLane: typeof prd.integrationLane === 'string' && prd.integrationLane.trim()
      ? prd.integrationLane.trim()
      : undefined,
  };
}

export function captureObservedTaskSurface(task: Pick<Task, 'worktree' | 'repoPath' | 'baseCommitSha'>): Pick<Task, 'observedWriteSurface' | 'observedPackageSurface' | 'surfaceCapturedAt'> {
  return {
    ...getObservedPathSurface(task),
    surfaceCapturedAt: Date.now(),
  };
}

export function resolveTaskIntegrationLane(
  task: Pick<Task, 'integrationLane' | 'intendedMergeTarget' | 'mergeTargetBranch'>,
  targetBranch?: string,
): string {
  if (typeof task.integrationLane === 'string' && task.integrationLane.trim()) {
    return task.integrationLane.trim();
  }

  if (typeof targetBranch === 'string' && targetBranch.trim()) {
    return targetBranch.trim();
  }

  if (typeof task.mergeTargetBranch === 'string' && task.mergeTargetBranch.trim()) {
    return task.mergeTargetBranch.trim();
  }

  if (typeof task.intendedMergeTarget === 'string' && task.intendedMergeTarget.trim()) {
    return task.intendedMergeTarget.trim();
  }

  return 'main';
}

export function buildCoordinationState(task: Pick<
  Task,
  | 'coordinationStatus'
  | 'coordinationPhase'
  | 'coordinationBlockers'
  | 'coordinationConflicts'
  | 'coordinationReason'
  | 'integrationLane'
  | 'declaredWriteSurface'
  | 'declaredConflictDomains'
  | 'observedWriteSurface'
  | 'observedPackageSurface'
  | 'surfaceCapturedAt'
>): TaskCoordinationState | undefined {
  const hasCoordinationSignal = task.coordinationStatus !== undefined
    || task.coordinationPhase !== undefined
    || (task.coordinationBlockers && task.coordinationBlockers.length > 0)
    || task.coordinationReason !== undefined
    || (task.coordinationConflicts && task.coordinationConflicts.length > 0)
    || (task.declaredWriteSurface && task.declaredWriteSurface.length > 0)
    || (task.declaredConflictDomains && task.declaredConflictDomains.length > 0)
    || (task.observedWriteSurface && task.observedWriteSurface.length > 0)
    || (task.observedPackageSurface && task.observedPackageSurface.length > 0)
    || task.surfaceCapturedAt !== undefined;

  if (!hasCoordinationSignal) {
    return undefined;
  }

  return {
    status: task.coordinationStatus || 'clear',
    phase: task.coordinationPhase,
    owner: task.coordinationBlockers?.[0],
    blockers: task.coordinationBlockers,
    conflicts: task.coordinationConflicts,
    reason: task.coordinationReason,
    lane: task.integrationLane,
    declaredWriteSurface: task.declaredWriteSurface,
    declaredConflictDomains: task.declaredConflictDomains,
    observedWriteSurface: task.observedWriteSurface,
    observedPackageSurface: task.observedPackageSurface,
    surfaceCapturedAt: toIsoTimestamp(task.surfaceCapturedAt),
  };
}

export function findCoordinationBlockers(
  task: Task,
  candidates: Task[],
  phase: TaskCoordinationPhase,
  options: { targetBranch?: string } = {},
): CoordinationCheckResult {
  const hydratedTask = hydrateTaskForPhase(task, phase);
  const taskConflictDomains = getEffectiveConflictDomains(hydratedTask, phase);
  const taskPathSurface = getEffectivePathSurface(hydratedTask, phase);
  const taskHasKnownSurface = taskConflictDomains.length > 0 || taskPathSurface.length > 0;
  const lane = resolveTaskIntegrationLane(hydratedTask, options.targetBranch);
  const currentTaskIsGeneratedDependencyRepair = isGeneratedDependencyRepairTask(hydratedTask);
  const matches: CoordinationOverlapMatch[] = [];

  for (const candidate of candidates) {
    if (candidate.id === task.id) {
      continue;
    }

    if (!sameRepoPath(candidate.repoPath, task.repoPath)) {
      continue;
    }

    if (!taskBlocksCoordination(candidate)) {
      continue;
    }

    if (shouldBypassCandidateForBaselineRepair(task, candidate, phase, candidates)) {
      continue;
    }

    if (currentTaskIsGeneratedDependencyRepair) {
      if (shouldBypassCandidateForGeneratedDependencyRepair(
        hydratedTask,
        candidate,
        candidates,
        phase,
        taskConflictDomains,
      )) {
        continue;
      }
    } else {
      if (shouldBypassCandidateForGeneratedFollowup(task, candidate)) {
        continue;
      }

      if (shouldBypassCandidateForDependencyOrder(task, candidate, candidates)) {
        continue;
      }

      if (shouldBypassCandidateForPendingPriority(task, candidate)) {
        continue;
      }
    }

    if (!isActiveCoordinationConflict(candidate) && compareTaskOrder(candidate, task) >= 0) {
      continue;
    }

    const hydratedCandidate = hydrateTaskForPhase(candidate, phase);
    const candidateLane = resolveTaskIntegrationLane(hydratedCandidate, options.targetBranch);
    const candidateConflictDomains = getEffectiveConflictDomains(hydratedCandidate, phase);
    const candidatePathSurface = getEffectivePathSurface(hydratedCandidate, phase);
    const candidateHasHotReservation = hasHotConflictReservation(hydratedCandidate);
    const overlappingDomains = taskConflictDomains
      .filter((domain) => candidateConflictDomains.includes(domain))
      .sort();
    const overlappingPaths = findPathOverlaps(taskPathSurface, candidatePathSurface);
    const overlapKinds: Array<'conflict_domain' | 'write_surface'> = [];

    if (
      phase === 'start'
      && candidateHasHotReservation
      && candidateLane === lane
      && !taskHasKnownSurface
    ) {
      matches.push({
        taskId: candidate.id,
        overlapKinds: ['write_surface'],
        overlappingDomains: [],
        overlappingPaths: ['<unknown-surface-during-hot-merge-repair>'],
      });
      continue;
    }

    if (overlappingDomains.length > 0) {
      overlapKinds.push('conflict_domain');
    }
    if (overlappingPaths.length > 0) {
      overlapKinds.push('write_surface');
    }

    if (overlapKinds.length === 0) {
      continue;
    }

    matches.push({
      taskId: candidate.id,
      overlapKinds,
      overlappingDomains,
      overlappingPaths,
    });
  }

  const blockers = matches.map((match) => match.taskId);
  const blocked = blockers.length > 0;
  const status = blocked
    ? (phase === 'start' ? 'blocked_predicted_overlap' : 'blocked_observed_overlap')
    : 'clear';
  const reason = blocked
    ? formatCoordinationBlockReason(matches)
    : undefined;

  return {
    blocked,
    phase,
    status,
    blockers,
    reason,
    lane,
    matches,
    taskUpdates: {
      integrationLane: lane,
      declaredWriteSurface: hydratedTask.declaredWriteSurface,
      declaredConflictDomains: hydratedTask.declaredConflictDomains,
      observedWriteSurface: hydratedTask.observedWriteSurface,
      observedPackageSurface: hydratedTask.observedPackageSurface,
      surfaceCapturedAt: hydratedTask.surfaceCapturedAt,
      coordinationStatus: blocked ? status : undefined,
      coordinationPhase: blocked ? phase : undefined,
      coordinationBlockers: blocked ? blockers : undefined,
      coordinationConflicts: blocked ? matches : undefined,
      coordinationReason: blocked ? reason : undefined,
    },
  };
}

export function createCoordinationBlockedError(result: CoordinationCheckResult): CoordinationBlockedError {
  const error = new Error(result.reason || 'Task is blocked by an earlier overlapping task') as CoordinationBlockedError;
  error.blockerTaskIds = result.blockers;
  error.taskUpdates = result.taskUpdates;
  error.coordination = result;
  return error;
}

export function isCoordinationBlockedError(error: unknown): error is CoordinationBlockedError {
  return Boolean(
    error
    && typeof error === 'object'
    && 'blockerTaskIds' in error
    && Array.isArray((error as CoordinationBlockedError).blockerTaskIds)
  );
}
