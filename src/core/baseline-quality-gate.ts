import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager } from '../config/manager';
import { bootstrapWorktreeDeps } from './bootstrap';
import {
  BaselineQualityGateEnvironmentRepairState,
  BaselineQualityGateRootCause,
  BaselineQualityGateState,
  BaselineRecoveryPhase,
  FinalizerFailureDetails,
  Task,
  ToolchainEnvFingerprint,
} from '../types/task';
import { parseTurboNestedFailures } from './finalize-failure-classifier';
import {
  buildRalphToolchainEnv,
  isCorepackDownloadFailure,
} from './toolchain-env';

export type BaselineQualityGateClassificationKind =
  | 'baseline_quality_gate_failure'
  | 'task_quality_gate_failure'
  | 'baseline_probe_failed'
  | 'not_quality_gate_failure';

type BaselineQualityGateRecordedKind = Exclude<
  BaselineQualityGateClassificationKind,
  'not_quality_gate_failure'
>;

interface BaselineQualityGateClassificationBase {
  signature?: string;
  taskFailureSignature?: string;
  baselineFailureSignature?: string;
  repairKey?: string;
  repairGroupKey?: string;
  repairComponentKey?: string;
  environmentFingerprint?: ToolchainEnvFingerprint;
  message: string;
  rootCause?: BaselineQualityGateRootCause;
  taskRootCause?: BaselineQualityGateRootCause;
  confidence?: number;
}

export type BaselineQualityGateClassification = ({
  kind: 'not_quality_gate_failure';
  baselineFailure?: never;
} & BaselineQualityGateClassificationBase) | ({
  kind: BaselineQualityGateRecordedKind;
  baselineFailure?: FinalizerFailureDetails;
} & BaselineQualityGateClassificationBase);

export interface BaselineGateProbeResult {
  ok: boolean;
  message: string;
  exitCode?: number | null;
  errorKind?: 'output_buffer_overflow' | 'spawn_error' | 'timeout';
  outputTruncated?: boolean;
  environmentFingerprint?: ToolchainEnvFingerprint;
}

export type BaselineGateProbe = (input: {
  cwd: string;
  command: string;
  timeoutMs: number;
  failure: FinalizerFailureDetails;
  task: Task;
}) => Promise<BaselineGateProbeResult> | BaselineGateProbeResult;

interface RootCauseAnalysis {
  rootCause: BaselineQualityGateRootCause;
  confidence: number;
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeEvidence(value: string | undefined, task?: Pick<Task, 'repoPath' | 'worktree'>): string | undefined {
  if (!value) {
    return undefined;
  }

  let normalized = value.replace(ANSI_PATTERN, '');

  if (task?.worktree) {
    normalized = normalized.replace(
      new RegExp(escapeRegex(path.resolve(task.worktree)), 'g'),
      '<task-worktree>',
    );
  }

  if (task?.repoPath) {
    normalized = normalized.replace(
      new RegExp(escapeRegex(path.resolve(task.repoPath)), 'g'),
      '<repo>',
    );
  }

  return normalized
    .replace(/\/private\/var\/folders\/[^\s'")]+/g, '<tmp>')
    .replace(/\/var\/folders\/[^\s'")]+/g, '<tmp>')
    .replace(/\/tmp\/[^\s'")]+/g, '<tmp>')
    .replace(/\b[0-9a-f]{40}\b/gi, '<sha>')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeList(values: string[] | undefined, task?: Pick<Task, 'repoPath' | 'worktree'>): string | undefined {
  if (!values?.length) {
    return undefined;
  }

  return values
    .map((value) => normalizeEvidence(value, task))
    .filter((value): value is string => Boolean(value))
    .sort()
    .join(',');
}

export function buildBaselineFailureSignature(
  failure: FinalizerFailureDetails,
  task?: Pick<Task, 'repoPath' | 'worktree'>,
): string {
  const parts = [
    failure.gate,
    failure.packageLabel,
    failure.class,
    normalizeEvidence(failure.command, task),
    normalizeEvidence(failure.diagnosticSignature, task),
    normalizeList(failure.failedFiles, task),
    normalizeList(failure.failedCodes, task),
    normalizeList(failure.failedSymbols, task),
    normalizeEvidence(failure.rawMessage, task),
  ].filter(Boolean);

  return parts.join('|').slice(0, 1600);
}

function buildRepairKey(input: {
  targetBranch: string;
  baselineFailureSignature: string;
}): string {
  return [
    'baseline-quality-gate',
    input.targetBranch,
    input.baselineFailureSignature,
  ].join('|');
}

export function deriveBaselineRepairGroupKey(input: {
  targetBranch: string;
  packageLabel: string;
}): string {
  return [
    'baseline-quality-gate',
    input.targetBranch,
    `package:${input.packageLabel || 'unknown'}`,
  ].join('|');
}

export function deriveBaselineRepairComponentKey(input: {
  targetBranch: string;
  packageLabel: string;
  gate: string;
  failureClass?: string;
  diagnosticSignature?: string;
  failedFilesSignature?: string;
}): string {
  return [
    'baseline-quality-gate',
    input.targetBranch,
    `package:${input.packageLabel || 'unknown'}`,
    `gate:${input.gate || 'unknown'}`,
    `class:${input.failureClass || 'unknown'}`,
    input.diagnosticSignature ? `diagnostics:${input.diagnosticSignature}` : undefined,
    input.failedFilesSignature ? `files:${input.failedFilesSignature}` : undefined,
  ].filter(Boolean).join('|').slice(0, 1600);
}

function combinedFailureText(
  failure: FinalizerFailureDetails,
  task?: Pick<Task, 'repoPath' | 'worktree'>,
): string {
  return [
    failure.class,
    failure.rawMessage,
    failure.diagnosticSignature,
    failure.failedFiles?.join('\n'),
    failure.failedCodes?.join('\n'),
    failure.failedSymbols?.join('\n'),
    failure.diagnostics?.map((diagnostic) => diagnostic.message).join('\n'),
  ]
    .map((value) => normalizeEvidence(value, task))
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

function classifyFailureRootCause(input: {
  failure: FinalizerFailureDetails;
  task?: Pick<Task, 'repoPath' | 'worktree'>;
  baseline: boolean;
}): RootCauseAnalysis {
  const text = combinedFailureText(input.failure, input.task);

  if (isCorepackDownloadFailure(text)) {
    return {
      rootCause: 'dependency_bootstrap_worktree_environment',
      confidence: 0.95,
    };
  }

  if (input.failure.class === 'test_module_provider_drift' || /nest can't resolve dependencies/i.test(text)) {
    return {
      rootCause: input.baseline ? 'shared_baseline_code_debt' : 'task_induced',
      confidence: input.baseline ? 0.9 : 0.75,
    };
  }

  if (
    /node_modules/.test(text)
    && /symlink/.test(text)
    && /(filesystem root|outside|not within|invalid)/.test(text)
  ) {
    return {
      rootCause: 'dependency_bootstrap_worktree_environment',
      confidence: 0.95,
    };
  }

  if (/(^|[^a-z])(module not found|can't resolve|cannot find module|err_module_not_found|ts2307)([^a-z]|$)/.test(text)) {
    return {
      rootCause: input.baseline ? 'shared_baseline_code_debt' : 'task_induced',
      confidence: input.baseline ? 0.9 : 0.75,
    };
  }

  if (/(generated|\.next\/types|prisma|schema|typegen|codegen|drift)/.test(text)) {
    return {
      rootCause: input.baseline ? 'generated_artifact_drift' : 'task_induced',
      confidence: input.baseline ? 0.85 : 0.7,
    };
  }

  if (input.failure.timedOut || /(timeout|timed out|panic|internal error|segmentation fault|econnreset)/.test(text)) {
    return {
      rootCause: 'toolchain_flake',
      confidence: 0.55,
    };
  }

  return {
    rootCause: input.baseline ? 'shared_baseline_code_debt' : 'task_induced',
    confidence: input.baseline ? 0.6 : 0.55,
  };
}

export function isBaselineQualityGateStateCurrent(task: Pick<
  Task,
  | 'repoPath'
  | 'worktree'
  | 'finalizerFailure'
  | 'baselineQualityGate'
  | 'latestFailure'
>): boolean {
  const baseline = task.baselineQualityGate;
  const failureSignature = task.latestFailure?.signature
    ?? (task.finalizerFailure ? buildBaselineFailureSignature(task.finalizerFailure, task) : undefined);

  if (!baseline) {
    return false;
  }

  if (!failureSignature) {
    return true;
  }

  if (
    task.latestFailure?.packageLabel
    && baseline.packageLabel
    && task.latestFailure.packageLabel !== baseline.packageLabel
  ) {
    return false;
  }

  if (
    task.latestFailure?.gate
    && baseline.gate
    && task.latestFailure.gate !== baseline.gate
  ) {
    return false;
  }

  if (!baseline.taskFailureSignature && !baseline.latestFailureSignature) {
    return false;
  }

  return baseline.taskFailureSignature === failureSignature
    || baseline.latestFailureSignature === failureSignature;
}

function resolveQualityGateTimeoutMs(config: Pick<ConfigManager, 'get'>): number {
  const configuredTimeout = Number(config.get('finalizer.qualityGateTimeout'));

  if (!Number.isFinite(configuredTimeout) || configuredTimeout <= 0) {
    return 600_000;
  }

  return configuredTimeout >= 1000 ? configuredTimeout : configuredTimeout * 1000;
}

function runGit(repoPath: string, args: string[]): string | undefined {
  try {
    const result = spawnSync('git', args, {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (result.status !== 0) {
      return undefined;
    }

    return result.stdout.trim();
  } catch {
    return undefined;
  }
}

function resolveBaselineCwd(
  task: Task,
  failure: FinalizerFailureDetails,
  baselineRepoPath = task.repoPath,
): string | undefined {
  const relativeCwd = path.relative(path.resolve(task.worktree), path.resolve(failure.cwd));
  if (relativeCwd.startsWith('..') || path.isAbsolute(relativeCwd)) {
    return undefined;
  }

  return path.resolve(baselineRepoPath, relativeCwd);
}

function addDetachedBaselineProbeWorktree(input: {
  repoPath: string;
  targetBranch: string;
}): { ok: true; path: string; commit: string } | { ok: false; message: string } {
  const commit = runGit(input.repoPath, ['rev-parse', '--verify', `${input.targetBranch}^{commit}`]);
  if (!commit) {
    return {
      ok: false,
      message: `could not resolve target branch ${input.targetBranch} for isolated baseline probe`,
    };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-baseline-probe-'));
  fs.rmSync(tempDir, { recursive: true, force: true });

  const result = spawnSync('git', ['worktree', 'add', '--detach', tempDir, commit], {
    cwd: input.repoPath,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    return {
      ok: false,
      message: `could not create isolated baseline probe worktree: ${result.stderr?.trim() || result.stdout?.trim() || `exit code ${result.status}`}`,
    };
  }

  return {
    ok: true,
    path: tempDir,
    commit,
  };
}

function removeBaselineProbeWorktree(repoPath: string, worktreePath: string): void {
  const result = spawnSync('git', ['worktree', 'remove', '--force', worktreePath], {
    cwd: repoPath,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    fs.rmSync(worktreePath, { recursive: true, force: true });
    spawnSync('git', ['worktree', 'prune'], {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
}

function normalizeFinalizerFailureForTask(
  task: Task,
  failure: FinalizerFailureDetails,
): FinalizerFailureDetails {
  if (failure.nestedFailures?.length) {
    return failure;
  }

  const nestedFailures = parseTurboNestedFailures({
    output: failure.rawMessage,
    taskWorktree: task.worktree,
    repoPath: task.repoPath,
    parentCommand: failure.command,
  });
  const primaryNestedFailure = nestedFailures[0];
  if (!primaryNestedFailure) {
    return failure;
  }

  const failureCwd = path.resolve(failure.cwd);
  const taskWorktree = path.resolve(task.worktree);
  const isRootFailure = failure.packageLabel === task.id
    || failure.packageLabel === path.basename(task.worktree)
    || failureCwd === taskWorktree
    || failureCwd === path.resolve(task.repoPath);

  if (!isRootFailure) {
    return failure;
  }

  return {
    ...failure,
    gate: primaryNestedFailure.gate,
    packageLabel: primaryNestedFailure.packageLabel,
    cwd: primaryNestedFailure.cwd,
    command: primaryNestedFailure.command,
    parentCommand: failure.parentCommand ?? failure.command,
    parentCwd: failure.parentCwd ?? failure.cwd,
    nestedFailures,
  };
}

function defaultProbe(input: {
  cwd: string;
  command: string;
  timeoutMs: number;
  task: Task;
}): BaselineGateProbeResult {
  const { env, fingerprint } = buildRalphToolchainEnv({
    baseEnv: process.env,
    installRoot: input.cwd,
    ralphHome: process.env.RALPH_HOME,
  });
  const result = spawnSync(input.command, {
    cwd: input.cwd,
    shell: true,
    encoding: 'utf-8',
    env,
    timeout: input.timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [result.stdout?.trim(), result.stderr?.trim()]
    .filter(Boolean)
    .join('\n')
    .slice(0, 1200);
  const errorMessage = result.error?.message;
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const outputBufferOverflow = errorCode === 'ENOBUFS'
    || /ENOBUFS|stdout maxBuffer length exceeded|stderr maxBuffer length exceeded/i.test(errorMessage || '');
  const timedOut = result.error?.name === 'TimeoutError'
    || errorCode === 'ETIMEDOUT'
    || /timed out|timeout/i.test(errorMessage || '');

  return {
    ok: result.status === 0,
    exitCode: result.status,
    errorKind: outputBufferOverflow
      ? 'output_buffer_overflow'
      : timedOut
        ? 'timeout'
        : result.error
          ? 'spawn_error'
          : undefined,
    outputTruncated: outputBufferOverflow || output.length >= 1200,
    environmentFingerprint: fingerprint,
    message: errorMessage
      ? outputBufferOverflow
        ? `baseline probe output exceeded buffer: ${errorMessage}`
        : errorMessage
      : output || `exit code ${result.status}`,
  };
}

function isBaselineProbeBufferOverflow(result: Pick<BaselineGateProbeResult, 'errorKind' | 'message'>): boolean {
  return result.errorKind === 'output_buffer_overflow'
    || /ENOBUFS|output exceeded buffer|stdout maxBuffer length exceeded|stderr maxBuffer length exceeded/i.test(result.message);
}

export async function classifyBaselineQualityGateFailure(input: {
  task: Task;
  configManager: Pick<ConfigManager, 'get'>;
  targetBranch?: string;
  runGate?: BaselineGateProbe;
}): Promise<BaselineQualityGateClassification> {
  const { task } = input;
  const failure = task.finalizerFailure
    ? normalizeFinalizerFailureForTask(task, task.finalizerFailure)
    : undefined;
  const targetBranch = input.targetBranch ?? 'main';
  const taskFailureSignature = failure
    ? buildBaselineFailureSignature(failure, task)
    : undefined;

  if (
    task.status !== 'failed_finalize'
    || !['quality_gate_failure', 'baseline_quality_gate_failure'].includes(task.lastErrorKind ?? '')
    || !failure
  ) {
    return {
      kind: 'not_quality_gate_failure',
      signature: taskFailureSignature,
      taskFailureSignature,
      message: 'task is not a failed finalizer quality-gate failure',
    };
  }

  const taskAnalysis = classifyFailureRootCause({
    failure,
    task,
    baseline: false,
  });
  const repairGroupKey = deriveBaselineRepairGroupKey({
    targetBranch,
    packageLabel: failure.packageLabel,
  });
  const repairComponentKey = deriveBaselineRepairComponentKey({
    targetBranch,
    packageLabel: failure.packageLabel,
    gate: failure.gate,
    failureClass: failure.class,
    diagnosticSignature: failure.diagnosticSignature,
    failedFilesSignature: normalizeList(failure.failedFiles, task),
  });

  if (isCorepackDownloadFailure(combinedFailureText(failure, task))) {
    return {
      kind: 'task_quality_gate_failure',
      signature: taskFailureSignature,
      taskFailureSignature,
      repairGroupKey,
      repairComponentKey,
      message: 'task finalizer failed because Corepack/PNPM cache was not available in the normalized toolchain environment',
      rootCause: taskAnalysis.rootCause,
      taskRootCause: taskAnalysis.rootCause,
      confidence: taskAnalysis.confidence,
    };
  }

  const initialBaselineCwd = resolveBaselineCwd(task, failure);
  if (!initialBaselineCwd || !fs.existsSync(initialBaselineCwd)) {
    return {
      kind: 'baseline_probe_failed',
      signature: taskFailureSignature,
      taskFailureSignature,
      repairComponentKey,
      message: 'could not resolve the quality-gate cwd on the target baseline worktree',
      rootCause: 'unsafe_ambiguous',
      taskRootCause: taskAnalysis.rootCause,
      confidence: 0.8,
    };
  }

  const dirtyStatus = runGit(task.repoPath, ['status', '--porcelain']);
  let probeRepoPath = task.repoPath;
  let baselineCwd = initialBaselineCwd;
  let isolatedProbeWorktree: string | undefined;

  if (dirtyStatus && dirtyStatus.trim()) {
    const isolatedWorktree = addDetachedBaselineProbeWorktree({
      repoPath: task.repoPath,
      targetBranch,
    });

    if (!isolatedWorktree.ok) {
      return {
        kind: 'baseline_probe_failed',
        signature: taskFailureSignature,
        taskFailureSignature,
        repairComponentKey,
        message: `target baseline worktree is dirty and isolated baseline probe setup failed: ${isolatedWorktree.message}`,
        rootCause: 'unsafe_ambiguous',
        taskRootCause: taskAnalysis.rootCause,
        confidence: 0.85,
      };
    }

    isolatedProbeWorktree = isolatedWorktree.path;
    probeRepoPath = isolatedProbeWorktree;
    const isolatedBaselineCwd = resolveBaselineCwd(task, failure, probeRepoPath);
    if (!isolatedBaselineCwd || !fs.existsSync(isolatedBaselineCwd)) {
      removeBaselineProbeWorktree(task.repoPath, isolatedProbeWorktree);
      return {
        kind: 'baseline_probe_failed',
        signature: taskFailureSignature,
        taskFailureSignature,
        repairComponentKey,
        message: 'could not resolve the quality-gate cwd in the isolated baseline probe worktree',
        rootCause: 'unsafe_ambiguous',
        taskRootCause: taskAnalysis.rootCause,
        confidence: 0.8,
      };
    }

    baselineCwd = isolatedBaselineCwd;
  }

  try {
    if (isolatedProbeWorktree && !input.runGate) {
      try {
        bootstrapWorktreeDeps(isolatedProbeWorktree, {
          repoPath: task.repoPath,
          logger: () => undefined,
        });
      } catch (error) {
        return {
          kind: 'baseline_probe_failed',
          signature: taskFailureSignature,
          taskFailureSignature,
          repairComponentKey,
          message: `isolated baseline probe dependency bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
          rootCause: 'unsafe_ambiguous',
          taskRootCause: taskAnalysis.rootCause,
          confidence: 0.85,
        };
      }
    }

    const timeoutMs = resolveQualityGateTimeoutMs(input.configManager);
    const probe = input.runGate ?? defaultProbe;
    const result = await probe({
      cwd: baselineCwd,
      command: failure.command,
      timeoutMs,
      failure,
      task,
    });

    if (result.ok) {
      return {
        kind: 'task_quality_gate_failure',
        signature: taskFailureSignature,
        taskFailureSignature,
        repairGroupKey,
        repairComponentKey,
        environmentFingerprint: result.environmentFingerprint,
        message: isolatedProbeWorktree
          ? 'isolated target baseline quality gate passed; failure appears task-specific'
          : 'target baseline quality gate passed; failure appears task-specific',
        rootCause: taskAnalysis.rootCause,
        taskRootCause: taskAnalysis.rootCause,
        confidence: taskAnalysis.confidence,
      };
    }

    if (
      input.configManager.get('runner.baselineQualityGateTreatProbeBufferOverflowAsProbeFailure') !== false
      && isBaselineProbeBufferOverflow(result)
    ) {
      return {
        kind: 'baseline_probe_failed',
        signature: taskFailureSignature,
        taskFailureSignature,
        repairGroupKey,
        repairComponentKey,
        environmentFingerprint: result.environmentFingerprint,
        message: `${isolatedProbeWorktree ? 'isolated ' : ''}target baseline quality-gate probe exceeded output buffer; treating as probe failure instead of product baseline failure: ${result.message}`,
        rootCause: 'toolchain_flake',
        taskRootCause: taskAnalysis.rootCause,
        confidence: 0.85,
      };
    }

    const baselineFailure: FinalizerFailureDetails = {
      ...failure,
      cwd: baselineCwd,
      exitCode: result.exitCode ?? failure.exitCode,
      rawMessage: result.message,
    };
    const baselineFailureSignature = buildBaselineFailureSignature(baselineFailure, {
      repoPath: probeRepoPath,
      worktree: probeRepoPath,
    });
    const baselineAnalysis = classifyFailureRootCause({
      failure: baselineFailure,
      task: {
        repoPath: probeRepoPath,
        worktree: probeRepoPath,
      },
      baseline: true,
    });

    return {
      kind: 'baseline_quality_gate_failure',
      signature: baselineFailureSignature,
      taskFailureSignature,
      baselineFailureSignature,
      repairGroupKey,
      repairComponentKey,
      environmentFingerprint: result.environmentFingerprint,
      repairKey: buildRepairKey({
        targetBranch,
        baselineFailureSignature,
      }),
      message: `${isolatedProbeWorktree ? 'isolated ' : ''}target baseline quality gate failed with the same gate context: ${result.message}`,
      rootCause: baselineAnalysis.rootCause,
      taskRootCause: taskAnalysis.rootCause,
      confidence: Math.min(baselineAnalysis.confidence, 0.95),
      baselineFailure,
    };
  } finally {
    if (isolatedProbeWorktree) {
      removeBaselineProbeWorktree(task.repoPath, isolatedProbeWorktree);
    }
  }
}

export function buildBaselineQualityGateState(input: {
  task: Task;
  classification: Exclude<BaselineQualityGateClassification, { kind: 'not_quality_gate_failure' }>;
  targetBranch: string;
  observedAt: number;
  repairTaskId?: string;
  demandTaskIds?: string[];
  phase?: BaselineRecoveryPhase;
  taskEnvRepair?: BaselineQualityGateEnvironmentRepairState;
  baselineEnvRepair?: BaselineQualityGateEnvironmentRepairState;
  stoppedAt?: number;
  stopReason?: string;
}): BaselineQualityGateState {
  const failure = input.task.finalizerFailure;
  const latestFailure = input.task.latestFailure;
  const signature = input.classification.signature
    ?? (failure ? buildBaselineFailureSignature(failure, input.task) : 'unknown');
  return {
    kind: input.classification.kind,
    failureObservationId: input.task.latestFailure?.id,
    observedAt: input.observedAt,
    lastUpdatedAt: input.observedAt,
    targetBranch: input.targetBranch,
    gate: latestFailure?.gate ?? failure?.gate ?? input.classification.baselineFailure?.gate ?? 'unknown',
    packageLabel: latestFailure?.packageLabel ?? failure?.packageLabel ?? input.classification.baselineFailure?.packageLabel ?? 'unknown',
    signature,
    latestFailureSignature: input.task.latestFailure?.signature,
    taskFailureSignature: input.classification.taskFailureSignature,
    baselineFailureSignature: input.classification.baselineFailureSignature,
    repairKey: input.classification.repairKey,
    repairGroupKey: input.classification.repairGroupKey,
    repairComponentKey: input.classification.repairComponentKey,
    message: input.classification.message,
    rootCause: input.classification.rootCause,
    taskRootCause: input.classification.taskRootCause,
    phase: input.phase ?? (input.repairTaskId ? 'waiting_for_baseline_repair' : 'classified'),
    confidence: input.classification.confidence,
    repairTaskId: input.repairTaskId,
    demandTaskIds: input.demandTaskIds,
    environmentFingerprint: input.classification.environmentFingerprint,
    baselineFailure: input.classification.baselineFailure,
    taskEnvRepair: input.taskEnvRepair,
    baselineEnvRepair: input.baselineEnvRepair,
    stoppedAt: input.stoppedAt,
    stopReason: input.stopReason,
  };
}
