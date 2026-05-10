import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager } from '../config/manager';
import { Task } from '../types/task';
import { bootstrapWorktreeDeps, detectPackageManager, findInstallRoot } from './bootstrap';
import {
  buildGitInternalExcludePathspecs,
  filterGitInternalPaths,
  isGitInternalPath,
} from './git-internal-paths';
import {
  buildOperationalArtifactExcludePathspecs,
  filterOperationalArtifactPaths,
} from './operational-artifacts';
import {
  classifyQualityGateFailure,
  QualityGateFailure,
} from './finalize-failure-classifier';
import { buildRalphToolchainEnv } from './toolchain-env';
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
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const QUALITY_GATE_SCRIPTS = ['typecheck', 'lint', 'test', 'build'] as const;
type QualityGateScript = typeof QUALITY_GATE_SCRIPTS[number] | string;
const LINT_SCRIPT_PREFERENCES = ['lint:check', 'lint:ci', 'lint:ralph', 'lint'] as const;
const PRISMA_GENERATE_SCRIPT_PREFERENCES = ['db:generate:safe', 'db:generate'] as const;

interface ResolvedScriptExecution {
  requestedScript: QualityGateScript;
  actualScript: string;
}

interface ResolvedPreparationExecution {
  label: string;
  cwd: string;
  actualScript: string;
  reason: string;
}

interface ParsedLintDiagnostic {
  file: string;
  line: number;
  severity: 'error' | 'warning';
  message: string;
}

interface QualityGateSandbox {
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

interface ManagedSpawnResult {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  timedOut: boolean;
}

function sanitizeTempName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 80) || 'task';
}

function createQualityGateSandbox(task: Task, installRoot?: string): QualityGateSandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ralph-quality-gate-${sanitizeTempName(task.id)}-`));
  const home = path.join(root, 'home');
  const ralphHome = path.join(root, 'ralph-home');

  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(ralphHome, { recursive: true });

  const { env, fingerprint } = buildRalphToolchainEnv({
    baseEnv: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      RALPH_HOME: ralphHome,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      RALPH_QUALITY_GATE_HOME: ralphHome,
    },
    installRoot,
    ralphHome: process.env.RALPH_HOME,
    sandboxHome: home,
  });
  appendFinalizeLog(task, `Quality gate toolchain env: ${JSON.stringify(fingerprint)}`);

  return {
    env,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function closeFd(fd: number | undefined): void {
  if (fd === undefined) {
    return;
  }

  try {
    fs.closeSync(fd);
  } catch {
    // Best-effort cleanup; keep the original quality gate result authoritative.
  }
}

function readFileIfExists(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
}

function killProcessTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    }

    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      // Process-tree cleanup is best effort and should not mask gate failure.
    }
  }
}

function runManagedQualityGateCommand(
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  }
): ManagedSpawnResult {
  const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-quality-gate-output-'));
  const stdoutPath = path.join(captureDir, 'stdout.log');
  const stderrPath = path.join(captureDir, 'stderr.log');
  let stdoutFd: number | undefined;
  let stderrFd: number | undefined;

  try {
    stdoutFd = fs.openSync(stdoutPath, 'w');
    stderrFd = fs.openSync(stderrPath, 'w');
    const spawnOptions = {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      killSignal: 'SIGKILL',
      detached: process.platform !== 'win32',
      stdio: ['ignore', stdoutFd, stderrFd],
    } as Parameters<typeof spawnSync>[2] & { detached?: boolean };
    const result = spawnSync(file, args, spawnOptions);
    closeFd(stdoutFd);
    closeFd(stderrFd);
    stdoutFd = undefined;
    stderrFd = undefined;

    const error = result.error as NodeJS.ErrnoException | undefined;
    const timedOut = error?.code === 'ETIMEDOUT';
    if (timedOut && typeof result.pid === 'number') {
      killProcessTree(result.pid);
    }

    return {
      stdout: readFileIfExists(stdoutPath),
      stderr: readFileIfExists(stderrPath),
      status: result.status,
      signal: result.signal,
      error: result.error,
      timedOut,
    };
  } finally {
    closeFd(stdoutFd);
    closeFd(stderrFd);
    fs.rmSync(captureDir, { recursive: true, force: true });
  }
}

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

function runGitWithEnv(worktreePath: string, args: string[], env: NodeJS.ProcessEnv, input?: string): string {
  return execFileSync('git', args, {
    cwd: worktreePath,
    encoding: 'utf-8',
    env,
    input,
    stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function tryRunGit(worktreePath: string, args: string[]): string | undefined {
  try {
    return runGit(worktreePath, args);
  } catch {
    return undefined;
  }
}

function tryRunGitWithEnv(worktreePath: string, args: string[], env: NodeJS.ProcessEnv): string | undefined {
  try {
    return runGitWithEnv(worktreePath, args, env);
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

function filterFinalizerOperationalPaths(paths: string[]): string[] {
  return filterOperationalArtifactPaths(filterGitInternalPaths(paths));
}

function buildFinalizerExcludePathspecs(): string[] {
  return [
    ...buildGitInternalExcludePathspecs(),
    ...buildOperationalArtifactExcludePathspecs(),
  ];
}

function resolveLocalMergeGitEnv(worktreePath: string): NodeJS.ProcessEnv | undefined {
  const localGitDir = path.join(worktreePath, '.git-local');
  if (!fs.existsSync(localGitDir)) {
    return undefined;
  }

  const stat = fs.statSync(localGitDir);
  if (!stat.isDirectory()) {
    return undefined;
  }

  const mergeHeadPath = path.join(localGitDir, 'MERGE_HEAD');
  if (!fs.existsSync(mergeHeadPath)) {
    return undefined;
  }

  const env = {
    ...process.env,
    GIT_DIR: localGitDir,
    GIT_WORK_TREE: worktreePath,
  };

  if (!tryRunGitWithEnv(worktreePath, ['rev-parse', '--git-dir'], env)) {
    return undefined;
  }

  return env;
}

function listUnmergedFiles(worktreePath: string, env: NodeJS.ProcessEnv): string[] {
  const output = tryRunGitWithEnv(worktreePath, ['diff', '--name-only', '--diff-filter=U', '-z'], env);
  return filterFinalizerOperationalPaths((output || '').split('\0').filter(Boolean));
}

function listChangedFilesWithEnv(worktreePath: string, env: NodeJS.ProcessEnv): string[] {
  const diffFiles = tryRunGitWithEnv(worktreePath, ['diff', '--name-only', '-z', 'HEAD', '--'], env);
  const stagedFiles = tryRunGitWithEnv(worktreePath, ['diff', '--cached', '--name-only', '-z', '--'], env);
  const untrackedFiles = tryRunGitWithEnv(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z'], env);
  return [...new Set(filterFinalizerOperationalPaths([
    ...(diffFiles || '').split('\0').filter(Boolean),
    ...(stagedFiles || '').split('\0').filter(Boolean),
    ...(untrackedFiles || '').split('\0').filter(Boolean),
  ]))];
}

function hasResolvedLocalMerge(worktreePath: string, env: NodeJS.ProcessEnv): boolean {
  return listUnmergedFiles(worktreePath, env).length === 0;
}

function listChangedFiles(worktreePath: string, baseCommitSha?: string): string[] {
  const diffFiles = tryRunGit(
    worktreePath,
    baseCommitSha?.trim()
      ? ['diff', '--name-only', '-z', baseCommitSha.trim(), '--']
      : ['diff', '--name-only', '-z', 'HEAD', '--']
  );
  const untrackedFiles = tryRunGit(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z']);
  const changedPaths = [
    ...(diffFiles || '').split('\0').filter(Boolean),
    ...(untrackedFiles || '').split('\0').filter(Boolean),
  ];

  return filterFinalizerOperationalPaths(changedPaths);
}

function listDiffFilesRaw(worktreePath: string, fromRef: string, toRef: string): string[] {
  const output = tryRunGit(worktreePath, ['diff', '--name-only', '-z', fromRef, toRef, '--']);
  return (output || '').split('\0').filter(Boolean);
}

function assertExistingCommitIsSafe(task: Task, worktreePath: string): void {
  if (!task.baseCommitSha?.trim()) {
    return;
  }

  const committedPaths = listDiffFilesRaw(worktreePath, task.baseCommitSha.trim(), 'HEAD');
  const forbiddenPaths = committedPaths.filter((file) => isGitInternalPath(file));
  if (forbiddenPaths.length > 0) {
    throw new Error(`Existing task commit contains git-internal artifacts: ${forbiddenPaths.join(', ')}`);
  }
}

function listStagedFiles(worktreePath: string): string[] {
  const stagedOutput = tryRunGit(worktreePath, ['diff', '--cached', '--name-only', '-z', '--']);
  return filterFinalizerOperationalPaths((stagedOutput || '').split('\0').filter(Boolean));
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

  const changedFiles = listChangedFiles(task.worktree, task.baseCommitSha);
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

function normalizeChangedFileSet(files: string[]): Set<string> {
  return new Set(files.map((file) => file.replace(/\\/g, '/')));
}

type ChangedLineSet = Set<number> | 'all';

function buildChangedLineMap(worktreePath: string, baseCommitSha?: string): Map<string, ChangedLineSet> {
  const changedLines = new Map<string, ChangedLineSet>();
  const diffOutput = tryRunGit(
    worktreePath,
    baseCommitSha?.trim()
      ? ['diff', '--unified=0', '--no-color', baseCommitSha.trim(), '--']
      : ['diff', '--unified=0', '--no-color', 'HEAD', '--']
  );
  const untrackedFiles = tryRunGit(worktreePath, ['ls-files', '--others', '--exclude-standard']);

  if (diffOutput) {
    let currentFile: string | undefined;

    for (const rawLine of diffOutput.split(/\r?\n/)) {
      if (rawLine.startsWith('+++ ')) {
        const match = rawLine.match(/^\+\+\+ b\/(.+)$/);
        currentFile = match ? match[1].replace(/\\/g, '/') : undefined;
        continue;
      }

      if (!currentFile || !rawLine.startsWith('@@ ')) {
        continue;
      }

      const match = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (!match) {
        continue;
      }

      const startLine = Number(match[1]);
      const lineCount = match[2] ? Number(match[2]) : 1;
      if (!Number.isFinite(startLine) || !Number.isFinite(lineCount) || lineCount <= 0) {
        continue;
      }

      const existing = changedLines.get(currentFile);
      if (existing === 'all') {
        continue;
      }

      const lineSet = existing ?? new Set<number>();
      for (let line = startLine; line < startLine + lineCount; line += 1) {
        lineSet.add(line);
      }
      changedLines.set(currentFile, lineSet);
    }
  }

  if (untrackedFiles) {
    for (const file of untrackedFiles.split(/\r?\n/)) {
      const trimmed = file.trim();
      if (trimmed) {
        changedLines.set(trimmed.replace(/\\/g, '/'), 'all');
      }
    }
  }

  return changedLines;
}

function resolveScriptExecutions(
  target: QualityGateTarget,
  requestedScripts: QualityGateScript[],
): ResolvedScriptExecution[] {
  const resolved: ResolvedScriptExecution[] = [];
  const seen = new Set<string>();

  for (const requestedScript of requestedScripts) {
    if (requestedScript === 'lint') {
      for (const scriptName of LINT_SCRIPT_PREFERENCES) {
        if (typeof target.manifest?.scripts?.[scriptName] !== 'string') {
          continue;
        }

        if (!seen.has(scriptName)) {
          resolved.push({ requestedScript, actualScript: scriptName });
          seen.add(scriptName);
        }
        break;
      }
      continue;
    }

    if (typeof target.manifest?.scripts?.[requestedScript] !== 'string') {
      continue;
    }

    const normalized = String(requestedScript);
    if (!seen.has(normalized)) {
      resolved.push({ requestedScript, actualScript: normalized });
      seen.add(normalized);
    }
  }

  return resolved;
}

function resolvePreferredScript(
  manifest: PackageManifest | null,
  scriptNames: readonly string[],
): string | undefined {
  for (const scriptName of scriptNames) {
    if (typeof manifest?.scripts?.[scriptName] === 'string') {
      return scriptName;
    }
  }

  return undefined;
}

function resolvePrismaPreparationExecutions(
  installRoot: string,
  manifest: PackageManifest | null,
  changedFiles: string[],
  requestedScripts: QualityGateScript[],
  targets: QualityGateTarget[],
): ResolvedPreparationExecution[] {
  const normalizedChangedFiles = normalizeChangedFileSet(changedFiles);
  const candidateDirs = [
    installRoot,
    ...resolveWorkspacePackageDirs(installRoot, manifest),
  ];
  const resolved = new Map<string, ResolvedPreparationExecution>();
  const willRunTypecheck = targets.some((target) => (
    resolveScriptExecutions(target, requestedScripts)
      .some((script) => script.requestedScript === 'typecheck' || script.actualScript === 'typecheck')
  ));

  for (const candidateDir of candidateDirs) {
    const relativeDir = path.relative(installRoot, candidateDir).replace(/\\/g, '/');
    if (relativeDir.startsWith('..')) {
      continue;
    }

    const prefix = relativeDir ? `${relativeDir}/` : '';
    const schemaPath = `${prefix}prisma/schema.prisma`;
    const migrationPrefix = `${prefix}prisma/migrations/`;
    const hasPrismaSchema = fs.existsSync(path.join(candidateDir, 'prisma', 'schema.prisma'));
    const changedPrismaArtifact = [...normalizedChangedFiles].some((file) => (
      file === schemaPath || file.startsWith(migrationPrefix)
    ));
    const needsGenerate = changedPrismaArtifact || (willRunTypecheck && hasPrismaSchema);

    if (!needsGenerate) {
      continue;
    }

    const candidateManifest = candidateDir === installRoot
      ? manifest
      : readPackageManifest(candidateDir);
    const actualScript = resolvePreferredScript(
      candidateManifest,
      PRISMA_GENERATE_SCRIPT_PREFERENCES,
    );

    if (!actualScript) {
      continue;
    }

    const label = relativeDir || path.basename(installRoot);
    const key = `${candidateDir}:${actualScript}`;
    if (!resolved.has(key)) {
      resolved.set(key, {
        label,
        cwd: candidateDir,
        actualScript,
        reason: changedPrismaArtifact
          ? 'Prisma schema or migration changed'
          : 'Root typecheck may consume generated Prisma client types',
      });
    }
  }

  return [...resolved.values()];
}

function manifestHasDependency(manifest: PackageManifest | null, packageName: string): boolean {
  const dependencyGroups = [
    manifest?.dependencies,
    manifest?.devDependencies,
    manifest?.optionalDependencies,
    manifest?.peerDependencies,
  ];

  return dependencyGroups.some((dependencies) => (
    dependencies
    && typeof dependencies === 'object'
    && typeof dependencies[packageName] === 'string'
  ));
}

function resolveWorkspaceBuildPreparationExecutions(
  installRoot: string,
  manifest: PackageManifest | null,
  changedFiles: string[],
): ResolvedPreparationExecution[] {
  const workspaceDirs = resolveWorkspacePackageDirs(installRoot, manifest);
  if (workspaceDirs.length === 0) {
    return [];
  }

  const normalizedChangedFiles = normalizeChangedFileSet(changedFiles);
  const resolved = new Map<string, ResolvedPreparationExecution>();

  for (const workspaceDir of workspaceDirs) {
    const relativeDir = path.relative(installRoot, workspaceDir).replace(/\\/g, '/');
    if (!relativeDir || relativeDir.startsWith('..')) {
      continue;
    }

    const changedInWorkspace = [...normalizedChangedFiles].some((file) => (
      file === relativeDir || file.startsWith(`${relativeDir}/`)
    ));
    if (!changedInWorkspace) {
      continue;
    }

    const workspaceManifest = readPackageManifest(workspaceDir);
    if (typeof workspaceManifest?.scripts?.build !== 'string') {
      continue;
    }

    // App builds are already first-class quality gates. Library package builds
    // prepare ignored dist artifacts needed by downstream workspace tests.
    if (manifestHasDependency(workspaceManifest, 'next')) {
      continue;
    }

    const key = `${workspaceDir}:build`;
    if (!resolved.has(key)) {
      resolved.set(key, {
        label: relativeDir,
        cwd: workspaceDir,
        actualScript: 'build',
        reason: 'Changed workspace package may be consumed by downstream quality gates',
      });
    }
  }

  return [...resolved.values()];
}

function parseStylishLintDiagnostics(output: string, worktreePath: string): ParsedLintDiagnostic[] {
  const diagnostics: ParsedLintDiagnostic[] = [];
  let currentFile: string | undefined;
  const lines = output.split(/\r?\n/);
  const normalizedWorktreePath = resolveExistingPath(worktreePath);

  for (const rawLine of lines) {
    const line = rawLine.replace(/\u001b\[[0-9;]*m/g, '');
    const trimmed = line.trim();
    const strippedTrimmed = trimmed.replace(/^(?:[A-Za-z][A-Za-z0-9_.-]*:)+\s*/, '');

    if (!trimmed) {
      continue;
    }

    const match = strippedTrimmed.match(/^(\d+):\d+\s+(error|warning)\s+(.+?)(?:\s{2,}([@\w./-]+))?$/);
    if (match && currentFile) {
      diagnostics.push({
        file: currentFile,
        line: Number(match[1]),
        severity: match[2] === 'error' ? 'error' : 'warning',
        message: match[3].trim(),
      });
      continue;
    }

    if (strippedTrimmed.startsWith('/')) {
      currentFile = path.relative(normalizedWorktreePath, resolveExistingPath(strippedTrimmed)).replace(/\\/g, '/');
    } else if (strippedTrimmed.startsWith('.')) {
      currentFile = strippedTrimmed.replace(/\\/g, '/').replace(/^\.\//, '');
    } else if (/^[A-Za-z]:[\\/]/.test(strippedTrimmed)) {
      currentFile = path.relative(normalizedWorktreePath, resolveExistingPath(strippedTrimmed)).replace(/\\/g, '/');
    } else if (!line.startsWith(' ')) {
      currentFile = undefined;
    }
  }

  return diagnostics;
}

function isChangedDiagnosticLocation(
  diagnostic: ParsedLintDiagnostic,
  changedFileSet: Set<string>,
  changedLineMap: Map<string, ChangedLineSet>,
): boolean {
  const marker = changedLineMap.get(diagnostic.file);
  if (!marker) {
    return false;
  }

  if (marker === 'all') {
    return true;
  }

  if (Number.isFinite(diagnostic.line)) {
    return marker.has(diagnostic.line);
  }

  return changedFileSet.has(diagnostic.file);
}

function shouldTreatLintFailureAsLegacyDebt(
  task: Task,
  target: QualityGateTarget,
  output: string,
  changedFileSet: Set<string>,
  changedLineMap: Map<string, ChangedLineSet>,
): {
  suppressFailure: boolean;
  summary?: string;
} {
  const normalizedWorktreePath = resolveExistingPath(task.worktree);
  const normalizedTargetCwd = resolveExistingPath(target.cwd);
  const diagnostics = parseStylishLintDiagnostics(output, task.worktree)
    .filter((diagnostic) => {
      const normalizedTarget = path.relative(normalizedWorktreePath, normalizedTargetCwd).replace(/\\/g, '/');
      if (!normalizedTarget || normalizedTarget === '') {
        return true;
      }
      return diagnostic.file === normalizedTarget || diagnostic.file.startsWith(`${normalizedTarget}/`);
    });

  if (diagnostics.length === 0) {
    return { suppressFailure: false };
  }

  const errorDiagnostics = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  const warningDiagnostics = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning');
  const changedErrorDiagnostics = errorDiagnostics.filter((diagnostic) =>
    isChangedDiagnosticLocation(diagnostic, changedFileSet, changedLineMap),
  );
  const changedWarningDiagnostics = warningDiagnostics.filter((diagnostic) =>
    isChangedDiagnosticLocation(diagnostic, changedFileSet, changedLineMap),
  );

  if (changedErrorDiagnostics.length > 0) {
    return { suppressFailure: false };
  }

  if (errorDiagnostics.length === 0 && warningDiagnostics.length === 0) {
    return { suppressFailure: false };
  }

  const summary = [
    `Suppressed package lint failure for ${target.label} as legacy debt outside changed files`,
    `errors=${errorDiagnostics.length}`,
    `warnings=${warningDiagnostics.length}`,
    `changedErrors=${changedErrorDiagnostics.length}`,
    `changedWarnings=${changedWarningDiagnostics.length}`,
  ].join(' ');

  return {
    suppressFailure: true,
    summary,
  };
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatQualityGateValidationCommand(
  worktreePath: string,
  cwd: string,
  packageManager: string,
  script: string,
): string {
  const relativeCwd = path.relative(worktreePath, cwd).replace(/\\/g, '/');
  const command = `${packageManager} run ${script}`;
  if (!relativeCwd || relativeCwd === '.') {
    return command;
  }

  return `cd ${shellQuote(relativeCwd)} && ${command}`;
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

  const changedFiles = listChangedFiles(task.worktree, task.baseCommitSha);
  const packageManager = detectPackageManager(task.worktree, task.repoPath) ?? 'npm';
  const targets = resolveQualityGateTargets(task, installRoot, manifest);
  const executedScripts: string[] = [];
  const changedFileSet = normalizeChangedFileSet(changedFiles);
  const changedLineMap = buildChangedLineMap(task.worktree, task.baseCommitSha);
  const preparations = [
    ...resolvePrismaPreparationExecutions(
      installRoot,
      manifest,
      changedFiles,
      requestedScripts,
      targets,
    ),
    ...resolveWorkspaceBuildPreparationExecutions(
      installRoot,
      manifest,
      changedFiles,
    ),
  ];
  const sandbox = createQualityGateSandbox(task, installRoot);
  const completedPreparationCommands: string[] = [];

  try {
    for (const preparation of preparations) {
      const preparationCommand = formatQualityGateValidationCommand(
        task.worktree,
        preparation.cwd,
        packageManager,
        preparation.actualScript,
      );
      appendFinalizeLog(
        task,
        `Running quality gate preparation: ${packageManager} run ${preparation.actualScript} (reason: ${preparation.reason}, cwd: ${preparation.cwd})`
      );
      const command = `${packageManager} run ${preparation.actualScript}`;
      const result = runManagedQualityGateCommand(packageManager, ['run', preparation.actualScript], {
        cwd: preparation.cwd,
        env: sandbox.env,
        timeoutMs,
      });

      if (result.stdout?.trim()) {
        appendFinalizeLog(task, result.stdout.trim());
      }
      if (result.stderr?.trim()) {
        appendFinalizeLog(task, result.stderr.trim());
      }

      if (result.timedOut) {
        throw new QualityGateFailure(classifyQualityGateFailure({
          requestedScript: 'typecheck',
          actualScript: preparation.actualScript,
          cwd: preparation.cwd,
          packageLabel: preparation.label,
          command,
          validationCommands: [...completedPreparationCommands, preparationCommand],
          rawMessage: `Quality gate preparation "${preparation.actualScript}" timed out after ${formatTimeoutSeconds(timeoutMs)}s`,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status,
          timedOut: true,
          taskId: task.id,
          taskWorktree: task.worktree,
          repoPath: task.repoPath,
        }));
      }

      if (result.error) {
        throw new QualityGateFailure(classifyQualityGateFailure({
          requestedScript: 'typecheck',
          actualScript: preparation.actualScript,
          cwd: preparation.cwd,
          packageLabel: preparation.label,
          command,
          validationCommands: [...completedPreparationCommands, preparationCommand],
          rawMessage: `Quality gate preparation "${preparation.actualScript}" failed to start: ${result.error.message}`,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status,
          startFailed: true,
          taskId: task.id,
          taskWorktree: task.worktree,
          repoPath: task.repoPath,
        }));
      }

      if (result.status !== 0) {
        const errorMessage = result.stderr?.trim() || result.stdout?.trim() || `exit code ${result.status}`;
        throw new QualityGateFailure(classifyQualityGateFailure({
          requestedScript: 'typecheck',
          actualScript: preparation.actualScript,
          cwd: preparation.cwd,
          packageLabel: preparation.label,
          command,
          validationCommands: [...completedPreparationCommands, preparationCommand],
          rawMessage: `Quality gate preparation "${preparation.actualScript}" failed: ${errorMessage}`,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status,
          taskId: task.id,
          taskWorktree: task.worktree,
          repoPath: task.repoPath,
        }));
      }

      completedPreparationCommands.push(preparationCommand);
      executedScripts.push(`${preparation.label}:${preparation.actualScript}[prepare]`);
    }

    for (const target of targets) {
      const availableScripts = resolveScriptExecutions(target, requestedScripts);
      if (availableScripts.length === 0) {
        appendFinalizeLog(task, `Skipped quality gates for ${target.label} (none of ${requestedScripts.join(', ')} exist)`);
        continue;
      }

      for (const scriptExecution of availableScripts) {
        const validationCommand = formatQualityGateValidationCommand(
          task.worktree,
          target.cwd,
          packageManager,
          scriptExecution.actualScript,
        );
        appendFinalizeLog(
          task,
          `Running quality gate: ${packageManager} run ${scriptExecution.actualScript} (requested: ${scriptExecution.requestedScript}, cwd: ${target.cwd})`
        );
        const command = `${packageManager} run ${scriptExecution.actualScript}`;
        const result = runManagedQualityGateCommand(packageManager, ['run', scriptExecution.actualScript], {
          cwd: target.cwd,
          env: sandbox.env,
          timeoutMs,
        });

        if (result.stdout?.trim()) {
          appendFinalizeLog(task, result.stdout.trim());
        }
        if (result.stderr?.trim()) {
          appendFinalizeLog(task, result.stderr.trim());
        }

        if (result.timedOut) {
          throw new QualityGateFailure(classifyQualityGateFailure({
            requestedScript: scriptExecution.requestedScript,
            actualScript: scriptExecution.actualScript,
            cwd: target.cwd,
            packageLabel: target.label,
            command,
            preparationCommands: completedPreparationCommands,
            validationCommands: [...completedPreparationCommands, validationCommand],
            rawMessage: `Quality gate "${scriptExecution.actualScript}" timed out after ${formatTimeoutSeconds(timeoutMs)}s`,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.status,
            timedOut: true,
            taskId: task.id,
            taskWorktree: task.worktree,
            repoPath: task.repoPath,
          }));
        }

        if (result.error) {
          throw new QualityGateFailure(classifyQualityGateFailure({
            requestedScript: scriptExecution.requestedScript,
            actualScript: scriptExecution.actualScript,
            cwd: target.cwd,
            packageLabel: target.label,
            command,
            preparationCommands: completedPreparationCommands,
            validationCommands: [...completedPreparationCommands, validationCommand],
            rawMessage: `Quality gate "${scriptExecution.actualScript}" failed to start: ${result.error.message}`,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.status,
            startFailed: true,
            taskId: task.id,
            taskWorktree: task.worktree,
            repoPath: task.repoPath,
          }));
        }

        if (result.status !== 0) {
          const combinedOutput = [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join('\n');
          const errorMessage = result.stderr?.trim() || result.stdout?.trim() || `exit code ${result.status}`;
          if (scriptExecution.requestedScript === 'lint') {
            const lintFailure = shouldTreatLintFailureAsLegacyDebt(
              task,
              target,
              combinedOutput || errorMessage,
              changedFileSet,
              changedLineMap,
            );
            if (lintFailure.suppressFailure) {
              if (lintFailure.summary) {
                appendFinalizeLog(task, lintFailure.summary);
              }
              executedScripts.push(`${target.label}:${scriptExecution.actualScript}[legacy-debt]`);
              continue;
            }
          }
          throw new QualityGateFailure(classifyQualityGateFailure({
            requestedScript: scriptExecution.requestedScript,
            actualScript: scriptExecution.actualScript,
            cwd: target.cwd,
            packageLabel: target.label,
            command,
            preparationCommands: completedPreparationCommands,
            validationCommands: [...completedPreparationCommands, validationCommand],
            rawMessage: `Quality gate "${scriptExecution.actualScript}" failed: ${errorMessage}`,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.status,
            taskId: task.id,
            taskWorktree: task.worktree,
            repoPath: task.repoPath,
          }));
        }

        executedScripts.push(`${target.label}:${scriptExecution.actualScript}`);
      }
    }

    if (executedScripts.length === 0) {
      appendFinalizeLog(task, `Skipped quality gates (none of ${requestedScripts.join(', ')} exist in changed targets)`);
      return [];
    }

    appendFinalizeLog(task, `Quality gates passed: ${executedScripts.join(', ')}`);
    return executedScripts;
  } finally {
    sandbox.cleanup();
  }
}

export function finalizeTaskOutput(task: Task): FinalizeResult {
  assertFinalizerScope(task);

  const bootstrapResult = bootstrapWorktreeDeps(task.worktree, {
    repoPath: task.repoPath,
    logPath: task.logPath,
    installIfNeeded: false,
  });
  if (bootstrapResult.installReason === 'next_turbopack_requires_local_install') {
    appendFinalizeLog(
      task,
      'Retrying dependency bootstrap with local install because Next/Turbopack cannot use repo-external node_modules symlinks',
    );
    bootstrapWorktreeDeps(task.worktree, {
      repoPath: task.repoPath,
      logPath: task.logPath,
    });
  }

  const configManager = new ConfigManager();
  const qualityGateTimeoutMs = resolveQualityGateTimeoutMs(configManager);
  const qualityGateScripts = resolveConfiguredQualityGates(configManager);
  const worktreePath = path.resolve(task.worktree);
  const localMergeEnv = resolveLocalMergeGitEnv(worktreePath);
  const existingCommitState = detectExistingTaskCommit(task, worktreePath);
  const changedFilesBeforeFinalize = listChangedFiles(worktreePath);

  if (changedFilesBeforeFinalize.length === 0 && !existingCommitState.hasExistingCommit && !localMergeEnv) {
    return {
      success: true,
      committed: false,
      message: 'No changes to commit',
    };
  }

  const qualityGates = runQualityGates(task, qualityGateTimeoutMs, qualityGateScripts);

  if (localMergeEnv) {
    const unmergedFiles = listUnmergedFiles(worktreePath, localMergeEnv);
    if (unmergedFiles.length > 0) {
      throw new Error(`Cannot finalize unresolved local merge: ${unmergedFiles.join(', ')}`);
    }

    if (hasResolvedLocalMerge(worktreePath, localMergeEnv)) {
      const localChangedFiles = listChangedFilesWithEnv(worktreePath, localMergeEnv);
      if (localChangedFiles.length > 0) {
        runGitWithEnv(
          worktreePath,
          ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'],
          localMergeEnv,
          localChangedFiles.join('\0'),
        );
      }

      const commitMessage = buildCommitMessage(task);
      runGitWithEnv(worktreePath, ['commit', '--no-verify', '--allow-empty', '-m', commitMessage], localMergeEnv);

      const qualityGateSuffix = qualityGates.length > 0
        ? ` after quality gates (${qualityGates.join(', ')})`
        : '';
      const commitSha = tryRunGitWithEnv(worktreePath, ['rev-parse', 'HEAD'], localMergeEnv);

      appendFinalizeLog(
        task,
        `Committed resolved local merge ${commitSha ?? 'unknown'} with finalizer commit`
      );

      return {
        success: true,
        committed: true,
        message: `Committed resolved local merge successfully${qualityGateSuffix}`,
        commitMessage,
        commitSha,
      };
    }
  }

  if (changedFilesBeforeFinalize.length === 0 && existingCommitState.hasExistingCommit) {
    assertExistingCommitIsSafe(task, worktreePath);
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

  runGit(worktreePath, ['add', '-A', '--', '.', ...buildFinalizerExcludePathspecs()]);

  const stagedFiles = listStagedFiles(worktreePath);
  if (stagedFiles.length === 0) {
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
