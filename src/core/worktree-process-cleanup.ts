import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_GRACE_MS = 5000;
const DEFAULT_POLL_MS = 100;
const MAX_SCAN_DEPTH = 8;
const MAX_SCANNED_DIRS = 4000;
const DEFAULT_WORKTREE_LOCK_GLOBS = ['**/.next/lock', '**/.next.stale-build*/lock'];
const DEFAULT_WORKTREE_PROCESS_COMMAND_PATTERNS = ['next build', 'pnpm run build'];
const SKIPPED_DIRS = new Set([
  '.git',
  '.git-local',
  '.hg',
  '.ralph-cache',
  '.turbo',
  '.next',
  'node_modules',
]);
const SKIPPED_DIR_PREFIXES = ['.next.stale-build'];

export interface WorktreeProcessInfo {
  ppid?: number;
  pgid?: number;
  command?: string;
  cwd?: string;
}

export interface WorktreeCleanupTarget {
  pid: number;
  pgid?: number;
  command?: string;
  cwd?: string;
  lockPath: string;
  source?: 'lock_holder' | 'process_scan';
  signalPid: number;
  signalScope: 'process' | 'process_group';
}

export interface WorktreeCleanupSkippedProcess {
  pid: number;
  reason: 'not_running' | 'protected' | 'outside_worktree' | 'missing_process_info';
  lockPath: string;
  source?: 'lock_holder' | 'process_scan';
  command?: string;
  cwd?: string;
}

export interface WorktreeCleanupResult {
  taskId: string;
  worktreePath?: string;
  reason: string;
  lockPaths: string[];
  killed: WorktreeCleanupTarget[];
  skipped: WorktreeCleanupSkippedProcess[];
}

export interface WorktreeProcessCleanupOptions {
  taskId: string;
  worktreePath?: string;
  reason: string;
  protectedPids?: number[];
  allowProtectedDescendantCleanup?: boolean;
  lockPaths?: string[];
  lockGlobs?: string[];
  processCommandPatterns?: string[];
  graceMs?: number;
  pollMs?: number;
}

export interface WorktreeProcessCleanupDeps {
  listLockHolderPids?: (lockPath: string) => number[];
  listProcessCandidatePids?: (worktreePath: string, commandPatterns: string[]) => number[];
  getProcessInfo?: (pid: number) => WorktreeProcessInfo | undefined;
  isProcessRunning?: (pid: number) => boolean;
  terminateProcess?: (pid: number, signal?: NodeJS.Signals | number) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function resolveConfiguredWorktreeCleanupLockGlobs(
  config: { get: (key: string) => unknown }
): string[] | undefined {
  const rawValue = config.get('runner.worktreeCleanupLockGlobs');
  if (Array.isArray(rawValue)) {
    return rawValue.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  }

  if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
    return rawValue.split(',').map((value) => value.trim()).filter(Boolean);
  }

  return undefined;
}

function defaultIsProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcessCwd(pid: number): string | undefined {
  if (process.platform === 'win32') {
    return undefined;
  }

  try {
    const procCwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    if (procCwd) {
      return procCwd;
    }
  } catch {
    // Fall back to lsof below on platforms without /proc, especially macOS.
  }

  try {
    const output = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const cwdLine = output
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('n'));

    return cwdLine ? cwdLine.slice(1) : undefined;
  } catch {
    return undefined;
  }
}

export function readWorktreeProcessInfo(pid: number): WorktreeProcessInfo | undefined {
  if (process.platform === 'win32') {
    return undefined;
  }

  try {
    const output = execFileSync('ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'pgid=', '-o', 'command='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const match = output.match(/^(\d+)\s+(\d+)\s+([\s\S]*)$/);
    if (!match) {
      return undefined;
    }

    return {
      ppid: Number(match[1]),
      pgid: Number(match[2]),
      command: match[3],
      cwd: readProcessCwd(pid),
    };
  } catch {
    return undefined;
  }
}

export function listLockHolderPids(lockPath: string): number[] {
  try {
    const output = execFileSync('lsof', ['-F', 'p', lockPath], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return [...new Set(
      output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^p\d+$/.test(line))
        .map((line) => Number(line.slice(1)))
        .filter((pid) => Number.isInteger(pid) && pid > 0)
    )];
  } catch {
    return [];
  }
}

function normalizeProcessCommandPatterns(patterns?: string[]): string[] {
  const rawPatterns = Array.isArray(patterns) && patterns.length > 0
    ? patterns
    : DEFAULT_WORKTREE_PROCESS_COMMAND_PATTERNS;

  return [...new Set(
    rawPatterns
      .map((pattern) => typeof pattern === 'string' ? pattern.trim().replace(/\\/g, '/') : '')
      .filter(Boolean)
  )];
}

export function listWorktreeProcessCandidatePids(_worktreePath: string, commandPatterns?: string[]): number[] {
  if (process.platform === 'win32') {
    return [];
  }

  const patterns = normalizeProcessCommandPatterns(commandPatterns)
    .map((pattern) => pattern.toLowerCase());
  if (patterns.length === 0) {
    return [];
  }

  try {
    const output = execFileSync('ps', ['-axo', 'pid=', '-o', 'command='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    return [...new Set(
      output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
          const match = line.match(/^(\d+)\s+([\s\S]*)$/);
          if (!match) {
            return [];
          }

          const command = normalizeCommand(match[2]).toLowerCase();
          if (!patterns.some((pattern) => command.includes(pattern))) {
            return [];
          }

          const pid = Number(match[1]);
          const info = readWorktreeProcessInfo(pid);
          if (!info || !isProcessScopedToWorktree(info, _worktreePath)) {
            return [];
          }

          return [pid];
        })
        .filter((pid) => Number.isInteger(pid) && pid > 0)
    )];
  } catch {
    return [];
  }
}

function resolvePathForComparison(targetPath: string): string {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function isPathInside(childPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeCommand(command: string | undefined): string {
  return command ? command.replace(/\\/g, '/') : '';
}

function isProcessScopedToWorktree(info: WorktreeProcessInfo, worktreePath: string): boolean {
  const normalizedWorktree = resolvePathForComparison(worktreePath);

  if (info.cwd) {
    const cwd = resolvePathForComparison(info.cwd);
    if (isPathInside(cwd, normalizedWorktree)) {
      return true;
    }
  }

  const command = normalizeCommand(info.command);
  const normalizedCommandWorktree = normalizedWorktree.replace(/\\/g, '/');
  const resolvedCommandWorktree = path.resolve(worktreePath).replace(/\\/g, '/');

  return command.includes(normalizedCommandWorktree) || command.includes(resolvedCommandWorktree);
}

function isDescendantOf(
  pid: number,
  ancestorPid: number,
  getProcessInfo: (pid: number) => WorktreeProcessInfo | undefined
): boolean {
  const seen = new Set<number>();
  let currentPid = pid;

  while (!seen.has(currentPid)) {
    if (currentPid === ancestorPid) {
      return true;
    }

    seen.add(currentPid);
    const parentPid = getProcessInfo(currentPid)?.ppid;
    if (!parentPid || parentPid <= 1) {
      return false;
    }

    currentPid = parentPid;
  }

  return false;
}

function isProtectedPid(
  pid: number,
  protectedPids: number[],
  getProcessInfo: (pid: number) => WorktreeProcessInfo | undefined
): boolean {
  return protectedPids.some((protectedPid) => isDescendantOf(pid, protectedPid, getProcessInfo));
}

function isProtectedProcessGroup(
  pgid: number | undefined,
  protectedPids: number[],
  getProcessInfo: (pid: number) => WorktreeProcessInfo | undefined
): boolean {
  if (!pgid || pgid <= 1) {
    return false;
  }

  return protectedPids.some((protectedPid) => getProcessInfo(protectedPid)?.pgid === pgid);
}

function resolveSignalTarget(
  pid: number,
  info: WorktreeProcessInfo,
  protectedPids: number[],
  getProcessInfo: (pid: number) => WorktreeProcessInfo | undefined
): { signalPid: number; signalScope: 'process' | 'process_group' } {
  if (process.platform !== 'win32' && info.pgid && info.pgid > 1 && !isProtectedProcessGroup(info.pgid, protectedPids, getProcessInfo)) {
    return {
      signalPid: -info.pgid,
      signalScope: 'process_group',
    };
  }

  return {
    signalPid: pid,
    signalScope: 'process',
  };
}

function normalizeLockGlobs(lockGlobs?: string[]): string[] {
  const rawGlobs = Array.isArray(lockGlobs) && lockGlobs.length > 0
    ? lockGlobs
    : DEFAULT_WORKTREE_LOCK_GLOBS;
  const safeGlobs = rawGlobs
    .map((glob) => typeof glob === 'string' ? glob.trim().replace(/\\/g, '/') : '')
    .filter(Boolean)
    .map((glob) => glob.replace(/^\.\//, ''))
    .filter((glob) => (
      !path.isAbsolute(glob)
      && !glob.split('/').some((segment) => segment === '..')
    ));

  return safeGlobs.length > 0 ? [...new Set(safeGlobs)] : DEFAULT_WORKTREE_LOCK_GLOBS;
}

function segmentMatchesGlob(pattern: string, segment: string): boolean {
  if (pattern === '*') {
    return true;
  }

  if (!pattern.includes('*')) {
    return pattern === segment;
  }

  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${escaped}$`).test(segment);
}

function matchesGlobSegments(patternSegments: string[], pathSegments: string[]): boolean {
  if (patternSegments.length === 0) {
    return pathSegments.length === 0;
  }

  const [head, ...tail] = patternSegments;
  if (head === '**') {
    if (matchesGlobSegments(tail, pathSegments)) {
      return true;
    }

    return pathSegments.length > 0 && matchesGlobSegments(patternSegments, pathSegments.slice(1));
  }

  return pathSegments.length > 0
    && segmentMatchesGlob(head, pathSegments[0])
    && matchesGlobSegments(tail, pathSegments.slice(1));
}

function matchesAnyLockGlob(relativePath: string, lockGlobs: string[]): boolean {
  const normalizedRelativePath = relativePath.replace(/\\/g, '/');
  const pathSegments = normalizedRelativePath.split('/').filter(Boolean);

  return lockGlobs.some((glob) => {
    const patternSegments = glob.split('/').filter(Boolean);
    return matchesGlobSegments(patternSegments, pathSegments);
  });
}

function collectMatchingFilesInDirectory(input: {
  dir: string;
  worktreePath: string;
  lockGlobs: string[];
  lockPaths: string[];
}): void {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(input.dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const dirent of dirents) {
    if (!dirent.isFile() && !dirent.isSymbolicLink()) {
      continue;
    }

    const filePath = path.join(input.dir, dirent.name);
    const relativePath = path.relative(input.worktreePath, filePath);
    if (matchesAnyLockGlob(relativePath, input.lockGlobs)) {
      input.lockPaths.push(filePath);
    }
  }
}

function shouldInspectSkippedDirectoryFiles(dirName: string): boolean {
  return dirName !== 'node_modules'
    && dirName !== '.git'
    && dirName !== '.git-local'
    && dirName !== '.hg';
}

function isSkippedDirectoryName(dirName: string): boolean {
  return SKIPPED_DIRS.has(dirName)
    || SKIPPED_DIR_PREFIXES.some((prefix) => dirName.startsWith(prefix));
}

export function findKnownWorktreeLockPaths(worktreePath: string, lockGlobs?: string[]): string[] {
  if (!worktreePath || !fs.existsSync(worktreePath)) {
    return [];
  }

  const normalizedLockGlobs = normalizeLockGlobs(lockGlobs);
  const lockPaths: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: worktreePath, depth: 0 }];
  let scannedDirs = 0;

  while (queue.length > 0 && scannedDirs < MAX_SCANNED_DIRS) {
    const entry = queue.shift();
    if (!entry) {
      break;
    }

    scannedDirs++;

    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(entry.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    collectMatchingFilesInDirectory({
      dir: entry.dir,
      worktreePath,
      lockGlobs: normalizedLockGlobs,
      lockPaths,
    });

    for (const dirent of dirents) {
      if (!dirent.isDirectory()) {
        continue;
      }

      const childDir = path.join(entry.dir, dirent.name);

      if (entry.depth >= MAX_SCAN_DEPTH || isSkippedDirectoryName(dirent.name)) {
        if (shouldInspectSkippedDirectoryFiles(dirent.name)) {
          collectMatchingFilesInDirectory({
            dir: childDir,
            worktreePath,
            lockGlobs: normalizedLockGlobs,
            lockPaths,
          });
        }
        continue;
      }

      queue.push({ dir: childDir, depth: entry.depth + 1 });
    }
  }

  return [...new Set(lockPaths)];
}

async function waitUntilPidsExit(
  pids: number[],
  deadline: number,
  deps: {
    isProcessRunning: (pid: number) => boolean;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    pollMs: number;
  }
): Promise<boolean> {
  while (deps.now() < deadline) {
    if (pids.every((pid) => !deps.isProcessRunning(pid))) {
      return true;
    }

    await deps.sleep(deps.pollMs);
  }

  return pids.every((pid) => !deps.isProcessRunning(pid));
}

export async function cleanupWorktreeProcesses(
  options: WorktreeProcessCleanupOptions,
  deps: WorktreeProcessCleanupDeps = {}
): Promise<WorktreeCleanupResult> {
  const getProcessInfo = deps.getProcessInfo ?? readWorktreeProcessInfo;
  const isProcessRunning = deps.isProcessRunning ?? defaultIsProcessRunning;
  const terminateProcess = deps.terminateProcess ?? ((pid, signal) => process.kill(pid, signal));
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const listPidsForLock = deps.listLockHolderPids ?? listLockHolderPids;
  const listProcessCandidates = deps.listProcessCandidatePids ?? listWorktreeProcessCandidatePids;
  const lockPaths = options.lockPaths ?? (options.worktreePath ? findKnownWorktreeLockPaths(options.worktreePath, options.lockGlobs) : []);
  const result: WorktreeCleanupResult = {
    taskId: options.taskId,
    worktreePath: options.worktreePath,
    reason: options.reason,
    lockPaths,
    killed: [],
    skipped: [],
  };

  if (!options.worktreePath) {
    return result;
  }

  const holders = new Map<number, { lockPath: string; source: 'lock_holder' | 'process_scan' }>();
  for (const lockPath of lockPaths) {
    for (const pid of listPidsForLock(lockPath)) {
      if (!holders.has(pid)) {
        holders.set(pid, { lockPath, source: 'lock_holder' });
      }
    }
  }

  const commandPatterns = normalizeProcessCommandPatterns(options.processCommandPatterns);
  for (const pid of listProcessCandidates(options.worktreePath, commandPatterns)) {
    if (!holders.has(pid)) {
      holders.set(pid, { lockPath: '(process scan)', source: 'process_scan' });
    }
  }

  const protectedPids = (options.protectedPids || [])
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  for (const [pid, holder] of holders) {
    const { lockPath, source } = holder;
    if (!isProcessRunning(pid)) {
      result.skipped.push({ pid, reason: 'not_running', lockPath, source });
      continue;
    }

    const info = getProcessInfo(pid);
    if (!info) {
      result.skipped.push({ pid, reason: 'missing_process_info', lockPath, source });
      continue;
    }

    const isDirectlyProtected = protectedPids.includes(pid);
    const isProtectedDescendant = !isDirectlyProtected && isProtectedPid(pid, protectedPids, getProcessInfo);
    if (isDirectlyProtected || (isProtectedDescendant && !options.allowProtectedDescendantCleanup)) {
      result.skipped.push({
        pid,
        reason: 'protected',
        lockPath,
        source,
        command: info.command,
        cwd: info.cwd,
      });
      continue;
    }

    if (!isProcessScopedToWorktree(info, options.worktreePath)) {
      result.skipped.push({
        pid,
        reason: 'outside_worktree',
        lockPath,
        source,
        command: info.command,
        cwd: info.cwd,
      });
      continue;
    }

    const signalTarget = resolveSignalTarget(pid, info, protectedPids, getProcessInfo);
    const target: WorktreeCleanupTarget = {
      pid,
      pgid: info.pgid,
      command: info.command,
      cwd: info.cwd,
      lockPath,
      source,
      signalPid: signalTarget.signalPid,
      signalScope: signalTarget.signalScope,
    };

    try {
      terminateProcess(signalTarget.signalPid, 'SIGTERM');
    } catch {
      try {
        terminateProcess(pid, 'SIGTERM');
        target.signalPid = pid;
        target.signalScope = 'process';
      } catch {
        result.skipped.push({
          pid,
          reason: 'not_running',
          lockPath,
          source,
          command: info.command,
          cwd: info.cwd,
        });
        continue;
      }
    }

    const gracefulExit = await waitUntilPidsExit([pid], now() + graceMs, {
      isProcessRunning,
      now,
      sleep,
      pollMs,
    });

    if (!gracefulExit) {
      try {
        terminateProcess(target.signalPid, 'SIGKILL');
      } catch {
        if (target.signalPid !== pid) {
          try {
            terminateProcess(pid, 'SIGKILL');
            target.signalPid = pid;
            target.signalScope = 'process';
          } catch {
            // Best effort: leave result as killed so the event captures the attempted cleanup target.
          }
        }
      }

      await waitUntilPidsExit([pid], now() + graceMs, {
        isProcessRunning,
        now,
        sleep,
        pollMs,
      });
    }

    result.killed.push(target);
  }

  return result;
}
