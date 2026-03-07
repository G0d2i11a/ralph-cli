import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { StateManager } from '../core/state';
import { WorktreeManager } from '../core/worktree';
import { AgentRunner, AgentType } from '../core/agent';
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
    const depCheck = await checkDependencies(prd, stateManager);
    if (!depCheck.satisfied) {
      console.error(JSON.stringify({
        error: `Dependencies not satisfied: ${depCheck.pending.join(', ')}`
      }));
      process.exit(1);
    }
    
    // Generate task ID
    const taskId = generateTaskId();
    
    // Create worktree
    const worktreeManager = new WorktreeManager();
    const worktreePath = await worktreeManager.createWorktree(repoPath, taskId);
    
    // Create log path
    const logDir = path.join(os.homedir(), '.ralph', 'tasks', taskId);
    const logPath = path.join(logDir, 'agent.log');
    
    // Ensure log directory exists
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    // Create task with stagnation fields initialized
    const task: Task = {
      id: taskId,
      prdPath: path.resolve(prdPath),
      status: 'pending',
      startTime: Date.now(),
      completedUS: [],
      worktree: worktreePath,
      logPath,
      agent,
      repoPath,
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: Date.now(),
      lastFilesChanged: 0
    };
    
    // Save task
    await stateManager.saveTask(task);
    
    // Start agent in background
    const runner = new AgentRunner();
    
    // Fork process to run in background
    const { fork } = require('child_process');
    const workerPath = path.join(__dirname, '../worker.js');
    
    const child = fork(workerPath, [taskId], {
      detached: true,
      stdio: 'ignore'
    });
    
    child.unref();
    
    // Update task with PID
    task.pid = child.pid;
    task.status = 'running';
    await stateManager.saveTask(task);
    
    console.log(JSON.stringify({
      taskId,
      status: 'started',
      worktree: worktreePath,
      logPath
    }));
    
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    }));
    process.exit(1);
  }
}
