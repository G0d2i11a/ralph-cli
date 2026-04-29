import * as fs from 'fs';
import * as path from 'path';
import { AgentBackend, AgentType, DEFAULT_AGENT, resolveAgentBackend, resolveAgentType } from './agent';
import { TaskScheduler } from './scheduler';
import { StateManager } from './state';
import { enqueueTaskFromPrd } from './task-intake';
import { Task } from '../types/task';
import {
  assertPrdHasExplicitTitle,
  assertPrdIsExecutable,
  formatNonExecutablePrdMessage,
  isPrdExplicitlyNonExecutable,
  parsePRD,
} from '../utils/helpers';

export const DEFAULT_EZ4IELTS_WATCH_DIR = '';
export const DEFAULT_EZ4IELTS_PATTERN = 'ez4ielts-*.json';
export const DEFAULT_EZ4IELTS_SETTLE_MS = 2000;

interface CandidateState {
  signature: string;
  stableSince: number;
  attemptedSignature?: string;
}

interface DirectoryWatchSource {
  type: 'directory';
  rootDir: string;
  pattern: string;
  recursive: false;
  description: string;
}

interface GlobWatchSource {
  type: 'glob';
  rootDir: string;
  glob: string;
  matcher: RegExp;
  recursive: true;
  description: string;
}

type PrdWatchSource = DirectoryWatchSource | GlobWatchSource;

export interface PrdAutoIngestOptions {
  watchDir?: string;
  pattern?: string;
  glob?: string;
  repoPath?: string;
  agent?: string;
  backend?: string;
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
  action: 'ingested' | 'already-tracked' | 'invalid' | 'skipped';
  status?: string;
  error?: string;
  reason?: string;
}

function resolveConfiguredWatchDir(watchDir?: string): string | null {
  const candidate = watchDir?.trim() || process.env.RALPH_EZ4IELTS_WATCH_DIR?.trim() || DEFAULT_EZ4IELTS_WATCH_DIR;
  return candidate ? path.resolve(candidate) : null;
}

function hasGlobMagic(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

function normalizeGlobPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(pattern: string): RegExp {
  const normalizedPattern = normalizeGlobPath(pattern);
  let source = '^';

  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const char = normalizedPattern[index];

    if (char === '*') {
      if (normalizedPattern[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      continue;
    }

    source += escapeRegExp(char);
  }

  source += '$';
  return new RegExp(source);
}

function resolveStaticGlobRoot(absoluteGlob: string): string {
  const parsed = path.parse(absoluteGlob);
  const relativeParts = absoluteGlob
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean);
  const staticParts: string[] = [];

  for (const part of relativeParts) {
    if (hasGlobMagic(part)) {
      break;
    }

    staticParts.push(part);
  }

  if (staticParts.length === relativeParts.length) {
    staticParts.pop();
  }

  return staticParts.length > 0
    ? path.join(parsed.root, ...staticParts)
    : parsed.root;
}

function resolveGlobWatchSource(glob: string, repoPath: string): GlobWatchSource {
  const trimmedGlob = glob.trim();
  if (!trimmedGlob) {
    throw new Error('PRD auto-ingest requires a non-empty glob.');
  }

  const absoluteGlob = path.isAbsolute(trimmedGlob)
    ? path.resolve(trimmedGlob)
    : path.resolve(repoPath, trimmedGlob);

  return {
    type: 'glob',
    rootDir: resolveStaticGlobRoot(absoluteGlob),
    glob: absoluteGlob,
    matcher: globToRegExp(absoluteGlob),
    recursive: true,
    description: `${absoluteGlob} (repo ${repoPath})`,
  };
}

export class PrdAutoIngestor {
  private readonly stateManager: StateManager;
  private readonly scheduler: TaskScheduler;
  private readonly repoPath: string;
  private readonly agent: AgentType;
  private readonly backend: AgentBackend;
  private readonly source: PrdWatchSource;
  private readonly settleMs: number;
  private readonly now: () => number;
  private readonly logger: (message: string) => void;
  private readonly listFilesFn: (watchDir: string, options?: { recursive?: boolean }) => string[];
  private readonly statSignatureFn: (filePath: string) => string;
  private readonly ignoredExistingPaths = new Set<string>();
  private readonly trackedPaths = new Set<string>();
  private readonly candidates = new Map<string, CandidateState>();
  private initialized = false;

  constructor(options: PrdAutoIngestOptions = {}, deps: PrdAutoIngestDeps = {}) {
    const configuredGlob = options.glob?.trim();

    if (configuredGlob) {
      this.repoPath = path.resolve(options.repoPath || process.cwd());
      this.source = resolveGlobWatchSource(configuredGlob, this.repoPath);
    } else {
      const resolvedWatchDir = resolveConfiguredWatchDir(options.watchDir);
      if (!resolvedWatchDir) {
        throw new Error('ez4ielts auto-ingest requires a watch directory. Pass `--ez4ielts-dir` or set `ingestion.ez4ielts.watchDir` / `RALPH_EZ4IELTS_WATCH_DIR`.');
      }

      const pattern = options.pattern || DEFAULT_EZ4IELTS_PATTERN;
      this.repoPath = path.resolve(options.repoPath || path.dirname(resolvedWatchDir));
      this.source = {
        type: 'directory',
        rootDir: resolvedWatchDir,
        pattern,
        recursive: false,
        description: `${resolvedWatchDir} (${pattern})`,
      };
    }

    this.stateManager = deps.stateManager ?? new StateManager();
    this.scheduler = deps.scheduler ?? new TaskScheduler({ stateManager: this.stateManager });
    this.agent = resolveAgentType(options.agent || DEFAULT_AGENT);
    this.backend = resolveAgentBackend(options.backend);
    this.settleMs = options.settleMs ?? DEFAULT_EZ4IELTS_SETTLE_MS;
    this.now = deps.now ?? (() => Date.now());
    this.logger = options.logger ?? (() => undefined);
    this.listFilesFn = deps.listFiles
      ? (watchDir) => deps.listFiles!(watchDir)
      : defaultListFiles;
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
      `[watch] PRD auto-ingest enabled for ${this.source.description} (${existingFiles.length} existing matching file(s) ignored)`
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

      const existingTask = await this.findTrackedTask(filePath);
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
        assertPrdHasExplicitTitle(filePath);
        const prd = parsePRD(filePath);
        if (isPrdExplicitlyNonExecutable(prd)) {
          candidate.attemptedSignature = signature;
          const message = formatNonExecutablePrdMessage(filePath);
          results.push({
            filePath,
            action: 'skipped',
            reason: message,
          });
          this.logger(`[watch] skipping non-executable PRD ${path.basename(filePath)}: ${message}`);
          continue;
        }
        assertPrdIsExecutable(prd, filePath);
        const existingPrdTask = await this.findTrackedTask(filePath, prd.id);
        if (existingPrdTask) {
          this.trackedPaths.add(filePath);
          this.candidates.delete(filePath);
          results.push({
            filePath,
            taskId: existingPrdTask.id,
            action: 'already-tracked',
            status: existingPrdTask.status,
          });
          this.logger(`[watch] skipping already-tracked PRD ${path.basename(filePath)} (${existingPrdTask.id})`);
          continue;
        }
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

      let queuedTask;
      try {
        queuedTask = await enqueueTaskFromPrd(filePath, {
          repoPath: this.repoPath,
          agent: this.agent,
          backend: this.backend,
          allowMixedHome: false,
          dedupeByPrdPath: true,
          stateManager: this.stateManager,
          scheduler: this.scheduler,
          now: this.now,
        });
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
    return this.listFilesFn(this.source.rootDir, { recursive: this.source.recursive })
      .filter((filePath) => this.matchesSource(filePath))
      .map((filePath) => path.resolve(filePath))
      .sort();
  }

  private matchesSource(filePath: string): boolean {
    if (this.source.type === 'directory') {
      return matchesGlob(path.basename(filePath), this.source.pattern);
    }

    return this.source.matcher.test(normalizeGlobPath(path.resolve(filePath)));
  }

  private statSignature(filePath: string): string {
    return this.statSignatureFn(filePath);
  }

  private async findTrackedTask(filePath: string, prdId?: string): Promise<Task | null> {
    const resolvedPrdPath = path.resolve(filePath);
    const resolvedRepoPath = path.resolve(this.repoPath);
    const tasks = await this.stateManager.listTasks();

    return tasks.find((task) => {
      if (path.resolve(task.prdPath) === resolvedPrdPath) {
        return true;
      }

      return Boolean(
        prdId
          && task.prdId === prdId
          && path.resolve(task.repoPath) === resolvedRepoPath
      );
    }) || null;
  }
}

function defaultListFiles(watchDir: string, options: { recursive?: boolean } = {}): string[] {
  if (!fs.existsSync(watchDir)) {
    return [];
  }

  const files: string[] = [];
  for (const entry of fs.readdirSync(watchDir, { withFileTypes: true })) {
    const entryPath = path.join(watchDir, entry.name);

    if (entry.isFile()) {
      files.push(entryPath);
      continue;
    }

    if (options.recursive && entry.isDirectory()) {
      files.push(...defaultListFiles(entryPath, options));
    }
  }

  return files;
}

function defaultStatSignature(filePath: string): string {
  const stats = fs.statSync(filePath);
  return `${stats.size}:${Math.trunc(stats.mtimeMs)}`;
}

function matchesGlob(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}
