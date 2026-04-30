import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PRD } from '../types/prd';
import { Task, TaskStatus } from '../types/task';
import { assertPrdHasExplicitTitle, parsePRD } from '../utils/helpers';
import { PrdIntakeRefusalError, assertPrdCanBeEnqueued } from './prd-intake-policy';
import {
  CoordinationOverlapMatch,
  extractDeclaredCoordination,
  findCoordinationBlockers,
} from './task-coordination';
import { resolveTaskIntegrationStatus } from './task-delivery';

type PreflightStateStore = {
  listTasks(): Promise<Task[]>;
};

export type PrdPreflightDecision = 'ready' | 'blocked' | 'skipped';

export type PrdPreflightIssueKind =
  | 'invalid'
  | 'stale_status'
  | 'umbrella'
  | 'active_duplicate'
  | 'completed_duplicate'
  | 'batch_duplicate'
  | 'missing_dependency'
  | 'blocked_batch_dependency'
  | 'write_surface_overlap';

export interface PrdPreflightIssue {
  kind: PrdPreflightIssueKind;
  severity: 'blocked' | 'skipped';
  message: string;
  taskId?: string;
  taskIds?: string[];
  prdId?: string;
  dependencyIds?: string[];
  overlaps?: CoordinationOverlapMatch[];
}

export interface PrdPreflightResult {
  prdPath: string;
  absolutePrdPath: string;
  prdId?: string;
  title?: string;
  decision: PrdPreflightDecision;
  issues: PrdPreflightIssue[];
  activeDuplicates: string[];
  completedDuplicates: string[];
  missingDependencies: string[];
  blockedBatchDependencies: string[];
  writeSurfaceOverlaps: CoordinationOverlapMatch[];
}

export interface PrdFolderPreflightSummary {
  path: string;
  ok: boolean;
  total: number;
  ready: PrdPreflightResult[];
  blocked: PrdPreflightResult[];
  skipped: PrdPreflightResult[];
  stale: PrdPreflightResult[];
  activeDuplicates: PrdPreflightResult[];
  completedDuplicates: PrdPreflightResult[];
  missingDependencies: PrdPreflightResult[];
  writeSurfaceOverlaps: PrdPreflightResult[];
  files: PrdPreflightResult[];
}

export interface AssessPrdPathsOptions {
  repoPath: string;
  stateManager: PreflightStateStore;
  allowDuplicate?: boolean;
  allowUmbrellaPrd?: boolean;
  now?: () => number;
}

const ACTIVE_TASK_STATUSES = new Set<TaskStatus>([
  'pending',
  'running',
  'ready_to_finalize',
  'finalizing',
  'failed_finalize',
]);

const PRD_FILE_EXTENSIONS = new Set(['.json', '.md', '.markdown']);

function hashFile(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sameRepo(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function samePrdPath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function hasIssue(candidate: MutablePreflightCandidate): boolean {
  return candidate.issues.length > 0;
}

function hasSkippedIssue(candidate: MutablePreflightCandidate): boolean {
  return candidate.issues.some((issue) => issue.severity === 'skipped');
}

function hasBlockedIssue(candidate: MutablePreflightCandidate): boolean {
  return candidate.issues.some((issue) => issue.severity === 'blocked');
}

function isClearlySameCompletedPrd(task: Task, input: {
  repoPath: string;
  prdPath: string;
  prd: PRD;
  sourceHash: string;
}): boolean {
  if (task.status !== 'completed') {
    return false;
  }

  if (!sameRepo(task.repoPath, input.repoPath)) {
    return false;
  }

  if (samePrdPath(task.prdPath, input.prdPath)) {
    return true;
  }

  if (task.prdId !== input.prd.id) {
    return false;
  }

  if (task.prdSourceHash) {
    return task.prdSourceHash === input.sourceHash;
  }

  return true;
}

function taskMatchesPrd(task: Task, input: { repoPath: string; prdPath: string; prdId: string }): boolean {
  return sameRepo(task.repoPath, input.repoPath)
    && (task.prdId === input.prdId || samePrdPath(task.prdPath, input.prdPath));
}

function findActiveDuplicateTasks(tasks: Task[], input: {
  repoPath: string;
  prdPath: string;
  prdId: string;
}): Task[] {
  return tasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status) && taskMatchesPrd(task, input));
}

function findCompletedDuplicateTasks(tasks: Task[], input: {
  repoPath: string;
  prdPath: string;
  prd: PRD;
  sourceHash: string;
}): Task[] {
  return tasks.filter((task) => isClearlySameCompletedPrd(task, input));
}

function sameRepoTaskExistsForPrdId(tasks: Task[], repoPath: string, prdId: string): boolean {
  return tasks.some((task) => sameRepo(task.repoPath, repoPath) && task.prdId === prdId);
}

function createSkippedIssue(kind: PrdPreflightIssueKind, message: string, extras: Partial<PrdPreflightIssue> = {}): PrdPreflightIssue {
  return {
    kind,
    severity: 'skipped',
    message,
    ...extras,
  };
}

function createBlockedIssue(kind: PrdPreflightIssueKind, message: string, extras: Partial<PrdPreflightIssue> = {}): PrdPreflightIssue {
  return {
    kind,
    severity: 'blocked',
    message,
    ...extras,
  };
}

function intakeRefusalToIssue(error: PrdIntakeRefusalError): PrdPreflightIssue {
  if (error.issue.kind === 'umbrella') {
    return createSkippedIssue('umbrella', error.message, { taskId: error.issue.taskId });
  }

  if (error.issue.kind === 'stale_history') {
    return createSkippedIssue('completed_duplicate', error.message, { taskId: error.issue.taskId });
  }

  return createSkippedIssue('stale_status', error.message, { taskId: error.issue.taskId });
}

function createSyntheticTask(candidate: MutablePreflightCandidate, index: number, now: number): Task {
  const declaredCoordination = candidate.prd
    ? extractDeclaredCoordination(candidate.prd)
    : {};

  return {
    id: `batch:${candidate.prdId || path.basename(candidate.absolutePrdPath)}:${index}`,
    prdPath: candidate.absolutePrdPath,
    prdId: candidate.prdId,
    prdTitle: candidate.title,
    prdDependencies: candidate.prd?.dependencies || [],
    declaredWriteSurface: declaredCoordination.declaredWriteSurface,
    declaredConflictDomains: declaredCoordination.declaredConflictDomains,
    integrationLane: declaredCoordination.integrationLane,
    enqueuedAt: now + index,
    status: 'pending',
    startTime: now + index,
    completedUS: [],
    worktree: '',
    logPath: '',
    eventLogPath: '',
    agent: 'codex',
    repoPath: candidate.repoPath,
    loopCount: 0,
    consecutiveNoProgress: 0,
    consecutiveErrors: 0,
    lastProgressTime: now + index,
    lastFilesChanged: 0,
  };
}

function issueSignature(candidates: MutablePreflightCandidate[]): string {
  return candidates
    .map((candidate) => `${candidate.absolutePrdPath}:${candidate.issues.map((issue) => `${issue.kind}:${issue.taskId || ''}:${issue.taskIds?.join(',') || ''}:${issue.dependencyIds?.join(',') || ''}`).join('|')}`)
    .join('\n');
}

interface MutablePreflightCandidate {
  inputPath: string;
  absolutePrdPath: string;
  repoPath: string;
  prd?: PRD;
  prdId?: string;
  title?: string;
  sourceHash?: string;
  issues: PrdPreflightIssue[];
  activeDuplicates: string[];
  completedDuplicates: string[];
  missingDependencies: string[];
  blockedBatchDependencies: string[];
  writeSurfaceOverlaps: CoordinationOverlapMatch[];
}

function resetDynamicIssues(candidate: MutablePreflightCandidate): void {
  candidate.issues = candidate.issues.filter((issue) => (
    issue.kind !== 'blocked_batch_dependency'
    && issue.kind !== 'write_surface_overlap'
  ));
  candidate.blockedBatchDependencies = [];
  candidate.writeSurfaceOverlaps = [];
}

function addMissingDependencyIssues(
  candidates: MutablePreflightCandidate[],
  tasks: Task[],
): void {
  const candidatesByPrdId = new Map<string, MutablePreflightCandidate[]>();

  for (const candidate of candidates) {
    if (!candidate.prdId || hasSkippedIssue(candidate)) {
      continue;
    }

    const existing = candidatesByPrdId.get(candidate.prdId) || [];
    existing.push(candidate);
    candidatesByPrdId.set(candidate.prdId, existing);
  }

  for (const candidate of candidates) {
    if (!candidate.prd || hasSkippedIssue(candidate)) {
      continue;
    }

    const missingDependencies = (candidate.prd.dependencies || []).filter((depId) => (
      !sameRepoTaskExistsForPrdId(tasks, candidate.repoPath, depId)
      && !candidatesByPrdId.has(depId)
    ));

    if (missingDependencies.length === 0) {
      continue;
    }

    candidate.missingDependencies = missingDependencies;
    candidate.issues.push(createBlockedIssue(
      'missing_dependency',
      `Missing dependency PRD(s): ${missingDependencies.join(', ')}`,
      { dependencyIds: missingDependencies },
    ));
  }
}

function addWriteSurfaceOverlapIssues(
  candidates: MutablePreflightCandidate[],
  tasks: Task[],
  now: number,
): void {
  const blockingTasks = [...tasks];

  candidates.forEach((candidate, index) => {
    if (!candidate.prd || hasIssue(candidate)) {
      return;
    }

    const syntheticTask = createSyntheticTask(candidate, index, now);
    const coordination = findCoordinationBlockers(syntheticTask, blockingTasks, 'start');

    if (coordination.blocked) {
      candidate.writeSurfaceOverlaps = coordination.matches;
      candidate.issues.push(createBlockedIssue(
        'write_surface_overlap',
        coordination.reason || `Write surface overlaps earlier task(s): ${coordination.blockers.join(', ')}`,
        {
          taskIds: coordination.blockers,
          overlaps: coordination.matches,
        },
      ));
      return;
    }

    blockingTasks.push(syntheticTask);
  });
}

function addBlockedBatchDependencyIssues(candidates: MutablePreflightCandidate[], tasks: Task[]): void {
  for (const candidate of candidates) {
    if (!candidate.prd || hasSkippedIssue(candidate) || hasBlockedIssue(candidate)) {
      continue;
    }

    const blockedDependencies = (candidate.prd.dependencies || []).filter((depId) => {
      if (sameRepoTaskExistsForPrdId(tasks, candidate.repoPath, depId)) {
        return false;
      }

      const batchDependencies = candidates.filter((entry) => entry.prdId === depId);
      return batchDependencies.length > 0 && !batchDependencies.some((entry) => !hasIssue(entry));
    });

    if (blockedDependencies.length === 0) {
      continue;
    }

    candidate.blockedBatchDependencies = blockedDependencies;
    candidate.issues.push(createBlockedIssue(
      'blocked_batch_dependency',
      `Batch dependency PRD(s) are not eligible to enqueue: ${blockedDependencies.join(', ')}`,
      { dependencyIds: blockedDependencies },
    ));
  }
}

function applyDynamicIssues(candidates: MutablePreflightCandidate[], tasks: Task[], now: number): void {
  let previousSignature = '';

  for (let attempt = 0; attempt <= candidates.length; attempt++) {
    candidates.forEach(resetDynamicIssues);
    addWriteSurfaceOverlapIssues(candidates, tasks, now);
    addBlockedBatchDependencyIssues(candidates, tasks);

    const nextSignature = issueSignature(candidates);
    if (nextSignature === previousSignature) {
      return;
    }

    previousSignature = nextSignature;
  }
}

function toPreflightResult(candidate: MutablePreflightCandidate): PrdPreflightResult {
  const skipped = hasSkippedIssue(candidate);
  const blocked = hasBlockedIssue(candidate);

  return {
    prdPath: candidate.inputPath,
    absolutePrdPath: candidate.absolutePrdPath,
    prdId: candidate.prdId,
    title: candidate.title,
    decision: skipped ? 'skipped' : blocked ? 'blocked' : 'ready',
    issues: candidate.issues,
    activeDuplicates: candidate.activeDuplicates,
    completedDuplicates: candidate.completedDuplicates,
    missingDependencies: candidate.missingDependencies,
    blockedBatchDependencies: candidate.blockedBatchDependencies,
    writeSurfaceOverlaps: candidate.writeSurfaceOverlaps,
  };
}

function prdSortKey(filePath: string): string {
  return path.basename(filePath).toLowerCase();
}

export function listPrdFiles(prdDir: string): string[] {
  const resolvedDir = path.resolve(prdDir);

  if (!fs.existsSync(resolvedDir)) {
    throw new Error(`PRD folder does not exist: ${resolvedDir}`);
  }

  const stats = fs.statSync(resolvedDir);
  if (!stats.isDirectory()) {
    throw new Error(`PRD path is not a folder: ${resolvedDir}`);
  }

  return fs.readdirSync(resolvedDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && PRD_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(resolvedDir, entry.name))
    .sort((left, right) => prdSortKey(left).localeCompare(prdSortKey(right)));
}

export async function assessPrdPaths(
  prdPaths: string[],
  options: AssessPrdPathsOptions,
): Promise<PrdPreflightResult[]> {
  const repoPath = path.resolve(options.repoPath);
  const now = options.now?.() ?? Date.now();
  const tasks = await options.stateManager.listTasks();
  const candidates: MutablePreflightCandidate[] = [];
  const seenPrdIds = new Map<string, MutablePreflightCandidate>();
  const seenPrdPaths = new Map<string, MutablePreflightCandidate>();

  for (const inputPath of prdPaths) {
    const absolutePrdPath = path.resolve(inputPath);
    const candidate: MutablePreflightCandidate = {
      inputPath,
      absolutePrdPath,
      repoPath,
      issues: [],
      activeDuplicates: [],
      completedDuplicates: [],
      missingDependencies: [],
      blockedBatchDependencies: [],
      writeSurfaceOverlaps: [],
    };

    try {
      assertPrdHasExplicitTitle(absolutePrdPath);
      const prd = parsePRD(absolutePrdPath);
      const sourceHash = hashFile(absolutePrdPath);
      candidate.prd = prd;
      candidate.prdId = prd.id;
      candidate.title = prd.title;
      candidate.sourceHash = sourceHash;

      const duplicatePath = seenPrdPaths.get(absolutePrdPath);
      const duplicateId = seenPrdIds.get(prd.id);
      if (duplicatePath || duplicateId) {
        const original = duplicatePath || duplicateId;
        candidate.issues.push(createSkippedIssue(
          'batch_duplicate',
          `Another PRD in this batch already uses ${duplicatePath ? `path ${absolutePrdPath}` : `id ${prd.id}`}`,
          { prdId: original?.prdId },
        ));
      } else {
        seenPrdPaths.set(absolutePrdPath, candidate);
        seenPrdIds.set(prd.id, candidate);
      }

      const activeDuplicates = findActiveDuplicateTasks(tasks, {
        repoPath,
        prdPath: absolutePrdPath,
        prdId: prd.id,
      });
      candidate.activeDuplicates = activeDuplicates.map((task) => task.id);
      if (activeDuplicates.length > 0 && !options.allowDuplicate) {
        candidate.issues.push(createSkippedIssue(
          'active_duplicate',
          `Active duplicate task(s) already exist: ${candidate.activeDuplicates.join(', ')}`,
          { taskIds: candidate.activeDuplicates },
        ));
      }

      const completedDuplicates = findCompletedDuplicateTasks(tasks, {
        repoPath,
        prdPath: absolutePrdPath,
        prd,
        sourceHash,
      });
      candidate.completedDuplicates = completedDuplicates.map((task) => task.id);
      if (completedDuplicates.length > 0) {
        candidate.issues.push(createSkippedIssue(
          'completed_duplicate',
          `Completed duplicate task(s) already exist: ${candidate.completedDuplicates.join(', ')}`,
          { taskIds: candidate.completedDuplicates },
        ));
      }

      try {
        await assertPrdCanBeEnqueued({
          prdPath: absolutePrdPath,
          prd,
          repoPath,
          sourceHash,
          stateManager: options.stateManager,
          allowUmbrellaPrd: options.allowUmbrellaPrd,
        });
      } catch (error) {
        if (error instanceof PrdIntakeRefusalError) {
          const issue = intakeRefusalToIssue(error);
          const alreadyRecorded = candidate.issues.some((existing) => (
            existing.kind === issue.kind
            && (existing.taskId === issue.taskId || existing.taskIds?.includes(issue.taskId || ''))
          ));
          if (!alreadyRecorded) {
            candidate.issues.push(issue);
          }
        } else {
          throw error;
        }
      }
    } catch (error) {
      candidate.issues.push(createSkippedIssue(
        'invalid',
        error instanceof Error ? error.message : String(error),
      ));
    }

    candidates.push(candidate);
  }

  addMissingDependencyIssues(candidates, tasks);
  applyDynamicIssues(candidates, tasks, now);

  return candidates.map(toPreflightResult);
}

export function summarizePrdFolderPreflight(prdDir: string, results: PrdPreflightResult[]): PrdFolderPreflightSummary {
  const skipped = results.filter((result) => result.decision === 'skipped');
  const blocked = results.filter((result) => result.decision === 'blocked');

  return {
    path: path.resolve(prdDir),
    ok: skipped.length === 0 && blocked.length === 0,
    total: results.length,
    ready: results.filter((result) => result.decision === 'ready'),
    blocked,
    skipped,
    stale: results.filter((result) => result.issues.some((issue) => (
      issue.kind === 'stale_status' || issue.kind === 'completed_duplicate'
    ))),
    activeDuplicates: results.filter((result) => result.activeDuplicates.length > 0),
    completedDuplicates: results.filter((result) => result.completedDuplicates.length > 0),
    missingDependencies: results.filter((result) => result.missingDependencies.length > 0),
    writeSurfaceOverlaps: results.filter((result) => result.writeSurfaceOverlaps.length > 0),
    files: results,
  };
}

export function taskBlocksNewWork(task: Task): boolean {
  if (ACTIVE_TASK_STATUSES.has(task.status)) {
    return true;
  }

  return task.status === 'completed' && resolveTaskIntegrationStatus(task) !== 'integrated';
}
