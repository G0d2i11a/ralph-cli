import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Task } from '../types/task';
import { parsePRD } from '../utils/helpers';

export interface FinalizeResult {
  success: boolean;
  committed: boolean;
  message: string;
  commitMessage?: string;
}

function readGitDir(worktreePath: string): string {
  const dotGitPath = path.join(worktreePath, '.git');
  const content = fs.readFileSync(dotGitPath, 'utf-8').trim();
  const match = content.match(/^gitdir:\s+(.+)$/);

  if (!match) {
    throw new Error(`Unsupported worktree .git format at ${dotGitPath}`);
  }

  return path.resolve(worktreePath, match[1]);
}

function ensurePathInside(parent: string, candidate: string, label: string): void {
  const relativePath = path.relative(parent, candidate);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`${label} is outside allowed path: ${candidate}`);
  }
}

function assertFinalizerScope(task: Task): void {
  const repoPath = path.resolve(task.repoPath);
  const worktreePath = path.resolve(task.worktree);
  const allowedWorktreeRoot = path.join(repoPath, '.ralph-worktrees');
  const allowedGitWorktreeRoot = path.join(repoPath, '.git', 'worktrees');

  ensurePathInside(allowedWorktreeRoot, worktreePath, 'Worktree');

  const gitDir = readGitDir(worktreePath);
  ensurePathInside(allowedGitWorktreeRoot, gitDir, 'Git worktree metadata');
}

function buildCommitMessage(task: Task): string {
  try {
    const prd = parsePRD(task.prdPath);
    const title = prd.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 60);

    if (title) {
      return `feat(ralph): complete ${title}`;
    }
  } catch {
    // fall through to task-id based message
  }

  return `feat(ralph): complete ${task.id}`;
}

function runGit(worktreePath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: worktreePath,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function finalizeTaskOutput(task: Task): FinalizeResult {
  assertFinalizerScope(task);

  const worktreePath = path.resolve(task.worktree);
  const statusBefore = runGit(worktreePath, ['status', '--porcelain']);

  if (!statusBefore) {
    return {
      success: true,
      committed: false,
      message: 'No changes to commit',
    };
  }

  runGit(worktreePath, ['add', '-A']);

  const statusAfterAdd = runGit(worktreePath, ['status', '--porcelain']);
  if (!statusAfterAdd) {
    return {
      success: true,
      committed: false,
      message: 'No staged changes to commit',
    };
  }

  const commitMessage = buildCommitMessage(task);
  runGit(worktreePath, ['commit', '--no-verify', '-m', commitMessage]);

  return {
    success: true,
    committed: true,
    message: 'Committed task changes successfully',
    commitMessage,
  };
}
