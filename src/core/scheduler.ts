import * as fs from 'fs';
import * as path from 'path';
import { ChildProcess, execFileSync, fork, ForkOptions } from 'child_process';
import { ConfigManager } from '../config/manager';
import { PRD } from '../types/prd';
import { Task, TaskStatus } from '../types/task';
import { checkDependencies, DependencyBlocker, DependencyCheckResult, isProcessRunning, parsePRD } from '../utils/helpers';
import { bootstrapWorktreeDeps } from './bootstrap';
import { appendTaskEvent } from './events';
import { evaluateAutoRecovery } from './auto-recovery-state';
import {
  captureObservedTaskSurface,
  findCoordinationBlockers,
  hasHotConflictReservation,
} from './task-coordination';
import { getRalphPaths, RalphHomeOptions, resolveRalphHome } from './paths';
import { StateManager } from './state';
import { resolveTaskIntegrationStatus } from './task-delivery';
import { WorktreeManager } from './worktree';

const DEFAULT_MAX_CONCURRENT = 3;
const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 30000;
const LOCK_STALE_MS = 300000;
const DEFAULT_RUNNING_LEASE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_FINALIZING_LEASE_TIMEOUT_MS = 30 * 60 * 1000;
const RECOVERY_TERMINATION_GRACE_MS = 5000;
const RECOVERY_TERMINATION_POLL_MS = 100;

export type TerminalTaskStatus = Exclude<TaskStatus, 'pending' | 'running' | 'ready_to_finalize' | 'finalizing'>;

type DependencyResult = DependencyCheckResult;
type DependencyChecker = (
  prd: PRD,
  stateManager: StateManager,
  options?: { repoPath?: string; task?: Task }
) => Promise<DependencyResult>;
type ProcessChecker = (pid: number) => boolean;

export interface SchedulerDeps extends RalphHomeOptions {
  stateManager?: StateManager;
  worktreeManager?: Pick<WorktreeManager, 'createWorktree'>;
  configManager?: Pick<ConfigManager, 'get'>;
  bootstrapWorktreeDeps?: typeof bootstrapWorktreeDeps;
  parsePRD?: typeof parsePRD;
  checkDependencies?: DependencyChecker;
  forkProcess?: (
    modulePath: string,
    args?: ReadonlyArray<string>,
    options?: ForkOptions
  ) => ChildProcess;
  isProcessRunning?: ProcessChecker;
  terminateProcess?: (pid: number, signal?: NodeJS.Signals | number) => void;
  lockDir?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PendingTaskState {
  reason: 'dependencies' | 'coordination' | 'queued';
  dependencies: string[];
  dependencyBlockers?: DependencyBlocker[];
  failedDependencies?: string[];
  recoveringDependencies?: string[];
  missingDependencies?: string[];
  blockers: string[];
  failedBlockers?: string[];
  recoveringBlockers?: string[];
  coordinationReason?: string;
  integrationLane?: string;
  maxConcurrent: number;
  running: number;
}

function resolveConcurrencyLimit(
  configManager: Pick<ConfigManager, 'get'> = new ConfigManager()
): number {
  const rawValue = Number(
    configManager.get('runner.maxConcurrent') ?? configManager.get('maxConcurrentTasks')
  );

  if (!Number.isFinite(rawValue) || rawValue < 1) {
    return DEFAULT_MAX_CONCURRENT;
  }

  return Math.floor(rawValue);
}

function resolveHeadCommit(worktreePath: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return undefined;
  }
}

function toTimeoutMs(value: unknown, fallbackMs: number): number {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return fallbackMs;
  }

  return numericValue * 1000;
}

function isFailedCoordinationBlocker(task: Task): boolean {
  if (task.status === 'failed' || task.status === 'stagnant' || task.status === 'failed_finalize') {
    return true;
  }

  if (task.status !== 'completed') {
    return false;
  }

  const integrationStatus = resolveTaskIntegrationStatus(task);
  return integrationStatus === 'failed' || integrationStatus === 'blocked_conflict';
}

export class TaskScheduler {
  private readonly stateManager: StateManager;
  private readonly worktreeManager: Pick<WorktreeManager, 'createWorktree'>;
  private readonly configManager: Pick<ConfigManager, 'get'>;
  private readonly bootstrapWorktreeDepsFn: typeof bootstrapWorktreeDeps;
  private readonly parsePRDFn: typeof parsePRD;
  private readonly checkDependenciesFn: DependencyChecker;
  private readonly forkProcessFn: (
    modulePath: string,
    args?: ReadonlyArray<string>,
    options?: ForkOptions
  ) => ChildProcess;
  private readonly isProcessRunningFn: ProcessChecker;
  private readonly terminateProcessFn: (pid: number, signal?: NodeJS.Signals | number) => void;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly lockDir: string;
  private readonly lockInfoPath: string;
  private readonly ralphHome: string;

  constructor(deps: SchedulerDeps = {}) {
    this.ralphHome = resolveRalphHome(deps);
    this.stateManager = deps.stateManager ?? new StateManager(deps);
    this.worktreeManager = deps.worktreeManager ?? new WorktreeManager();
    this.configManager = deps.configManager ?? new ConfigManager(deps);
    this.bootstrapWorktreeDepsFn = deps.bootstrapWorktreeDeps ?? bootstrapWorktreeDeps;
    this.parsePRDFn = deps.parsePRD ?? parsePRD;
    this.checkDependenciesFn = deps.checkDependencies ?? checkDependencies;
    this.forkProcessFn = deps.forkProcess ?? fork;
    this.isProcessRunningFn = deps.isProcessRunning ?? isProcessRunning;
    this.terminateProcessFn = deps.terminateProcess ?? ((pid, signal) => process.kill(pid, signal));
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.lockDir = deps.lockDir ?? getRalphPaths(deps).schedulerLockDir;
    this.lockInfoPath = path.join(this.lockDir, 'owner.json');
  }

  getConcurrencyLimit(): number {
    return resolveConcurrencyLimit(this.configManager);
  }

  async countRunningTasks(options: { reconcile?: boolean } = {}): Promise<number> {
    const shouldReconcile = options.reconcile !== false;
    const runningTasks = shouldReconcile
      ? await this.reconcileRunningTasks()
      : await this.stateManager.listTasks('running');
    return runningTasks.length;
  }

  async recoverStaleTasks(): Promise<void> {
    await this.withLock(async () => {
      await this.recoverStaleTasksUnlocked();
    });
  }

  private async recoverStaleTasksUnlocked(): Promise<void> {
    await this.reconcileRunningTasks();
    await this.reconcileFinalizingTasks();
  }

  private getRunningLeaseTimeoutMs(): number {
    return toTimeoutMs(this.configManager.get('runner.leaseTimeout'), DEFAULT_RUNNING_LEASE_TIMEOUT_MS);
  }

  private getRunningStagnationTimeoutMs(): number | undefined {
    const rawValue = Number(this.configManager.get('runner.stagnationTimeout'));

    if (!Number.isFinite(rawValue) || rawValue <= 0) {
      return undefined;
    }

    return rawValue * 1000;
  }

  private getFinalizingLeaseTimeoutMs(): number {
    return toTimeoutMs(
      this.configManager.get('finalizer.leaseTimeout') ?? this.configManager.get('finalizer.qualityGateTimeout'),
      DEFAULT_FINALIZING_LEASE_TIMEOUT_MS
    );
  }

  private isLeaseFresh(task: Task, timeoutMs: number): boolean {
    if (typeof task.leaseExpiresAt === 'number') {
      return task.leaseExpiresAt > this.now();
    }

    if (typeof task.leaseHeartbeatAt === 'number') {
      return this.now() - task.leaseHeartbeatAt < timeoutMs;
    }

    return false;
  }

  private async terminateWorkerForRecovery(task: Pick<Task, 'id' | 'pid'>, reason: string): Promise<boolean> {
    if (typeof task.pid !== 'number') {
      return true;
    }

    if (!this.isProcessRunningFn(task.pid)) {
      return true;
    }

    try {
      this.terminateProcessFn(task.pid, 'SIGTERM');
    } catch (error) {
      console.error(`Failed to send SIGTERM to worker ${task.pid} for task ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const gracefulDeadline = this.now() + RECOVERY_TERMINATION_GRACE_MS;
    while (this.isProcessRunningFn(task.pid) && this.now() < gracefulDeadline) {
      await this.sleep(RECOVERY_TERMINATION_POLL_MS);
    }

    if (!this.isProcessRunningFn(task.pid)) {
      return true;
    }

    try {
      this.terminateProcessFn(task.pid, 'SIGKILL');
    } catch (error) {
      console.error(`Failed to send SIGKILL to worker ${task.pid} for task ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const forcedDeadline = this.now() + RECOVERY_TERMINATION_GRACE_MS;
    while (this.isProcessRunningFn(task.pid) && this.now() < forcedDeadline) {
      await this.sleep(RECOVERY_TERMINATION_POLL_MS);
    }

    const stopped = !this.isProcessRunningFn(task.pid);
    if (!stopped) {
      console.error(`Worker ${task.pid} for task ${task.id} did not exit during recovery: ${reason}`);
    }

    return stopped;
  }

  private async reconcileRunningTasks(): Promise<Task[]> {
    const runningTasks = await this.stateManager.listTasks('running');
    const activeTasks: Task[] = [];
    const leaseTimeoutMs = this.getRunningLeaseTimeoutMs();
    const stagnationTimeoutMs = this.getRunningStagnationTimeoutMs();

    for (const task of runningTasks) {
      const latestTask = await this.stateManager.loadTask(task.id);

      if (!latestTask || latestTask.status !== 'running') {
        continue;
      }

      if (typeof latestTask.pid !== 'number') {
        if (this.isLeaseFresh(latestTask, leaseTimeoutMs)) {
          activeTasks.push(latestTask);
          continue;
        }

        const lastError = 'Worker process PID is missing and the running lease is stale';
        console.error(`Recovering stale running task ${latestTask.id}: ${lastError}`);
        const updateResult = await this.stateManager.updateTaskIf(latestTask.id, (candidate) => (
          candidate.status === 'running'
          && candidate.pid === undefined
          && candidate.leaseOwner === latestTask.leaseOwner
          && (candidate.leaseHeartbeatAt ?? 0) <= (latestTask.leaseHeartbeatAt ?? 0)
        ), {
          status: 'failed',
          endTime: this.now(),
          currentUS: undefined,
          pid: undefined,
          leaseOwner: undefined,
          leaseHeartbeatAt: undefined,
          leaseExpiresAt: undefined,
          lastError,
        });
        if (updateResult.updated) {
          appendTaskEvent(updateResult.task ?? latestTask, {
            type: 'task_recovered_stale_running',
            status: 'failed',
            message: lastError,
          });
        }
        continue;
      }

      if (this.isProcessRunningFn(latestTask.pid)) {
        if (
          Number.isFinite(stagnationTimeoutMs)
          && typeof latestTask.lastProgressTime === 'number'
          && this.now() - latestTask.lastProgressTime >= Number(stagnationTimeoutMs)
        ) {
          const noProgressMs = this.now() - latestTask.lastProgressTime;
          const lastError = `Running worker made no progress for ${Math.floor(noProgressMs / 1000)}s; task was marked stagnant for retry`;
          console.error(`Recovering stagnant running task ${latestTask.id}: ${lastError}`);
          const terminated = await this.terminateWorkerForRecovery(latestTask, lastError);

          if (!terminated) {
            activeTasks.push(latestTask);
            continue;
          }

          const observedPid = latestTask.pid;
          const observedLeaseOwner = latestTask.leaseOwner;
          const observedLastProgressTime = latestTask.lastProgressTime;
          const updateResult = await this.stateManager.updateTaskIf(latestTask.id, (candidate) => (
            candidate.status === 'running'
            && candidate.pid === observedPid
            && candidate.leaseOwner === observedLeaseOwner
            && candidate.lastProgressTime <= observedLastProgressTime
          ), {
            status: 'stagnant',
            endTime: this.now(),
            currentUS: undefined,
            pid: undefined,
            leaseOwner: undefined,
            leaseHeartbeatAt: undefined,
            leaseExpiresAt: undefined,
            lastError,
            lastErrorKind: 'stagnation',
            lastErrorClass: 'stagnation',
            lastErrorRetryable: false,
            lastErrorObservedAt: this.now(),
          });
          if (updateResult.updated) {
            appendTaskEvent(updateResult.task ?? latestTask, {
              type: 'task_recovered_stagnant_running',
              status: 'stagnant',
              message: lastError,
              data: {
                pid: latestTask.pid,
                noProgressMs,
                stagnationTimeoutMs,
              },
            });
          }
          continue;
        }

        activeTasks.push(latestTask);
        continue;
      }

      const lastError = `Worker process ${latestTask.pid} is no longer running`;

      console.error(`Recovering stale running task ${latestTask.id}: ${lastError}`);
      const observedPid = latestTask.pid;
      const observedLeaseOwner = latestTask.leaseOwner;
      const updateResult = await this.stateManager.updateTaskIf(latestTask.id, (candidate) => (
        candidate.status === 'running'
        && candidate.pid === observedPid
        && candidate.leaseOwner === observedLeaseOwner
      ), {
        status: 'failed',
        endTime: this.now(),
        currentUS: undefined,
        pid: undefined,
        leaseOwner: undefined,
        leaseHeartbeatAt: undefined,
        leaseExpiresAt: undefined,
        lastError,
      });
      if (updateResult.updated) {
        appendTaskEvent(updateResult.task ?? latestTask, {
          type: 'task_recovered_stale_running',
          status: 'failed',
          message: lastError,
          data: { pid: latestTask.pid },
        });
      }
    }

    return activeTasks;
  }

  private async reconcileFinalizingTasks(): Promise<void> {
    const finalizingTasks = await this.stateManager.listTasks('finalizing');
    const leaseTimeoutMs = this.getFinalizingLeaseTimeoutMs();

    for (const task of finalizingTasks) {
      const latestTask = await this.stateManager.loadTask(task.id);

      if (!latestTask || latestTask.status !== 'finalizing') {
        continue;
      }

      if (this.isLeaseFresh(latestTask, leaseTimeoutMs)) {
        continue;
      }

      const lastError = 'Finalizer lease is stale; task was returned to ready_to_finalize for retry';
      console.error(`Recovering stale finalizing task ${latestTask.id}: ${lastError}`);
      await this.stateManager.updateTask(latestTask.id, {
        status: 'ready_to_finalize',
        endTime: undefined,
        pid: undefined,
        currentUS: undefined,
        leaseOwner: undefined,
        leaseHeartbeatAt: undefined,
        leaseExpiresAt: undefined,
        lastError,
      });
      appendTaskEvent(latestTask, {
        type: 'task_recovered_stale_finalizing',
        status: 'ready_to_finalize',
        message: lastError,
      });
    }
  }

  private getDependencyPRD(task: Task): PRD {
    if (task.prdId && Array.isArray(task.prdDependencies)) {
      return {
        id: task.prdId,
        title: task.prdTitle || task.prdId,
        description: '',
        userStories: [],
        dependencies: task.prdDependencies || [],
      };
    }

    return this.parsePRDFn(task.prdPath);
  }

  async describePendingTask(task: Task, options: { readOnly?: boolean } = {}): Promise<PendingTaskState> {
    const maxConcurrent = this.getConcurrencyLimit();
    const running = await this.countRunningTasks({ reconcile: !options.readOnly });
    const prd = this.getDependencyPRD(task);
    const dependencyState = await this.checkDependenciesFn(prd, this.stateManager, {
      repoPath: task.repoPath,
      task,
    });

    if (!dependencyState.satisfied) {
      return {
        reason: 'dependencies',
        dependencies: dependencyState.pending,
        dependencyBlockers: dependencyState.blockers,
        failedDependencies: dependencyState.failed,
        recoveringDependencies: dependencyState.recovering,
        missingDependencies: dependencyState.missing,
        blockers: [],
        maxConcurrent,
        running,
      };
    }

    const coordinationState = await this.describeCoordinationBlockedTask(task);
    if (coordinationState) {
      return {
        reason: 'coordination',
        dependencies: [],
        blockers: coordinationState.blockers,
        failedBlockers: coordinationState.failedBlockers,
        recoveringBlockers: coordinationState.recoveringBlockers,
        coordinationReason: coordinationState.reason,
        integrationLane: coordinationState.lane,
        maxConcurrent,
        running,
      };
    }

    return {
      reason: 'queued',
      dependencies: [],
      blockers: [],
      maxConcurrent,
      running,
    };
  }

  private async describeCoordinationBlockedTask(task: Task): Promise<{
    blockers: string[];
    failedBlockers: string[];
    recoveringBlockers: string[];
    reason?: string;
    lane: string;
  } | null> {
    const tasks = await this.stateManager.listTasks();
    const result = findCoordinationBlockers(task, tasks, 'start');
    const tasksById = new Map(tasks.map((entry) => [entry.id, entry]));
    const failedBlockers: string[] = [];
    const recoveringBlockers: string[] = [];

    for (const blockerId of result.blockers) {
      const blocker = tasksById.get(blockerId);
      if (!blocker) {
        continue;
      }

      if (evaluateAutoRecovery(blocker).active) {
        recoveringBlockers.push(blockerId);
        continue;
      }

      if (isFailedCoordinationBlocker(blocker)) {
        failedBlockers.push(blockerId);
      }
    }

    return result.blocked
      ? {
          blockers: result.blockers,
          failedBlockers,
          recoveringBlockers,
          reason: result.reason,
          lane: result.lane,
        }
      : null;
  }

  private coordinationUpdatesChanged(task: Task, updates: Partial<Task>): boolean {
    const currentBlockers = task.coordinationBlockers || [];
    const nextBlockers = updates.coordinationBlockers || [];

    return task.integrationLane !== updates.integrationLane
      || task.coordinationStatus !== updates.coordinationStatus
      || task.coordinationPhase !== updates.coordinationPhase
      || task.coordinationReason !== updates.coordinationReason
      || task.declaredWriteSurface?.join('\n') !== updates.declaredWriteSurface?.join('\n')
      || task.declaredConflictDomains?.join('\n') !== updates.declaredConflictDomains?.join('\n')
      || currentBlockers.join('\n') !== nextBlockers.join('\n');
  }

  async schedulePendingTasks(): Promise<Task[]> {
    return this.withLock(async () => {
      const startedTasks: Task[] = [];
      const maxConcurrent = this.getConcurrencyLimit();
      await this.recoverStaleTasksUnlocked();
      let runningCount = await this.countRunningTasks();

      if (runningCount >= maxConcurrent) {
        return startedTasks;
      }

      const pendingTasks = (await this.stateManager.listTasks('pending'))
        .slice()
        .sort((a, b) => a.startTime - b.startTime);

      for (const task of pendingTasks) {
        if (runningCount >= maxConcurrent) {
          break;
        }

        try {
          const prd = this.getDependencyPRD(task);
          const dependencyState = await this.checkDependenciesFn(prd, this.stateManager, {
            repoPath: task.repoPath,
            task,
          });

          if (!dependencyState.satisfied) {
            continue;
          }

          const coordinationState = findCoordinationBlockers(
            task,
            await this.stateManager.listTasks(),
            'start',
          );
          if (coordinationState.blocked) {
            const shouldRecordCoordinationBlock = this.coordinationUpdatesChanged(task, coordinationState.taskUpdates);
            if (shouldRecordCoordinationBlock) {
              await this.stateManager.updateTask(task.id, coordinationState.taskUpdates);
              appendTaskEvent(task, {
                type: 'coordination_blocked',
                status: task.status,
                message: coordinationState.reason,
                data: {
                  phase: coordinationState.phase,
                  blockers: coordinationState.blockers,
                  lane: coordinationState.lane,
                },
              });
            }
            continue;
          }

          if (task.coordinationStatus || task.coordinationPhase || task.coordinationReason || task.coordinationBlockers?.length) {
            await this.stateManager.updateTask(task.id, coordinationState.taskUpdates);
          }

          const startedTask = await this.startTask(task);
          if (!startedTask) {
            continue;
          }

          startedTasks.push(startedTask);
          runningCount++;
        } catch (error) {
          console.error(`Failed to evaluate pending task ${task.id}:`, error);
        }
      }

      return startedTasks;
    });
  }

  private async startTask(task: Task): Promise<Task | null> {
    try {
      let currentTask = task;

      if (!currentTask.worktree) {
        const worktreePath = await this.worktreeManager.createWorktree(
          currentTask.repoPath,
          currentTask.id,
          currentTask.baseRef || currentTask.baseCommitSha
        );
        await this.stateManager.updateTask(currentTask.id, { worktree: worktreePath });
        currentTask = {
          ...currentTask,
          worktree: worktreePath,
        };
      }

      if (!currentTask.baseCommitSha) {
        const baseCommitSha = resolveHeadCommit(currentTask.worktree);
        if (baseCommitSha) {
          await this.stateManager.updateTask(currentTask.id, { baseCommitSha });
          currentTask = {
            ...currentTask,
            baseCommitSha,
          };
        }
      }

      this.bootstrapWorktreeDepsFn(currentTask.worktree, {
        repoPath: currentTask.repoPath,
        logPath: currentTask.logPath,
      });

      const startTime = this.now();
      await this.stateManager.updateTask(currentTask.id, {
        status: 'running',
        startTime,
        endTime: undefined,
        currentUS: undefined,
        loopCount: 0,
        consecutiveNoProgress: 0,
        consecutiveErrors: 0,
        lastProgressTime: startTime,
        lastFilesChanged: 0,
        leaseOwner: `scheduler:${process.pid}`,
        leaseHeartbeatAt: startTime,
        leaseExpiresAt: startTime + this.getRunningLeaseTimeoutMs(),
        coordinationStatus: undefined,
        coordinationPhase: undefined,
        coordinationBlockers: undefined,
        coordinationReason: undefined,
      });
      currentTask = {
        ...currentTask,
        status: 'running',
        startTime,
        endTime: undefined,
        currentUS: undefined,
        loopCount: 0,
        consecutiveNoProgress: 0,
        consecutiveErrors: 0,
        lastProgressTime: startTime,
        lastFilesChanged: 0,
      };

      const workerPath = path.join(__dirname, '../worker.js');
      const child = this.forkProcessFn(workerPath, [currentTask.id], {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          RALPH_HOME: this.ralphHome,
        },
      });

      child.disconnect?.();
      child.unref?.();

      if (!child.pid) {
        throw new Error(`Worker process for task ${currentTask.id} did not expose a PID`);
      }

      await this.stateManager.updateTask(currentTask.id, {
        pid: child.pid,
        leaseOwner: `worker:${child.pid}`,
        leaseHeartbeatAt: this.now(),
        leaseExpiresAt: this.now() + this.getRunningLeaseTimeoutMs(),
      });
      appendTaskEvent(currentTask, {
        type: 'task_started',
        status: 'running',
        message: `Worker process started for task ${currentTask.id}`,
        data: {
          pid: child.pid,
          worktree: currentTask.worktree,
          baseRef: currentTask.baseRef,
          baseCommitSha: currentTask.baseCommitSha,
        },
      });

      return await this.stateManager.loadTask(currentTask.id);
    } catch (error) {
      console.error(`Failed to start task ${task.id}:`, error);
      await this.stateManager.updateTask(task.id, {
        status: 'failed',
        endTime: this.now(),
        pid: undefined,
        leaseOwner: undefined,
        leaseHeartbeatAt: undefined,
        leaseExpiresAt: undefined,
        lastError: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquireLock();

    try {
      return await operation();
    } finally {
      this.releaseLock();
    }
  }

  private async acquireLock(): Promise<void> {
    const startedAt = this.now();
    const lockRoot = path.dirname(this.lockDir);

    if (!fs.existsSync(lockRoot)) {
      fs.mkdirSync(lockRoot, { recursive: true });
    }

    while (true) {
      try {
        fs.mkdirSync(this.lockDir);
        fs.writeFileSync(this.lockInfoPath, JSON.stringify({
          pid: process.pid,
          acquiredAt: this.now(),
        }));
        return;
      } catch (error) {
        const lockError = error as NodeJS.ErrnoException;
        if (lockError.code !== 'EEXIST') {
          throw lockError;
        }

        if (this.isLockStale()) {
          fs.rmSync(this.lockDir, { recursive: true, force: true });
          continue;
        }

        if (this.now() - startedAt >= LOCK_TIMEOUT_MS) {
          throw new Error('Timed out waiting for the Ralph scheduler lock');
        }

        await this.sleep(LOCK_RETRY_MS);
      }
    }
  }

  private releaseLock(): void {
    fs.rmSync(this.lockDir, { recursive: true, force: true });
  }

  private isLockStale(): boolean {
    try {
      if (fs.existsSync(this.lockInfoPath)) {
        const content = fs.readFileSync(this.lockInfoPath, 'utf-8');
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

      const stats = fs.statSync(this.lockDir);
      return this.now() - stats.mtimeMs > LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
}

export async function schedulePendingTasks(deps: SchedulerDeps = {}): Promise<Task[]> {
  const scheduler = new TaskScheduler(deps);
  return scheduler.schedulePendingTasks();
}

export async function finalizeTask(
  task: Task,
  status: TerminalTaskStatus,
  deps: SchedulerDeps = {}
): Promise<void> {
  const stateManager = deps.stateManager ?? new StateManager();
  const now = deps.now ?? (() => Date.now());
  const conflictReservationSurface = status === 'failed' && task.worktree && hasHotConflictReservation(task)
    ? captureObservedTaskSurface(task)
    : {};

  task.status = status;
  task.endTime = now();
  task.currentUS = undefined;
  task.pid = undefined;
  task.leaseOwner = undefined;
  task.leaseHeartbeatAt = undefined;
  task.leaseExpiresAt = undefined;

  await stateManager.updateTask(task.id, {
    status: task.status,
    endTime: task.endTime,
    currentUS: undefined,
    pid: undefined,
    leaseOwner: undefined,
    leaseHeartbeatAt: undefined,
    leaseExpiresAt: undefined,
    ...conflictReservationSurface,
  });
  appendTaskEvent(task, {
    type: 'task_terminal',
    status,
    message: `Task moved to ${status}`,
  });

  const scheduler = new TaskScheduler({
    ...deps,
    stateManager,
  });

  try {
    await scheduler.schedulePendingTasks();
  } catch (error) {
    console.error('Failed to schedule pending tasks after terminal transition:', error);
  }
}

export async function markTaskReadyToFinalize(
  task: Task,
  deps: SchedulerDeps = {}
): Promise<void> {
  const stateManager = deps.stateManager ?? new StateManager();
  const now = deps.now ?? (() => Date.now());
  const coordinationSurface = task.worktree
    ? captureObservedTaskSurface(task)
    : {};
  const readyAt = now();

  task.status = 'ready_to_finalize';
  task.endTime = undefined;
  task.currentUS = undefined;
  task.pid = undefined;
  task.repairContext = undefined;
  task.leaseOwner = undefined;
  task.leaseHeartbeatAt = undefined;
  task.leaseExpiresAt = undefined;
  task.lastProgressTime = readyAt;
  task.autoRecoveryKind = undefined;
  task.autoRecoveryNextEligibleAt = undefined;
  task.autoRecoveryStoppedAt = undefined;
  task.autoRecoveryStopReason = undefined;

  await stateManager.updateTask(task.id, {
    status: task.status,
    endTime: undefined,
    currentUS: undefined,
    pid: undefined,
    repairContext: undefined,
    leaseOwner: undefined,
    leaseHeartbeatAt: undefined,
    leaseExpiresAt: undefined,
    lastProgressTime: readyAt,
    autoRecoveryKind: undefined,
    autoRecoveryNextEligibleAt: undefined,
    autoRecoveryStoppedAt: undefined,
    autoRecoveryStopReason: undefined,
    ...coordinationSurface,
  });
  appendTaskEvent(task, {
    type: 'task_ready_to_finalize',
    status: 'ready_to_finalize',
    message: 'Task implementation completed and is ready to finalize',
  });

  const scheduler = new TaskScheduler({
    ...deps,
    stateManager,
  });

  try {
    await scheduler.schedulePendingTasks();
  } catch (error) {
    console.error('Failed to schedule pending tasks after marking task ready to finalize:', error);
  }
}
