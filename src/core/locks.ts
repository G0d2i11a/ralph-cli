import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getRalphPaths, RalphHomeOptions } from './paths';

const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 30000;
const LOCK_STALE_MS = 300000;

interface LockOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  staleMs?: number;
}

export interface RalphLockOptions extends LockOptions, RalphHomeOptions {}

function sanitizeSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return sanitized || 'lock';
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireDirectoryLock(lockDir: string, options: LockOptions): Promise<void> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const startedAt = now();
  const lockRoot = path.dirname(lockDir);
  const lockInfoPath = path.join(lockDir, 'owner.json');

  if (!fs.existsSync(lockRoot)) {
    fs.mkdirSync(lockRoot, { recursive: true });
  }

  while (true) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(lockInfoPath, JSON.stringify({
        pid: process.pid,
        acquiredAt: now(),
      }));
      return;
    } catch (error) {
      const lockError = error as NodeJS.ErrnoException;
      if (lockError.code !== 'EEXIST') {
        throw lockError;
      }

      if (isDirectoryLockStale(lockDir, lockInfoPath, { now, staleMs })) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }

      if (now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for lock ${lockDir}`);
      }

      await sleep(LOCK_RETRY_MS);
    }
  }
}

function releaseDirectoryLock(lockDir: string): void {
  fs.rmSync(lockDir, { recursive: true, force: true });
}

function isDirectoryLockStale(
  lockDir: string,
  lockInfoPath: string,
  options: { now: () => number; staleMs: number }
): boolean {
  try {
    if (fs.existsSync(lockInfoPath)) {
      const content = fs.readFileSync(lockInfoPath, 'utf-8');
      const lockInfo = JSON.parse(content) as { pid?: number };

      if (typeof lockInfo.pid === 'number') {
        try {
          process.kill(lockInfo.pid, 0);
          return false;
        } catch {
          return true;
        }
      }
    }

    const stats = fs.statSync(lockDir);
    return options.now() - stats.mtimeMs > options.staleMs;
  } catch {
    return false;
  }
}

export async function withDirectoryLock<T>(
  lockDir: string,
  operation: () => Promise<T>,
  options: LockOptions = {}
): Promise<T> {
  await acquireDirectoryLock(lockDir, options);

  try {
    return await operation();
  } finally {
    releaseDirectoryLock(lockDir);
  }
}

export function getTaskFinalizeLockDir(taskId: string, options: RalphHomeOptions = {}): string {
  return path.join(getRalphPaths(options).locksDir, 'finalize', sanitizeSegment(taskId));
}

export function getRepoMergeLockDir(repoPath: string, options: RalphHomeOptions = {}): string {
  const resolvedRepoPath = path.resolve(repoPath);
  const repoSlug = sanitizeSegment(path.basename(resolvedRepoPath));
  const repoHash = createHash('sha1').update(resolvedRepoPath).digest('hex');
  return path.join(getRalphPaths(options).locksDir, 'merge', `${repoSlug}-${repoHash}`);
}

export async function withTaskFinalizeLock<T>(
  taskId: string,
  operation: () => Promise<T>,
  options: RalphLockOptions = {}
): Promise<T> {
  const { ralphHome, homeDir, ...lockOptions } = options;
  return withDirectoryLock(getTaskFinalizeLockDir(taskId, { ralphHome, homeDir }), operation, lockOptions);
}

export async function withRepoMergeLock<T>(
  repoPath: string,
  operation: () => Promise<T>,
  options: RalphLockOptions = {}
): Promise<T> {
  const { ralphHome, homeDir, ...lockOptions } = options;
  return withDirectoryLock(getRepoMergeLockDir(repoPath, { ralphHome, homeDir }), operation, lockOptions);
}
