import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { StateManager } from './state';
import { Task, TaskStatus } from '../types/task';
import { parsePRD } from '../utils/helpers';

export type PrdInventoryStatus =
  | 'not_ingested'
  | 'queued'
  | 'running'
  | 'ready_to_finalize'
  | 'completed'
  | 'failed'
  | 'changed_since_ingested';

export interface PrdInventoryItem {
  path: string;
  prdId?: string;
  title?: string;
  sourceHash?: string;
  status: PrdInventoryStatus;
  taskId?: string;
  taskStatus?: TaskStatus;
}

export interface PrdInventoryInput {
  watchDir?: string;
  pattern?: string;
  repoPath?: string;
  stateManager: Pick<StateManager, 'listTasks'>;
}

export interface PrdInventory {
  enabled: boolean;
  watchDir?: string;
  pattern: string;
  totalFiles: number;
  notIngestedCount: number;
  changedSinceIngestedCount: number;
  items: PrdInventoryItem[];
}

const DEFAULT_PATTERN = 'ez4ielts-*.json';

function matchesGlob(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

function hashFile(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function listMatchingFiles(watchDir: string, pattern: string): string[] {
  if (!fs.existsSync(watchDir)) {
    return [];
  }

  return fs.readdirSync(watchDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.resolve(watchDir, entry.name))
    .filter((filePath) => matchesGlob(path.basename(filePath), pattern))
    .sort();
}

function normalizeTaskStatus(status: TaskStatus): PrdInventoryStatus {
  if (status === 'pending') {
    return 'queued';
  }

  if (status === 'failed' || status === 'failed_finalize' || status === 'stagnant') {
    return 'failed';
  }

  if (status === 'finalizing') {
    return 'ready_to_finalize';
  }

  return status;
}

function indexTasks(tasks: Task[], repoPath?: string) {
  const resolvedRepoPath = repoPath ? path.resolve(repoPath) : undefined;
  const filteredTasks = resolvedRepoPath
    ? tasks.filter((task) => path.resolve(task.repoPath) === resolvedRepoPath)
    : tasks;

  const byPath = new Map<string, Task>();
  const byPrdId = new Map<string, Task>();
  const bySourceHash = new Map<string, Task>();

  for (const task of filteredTasks) {
    byPath.set(path.resolve(task.prdPath), task);

    if (task.prdId) {
      byPrdId.set(task.prdId, task);
    }

    if (task.prdSourceHash) {
      bySourceHash.set(task.prdSourceHash, task);
    }
  }

  return { byPath, byPrdId, bySourceHash };
}

export async function buildPrdInventory(input: PrdInventoryInput): Promise<PrdInventory> {
  const pattern = input.pattern?.trim() || DEFAULT_PATTERN;
  const watchDir = input.watchDir?.trim() ? path.resolve(input.watchDir) : undefined;

  if (!watchDir) {
    return {
      enabled: false,
      pattern,
      totalFiles: 0,
      notIngestedCount: 0,
      changedSinceIngestedCount: 0,
      items: [],
    };
  }

  const tasks = await input.stateManager.listTasks();
  const taskIndex = indexTasks(tasks, input.repoPath);
  const items = listMatchingFiles(watchDir, pattern).map<PrdInventoryItem>((filePath) => {
    let prdId: string | undefined;
    let title: string | undefined;
    let sourceHash: string | undefined;

    try {
      const prd = parsePRD(filePath);
      prdId = prd.id;
      title = prd.title;
    } catch {
      // Invalid PRDs still need to appear as not ingested so the user can fix the file.
    }

    try {
      sourceHash = hashFile(filePath);
    } catch {
      sourceHash = undefined;
    }

    const matchingTask = taskIndex.byPath.get(path.resolve(filePath))
      ?? (prdId ? taskIndex.byPrdId.get(prdId) : undefined)
      ?? (sourceHash ? taskIndex.bySourceHash.get(sourceHash) : undefined);

    if (!matchingTask) {
      return {
        path: filePath,
        prdId,
        title,
        sourceHash,
        status: 'not_ingested',
      };
    }

    const changedSinceIngested = Boolean(
      sourceHash
      && matchingTask.prdSourceHash
      && sourceHash !== matchingTask.prdSourceHash
      && (
        path.resolve(matchingTask.prdPath) === path.resolve(filePath)
        || (prdId !== undefined && matchingTask.prdId === prdId)
      )
    );

    return {
      path: filePath,
      prdId,
      title,
      sourceHash,
      status: changedSinceIngested ? 'changed_since_ingested' : normalizeTaskStatus(matchingTask.status),
      taskId: matchingTask.id,
      taskStatus: matchingTask.status,
    };
  });

  return {
    enabled: true,
    watchDir,
    pattern,
    totalFiles: items.length,
    notIngestedCount: items.filter((item) => item.status === 'not_ingested').length,
    changedSinceIngestedCount: items.filter((item) => item.status === 'changed_since_ingested').length,
    items,
  };
}
