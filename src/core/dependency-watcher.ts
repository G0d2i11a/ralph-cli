import { StateManager } from '../core/state';
import { WorktreeManager } from '../core/worktree';
import { schedulePendingTasks } from './scheduler';

export class DependencyWatcher {
  private stateManager: StateManager;
  private worktreeManager: WorktreeManager;
  private pollInterval: number;
  private isRunning: boolean = false;

  constructor(pollInterval: number = 30000) { // Default: 30 seconds
    this.stateManager = new StateManager();
    this.worktreeManager = new WorktreeManager();
    this.pollInterval = pollInterval;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('Dependency watcher is already running');
      return;
    }

    this.isRunning = true;
    console.log(`Dependency watcher started (polling every ${this.pollInterval / 1000}s)`);

    while (this.isRunning) {
      try {
        await this.checkPendingTasks();
      } catch (error) {
        console.error('Error checking pending tasks:', error);
      }

      // Wait for next poll
      await new Promise(resolve => setTimeout(resolve, this.pollInterval));
    }
  }

  stop(): void {
    this.isRunning = false;
    console.log('Dependency watcher stopped');
  }

  private async checkPendingTasks(): Promise<void> {
    const startedTasks = await schedulePendingTasks({
      stateManager: this.stateManager,
      worktreeManager: this.worktreeManager,
    });

    for (const task of startedTasks) {
      console.log(`Task ${task.id} started (PID: ${task.pid})`);
    }
  }
}

// CLI command handler
export async function watchCommand(options: { interval?: number }): Promise<void> {
  const interval = options.interval || 30000;
  const watcher = new DependencyWatcher(interval);

  // Handle graceful shutdown
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
