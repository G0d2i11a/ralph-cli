import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../config/manager';
import { Task } from '../types/task';
import { detectPackageManager, findInstallRoot } from './bootstrap';
import { resolveWorkspacePackageDirs } from './workspaces';
import { parsePRD } from '../utils/helpers';

export interface FinalizeResult {
  success: boolean;
  committed: boolean;
  message: string;
  commitMessage?: string;
  commitSha?: string;
}

interface PackageManifest {
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

const QUALITY_GATE_SCRIPTS = ['typecheck', 'lint', 'test', 'build'] as const;
type QualityGateScript = typeof QUALITY_GATE_SCRIPTS[number] | string;

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

function tryRunGit(worktreePath: string, args: string[]): string | undefined {
  try {
    return runGit(worktreePath, args);
  } catch {
    return undefined;
  }
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

function listChangedFiles(worktreePath: string): string[] {
  const files = new Set<string>();
  const diffFiles = tryRunGit(worktreePath, ['diff', '--name-only', 'HEAD']);
  const untrackedFiles = tryRunGit(worktreePath, ['ls-files', '--others', '--exclude-standard']);

  for (const output of [diffFiles, untrackedFiles]) {
    if (!output) {
      continue;
    }

    for (const file of output.split(/\r?\n/)) {
      const trimmed = file.trim();
      if (trimmed) {
        files.add(trimmed);
      }
    }
  }

  return [...files];
}

interface QualityGateTarget {
  cwd: string;
  label: string;
  manifest: PackageManifest | null;
}

function resolveQualityGateTargets(
  task: Task,
  installRoot: string,
  manifest: PackageManifest | null,
): QualityGateTarget[] {
  const workspaceDirs = resolveWorkspacePackageDirs(installRoot, manifest);
  if (workspaceDirs.length === 0) {
    return [{ cwd: installRoot, label: path.basename(installRoot), manifest }];
  }

  const changedFiles = listChangedFiles(task.worktree);
  const targets = new Map<string, QualityGateTarget>();
  let hasRootScopedChange = false;

  for (const file of changedFiles) {
    const workspaceDir = workspaceDirs.find((candidate) => {
      const relativeWorkspacePath = path.relative(installRoot, candidate);
      return file === relativeWorkspacePath || file.startsWith(`${relativeWorkspacePath}${path.sep}`);
    });

    if (!workspaceDir) {
      hasRootScopedChange = true;
      continue;
    }

    targets.set(workspaceDir, {
      cwd: workspaceDir,
      label: path.relative(installRoot, workspaceDir),
      manifest: readPackageManifest(workspaceDir),
    });
  }

  if (hasRootScopedChange || targets.size === 0) {
    targets.set(installRoot, {
      cwd: installRoot,
      label: path.basename(installRoot),
      manifest,
    });
  }

  return [...targets.values()];
}

function resolveTaskBaseCommit(task: Task, worktreePath: string): string | undefined {
  if (typeof task.baseCommitSha === 'string' && task.baseCommitSha.trim()) {
    return task.baseCommitSha.trim();
  }

  const repoHead = tryRunGit(task.repoPath, ['rev-parse', 'HEAD']);
  if (!repoHead) {
    return undefined;
  }

  return tryRunGit(worktreePath, ['merge-base', 'HEAD', repoHead]);
}

function detectExistingTaskCommit(task: Task, worktreePath: string): { hasExistingCommit: boolean; headCommit?: string } {
  const headCommit = tryRunGit(worktreePath, ['rev-parse', 'HEAD']);
  const baseCommit = resolveTaskBaseCommit(task, worktreePath);

  if (!headCommit || !baseCommit) {
    return {
      hasExistingCommit: false,
      headCommit,
    };
  }

  return {
    hasExistingCommit: headCommit !== baseCommit,
    headCommit,
  };
}

function resolveQualityGateTimeoutMs(config: Pick<ConfigManager, 'get'>): number {
  const configuredTimeout = Number(config.get('finalizer.qualityGateTimeout'));

  if (!Number.isFinite(configuredTimeout) || configuredTimeout <= 0) {
    return 600_000;
  }

  return configuredTimeout >= 1000 ? configuredTimeout : configuredTimeout * 1000;
}

function formatTimeoutSeconds(timeoutMs: number): string {
  const timeoutSeconds = timeoutMs / 1000;
  return Number.isInteger(timeoutSeconds)
    ? String(timeoutSeconds)
    : timeoutSeconds.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function resolveConfiguredQualityGates(config: Pick<ConfigManager, 'get'>): QualityGateScript[] {
  const configuredGates = config.get('finalizer.qualityGates');

  if (Array.isArray(configuredGates)) {
    return configuredGates
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  if (typeof configuredGates === 'string') {
    const trimmed = configuredGates.trim();
    if (!trimmed || trimmed.toLowerCase() === 'none') {
      return [];
    }

    return trimmed.split(',').map((entry) => entry.trim()).filter(Boolean);
  }

  return [...QUALITY_GATE_SCRIPTS];
}

function runQualityGates(task: Task, timeoutMs: number, configuredScripts: QualityGateScript[]): string[] {
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

  const requestedScripts = configuredScripts.length > 0 ? configuredScripts : [];
  if (requestedScripts.length === 0) {
    appendFinalizeLog(task, 'Skipped quality gates (finalizer.qualityGates is empty)');
    return [];
  }

  const packageManager = detectPackageManager(task.worktree, task.repoPath) ?? 'npm';
  const targets = resolveQualityGateTargets(task, installRoot, manifest);
  const executedScripts: string[] = [];

  for (const target of targets) {
    const availableScripts = requestedScripts.filter((scriptName) => typeof target.manifest?.scripts?.[scriptName] === 'string');
    if (availableScripts.length === 0) {
      appendFinalizeLog(task, `Skipped quality gates for ${target.label} (none of ${requestedScripts.join(', ')} exist)`);
      continue;
    }

    for (const scriptName of availableScripts) {
      appendFinalizeLog(task, `Running quality gate: ${packageManager} run ${scriptName} (cwd: ${target.cwd})`);
      const result = spawnSync(packageManager, ['run', scriptName], {
        cwd: target.cwd,
        encoding: 'utf-8',
        env: process.env,
        timeout: timeoutMs,
      });

      if (result.stdout?.trim()) {
        appendFinalizeLog(task, result.stdout.trim());
      }
      if (result.stderr?.trim()) {
        appendFinalizeLog(task, result.stderr.trim());
      }

      if (result.error) {
        if ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
          throw new Error(`Quality gate "${scriptName}" timed out after ${formatTimeoutSeconds(timeoutMs)}s`);
        }
        throw new Error(`Quality gate \"${scriptName}\" failed to start: ${result.error.message}`);
      }

      if (result.status !== 0) {
        const errorMessage = result.stderr?.trim() || result.stdout?.trim() || `exit code ${result.status}`;
        throw new Error(`Quality gate \"${scriptName}\" failed: ${errorMessage}`);
      }

      executedScripts.push(`${target.label}:${scriptName}`);
    }
  }

  if (executedScripts.length === 0) {
    appendFinalizeLog(task, `Skipped quality gates (none of ${requestedScripts.join(', ')} exist in changed targets)`);
    return [];
  }

  appendFinalizeLog(task, `Quality gates passed: ${executedScripts.join(', ')}`);
  return executedScripts;
}

export function finalizeTaskOutput(task: Task): FinalizeResult {
  assertFinalizerScope(task);

  const configManager = new ConfigManager();
  const qualityGateTimeoutMs = resolveQualityGateTimeoutMs(configManager);
  const qualityGateScripts = resolveConfiguredQualityGates(configManager);
  const worktreePath = path.resolve(task.worktree);
  const existingCommitState = detectExistingTaskCommit(task, worktreePath);
  const statusBefore = runGit(worktreePath, ['status', '--porcelain']);

  if (!statusBefore && !existingCommitState.hasExistingCommit) {
    return {
      success: true,
      committed: false,
      message: 'No changes to commit',
    };
  }

  const qualityGates = runQualityGates(task, qualityGateTimeoutMs, qualityGateScripts);

  if (!statusBefore && existingCommitState.hasExistingCommit) {
    const latestCommitMessage = tryRunGit(worktreePath, ['log', '-1', '--pretty=%s']);
    const qualityGateSuffix = qualityGates.length > 0
      ? ` after quality gates (${qualityGates.join(', ')})`
      : '';

    appendFinalizeLog(
      task,
      `Detected existing task commit ${existingCommitState.headCommit ?? 'unknown'} before finalizer commit; validating without creating another commit`
    );

    return {
      success: true,
      committed: false,
      message: `Validated existing task commits${qualityGateSuffix}`,
      commitMessage: latestCommitMessage,
      commitSha: existingCommitState.headCommit,
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

  const qualityGateSuffix = qualityGates.length > 0
    ? ` after quality gates (${qualityGates.join(', ')})`
    : '';

  return {
    success: true,
    committed: true,
    message: `Committed task changes successfully${qualityGateSuffix}`,
    commitMessage,
    commitSha: tryRunGit(worktreePath, ['rev-parse', 'HEAD']),
  };
}
