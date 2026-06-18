import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../config/manager';
import { Task, TaskStatus } from '../types/task';
import { ReclamationDecision } from './reclamation-policy';
import { WorktreeInspection, WorktreeManager } from './worktree';

export interface ReclamationEvidenceCandidate {
  kind: 'task_worktree' | 'orphan_worktree';
  task?: Task;
  taskId?: string;
  status?: TaskStatus | 'orphan';
  repoPath: string;
  worktree: string;
  tier: string;
  inspection?: WorktreeInspection;
}

export interface ReclamationEvidenceArtifact {
  kind:
    | 'manifest'
    | 'task_snapshot'
    | 'inspection'
    | 'status_porcelain'
    | 'status_short'
    | 'diff_patch'
    | 'cached_diff_patch'
    | 'untracked_file_list'
    | 'untracked_file_copy'
    | 'tracked_file_list'
    | 'worktree_list'
    | 'agent_log_tail'
    | 'task_event_log_tail'
    | 'restore_instructions';
  relativePath: string;
  bytes: number;
  sha256?: string;
  command?: string[];
}

export interface ReclamationEvidenceManifest {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  mode: string;
  complete: boolean;
  candidate: {
    kind: 'task_worktree' | 'orphan_worktree';
    taskId?: string;
    status?: TaskStatus | 'orphan';
    repoPath: string;
    worktree: string;
    branch?: string;
    head?: string;
    baseCommitSha?: string;
  };
  decision: ReclamationDecision;
  taskSnapshot?: Task;
  inspection?: WorktreeInspection;
  limits: {
    maxBytesPerCandidate: number;
    maxUntrackedFiles: number;
    maxUntrackedBytes: number;
    maxSingleUntrackedFileBytes: number;
  };
  artifacts: ReclamationEvidenceArtifact[];
  restore: {
    notes: string;
    applyPatchCommand?: string;
    applyCachedPatchCommand?: string;
    untrackedFilesRelativeDir?: string;
  };
}

export interface EvidenceArchiveResult {
  ok: boolean;
  complete: boolean;
  dir?: string;
  manifestPath?: string;
  bytes?: number;
  error?: string;
}

interface WorktreeEvidenceArchiverDeps {
  ralphHome: string;
  configManager: Pick<ConfigManager, 'get'>;
  worktreeManager: WorktreeManager;
  now?: () => number;
}

interface EvidenceRetentionOptions {
  maxTotalBytes: number;
  maxAgeHours: number;
  incompleteTempRetentionHours: number;
  excludePaths?: string[];
}

interface EvidenceArchiveEntry {
  path: string;
  bytes: number;
  createdAtMs: number;
}

const HOUR_MS = 60 * 60 * 1000;
const EVIDENCE_DATE_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function getNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function getBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'worktree';
}

function readTail(filePath: string, maxBytes: number): Buffer | undefined {
  if (!filePath || !fs.existsSync(filePath)) {
    return undefined;
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    return undefined;
  }

  const length = Math.min(stat.size, Math.max(0, maxBytes));
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
  } finally {
    fs.closeSync(fd);
  }
  return buffer;
}

function resolveEvidenceRoot(ralphHome: string, configuredDir: unknown): string {
  if (typeof configuredDir === 'string' && configuredDir.trim()) {
    return path.resolve(configuredDir);
  }

  return path.join(ralphHome, 'reclamation', 'evidence');
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export class WorktreeEvidenceArchiver {
  private readonly ralphHome: string;
  private readonly configManager: Pick<ConfigManager, 'get'>;
  private readonly worktreeManager: WorktreeManager;
  private readonly now: () => number;

  constructor(deps: WorktreeEvidenceArchiverDeps) {
    this.ralphHome = deps.ralphHome;
    this.configManager = deps.configManager;
    this.worktreeManager = deps.worktreeManager;
    this.now = deps.now ?? (() => Date.now());
  }

  async archive(
    candidate: ReclamationEvidenceCandidate,
    decision: ReclamationDecision,
    options: { mode?: string } = {},
  ): Promise<EvidenceArchiveResult> {
    if (!getBoolean(this.configManager.get('reclamation.evidence.enabled'), true)) {
      return { ok: false, complete: false, error: 'evidence_disabled' };
    }

    const createdAt = new Date(this.now()).toISOString();
    const dateSegment = createdAt.slice(0, 10);
    const id = this.buildArchiveId(candidate);
    const evidenceRoot = resolveEvidenceRoot(this.ralphHome, this.configManager.get('reclamation.evidence.dir'));
    const tempDir = this.uniqueFinalDir(path.join(evidenceRoot, '.tmp', id));
    const finalDir = this.uniqueFinalDir(path.join(evidenceRoot, dateSegment, id));
    const artifacts: ReclamationEvidenceArtifact[] = [];
    const maxBytesPerCandidate = getNumber(this.configManager.get('reclamation.evidence.maxBytesPerCandidate'), 100 * 1024 * 1024);
    const maxUntrackedFiles = getNumber(this.configManager.get('reclamation.evidence.maxUntrackedFiles'), 500);
    const maxUntrackedBytes = getNumber(this.configManager.get('reclamation.evidence.maxUntrackedBytes'), 50 * 1024 * 1024);
    const maxSingleUntrackedFileBytes = getNumber(this.configManager.get('reclamation.evidence.maxSingleUntrackedFileBytes'), 10 * 1024 * 1024);
    const logTailBytes = getNumber(this.configManager.get('reclamation.evidence.logTailBytes'), 256 * 1024);
    const retention = this.resolveRetentionOptions();
    const cleanupIncompleteOnFailure = getBoolean(this.configManager.get('reclamation.evidence.cleanupIncompleteOnFailure'), true);

    if (getBoolean(this.configManager.get('reclamation.evidence.pruneBeforeArchive'), true)) {
      this.pruneEvidenceRoot(evidenceRoot, retention);
    }

    if (retention.maxTotalBytes > 0 && this.measureEvidenceArchiveBytes(evidenceRoot) >= retention.maxTotalBytes) {
      return {
        ok: false,
        complete: false,
        error: 'evidence_archive_total_limit_exceeded',
      };
    }

    try {
      fs.mkdirSync(tempDir, { recursive: true });

      const writeBuffer = (
        kind: ReclamationEvidenceArtifact['kind'],
        relativePath: string,
        buffer: Buffer,
        command?: string[],
      ) => {
        const absolutePath = path.join(tempDir, relativePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, buffer);
        artifacts.push({
          kind,
          relativePath,
          bytes: buffer.byteLength,
          sha256: sha256(buffer),
          command,
        });
      };

      const writeText = (
        kind: ReclamationEvidenceArtifact['kind'],
        relativePath: string,
        content: string,
        command?: string[],
      ) => writeBuffer(kind, relativePath, Buffer.from(content, 'utf-8'), command);

      const writeJson = (
        kind: ReclamationEvidenceArtifact['kind'],
        relativePath: string,
        value: unknown,
      ) => writeText(kind, relativePath, `${JSON.stringify(value, null, 2)}\n`);

      if (getBoolean(this.configManager.get('reclamation.evidence.includeTaskSnapshot'), true) && candidate.task) {
        writeJson('task_snapshot', 'task.json', candidate.task);
      }

      writeJson('inspection', 'inspection.json', candidate.inspection ?? {});

      if (getBoolean(this.configManager.get('reclamation.evidence.includeStatus'), true)) {
        writeText(
          'status_porcelain',
          'git-status-porcelain-v2.txt',
          await this.worktreeManager.getWorktreeStatusPorcelainV2(candidate.worktree),
          ['git', 'status', '--porcelain=v2', '--branch'],
        );
        writeText(
          'status_short',
          'git-status-short.txt',
          await this.worktreeManager.getWorktreeStatusShort(candidate.worktree),
          ['git', 'status', '--short', '--branch'],
        );
        writeText(
          'worktree_list',
          'git-worktree-list-porcelain.txt',
          await this.worktreeManager.getWorktreeListPorcelain(candidate.repoPath),
          ['git', 'worktree', 'list', '--porcelain'],
        );
      }

      if (getBoolean(this.configManager.get('reclamation.evidence.includePatches'), true)) {
        writeText(
          'diff_patch',
          'git-diff.patch',
          await this.worktreeManager.getWorktreeDiffPatch(candidate.worktree),
          ['git', 'diff', '--binary', '--full-index'],
        );
        writeText(
          'cached_diff_patch',
          'git-diff-cached.patch',
          await this.worktreeManager.getWorktreeCachedDiffPatch(candidate.worktree),
          ['git', 'diff', '--cached', '--binary', '--full-index'],
        );
      }

      if (getBoolean(this.configManager.get('reclamation.evidence.includeFileList'), true)) {
        writeText(
          'tracked_file_list',
          'tracked-files.txt',
          `${(await this.worktreeManager.listTrackedAndOtherFiles(candidate.worktree)).join('\n')}\n`,
          ['git', 'ls-files', '-co', '--exclude-standard'],
        );
      }

      let copiedUntrackedBytes = 0;
      let copiedUntrackedFiles = 0;
      let untrackedFileList: string[] = [];

      if (getBoolean(this.configManager.get('reclamation.evidence.includeUntrackedFiles'), true)) {
        untrackedFileList = await this.worktreeManager.listUntrackedFiles(candidate.worktree);
        writeText(
          'untracked_file_list',
          'untracked-files.txt',
          `${untrackedFileList.join('\n')}${untrackedFileList.length > 0 ? '\n' : ''}`,
          ['git', 'ls-files', '--others', '--exclude-standard'],
        );

        const worktreeRealPath = fs.realpathSync(candidate.worktree);
        for (const relativeFile of untrackedFileList.slice(0, maxUntrackedFiles)) {
          const absoluteFile = path.resolve(candidate.worktree, relativeFile);
          if (!isPathInside(worktreeRealPath, fs.existsSync(absoluteFile) ? fs.realpathSync(path.dirname(absoluteFile)) : absoluteFile)) {
            continue;
          }

          const stat = fs.lstatSync(absoluteFile);
          if (!stat.isFile() || stat.size > maxSingleUntrackedFileBytes || copiedUntrackedBytes + stat.size > maxUntrackedBytes) {
            continue;
          }

          const destination = path.join(tempDir, 'untracked', relativeFile);
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.copyFileSync(absoluteFile, destination);
          const buffer = fs.readFileSync(destination);
          artifacts.push({
            kind: 'untracked_file_copy',
            relativePath: path.relative(tempDir, destination),
            bytes: buffer.byteLength,
            sha256: sha256(buffer),
          });
          copiedUntrackedBytes += stat.size;
          copiedUntrackedFiles += 1;
        }
      }

      if (candidate.task && getBoolean(this.configManager.get('reclamation.evidence.includeAgentLogTail'), true)) {
        const tail = readTail(candidate.task.logPath, logTailBytes);
        if (tail) {
          writeBuffer('agent_log_tail', 'agent-log-tail.txt', tail);
        }
      }

      if (candidate.task?.eventLogPath && getBoolean(this.configManager.get('reclamation.evidence.includeTaskEventLogTail'), true)) {
        const tail = readTail(candidate.task.eventLogPath, logTailBytes);
        if (tail) {
          writeBuffer('task_event_log_tail', 'task-events-tail.jsonl', tail);
        }
      }

      writeText(
        'restore_instructions',
        'restore.md',
        [
          '# Ralph Worktree Reclamation Evidence',
          '',
          `Worktree: ${candidate.worktree}`,
          `Task: ${candidate.taskId ?? 'orphan'}`,
          '',
          'Tracked changes can be reviewed with `git apply --stat git-diff.patch` and replayed with `git apply git-diff.patch` from a compatible checkout.',
          'Staged changes are captured separately in `git-diff-cached.patch`.',
          copiedUntrackedFiles > 0 ? 'Copied untracked files are under `untracked/`.' : 'No untracked files were copied.',
          '',
        ].join('\n'),
      );

      const bytes = this.measureDirectoryBytes(tempDir);
      if (bytes > maxBytesPerCandidate) {
        const manifestPath = path.join(tempDir, 'manifest.json');
        const manifest = this.buildManifest(id, candidate, decision, options.mode ?? 'manual', createdAt, false, artifacts, {
          maxBytesPerCandidate,
          maxUntrackedFiles,
          maxUntrackedBytes,
          maxSingleUntrackedFileBytes,
        });
        fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        if (cleanupIncompleteOnFailure) {
          this.removePath(tempDir);
        }
        return {
          ok: false,
          complete: false,
          dir: cleanupIncompleteOnFailure ? undefined : tempDir,
          manifestPath: cleanupIncompleteOnFailure ? undefined : manifestPath,
          bytes,
          error: 'evidence_archive_limit_exceeded',
        };
      }

      const manifest = this.buildManifest(id, candidate, decision, options.mode ?? 'manual', createdAt, true, artifacts, {
        maxBytesPerCandidate,
        maxUntrackedFiles,
        maxUntrackedBytes,
        maxSingleUntrackedFileBytes,
      });
      writeText('manifest', 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

      const archiveBytes = this.measureDirectoryBytes(tempDir);
      if (retention.maxTotalBytes > 0 && archiveBytes > retention.maxTotalBytes) {
        if (cleanupIncompleteOnFailure) {
          this.removePath(tempDir);
        }
        return {
          ok: false,
          complete: false,
          dir: cleanupIncompleteOnFailure ? undefined : tempDir,
          manifestPath: cleanupIncompleteOnFailure ? undefined : path.join(tempDir, 'manifest.json'),
          bytes: archiveBytes,
          error: 'evidence_archive_total_limit_exceeded',
        };
      }

      fs.mkdirSync(path.dirname(finalDir), { recursive: true });
      fs.renameSync(tempDir, finalDir);

      if (getBoolean(this.configManager.get('reclamation.evidence.pruneAfterArchive'), true)) {
        this.pruneEvidenceRoot(evidenceRoot, {
          ...retention,
          excludePaths: [finalDir],
        });
      }

      return {
        ok: true,
        complete: true,
        dir: finalDir,
        manifestPath: path.join(finalDir, 'manifest.json'),
        bytes: archiveBytes,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const dir = fs.existsSync(tempDir) ? tempDir : undefined;
      const manifestPath = dir && fs.existsSync(path.join(tempDir, 'manifest.json'))
        ? path.join(tempDir, 'manifest.json')
        : undefined;
      const bytes = dir ? this.measureDirectoryBytes(tempDir) : undefined;
      if (dir && cleanupIncompleteOnFailure) {
        this.removePath(tempDir);
      }
      return {
        ok: false,
        complete: false,
        dir: cleanupIncompleteOnFailure ? undefined : dir,
        manifestPath: cleanupIncompleteOnFailure ? undefined : manifestPath,
        bytes,
        error: message,
      };
    }
  }

  private buildArchiveId(candidate: ReclamationEvidenceCandidate): string {
    const status = sanitizePathSegment(String(candidate.status ?? 'unknown'));
    const identity = sanitizePathSegment(candidate.taskId ?? path.basename(candidate.worktree));
    const head = candidate.inspection?.head ? `-${candidate.inspection.head.slice(0, 12)}` : '';
    return `${identity}-${status}-${this.now()}${head}`;
  }

  private uniqueFinalDir(baseDir: string): string {
    if (!fs.existsSync(baseDir)) {
      return baseDir;
    }

    for (let index = 1; index < 1000; index += 1) {
      const candidate = `${baseDir}-${index}`;
      if (!fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return `${baseDir}-${crypto.randomBytes(4).toString('hex')}`;
  }

  private measureDirectoryBytes(dir: string): number {
    if (!fs.existsSync(dir)) {
      return 0;
    }

    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += this.measureDirectoryBytes(absolutePath);
        continue;
      }

      if (entry.isFile()) {
        total += fs.statSync(absolutePath).size;
      }
    }
    return total;
  }

  private resolveRetentionOptions(): EvidenceRetentionOptions {
    return {
      maxTotalBytes: Math.max(0, getNumber(this.configManager.get('reclamation.evidence.maxTotalBytes'), 512 * 1024 * 1024)),
      maxAgeHours: Math.max(0, getNumber(this.configManager.get('reclamation.evidence.maxAgeHours'), 24)),
      incompleteTempRetentionHours: Math.max(0, getNumber(this.configManager.get('reclamation.evidence.incompleteTempRetentionHours'), 1)),
    };
  }

  private pruneEvidenceRoot(evidenceRoot: string, options: EvidenceRetentionOptions): void {
    if (!fs.existsSync(evidenceRoot)) {
      return;
    }

    this.pruneIncompleteTempArchives(evidenceRoot, options.incompleteTempRetentionHours);

    if (options.maxAgeHours >= 0) {
      const cutoffMs = this.now() - options.maxAgeHours * HOUR_MS;
      for (const entry of this.listEvidenceArchiveEntries(evidenceRoot, options.excludePaths)) {
        if (entry.createdAtMs < cutoffMs && this.removePath(entry.path)) {
          this.removeEmptyDateDir(path.dirname(entry.path), evidenceRoot);
        }
      }
    }

    if (options.maxTotalBytes <= 0) {
      return;
    }

    let entries = this.listEvidenceArchiveEntries(evidenceRoot, options.excludePaths)
      .sort((left, right) => left.createdAtMs - right.createdAtMs);
    let totalBytes = entries.reduce((total, entry) => total + entry.bytes, 0);

    for (const entry of entries) {
      if (totalBytes <= options.maxTotalBytes) {
        break;
      }

      if (this.removePath(entry.path)) {
        totalBytes -= entry.bytes;
        this.removeEmptyDateDir(path.dirname(entry.path), evidenceRoot);
      }
    }

    entries = this.listEvidenceArchiveEntries(evidenceRoot, options.excludePaths);
    totalBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
    if (totalBytes <= options.maxTotalBytes) {
      this.removeEmptyDateDirs(evidenceRoot);
    }
  }

  private pruneIncompleteTempArchives(evidenceRoot: string, retentionHours: number): void {
    const tempRoot = path.join(evidenceRoot, '.tmp');
    if (!fs.existsSync(tempRoot)) {
      return;
    }

    const cutoffMs = this.now() - retentionHours * HOUR_MS;
    for (const entry of this.safeReadDir(tempRoot)) {
      const absolutePath = path.join(tempRoot, entry.name);
      const stat = this.safeLstat(absolutePath);
      if (!stat || stat.mtimeMs >= cutoffMs) {
        continue;
      }
      this.removePath(absolutePath);
    }

    this.removeEmptyDir(tempRoot);
  }

  private measureEvidenceArchiveBytes(evidenceRoot: string): number {
    return this.listEvidenceArchiveEntries(evidenceRoot)
      .reduce((total, entry) => total + entry.bytes, 0);
  }

  private listEvidenceArchiveEntries(evidenceRoot: string, excludePaths: string[] = []): EvidenceArchiveEntry[] {
    if (!fs.existsSync(evidenceRoot)) {
      return [];
    }

    const entries: EvidenceArchiveEntry[] = [];
    for (const entry of this.safeReadDir(evidenceRoot)) {
      if (entry.name === '.tmp') {
        continue;
      }

      const absolutePath = path.join(evidenceRoot, entry.name);
      if (entry.isDirectory() && EVIDENCE_DATE_DIR_PATTERN.test(entry.name)) {
        for (const archiveEntry of this.safeReadDir(absolutePath)) {
          const archivePath = path.join(absolutePath, archiveEntry.name);
          const stat = this.safeLstat(archivePath);
          if (!stat || this.isExcludedPath(archivePath, excludePaths)) {
            continue;
          }
          entries.push({
            path: archivePath,
            bytes: this.measurePathBytes(archivePath),
            createdAtMs: this.readArchiveCreatedAtMs(archivePath, stat.mtimeMs),
          });
        }
        continue;
      }

      const stat = this.safeLstat(absolutePath);
      if (!stat || !stat.isDirectory() || !fs.existsSync(path.join(absolutePath, 'manifest.json'))) {
        continue;
      }
      if (this.isExcludedPath(absolutePath, excludePaths)) {
        continue;
      }
      entries.push({
        path: absolutePath,
        bytes: this.measurePathBytes(absolutePath),
        createdAtMs: this.readArchiveCreatedAtMs(absolutePath, stat.mtimeMs),
      });
    }

    return entries;
  }

  private measurePathBytes(absolutePath: string): number {
    const stat = this.safeLstat(absolutePath);
    if (!stat) {
      return 0;
    }
    if (stat.isDirectory()) {
      return this.measureDirectoryBytes(absolutePath);
    }
    return stat.isFile() ? stat.size : 0;
  }

  private readArchiveCreatedAtMs(archivePath: string, fallbackMs: number): number {
    const manifestPath = path.join(archivePath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return fallbackMs;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { createdAt?: unknown };
      if (typeof parsed.createdAt === 'string') {
        const createdAtMs = Date.parse(parsed.createdAt);
        if (Number.isFinite(createdAtMs)) {
          return createdAtMs;
        }
      }
    } catch {
      return fallbackMs;
    }

    return fallbackMs;
  }

  private safeReadDir(dir: string): fs.Dirent[] {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  }

  private safeLstat(absolutePath: string): fs.Stats | undefined {
    try {
      return fs.lstatSync(absolutePath);
    } catch {
      return undefined;
    }
  }

  private isExcludedPath(absolutePath: string, excludePaths: string[]): boolean {
    const resolvedPath = path.resolve(absolutePath);
    return excludePaths.some((excludePath) => {
      const resolvedExclude = path.resolve(excludePath);
      return resolvedPath === resolvedExclude || isPathInside(resolvedExclude, resolvedPath);
    });
  }

  private removePath(absolutePath: string): boolean {
    try {
      fs.rmSync(absolutePath, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  private removeEmptyDateDirs(evidenceRoot: string): void {
    for (const entry of this.safeReadDir(evidenceRoot)) {
      if (!entry.isDirectory() || !EVIDENCE_DATE_DIR_PATTERN.test(entry.name)) {
        continue;
      }
      this.removeEmptyDateDir(path.join(evidenceRoot, entry.name), evidenceRoot);
    }
  }

  private removeEmptyDateDir(dateDir: string, evidenceRoot: string): void {
    if (path.dirname(dateDir) !== evidenceRoot || !EVIDENCE_DATE_DIR_PATTERN.test(path.basename(dateDir))) {
      return;
    }
    this.removeEmptyDir(dateDir);
  }

  private removeEmptyDir(dir: string): void {
    try {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
      }
    } catch {
      // Best-effort cleanup only.
    }
  }

  private buildManifest(
    id: string,
    candidate: ReclamationEvidenceCandidate,
    decision: ReclamationDecision,
    mode: string,
    createdAt: string,
    complete: boolean,
    artifacts: ReclamationEvidenceArtifact[],
    limits: ReclamationEvidenceManifest['limits'],
  ): ReclamationEvidenceManifest {
    return {
      schemaVersion: 1,
      id,
      createdAt,
      mode,
      complete,
      candidate: {
        kind: candidate.kind,
        taskId: candidate.taskId,
        status: candidate.status,
        repoPath: candidate.repoPath,
        worktree: candidate.worktree,
        branch: candidate.inspection?.branch,
        head: candidate.inspection?.head,
        baseCommitSha: candidate.task?.baseCommitSha,
      },
      decision,
      taskSnapshot: candidate.task,
      inspection: candidate.inspection,
      limits,
      artifacts,
      restore: {
        notes: 'Review patches and copied untracked files before restoring work from this evidence archive.',
        applyPatchCommand: 'git apply git-diff.patch',
        applyCachedPatchCommand: 'git apply --cached git-diff-cached.patch',
        untrackedFilesRelativeDir: 'untracked',
      },
    };
  }
}
