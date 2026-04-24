import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import type { PRD, UserStory } from '../types/prd';
import type { Task } from '../types/task';
import type { StateManager } from '../core/state';

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

function normalizePrd(prd: Partial<PRD>, fallbackId: string): PRD {
  const userStories = Array.isArray(prd.userStories)
    ? prd.userStories.map((story, index) => normalizeUserStory(story, index))
    : [];

  return {
    id: normalizeString(prd.id, fallbackId),
    title: normalizeString(prd.title, 'Untitled PRD'),
    description: normalizeString(prd.description),
    userStories,
    dependencies: normalizeStringArray(prd.dependencies),
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
    id: frontmatter.id,
    title: frontmatter.title,
    description: frontmatter.description,
    userStories: frontmatterStories && frontmatterStories.length > 0 ? frontmatterStories : bodyStories,
    dependencies: frontmatter.dependencies,
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

export async function checkDependencies(
  prd: PRD,
  stateManager: StateManager,
  options: { repoPath?: string; task?: Task } = {}
): Promise<{ satisfied: boolean; pending: string[] }> {
  if (!prd.dependencies || prd.dependencies.length === 0) {
    return { satisfied: true, pending: [] };
  }

  const pending: string[] = [];

  for (const depId of prd.dependencies) {
    const depTask = await stateManager.getTaskByPrdId(depId, {
      repoPath: options.repoPath,
    });

    const isIntegrated = Boolean(
      depTask
      && depTask.status === 'completed'
      && (depTask.integratedAt || depTask.integrationCommitSha || depTask.mergedAt || depTask.mergeCommitSha)
    );

    if (!isIntegrated) {
      pending.push(depId);
    }
  }

  return {
    satisfied: pending.length === 0,
    pending
  };
}
