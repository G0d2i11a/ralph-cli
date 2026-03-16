import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { StateManager } from '../core/state';
import { AgentType } from '../core/agent';
import { TaskScheduler } from '../core/scheduler';
import { generateTaskId, parsePRD, checkDependencies } from '../utils/helpers';
import { Task } from '../types/task';

export async function startCommand(
  prdPath: string,
  options: { repo?: string; agent?: string }
): Promise<void> {
  try {
    const repoPath = options.repo || process.cwd();
    const agent = (options.agent || 'claude') as AgentType;
    
    // Parse PRD
    const prd = parsePRD(prdPath);
    
    // Check dependencies
    const stateManager = new StateManager();
    const scheduler = new TaskScheduler({ stateManager });
    
    // Generate task ID
    const taskId = generateTaskId();
    
    // Create log path
    const logDir = path.join(os.homedir(), '.ralph', 'tasks', taskId);
    const logPath = path.join(logDir, 'agent.log');
    
    // Ensure log directory exists
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    const task: Task = {
      id: taskId,
      prdPath: path.resolve(prdPath),
      status: 'pending',
      startTime: Date.now(),
      completedUS: [],
      worktree: '',
      logPath,
      agent,
      repoPath,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 0
    };
    
    await stateManager.saveTask(task);
    await scheduler.schedulePendingTasks();

    const latestTask = await stateManager.loadTask(taskId);
    if (!latestTask) {
      throw new Error(`Task ${taskId} not found after scheduling`);
    }

    if (latestTask.status === 'running') {
      console.log(JSON.stringify({
        taskId,
        status: 'started',
        worktree: latestTask.worktree,
        logPath: latestTask.logPath
      }));
      return;
    }

    if (latestTask.status !== 'pending') {
      throw new Error(`Task ${taskId} could not be scheduled (status: ${latestTask.status})`);
    }

    const depCheck = await checkDependencies(prd, stateManager);
    const pendingState = await scheduler.describePendingTask(latestTask);

    console.log(JSON.stringify({
      taskId,
      status: 'pending',
      reason: pendingState.reason === 'dependencies' ? 'waiting for dependencies' : 'queued',
      dependencies: depCheck.pending,
      concurrencyLimit: pendingState.maxConcurrent,
      message: pendingState.reason === 'dependencies'
        ? 'Task will start automatically when dependencies are completed'
        : 'Task queued and will start automatically when capacity is available'
    }));
    
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    }));
    process.exit(1);
  }
}
