import * as fs from 'fs';
import * as path from 'path';
import { AgentType, DEFAULT_AGENT, resolveAgentType } from './agent';
import { TaskScheduler } from './scheduler';
import { StateManager } from './state';
import { enqueueTaskFromPrd } from './task-intake';
import { parsePRD } from '../utils/helpers';

export const DEFAULT_EZ4IELTS_WATCH_DIR = process.env.RALPH_EZ4IELTS_WATCH_DIR || '~/Workspace/openclaw/docs';
export const DEFAULT_EZ4IELTS_PATTERN = 'ez4ielts-*.json';
export const DEFAULT_EZ4IELTS_SETTLE_MS = 2000;

interface CandidateState {
  signature: string;
  stableSince: number;
  attemptedSignature?: string;
}

export interface PrdAutoIngestOptions {
  watchDir?: string;
  pattern?: string;
  repoPath?: string;
  agent?: string;
  settleMs?: number;
  logger?: (message: string) => void;
}

export interface PrdAutoIngestDeps {
  stateManager?: StateManager;
  scheduler?: TaskScheduler;
  now?: () => number;
  listFiles?: (watchDir: string) => string[];
  statSignature?: (filePath: string) => string;
}

export interface PrdAutoIngestResult {
  filePath: string;
  taskId?: string;
  action: 'ingested' | 'already-tracked' | 'invalid';
  status?: string;
  error?: string;
}

export class PrdAutoIngestor {
  private readonly stateManager: StateManager;
  private readonly scheduler: TaskScheduler;
  private readonly repoPath: string;
  private readonly agent: AgentType;
  private readonly watchDir: string;
  private readonly pattern: string;
  private readonly settleMs: number;
  private readonly now: () => number;
  private readonly logger: (message: string) => void;
  private readonly listFilesFn: (watchDir: string) => string[];
  private readonly statSignatureFn: (filePath: string) => string;
  private readonly ignoredExistingPaths = new Set<string>();
  private readonly trackedPaths = new Set<string>();
  private readonly candidates = new Map<string, CandidateState>();
  private initialized = false;

  constructor(options: PrdAutoIngestOptions = {}, deps: PrdAutoIngestDeps = {}) {
    this.stateManager = deps.stateManager ?? new StateManager();
    this.scheduler = deps.scheduler ?? new TaskScheduler({ stateManager: this.stateManager });
    this.watchDir = path.resolve(options.watchDir || DEFAULT_EZ4IELTS_WATCH_DIR);
    this.repoPath = path.resolve(options.repoPath || path.dirname(this.watchDir));
    this.agent = resolveAgentType(options.agent || DEFAULT_AGENT);
    this.pattern = options.pattern || DEFAULT_EZ4IELTS_PATTERN;
    this.settleMs = options.settleMs ?? DEFAULT_EZ4IELTS_SETTLE_MS;
    this.now = deps.now ?? (() => Date.now());
    this.logger = options.logger ?? (() => undefined);
    this.listFilesFn = deps.listFiles ?? defaultListFiles;
    this.statSignatureFn = deps.statSignature ?? defaultStatSignature;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const existingFiles = this.listMatchingFiles();
    existingFiles.forEach((filePath) => this.ignoredExistingPaths.add(filePath));
    this.initialized = true;

    this.logger(
      `[watch] ez4ielts auto-ingest enabled for ${this.watchDir} (${existingFiles.length} existing matching file(s) ignored)`
    );
  }

  async scan(): Promise<PrdAutoIngestResult[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    const results: PrdAutoIngestResult[] = [];
    const currentFiles = new Set(this.listMatchingFiles());

    for (const filePath of [...this.candidates.keys()]) {
      if (!currentFiles.has(filePath)) {
        this.candidates.delete(filePath);
      }
    }

    for (const filePath of currentFiles) {
      if (this.ignoredExistingPaths.has(filePath) || this.trackedPaths.has(filePath)) {
        continue;
      }

      const existingTask = await this.stateManager.getTaskByPrdPath(filePath);
      if (existingTask) {
        this.trackedPaths.add(filePath);
        results.push({
          filePath,
          taskId: existingTask.id,
          action: 'already-tracked',
          status: existingTask.status,
        });
        this.logger(`[watch] skipping already-tracked PRD ${path.basename(filePath)} (${existingTask.id})`);
        continue;
      }

      const signature = this.statSignature(filePath);
      const candidate = this.candidates.get(filePath);

      if (!candidate || candidate.signature !== signature) {
        this.candidates.set(filePath, {
          signature,
          stableSince: this.now(),
        });
        continue;
      }

      if (this.now() - candidate.stableSince < this.settleMs) {
        continue;
      }

      if (candidate.attemptedSignature === signature) {
        continue;
      }

      try {
        parsePRD(filePath);
      } catch (error) {
        candidate.attemptedSignature = signature;
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          filePath,
          action: 'invalid',
          error: message,
        });
        this.logger(`[watch] waiting for valid PRD ${path.basename(filePath)}: ${message}`);
        continue;
      }

      const queuedTask = await enqueueTaskFromPrd(filePath, {
        repoPath: this.repoPath,
        agent: this.agent,
        dedupeByPrdPath: true,
        stateManager: this.stateManager,
        scheduler: this.scheduler,
        now: this.now,
      });

      this.trackedPaths.add(filePath);
      this.candidates.delete(filePath);
      results.push({
        filePath,
        taskId: queuedTask.taskId,
        action: queuedTask.alreadyExists ? 'already-tracked' : 'ingested',
        status: queuedTask.latestTask.status,
      });
      this.logger(
        `[watch] ${queuedTask.alreadyExists ? 'tracked' : 'ingested'} ${path.basename(filePath)} as ${queuedTask.taskId} (${queuedTask.latestTask.status})`
      );
    }

    return results;
  }

  private listMatchingFiles(): string[] {
    return this.listFilesFn(this.watchDir)
      .filter((filePath) => matchesGlob(path.basename(filePath), this.pattern))
      .map((filePath) => path.resolve(filePath))
      .sort();
  }

  private statSignature(filePath: string): string {
    return this.statSignatureFn(filePath);
  }
}

function defaultListFiles(watchDir: string): string[] {
  if (!fs.existsSync(watchDir)) {
    return [];
  }

  return fs.readdirSync(watchDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(watchDir, entry.name));
}

function defaultStatSignature(filePath: string): string {
  const stats = fs.statSync(filePath);
  return `${stats.size}:${Math.trunc(stats.mtimeMs)}`;
}

function matchesGlob(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}
