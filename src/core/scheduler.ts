import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChildProcess, fork, ForkOptions } from 'child_process';
import { ConfigManager } from '../config/manager';
import { PRD } from '../types/prd';
import { Task, TaskStatus } from '../types/task';
import { checkDependencies, parsePRD } from '../utils/helpers';
import { bootstrapWorktreeDeps } from './bootstrap';
import { StateManager } from './state';
import { WorktreeManager } from './worktree';

const DEFAULT_MAX_CONCURRENT = 3;
const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 30000;
const LOCK_STALE_MS = 300000;

export type TerminalTaskStatus = Exclude<TaskStatus, 'pending' | 'running' | 'ready_to_finalize' | 'finalizing'>;

type DependencyResult = { satisfied: boolean; pending: string[] };
type DependencyChecker = (
  prd: PRD,
  stateManager: StateManager
) => Promise<DependencyResult>;

export interface SchedulerDeps {
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
  lockDir?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PendingTaskState {
  reason: 'dependencies' | 'queued';
  dependencies: string[];
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
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly lockDir: string;
  private readonly lockInfoPath: string;

  constructor(deps: SchedulerDeps = {}) {
    this.stateManager = deps.stateManager ?? new StateManager();
    this.worktreeManager = deps.worktreeManager ?? new WorktreeManager();
    this.configManager = deps.configManager ?? new ConfigManager();
    this.bootstrapWorktreeDepsFn = deps.bootstrapWorktreeDeps ?? bootstrapWorktreeDeps;
    this.parsePRDFn = deps.parsePRD ?? parsePRD;
    this.checkDependenciesFn = deps.checkDependencies ?? checkDependencies;
    this.forkProcessFn = deps.forkProcess ?? fork;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.lockDir = deps.lockDir ?? path.join(os.homedir(), '.ralph', 'scheduler.lock');
    this.lockInfoPath = path.join(this.lockDir, 'owner.json');
  }

  getConcurrencyLimit(): number {
    return resolveConcurrencyLimit(this.configManager);
  }

  async countRunningTasks(): Promise<number> {
    const runningTasks = await this.stateManager.listTasks('running');
    return runningTasks.length;
  }

  async describePendingTask(task: Task): Promise<PendingTaskState> {
    const maxConcurrent = this.getConcurrencyLimit();
    const running = await this.countRunningTasks();
    const prd = this.parsePRDFn(task.prdPath);
    const dependencyState = await this.checkDependenciesFn(prd, this.stateManager);

    if (!dependencyState.satisfied) {
      return {
        reason: 'dependencies',
        dependencies: dependencyState.pending,
        maxConcurrent,
        running,
      };
    }

    return {
      reason: 'queued',
      dependencies: [],
      maxConcurrent,
      running,
    };
  }

  async schedulePendingTasks(): Promise<Task[]> {
    return this.withLock(async () => {
      const startedTasks: Task[] = [];
      const maxConcurrent = this.getConcurrencyLimit();
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
          const prd = this.parsePRDFn(task.prdPath);
          const dependencyState = await this.checkDependenciesFn(prd, this.stateManager);

          if (!dependencyState.satisfied) {
            continue;
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
          currentTask.id
        );
        await this.stateManager.updateTask(currentTask.id, { worktree: worktreePath });
        currentTask = {
          ...currentTask,
          worktree: worktreePath,
        };
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
      });
      currentTask = {
        ...currentTask,
        status: 'running',
        startTime,
        endTime: undefined,
      };

      const workerPath = path.join(__dirname, '../worker.js');
      const child = this.forkProcessFn(workerPath, [currentTask.id], {
        detached: true,
        stdio: 'ignore',
      });

      child.unref?.();

      if (!child.pid) {
        throw new Error(`Worker process for task ${currentTask.id} did not expose a PID`);
      }

      await this.stateManager.updateTask(currentTask.id, {
        pid: child.pid,
      });

      return await this.stateManager.loadTask(currentTask.id);
    } catch (error) {
      console.error(`Failed to start task ${task.id}:`, error);
      await this.stateManager.updateTask(task.id, {
        status: 'failed',
        endTime: this.now(),
        pid: undefined,
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

  task.status = status;
  task.endTime = now();
  task.currentUS = undefined;
  task.pid = undefined;

  await stateManager.saveTask(task);

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
