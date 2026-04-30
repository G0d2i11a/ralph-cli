import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager } from '../config/manager';
import {
  FinalizerFailureDetails,
  Task,
  TaskValidationEvidenceManifest,
  ValidationEvidencePhase,
  ValidationEvidenceRun,
  ValidationEvidenceStatus,
} from '../types/task';
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
  QualityGateFailureInput,
  summarizeValidationOutput,
} from './finalize-failure-classifier';
import { resolveWorkspacePackageDirs } from './workspaces';
import { parsePRD } from '../utils/helpers';

export interface FinalizeResult {
  success: boolean;
  committed: boolean;
  message: string;
  commitMessage?: string;
  commitSha?: string;
  validationEvidence: TaskValidationEvidenceManifest;
}

interface PackageManifest {
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
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

interface QualityGateRunResult {
  executedScripts: string[];
  validationEvidence: TaskValidationEvidenceManifest;
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

function createQualityGateSandbox(task: Task): QualityGateSandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ralph-quality-gate-${sanitizeTempName(task.id)}-`));
  const home = path.join(root, 'home');
  const ralphHome = path.join(root, 'ralph-home');

  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(ralphHome, { recursive: true });

  return {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      RALPH_HOME: ralphHome,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      RALPH_QUALITY_GATE_HOME: ralphHome,
    },
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

function buildValidationEvidenceManifest(
  task: Pick<Task, 'id'>,
  configuredGates: string[],
  runs: ValidationEvidenceRun[],
): TaskValidationEvidenceManifest {
  const classifications: Record<string, number> = {};

  for (const run of runs) {
    classifications[run.classification] = (classifications[run.classification] ?? 0) + 1;
  }

  return {
    schemaVersion: 1,
    source: 'finalizer',
    taskId: task.id,
    generatedAt: Date.now(),
    configuredGates: [...configuredGates],
    summary: {
      total: runs.length,
      passed: runs.filter((run) => run.status === 'passed').length,
      failed: runs.filter((run) => run.status === 'failed').length,
      skipped: runs.filter((run) => run.status === 'skipped').length,
      classifications,
    },
    runs: runs.map((run) => ({ ...run })),
  };
}

function createSkippedValidationRun(input: {
  phase: ValidationEvidencePhase;
  requestedGate: string;
  gate?: string;
  packageLabel?: string;
  cwd?: string;
  reason: string;
}): ValidationEvidenceRun {
  return {
    phase: input.phase,
    requestedGate: input.requestedGate,
    gate: input.gate ?? input.requestedGate,
    status: 'skipped',
    classification: 'skipped',
    packageLabel: input.packageLabel,
    cwd: input.cwd,
    reason: input.reason,
  };
}

function createSkippedGateRuns(
  requestedScripts: QualityGateScript[],
  cwd: string,
  packageLabel: string,
  reason: string,
): ValidationEvidenceRun[] {
  const gates = requestedScripts.length > 0 ? requestedScripts : ['quality_gates'];

  return gates.map((requestedGate) => createSkippedValidationRun({
    phase: 'quality_gate',
    requestedGate,
    packageLabel,
    cwd,
    reason,
  }));
}

function createCompletedValidationRun(input: {
  phase: ValidationEvidencePhase;
  requestedGate: string;
  gate: string;
  packageLabel: string;
  cwd: string;
  command: string;
  status?: Extract<ValidationEvidenceStatus, 'passed'>;
  classification?: 'passed' | 'legacy_debt';
  reason?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  durationMs: number;
  startedAt: number;
  completedAt: number;
}): ValidationEvidenceRun {
  return {
    phase: input.phase,
    requestedGate: input.requestedGate,
    gate: input.gate,
    status: input.status ?? 'passed',
    classification: input.classification ?? 'passed',
    packageLabel: input.packageLabel,
    cwd: input.cwd,
    command: input.command,
    exitCode: typeof input.exitCode === 'number' ? input.exitCode : undefined,
    durationMs: input.durationMs,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    reason: input.reason,
    stdoutSummary: summarizeValidationOutput(input.stdout),
    stderrSummary: summarizeValidationOutput(input.stderr),
  };
}

function createFailedValidationRun(
  details: FinalizerFailureDetails,
  phase: ValidationEvidencePhase,
): ValidationEvidenceRun {
  return {
    phase,
    requestedGate: details.requestedGate,
    gate: details.gate,
    status: 'failed',
    classification: details.class,
    packageLabel: details.packageLabel,
    cwd: details.cwd,
    command: details.command,
    exitCode: details.exitCode,
    durationMs: details.durationMs,
    startedAt: details.startedAt,
    completedAt: details.completedAt,
    timedOut: details.timedOut,
    startFailed: details.startFailed,
    reason: details.rawMessage,
    stdoutSummary: details.stdoutSummary,
    stderrSummary: details.stderrSummary,
    diagnosticCount: details.diagnosticCount,
    diagnosticSignature: details.diagnosticSignature,
    failedFiles: details.failedFiles,
    failedCodes: details.failedCodes,
    failedSymbols: details.failedSymbols,
    diagnostics: details.diagnostics,
  };
}

function createQualityGateFailure(
  task: Task,
  configuredScripts: QualityGateScript[],
  evidenceRuns: ValidationEvidenceRun[],
  phase: ValidationEvidencePhase,
  input: QualityGateFailureInput,
): QualityGateFailure {
  const details = classifyQualityGateFailure(input);
  const failedRun = createFailedValidationRun(details, phase);
  const nextRuns = [...evidenceRuns, failedRun];
  return new QualityGateFailure(
    details,
    buildValidationEvidenceManifest(task, configuredScripts, nextRuns),
  );
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
): ResolvedPreparationExecution[] {
  const normalizedChangedFiles = normalizeChangedFileSet(changedFiles);
  const candidateDirs = [
    installRoot,
    ...resolveWorkspacePackageDirs(installRoot, manifest),
  ];
  const resolved = new Map<string, ResolvedPreparationExecution>();

  for (const candidateDir of candidateDirs) {
    const relativeDir = path.relative(installRoot, candidateDir).replace(/\\/g, '/');
    if (relativeDir.startsWith('..')) {
      continue;
    }

    const prefix = relativeDir ? `${relativeDir}/` : '';
    const schemaPath = `${prefix}prisma/schema.prisma`;
    const migrationPrefix = `${prefix}prisma/migrations/`;
    const needsGenerate = [...normalizedChangedFiles].some((file) => (
      file === schemaPath || file.startsWith(migrationPrefix)
    ));

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
        reason: 'Prisma schema or migration changed',
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

function runQualityGates(task: Task, timeoutMs: number, configuredScripts: QualityGateScript[]): QualityGateRunResult {
  const evidenceRuns: ValidationEvidenceRun[] = [];
  const requestedScripts = configuredScripts.length > 0 ? configuredScripts : [];
  if (requestedScripts.length === 0) {
    const reason = 'finalizer.qualityGates is empty';
    appendFinalizeLog(task, `Skipped quality gates (${reason})`);
    evidenceRuns.push(createSkippedValidationRun({
      phase: 'quality_gate',
      requestedGate: 'quality_gates',
      gate: 'quality_gates',
      cwd: task.worktree,
      packageLabel: path.basename(task.worktree),
      reason,
    }));
    return {
      executedScripts: [],
      validationEvidence: buildValidationEvidenceManifest(task, configuredScripts, evidenceRuns),
    };
  }

  const installRoot = findInstallRoot(task.worktree, task.repoPath);
  if (!installRoot) {
    const reason = 'no package.json detected';
    appendFinalizeLog(task, `Skipped quality gates (${reason})`);
    evidenceRuns.push(...createSkippedGateRuns(
      requestedScripts,
      task.worktree,
      path.basename(task.worktree),
      reason,
    ));
    return {
      executedScripts: [],
      validationEvidence: buildValidationEvidenceManifest(task, configuredScripts, evidenceRuns),
    };
  }

  const manifest = readPackageManifest(installRoot);
  if (!manifest?.scripts) {
    const reason = `no scripts in ${installRoot}`;
    appendFinalizeLog(task, `Skipped quality gates (${reason})`);
    evidenceRuns.push(...createSkippedGateRuns(
      requestedScripts,
      installRoot,
      path.basename(installRoot),
      reason,
    ));
    return {
      executedScripts: [],
      validationEvidence: buildValidationEvidenceManifest(task, configuredScripts, evidenceRuns),
    };
  }

  const changedFiles = listChangedFiles(task.worktree, task.baseCommitSha);
  const packageManager = detectPackageManager(task.worktree, task.repoPath) ?? 'npm';
  const targets = resolveQualityGateTargets(task, installRoot, manifest);
  const executedScripts: string[] = [];
  const changedFileSet = normalizeChangedFileSet(changedFiles);
  const changedLineMap = buildChangedLineMap(task.worktree, task.baseCommitSha);
  const preparations = resolvePrismaPreparationExecutions(
    installRoot,
    manifest,
    changedFiles,
  );
  const sandbox = createQualityGateSandbox(task);

  try {
  for (const preparation of preparations) {
    appendFinalizeLog(
      task,
      `Running quality gate preparation: ${packageManager} run ${preparation.actualScript} (reason: ${preparation.reason}, cwd: ${preparation.cwd})`
    );
    const command = `${packageManager} run ${preparation.actualScript}`;
    const startedAt = Date.now();
    const result = runManagedQualityGateCommand(packageManager, ['run', preparation.actualScript], {
      cwd: preparation.cwd,
      env: sandbox.env,
      timeoutMs,
    });
    const completedAt = Date.now();
    const durationMs = completedAt - startedAt;

    if (result.stdout?.trim()) {
      appendFinalizeLog(task, result.stdout.trim());
    }
    if (result.stderr?.trim()) {
      appendFinalizeLog(task, result.stderr.trim());
    }

    if (result.timedOut) {
      throw createQualityGateFailure(task, configuredScripts, evidenceRuns, 'quality_gate_preparation', {
        requestedScript: 'typecheck',
        actualScript: preparation.actualScript,
        cwd: preparation.cwd,
        packageLabel: preparation.label,
        command,
        rawMessage: `Quality gate preparation "${preparation.actualScript}" timed out after ${formatTimeoutSeconds(timeoutMs)}s`,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.status,
        durationMs,
        startedAt,
        completedAt,
        timedOut: true,
      });
    }

    if (result.error) {
      throw createQualityGateFailure(task, configuredScripts, evidenceRuns, 'quality_gate_preparation', {
        requestedScript: 'typecheck',
        actualScript: preparation.actualScript,
        cwd: preparation.cwd,
        packageLabel: preparation.label,
        command,
        rawMessage: `Quality gate preparation "${preparation.actualScript}" failed to start: ${result.error.message}`,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.status,
        durationMs,
        startedAt,
        completedAt,
        startFailed: true,
      });
    }

    if (result.status !== 0) {
      const errorMessage = result.stderr?.trim() || result.stdout?.trim() || `exit code ${result.status}`;
      throw createQualityGateFailure(task, configuredScripts, evidenceRuns, 'quality_gate_preparation', {
        requestedScript: 'typecheck',
        actualScript: preparation.actualScript,
        cwd: preparation.cwd,
        packageLabel: preparation.label,
        command,
        rawMessage: `Quality gate preparation "${preparation.actualScript}" failed: ${errorMessage}`,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.status,
        durationMs,
        startedAt,
        completedAt,
      });
    }

    evidenceRuns.push(createCompletedValidationRun({
      phase: 'quality_gate_preparation',
      requestedGate: 'typecheck',
      gate: preparation.actualScript,
      packageLabel: preparation.label,
      cwd: preparation.cwd,
      command,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.status,
      durationMs,
      startedAt,
      completedAt,
      reason: preparation.reason,
    }));
    executedScripts.push(`${preparation.label}:${preparation.actualScript}[prepare]`);
  }

  for (const target of targets) {
    const availableScripts = resolveScriptExecutions(target, requestedScripts);
    const resolvedRequestedScripts = new Set(availableScripts.map((script) => script.requestedScript));
    const skippedScripts = requestedScripts.filter((requestedScript) => !resolvedRequestedScripts.has(requestedScript));

    for (const requestedScript of skippedScripts) {
      evidenceRuns.push(createSkippedValidationRun({
        phase: 'quality_gate',
        requestedGate: requestedScript,
        packageLabel: target.label,
        cwd: target.cwd,
        reason: `script "${requestedScript}" is not defined for ${target.label}`,
      }));
    }

    if (availableScripts.length === 0) {
      appendFinalizeLog(task, `Skipped quality gates for ${target.label} (none of ${requestedScripts.join(', ')} exist)`);
      continue;
    }

    for (const scriptExecution of availableScripts) {
      appendFinalizeLog(
        task,
        `Running quality gate: ${packageManager} run ${scriptExecution.actualScript} (requested: ${scriptExecution.requestedScript}, cwd: ${target.cwd})`
      );
      const command = `${packageManager} run ${scriptExecution.actualScript}`;
      const startedAt = Date.now();
      const result = runManagedQualityGateCommand(packageManager, ['run', scriptExecution.actualScript], {
        cwd: target.cwd,
        env: sandbox.env,
        timeoutMs,
      });
      const completedAt = Date.now();
      const durationMs = completedAt - startedAt;

      if (result.stdout?.trim()) {
        appendFinalizeLog(task, result.stdout.trim());
      }
      if (result.stderr?.trim()) {
        appendFinalizeLog(task, result.stderr.trim());
      }

      if (result.timedOut) {
        throw createQualityGateFailure(task, configuredScripts, evidenceRuns, 'quality_gate', {
          requestedScript: scriptExecution.requestedScript,
          actualScript: scriptExecution.actualScript,
          cwd: target.cwd,
          packageLabel: target.label,
          command,
          rawMessage: `Quality gate "${scriptExecution.actualScript}" timed out after ${formatTimeoutSeconds(timeoutMs)}s`,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status,
          durationMs,
          startedAt,
          completedAt,
          timedOut: true,
        });
      }

      if (result.error) {
        throw createQualityGateFailure(task, configuredScripts, evidenceRuns, 'quality_gate', {
          requestedScript: scriptExecution.requestedScript,
          actualScript: scriptExecution.actualScript,
          cwd: target.cwd,
          packageLabel: target.label,
          command,
          rawMessage: `Quality gate "${scriptExecution.actualScript}" failed to start: ${result.error.message}`,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status,
          durationMs,
          startedAt,
          completedAt,
          startFailed: true,
        });
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
            evidenceRuns.push(createCompletedValidationRun({
              phase: 'quality_gate',
              requestedGate: scriptExecution.requestedScript,
              gate: scriptExecution.actualScript,
              packageLabel: target.label,
              cwd: target.cwd,
              command,
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.status,
              durationMs,
              startedAt,
              completedAt,
              classification: 'legacy_debt',
              reason: lintFailure.summary,
            }));
            executedScripts.push(`${target.label}:${scriptExecution.actualScript}[legacy-debt]`);
            continue;
          }
        }
        throw createQualityGateFailure(task, configuredScripts, evidenceRuns, 'quality_gate', {
          requestedScript: scriptExecution.requestedScript,
          actualScript: scriptExecution.actualScript,
          cwd: target.cwd,
          packageLabel: target.label,
          command,
          rawMessage: `Quality gate "${scriptExecution.actualScript}" failed: ${errorMessage}`,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status,
          durationMs,
          startedAt,
          completedAt,
        });
      }

      evidenceRuns.push(createCompletedValidationRun({
        phase: 'quality_gate',
        requestedGate: scriptExecution.requestedScript,
        gate: scriptExecution.actualScript,
        packageLabel: target.label,
        cwd: target.cwd,
        command,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.status,
        durationMs,
        startedAt,
        completedAt,
      }));
      executedScripts.push(`${target.label}:${scriptExecution.actualScript}`);
    }
  }

  if (executedScripts.length === 0) {
    appendFinalizeLog(task, `Skipped quality gates (none of ${requestedScripts.join(', ')} exist in changed targets)`);
    return {
      executedScripts,
      validationEvidence: buildValidationEvidenceManifest(task, configuredScripts, evidenceRuns),
    };
  }

  appendFinalizeLog(task, `Quality gates passed: ${executedScripts.join(', ')}`);
  return {
    executedScripts,
    validationEvidence: buildValidationEvidenceManifest(task, configuredScripts, evidenceRuns),
  };
  } finally {
    sandbox.cleanup();
  }
}

export function finalizeTaskOutput(task: Task): FinalizeResult {
  assertFinalizerScope(task);

  bootstrapWorktreeDeps(task.worktree, {
    repoPath: task.repoPath,
    logPath: task.logPath,
    installIfNeeded: false,
  });

  const configManager = new ConfigManager();
  const qualityGateTimeoutMs = resolveQualityGateTimeoutMs(configManager);
  const qualityGateScripts = resolveConfiguredQualityGates(configManager);
  const worktreePath = path.resolve(task.worktree);
  const localMergeEnv = resolveLocalMergeGitEnv(worktreePath);
  const existingCommitState = detectExistingTaskCommit(task, worktreePath);
  const changedFilesBeforeFinalize = listChangedFiles(worktreePath);

  if (changedFilesBeforeFinalize.length === 0 && !existingCommitState.hasExistingCommit && !localMergeEnv) {
    const reason = 'no changes or existing task commits detected before finalization';
    return {
      success: true,
      committed: false,
      message: 'No changes to commit',
      validationEvidence: buildValidationEvidenceManifest(
        task,
        qualityGateScripts,
        createSkippedGateRuns(qualityGateScripts, worktreePath, path.basename(worktreePath), reason),
      ),
    };
  }

  const qualityGateResult = runQualityGates(task, qualityGateTimeoutMs, qualityGateScripts);
  const qualityGates = qualityGateResult.executedScripts;
  const validationEvidence = qualityGateResult.validationEvidence;

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
        validationEvidence,
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
      validationEvidence,
    };
  }

  runGit(worktreePath, ['add', '-A', '--', '.', ...buildFinalizerExcludePathspecs()]);

  const stagedFiles = listStagedFiles(worktreePath);
  if (stagedFiles.length === 0) {
    return {
      success: true,
      committed: false,
      message: 'No staged changes to commit',
      validationEvidence,
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
    validationEvidence,
  };
}
