import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Task } from '../types/task';
import { detectPackageManager, findInstallRoot } from './bootstrap';
import { parsePRD } from '../utils/helpers';

export interface FinalizeResult {
  success: boolean;
  committed: boolean;
  message: string;
  commitMessage?: string;
}

interface PackageManifest {
  scripts?: Record<string, string>;
}

const QUALITY_GATE_SCRIPTS = ['typecheck', 'lint', 'build'] as const;

function resolveExistingPath(targetPath: string): string {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
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
  const normalizedParent = resolveExistingPath(parent);
  const normalizedCandidate = resolveExistingPath(candidate);
  const relativePath = path.relative(normalizedParent, normalizedCandidate);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`${label} is outside allowed path: ${normalizedCandidate}`);
  }
}

function assertFinalizerScope(task: Task): void {
  const repoPath = resolveExistingPath(task.repoPath);
  const worktreePath = resolveExistingPath(task.worktree);
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
    // Fall through to task-id based message.
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

function appendFinalizeLog(task: Task, message: string): void {
  const logDir = path.dirname(task.logPath);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  fs.appendFileSync(task.logPath, `[Finalize] ${message}\n`);
}

function readPackageManifest(installRoot: string): PackageManifest | null {
  const packageJsonPath = path.join(installRoot, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as PackageManifest;
}

function runQualityGates(task: Task): string[] {
  const installRoot = findInstallRoot(task.worktree, task.repoPath);
  if (!installRoot) {
    appendFinalizeLog(task, 'Skipped quality gates (no package.json detected)');
    return [];
  }

  const manifest = readPackageManifest(installRoot);
  if (!manifest?.scripts) {
    appendFinalizeLog(task, `Skipped quality gates (no scripts in ${installRoot})`);
    return [];
  }

  const availableScripts = QUALITY_GATE_SCRIPTS.filter((scriptName) => typeof manifest.scripts?.[scriptName] === 'string');
  if (availableScripts.length === 0) {
    appendFinalizeLog(task, `Skipped quality gates (no typecheck/lint/build scripts in ${installRoot})`);
    return [];
  }

  const packageManager = detectPackageManager(task.worktree, task.repoPath) ?? 'npm';

  for (const scriptName of availableScripts) {
    appendFinalizeLog(task, `Running quality gate: ${packageManager} run ${scriptName} (cwd: ${installRoot})`);
    const result = spawnSync(packageManager, ['run', scriptName], {
      cwd: installRoot,
      encoding: 'utf-8',
      env: process.env,
    });

    if (result.stdout?.trim()) {
      appendFinalizeLog(task, result.stdout.trim());
    }
    if (result.stderr?.trim()) {
      appendFinalizeLog(task, result.stderr.trim());
    }

    if (result.error) {
      throw new Error(`Quality gate \"${scriptName}\" failed to start: ${result.error.message}`);
    }

    if (result.status !== 0) {
      const errorMessage = result.stderr?.trim() || result.stdout?.trim() || `exit code ${result.status}`;
      throw new Error(`Quality gate \"${scriptName}\" failed: ${errorMessage}`);
    }
  }

  appendFinalizeLog(task, `Quality gates passed: ${availableScripts.join(', ')}`);
  return availableScripts;
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

  const qualityGates = runQualityGates(task);

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

  const qualityGateSuffix = qualityGates.length > 0
    ? ` after quality gates (${qualityGates.join(', ')})`
    : '';

  return {
    success: true,
    committed: true,
    message: `Committed task changes successfully${qualityGateSuffix}`,
    commitMessage,
  };
}
