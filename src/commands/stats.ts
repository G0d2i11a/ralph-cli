import { StateManager } from '../core/state';
import { PRD } from '../types/prd';
import * as fs from 'fs';
import * as path from 'path';

interface UserStoryStats {
  id: string;
  title: string;
  duration: number;
  iterations: number;
  status: string;
}

interface TaskStats {
  taskId: string;
  status: string;
  duration: number;
  userStories: UserStoryStats[];
  totalIterations: number;
  avgIterationTime: number;
  successRate: number;
}

export async function statsCommand(taskId: string, options: { format?: string; all?: boolean }): Promise<void> {
  const stateManager = new StateManager();

  if (options.all) {
    await showAllStats(stateManager, options.format || 'table');
    return;
  }

  if (!taskId) {
    console.error('Error: task-id is required (or use --all)');
    process.exit(1);
  }

  const task = await stateManager.loadTask(taskId);
  if (!task) {
    console.error(`Error: Task ${taskId} not found`);
    process.exit(1);
  }

  const stats = await calculateStats(task, stateManager);
  
  const format = options.format || 'table';
  if (format === 'json') {
    console.log(JSON.stringify(stats, null, 2));
  } else if (format === 'summary') {
    printSummary(stats);
  } else {
    printTable(stats);
  }
}

async function calculateStats(task: any, stateManager: StateManager): Promise<TaskStats> {
  const duration = task.endTime 
    ? Math.round((task.endTime - task.startTime) / 1000)
    : Math.round((Date.now() - task.startTime) / 1000);

  // Load PRD to get User Story info
  let prd: PRD | null = null;
  try {
    if (fs.existsSync(task.prdPath)) {
      const prdContent = fs.readFileSync(task.prdPath, 'utf-8');
      prd = parsePRD(prdContent);
    }
  } catch (error) {
    // PRD not available, use basic info
  }

  // Parse log file for detailed stats
  const logStats = await parseLogFile(task.logPath);

  const userStories: UserStoryStats[] = [];
  const completedUS = task.completedUS || [];
  
  if (prd) {
    for (const us of prd.userStories) {
      const usLog = logStats.userStories[us.id] || {};
      userStories.push({
        id: us.id,
        title: us.title,
        duration: usLog.duration || 0,
        iterations: usLog.iterations || 0,
        status: completedUS.includes(us.id) ? 'completed' : 
                task.currentUS === us.id ? 'in-progress' : 'pending'
      });
    }
  }

  const totalIterations = task.loopCount || userStories.reduce((sum, us) => sum + us.iterations, 0);
  const avgIterationTime = totalIterations > 0 ? duration / totalIterations : 0;
  const successRate = prd ? completedUS.length / prd.userStories.length : 
                      task.status === 'completed' ? 1.0 : 0.0;

  return {
    taskId: task.id,
    status: task.status,
    duration,
    userStories,
    totalIterations,
    avgIterationTime: Math.round(avgIterationTime * 10) / 10,
    successRate: Math.round(successRate * 100) / 100
  };
}

async function parseLogFile(logPath: string): Promise<any> {
  const stats: any = {
    userStories: {}
  };

  if (!fs.existsSync(logPath)) {
    return stats;
  }

  try {
    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.split('\n');

    let currentUS: string | null = null;
    let usStartTime: number | null = null;
    let usIterations: { [key: string]: number } = {};

    for (const line of lines) {
      // Detect User Story start
      const usMatch = line.match(/Starting User Story: (US-\d+)/i) || 
                      line.match(/Processing (US-\d+)/i);
      if (usMatch) {
        const usId = usMatch[1];
        if (currentUS && usStartTime) {
          // Save previous US stats
          const timestamp = extractTimestamp(line);
          if (timestamp) {
            const duration = Math.round((timestamp - usStartTime) / 1000);
            stats.userStories[currentUS] = {
              duration,
              iterations: usIterations[currentUS] || 1
            };
          }
        }
        currentUS = usId;
        usStartTime = extractTimestamp(line);
        usIterations[usId] = (usIterations[usId] || 0) + 1;
      }

      // Detect iteration
      if (currentUS && line.match(/iteration|retry|attempt/i)) {
        usIterations[currentUS] = (usIterations[currentUS] || 0) + 1;
      }
    }

    // Save last US
    if (currentUS && usStartTime) {
      const lastTimestamp = Date.now();
      const duration = Math.round((lastTimestamp - usStartTime) / 1000);
      stats.userStories[currentUS] = {
        duration,
        iterations: usIterations[currentUS] || 1
      };
    }
  } catch (error) {
    // Log parsing failed, return empty stats
  }

  return stats;
}

function extractTimestamp(line: string): number | null {
  // Try to extract timestamp from log line
  const isoMatch = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  if (isoMatch) {
    return new Date(isoMatch[0]).getTime();
  }

  const unixMatch = line.match(/\[(\d{13})\]/);
  if (unixMatch) {
    return parseInt(unixMatch[1]);
  }

  return null;
}

function parsePRD(content: string): PRD | null {
  try {
    // Try JSON format first
    return JSON.parse(content);
  } catch {
    // Parse markdown format
    const lines = content.split('\n');
    const prd: PRD = {
      id: '',
      title: '',
      description: '',
      userStories: []
    };

    let currentSection = '';
    let currentUS: any = null;

    for (const line of lines) {
      if (line.startsWith('# ')) {
        prd.title = line.substring(2).trim();
      } else if (line.match(/^## (US-\d+)/)) {
        if (currentUS) {
          prd.userStories.push(currentUS);
        }
        const match = line.match(/^## (US-\d+):?\s*(.+)/);
        currentUS = {
          id: match![1],
          title: match![2] || '',
          description: '',
          acceptanceCriteria: []
        };
      } else if (currentUS && line.trim()) {
        currentUS.description += line + '\n';
      }
    }

    if (currentUS) {
      prd.userStories.push(currentUS);
    }

    return prd.userStories.length > 0 ? prd : null;
  }
}

function printTable(stats: TaskStats): void {
  console.log(`\n📊 Task Statistics: ${stats.taskId}`);
  console.log(`Status: ${stats.status}`);
  console.log(`Duration: ${formatDuration(stats.duration)}`);
  console.log(`Total Iterations: ${stats.totalIterations}`);
  console.log(`Avg Iteration Time: ${formatDuration(stats.avgIterationTime)}`);
  console.log(`Success Rate: ${(stats.successRate * 100).toFixed(0)}%`);
  
  if (stats.userStories.length > 0) {
    console.log('\n📝 User Stories:');
    console.log('─'.repeat(80));
    console.log(
      'ID'.padEnd(10) + 
      'Title'.padEnd(35) + 
      'Duration'.padEnd(12) + 
      'Iterations'.padEnd(12) + 
      'Status'
    );
    console.log('─'.repeat(80));

    for (const us of stats.userStories) {
      console.log(
        us.id.padEnd(10) +
        truncate(us.title, 33).padEnd(35) +
        formatDuration(us.duration).padEnd(12) +
        us.iterations.toString().padEnd(12) +
        formatStatus(us.status)
      );
    }
    console.log('─'.repeat(80));
  }
  console.log();
}

function printSummary(stats: TaskStats): void {
  const completed = stats.userStories.filter(us => us.status === 'completed').length;
  const total = stats.userStories.length;
  
  console.log(`Task ${stats.taskId}: ${stats.status}`);
  console.log(`Completed ${completed}/${total} User Stories in ${formatDuration(stats.duration)}`);
  console.log(`${stats.totalIterations} iterations, avg ${formatDuration(stats.avgIterationTime)} per iteration`);
}

async function showAllStats(stateManager: StateManager, format: string): Promise<void> {
  const tasks = await stateManager.listTasks();
  
  if (tasks.length === 0) {
    console.log('No tasks found');
    return;
  }

  const allStats: TaskStats[] = [];
  for (const task of tasks) {
    const stats = await calculateStats(task, stateManager);
    allStats.push(stats);
  }

  if (format === 'json') {
    console.log(JSON.stringify(allStats, null, 2));
  } else {
    console.log('\n📊 All Tasks Statistics\n');
    console.log('─'.repeat(100));
    console.log(
      'Task ID'.padEnd(30) +
      'Status'.padEnd(12) +
      'Duration'.padEnd(12) +
      'US Done'.padEnd(12) +
      'Iterations'.padEnd(12) +
      'Success Rate'
    );
    console.log('─'.repeat(100));

    for (const stats of allStats) {
      const completed = stats.userStories.filter(us => us.status === 'completed').length;
      const total = stats.userStories.length;
      
      console.log(
        truncate(stats.taskId, 28).padEnd(30) +
        formatStatus(stats.status).padEnd(12) +
        formatDuration(stats.duration).padEnd(12) +
        `${completed}/${total}`.padEnd(12) +
        stats.totalIterations.toString().padEnd(12) +
        `${(stats.successRate * 100).toFixed(0)}%`
      );
    }
    console.log('─'.repeat(100));
    console.log();
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  } else if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  } else {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${mins}m`;
  }
}

function formatStatus(status: string): string {
  const statusMap: { [key: string]: string } = {
    'completed': '✅ completed',
    'running': '🔄 running',
    'in-progress': '🔄 in-progress',
    'pending': '⏳ pending',
    'failed': '❌ failed',
    'stagnant': '⚠️  stagnant'
  };
  return statusMap[status] || status;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + '...';
}
