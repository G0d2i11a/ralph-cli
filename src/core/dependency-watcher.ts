import { execFileSync } from 'child_process';
import * as path from 'path';
import { ConfigManager } from '../config/manager';
import { StateManager } from '../core/state';
import { appendTaskEvent } from './events';
import { FinalizeResult, finalizeTaskOutput } from './finalizer';
import { isQualityGateFailure } from './finalize-failure-classifier';
import { assertRalphHomeIsolation } from './home-isolation';
import { resolveTaskIntegrationStatus } from './task-delivery';
import {
  resolveIntegrationPolicy,
  resolveMergeTargetBranch,
  shouldAttemptAutomaticIntegration,
} from './integration-policy';
import { withIntegrationLaneLock, withTaskFinalizeLock } from './locks';
import { mergeBranch, MergeStrategy } from './merge';
import {
  buildMergeFailureUpdates,
  createMergeFailureError,
  formatDestructiveAutoResolveError,
  getTaskUpdatesFromError,
  isDestructiveMergeStrategy,
} from './merge-policy';
import {
  buildSuccessfulMergeTaskUpdates,
  buildMergeRepairObservationSignature,
  buildMergeRepairProof,
  deriveMergeRepairDisplayStatus,
} from './merge-task-updates';
import {
  decideFinalizeRepairRequeue,
  evaluateFinalizeRepairFailure,
  resolveFinalizeRepairConfig,
} from './finalize-repair-policy';
import { buildMergeRepairReason, buildTaskRepairContext } from './repair-context';
import {
  captureObservedTaskSurface,
  findCoordinationBlockers,
  resolveTaskIntegrationLane,
} from './task-coordination';
import { buildFinalizeRetryReset } from './task-reset';
import { evaluateFailedTaskForFinalizeRecovery } from './soft-success';
import {
  buildStoryCompletionInvariantFailureUpdates,
  evaluateTaskStoryCompletion,
  formatStoryCompletionInvariantMessage,
} from './story-completion';
import { DEFAULT_AGENT, resolveAgentBackend, resolveAgentType, resolveConfiguredBackend } from './agent';
import { classifyAgentFailureOutput, ErrorClassification } from './error-classifier';
import {
  resolveFailedBlockerRecoveryConfig,
  isTransientTaskErrorClass,
  resolveTransientRecoveryConfig,
  resolveTransientRecoveryDelayMs,
} from './auto-recovery-policy';
import {
  DEFAULT_EZ4IELTS_PATTERN,
  DEFAULT_EZ4IELTS_SETTLE_MS,
  PrdAutoIngestor,
} from './prd-auto-ingest';
import { TaskScheduler } from './scheduler';
import { Task } from '../types/task';
import { probeTaskMergeability, probeTaskWorktreeMergeability } from './merge';

export interface WatchCommandOptions {
  interval?: number;
  repo?: string;
  agent?: string;
  backend?: string;
  allowMixedHome?: boolean;
  autoIngestEz4ielts?: boolean;
  ez4ieltsDir?: string;
}

interface DependencyWatcherDeps {
  stateManager?: StateManager;
  scheduler?: TaskScheduler;
  configManager?: Pick<ConfigManager, 'get'>;
  autoIngestor?: Pick<PrdAutoIngestor, 'initialize' | 'scan'>;
  detectAlreadyIntegratedTask?: (task: Task, targetBranch: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<typeof console, 'log' | 'error'>;
  finalizer?: typeof finalizeTaskOutput;
  mergeTask?: typeof mergeBranch;
  probeMergeability?: typeof probeTaskMergeability;
  probeWorktreeMergeability?: typeof probeTaskWorktreeMergeability;
  lifecycle?: DependencyWatcherLifecycleHooks;
}

interface DependencyWatcherLifecycleHooks {
  onStarted?: () => void | Promise<void>;
  onLoopStarted?: () => void | Promise<void>;
  onLoopCompleted?: () => void | Promise<void>;
  onLoopError?: (error: unknown) => void | Promise<void>;
  onStopped?: () => void | Promise<void>;
}

function resolveConfiguredPollIntervalMs(value: unknown): number {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return 30000;
  }

  return numericValue * 1000;
}

function resolveAutoMergeDelayMs(value: unknown): number {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return 0;
  }

  return numericValue >= 1000 ? numericValue : numericValue * 1000;
}

function resolveFinalizerLeaseTimeoutMs(value: unknown): number {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return 30 * 60 * 1000;
  }

  return numericValue * 1000;
}

function hasMergeConflict(task: Task): boolean {
  if (task.mergeConflictFiles && task.mergeConflictFiles.length > 0) {
    return true;
  }

  const message = task.mergeError || task.lastError || '';
  return /Merge conflicts detected/i.test(message);
}

function requiresPostFinalizeMergeProbe(task: Task): boolean {
  return task.postFinalizeMergeProbeRequired === true
    || task.repairContext?.mode === 'merge'
    || Boolean(task.mergeRepairAttempts && task.mergeRepairAttempts > 0)
    || Boolean(task.mergeConflictFiles?.length)
    || /Merge conflicts detected/i.test(task.mergeError || '');
}

function requiresMergeRepairProof(task: Pick<Task, 'postFinalizeMergeProbeRequired' | 'repairContext' | 'mergeRepairAttempts' | 'mergeConflictFiles' | 'mergeError' | 'lastError'>): boolean {
  return task.postFinalizeMergeProbeRequired === true
    || task.repairContext?.mode === 'merge'
    || Boolean(task.mergeConflictFiles?.length)
    || /Merge conflicts detected/i.test(task.mergeError || task.lastError || '');
}

function normalizeErrorSignature(message?: string): string | undefined {
  const normalized = (message || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);

  return normalized || undefined;
}

function buildMergeConflictSignature(conflictFiles?: string[]): string | undefined {
  if (!conflictFiles || conflictFiles.length === 0) {
    return undefined;
  }

  return [...new Set(conflictFiles)].sort().join('\n');
}

function isResolvedPendingMergeProof(
  probeResult?: Pick<Awaited<ReturnType<typeof probeTaskWorktreeMergeability>>, 'sourceKind' | 'worktreeMergeState'>,
): boolean {
  return probeResult?.sourceKind === 'resolved_pending_merge'
    || probeResult?.worktreeMergeState?.kind === 'resolved_pending_commit';
}

function selectRecoveryStoryId(task: Pick<Task, 'repairContext' | 'storyProgress' | 'completedUS'>): string | undefined {
  if (task.repairContext?.storyId) {
    return task.repairContext.storyId;
  }

  const failedStory = task.storyProgress
    ?.slice()
    .reverse()
    .find((story) => story.status === 'failed' || story.status === 'needs_repair');

  if (failedStory) {
    return failedStory.id;
  }

  return task.storyProgress?.[task.storyProgress.length - 1]?.id
    || task.completedUS[task.completedUS.length - 1];
}

function selectStagnantRecoveryStoryId(
  task: Pick<Task, 'currentUS' | 'repairContext' | 'storyProgress' | 'completedUS'>,
): string | undefined {
  const inProgressStory = task.storyProgress
    ?.slice()
    .reverse()
    .find((story) => story.status === 'in_progress');

  return inProgressStory?.id
    || task.repairContext?.storyId
    || task.currentUS
    || task.storyProgress
      ?.slice()
      .reverse()
      .find((story) => story.status === 'needs_repair' || story.status === 'pending')
      ?.id
    || selectRecoveryStoryId(task);
}

function buildRetryableFailureSignature(
  task: Pick<Task, 'lastErrorSignature' | 'lastErrorKind' | 'lastErrorClass' | 'lastError' | 'mergeError'>,
  classification?: Pick<ErrorClassification, 'signature'>,
): string {
  return task.lastErrorSignature
    || classification?.signature
    || (task.lastErrorKind && task.lastErrorClass
      ? `${task.lastErrorClass}:${task.lastErrorKind}`
      : undefined)
    || normalizeErrorSignature(task.lastError || task.mergeError)
    || 'unknown_failure';
}

function resolveRetryableTransientFailure(
  task: Pick<Task, 'lastError' | 'mergeError' | 'lastErrorKind' | 'lastErrorClass' | 'lastErrorRetryable' | 'lastErrorSignature'>,
): {
  kind: string;
  class: Task['lastErrorClass'];
  signature: string;
  message: string;
  backfill: Partial<Task>;
} | undefined {
  const message = task.lastError || task.mergeError || '';
  const classified = classifyAgentFailureOutput(message);

  if (task.lastErrorRetryable && isTransientTaskErrorClass(task.lastErrorClass)) {
    return {
      kind: task.lastErrorKind || classified.kind,
      class: task.lastErrorClass,
      signature: buildRetryableFailureSignature(task, classified),
      message,
      backfill: {
        lastErrorKind: task.lastErrorKind || classified.kind,
        lastErrorClass: task.lastErrorClass,
        lastErrorRetryable: true,
        lastErrorSignature: buildRetryableFailureSignature(task, classified),
      },
    };
  }

  if (!classified.explicit || !classified.retryable || !isTransientTaskErrorClass(classified.class)) {
    return undefined;
  }

  return {
    kind: classified.kind,
    class: classified.class,
    signature: buildRetryableFailureSignature(task, classified),
    message: task.lastError || classified.message,
    backfill: {
      lastErrorKind: classified.kind,
      lastErrorClass: classified.class,
      lastErrorRetryable: true,
      lastErrorSignature: buildRetryableFailureSignature(task, classified),
    },
  };
}

function resetSingleStory(
  task: Pick<Task, 'storyProgress' | 'completedUS'>,
  storyId: string,
  {
    status,
    updatedAt,
    message,
  }: {
    status: 'pending' | 'needs_repair';
    updatedAt: number;
    message: string;
  },
): {
  completedUS: string[];
  storyProgress: Task['storyProgress'];
} {
  return {
    completedUS: task.completedUS.filter((candidate) => candidate !== storyId),
    storyProgress: (task.storyProgress || []).map((story) => story.id === storyId
      ? {
          ...story,
          status,
          attempts: 0,
          lastError: message,
          updatedAt,
          history: [
            ...(story.history || []),
            {
              attempt: story.attempts,
              status,
              message,
              updatedAt,
            },
          ],
        }
      : story),
  };
}

function hasIntegrationOrMergeMarker(
  task: Pick<Task, 'integratedAt' | 'integrationStatus' | 'integrationCommitSha' | 'mergedAt' | 'mergeCommitSha'>,
): boolean {
  return Boolean(
    task.integratedAt
    || task.integrationStatus === 'integrated'
    || task.integrationCommitSha
    || task.mergedAt
    || task.mergeCommitSha
  );
}

function buildFailedBlockerRecoverySignature(
  task: Pick<Task, 'lastErrorSignature' | 'lastErrorKind' | 'lastError' | 'storyProgress'>,
): string {
  return task.lastErrorSignature
    || (task.lastErrorKind
      ? `${task.lastErrorKind}:${normalizeErrorSignature(task.lastError) || 'unknown'}`
      : undefined)
    || (task.storyProgress || [])
      .map((story) => `${story.id}:${story.status}:${story.attempts}`)
      .join('|')
    || 'story_incomplete';
}

function selectFailedBlockerResettableStoryIds(task: Pick<Task, 'storyProgress'>): string[] {
  return (task.storyProgress || [])
    .filter((story) => story.status !== 'passed')
    .map((story) => story.id);
}

function resetIncompleteStoriesForFailedBlocker(
  task: Pick<Task, 'storyProgress' | 'completedUS'>,
  storyIds: string[],
  {
    updatedAt,
    message,
  }: {
    updatedAt: number;
    message: string;
  },
): {
  completedUS: string[];
  storyProgress: Task['storyProgress'];
} {
  const resettable = new Set(storyIds);

  return {
    completedUS: task.completedUS.filter((candidate) => !resettable.has(candidate)),
    storyProgress: (task.storyProgress || []).map((story) => resettable.has(story.id)
      ? {
          ...story,
          status: 'pending' as const,
          attempts: 0,
          lastError: message,
          updatedAt,
          history: [
            ...(story.history || []),
            {
              attempt: story.attempts,
              status: 'pending' as const,
              message,
              updatedAt,
            },
          ],
        }
      : story),
  };
}

function mergeDemandTaskIds(existing: string[] | undefined, demandTaskIds: string[]): string[] {
  return [...new Set([...(existing || []), ...demandTaskIds])].sort();
}

function buildCompletedConflictRepairReset(task: Task, repairStoryId: string): {
  updatedAt: number;
  completedUS: string[];
  storyProgress: Task['storyProgress'];
  repairContext: Task['repairContext'];
} {
  const updatedAt = Date.now();
  const repairMessage = buildMergeRepairReason(task);

  return {
    updatedAt,
    completedUS: task.completedUS.filter((storyId) => storyId !== repairStoryId),
    storyProgress: (task.storyProgress || []).map((story) => story.id === repairStoryId
      ? {
          ...story,
          status: 'pending' as const,
          attempts: 0,
          lastError: repairMessage,
          updatedAt,
          history: [
            ...(story.history || []),
            {
              attempt: story.attempts,
              status: 'pending' as const,
              message: 'Automatically reset for merge repair',
              updatedAt,
            },
          ],
        }
      : story),
    repairContext: buildTaskRepairContext({
      mode: 'merge',
      storyId: repairStoryId,
      reason: repairMessage,
      createdAt: updatedAt,
    }),
  };
}

function selectFinalizeRepairStoryId(task: Task, mergeConflict: boolean): string | undefined {
  if (mergeConflict) {
    const needsRepairStory = (task.storyProgress || [])
      .slice()
      .reverse()
      .find((story) => story.status === 'needs_repair');
    if (needsRepairStory) {
      return needsRepairStory.id;
    }

    return task.storyProgress?.[task.storyProgress.length - 1]?.id
      || task.completedUS[task.completedUS.length - 1];
  }

  return task.completedUS[task.completedUS.length - 1]
    || task.storyProgress?.[task.storyProgress.length - 1]?.id;
}

function resolveTaskBranchName(task: Pick<Task, 'id'>): string {
  return `ralph/${task.id}`;
}

function resolveTaskIntegrationBranch(task: Pick<Task, 'integrationBranch' | 'integrationLane' | 'intendedMergeTarget' | 'mergeTargetBranch'>, targetBranch: string): string {
  if (typeof task.integrationBranch === 'string' && task.integrationBranch.trim()) {
    return task.integrationBranch.trim();
  }

  return `ralph/integration/${resolveTaskIntegrationLane(task, targetBranch)}`;
}

function isTaskAlreadyIntegrated(task: Task, targetBranch: string): boolean {
  const integrationBranch = resolveTaskIntegrationBranch(task, targetBranch);

  try {
    execFileSync('git', ['merge-base', '--is-ancestor', resolveTaskBranchName(task), integrationBranch], {
      cwd: task.repoPath,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

export class DependencyWatcher {
  private readonly scheduler: TaskScheduler;
  private readonly pollInterval: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Pick<typeof console, 'log' | 'error'>;
  private readonly autoIngestor?: Pick<PrdAutoIngestor, 'initialize' | 'scan'>;
  private readonly stateManager: StateManager;
  private readonly configManager: Pick<ConfigManager, 'get'>;
  private readonly detectAlreadyIntegratedTask: (task: Task, targetBranch: string) => boolean;
  private readonly finalizer: typeof finalizeTaskOutput;
  private readonly mergeTask: typeof mergeBranch;
  private readonly probeMergeability: typeof probeTaskMergeability;
  private readonly probeWorktreeMergeability: typeof probeTaskWorktreeMergeability;
  private readonly lifecycle?: DependencyWatcherLifecycleHooks;
  private readonly autoIngestEnabled: boolean;
  private isRunning = false;

  constructor(
    options: WatchCommandOptions = {},
    deps: DependencyWatcherDeps = {}
  ) {
    const stateManager = deps.stateManager ?? new StateManager();
    const configManager = deps.configManager ?? new ConfigManager();

    this.stateManager = stateManager;
    this.configManager = configManager;
    this.detectAlreadyIntegratedTask = deps.detectAlreadyIntegratedTask ?? isTaskAlreadyIntegrated;
    this.finalizer = deps.finalizer ?? finalizeTaskOutput;
    this.mergeTask = deps.mergeTask ?? mergeBranch;
    this.probeMergeability = deps.probeMergeability ?? probeTaskMergeability;
    this.probeWorktreeMergeability = deps.probeWorktreeMergeability ?? probeTaskWorktreeMergeability;
    this.scheduler = deps.scheduler ?? new TaskScheduler({ stateManager });
    this.pollInterval = Number.isFinite(options.interval) && Number(options.interval) > 0
      ? Number(options.interval)
      : resolveConfiguredPollIntervalMs(configManager.get('runner.pollInterval'));
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.logger = deps.logger ?? console;
    this.lifecycle = deps.lifecycle;

    this.autoIngestEnabled = options.autoIngestEz4ielts
      ?? Boolean(configManager.get('ingestion.ez4ielts.enabled'));

    if (deps.autoIngestor) {
      this.autoIngestor = deps.autoIngestor;
      return;
    }

    if (this.autoIngestEnabled) {
      const settleMs = Number(configManager.get('ingestion.ez4ielts.settleMs'));
      const configuredPattern = configManager.get('ingestion.ez4ielts.pattern');
      const configuredWatchDir = configManager.get('ingestion.ez4ielts.watchDir');
      const watchDir = options.ez4ieltsDir || configuredWatchDir || process.env.RALPH_EZ4IELTS_WATCH_DIR;

      if (!watchDir || !String(watchDir).trim()) {
        throw new Error('ez4ielts auto-ingest requires a watch directory. Pass `--ez4ielts-dir` or set `ingestion.ez4ielts.watchDir` / `RALPH_EZ4IELTS_WATCH_DIR`.');
      }

      const repoPath = options.repo || path.dirname(path.resolve(watchDir));
      const backend = options.backend
        ? resolveAgentBackend(options.backend)
        : resolveConfiguredBackend(configManager);

      this.autoIngestor = new PrdAutoIngestor({
        repoPath,
        agent: resolveAgentType(options.agent || DEFAULT_AGENT),
        backend,
        watchDir,
        pattern: typeof configuredPattern === 'string' ? configuredPattern : DEFAULT_EZ4IELTS_PATTERN,
        settleMs: Number.isFinite(settleMs) && settleMs >= 0 ? settleMs : DEFAULT_EZ4IELTS_SETTLE_MS,
        logger: (message) => this.logger.log(message),
      }, {
        stateManager,
        scheduler: this.scheduler,
      });
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.log('Dependency watcher is already running');
      return;
    }

    this.isRunning = true;
    await this.autoIngestor?.initialize();
    this.logger.log(`Dependency watcher started (polling every ${this.pollInterval / 1000}s)`);
    await this.invokeLifecycleHook('onStarted');

    while (this.isRunning) {
      await this.invokeLifecycleHook('onLoopStarted');
      try {
        await this.autoIngestor?.scan();
        await this.scheduler.recoverStaleTasks();
        await this.auditStoryCompletionInvariants();
        await this.recoverSoftFailedTasks();
        await this.recoverFailedWorkerMergeRepairTasks();
        await this.recoverFailedTransientTasks();
        await this.recoverStagnantTasks();
        await this.recoverFailedFinalizeTasks();
        await this.recoverCompletedConflictTasks();
        await this.integrateCompletedTasks();
        await this.finalizeReadyTasks();
        await this.recoverFailedBlockers();
        await this.checkPendingTasks();
        await this.invokeLifecycleHook('onLoopCompleted');
      } catch (error) {
        await this.invokeLoopErrorHook(error);
        this.logger.error('Error checking pending tasks:', error);
      }

      await this.sleep(this.pollInterval);
    }

    await this.invokeLifecycleHook('onStopped');
  }

  stop(): void {
    this.isRunning = false;
    this.logger.log('Dependency watcher stopped');
  }

  getPollIntervalMs(): number {
    return this.pollInterval;
  }

  isAutoIngestEnabled(): boolean {
    return this.autoIngestEnabled;
  }

  private async invokeLifecycleHook(
    hookName: Exclude<keyof DependencyWatcherLifecycleHooks, 'onLoopError'>
  ): Promise<void> {
    const hook = this.lifecycle?.[hookName];

    if (!hook) {
      return;
    }

    try {
      await hook();
    } catch (error) {
      this.logger.error(`Dependency watcher lifecycle hook ${hookName} failed:`, error);
    }
  }

  private async invokeLoopErrorHook(error: unknown): Promise<void> {
    if (!this.lifecycle?.onLoopError) {
      return;
    }

    try {
      await this.lifecycle.onLoopError(error);
    } catch (hookError) {
      this.logger.error('Dependency watcher lifecycle hook onLoopError failed:', hookError);
    }
  }

  async auditStoryCompletionInvariants(): Promise<void> {
    const tasks = (await this.stateManager.listTasks())
      .filter((task) => task.status === 'ready_to_finalize' || task.status === 'finalizing' || task.status === 'completed')
      .sort((a: Task, b: Task) => a.startTime - b.startTime);

    for (const task of tasks) {
      const storyCompletion = evaluateTaskStoryCompletion(task);
      if (storyCompletion.allStoriesPassed) {
        continue;
      }

      const observedAt = Date.now();
      const phase = task.status === 'completed' ? 'integrate' : 'finalize';
      const message = formatStoryCompletionInvariantMessage(task.id, phase, storyCompletion);
      await this.stateManager.updateTask(task.id, {
        status: 'failed',
        endTime: observedAt,
        pid: undefined,
        currentUS: undefined,
        leaseOwner: undefined,
        leaseHeartbeatAt: undefined,
        leaseExpiresAt: undefined,
        integratedAt: undefined,
        mergedAt: undefined,
        integrationCommitSha: undefined,
        mergeCommitSha: undefined,
        mergeMessage: undefined,
        postFinalizeMergeProbeRequired: undefined,
        repairContext: undefined,
        mergeRepairAttempts: 0,
        mergeRepairDisplayStatus: undefined,
        mergeRepairProof: undefined,
        mergeRepairRecoveryStartedAt: undefined,
        mergeRepairRecoveryDeadlineAt: undefined,
        mergeRepairRecoveryTotalRequeues: undefined,
        mergeRepairRecoveryConsecutiveNoProgress: undefined,
        mergeRepairRecoveryLastObservationSignature: undefined,
        mergeRepairRecoveryLastConflictSignature: undefined,
        mergeRepairRecoveryLastProbeMessage: undefined,
        mergeRepairRecoveryLastProgressReason: undefined,
        mergeRepairRecoveryStoppedAt: undefined,
        mergeRepairRecoveryStopReason: undefined,
        ...buildStoryCompletionInvariantFailureUpdates(message, observedAt),
      });
      appendTaskEvent(task, {
        type: 'story_completion_invariant_failed',
        status: 'failed',
        message,
        data: {
          phase,
          previousStatus: task.status,
          previousIntegrationStatus: task.integrationStatus,
          incompleteStories: storyCompletion.incompleteStories,
        },
      });
      this.logger.error(`Invalidated incomplete ${task.status} task ${task.id}: ${message}`);
    }
  }

  async recoverSoftFailedTasks(): Promise<void> {
    const failedTasks = (await this.stateManager.listTasks('failed'))
      .slice()
      .sort((a: Task, b: Task) => a.startTime - b.startTime);

    for (const task of failedTasks) {
      let mergeProofRecovery:
        | Awaited<ReturnType<typeof this.probeWorktreeMergeability>>
        | undefined;
      const needsMergeRepairProof = requiresMergeRepairProof(task);

      const decision = evaluateFailedTaskForFinalizeRecovery({
        logPath: task.logPath,
        worktreePath: task.worktree,
        baseCommitSha: task.baseCommitSha,
        lastFilesChanged: task.lastFilesChanged,
        storyProgress: task.storyProgress,
        lastError: task.lastError,
      });

      if (!decision.shouldTreatAsSuccess) {
        continue;
      }

      if (needsMergeRepairProof) {
        const integrationPolicy = resolveIntegrationPolicy(this.configManager);

        try {
          mergeProofRecovery = await this.probeWorktreeMergeability(task, integrationPolicy.targetBranch, {
            pullLatest: integrationPolicy.pullLatest,
            integrationWorktreeDir: integrationPolicy.integrationWorktreeDir,
            syncTargetBranch: false,
          });
        } catch (error) {
          this.logger.error(
            `Exact worktree mergeability probe failed for soft recovery task ${task.id}: ${error instanceof Error ? error.message : String(error)}`
          );
          continue;
        }

        if (!mergeProofRecovery.alreadyIntegrated && !mergeProofRecovery.mergeable) {
          this.logger.log(`Task ${task.id} soft recovery blocked by exact worktree mergeability probe`);
          continue;
        }
      }

      const updatedAt = Date.now();
      const completedUS = decision.recoverableStoryId && !task.completedUS.includes(decision.recoverableStoryId)
        ? [...task.completedUS, decision.recoverableStoryId]
        : task.completedUS;
      const storyProgress = decision.recoverableStoryId
        ? (task.storyProgress || []).map((story) => story.id === decision.recoverableStoryId
          ? {
              ...story,
              status: 'passed' as const,
              lastError: undefined,
              lastEvidence: story.lastEvidence || decision.reason,
              updatedAt,
              history: [
                ...(story.history || []),
                {
                  attempt: story.attempts,
                  status: 'passed' as const,
                  message: `Soft-recovered for finalization: ${decision.reason}`,
                  evidence: story.lastEvidence || decision.reason,
                  updatedAt,
                },
              ],
            }
          : story)
        : task.storyProgress;

      const storyCompletion = evaluateTaskStoryCompletion({
        ...task,
        completedUS,
        storyProgress,
      });
      if (!storyCompletion.allStoriesPassed) {
        const message = formatStoryCompletionInvariantMessage(task.id, 'finalize', storyCompletion);
        await this.stateManager.updateTask(task.id, {
          status: 'failed',
          completedUS,
          storyProgress,
          currentUS: undefined,
          pid: undefined,
          endTime: updatedAt,
          leaseOwner: undefined,
          leaseHeartbeatAt: undefined,
          leaseExpiresAt: undefined,
          ...buildStoryCompletionInvariantFailureUpdates(message, updatedAt),
        });
        appendTaskEvent(task, {
          type: 'story_completion_invariant_failed',
          status: 'failed',
          message,
          data: {
            phase: 'finalize',
            recoveredStoryId: decision.recoverableStoryId,
            incompleteStories: storyCompletion.incompleteStories,
          },
        });
        this.logger.error(`Refused soft recovery for incomplete task ${task.id}: ${message}`);
        continue;
      }

      await this.stateManager.updateTask(task.id, {
        status: 'ready_to_finalize',
        completedUS,
        storyProgress,
        currentUS: undefined,
        pid: undefined,
        endTime: undefined,
        lastError: undefined,
        lastErrorSignature: undefined,
        lastErrorHadObjectiveProgress: undefined,
        mergeError: undefined,
        mergeConflictFiles: undefined,
        mergeConflictPhase: undefined,
        mergeConflictAt: undefined,
        integrationBranch: mergeProofRecovery?.integrationBranch ?? task.integrationBranch,
        integrationWorktree: mergeProofRecovery?.integrationWorktree ?? task.integrationWorktree,
        mergeRepairDisplayStatus: mergeProofRecovery
          ? deriveMergeRepairDisplayStatus(mergeProofRecovery)
          : task.mergeRepairDisplayStatus,
        mergeRepairProof: mergeProofRecovery
          ? buildMergeRepairProof(mergeProofRecovery)
          : task.mergeRepairProof,
        postFinalizeMergeProbeRequired: needsMergeRepairProof
          ? true
          : task.postFinalizeMergeProbeRequired,
      });
      appendTaskEvent(task, {
        type: 'task_recovered_soft_failed',
        status: 'ready_to_finalize',
        message: decision.reason,
        data: {
          recoveredStoryId: decision.recoverableStoryId,
          exactProbeMessage: mergeProofRecovery?.message,
        },
      });
      this.logger.log(`Task ${task.id} recovered into ready_to_finalize (${decision.reason})`);
    }
  }

  async recoverFailedWorkerMergeRepairTasks(): Promise<void> {
    const repairConfig = resolveFinalizeRepairConfig(this.configManager);
    const integrationPolicy = resolveIntegrationPolicy(this.configManager);
    const failedTasks = (await this.stateManager.listTasks('failed'))
      .slice()
      .sort((a: Task, b: Task) => a.startTime - b.startTime);

    for (const task of failedTasks) {
      if (!requiresMergeRepairProof(task)) {
        continue;
      }

      if (resolveRetryableTransientFailure(task) && task.repairContext?.mode === 'merge') {
        continue;
      }

      const repairStoryId = selectRecoveryStoryId(task);
      if (!repairStoryId) {
        continue;
      }
      const repairStory = task.storyProgress?.find((story) => story.id === repairStoryId);
      if (task.repairContext?.mode !== 'merge' && repairStory?.status !== 'needs_repair') {
        continue;
      }

      let mergeProbeResult: Awaited<ReturnType<typeof probeTaskWorktreeMergeability>>;

      try {
        mergeProbeResult = await this.probeWorktreeMergeability(task, integrationPolicy.targetBranch, {
          pullLatest: integrationPolicy.pullLatest,
          integrationWorktreeDir: integrationPolicy.integrationWorktreeDir,
          syncTargetBranch: false,
        });
      } catch (error) {
        this.logger.error(
          `Exact worktree mergeability probe failed for worker merge-repair task ${task.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      const now = Date.now();
      const firstRecoveryObservation = task.mergeRepairRecoveryStartedAt === undefined
        && task.mergeRepairRecoveryTotalRequeues === undefined
        && task.mergeRepairRecoveryConsecutiveNoProgress === undefined;
      const startedAt = task.mergeRepairRecoveryStartedAt
        ?? (firstRecoveryObservation
          ? now
          : task.repairContext?.createdAt
            ?? task.lastErrorObservedAt
            ?? now);
      const deadlineAt = task.mergeRepairRecoveryDeadlineAt
        ?? startedAt + (repairConfig.repairDeadlineSeconds * 1000);
      const currentObservationSignature = buildMergeRepairObservationSignature(mergeProbeResult);
      const previousSignature = task.mergeRepairRecoveryLastConflictSignature
        || buildMergeConflictSignature(task.mergeConflictFiles)
        || normalizeErrorSignature(task.mergeError || task.lastError)
        || 'merge_conflict';
      const currentSignature = buildMergeConflictSignature(mergeProbeResult.conflictFiles)
        || normalizeErrorSignature(mergeProbeResult.message)
        || 'merge_conflict';
      const previousObservationSignature = task.mergeRepairRecoveryLastObservationSignature;
      const resolvedPendingMergeProof = isResolvedPendingMergeProof(mergeProbeResult);
      const hasProgress = !firstRecoveryObservation && (
        resolvedPendingMergeProof
        || (previousObservationSignature
          ? previousObservationSignature !== currentObservationSignature
          : currentSignature !== previousSignature)
      );
      const nextConsecutiveNoProgress = firstRecoveryObservation
        ? 0
        : hasProgress
          ? 0
          : (task.mergeRepairRecoveryConsecutiveNoProgress ?? 0) + 1;
      const nextProgressReason = firstRecoveryObservation
        ? 'Initialized worker merge-repair recovery tracking'
        : hasProgress
          ? resolvedPendingMergeProof
            ? 'Observed resolved pending merge awaiting finalizer commit'
            : 'Merge-repair worktree observation changed'
          : task.mergeRepairRecoveryLastProgressReason;
      const commonUpdates: Partial<Task> = {
        lastError: mergeProbeResult.message,
        lastErrorKind: 'merge_conflict',
        lastErrorClass: 'merge_conflict',
        lastErrorRetryable: true,
        lastErrorObservedAt: now,
        lastErrorSignature: currentSignature,
        lastErrorHadObjectiveProgress: false,
        mergeError: mergeProbeResult.mergeable ? undefined : mergeProbeResult.message,
        mergeConflictFiles: mergeProbeResult.mergeable ? undefined : mergeProbeResult.conflictFiles,
        mergeConflictPhase: mergeProbeResult.mergeable ? undefined : mergeProbeResult.failurePhase,
        mergeConflictAt: mergeProbeResult.mergeable ? undefined : now,
        integrationBranch: mergeProbeResult.integrationBranch,
        integrationWorktree: mergeProbeResult.integrationWorktree,
        postFinalizeMergeProbeRequired: true,
        ...captureObservedTaskSurface(task),
        mergeRepairRecoveryStartedAt: startedAt,
        mergeRepairRecoveryDeadlineAt: deadlineAt,
        mergeRepairRecoveryConsecutiveNoProgress: nextConsecutiveNoProgress,
        mergeRepairRecoveryLastObservationSignature: currentObservationSignature,
        mergeRepairRecoveryLastConflictSignature: currentSignature,
        mergeRepairRecoveryLastProbeMessage: mergeProbeResult.message,
        mergeRepairRecoveryLastProgressReason: nextProgressReason,
        mergeRepairDisplayStatus: deriveMergeRepairDisplayStatus(mergeProbeResult),
        mergeRepairProof: buildMergeRepairProof(mergeProbeResult, now),
        autoRecoveryKind: 'merge_repair',
        autoRecoveryHardCap: repairConfig.repairHardCap,
      };

      if (mergeProbeResult.alreadyIntegrated || mergeProbeResult.mergeable) {
        const recoveryMessage = mergeProbeResult.alreadyIntegrated
          ? `Recovered merge repair because ${resolveTaskBranchName(task)} is already integrated in ${mergeProbeResult.integrationBranch}`
          : `Recovered merge repair because exact worktree mergeability probe passed against ${mergeProbeResult.integrationBranch}`;
        const completedUS = task.completedUS.includes(repairStoryId)
          ? task.completedUS
          : [...task.completedUS, repairStoryId];
        const storyProgress = (task.storyProgress || []).map((story) => story.id === repairStoryId
          ? {
              ...story,
              status: 'passed' as const,
              lastError: undefined,
              updatedAt: now,
              history: [
                ...(story.history || []),
                {
                  attempt: story.attempts,
                  status: 'passed' as const,
                  message: recoveryMessage,
                  updatedAt: now,
                },
              ],
            }
          : story);

        const storyCompletion = evaluateTaskStoryCompletion({
          ...task,
          completedUS,
          storyProgress,
        });
        if (!storyCompletion.allStoriesPassed) {
          const message = formatStoryCompletionInvariantMessage(task.id, 'finalize', storyCompletion);
          await this.stateManager.updateTask(task.id, {
            ...commonUpdates,
            status: 'failed',
            completedUS,
            storyProgress,
            currentUS: undefined,
            pid: undefined,
            endTime: now,
            leaseOwner: undefined,
            leaseHeartbeatAt: undefined,
            leaseExpiresAt: undefined,
            repairContext: undefined,
            autoRecoveryKind: undefined,
            autoRecoveryNextEligibleAt: undefined,
            autoRecoveryStoppedAt: now,
            autoRecoveryStopReason: 'story_incomplete',
            autoRecoveryLastReason: message,
            mergeRepairRecoveryStoppedAt: now,
            mergeRepairRecoveryStopReason: 'story_incomplete',
            mergeRepairDisplayStatus: undefined,
            mergeRepairProof: undefined,
            postFinalizeMergeProbeRequired: undefined,
            ...buildStoryCompletionInvariantFailureUpdates(message, now),
          });
          appendTaskEvent(task, {
            type: 'story_completion_invariant_failed',
            status: 'failed',
            storyId: repairStoryId,
            message,
            data: {
              phase: 'finalize',
              exactProbeMessage: mergeProbeResult.message,
              incompleteStories: storyCompletion.incompleteStories,
            },
          });
          this.logger.error(`Refused worker merge-repair recovery for incomplete task ${task.id}: ${message}`);
          continue;
        }

        await this.stateManager.updateTask(task.id, {
          ...commonUpdates,
          status: 'ready_to_finalize',
          completedUS,
          storyProgress,
          currentUS: undefined,
          pid: undefined,
          endTime: undefined,
          leaseOwner: undefined,
          leaseHeartbeatAt: undefined,
          leaseExpiresAt: undefined,
          lastError: undefined,
          lastErrorKind: undefined,
          lastErrorClass: undefined,
          lastErrorRetryable: undefined,
          lastErrorObservedAt: undefined,
          lastErrorSignature: undefined,
          lastErrorHadObjectiveProgress: undefined,
          mergeError: undefined,
          mergeConflictFiles: undefined,
          mergeConflictPhase: undefined,
          mergeConflictAt: undefined,
          repairContext: undefined,
          autoRecoveryKind: undefined,
          autoRecoveryNextEligibleAt: undefined,
          autoRecoveryStoppedAt: undefined,
          autoRecoveryStopReason: undefined,
          autoRecoveryLastReason: recoveryMessage,
          mergeRepairRecoveryStoppedAt: undefined,
          mergeRepairRecoveryStopReason: undefined,
        });
        appendTaskEvent(task, {
          type: 'merge_repair_recovered',
          status: 'ready_to_finalize',
          storyId: repairStoryId,
          message: recoveryMessage,
          data: {
            exactProbeMessage: mergeProbeResult.message,
            conflictFiles: mergeProbeResult.conflictFiles,
          },
        });
        this.logger.log(`Task ${task.id} recovered into ready_to_finalize after worker merge repair`);
        continue;
      }

      if (task.mergeRepairRecoveryStoppedAt) {
        continue;
      }

      const currentTotalRequeues = task.mergeRepairRecoveryTotalRequeues ?? 0;
      const currentAutoRequeues = task.autoRecoveryTotalRequeues ?? 0;
      const integrationSyncConflict = mergeProbeResult.failurePhase === 'integration_sync';
      let stopReason: string | undefined;
      let stopMessage: string | undefined;

      if (integrationSyncConflict) {
        stopReason = 'merge_repair_integration_sync_conflict';
        stopMessage = 'Integration branch sync conflict must be resolved before task merge repair can continue';
      } else if (deadlineAt <= now) {
        stopReason = 'merge_repair_deadline_exhausted';
        stopMessage = 'Worker merge repair deadline exhausted';
      } else if (currentTotalRequeues >= repairConfig.repairHardCap || currentAutoRequeues >= repairConfig.repairHardCap) {
        stopReason = 'merge_repair_hard_cap_reached';
        stopMessage = 'Worker merge repair hard cap reached';
      } else if (
        !mergeProbeResult.mergeable
        && !mergeProbeResult.alreadyIntegrated
        && !resolvedPendingMergeProof
        && nextConsecutiveNoProgress >= repairConfig.maxNoProgressRepairRounds
      ) {
        stopReason = 'merge_repair_same_unresolved_state';
        stopMessage = 'Worker merge repair kept the same unresolved worktree state';
      }

      if (stopReason && stopMessage) {
        await this.stateManager.updateTask(task.id, {
          ...commonUpdates,
          mergeRepairDisplayStatus: 'stopped',
          mergeRepairRecoveryStoppedAt: now,
          mergeRepairRecoveryStopReason: stopReason,
          autoRecoveryStoppedAt: now,
          autoRecoveryStopReason: stopReason,
          autoRecoveryLastReason: stopMessage,
        });
        appendTaskEvent(task, {
          type: 'merge_repair_stopped',
          status: 'failed',
          storyId: repairStoryId,
          message: stopMessage,
          data: {
            stopReason,
            failurePhase: mergeProbeResult.failurePhase,
            exactProbeMessage: mergeProbeResult.message,
            conflictFiles: mergeProbeResult.conflictFiles,
            consecutiveNoProgress: nextConsecutiveNoProgress,
            totalRequeues: currentTotalRequeues,
            deadlineAt,
          },
        });
        this.logger.log(`Task ${task.id} stopped worker merge-repair recovery (${stopMessage})`);
        continue;
      }

      const repairMessage = buildMergeRepairReason({
        ...task,
        mergeError: mergeProbeResult.message,
        mergeConflictFiles: mergeProbeResult.conflictFiles,
        mergeConflictPhase: mergeProbeResult.failurePhase,
        integrationBranch: mergeProbeResult.integrationBranch,
      });
      const resetState = resetSingleStory(task, repairStoryId, {
        status: 'needs_repair',
        updatedAt: now,
        message: repairMessage,
      });
      const nextMergeRepairRequeues = currentTotalRequeues + 1;
      const nextAutoRecoveryRequeues = currentAutoRequeues + 1;

      await this.stateManager.updateTask(task.id, {
        ...commonUpdates,
        status: 'pending',
        completedUS: resetState.completedUS,
        storyProgress: resetState.storyProgress,
        currentUS: undefined,
        pid: undefined,
        endTime: undefined,
        leaseOwner: undefined,
        leaseHeartbeatAt: undefined,
        leaseExpiresAt: undefined,
        repairContext: buildTaskRepairContext({
          mode: 'merge',
          storyId: repairStoryId,
          reason: repairMessage,
          createdAt: now,
        }),
        mergeRepairAttempts: (task.mergeRepairAttempts ?? 0) + 1,
        mergeRepairRecoveryTotalRequeues: nextMergeRepairRequeues,
        mergeRepairRecoveryStoppedAt: undefined,
        mergeRepairRecoveryStopReason: undefined,
        mergeRepairDisplayStatus: 'requeued',
        autoRecoveryTotalRequeues: nextAutoRecoveryRequeues,
        autoRecoveryLastRequeuedAt: now,
        autoRecoveryNextEligibleAt: undefined,
        autoRecoveryStoppedAt: undefined,
        autoRecoveryStopReason: undefined,
        autoRecoveryLastReason: nextProgressReason || mergeProbeResult.message,
      });
      appendTaskEvent(task, {
        type: 'merge_repair_auto_requeued',
        status: 'pending',
        storyId: repairStoryId,
        message: `Requeued ${repairStoryId} for bounded merge repair`,
        data: {
          exactProbeMessage: mergeProbeResult.message,
          conflictFiles: mergeProbeResult.conflictFiles,
          failurePhase: mergeProbeResult.failurePhase,
          consecutiveNoProgress: nextConsecutiveNoProgress,
          totalRequeues: nextMergeRepairRequeues,
          deadlineAt,
          progressReason: nextProgressReason,
        },
      });
      this.logger.log(`Task ${task.id} returned to pending merge repair for ${repairStoryId}`);
    }
  }

  async recoverFailedTransientTasks(): Promise<void> {
    const recoveryConfig = resolveTransientRecoveryConfig(this.configManager);
    const failedTasks = (await this.stateManager.listTasks('failed'))
      .slice()
      .sort((a: Task, b: Task) => a.startTime - b.startTime);

    for (const task of failedTasks) {
      const transientFailure = resolveRetryableTransientFailure(task);
      if (!transientFailure) {
        continue;
      }

      const repairStoryId = selectRecoveryStoryId(task);
      if (!repairStoryId) {
        continue;
      }

      const now = Date.now();
      const startedAt = task.transientRecoveryStartedAt
        ?? task.lastErrorObservedAt
        ?? now;
      const deadlineAt = task.transientRecoveryDeadlineAt
        ?? startedAt + (recoveryConfig.transientRecoveryDeadlineSeconds * 1000);
      const firstRecoveryObservation = task.transientRecoveryStartedAt === undefined
        && task.transientRecoveryTotalRequeues === undefined
        && task.transientRecoveryConsecutiveSameSignature === undefined;
      const previousSignature = task.transientRecoveryLastFailureSignature
        || task.lastErrorSignature
        || transientFailure.signature;
      const nextConsecutiveSameSignature = firstRecoveryObservation
        ? 1
        : previousSignature === transientFailure.signature
          ? (task.transientRecoveryConsecutiveSameSignature ?? 0) + 1
          : 1;
      const currentTotalRequeues = task.transientRecoveryTotalRequeues ?? 0;
      const currentAutoRequeues = task.autoRecoveryTotalRequeues ?? 0;
      const commonUpdates: Partial<Task> = {
        lastErrorKind: transientFailure.kind,
        lastErrorClass: transientFailure.class,
        lastErrorRetryable: true,
        lastErrorSignature: transientFailure.signature,
        lastErrorHadObjectiveProgress: task.lastErrorHadObjectiveProgress ?? false,
        transientRecoveryStartedAt: startedAt,
        transientRecoveryDeadlineAt: deadlineAt,
        transientRecoveryConsecutiveSameSignature: nextConsecutiveSameSignature,
        transientRecoveryLastFailureKind: transientFailure.kind,
        transientRecoveryLastFailureClass: transientFailure.class,
        transientRecoveryLastFailureSignature: transientFailure.signature,
        transientRecoveryLastHadObjectiveProgress: task.lastErrorHadObjectiveProgress ?? false,
        autoRecoveryKind: 'transient',
        autoRecoveryHardCap: recoveryConfig.autoRecoveryHardCap,
      };

      const needsBackfill = task.lastErrorKind !== commonUpdates.lastErrorKind
        || task.lastErrorClass !== commonUpdates.lastErrorClass
        || task.lastErrorRetryable !== true
        || task.lastErrorSignature !== commonUpdates.lastErrorSignature
        || task.lastErrorHadObjectiveProgress === undefined;

      let stopReason: string | undefined;
      let stopMessage: string | undefined;
      if (deadlineAt <= now) {
        stopReason = 'transient_deadline_exhausted';
        stopMessage = 'Transient recovery deadline exhausted';
      } else if (currentTotalRequeues >= recoveryConfig.maxTransientRecoveryRequeues) {
        stopReason = 'transient_budget_exhausted';
        stopMessage = 'Transient recovery requeue budget exhausted';
      } else if (currentAutoRequeues >= recoveryConfig.autoRecoveryHardCap) {
        stopReason = 'auto_recovery_hard_cap_reached';
        stopMessage = 'Auto-recovery hard cap reached';
      } else if (nextConsecutiveSameSignature >= recoveryConfig.maxTransientRecoverySameSignature) {
        stopReason = 'transient_same_signature_no_progress';
        stopMessage = 'Transient recovery saw the same retryable failure signature repeatedly';
      }

      if (stopReason && !task.transientRecoveryStoppedAt) {
        await this.stateManager.updateTask(task.id, {
          ...commonUpdates,
          transientRecoveryStoppedAt: now,
          transientRecoveryStopReason: stopReason,
          autoRecoveryStoppedAt: now,
          autoRecoveryStopReason: stopReason,
          autoRecoveryLastReason: stopMessage,
        });
        appendTaskEvent(task, {
          type: 'transient_recovery_stopped',
          status: 'failed',
          storyId: repairStoryId,
          message: stopMessage,
          data: {
            stopReason,
            failureKind: transientFailure.kind,
            failureClass: transientFailure.class,
            failureSignature: transientFailure.signature,
            consecutiveSameSignature: nextConsecutiveSameSignature,
            totalRequeues: currentTotalRequeues,
            deadlineAt,
          },
        });
        this.logger.log(`Task ${task.id} stopped transient auto-recovery (${stopMessage})`);
        continue;
      }

      if (task.transientRecoveryStoppedAt) {
        continue;
      }

      if (!task.transientRecoveryNextEligibleAt) {
        const delayMs = resolveTransientRecoveryDelayMs(currentTotalRequeues + 1, recoveryConfig);
        const nextEligibleAt = now + delayMs;
        await this.stateManager.updateTask(task.id, {
          ...commonUpdates,
          transientRecoveryLastDelayMs: delayMs,
          transientRecoveryNextEligibleAt: nextEligibleAt,
          transientRecoveryStoppedAt: undefined,
          transientRecoveryStopReason: undefined,
          autoRecoveryNextEligibleAt: nextEligibleAt,
          autoRecoveryStoppedAt: undefined,
          autoRecoveryStopReason: undefined,
          autoRecoveryLastReason: `Scheduled transient auto-recovery for ${transientFailure.kind}`,
        });
        appendTaskEvent(task, {
          type: 'transient_recovery_scheduled',
          status: 'failed',
          storyId: repairStoryId,
          message: `Scheduled transient auto-recovery after ${transientFailure.kind}`,
          data: {
            failureKind: transientFailure.kind,
            failureClass: transientFailure.class,
            failureSignature: transientFailure.signature,
            delayMs,
            nextEligibleAt,
            needsBackfill,
          },
        });
        this.logger.log(`Task ${task.id} scheduled transient auto-recovery in ${delayMs}ms`);
        continue;
      }

      if (task.transientRecoveryNextEligibleAt > now) {
        if (needsBackfill) {
          await this.stateManager.updateTask(task.id, commonUpdates);
        }
        continue;
      }

      const resetMessage = `Automatically requeued after retryable ${transientFailure.kind} failure`;
      const resetState = resetSingleStory(task, repairStoryId, {
        status: 'pending',
        updatedAt: now,
        message: resetMessage,
      });
      const nextTransientRequeues = currentTotalRequeues + 1;
      const nextAutoRecoveryRequeues = currentAutoRequeues + 1;

      await this.stateManager.updateTask(task.id, {
        ...commonUpdates,
        status: 'pending',
        completedUS: resetState.completedUS,
        storyProgress: resetState.storyProgress,
        currentUS: undefined,
        pid: undefined,
        endTime: undefined,
        leaseOwner: undefined,
        leaseHeartbeatAt: undefined,
        leaseExpiresAt: undefined,
        loopCount: 0,
        consecutiveNoProgress: 0,
        consecutiveErrors: 0,
        lastProgressTime: now,
        transientRetryCount: 0,
        transientRetryBudget: undefined,
        transientRetryLastDelayMs: undefined,
        transientRecoveryTotalRequeues: nextTransientRequeues,
        transientRecoveryNextEligibleAt: undefined,
        transientRecoveryStoppedAt: undefined,
        transientRecoveryStopReason: undefined,
        transientRecoveryLastRequeuedStoryId: repairStoryId,
        autoRecoveryTotalRequeues: nextAutoRecoveryRequeues,
        autoRecoveryLastRequeuedAt: now,
        autoRecoveryNextEligibleAt: undefined,
        autoRecoveryStoppedAt: undefined,
        autoRecoveryStopReason: undefined,
        autoRecoveryLastReason: resetMessage,
      });
      appendTaskEvent(task, {
        type: 'transient_recovery_auto_requeued',
        status: 'pending',
        storyId: repairStoryId,
        message: resetMessage,
        data: {
          failureKind: transientFailure.kind,
          failureClass: transientFailure.class,
          failureSignature: transientFailure.signature,
          totalRequeues: nextTransientRequeues,
        },
      });
      this.logger.log(`Task ${task.id} returned to pending after transient auto-recovery`);
    }
  }

  async recoverStagnantTasks(): Promise<void> {
    const recoveryConfig = resolveTransientRecoveryConfig(this.configManager);
    const stagnantTasks = (await this.stateManager.listTasks('stagnant'))
      .slice()
      .sort((a: Task, b: Task) => a.startTime - b.startTime);

    for (const task of stagnantTasks) {
      const now = Date.now();
      const currentAutoRequeues = task.autoRecoveryTotalRequeues ?? 0;
      const stopReason = 'stagnation_auto_recovery_hard_cap_reached';
      const stopMessage = 'Stagnation auto-recovery hard cap reached';

      if (currentAutoRequeues >= recoveryConfig.autoRecoveryHardCap) {
        if (task.autoRecoveryStopReason === stopReason && task.autoRecoveryStoppedAt) {
          continue;
        }

        await this.stateManager.updateTask(task.id, {
          autoRecoveryKind: 'stagnant',
          autoRecoveryHardCap: recoveryConfig.autoRecoveryHardCap,
          autoRecoveryStoppedAt: now,
          autoRecoveryStopReason: stopReason,
          autoRecoveryLastReason: stopMessage,
        });
        appendTaskEvent(task, {
          type: 'stagnant_recovery_stopped',
          status: 'stagnant',
          storyId: selectStagnantRecoveryStoryId(task),
          message: stopMessage,
          data: {
            stopReason,
            totalRequeues: currentAutoRequeues,
            hardCap: recoveryConfig.autoRecoveryHardCap,
          },
        });
        this.logger.log(`Task ${task.id} stopped stagnation auto-recovery (${stopMessage})`);
        continue;
      }

      const repairStoryId = selectStagnantRecoveryStoryId(task);
      const resetMessage = task.repairContext?.mode === 'merge'
        ? 'Automatically requeued merge repair after stagnation'
        : 'Automatically requeued after stagnation timeout';
      const storyStatus = task.repairContext?.mode === 'merge' ? 'needs_repair' : 'pending';
      const nextAutoRequeues = currentAutoRequeues + 1;
      const refreshedMergeRepairContext = task.repairContext?.mode === 'merge'
        ? buildTaskRepairContext({
            mode: 'merge',
            storyId: repairStoryId ?? task.repairContext.storyId,
            reason: buildMergeRepairReason(task),
            createdAt: now,
          })
        : undefined;
      const resetState = repairStoryId
        ? resetSingleStory(task, repairStoryId, {
            status: storyStatus,
            updatedAt: now,
            message: resetMessage,
          })
        : {
            completedUS: task.completedUS,
            storyProgress: task.storyProgress,
          };

      await this.stateManager.updateTask(task.id, {
        status: 'pending',
        completedUS: resetState.completedUS,
        storyProgress: resetState.storyProgress,
        currentUS: undefined,
        pid: undefined,
        endTime: undefined,
        leaseOwner: undefined,
        leaseHeartbeatAt: undefined,
        leaseExpiresAt: undefined,
        loopCount: 0,
        consecutiveNoProgress: 0,
        consecutiveErrors: 0,
        lastProgressTime: now,
        lastError: undefined,
        lastErrorKind: undefined,
        lastErrorClass: undefined,
        lastErrorRetryable: undefined,
        lastErrorObservedAt: undefined,
        lastErrorSignature: undefined,
        lastErrorHadObjectiveProgress: undefined,
        transientRetryCount: 0,
        transientRetryBudget: undefined,
        transientRetryLastDelayMs: undefined,
        autoRecoveryKind: 'stagnant',
        autoRecoveryTotalRequeues: nextAutoRequeues,
        autoRecoveryHardCap: recoveryConfig.autoRecoveryHardCap,
        autoRecoveryLastRequeuedAt: now,
        autoRecoveryNextEligibleAt: undefined,
        autoRecoveryStoppedAt: undefined,
        autoRecoveryStopReason: undefined,
        autoRecoveryLastReason: resetMessage,
        repairContext: refreshedMergeRepairContext ?? task.repairContext,
        ...(task.repairContext?.mode === 'merge'
          ? {
              postFinalizeMergeProbeRequired: true,
              ...captureObservedTaskSurface(task),
            }
          : {}),
        mergeRepairRecoveryStartedAt: undefined,
        mergeRepairRecoveryDeadlineAt: undefined,
        mergeRepairRecoveryTotalRequeues: undefined,
        mergeRepairRecoveryConsecutiveNoProgress: undefined,
        mergeRepairRecoveryLastConflictSignature: undefined,
        mergeRepairRecoveryLastProbeMessage: undefined,
        mergeRepairRecoveryLastProgressReason: undefined,
        mergeRepairRecoveryStoppedAt: undefined,
        mergeRepairRecoveryStopReason: undefined,
      });
      appendTaskEvent(task, {
        type: 'stagnant_recovery_auto_requeued',
        status: 'pending',
        storyId: repairStoryId,
        message: resetMessage,
        data: {
          repairMode: task.repairContext?.mode,
          totalRequeues: nextAutoRequeues,
          hardCap: recoveryConfig.autoRecoveryHardCap,
        },
      });
      this.logger.log(`Task ${task.id} returned to pending after stagnation auto-recovery`);
    }
  }

  async recoverFailedFinalizeTasks(): Promise<void> {
    const repairConfig = resolveFinalizeRepairConfig(this.configManager);
    const integrationPolicy = resolveIntegrationPolicy(this.configManager);
    const targetBranch = resolveMergeTargetBranch(this.configManager.get('merge.targetBranch'));
    const failedFinalizeTasks = (await this.stateManager.listTasks('failed_finalize'))
      .slice()
      .sort((a: Task, b: Task) => a.startTime - b.startTime);

    for (const task of failedFinalizeTasks) {
      let activeTask = task;
      const mergeConflict = hasMergeConflict(activeTask);

      if (
        !activeTask.finalizeRepairStartedAt
        || !activeTask.finalizeRepairDeadlineAt
        || !activeTask.finalizeRepairLastFailureSnapshot
      ) {
        const backfilledRepairState = evaluateFinalizeRepairFailure({
          ...activeTask,
          lastError: activeTask.lastError || activeTask.mergeError,
          mergeError: activeTask.mergeError || activeTask.lastError,
        }, repairConfig);
        const normalizedLastProgressAt = activeTask.finalizeRepairLastProgressAt
          ?? backfilledRepairState.lastProgressAt;
        const normalizedLastProgressReason = activeTask.finalizeRepairLastProgressReason
          ?? backfilledRepairState.lastProgressReason;
        const normalizedConsecutiveNoProgress = activeTask.finalizeRepairConsecutiveNoProgress
          ?? backfilledRepairState.consecutiveNoProgress;
        await this.stateManager.updateTask(activeTask.id, {
          finalizeRepairStartedAt: backfilledRepairState.startedAt,
          finalizeRepairDeadlineAt: backfilledRepairState.deadlineAt,
          finalizeRepairLastFailureSnapshot: backfilledRepairState.snapshot,
          finalizeRepairLastProgressAt: normalizedLastProgressAt,
          finalizeRepairLastProgressReason: normalizedLastProgressReason,
          finalizeRepairConsecutiveNoProgress: normalizedConsecutiveNoProgress,
          finalizeRepairTotalRequeues: activeTask.finalizeRepairTotalRequeues ?? 0,
        });
        appendTaskEvent(activeTask, {
          type: 'finalize_repair_state_backfilled',
          status: 'failed_finalize',
          message: 'Backfilled finalize repair state for legacy failed_finalize task',
          data: {
            repairPolicy: repairConfig.repairPolicy,
            consecutiveNoProgress: normalizedConsecutiveNoProgress,
            deadlineAt: backfilledRepairState.deadlineAt,
            progressReason: normalizedLastProgressReason,
          },
        });
        activeTask = {
          ...activeTask,
          finalizeRepairStartedAt: backfilledRepairState.startedAt,
          finalizeRepairDeadlineAt: backfilledRepairState.deadlineAt,
          finalizeRepairLastFailureSnapshot: backfilledRepairState.snapshot,
          finalizeRepairLastProgressAt: normalizedLastProgressAt,
          finalizeRepairLastProgressReason: normalizedLastProgressReason,
          finalizeRepairConsecutiveNoProgress: normalizedConsecutiveNoProgress,
          finalizeRepairTotalRequeues: activeTask.finalizeRepairTotalRequeues ?? 0,
        };
      }

      const repairStoryId = selectFinalizeRepairStoryId(activeTask, mergeConflict);

      let mergeProbeResult: Awaited<ReturnType<typeof probeTaskWorktreeMergeability>> | undefined;

      if (mergeConflict) {
        try {
          mergeProbeResult = await this.probeWorktreeMergeability(activeTask, targetBranch, {
            pullLatest: integrationPolicy.pullLatest,
            integrationWorktreeDir: integrationPolicy.integrationWorktreeDir,
            syncTargetBranch: false,
          });
        } catch (error) {
          this.logger.error(
            `Exact mergeability probe failed for ${activeTask.id}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      if (mergeConflict && mergeProbeResult) {
        const shouldRefreshConflictState = mergeProbeResult.alreadyIntegrated
          || mergeProbeResult.mergeable
          || mergeProbeResult.message !== activeTask.mergeError
          || JSON.stringify(mergeProbeResult.conflictFiles || []) !== JSON.stringify(activeTask.mergeConflictFiles || [])
          || mergeProbeResult.integrationBranch !== activeTask.integrationBranch
          || mergeProbeResult.integrationWorktree !== activeTask.integrationWorktree;

        if (shouldRefreshConflictState) {
          const refreshedConflictState = {
            mergeError: mergeProbeResult.mergeable ? undefined : mergeProbeResult.message,
            mergeConflictFiles: mergeProbeResult.mergeable ? undefined : mergeProbeResult.conflictFiles,
            mergeConflictAt: mergeProbeResult.mergeable ? undefined : Date.now(),
            integrationBranch: mergeProbeResult.integrationBranch,
            integrationWorktree: mergeProbeResult.integrationWorktree,
            mergeRepairDisplayStatus: deriveMergeRepairDisplayStatus(mergeProbeResult),
            mergeRepairProof: buildMergeRepairProof(mergeProbeResult),
          };
          await this.stateManager.updateTask(activeTask.id, refreshedConflictState);
          activeTask = {
            ...activeTask,
            ...refreshedConflictState,
          };
        }
      }

      if (
        mergeConflict
        && (
          mergeProbeResult?.alreadyIntegrated
          || mergeProbeResult?.mergeable
          || this.detectAlreadyIntegratedTask(activeTask, targetBranch)
        )
      ) {
        const updatedAt = Date.now();
        const completedUS = repairStoryId && !activeTask.completedUS.includes(repairStoryId)
          ? [...activeTask.completedUS, repairStoryId]
          : activeTask.completedUS;
        const recoveryMessage = mergeProbeResult?.alreadyIntegrated
          ? `Recovered finalize conflict because ${resolveTaskBranchName(activeTask)} is already integrated in ${resolveTaskIntegrationBranch(activeTask, targetBranch)}`
          : mergeProbeResult?.mergeable
            ? isResolvedPendingMergeProof(mergeProbeResult)
              ? `Recovered finalize conflict because the task worktree is a resolved pending merge awaiting finalizer commit against ${resolveTaskIntegrationBranch(activeTask, targetBranch)}`
              : `Recovered finalize conflict because exact worktree mergeability probe passed against ${resolveTaskIntegrationBranch(activeTask, targetBranch)}`
            : `Recovered finalize conflict because ${resolveTaskBranchName(activeTask)} is already integrated in ${resolveTaskIntegrationBranch(activeTask, targetBranch)}`;
        const storyProgress = repairStoryId
          ? (activeTask.storyProgress || []).map((story) => story.id === repairStoryId
            ? {
                ...story,
                status: 'passed' as const,
                lastError: undefined,
                updatedAt,
                history: [
                  ...(story.history || []),
                  {
                    attempt: story.attempts,
                    status: 'passed' as const,
                    message: recoveryMessage,
                    updatedAt,
                  },
                ],
              }
            : story)
          : task.storyProgress;

        const storyCompletion = evaluateTaskStoryCompletion({
          ...activeTask,
          completedUS,
          storyProgress,
        });
        if (!storyCompletion.allStoriesPassed) {
          const message = formatStoryCompletionInvariantMessage(activeTask.id, 'finalize', storyCompletion);
          await this.stateManager.updateTask(task.id, {
            status: 'failed',
            completedUS,
            storyProgress,
            currentUS: undefined,
            pid: undefined,
            endTime: updatedAt,
            leaseOwner: undefined,
            leaseHeartbeatAt: undefined,
            leaseExpiresAt: undefined,
            finalizerFailure: undefined,
            repairContext: undefined,
            postFinalizeMergeProbeRequired: undefined,
            finalizeRepairStartedAt: undefined,
            finalizeRepairDeadlineAt: undefined,
            finalizeRepairLastFailureSnapshot: undefined,
            finalizeRepairLastProgressAt: undefined,
            finalizeRepairLastProgressReason: undefined,
            finalizeRepairConsecutiveNoProgress: 0,
            finalizeRepairStoppedAt: updatedAt,
            finalizeRepairStopReason: 'story_incomplete',
            mergeRepairDisplayStatus: undefined,
            mergeRepairProof: undefined,
            ...buildStoryCompletionInvariantFailureUpdates(message, updatedAt),
          });
          appendTaskEvent(activeTask, {
            type: 'story_completion_invariant_failed',
            status: 'failed',
            storyId: repairStoryId,
            message,
            data: {
              phase: 'finalize',
              finalizerAttempts: activeTask.finalizerAttempts,
              mergeRepairAttempts: activeTask.mergeRepairAttempts,
              incompleteStories: storyCompletion.incompleteStories,
              exactProbeMessage: mergeProbeResult?.message,
            },
          });
          this.logger.error(`Refused failed-finalize recovery for incomplete task ${activeTask.id}: ${message}`);
          continue;
        }

        await this.stateManager.updateTask(task.id, {
          status: 'ready_to_finalize',
          completedUS,
          storyProgress,
          currentUS: undefined,
          pid: undefined,
          endTime: undefined,
          leaseOwner: undefined,
          leaseHeartbeatAt: undefined,
          leaseExpiresAt: undefined,
          lastError: undefined,
          mergeError: undefined,
          mergeConflictFiles: undefined,
          mergeConflictPhase: undefined,
          mergeConflictAt: undefined,
          finalizerFailure: undefined,
          repairContext: undefined,
          postFinalizeMergeProbeRequired: true,
          finalizeRepairStartedAt: undefined,
          finalizeRepairDeadlineAt: undefined,
          finalizeRepairLastFailureSnapshot: undefined,
          finalizeRepairLastProgressAt: undefined,
          finalizeRepairLastProgressReason: undefined,
          finalizeRepairConsecutiveNoProgress: 0,
          finalizeRepairStoppedAt: undefined,
          finalizeRepairStopReason: undefined,
          mergeRepairDisplayStatus: mergeProbeResult
            ? deriveMergeRepairDisplayStatus(mergeProbeResult)
            : activeTask.mergeRepairDisplayStatus,
          mergeRepairProof: mergeProbeResult
            ? buildMergeRepairProof(mergeProbeResult)
            : activeTask.mergeRepairProof,
        });
        appendTaskEvent(activeTask, {
          type: 'task_recovered_failed_finalize',
          status: 'ready_to_finalize',
          storyId: repairStoryId,
          message: recoveryMessage,
          data: {
            finalizerAttempts: activeTask.finalizerAttempts,
            mergeRepairAttempts: activeTask.mergeRepairAttempts,
            repairPolicy: repairConfig.repairPolicy,
            conflictFiles: activeTask.mergeConflictFiles,
            exactProbeMessage: mergeProbeResult?.message,
          },
        });
        this.logger.log(`Task ${activeTask.id} recovered into ready_to_finalize after mergeability recovery`);
        continue;
      }

      if (!repairStoryId) {
        continue;
      }

      const repairStory = activeTask.storyProgress?.find((story) => story.id === repairStoryId);
      const hasUnrunMergeRepair = Boolean(
        mergeConflict
        && repairStory?.status === 'needs_repair'
        && !activeTask.completedUS.includes(repairStoryId)
      );
      const decision = decideFinalizeRepairRequeue({
        task: activeTask,
        config: repairConfig,
        mergeConflict,
        hasUnrunMergeRepair,
      });

      if (!decision.shouldRequeue) {
        if (decision.stopReason && !activeTask.finalizeRepairStoppedAt) {
          const stoppedAt = Date.now();
          await this.stateManager.updateTask(activeTask.id, {
            finalizeRepairStoppedAt: stoppedAt,
            finalizeRepairStopReason: decision.stopReason,
          });
          appendTaskEvent(activeTask, {
            type: 'finalize_repair_stopped',
            status: 'failed_finalize',
            storyId: repairStoryId,
            message: decision.reason,
            data: {
              repairPolicy: repairConfig.repairPolicy,
              stopReason: decision.stopReason,
              consecutiveNoProgress: activeTask.finalizeRepairConsecutiveNoProgress,
              totalRequeues: activeTask.finalizeRepairTotalRequeues,
              deadlineAt: activeTask.finalizeRepairDeadlineAt,
              conflictFiles: activeTask.mergeConflictFiles,
            },
          });
          this.logger.log(`Task ${activeTask.id} stopped finalize repair recovery (${decision.reason})`);
        }
        continue;
      }

      const updatedAt = Date.now();
      const repairMessage = mergeConflict
        ? buildMergeRepairReason(activeTask)
        : activeTask.lastError || activeTask.mergeError || 'Finalizer failed; repair required';
      const repairContext = buildTaskRepairContext({
        storyId: repairStoryId,
        mode: mergeConflict ? 'merge' : 'finalize',
        reason: repairMessage,
        createdAt: updatedAt,
      });
      const completedUS = activeTask.completedUS.filter((storyId) => storyId !== repairStoryId);
      const storyProgress = (activeTask.storyProgress || []).map((story) => story.id === repairStoryId
        ? {
            ...story,
            status: 'needs_repair' as const,
            attempts: 0,
            lastError: repairMessage,
            updatedAt,
            history: [
              ...(story.history || []),
              {
                attempt: story.attempts,
                status: 'needs_repair' as const,
                message: repairMessage,
                updatedAt,
              },
            ],
          }
        : story);
      const nextMergeRepairAttempts = mergeConflict
        ? (hasUnrunMergeRepair ? (activeTask.mergeRepairAttempts ?? 0) : (activeTask.mergeRepairAttempts ?? 0) + 1)
        : undefined;
      const nextTotalRequeues = repairConfig.repairPolicy === 'progress'
        ? (activeTask.finalizeRepairTotalRequeues ?? 0) + 1
        : activeTask.finalizeRepairTotalRequeues;

        await this.stateManager.updateTask(activeTask.id, {
          status: 'pending',
          completedUS,
        storyProgress,
        currentUS: undefined,
        pid: undefined,
        endTime: undefined,
        repairContext,
          leaseOwner: undefined,
          leaseHeartbeatAt: undefined,
          leaseExpiresAt: undefined,
          postFinalizeMergeProbeRequired: mergeConflict
            ? true
            : activeTask.postFinalizeMergeProbeRequired,
          mergeRepairDisplayStatus: mergeConflict ? 'requeued' : activeTask.mergeRepairDisplayStatus,
          mergeRepairProof: mergeProbeResult
            ? buildMergeRepairProof(mergeProbeResult, updatedAt)
            : activeTask.mergeRepairProof,
          ...(mergeConflict ? { mergeRepairAttempts: nextMergeRepairAttempts } : {}),
          ...(repairConfig.repairPolicy === 'progress'
            ? {
              finalizeRepairTotalRequeues: nextTotalRequeues,
              finalizeRepairStoppedAt: undefined,
              finalizeRepairStopReason: undefined,
            }
          : {}),
      });
      appendTaskEvent(activeTask, {
        type: mergeConflict ? 'merge_repair_started' : 'task_recovered_failed_finalize',
        status: 'pending',
        storyId: repairStoryId,
        message: mergeConflict && hasUnrunMergeRepair
          ? `Requeued unrun merge repair for ${repairStoryId}`
          : mergeConflict
          ? `Returned ${repairStoryId} to merge repair after conflict`
          : `Returned ${repairStoryId} to repair after failed finalizer attempt`,
        data: {
          repairMode: repairContext.mode,
          finalizerAttempts: task.finalizerAttempts,
          mergeRepairAttempts: nextMergeRepairAttempts,
          repairPolicy: repairConfig.repairPolicy,
          repairLimit: repairConfig.maxRepairAttempts,
          maxNoProgressRepairRounds: repairConfig.maxNoProgressRepairRounds,
          repairHardCap: repairConfig.repairHardCap,
          totalRequeues: nextTotalRequeues,
          consecutiveNoProgress: task.finalizeRepairConsecutiveNoProgress,
          deadlineAt: task.finalizeRepairDeadlineAt,
          progressReason: decision.reason,
          conflictFiles: task.mergeConflictFiles,
        },
      });
      this.logger.log(mergeConflict
        ? `Task ${activeTask.id} returned to pending merge repair for ${repairStoryId}`
        : `Task ${activeTask.id} returned to pending repair for ${repairStoryId}`);
    }
  }

  async recoverCompletedConflictTasks(): Promise<void> {
    const integrationPolicy = resolveIntegrationPolicy(this.configManager);
    const targetBranch = resolveMergeTargetBranch(this.configManager.get('merge.targetBranch'));
    const completedConflictTasks = (await this.stateManager.listTasks('completed'))
      .filter((task) => resolveTaskIntegrationStatus(task) === 'blocked_conflict' && hasMergeConflict(task))
      .slice()
      .sort((a: Task, b: Task) => a.startTime - b.startTime);

    for (const task of completedConflictTasks) {
      const integrationLane = resolveTaskIntegrationLane(task, targetBranch);

      await withIntegrationLaneLock(task.repoPath, integrationLane, async () => {
        const latestTask = await this.stateManager.loadTask(task.id);
        if (!latestTask || latestTask.status !== 'completed') {
          return;
        }

        if (resolveTaskIntegrationStatus(latestTask) !== 'blocked_conflict' || !hasMergeConflict(latestTask)) {
          return;
        }

        let mergeProbeResult: Awaited<ReturnType<typeof probeTaskWorktreeMergeability>> | undefined;

        try {
          mergeProbeResult = await this.probeWorktreeMergeability(latestTask, targetBranch, {
            pullLatest: integrationPolicy.pullLatest,
            integrationWorktreeDir: integrationPolicy.integrationWorktreeDir,
            syncTargetBranch: false,
          });
        } catch (error) {
          this.logger.error(
            `Exact mergeability probe failed for completed blocked_conflict task ${latestTask.id}: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        if (mergeProbeResult?.alreadyIntegrated) {
          const storyCompletion = evaluateTaskStoryCompletion(latestTask);
          if (!storyCompletion.allStoriesPassed) {
            const message = formatStoryCompletionInvariantMessage(latestTask.id, 'integrate', storyCompletion);
            await this.stateManager.updateTask(task.id, {
              ...buildStoryCompletionInvariantFailureUpdates(message),
            });
            appendTaskEvent(latestTask, {
              type: 'merge_failed',
              status: 'completed',
              message,
            });
            this.logger.error(`Refused blocked-conflict integration recovery for incomplete task ${latestTask.id}: ${message}`);
            return;
          }

          const recoveredAt = Date.now();
          const message = `Recovered blocked integration conflict because ${resolveTaskBranchName(latestTask)} is already integrated in ${resolveTaskIntegrationBranch(latestTask, targetBranch)}`;

          await this.stateManager.updateTask(task.id, {
            integratedAt: recoveredAt,
            integrationStatus: 'integrated',
            mergeError: undefined,
            mergeConflictFiles: undefined,
            mergeConflictPhase: undefined,
            mergeConflictAt: undefined,
            postFinalizeMergeProbeRequired: undefined,
            integrationBranch: mergeProbeResult.integrationBranch,
            integrationWorktree: mergeProbeResult.integrationWorktree,
            coordinationStatus: undefined,
            coordinationPhase: undefined,
            coordinationBlockers: undefined,
            coordinationReason: undefined,
            mergeRepairDisplayStatus: undefined,
            mergeRepairProof: undefined,
          });
          appendTaskEvent(latestTask, {
            type: 'task_recovered_failed_finalize',
            status: 'completed',
            message,
            data: {
              exactProbeMessage: mergeProbeResult.message,
              conflictFiles: latestTask.mergeConflictFiles,
            },
          });
          this.logger.log(`Task ${latestTask.id} marked integrated after blocked_conflict recovery`);
          return;
        }

        if (mergeProbeResult?.mergeable) {
          const storyCompletion = evaluateTaskStoryCompletion(latestTask);
          if (!storyCompletion.allStoriesPassed) {
            const phase = mergeProbeResult.sourceKind === 'branch_head' ? 'integrate' : 'finalize';
            const message = formatStoryCompletionInvariantMessage(latestTask.id, phase, storyCompletion);
            await this.stateManager.updateTask(task.id, {
              status: 'failed',
              endTime: Date.now(),
              ...buildStoryCompletionInvariantFailureUpdates(message),
              mergeRepairDisplayStatus: undefined,
              mergeRepairProof: undefined,
              postFinalizeMergeProbeRequired: undefined,
            });
            appendTaskEvent(latestTask, {
              type: 'story_completion_invariant_failed',
              status: 'failed',
              message,
              data: {
                phase,
                exactProbeMessage: mergeProbeResult.message,
                incompleteStories: storyCompletion.incompleteStories,
              },
            });
            this.logger.error(`Refused blocked-conflict recovery for incomplete task ${latestTask.id}: ${message}`);
            return;
          }

          if (mergeProbeResult.sourceKind === 'branch_head') {
            const message = `Recovered blocked integration conflict because exact mergeability probe passed against ${resolveTaskIntegrationBranch(latestTask, targetBranch)}`;

            await this.stateManager.updateTask(task.id, {
              integratedAt: undefined,
              integrationStatus: 'not_started',
              integrationCommitSha: undefined,
              integrationBranch: undefined,
              integrationWorktree: undefined,
              mergedAt: undefined,
              mergeCommitSha: undefined,
              mergeMessage: undefined,
              mergeError: undefined,
              mergeConflictFiles: undefined,
              mergeConflictPhase: undefined,
              mergeConflictAt: undefined,
              postFinalizeMergeProbeRequired: undefined,
              targetSyncedAt: undefined,
              targetSyncStatus: 'not_requested',
              targetSyncDeferredReason: undefined,
              coordinationStatus: undefined,
              coordinationPhase: undefined,
              coordinationBlockers: undefined,
              coordinationReason: undefined,
              mergeRepairDisplayStatus: undefined,
              mergeRepairProof: undefined,
            });
            appendTaskEvent(latestTask, {
              type: 'task_recovered_failed_finalize',
              status: 'completed',
              message,
              data: {
                exactProbeMessage: mergeProbeResult.message,
                conflictFiles: latestTask.mergeConflictFiles,
              },
            });
            this.logger.log(`Task ${latestTask.id} cleared blocked_conflict after exact mergeability recovery`);
            return;
          }

          const readyMessage = isResolvedPendingMergeProof(mergeProbeResult)
            ? `Recovered blocked integration conflict because the task worktree is a resolved pending merge awaiting finalizer commit against ${resolveTaskIntegrationBranch(latestTask, targetBranch)}`
            : `Recovered blocked integration conflict because the task worktree now passes the exact mergeability probe against ${resolveTaskIntegrationBranch(latestTask, targetBranch)}`;

          await this.stateManager.updateTask(task.id, {
            status: 'ready_to_finalize',
            endTime: undefined,
            pid: undefined,
            currentUS: undefined,
            leaseOwner: undefined,
            leaseHeartbeatAt: undefined,
            leaseExpiresAt: undefined,
            lastError: undefined,
            lastErrorKind: undefined,
            lastErrorClass: undefined,
            lastErrorRetryable: undefined,
            lastErrorObservedAt: undefined,
            lastErrorSignature: undefined,
            lastErrorHadObjectiveProgress: undefined,
            mergeError: undefined,
            mergeConflictFiles: undefined,
            mergeConflictPhase: undefined,
            mergeConflictAt: undefined,
            postFinalizeMergeProbeRequired: true,
            repairContext: undefined,
            integrationBranch: mergeProbeResult.integrationBranch,
            integrationWorktree: mergeProbeResult.integrationWorktree,
            mergeRepairDisplayStatus: deriveMergeRepairDisplayStatus(mergeProbeResult),
            mergeRepairProof: buildMergeRepairProof(mergeProbeResult),
          });
          appendTaskEvent(latestTask, {
            type: 'task_recovered_failed_finalize',
            status: 'ready_to_finalize',
            message: readyMessage,
            data: {
              exactProbeMessage: mergeProbeResult.message,
              conflictFiles: latestTask.mergeConflictFiles,
            },
          });
          this.logger.log(`Task ${latestTask.id} recovered into ready_to_finalize from completed blocked_conflict`);
          return;
        }

        const repairStoryId = selectFinalizeRepairStoryId(latestTask, true);
        if (!repairStoryId) {
          return;
        }

        const repairReset = buildCompletedConflictRepairReset(latestTask, repairStoryId);

        await this.stateManager.updateTask(task.id, {
          status: 'pending',
          endTime: undefined,
          pid: undefined,
          currentUS: undefined,
          completedUS: repairReset.completedUS,
          storyProgress: repairReset.storyProgress,
          leaseOwner: undefined,
          leaseHeartbeatAt: undefined,
          leaseExpiresAt: undefined,
          loopCount: 0,
          consecutiveNoProgress: 0,
          consecutiveErrors: 0,
          lastProgressTime: repairReset.updatedAt,
          lastError: undefined,
          lastErrorKind: undefined,
          lastErrorClass: undefined,
          lastErrorRetryable: undefined,
          lastErrorObservedAt: undefined,
          lastErrorSignature: undefined,
          lastErrorHadObjectiveProgress: undefined,
          transientRetryCount: 0,
          transientRetryBudget: undefined,
          transientRetryLastDelayMs: undefined,
          ...buildFinalizeRetryReset(),
          postFinalizeMergeProbeRequired: true,
          repairContext: repairReset.repairContext,
          mergeRepairDisplayStatus: 'requeued',
          mergeRepairProof: mergeProbeResult
            ? buildMergeRepairProof(mergeProbeResult)
            : latestTask.mergeRepairProof,
        });
        appendTaskEvent(latestTask, {
          type: 'merge_repair_started',
          status: 'pending',
          storyId: repairStoryId,
          message: `Returned ${repairStoryId} to merge repair after completed delivery conflict`,
          data: {
            repairMode: 'merge',
            exactProbeMessage: mergeProbeResult?.message,
            conflictFiles: mergeProbeResult?.conflictFiles || latestTask.mergeConflictFiles,
          },
        });
        this.logger.log(`Task ${latestTask.id} returned to pending merge repair from completed blocked_conflict`);
      });
    }
  }

  private async autoMergeTaskIfEnabled(task: Task): Promise<Partial<Task>> {
    const policy = resolveIntegrationPolicy(this.configManager);
    if (!shouldAttemptAutomaticIntegration(policy)) {
      return {};
    }

    const targetBranch = policy.targetBranch;
    const strategy = policy.strategy;
    const storyCompletion = evaluateTaskStoryCompletion(task);
    if (!storyCompletion.allStoriesPassed) {
      throw new Error(formatStoryCompletionInvariantMessage(task.id, 'integrate', storyCompletion));
    }

    if (
      isDestructiveMergeStrategy(strategy)
      && !policy.allowDestructiveAutoResolve
    ) {
      throw new Error(formatDestructiveAutoResolveError(strategy));
    }

    const delayMs = policy.publishTargetBranch
      ? resolveAutoMergeDelayMs(this.configManager.get('autoMergeDelay'))
      : 0;
    if (delayMs > 0) {
      this.logger.log(`Task ${task.id} waiting ${delayMs}ms before auto-merge`);
      await this.sleep(delayMs);
    }

    this.logger.log(`Task ${task.id} auto-merging into ${targetBranch} (${strategy})`);
    appendTaskEvent(task, {
      type: 'merge_started',
      message: `Merging into ${targetBranch} (${strategy})`,
      data: { targetBranch, strategy },
    });
    const result = await this.mergeTask(task, targetBranch, strategy, {
      pullLatest: policy.pullLatest,
      useIntegrationWorktree: policy.useIntegrationWorktree,
      integrationWorktreeDir: policy.integrationWorktreeDir,
      syncTargetBranch: policy.syncTargetBranch,
    });

    if (!result.success) {
      const failureUpdates = buildMergeFailureUpdates(result, targetBranch, strategy);
      appendTaskEvent(task, {
        type: 'merge_failed',
        message: result.message,
        data: {
          targetBranch,
          strategy,
          hasConflicts: result.hasConflicts,
          conflictFiles: result.conflictFiles,
        },
      });
      throw createMergeFailureError(result, failureUpdates);
    }

    appendTaskEvent(task, {
      type: 'merge_completed',
      message: result.message,
      data: { targetBranch, strategy, commitSha: result.commitSha },
    });

    return buildSuccessfulMergeTaskUpdates(
      result,
      targetBranch,
      strategy,
    );
  }

  private async markCompletedTaskIntegrationFailure(
    task: Task,
    failureUpdates: Partial<Task>,
    message: string,
    strategy: MergeStrategy,
    targetBranch: string,
    hasConflicts: boolean,
  ): Promise<void> {
    await this.stateManager.updateTask(task.id, failureUpdates);
    appendTaskEvent(task, {
      type: 'merge_failed',
      message,
      data: {
        targetBranch,
        strategy,
        hasConflicts,
        conflictFiles: failureUpdates.mergeConflictFiles,
      },
    });
    this.logger.error(`Failed to integrate completed task ${task.id}: ${message}`);
  }

  private buildGenericIntegrationFailureUpdates(
    targetBranch: string,
    strategy: MergeStrategy,
    message: string,
  ): Partial<Task> {
    return {
      mergeTargetBranch: targetBranch,
      mergeStrategy: strategy,
      mergeMessage: undefined,
      mergeError: message,
      mergeConflictFiles: undefined,
      mergeConflictPhase: undefined,
      mergeConflictAt: undefined,
      integrationStatus: 'failed',
      targetSyncStatus: 'not_requested',
      targetSyncDeferredReason: undefined,
      coordinationStatus: undefined,
      coordinationPhase: undefined,
      coordinationBlockers: undefined,
      coordinationReason: undefined,
    };
  }

  async integrateCompletedTasks(): Promise<void> {
    const policy = resolveIntegrationPolicy(this.configManager);
    if (!shouldAttemptAutomaticIntegration(policy)) {
      return;
    }

    const completedTasks = (await this.stateManager.listTasks('completed'))
      .filter((task) => {
        const integrationStatus = resolveTaskIntegrationStatus(task);
        return integrationStatus !== 'integrated' && integrationStatus !== 'blocked_conflict';
      })
      .slice()
      .sort((a: Task, b: Task) => a.startTime - b.startTime);

    for (const task of completedTasks) {
      await withIntegrationLaneLock(task.repoPath, resolveTaskIntegrationLane(task, policy.targetBranch), async () => {
        const latestTask = await this.stateManager.loadTask(task.id);
        const latestIntegrationStatus = latestTask ? resolveTaskIntegrationStatus(latestTask) : undefined;
        if (!latestTask || latestTask.status !== 'completed' || latestIntegrationStatus === 'integrated' || latestIntegrationStatus === 'blocked_conflict') {
          return;
        }

        const storyCompletion = evaluateTaskStoryCompletion(latestTask);
        if (!storyCompletion.allStoriesPassed) {
          const message = formatStoryCompletionInvariantMessage(latestTask.id, 'integrate', storyCompletion);
          await this.stateManager.updateTask(task.id, {
            ...buildStoryCompletionInvariantFailureUpdates(message),
          });
          appendTaskEvent(latestTask, {
            type: 'merge_failed',
            status: 'completed',
            message,
          });
          this.logger.error(`Refused to integrate incomplete task ${latestTask.id}: ${message}`);
          return;
        }

        const coordinationState = findCoordinationBlockers(
          latestTask,
          await this.stateManager.listTasks(),
          'merge',
          { targetBranch: policy.targetBranch },
        );
        await this.stateManager.updateTask(task.id, {
          integrationLane: resolveTaskIntegrationLane(latestTask, policy.targetBranch),
          ...coordinationState.taskUpdates,
        });
        if (coordinationState.blocked) {
          return;
        }

        try {
          const mergeUpdates = await this.autoMergeTaskIfEnabled(latestTask);
          if (Object.keys(mergeUpdates).length === 0) {
            return;
          }

          await this.stateManager.updateTask(task.id, mergeUpdates);
          this.logger.log(`Task ${task.id} integrated into ${policy.targetBranch}`);
        } catch (error) {
          if (error instanceof Error && /Unattended autoMerge/.test(error.message)) {
            await this.markCompletedTaskIntegrationFailure(
              latestTask,
              this.buildGenericIntegrationFailureUpdates(policy.targetBranch, policy.strategy, error.message),
              error.message,
              policy.strategy,
              policy.targetBranch,
              false,
            );
            return;
          }

          const failureUpdates = getTaskUpdatesFromError(error);
          const failureMessage = error instanceof Error ? error.message : String(error);
          const normalizedFailureUpdates = Object.keys(failureUpdates).length > 0
            ? failureUpdates
            : this.buildGenericIntegrationFailureUpdates(policy.targetBranch, policy.strategy, failureMessage);
          await this.markCompletedTaskIntegrationFailure(
            latestTask,
            normalizedFailureUpdates,
            failureMessage,
            policy.strategy,
            policy.targetBranch,
            Boolean(normalizedFailureUpdates.mergeConflictFiles?.length),
          );
        }
      });
    }
  }

  async finalizeReadyTasks(): Promise<void> {
    const readyTasks = (await this.stateManager.listTasks('ready_to_finalize'))
      .slice()
      .sort((a: Task, b: Task) => a.startTime - b.startTime);

    for (const task of readyTasks) {
      await withTaskFinalizeLock(task.id, async () => {
        const integrationPolicy = resolveIntegrationPolicy(this.configManager);
        const targetBranch = integrationPolicy.targetBranch;
        const integrationLane = resolveTaskIntegrationLane(task, targetBranch);

        await withIntegrationLaneLock(task.repoPath, integrationLane, async () => {
        let finalizeResult: FinalizeResult | undefined;
        let finalizerCommittedAt: number | undefined;

        try {
          const latestTask = await this.stateManager.loadTask(task.id);
          if (!latestTask || (latestTask.status !== 'ready_to_finalize' && latestTask.status !== 'failed_finalize')) {
            return;
          }

          const coordinationState = findCoordinationBlockers(
            latestTask,
            await this.stateManager.listTasks(),
            'finalize',
            { targetBranch },
          );
          await this.stateManager.updateTask(task.id, {
            integrationLane,
            ...coordinationState.taskUpdates,
          });
          if (coordinationState.blocked) {
            appendTaskEvent(latestTask, {
              type: 'coordination_blocked',
              status: latestTask.status,
              message: coordinationState.reason,
              data: {
                phase: coordinationState.phase,
                blockers: coordinationState.blockers,
                lane: coordinationState.lane,
              },
            });
            this.logger.log(`Task ${task.id} waiting for overlapping task(s): ${coordinationState.blockers.join(', ')}`);
            return;
          }

          const storyCompletion = evaluateTaskStoryCompletion(latestTask);
          if (!storyCompletion.allStoriesPassed) {
            const observedAt = Date.now();
            const message = formatStoryCompletionInvariantMessage(latestTask.id, 'finalize', storyCompletion);
            await this.stateManager.updateTask(task.id, {
              status: 'failed',
              endTime: observedAt,
              pid: undefined,
              currentUS: undefined,
              leaseOwner: undefined,
              leaseHeartbeatAt: undefined,
              leaseExpiresAt: undefined,
              ...buildStoryCompletionInvariantFailureUpdates(message, observedAt),
            });
            appendTaskEvent(latestTask, {
              type: 'story_completion_invariant_failed',
              status: 'failed',
              message,
              data: {
                phase: 'finalize',
                incompleteStories: storyCompletion.incompleteStories,
              },
            });
            this.logger.error(`Refused to finalize incomplete task ${latestTask.id}: ${message}`);
            return;
          }

          const finalizingAt = Date.now();
          const leaseTimeoutMs = resolveFinalizerLeaseTimeoutMs(
            this.configManager.get('finalizer.leaseTimeout') ?? this.configManager.get('finalizer.qualityGateTimeout')
          );

          await this.stateManager.updateTask(task.id, {
            status: 'finalizing',
            pid: undefined,
            currentUS: undefined,
            endTime: undefined,
            leaseOwner: `finalizer:${process.pid}`,
            leaseHeartbeatAt: finalizingAt,
            leaseExpiresAt: finalizingAt + leaseTimeoutMs,
          });
          appendTaskEvent(latestTask, {
            type: 'finalizer_started',
            status: 'finalizing',
            message: 'Restricted finalizer started',
          });

          const taskToFinalize = await this.stateManager.loadTask(task.id);
          if (!taskToFinalize) {
            throw new Error(`Task ${task.id} disappeared before finalization`);
          }

          finalizeResult = this.finalizer(taskToFinalize);
          finalizerCommittedAt = finalizeResult.committed ? Date.now() : undefined;

          if (requiresPostFinalizeMergeProbe(taskToFinalize)) {
            const mergeProbeResult = await this.probeWorktreeMergeability(taskToFinalize, targetBranch, {
              pullLatest: integrationPolicy.pullLatest,
              integrationWorktreeDir: integrationPolicy.integrationWorktreeDir,
              syncTargetBranch: false,
            });

            if (!mergeProbeResult.alreadyIntegrated && !mergeProbeResult.mergeable) {
              const mergeFailureResult = {
                success: false,
                hasConflicts: Boolean(mergeProbeResult.conflictFiles?.length),
                message: mergeProbeResult.message,
                conflictFiles: mergeProbeResult.conflictFiles,
                integrationBranch: mergeProbeResult.integrationBranch,
                integrationWorktree: mergeProbeResult.integrationWorktree,
                sourceBranch: resolveTaskBranchName(taskToFinalize),
                targetBranch: resolveTaskIntegrationBranch(taskToFinalize, targetBranch),
                baseCommitSha: taskToFinalize.baseCommitSha,
              };

              throw createMergeFailureError(
                mergeFailureResult,
                buildMergeFailureUpdates(mergeFailureResult, targetBranch, integrationPolicy.strategy),
              );
            }
          }

          await this.stateManager.updateTask(task.id, {
            status: 'completed',
            endTime: Date.now(),
            lastError: undefined,
            finalizerCommitMessage: finalizeResult.commitMessage,
            finalizerCommitSha: finalizeResult.commitSha,
            finalizerCommittedAt,
            mergeError: undefined,
            mergeConflictFiles: undefined,
            mergeConflictPhase: undefined,
            mergeConflictAt: undefined,
            postFinalizeMergeProbeRequired: undefined,
            finalizerFailure: undefined,
            repairContext: undefined,
            finalizeRepairStartedAt: undefined,
            finalizeRepairDeadlineAt: undefined,
            finalizeRepairLastFailureSnapshot: undefined,
            finalizeRepairLastProgressAt: undefined,
            finalizeRepairLastProgressReason: undefined,
            finalizeRepairConsecutiveNoProgress: 0,
            finalizeRepairTotalRequeues: 0,
            finalizeRepairStoppedAt: undefined,
            finalizeRepairStopReason: undefined,
            lastErrorKind: undefined,
            lastErrorClass: undefined,
            lastErrorRetryable: undefined,
            lastErrorObservedAt: undefined,
            leaseOwner: undefined,
            leaseHeartbeatAt: undefined,
            leaseExpiresAt: undefined,
            integrationLane,
            ...coordinationState.taskUpdates,
          });
          appendTaskEvent(taskToFinalize, {
            type: 'finalizer_completed',
            status: 'completed',
            message: finalizeResult.message,
            data: {
              committed: finalizeResult.committed,
              commitSha: finalizeResult.commitSha,
              commitMessage: finalizeResult.commitMessage,
            },
          });

          let mergeSuffix = '';
          try {
            const mergeUpdates = await this.autoMergeTaskIfEnabled(taskToFinalize);
            if (Object.keys(mergeUpdates).length > 0) {
              await this.stateManager.updateTask(task.id, mergeUpdates);
              mergeSuffix = mergeUpdates.mergedAt
                ? `; merged into ${mergeUpdates.mergeTargetBranch}`
                : '';
            }
          } catch (error) {
            if (error instanceof Error && /Unattended autoMerge/.test(error.message)) {
              await this.markCompletedTaskIntegrationFailure(
                taskToFinalize,
                this.buildGenericIntegrationFailureUpdates(
                  integrationPolicy.targetBranch,
                  integrationPolicy.strategy,
                  error.message,
                ),
                error.message,
                integrationPolicy.strategy,
                integrationPolicy.targetBranch,
                false,
              );
              this.logger.log(`Task ${task.id} finalized (${finalizeResult.message}; integration failed)`);
              return;
            }

            const failureUpdates = getTaskUpdatesFromError(error);
            const failureMessage = error instanceof Error ? error.message : String(error);
            const normalizedFailureUpdates = Object.keys(failureUpdates).length > 0
              ? failureUpdates
              : this.buildGenericIntegrationFailureUpdates(
                  integrationPolicy.targetBranch,
                  integrationPolicy.strategy,
                  failureMessage,
                );
            await this.markCompletedTaskIntegrationFailure(
              taskToFinalize,
              normalizedFailureUpdates,
              failureMessage,
              integrationPolicy.strategy,
              integrationPolicy.targetBranch,
              Boolean(normalizedFailureUpdates.mergeConflictFiles?.length),
            );
            this.logger.log(`Task ${task.id} finalized (${finalizeResult.message}; integration failed)`);
            return;
          }

          this.logger.log(`Task ${task.id} finalized (${finalizeResult.message}${mergeSuffix})`);
        } catch (error) {
          const latestTask = await this.stateManager.loadTask(task.id);
          const finalizerAttempts = (latestTask?.finalizerAttempts ?? task.finalizerAttempts ?? 0) + 1;
          const failureUpdates = getTaskUpdatesFromError(error);
          const finalizerFailure = isQualityGateFailure(error) ? error.details : undefined;
          const failureMessage = error instanceof Error ? error.message : String(error);
          const observedAt = Date.now();
          const lastErrorKind = finalizerFailure
            ? 'quality_gate_failure'
            : failureUpdates.mergeConflictFiles?.length
              ? 'merge_conflict'
              : 'finalizer_failed';
          const lastErrorClass = finalizerFailure
            ? 'quality_gate'
            : failureUpdates.mergeConflictFiles?.length
              ? 'merge_conflict'
              : 'unknown';
          const repairConfig = resolveFinalizeRepairConfig(this.configManager);
          const repairFailureState = evaluateFinalizeRepairFailure({
            ...(latestTask ?? task),
            lastError: failureMessage,
            mergeError: failureMessage,
            finalizerFailure,
            ...failureUpdates,
          }, repairConfig);
          const repairStoryId = selectFinalizeRepairStoryId({
            ...(latestTask ?? task),
            mergeError: failureMessage,
            mergeConflictFiles: failureUpdates.mergeConflictFiles ?? latestTask?.mergeConflictFiles ?? task.mergeConflictFiles,
          }, Boolean(failureUpdates.mergeConflictFiles?.length));
          const repairContext = repairStoryId
            ? buildTaskRepairContext({
                storyId: repairStoryId,
                mode: failureUpdates.mergeConflictFiles?.length ? 'merge' : 'finalize',
                reason: failureMessage,
                createdAt: observedAt,
              })
            : undefined;
          await this.stateManager.updateTask(task.id, {
            status: 'failed_finalize',
            endTime: Date.now(),
            lastError: failureMessage,
            lastErrorKind,
            lastErrorClass,
            lastErrorRetryable: false,
            lastErrorObservedAt: observedAt,
            finalizerCommitMessage: finalizeResult?.commitMessage,
            finalizerCommitSha: finalizeResult?.commitSha,
            finalizerCommittedAt,
            finalizerAttempts,
            mergeError: failureMessage,
            finalizerFailure,
            repairContext,
            postFinalizeMergeProbeRequired: failureUpdates.postFinalizeMergeProbeRequired
              ?? latestTask?.postFinalizeMergeProbeRequired
              ?? task.postFinalizeMergeProbeRequired,
            pid: undefined,
            currentUS: undefined,
            leaseOwner: undefined,
            leaseHeartbeatAt: undefined,
            leaseExpiresAt: undefined,
            finalizeRepairStartedAt: repairFailureState.startedAt,
            finalizeRepairDeadlineAt: repairFailureState.deadlineAt,
            finalizeRepairLastFailureSnapshot: repairFailureState.snapshot,
            finalizeRepairLastProgressAt: repairFailureState.lastProgressAt,
            finalizeRepairLastProgressReason: repairFailureState.lastProgressReason,
            finalizeRepairConsecutiveNoProgress: repairFailureState.consecutiveNoProgress,
            ...failureUpdates,
          });
          appendTaskEvent(task, {
            type: 'finalizer_failed',
            status: 'failed_finalize',
            message: failureMessage,
            data: {
              finalizerAttempts,
              repairPolicy: repairConfig.repairPolicy,
              consecutiveNoProgress: repairFailureState.consecutiveNoProgress,
              progressReason: repairFailureState.lastProgressReason,
              finalizerFailureClass: finalizerFailure?.class,
              finalizerFailureGate: finalizerFailure?.gate,
              finalizerFailurePackage: finalizerFailure?.packageLabel,
              repairMode: repairContext?.mode,
              repairStoryId,
              diagnosticCount: finalizerFailure?.diagnosticCount,
              conflictFiles: failureUpdates.mergeConflictFiles,
            },
          });
          this.logger.error(`Failed to finalize task ${task.id}:`, error);
        }
        });
      });
    }
  }

  async recoverFailedBlockers(): Promise<void> {
    const recoveryConfig = resolveFailedBlockerRecoveryConfig(this.configManager);
    if (!recoveryConfig.autoRemediateFailedBlockers) {
      return;
    }

    const pendingTasks = (await this.stateManager.listTasks('pending'))
      .slice()
      .sort((a: Task, b: Task) => a.startTime - b.startTime);
    const demandByBlockerId = new Map<string, Set<string>>();

    for (const pendingTask of pendingTasks) {
      const pendingState = await this.scheduler.describePendingTask(pendingTask);

      for (const blocker of pendingState.dependencyBlockers || []) {
        if (blocker.taskId && blocker.attentionRequired) {
          if (!demandByBlockerId.has(blocker.taskId)) {
            demandByBlockerId.set(blocker.taskId, new Set());
          }
          demandByBlockerId.get(blocker.taskId)?.add(pendingTask.id);
        }
      }

      for (const blockerId of pendingState.failedBlockers || []) {
        if (!demandByBlockerId.has(blockerId)) {
          demandByBlockerId.set(blockerId, new Set());
        }
        demandByBlockerId.get(blockerId)?.add(pendingTask.id);
      }
    }

    if (demandByBlockerId.size === 0) {
      return;
    }

    const tasksById = new Map((await this.stateManager.listTasks()).map((task) => [task.id, task]));
    const blockers = [...demandByBlockerId.keys()]
      .map((blockerId) => tasksById.get(blockerId))
      .filter((task): task is Task => Boolean(task))
      .sort((a, b) => a.startTime - b.startTime);

    for (const blocker of blockers) {
      const demandTaskIds = [...(demandByBlockerId.get(blocker.id) || new Set<string>())].sort();

      if (blocker.status !== 'failed' || blocker.lastErrorKind !== 'story_incomplete') {
        continue;
      }

      if (blocker.failedBlockerRecoveryStoppedAt) {
        continue;
      }

      const now = Date.now();
      const signature = buildFailedBlockerRecoverySignature(blocker);
      const startedAt = blocker.failedBlockerRecoveryStartedAt
        ?? now;
      const deadlineAt = blocker.failedBlockerRecoveryDeadlineAt
        ?? startedAt + (recoveryConfig.failedBlockerRecoveryDeadlineSeconds * 1000);
      const currentFailedBlockerRequeues = blocker.failedBlockerRecoveryTotalRequeues ?? 0;
      const demandIds = mergeDemandTaskIds(blocker.failedBlockerRecoveryDemandTaskIds, demandTaskIds);

      const stopRecovery = async (stopReason: string, stopMessage: string) => {
        await this.stateManager.updateTask(blocker.id, {
          failedBlockerRecoveryStartedAt: startedAt,
          failedBlockerRecoveryDeadlineAt: deadlineAt,
          failedBlockerRecoveryLastSignature: signature,
          failedBlockerRecoveryStoppedAt: now,
          failedBlockerRecoveryStopReason: stopReason,
          failedBlockerRecoveryDemandTaskIds: demandIds,
          autoRecoveryKind: 'story_repair',
          autoRecoveryHardCap: recoveryConfig.failedBlockerRecoveryHardCap,
          autoRecoveryStoppedAt: now,
          autoRecoveryStopReason: stopReason,
          autoRecoveryLastReason: stopMessage,
        });
        appendTaskEvent(blocker, {
          type: 'failed_blocker_recovery_stopped',
          status: 'failed',
          message: stopMessage,
          data: {
            stopReason,
            demandTaskIds,
            signature,
            totalRequeues: currentFailedBlockerRequeues,
            deadlineAt,
          },
        });
        this.logger.log(`Task ${blocker.id} stopped failed-blocker auto-remediation (${stopMessage})`);
      };

      if (hasIntegrationOrMergeMarker(blocker)) {
        await stopRecovery(
          'failed_blocker_unsafe_integrated_marker',
          'Failed blocker has integration or merge markers; refusing automatic story reset',
        );
        continue;
      }

      if (deadlineAt <= now) {
        await stopRecovery(
          'failed_blocker_deadline_exhausted',
          'Failed blocker story repair deadline exhausted',
        );
        continue;
      }

      if (currentFailedBlockerRequeues >= recoveryConfig.maxFailedBlockerStoryRequeues) {
        await stopRecovery(
          'failed_blocker_story_budget_exhausted',
          'Failed blocker story repair requeue budget exhausted',
        );
        continue;
      }

      if (currentFailedBlockerRequeues >= recoveryConfig.failedBlockerRecoveryHardCap) {
        await stopRecovery(
          'failed_blocker_recovery_hard_cap_reached',
          'Failed blocker recovery hard cap reached',
        );
        continue;
      }

      const resettableStoryIds = selectFailedBlockerResettableStoryIds(blocker);
      if (resettableStoryIds.length === 0) {
        await stopRecovery(
          'failed_blocker_no_resettable_stories',
          'Failed blocker has no incomplete stories that can be reset safely',
        );
        continue;
      }

      const resetMessage = `Automatically requeued incomplete story work because pending task(s) are blocked: ${demandTaskIds.join(', ')}`;
      const resetState = resetIncompleteStoriesForFailedBlocker(blocker, resettableStoryIds, {
        updatedAt: now,
        message: resetMessage,
      });
      const nextFailedBlockerRequeues = currentFailedBlockerRequeues + 1;
      const currentAutoRequeues = blocker.autoRecoveryTotalRequeues ?? 0;
      const nextAutoRequeues = currentAutoRequeues + 1;

      await this.stateManager.updateTask(blocker.id, {
        status: 'pending',
        completedUS: resetState.completedUS,
        storyProgress: resetState.storyProgress,
        currentUS: undefined,
        pid: undefined,
        endTime: undefined,
        leaseOwner: undefined,
        leaseHeartbeatAt: undefined,
        leaseExpiresAt: undefined,
        loopCount: 0,
        consecutiveNoProgress: 0,
        consecutiveErrors: 0,
        lastProgressTime: now,
        lastError: undefined,
        lastErrorKind: undefined,
        lastErrorClass: undefined,
        lastErrorRetryable: undefined,
        lastErrorObservedAt: undefined,
        lastErrorSignature: undefined,
        lastErrorHadObjectiveProgress: undefined,
        transientRetryCount: 0,
        transientRetryBudget: undefined,
        transientRetryLastDelayMs: undefined,
        finalizerFailure: undefined,
        repairContext: undefined,
        finalizeRepairStoppedAt: undefined,
        finalizeRepairStopReason: undefined,
        mergeError: undefined,
        mergeConflictFiles: undefined,
        mergeConflictPhase: undefined,
        mergeConflictAt: undefined,
        mergeRepairDisplayStatus: undefined,
        mergeRepairProof: undefined,
        postFinalizeMergeProbeRequired: undefined,
        integrationStatus: 'not_started',
        targetSyncStatus: 'not_requested',
        targetSyncDeferredReason: undefined,
        coordinationStatus: undefined,
        coordinationPhase: undefined,
        coordinationBlockers: undefined,
        coordinationReason: undefined,
        failedBlockerRecoveryStartedAt: startedAt,
        failedBlockerRecoveryDeadlineAt: deadlineAt,
        failedBlockerRecoveryTotalRequeues: nextFailedBlockerRequeues,
        failedBlockerRecoveryLastSignature: signature,
        failedBlockerRecoveryStoppedAt: undefined,
        failedBlockerRecoveryStopReason: undefined,
        failedBlockerRecoveryDemandTaskIds: demandIds,
        autoRecoveryKind: 'story_repair',
        autoRecoveryHardCap: recoveryConfig.failedBlockerRecoveryHardCap,
        autoRecoveryTotalRequeues: nextAutoRequeues,
        autoRecoveryLastRequeuedAt: now,
        autoRecoveryNextEligibleAt: undefined,
        autoRecoveryStoppedAt: undefined,
        autoRecoveryStopReason: undefined,
        autoRecoveryLastReason: resetMessage,
      });
      appendTaskEvent(blocker, {
        type: 'failed_blocker_story_repair_auto_requeued',
        status: 'pending',
        storyId: resettableStoryIds[0],
        message: resetMessage,
        data: {
          resetStoryIds: resettableStoryIds,
          demandTaskIds,
          signature,
          totalRequeues: nextFailedBlockerRequeues,
          deadlineAt,
        },
      });
      this.logger.log(`Task ${blocker.id} returned to pending for failed-blocker story repair`);
    }
  }

  async checkPendingTasks(): Promise<void> {
    const startedTasks = await this.scheduler.schedulePendingTasks();

    for (const task of startedTasks) {
      appendTaskEvent(task, {
        type: 'manager_started_task',
        status: task.status,
        message: `Manager started task ${task.id}`,
        data: { pid: task.pid },
      });
      this.logger.log(`Task ${task.id} started (PID: ${task.pid})`);
    }
  }
}

export async function watchCommand(options: WatchCommandOptions): Promise<void> {
  try {
    await assertRalphHomeIsolation({
      repoPath: options.repo,
      allowMixedHome: options.allowMixedHome,
      operation: 'start the Ralph watcher',
    });

    const watcher = new DependencyWatcher(options);

    process.on('SIGINT', () => {
      console.log('\nReceived SIGINT, stopping watcher...');
      watcher.stop();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.log('\nReceived SIGTERM, stopping watcher...');
      watcher.stop();
      process.exit(0);
    });

    await watcher.start();
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exit(1);
  }
}
