import * as path from 'path';
import { ConfigManager } from '../config/manager';
import { StateManager } from '../core/state';
import { finalizeTaskOutput } from './finalizer';
import { DEFAULT_AGENT, resolveAgentType } from './agent';
import {
  DEFAULT_EZ4IELTS_PATTERN,
  DEFAULT_EZ4IELTS_SETTLE_MS,
  DEFAULT_EZ4IELTS_WATCH_DIR,
  PrdAutoIngestor,
} from './prd-auto-ingest';
import { TaskScheduler } from './scheduler';

export interface WatchCommandOptions {
  interval?: number;
  repo?: string;
  agent?: string;
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
}

export class DependencyWatcher {
  private readonly scheduler: TaskScheduler;
  private readonly pollInterval: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Pick<typeof console, 'log' | 'error'>;
  private readonly autoIngestor?: Pick<PrdAutoIngestor, 'initialize' | 'scan'>;
  private readonly stateManager: StateManager;
  private readonly finalizer: typeof finalizeTaskOutput;
  private isRunning = false;

  constructor(
    options: WatchCommandOptions = {},
    deps: DependencyWatcherDeps = {}
  ) {
    const stateManager = deps.stateManager ?? new StateManager();
    const configManager = deps.configManager ?? new ConfigManager();

    this.stateManager = stateManager;
    this.finalizer = deps.finalizer ?? finalizeTaskOutput;
    this.scheduler = deps.scheduler ?? new TaskScheduler({ stateManager });
    this.pollInterval = options.interval || 30000;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.logger = deps.logger ?? console;

    const autoIngestEnabled = options.autoIngestEz4ielts
      ?? Boolean(configManager.get('ingestion.ez4ielts.enabled'));

    if (deps.autoIngestor) {
      this.autoIngestor = deps.autoIngestor;
      return;
    }

    if (autoIngestEnabled) {
      const settleMs = Number(configManager.get('ingestion.ez4ielts.settleMs'));
      const configuredPattern = configManager.get('ingestion.ez4ielts.pattern');
      const configuredWatchDir = configManager.get('ingestion.ez4ielts.watchDir');
      const watchDir = options.ez4ieltsDir || configuredWatchDir || DEFAULT_EZ4IELTS_WATCH_DIR;
      const repoPath = options.repo || path.dirname(path.resolve(watchDir));

      this.autoIngestor = new PrdAutoIngestor({
        repoPath,
        agent: resolveAgentType(options.agent || DEFAULT_AGENT),
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

    while (this.isRunning) {
      try {
        await this.autoIngestor?.scan();
        await this.finalizeReadyTasks();
        await this.checkPendingTasks();
      } catch (error) {
        this.logger.error('Error checking pending tasks:', error);
      }

      await this.sleep(this.pollInterval);
    }
  }

  stop(): void {
    this.isRunning = false;
    this.logger.log('Dependency watcher stopped');
  }

  async finalizeReadyTasks(): Promise<void> {
    const readyTasks = (await this.stateManager.listTasks('ready_to_finalize'))
      .slice()
      .sort((a, b) => a.startTime - b.startTime);

    for (const task of readyTasks) {
      try {
        await this.stateManager.updateTask(task.id, {
          status: 'finalizing',
          pid: undefined,
          currentUS: undefined,
          endTime: undefined,
        });

        const result = this.finalizer(task);

        await this.stateManager.updateTask(task.id, {
          status: 'completed',
          endTime: Date.now(),
          finalizerCommitMessage: result.commitMessage,
          finalizerCommittedAt: result.committed ? Date.now() : undefined,
        });

        this.logger.log(`Task ${task.id} finalized (${result.message})`);
      } catch (error) {
        await this.stateManager.updateTask(task.id, {
          status: 'failed_finalize',
          endTime: Date.now(),
          lastError: error instanceof Error ? error.message : String(error),
          pid: undefined,
          currentUS: undefined,
        });
        this.logger.error(`Failed to finalize task ${task.id}:`, error);
      }
    }
  }

  async checkPendingTasks(): Promise<void> {
    const startedTasks = await this.scheduler.schedulePendingTasks();

    for (const task of startedTasks) {
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
