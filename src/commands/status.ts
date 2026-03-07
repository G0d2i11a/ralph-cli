import { StateManager } from '../core/state';
import { isProcessRunning, formatDuration } from '../utils/helpers';
import * as fs from 'fs';
import * as path from 'path';

interface StatusOptions {
  detailed?: boolean;
}

export async function statusCommand(taskId?: string, options?: StatusOptions): Promise<void> {
  try {
    const stateManager = new StateManager();
    
    if (!taskId) {
      // Show all running tasks
      const tasks = await stateManager.listTasks('running');
      console.log(JSON.stringify({
        tasks: tasks.map(t => ({
          id: t.id,
          status: t.status,
          currentUS: t.currentUS,
          completedUS: t.completedUS.length,
          duration: formatDuration(Date.now() - t.startTime),
          running: t.pid ? isProcessRunning(t.pid) : false
        }))
      }));
      return;
    }
    
    // Show specific task
    const task = await stateManager.loadTask(taskId);
    
    if (!task) {
      console.error(JSON.stringify({ error: `Task ${taskId} not found` }));
      process.exit(1);
    }
    
    const running = task.pid ? isProcessRunning(task.pid) : false;
    const duration = task.endTime 
      ? formatDuration(task.endTime - task.startTime)
      : formatDuration(Date.now() - task.startTime);
    
    // Basic status
    const basicStatus = {
      id: task.id,
      status: task.status,
      agent: task.agent,
      prdPath: task.prdPath,
      worktree: task.worktree,
      logPath: task.logPath,
      currentUS: task.currentUS,
      completedUS: task.completedUS,
      duration,
      running,
      pid: task.pid
    };
    
    // If not detailed, return basic status
    if (!options?.detailed) {
      console.log(JSON.stringify(basicStatus));
      return;
    }
    
    // Detailed status (like MCP's get)
    // Read PRD to get user stories
    const prdPath = path.join(task.worktree, 'prd.json');
    let userStories: any[] = [];
    let totalStories = 0;
    let completedStories = 0;
    
    if (fs.existsSync(prdPath)) {
      try {
        const prd = JSON.parse(fs.readFileSync(prdPath, 'utf-8'));
        userStories = prd.userStories || [];
        totalStories = userStories.length;
        completedStories = userStories.filter((s: any) => s.passes).length;
      } catch (e) {
        // Ignore PRD read errors
      }
    }
    
    // Calculate stagnation risk
    const loopCount = task.loopCount || 0;
    const consecutiveNoProgress = task.consecutiveNoProgress || 0;
    const consecutiveErrors = task.consecutiveErrors || 0;
    
    let isAtRisk = false;
    let riskReason = null;
    
    if (consecutiveNoProgress >= 2) {
      isAtRisk = true;
      riskReason = `No file changes for ${consecutiveNoProgress} consecutive updates (threshold: 3)`;
    } else if (consecutiveErrors >= 3) {
      isAtRisk = true;
      riskReason = `${consecutiveErrors} consecutive errors (threshold: 5)`;
    }
    
    // Detailed status
    console.log(JSON.stringify({
      ...basicStatus,
      progress: {
        completed: completedStories,
        total: totalStories,
        percentage: totalStories > 0 ? Math.round((completedStories / totalStories) * 100) : 0
      },
      userStories: userStories.map((s: any) => ({
        id: s.id,
        title: s.title,
        passes: s.passes,
        priority: s.priority,
        notes: s.notes
      })),
      stagnation: {
        loopCount,
        consecutiveNoProgress,
        consecutiveErrors,
        lastError: task.lastError,
        isAtRisk,
        riskReason
      }
    }));
    
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    }));
    process.exit(1);
  }
}
