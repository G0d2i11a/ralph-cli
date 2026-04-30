import * as fs from 'fs';
import * as path from 'path';
import { PRD } from '../types/prd';
import { Task } from '../types/task';
import { parseRawPrdMetadata } from '../utils/helpers';

interface TaskHistoryStore {
  listTasks(): Promise<Task[]>;
}

export type PrdIntakeRefusalKind =
  | 'completed'
  | 'in_progress'
  | 'archived'
  | 'umbrella'
  | 'stale_history';

export interface PrdIntakeIssue {
  kind: PrdIntakeRefusalKind;
  reason: string;
  taskId?: string;
}

export interface PrdIntakePolicyOptions {
  prdPath: string;
  prd: PRD;
  repoPath?: string;
  sourceHash?: string;
  stateManager?: TaskHistoryStore;
  allowUmbrellaPrd?: boolean;
}

export class PrdIntakeRefusalError extends Error {
  readonly issue: PrdIntakeIssue;

  constructor(prdPath: string, issue: PrdIntakeIssue) {
    super(formatPrdIntakeRefusal(prdPath, issue));
    this.name = 'PrdIntakeRefusalError';
    this.issue = issue;
  }
}

const COMPLETED_STATUSES = new Set([
  'complete',
  'completed',
  'done',
  'implemented',
  'integrated',
  'merged',
  'released',
  'resolved',
  'shipped',
]);

const ARCHIVED_STATUSES = new Set([
  'archive',
  'archived',
  'canceled',
  'cancelled',
  'closed',
  'deprecated',
  'obsolete',
  'superseded',
]);

const IN_PROGRESS_STATUSES = new Set([
  'active',
  'doing',
  'in_progress',
  'running',
  'started',
  'wip',
  'working',
]);

const PENDING_STATUSES = new Set([
  'backlog',
  'open',
  'pending',
  'queued',
  'ready',
  'todo',
  'to_do',
  'not_started',
]);

const UMBRELLA_TYPES = new Set([
  'epic',
  'index',
  'initiative',
  'master_plan',
  'overview',
  'planning',
  'portfolio',
  'program',
  'roadmap',
  'strategy',
  'theme',
  'umbrella',
  'vision',
]);

const UMBRELLA_TEXT_PATTERN = /\b(umbrella|strategy|roadmap|initiative|portfolio|program|vision|master plan)\b/i;

function normalizeToken(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = normalizeToken(value);
  if (['1', 'true', 'yes', 'y'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'n'].includes(normalized)) {
    return false;
  }

  return undefined;
}

function readNestedRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function metadataBoolean(metadata: Record<string, unknown>, key: string): boolean | undefined {
  const direct = normalizeBoolean(metadata[key]);
  if (direct !== undefined) {
    return direct;
  }

  return normalizeBoolean(readNestedRecord(metadata.ralph)?.[key]);
}

function hasExecutableFrontmatter(metadata: Record<string, unknown>): boolean {
  return metadataBoolean(metadata, 'executable') === true;
}

function hasNonExecutableFrontmatter(metadata: Record<string, unknown>): boolean {
  return metadataBoolean(metadata, 'executable') === false
    || metadataBoolean(metadata, 'nonExecutable') === true
    || metadataBoolean(metadata, 'non_executable') === true;
}

function firstLifecycleStatus(metadata: Record<string, unknown>): string {
  for (const key of ['status', 'state', 'lifecycleStatus', 'lifecycle_status']) {
    const normalized = normalizeToken(metadata[key]);
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

function isMarkdownPath(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return extension === '.md' || extension === '.markdown';
}

function rawStoriesAreComplete(metadata: Record<string, unknown>, prd: PRD): boolean {
  const rawStories = Array.isArray(metadata.userStories) ? metadata.userStories : [];

  if (rawStories.length > 0) {
    return rawStories.every((story) => {
      const record = readNestedRecord(story);
      if (!record) {
        return false;
      }

      return normalizeBoolean(record.passes) === true
        || COMPLETED_STATUSES.has(normalizeToken(record.status));
    });
  }

  return prd.userStories.length > 0
    && prd.userStories.every((story) => story.passes === true);
}

function rawStoriesHaveActiveWork(metadata: Record<string, unknown>): boolean {
  const rawStories = Array.isArray(metadata.userStories) ? metadata.userStories : [];

  return rawStories.some((story) => {
    const record = readNestedRecord(story);
    if (!record) {
      return false;
    }

    return IN_PROGRESS_STATUSES.has(normalizeToken(record.status));
  });
}

function evaluateLifecycleMetadata(metadata: Record<string, unknown>, prd: PRD): PrdIntakeIssue | undefined {
  if (metadataBoolean(metadata, 'archived') === true) {
    return {
      kind: 'archived',
      reason: 'frontmatter marks it as archived',
    };
  }

  if (metadataBoolean(metadata, 'completed') === true) {
    return {
      kind: 'completed',
      reason: 'frontmatter marks it as completed',
    };
  }

  const status = firstLifecycleStatus(metadata);
  if (ARCHIVED_STATUSES.has(status)) {
    return {
      kind: 'archived',
      reason: `frontmatter status is ${status}`,
    };
  }

  if (COMPLETED_STATUSES.has(status) || rawStoriesAreComplete(metadata, prd)) {
    return {
      kind: 'completed',
      reason: COMPLETED_STATUSES.has(status)
        ? `frontmatter status is ${status}`
        : 'frontmatter marks every user story as complete',
    };
  }

  if (IN_PROGRESS_STATUSES.has(status) || rawStoriesHaveActiveWork(metadata)) {
    return {
      kind: 'in_progress',
      reason: IN_PROGRESS_STATUSES.has(status)
        ? `frontmatter status is ${status}`
        : 'frontmatter marks at least one user story as in_progress',
    };
  }

  return undefined;
}

export type TaskIndexStatus = 'pending' | 'in_progress' | 'completed' | 'archived';

export interface TaskIndexStatusEvidence {
  status: TaskIndexStatus;
  indexPath: string;
}

function inferStatusFromIndexSection(heading: string): TaskIndexStatus | undefined {
  const normalized = normalizeToken(heading);

  if (COMPLETED_STATUSES.has(normalized) || /已完成/.test(heading)) {
    return 'completed';
  }

  if (IN_PROGRESS_STATUSES.has(normalized) || /进行中|進行中|执行中|執行中/.test(heading)) {
    return 'in_progress';
  }

  if (PENDING_STATUSES.has(normalized) || /待执行|待執行|待办|待辦|未开始|未開始/.test(heading)) {
    return 'pending';
  }

  if (ARCHIVED_STATUSES.has(normalized) || /归档|歸檔|停止|已停止/.test(heading)) {
    return 'archived';
  }

  return undefined;
}

function inferStatusFromIndexCell(cell: string): TaskIndexStatus | undefined {
  const normalized = normalizeToken(cell.replace(/\[[^\]]+\]\([^)]+\)/g, ''));

  if (COMPLETED_STATUSES.has(normalized) || /✅|✔|☑/.test(cell)) {
    return 'completed';
  }

  if (IN_PROGRESS_STATUSES.has(normalized) || /🚧|⏳/.test(cell)) {
    return 'in_progress';
  }

  if (PENDING_STATUSES.has(normalized)) {
    return 'pending';
  }

  if (ARCHIVED_STATUSES.has(normalized)) {
    return 'archived';
  }

  return undefined;
}

function inferStatusFromIndexLine(line: string): TaskIndexStatus | undefined {
  const cells = line
    .split('|')
    .map((cell) => cell.trim())
    .filter(Boolean);

  for (const cell of cells) {
    const status = inferStatusFromIndexCell(cell);
    if (status) {
      return status;
    }
  }

  return undefined;
}

function stripIndexLinkTarget(target: string): string {
  return target
    .split('#')[0]
    .split('?')[0]
    .replace(/^\.\/+/, '')
    .replace(/\\/g, '/');
}

function indexLineReferencesPrd(line: string, indexDir: string, prdPath: string): boolean {
  const prdBaseName = path.basename(prdPath);
  const relativePrdPath = path.relative(indexDir, prdPath).replace(/\\/g, '/');
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = linkPattern.exec(line)) !== null) {
    const target = stripIndexLinkTarget(match[1].trim());
    if (target === prdBaseName || target === relativePrdPath || path.basename(target) === prdBaseName) {
      return true;
    }
  }

  return line.includes(prdBaseName);
}

function findSiblingTaskIndex(prdPath: string): string | undefined {
  if (!isMarkdownPath(prdPath)) {
    return undefined;
  }

  const prdDir = path.dirname(prdPath);
  if (!fs.existsSync(prdDir)) {
    return undefined;
  }

  const indexFileName = fs.readdirSync(prdDir).find((entry) => entry.toLowerCase() === 'index.md');
  return indexFileName ? path.join(prdDir, indexFileName) : undefined;
}

export function readMarkdownTaskIndexStatus(prdPath: string): TaskIndexStatusEvidence | undefined {
  const indexPath = findSiblingTaskIndex(prdPath);
  if (!indexPath) {
    return undefined;
  }

  const indexDir = path.dirname(indexPath);
  const content = fs.readFileSync(indexPath, 'utf-8');
  let currentSectionStatus: TaskIndexStatus | undefined;

  for (const line of content.split(/\r?\n/)) {
    const headingMatch = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (headingMatch) {
      currentSectionStatus = inferStatusFromIndexSection(headingMatch[1]);
      continue;
    }

    if (!indexLineReferencesPrd(line, indexDir, prdPath)) {
      continue;
    }

    const status = inferStatusFromIndexLine(line) || currentSectionStatus;
    if (status) {
      return {
        status,
        indexPath,
      };
    }
  }

  return undefined;
}

function evaluateTaskIndexStatus(prdPath: string): PrdIntakeIssue | undefined {
  const evidence = readMarkdownTaskIndexStatus(prdPath);
  if (!evidence) {
    return undefined;
  }

  if (evidence.status === 'completed') {
    return {
      kind: 'completed',
      reason: `task index ${path.basename(evidence.indexPath)} marks it as completed`,
    };
  }

  if (evidence.status === 'in_progress') {
    return {
      kind: 'in_progress',
      reason: `task index ${path.basename(evidence.indexPath)} marks it as in_progress`,
    };
  }

  if (evidence.status === 'archived') {
    return {
      kind: 'archived',
      reason: `task index ${path.basename(evidence.indexPath)} marks it as archived`,
    };
  }

  return undefined;
}

function classificationTokens(metadata: Record<string, unknown>): string[] {
  const keys = ['type', 'kind', 'category', 'docType', 'doc_type', 'prdType', 'prd_type', 'scope'];
  return keys
    .map((key) => normalizeToken(metadata[key]))
    .filter(Boolean);
}

function hasBroadStrategyText(metadata: Record<string, unknown>, prd: PRD): boolean {
  const text = [
    metadata.title,
    metadata.description,
    prd.title,
    prd.description,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');

  if (!UMBRELLA_TEXT_PATTERN.test(text)) {
    return false;
  }

  return prd.userStories.length === 0 || prd.userStories.length > 6;
}

function evaluateUmbrellaMetadata(
  metadata: Record<string, unknown>,
  prd: PRD,
  allowUmbrellaPrd?: boolean,
): PrdIntakeIssue | undefined {
  if (hasNonExecutableFrontmatter(metadata)) {
    return {
      kind: 'umbrella',
      reason: 'frontmatter marks it as non-executable',
    };
  }

  if (allowUmbrellaPrd || hasExecutableFrontmatter(metadata)) {
    return undefined;
  }

  const umbrellaToken = classificationTokens(metadata).find((token) => UMBRELLA_TYPES.has(token));
  if (umbrellaToken) {
    return {
      kind: 'umbrella',
      reason: `frontmatter classifies it as ${umbrellaToken}`,
    };
  }

  if (hasBroadStrategyText(metadata, prd)) {
    return {
      kind: 'umbrella',
      reason: 'title or description looks like a broad strategy document',
    };
  }

  return undefined;
}

function isClearlySameCompletedPrd(task: Task, input: PrdIntakePolicyOptions): boolean {
  if (task.status !== 'completed') {
    return false;
  }

  if (input.repoPath && path.resolve(task.repoPath) !== path.resolve(input.repoPath)) {
    return false;
  }

  const samePath = path.resolve(task.prdPath) === path.resolve(input.prdPath);
  if (samePath) {
    return true;
  }

  if (task.prdId !== input.prd.id) {
    return false;
  }

  if (task.prdSourceHash && input.sourceHash) {
    return task.prdSourceHash === input.sourceHash;
  }

  return !task.prdSourceHash;
}

async function evaluateTaskHistory(input: PrdIntakePolicyOptions): Promise<PrdIntakeIssue | undefined> {
  if (!input.stateManager) {
    return undefined;
  }

  const tasks = await input.stateManager.listTasks();
  const staleTask = tasks.find((task) => isClearlySameCompletedPrd(task, input));

  if (!staleTask) {
    return undefined;
  }

  return {
    kind: 'stale_history',
    reason: `task ${staleTask.id} already completed this PRD`,
    taskId: staleTask.id,
  };
}

function formatPrdIntakeRefusal(prdPath: string, issue: PrdIntakeIssue): string {
  const fileName = path.basename(prdPath);
  const deltaMessage = 'Create a narrow delta PRD for the remaining work before starting Ralph.';

  if (issue.kind === 'umbrella') {
    return `Refusing to enqueue PRD ${fileName}: ${issue.reason}. `
      + `Pass the explicit umbrella allow flag only if this broad PRD should execute as-is, or add executable: true frontmatter. `
      + deltaMessage;
  }

  return `Refusing to enqueue PRD ${fileName}: ${issue.reason}. ${deltaMessage}`;
}

export async function assertPrdCanBeEnqueued(input: PrdIntakePolicyOptions): Promise<void> {
  const metadata = parseRawPrdMetadata(input.prdPath);
  let issue = evaluateLifecycleMetadata(metadata, input.prd)
    || evaluateTaskIndexStatus(input.prdPath)
    || evaluateUmbrellaMetadata(metadata, input.prd, input.allowUmbrellaPrd);

  if (!issue) {
    issue = await evaluateTaskHistory(input);
  }

  if (issue) {
    throw new PrdIntakeRefusalError(input.prdPath, issue);
  }
}
