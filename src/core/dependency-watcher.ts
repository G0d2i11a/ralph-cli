import { StateManager } from '../core/state';
import { WorktreeManager } from '../core/worktree';
import { parsePRD, checkDependencies } from '../utils/helpers';
import * as path from 'path';

const { fork } = require('child_process');

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
    const pendingTasks = await this.stateManager.listTasks('pending');

    for (const task of pendingTasks) {
      try {
        // Parse PRD to get dependencies
        const prd = parsePRD(task.prdPath);

        // Check if dependencies are satisfied
        const depCheck = await checkDependencies(prd, this.stateManager);

        if (depCheck.satisfied) {
          console.log(`Dependencies satisfied for task ${task.id}, starting...`);
          await this.startTask(task);
        }
      } catch (error) {
        console.error(`Error processing task ${task.id}:`, error);
      }
    }
  }

  private async startTask(task: any): Promise<void> {
    try {
      // Create worktree if not exists
      if (!task.worktree) {
        const worktreePath = await this.worktreeManager.createWorktree(
          task.repoPath,
          task.id
        );
        task.worktree = worktreePath;
        await this.stateManager.updateTask(task.id, { worktree: worktreePath });
      }

      // Fork worker process
      const workerPath = path.join(__dirname, '../worker.js');
      const child = fork(workerPath, [task.id], {
        detached: true,
        stdio: 'ignore'
      });

      child.unref();

      // Update task status
      await this.stateManager.updateTask(task.id, {
        pid: child.pid,
        status: 'running',
        startTime: Date.now()
      });

      console.log(`Task ${task.id} started (PID: ${child.pid})`);
    } catch (error) {
      console.error(`Failed to start task ${task.id}:`, error);
      await this.stateManager.updateTaskStatus(task.id, 'failed');
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
