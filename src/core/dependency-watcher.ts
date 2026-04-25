import * as path from 'path';
import { ConfigManager } from '../config/manager';
import { StateManager } from '../core/state';
import { appendTaskEvent } from './events';
import { FinalizeResult, finalizeTaskOutput } from './finalizer';
import { withTaskFinalizeLock } from './locks';
import { mergeBranch, MergeStrategy } from './merge';
import {
  buildMergeFailureUpdates,
  createMergeFailureError,
  formatDestructiveAutoResolveError,
  getTaskUpdatesFromError,
  isDestructiveMergeStrategy,
} from './merge-policy';
import { evaluateFailedTaskForFinalizeRecovery } from './soft-success';
import { DEFAULT_AGENT, resolveAgentBackend, resolveAgentType, resolveConfiguredBackend } from './agent';
import {
  DEFAULT_EZ4IELTS_PATTERN,
  DEFAULT_EZ4IELTS_SETTLE_MS,
  PrdAutoIngestor,
} from './prd-auto-ingest';
import { TaskScheduler } from './scheduler';
import { Task } from '../types/task';

export interface WatchCommandOptions {
  interval?: number;
  repo?: string;
  agent?: string;
  backend?: string;
  autoIngestEz4ielts?: boolean;
  ez4ieltsDir?: string;
}

interface DependencyWatcherDeps {
  stateManager?: StateManager;
  scheduler?: TaskScheduler;
  configManager?: Pick<ConfigManager, 'get'>;
  autoIngestor?: Pick<PrdAutoIngestor, 'initialize' | 'scan'>;
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<typeof console, 'log' | 'error'>;
  finalizer?: typeof finalizeTaskOutput;
  mergeTask?: typeof mergeBranch;
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

function resolveMergeStrategy(value: unknown): MergeStrategy {
  return value === 'ours' || value === 'theirs' || value === 'manual'
    ? value
    : 'manual';
}

function resolveMergeTargetBranch(value: unknown): string {
  if (typeof value !== 'string') {
    return 'main';
  }

  const trimmed = value.trim();
  return trimmed || 'main';
}

function hasMergeConflict(task: Task): boolean {
  if (task.mergeConflictFiles && task.mergeConflictFiles.length > 0) {
    return true;
  }

  const message = task.mergeError || task.lastError || '';
  return /Merge conflicts detected/i.test(message);
}

function buildMergeRepairContext(task: Task): string {
  const conflictFiles = task.mergeConflictFiles?.length
    ? task.mergeConflictFiles.join(', ')
    : 'unknown conflict files';
  const integrationTarget = task.integrationBranch || task.mergeTargetBranch || task.intendedMergeTarget || 'main';
  const repairIntro = [
    'Merge repair required by Ralph.',
    `Conflict files: ${conflictFiles}.`,
    `Integration target: ${integrationTarget}.`,
    'Resolve the semantic conflict by preserving the already-integrated target behavior and this task\'s intended behavior.',
    'Do not choose ours/theirs wholesale unless one side is provably obsolete.',
    'Update the task branch so it can merge cleanly, and run the relevant tests before finishing.',
  ];

  if (task.mergeError || task.lastError) {
    repairIntro.push(`Original merge error: ${task.mergeError || task.lastError}`);
  }

  return repairIntro.join(' ');
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

export class DependencyWatcher {
  private readonly scheduler: TaskScheduler;
  private readonly pollInterval: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Pick<typeof console, 'log' | 'error'>;
  private readonly autoIngestor?: Pick<PrdAutoIngestor, 'initialize' | 'scan'>;
  private readonly stateManager: StateManager;
  private readonly configManager: Pick<ConfigManager, 'get'>;
  private readonly finalizer: typeof finalizeTaskOutput;
  private readonly mergeTask: typeof mergeBranch;
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
    this.finalizer = deps.finalizer ?? finalizeTaskOutput;
    this.mergeTask = deps.mergeTask ?? mergeBranch;
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
        await this.recoverSoftFailedTasks();
        await this.recoverFailedFinalizeTasks();
        await this.finalizeReadyTasks();
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

  async recoverSoftFailedTasks(): Promise<void> {
    const failedTasks = (await this.stateManager.listTasks('failed'))
      .slice()
      .sort((a: Task, b: Task) => a.startTime - b.startTime);

    for (const task of failedTasks) {
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

      await this.stateManager.updateTask(task.id, {
        status: 'ready_to_finalize',
        completedUS,
        storyProgress,
        currentUS: undefined,
        pid: undefined,
        endTime: undefined,
        lastError: undefined,
        mergeError: undefined,
      });
      appendTaskEvent(task, {
        type: 'task_recovered_soft_failed',
        status: 'ready_to_finalize',
        message: decision.reason,
        data: {
          recoveredStoryId: decision.recoverableStoryId,
        },
      });
      this.logger.log(`Task ${task.id} recovered into ready_to_finalize (${decision.reason})`);
    }
  }

  async recoverFailedFinalizeTasks(): Promise<void> {
    const maxRepairAttempts = Number(this.configManager.get('finalizer.maxRepairAttempts'));
    const repairLimit = Number.isFinite(maxRepairAttempts) && maxRepairAttempts >= 0
      ? Math.floor(maxRepairAttempts)
      : 1;
    const failedFinalizeTasks = (await this.stateManager.listTasks('failed_finalize'))
      .slice()
      .sort((a: Task, b: Task) => a.startTime - b.startTime);

    for (const task of failedFinalizeTasks) {
      const mergeConflict = hasMergeConflict(task);
      const attempts = mergeConflict ? (task.mergeRepairAttempts ?? 0) : (task.finalizerAttempts ?? 0);
      const repairStoryId = selectFinalizeRepairStoryId(task, mergeConflict);
      if (!repairStoryId) {
        continue;
      }

      const repairStory = task.storyProgress?.find((story) => story.id === repairStoryId);
      const hasUnrunMergeRepair = Boolean(
        mergeConflict
        && repairStory?.status === 'needs_repair'
        && !task.completedUS.includes(repairStoryId)
      );
      if ((mergeConflict ? attempts >= repairLimit : attempts > repairLimit) && !hasUnrunMergeRepair) {
        continue;
      }

      const repairMessage = mergeConflict
        ? buildMergeRepairContext(task)
        : task.lastError || task.mergeError || 'Finalizer failed; repair required';
      const completedUS = task.completedUS.filter((storyId) => storyId !== repairStoryId);
      const storyProgress = (task.storyProgress || []).map((story) => story.id === repairStoryId
        ? {
            ...story,
            status: 'needs_repair' as const,
            attempts: 0,
            lastError: repairMessage,
            updatedAt: Date.now(),
            history: [
              ...(story.history || []),
              {
                attempt: story.attempts,
                status: 'needs_repair' as const,
                message: repairMessage,
                updatedAt: Date.now(),
              },
            ],
          }
        : story);

      await this.stateManager.updateTask(task.id, {
        status: 'pending',
        completedUS,
        storyProgress,
        currentUS: undefined,
        pid: undefined,
        endTime: undefined,
        leaseOwner: undefined,
        leaseHeartbeatAt: undefined,
        leaseExpiresAt: undefined,
        ...(mergeConflict ? { mergeRepairAttempts: hasUnrunMergeRepair ? attempts : attempts + 1 } : {}),
      });
      appendTaskEvent(task, {
        type: mergeConflict ? 'merge_repair_started' : 'task_recovered_failed_finalize',
        status: 'pending',
        storyId: repairStoryId,
        message: mergeConflict && hasUnrunMergeRepair
          ? `Requeued unrun merge repair for ${repairStoryId}`
          : mergeConflict
          ? `Returned ${repairStoryId} to merge repair after conflict`
          : `Returned ${repairStoryId} to repair after failed finalizer attempt`,
        data: {
          finalizerAttempts: task.finalizerAttempts,
          mergeRepairAttempts: mergeConflict ? (hasUnrunMergeRepair ? attempts : attempts + 1) : undefined,
          repairLimit,
          conflictFiles: task.mergeConflictFiles,
        },
      });
      this.logger.log(mergeConflict
        ? `Task ${task.id} returned to pending merge repair for ${repairStoryId}`
        : `Task ${task.id} returned to pending repair for ${repairStoryId}`);
    }
  }

  private async autoMergeTaskIfEnabled(task: Task): Promise<Partial<Task>> {
    if (!Boolean(this.configManager.get('autoMerge'))) {
      return {};
    }

    const targetBranch = resolveMergeTargetBranch(this.configManager.get('merge.targetBranch'));
    const strategy = resolveMergeStrategy(this.configManager.get('merge.strategy'));
    if (
      isDestructiveMergeStrategy(strategy)
      && !Boolean(this.configManager.get('merge.allowDestructiveAutoResolve'))
    ) {
      throw new Error(formatDestructiveAutoResolveError(strategy));
    }

    const delayMs = resolveAutoMergeDelayMs(this.configManager.get('autoMergeDelay'));
    if (delayMs > 0) {
      this.logger.log(`Task ${task.id} waiting ${delayMs}ms before auto-merge`);
      await this.sleep(delayMs);
    }

    const pullLatest = this.configManager.get('merge.pullLatest') !== false;
    const useIntegrationWorktree = this.configManager.get('merge.useIntegrationWorktree') !== false;
    const configuredIntegrationDir = this.configManager.get('merge.integrationWorktreeDir');
    const integrationWorktreeDir = typeof configuredIntegrationDir === 'string' && configuredIntegrationDir.trim()
      ? configuredIntegrationDir.trim()
      : undefined;
    const syncTargetBranch = this.configManager.get('merge.syncTargetBranch') !== false;

    this.logger.log(`Task ${task.id} auto-merging into ${targetBranch} (${strategy})`);
    appendTaskEvent(task, {
      type: 'merge_started',
      message: `Merging into ${targetBranch} (${strategy})`,
      data: { targetBranch, strategy },
    });
    const result = await this.mergeTask(task, targetBranch, strategy, {
      pullLatest,
      useIntegrationWorktree,
      integrationWorktreeDir,
      syncTargetBranch,
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

    return {
      mergedAt: Date.now(),
      integratedAt: Date.now(),
      mergeCommitSha: result.commitSha,
      integrationCommitSha: result.commitSha,
      integrationBranch: result.integrationBranch,
      integrationWorktree: result.integrationWorktree,
      mergeTargetBranch: targetBranch,
      mergeStrategy: strategy,
      mergeMessage: result.message,
      mergeError: undefined,
      mergeConflictFiles: undefined,
      mergeConflictAt: undefined,
      targetSyncedAt: result.targetSynced ? Date.now() : undefined,
      targetSyncDeferredReason: result.targetSynced === false ? result.targetSyncMessage : undefined,
    };
  }

  async finalizeReadyTasks(): Promise<void> {
    const readyTasks = (await this.stateManager.listTasks('ready_to_finalize'))
      .slice()
      .sort((a: Task, b: Task) => a.startTime - b.startTime);

    for (const task of readyTasks) {
      await withTaskFinalizeLock(task.id, async () => {
        let finalizeResult: FinalizeResult | undefined;
        let finalizerCommittedAt: number | undefined;

        try {
          const latestTask = await this.stateManager.loadTask(task.id);
          if (!latestTask || (latestTask.status !== 'ready_to_finalize' && latestTask.status !== 'failed_finalize')) {
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
          const mergeUpdates = await this.autoMergeTaskIfEnabled(taskToFinalize);

          await this.stateManager.updateTask(task.id, {
            status: 'completed',
            endTime: Date.now(),
            finalizerCommitMessage: finalizeResult.commitMessage,
            finalizerCommittedAt,
            leaseOwner: undefined,
            leaseHeartbeatAt: undefined,
            leaseExpiresAt: undefined,
            ...mergeUpdates,
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

          const mergeSuffix = mergeUpdates.mergedAt
            ? `; merged into ${mergeUpdates.mergeTargetBranch}`
            : '';
          this.logger.log(`Task ${task.id} finalized (${finalizeResult.message}${mergeSuffix})`);
        } catch (error) {
          const latestTask = await this.stateManager.loadTask(task.id);
          const finalizerAttempts = (latestTask?.finalizerAttempts ?? task.finalizerAttempts ?? 0) + 1;
          const failureUpdates = getTaskUpdatesFromError(error);
          await this.stateManager.updateTask(task.id, {
            status: 'failed_finalize',
            endTime: Date.now(),
            lastError: error instanceof Error ? error.message : String(error),
            finalizerCommitMessage: finalizeResult?.commitMessage,
            finalizerCommittedAt,
            finalizerAttempts,
            mergeError: error instanceof Error ? error.message : String(error),
            pid: undefined,
            currentUS: undefined,
            leaseOwner: undefined,
            leaseHeartbeatAt: undefined,
            leaseExpiresAt: undefined,
            ...failureUpdates,
          });
          appendTaskEvent(task, {
            type: 'finalizer_failed',
            status: 'failed_finalize',
            message: error instanceof Error ? error.message : String(error),
            data: {
              finalizerAttempts,
              conflictFiles: failureUpdates.mergeConflictFiles,
            },
          });
          this.logger.error(`Failed to finalize task ${task.id}:`, error);
        }
      });
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
}
