import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import type {
  PRD,
  PRDExecutionPhases,
  PRDOperatorGates,
  PRDReferenceImplementation,
  PRDRepairOf,
  PRDSchedulerHints,
  UserStory,
} from '../types/prd';
import type { Task } from '../types/task';
import type { StateManager } from '../core/state';
import { deriveTaskDeliveryStatus, resolveTaskIntegrationStatus } from '../core/task-delivery';
import { evaluateAutoRecovery } from '../core/auto-recovery-state';
import { inferDependencyRepairIdentityFromTask, sameRepoPath } from '../core/dependency-identity';

// Stagnation detection thresholds
export const STAGNATION_THRESHOLDS = {
  NO_PROGRESS_THRESHOLD: 3,
  CONSECUTIVE_ERRORS_THRESHOLD: 3,
  MAX_LOOPS: 10
};

export function generateTaskId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function normalizeString(value: unknown, fallback: string = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeOptionalStringArray(value: unknown): string[] | undefined {
  const normalized = normalizeStringArray(value);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeOptionalRecord<T extends Record<string, unknown>>(value: unknown): T | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as T;
}

function normalizeRepairOf(value: unknown): PRDRepairOf | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Partial<PRDRepairOf>;
  const prdId = normalizeString(raw.prdId);
  if (!prdId) {
    return undefined;
  }

  return {
    prdId,
    taskId: normalizeString(raw.taskId) || undefined,
    reason: normalizeString(raw.reason) || undefined,
  };
}

function normalizeSchedulerHints(value: unknown): PRDSchedulerHints | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const hints: PRDSchedulerHints = { ...raw };
  const priorityClass = normalizeString(raw.priorityClass);
  const effectiveDependencyPrdId = normalizeString(raw.effectiveDependencyPrdId);
  const releasesDependenciesFor = normalizeOptionalStringArray(raw.releasesDependenciesFor);

  if (priorityClass) {
    hints.priorityClass = priorityClass;
  }

  if (effectiveDependencyPrdId) {
    hints.effectiveDependencyPrdId = effectiveDependencyPrdId;
  }

  if (releasesDependenciesFor) {
    hints.releasesDependenciesFor = releasesDependenciesFor;
  }

  return hints;
}

function resolvePrdTitle(prd: Partial<PRD> & Record<string, unknown>, fallbackId: string): string {
  const explicitTitle = normalizeString(prd.title);
  if (explicitTitle) {
    return explicitTitle;
  }

  const projectName = normalizeString(prd.projectName);
  if (projectName) {
    return projectName;
  }

  const normalizedId = normalizeString(prd.id);
  if (normalizedId) {
    return normalizedId;
  }

  return fallbackId;
}

function normalizeUserStory(value: unknown, index: number): UserStory {
  const raw = (value && typeof value === 'object') ? value as Partial<UserStory> : {};
  const fallbackId = `US-${String(index + 1).padStart(3, '0')}`;

  return {
    id: normalizeString(raw.id, fallbackId),
    title: normalizeString(raw.title, `User Story ${index + 1}`),
    description: normalizeString(raw.description),
    acceptanceCriteria: normalizeStringArray(raw.acceptanceCriteria),
    passes: typeof raw.passes === 'boolean' ? raw.passes : undefined,
    notes: normalizeString(raw.notes) || undefined,
    priority: normalizeString(raw.priority) || undefined,
  };
}

function normalizePrd(prd: Partial<PRD> & Record<string, unknown>, fallbackId: string): PRD {
  const userStories = Array.isArray(prd.userStories)
    ? prd.userStories.map((story, index) => normalizeUserStory(story, index))
    : [];

  return {
    ...prd,
    id: normalizeString(prd.id, fallbackId),
    title: resolvePrdTitle(prd, fallbackId),
    description: normalizeString(prd.description),
    userStories,
    acceptanceCriteria: normalizeOptionalStringArray(prd.acceptanceCriteria),
    nonGoals: normalizeOptionalStringArray(prd.nonGoals),
    safetyBoundaries: normalizeOptionalStringArray(prd.safetyBoundaries),
    forbiddenWriteSurface: normalizeOptionalStringArray(prd.forbiddenWriteSurface),
    verificationCommands: normalizeOptionalStringArray(prd.verificationCommands),
    dependencies: normalizeStringArray(prd.dependencies),
    writeSurface: normalizeOptionalStringArray(prd.writeSurface),
    conflictDomains: normalizeOptionalStringArray(prd.conflictDomains),
    integrationLane: normalizeString(prd.integrationLane) || undefined,
    priorityClass: normalizeString(prd.priorityClass) || undefined,
    repairOf: normalizeRepairOf(prd.repairOf),
    releasesDependenciesFor: normalizeOptionalStringArray(prd.releasesDependenciesFor),
    schedulerHints: normalizeSchedulerHints(prd.schedulerHints),
    referenceImplementation: normalizeOptionalRecord<PRDReferenceImplementation>(prd.referenceImplementation),
    operator: normalizeOptionalRecord<PRDOperatorGates>(prd.operator),
    ralphExecutionPhases: normalizeOptionalRecord<PRDExecutionPhases>(prd.ralphExecutionPhases),
    enqueueBlockedUntil: normalizeOptionalStringArray(prd.enqueueBlockedUntil),
    runBlockedUntil: normalizeOptionalStringArray(prd.runBlockedUntil),
    requiredRalphGuarantees: normalizeOptionalStringArray(prd.requiredRalphGuarantees),
    applyOnlyStatus: normalizeString(prd.applyOnlyStatus) || undefined,
    ccoReview: normalizeOptionalRecord<Record<string, unknown>>(prd.ccoReview),
    validationEvidence: normalizeOptionalRecord<Record<string, unknown>>(prd.validationEvidence),
  };
}

export function parsePRD(prdPath: string): PRD {
  const content = fs.readFileSync(prdPath, 'utf-8');
  const fallbackId = path.basename(prdPath, path.extname(prdPath));

  if (path.extname(prdPath).toLowerCase() === '.json') {
    return normalizePrd(JSON.parse(content) as Partial<PRD>, fallbackId);
  }

  return parsePRDContent(content, prdPath);
}

function parseRawPrdMetadata(prdPath: string): Record<string, unknown> {
  const content = fs.readFileSync(prdPath, 'utf-8');

  if (path.extname(prdPath).toLowerCase() === '.json') {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`PRD ${path.basename(prdPath)} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  }

  const parsed = matter(content);
  return (parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data))
    ? parsed.data as Record<string, unknown>
    : {};
}

export function hasExplicitPrdTitle(prdPath: string): boolean {
  const metadata = parseRawPrdMetadata(prdPath);
  return typeof metadata.title === 'string' && metadata.title.trim().length > 0;
}

export function assertPrdHasExplicitTitle(prdPath: string): void {
  if (hasExplicitPrdTitle(prdPath)) {
    return;
  }

  throw new Error(
    `PRD ${path.basename(prdPath)} must define a non-empty top-level title. `
    + `Add a title field instead of relying on projectName or filename fallback.`
  );
}

export function parsePRDContent(content: string, prdPath: string = 'prd.json'): PRD {
  const fallbackId = path.basename(prdPath, path.extname(prdPath));

  try {
    return normalizePrd(JSON.parse(content) as Partial<PRD>, fallbackId);
  } catch {
    // Fall through to markdown parsing.
  }

  const parsed = matter(content);
  const frontmatter = parsed.data as Partial<PRD>;
  const body = parsed.content;
  const bodyStories = parseUserStoriesFromMarkdown(body);
  const frontmatterStories = Array.isArray(frontmatter.userStories)
    ? frontmatter.userStories
    : undefined;

  return normalizePrd({
    ...frontmatter,
    id: frontmatter.id,
    title: frontmatter.title,
    description: frontmatter.description,
    userStories: frontmatterStories && frontmatterStories.length > 0 ? frontmatterStories : bodyStories,
    acceptanceCriteria: frontmatter.acceptanceCriteria,
    nonGoals: frontmatter.nonGoals,
    safetyBoundaries: frontmatter.safetyBoundaries,
    forbiddenWriteSurface: frontmatter.forbiddenWriteSurface,
    verificationCommands: frontmatter.verificationCommands,
    dependencies: frontmatter.dependencies,
    writeSurface: frontmatter.writeSurface,
    conflictDomains: frontmatter.conflictDomains,
    integrationLane: frontmatter.integrationLane,
    priorityClass: frontmatter.priorityClass,
    repairOf: frontmatter.repairOf,
    releasesDependenciesFor: frontmatter.releasesDependenciesFor,
    schedulerHints: frontmatter.schedulerHints,
    referenceImplementation: frontmatter.referenceImplementation,
  }, fallbackId);
}

function parseUserStoriesFromMarkdown(markdown: string): PRD['userStories'] {
  const sections = markdown
    .split(/(?=^#{2,3}\s+US-\d+:?\s+)/m)
    .map((section) => section.trim())
    .filter((section) => /^#{2,3}\s+US-\d+:?\s+/m.test(section));

  return sections.map((section, index) => {
    const headerMatch = section.match(/^#{2,3}\s+(US-\d+):?\s+(.+)$/m);
    const body = section.replace(/^#{2,3}\s+US-\d+:?\s+.+$/m, '').trim();
    const descriptionMatch = body.match(/\*\*Description\*\*:?\s*(.+?)(?=\*\*Acceptance Criteria\*\*:?|$)/is);
    const acceptanceCriteriaMatch = body.match(/\*\*Acceptance Criteria\*\*:?\s*([\s\S]+)/i);

    const acceptanceCriteria = acceptanceCriteriaMatch
      ? acceptanceCriteriaMatch[1]
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => /^[-*]\s+/.test(line))
          .map((line) => line.replace(/^[-*]\s+/, '').trim())
      : [];

    return normalizeUserStory({
      id: headerMatch?.[1],
      title: headerMatch?.[2],
      description: descriptionMatch?.[1] ?? body,
      acceptanceCriteria,
    }, index);
  });
}

export function getTaskPRDPath(task: Pick<Task, 'logPath'>): string {
  return path.join(path.dirname(task.logPath), 'prd.json');
}

export function saveTaskPRD(task: Pick<Task, 'logPath'>, prd: PRD): string {
  const prdPath = getTaskPRDPath(task);
  const prdDir = path.dirname(prdPath);

  if (!fs.existsSync(prdDir)) {
    fs.mkdirSync(prdDir, { recursive: true });
  }

  const tempPath = `${prdPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(prd, null, 2));
  fs.renameSync(tempPath, prdPath);

  return prdPath;
}

export function loadTaskPRD(task: Pick<Task, 'prdPath' | 'logPath'>): PRD {
  const taskPrdPath = getTaskPRDPath(task);

  if (fs.existsSync(taskPrdPath)) {
    try {
      return parsePRD(taskPrdPath);
    } catch {
      // Rebuild below from the source PRD.
    }
  }

  const prd = parsePRD(task.prdPath);
  saveTaskPRD(task, prd);
  return prd;
}

export function updateTaskPRDStory(
  task: Pick<Task, 'prdPath' | 'logPath'>,
  storyId: string,
  updates: Partial<UserStory>
): PRD {
  const prd = loadTaskPRD(task);
  const story = prd.userStories.find((entry) => entry.id === storyId);

  if (!story) {
    throw new Error(`Story ${storyId} not found in PRD`);
  }

  Object.assign(story, updates);
  saveTaskPRD(task, prd);
  return prd;
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

export function detectStagnation(
  task: Task,
  options: { timeoutMs?: number; now?: () => number } = {}
): { isStagnant: boolean; reason?: string } {
  const timeoutMs = Number(options.timeoutMs);
  const now = options.now ?? (() => Date.now());

  if (Number.isFinite(timeoutMs) && timeoutMs > 0 && now() - task.lastProgressTime >= timeoutMs) {
    return {
      isStagnant: true,
      reason: `No progress for ${Math.floor((now() - task.lastProgressTime) / 1000)}s`
    };
  }

  if (task.consecutiveNoProgress >= STAGNATION_THRESHOLDS.NO_PROGRESS_THRESHOLD) {
    return {
      isStagnant: true,
      reason: `No progress for ${task.consecutiveNoProgress} consecutive loops`
    };
  }

  if (task.consecutiveErrors >= STAGNATION_THRESHOLDS.CONSECUTIVE_ERRORS_THRESHOLD) {
    return {
      isStagnant: true,
      reason: `${task.consecutiveErrors} consecutive errors`
    };
  }

  return { isStagnant: false };
}

export type DependencyBlockerKind =
  | 'missing'
  | 'pending'
  | 'running'
  | 'finalizing'
  | 'not_integrated'
  | 'integration_failed'
  | 'integration_blocked_conflict'
  | 'task_failed'
  | 'task_stagnant'
  | 'finalize_failed';

export interface DependencyBlocker {
  prdId: string;
  taskId?: string;
  status?: Task['status'];
  integrationStatus?: ReturnType<typeof resolveTaskIntegrationStatus>;
  kind: DependencyBlockerKind;
  reason: string;
  retryable?: boolean;
  autoRecoveryActive?: boolean;
  dependencyRepairActive?: boolean;
  repairTaskIds?: string[];
  actionRequired: boolean;
}

export interface DependencyCheckResult {
  satisfied: boolean;
  pending: string[];
  blockers: DependencyBlocker[];
  failed: string[];
  recovering: string[];
  repairTaskIds: string[];
  missing: string[];
}

const ACTIVE_DEPENDENCY_REPAIR_STATUSES = new Set<Task['status']>([
  'pending',
  'running',
  'ready_to_finalize',
  'finalizing',
  'failed_finalize',
]);

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function matchesRepoPath(task: Task, repoPath?: string): boolean {
  return !repoPath || sameRepoPath(task.repoPath, repoPath);
}

function isDependencyRepairTaskForPrd(task: Task, depId: string, candidates: Task[] = []): boolean {
  const identity = inferDependencyRepairIdentityFromTask(task, candidates);
  return identity?.repairOf.prdId === depId
    || identity?.releasesDependenciesFor.includes(depId) === true;
}

function isActiveDependencyRepairTaskForPrd(task: Task, depId: string, candidates: Task[] = []): boolean {
  return isDependencyRepairTaskForPrd(task, depId, candidates)
    && ACTIVE_DEPENDENCY_REPAIR_STATUSES.has(task.status);
}

function isIntegratedDependencyRepairTaskForPrd(task: Task, depId: string, candidates: Task[] = []): boolean {
  return isDependencyRepairTaskForPrd(task, depId, candidates)
    && task.status === 'completed'
    && resolveTaskIntegrationStatus(task) === 'integrated';
}

function findActiveDependencyRepairTasks(
  depId: string,
  tasks: Task[],
  options: { repoPath?: string },
): Task[] {
  return tasks.filter((task) => (
    matchesRepoPath(task, options.repoPath)
    && isActiveDependencyRepairTaskForPrd(task, depId, tasks)
  ));
}

function findIntegratedDependencyRepairTask(
  depId: string,
  tasks: Task[],
  options: { repoPath?: string },
): Task | undefined {
  return tasks.find((task) => (
    matchesRepoPath(task, options.repoPath)
    && isIntegratedDependencyRepairTaskForPrd(task, depId, tasks)
  ));
}

function classifyDependencyBlocker(depId: string, depTask: Task | null, candidates: Task[] = []): DependencyBlocker | null {
  if (!depTask) {
    return {
      prdId: depId,
      kind: 'missing',
      reason: 'dependency task has not been enqueued',
      actionRequired: false,
    };
  }

  const integrationStatus = resolveTaskIntegrationStatus(depTask);
  const deliveryStatus = deriveTaskDeliveryStatus(depTask);
  const integrated = depTask.status === 'completed'
    && deliveryStatus.integrationStatus === 'integrated';

  if (integrated) {
    return null;
  }

  const dependencyRepairActive = isActiveDependencyRepairTaskForPrd(depTask, depId, candidates);
  const autoRecoveryActive = evaluateAutoRecovery(depTask).active || dependencyRepairActive;
  const base = {
    prdId: depId,
    taskId: depTask.id,
    status: depTask.status,
    integrationStatus,
    retryable: depTask.lastErrorRetryable,
    autoRecoveryActive,
    dependencyRepairActive,
    repairTaskIds: dependencyRepairActive ? [depTask.id] : undefined,
  };

  if (depTask.status === 'failed') {
    return {
      ...base,
      kind: 'task_failed',
      reason: depTask.lastError || 'dependency task failed',
      actionRequired: !autoRecoveryActive,
    };
  }

  if (depTask.status === 'stagnant') {
    return {
      ...base,
      kind: 'task_stagnant',
      reason: depTask.lastError || 'dependency task is stagnant',
      actionRequired: !autoRecoveryActive,
    };
  }

  if (depTask.status === 'failed_finalize') {
    return {
      ...base,
      kind: 'finalize_failed',
      reason: depTask.lastError || 'dependency finalization failed',
      actionRequired: !autoRecoveryActive,
    };
  }

  if (depTask.status === 'completed') {
    if (integrationStatus === 'failed') {
      return {
        ...base,
        kind: 'integration_failed',
        reason: depTask.mergeError || depTask.lastError || 'dependency integration failed',
        actionRequired: !autoRecoveryActive,
      };
    }

    if (integrationStatus === 'blocked_conflict') {
      return {
        ...base,
        kind: 'integration_blocked_conflict',
        reason: depTask.mergeError || depTask.lastError || 'dependency integration is blocked by conflicts',
        actionRequired: !autoRecoveryActive,
      };
    }

    return {
      ...base,
      kind: 'not_integrated',
      reason: 'dependency completed but has not been integrated',
      actionRequired: false,
    };
  }

  if (depTask.status === 'running') {
    return {
      ...base,
      kind: 'running',
      reason: 'dependency task is still running',
      actionRequired: false,
    };
  }

  if (depTask.status === 'ready_to_finalize' || depTask.status === 'finalizing') {
    return {
      ...base,
      kind: 'finalizing',
      reason: 'dependency task is waiting for finalization',
      actionRequired: false,
    };
  }

  return {
    ...base,
    kind: 'pending',
    reason: 'dependency task is still pending',
    actionRequired: false,
  };
}

function isActiveBaselineRepairDependency(task: Task | null): boolean {
  if (!task || !task.prdId?.startsWith('baseline-quality-gate:')) {
    return false;
  }

  if (
    task.status === 'pending'
    || task.status === 'running'
    || task.status === 'ready_to_finalize'
    || task.status === 'finalizing'
  ) {
    return true;
  }

  if (task.status === 'completed') {
    return resolveTaskIntegrationStatus(task) !== 'integrated';
  }

  return (task.status === 'failed' || task.status === 'stagnant')
    && evaluateAutoRecovery(task).active;
}

export async function checkDependencies(
  prd: PRD,
  stateManager: StateManager,
  options: { repoPath?: string; task?: Task } = {}
): Promise<DependencyCheckResult> {
  if (!prd.dependencies || prd.dependencies.length === 0) {
    return {
      satisfied: true,
      pending: [],
      blockers: [],
      failed: [],
      recovering: [],
      repairTaskIds: [],
      missing: [],
    };
  }

  const blockers: DependencyBlocker[] = [];
  const tasks = await stateManager.listTasks();

  for (const depId of prd.dependencies) {
    const integratedRepairTask = findIntegratedDependencyRepairTask(depId, tasks, {
      repoPath: options.repoPath,
    });
    if (integratedRepairTask) {
      continue;
    }

    const depTask = await stateManager.getTaskByPrdId(depId, {
      repoPath: options.repoPath,
    });

    const blocker = classifyDependencyBlocker(depId, depTask, tasks);
    if (blocker) {
      if (blocker.actionRequired) {
        const activeRepairTasks = findActiveDependencyRepairTasks(depId, tasks, {
          repoPath: options.repoPath,
        });
        const repairTaskIds = uniqueStrings([
          ...(blocker.repairTaskIds || []),
          ...activeRepairTasks.map((task) => task.id),
        ]);

        if (repairTaskIds.length > 0) {
          blockers.push({
            ...blocker,
            reason: `dependency is waiting for active repair task ${repairTaskIds.join(', ')}`,
            autoRecoveryActive: true,
            dependencyRepairActive: true,
            repairTaskIds,
            actionRequired: false,
          });
          continue;
        }
      }

      const repairTaskId = depTask?.baselineQualityGate?.repairTaskId;
      if (
        blocker.actionRequired
        && depTask?.status === 'failed_finalize'
        && depTask.baselineQualityGate?.kind === 'baseline_quality_gate_failure'
        && repairTaskId
      ) {
        const repairTask = await stateManager.loadTask(repairTaskId);
        if (isActiveBaselineRepairDependency(repairTask)) {
          blockers.push({
            ...blocker,
            reason: `dependency finalization is waiting for active baseline repair task ${repairTaskId}`,
            autoRecoveryActive: true,
            actionRequired: false,
          });
          continue;
        }
      }

      blockers.push(blocker);
    }
  }

  const pending = blockers.map((blocker) => blocker.prdId);

  return {
    satisfied: pending.length === 0,
    pending,
    blockers,
    failed: blockers
      .filter((blocker) => blocker.actionRequired)
      .map((blocker) => blocker.prdId),
    recovering: blockers
      .filter((blocker) => blocker.autoRecoveryActive && !blocker.actionRequired)
      .map((blocker) => blocker.prdId),
    repairTaskIds: uniqueStrings(blockers.flatMap((blocker) => blocker.repairTaskIds || [])),
    missing: blockers
      .filter((blocker) => blocker.kind === 'missing')
      .map((blocker) => blocker.prdId),
  };
}
