import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const WORKTREE_GIT_MAX_BUFFER = 20 * 1024 * 1024;

export interface ProgressBaseline {
  commitSHA: string;
  commitCount: number;
  workingTreeFiles: number;
  worktreeSignature: string;
  logSize: number;
}

export interface ProgressResult {
  hasProgress: boolean;
  reason: string;
  filesChanged: number;
  newCommits: number;
  headChanged?: boolean;
}

function runGit(worktreePath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: worktreePath,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: WORKTREE_GIT_MAX_BUFFER,
  });
}

function tryRunGit(worktreePath: string, args: string[]): string {
  try {
    return runGit(worktreePath, args);
  } catch {
    return '';
  }
}

export function captureProgressBaseline(worktreePath: string): ProgressBaseline {
  return {
    commitSHA: getLatestCommitSHA(worktreePath),
    commitCount: getCommitCount(worktreePath),
    workingTreeFiles: getChangedFilesCount(worktreePath),
    worktreeSignature: getWorktreeDiffSignature(worktreePath),
    logSize: 0,
  };
}

export function detectProgress(
  worktreePath: string,
  logPath: string,
  baseline: ProgressBaseline
): ProgressResult {
  const currentCommitCount = getCommitCount(worktreePath);
  const newCommits = currentCommitCount - baseline.commitCount;

  if (newCommits > 0) {
    return {
      hasProgress: true,
      reason: `${newCommits} new commit(s)`,
      filesChanged: 0,
      newCommits,
      headChanged: false,
    };
  }

  const currentCommitSHA = getLatestCommitSHA(worktreePath);
  if (currentCommitSHA && baseline.commitSHA && currentCommitSHA !== baseline.commitSHA) {
    return {
      hasProgress: true,
      reason: 'HEAD commit changed',
      filesChanged: 0,
      newCommits: 0,
      headChanged: true,
    };
  }

  const currentFiles = getChangedFilesCount(worktreePath);
  const filesChanged = Math.abs(currentFiles - baseline.workingTreeFiles);

  if (filesChanged > 0) {
    return {
      hasProgress: true,
      reason: `${filesChanged} file(s) changed in working tree`,
      filesChanged,
      newCommits: 0,
      headChanged: false,
    };
  }

  const currentWorktreeSignature = getWorktreeDiffSignature(worktreePath);
  if (currentWorktreeSignature && currentWorktreeSignature !== baseline.worktreeSignature) {
    return {
      hasProgress: true,
      reason: 'working tree diff content changed',
      filesChanged: currentFiles,
      newCommits: 0,
      headChanged: false,
    };
  }

  const hasSuccessMessage = checkAgentLogForSuccess(logPath);

  if (hasSuccessMessage) {
    return {
      hasProgress: false,
      reason: 'Agent reported success in log, but no objective file or commit evidence was found',
      filesChanged: 0,
      newCommits: 0,
      headChanged: false,
    };
  }

  return {
    hasProgress: false,
    reason: 'No commits, no file changes, no success messages',
    filesChanged: 0,
    newCommits: 0,
    headChanged: false,
  };
}

export function getWorktreeDiffSignature(worktreePath: string): string {
  try {
    const hash = createHash('sha256');
    hash.update(tryRunGit(worktreePath, ['status', '--porcelain=v1', '-z']));
    hash.update('\0diff\0');
    hash.update(tryRunGit(worktreePath, ['diff', '--binary', 'HEAD', '--']));

    const untrackedFiles = tryRunGit(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z'])
      .split('\0')
      .filter(Boolean)
      .sort();

    for (const relativePath of untrackedFiles) {
      const absolutePath = path.join(worktreePath, relativePath);
      hash.update('\0untracked\0');
      hash.update(relativePath);
      try {
        const stats = fs.statSync(absolutePath);
        if (stats.isFile()) {
          hash.update(fs.readFileSync(absolutePath));
        }
      } catch {
        hash.update('\0missing\0');
      }
    }

    return hash.digest('hex');
  } catch {
    return '';
  }
}

export function getLatestCommitSHA(worktreePath: string): string {
  try {
    return runGit(worktreePath, ['rev-parse', 'HEAD']).trim();
  } catch {
    return '';
  }
}

export function getCommitCount(worktreePath: string): number {
  try {
    const count = runGit(worktreePath, ['rev-list', '--count', 'HEAD']);
    return parseInt(count.trim(), 10);
  } catch {
    return 0;
  }
}

export function getCommitCountAheadOfBase(worktreePath: string, baseCommitSha?: string): number {
  if (!baseCommitSha) {
    return 0;
  }

  try {
    const count = runGit(worktreePath, ['rev-list', '--count', `${baseCommitSha}..HEAD`]);
    return parseInt(count.trim(), 10);
  } catch {
    return 0;
  }
}

export function getChangedFilesCount(worktreePath: string): number {
  try {
    return runGit(worktreePath, ['status', '--porcelain'])
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .length;
  } catch {
    return 0;
  }
}

export function getDiffFilesCountFromBase(worktreePath: string, baseCommitSha?: string): number {
  if (!baseCommitSha) {
    return 0;
  }

  try {
    return runGit(worktreePath, ['diff', '--name-only', baseCommitSha, '--'])
      .trim()
      .split('\n')
      .filter(Boolean)
      .length;
  } catch {
    return 0;
  }
}

function checkAgentLogForSuccess(logPath: string): boolean {
  try {
    if (!fs.existsSync(logPath)) {
      return false;
    }

    const stats = fs.statSync(logPath);
    const readSize = Math.min(250 * 1024, stats.size);
    const buffer = Buffer.alloc(readSize);

    const fd = fs.openSync(logPath, 'r');
    fs.readSync(fd, buffer, 0, readSize, Math.max(0, stats.size - readSize));
    fs.closeSync(fd);

    const logTail = buffer.toString('utf-8');
    const successPatterns = [
      /\*\*Done\*\*/i,
      /\*\*Result\*\*/i,
      /\*\*Validation\*\*/i,
      /\*\*Verification\*\*/i,
      /implemented and validated/i,
      /user story.*completed/i,
      /successfully.*implemented/i,
      /all.*tests.*pass/i,
      /passed targeted/i,
      /implementation.*complete/i,
      /task.*done/i,
      /Suggested commit message:/i,
      /✓.*success/i,
      /✅/,
    ];

    return successPatterns.some((pattern) => pattern.test(logTail));
  } catch {
    return false;
  }
}
