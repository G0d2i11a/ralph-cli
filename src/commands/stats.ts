import { StateManager } from '../core/state';
import { readTaskEvents } from '../core/events';
import { loadTaskPRD } from '../utils/helpers';
import * as fs from 'fs';
import { Task } from '../types/task';

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

export async function statsCommand(taskId: string | undefined, options: { format?: string; all?: boolean }): Promise<void> {
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

  const stats = await calculateStats(task);
  const format = options.format || 'table';

  if (format === 'json') {
    console.log(JSON.stringify(stats, null, 2));
  } else if (format === 'summary') {
    printSummary(stats);
  } else {
    printTable(stats);
  }
}

async function calculateStats(task: Task): Promise<TaskStats> {
  const duration = task.endTime
    ? Math.round((task.endTime - task.startTime) / 1000)
    : Math.round((Date.now() - task.startTime) / 1000);

  let userStoriesFromPrd: import('../types/prd').UserStory[] = [];
  try {
    userStoriesFromPrd = loadTaskPRD(task).userStories;
  } catch {
    userStoriesFromPrd = [];
  }

  const logStats = await parseLogFile(task.logPath);
  const eventStats = parseEventStats(task);
  const completedUS = new Set(task.completedUS || []);
  const userStories: UserStoryStats[] = userStoriesFromPrd.map((userStory) => {
    const usLog = logStats.userStories[userStory.id] || {};
    const usEvents = eventStats.userStories[userStory.id] || {};
    const storyProgress = task.storyProgress?.find((story) => story.id === userStory.id);
    return {
      id: userStory.id,
      title: userStory.title,
      duration: usEvents.duration ?? usLog.duration ?? 0,
      iterations: storyProgress?.attempts ?? usEvents.iterations ?? usLog.iterations ?? 0,
      status: storyProgress?.status === 'passed' || completedUS.has(userStory.id) || userStory.passes
        ? 'completed'
        : storyProgress?.status === 'failed'
          ? 'failed'
          : storyProgress?.status === 'needs_repair'
            ? 'needs-repair'
            : task.currentUS === userStory.id || storyProgress?.status === 'in_progress'
          ? 'in-progress'
          : 'pending'
    };
  });

  const totalIterations = task.loopCount || userStories.reduce((sum, userStory) => sum + userStory.iterations, 0);
  const avgIterationTime = totalIterations > 0 ? duration / totalIterations : 0;
  const successRate = userStoriesFromPrd.length > 0
    ? completedUS.size / userStoriesFromPrd.length
    : task.status === 'completed' ? 1.0 : 0.0;

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

function parseEventStats(task: Task): { userStories: Record<string, { duration?: number; iterations?: number }> } {
  const stats = {
    userStories: {} as Record<string, { duration?: number; iterations?: number }>
  };
  const events = readTaskEvents(task);
  const storyStartTimes = new Map<string, number>();
  const storyIterations = new Map<string, number>();

  for (const event of events) {
    if (!event.storyId) {
      continue;
    }

    if (event.type === 'story_attempt_started') {
      if (!storyStartTimes.has(event.storyId)) {
        storyStartTimes.set(event.storyId, event.timestamp);
      }
      storyIterations.set(event.storyId, (storyIterations.get(event.storyId) || 0) + 1);
    }

    if (event.type === 'story_passed' || event.type === 'story_failed') {
      const startedAt = storyStartTimes.get(event.storyId);
      if (startedAt) {
        stats.userStories[event.storyId] = {
          duration: Math.round((event.timestamp - startedAt) / 1000),
          iterations: storyIterations.get(event.storyId) || 1,
        };
      }
    }
  }

  for (const [storyId, iterations] of storyIterations.entries()) {
    stats.userStories[storyId] = {
      ...stats.userStories[storyId],
      iterations,
    };
  }

  return stats;
}

async function parseLogFile(logPath: string): Promise<{ userStories: Record<string, { duration: number; iterations: number }> }> {
  const stats = {
    userStories: {} as Record<string, { duration: number; iterations: number }>
  };

  if (!fs.existsSync(logPath)) {
    return stats;
  }

  try {
    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.split('\n');

    let currentUS: string | null = null;
    let usStartTime: number | null = null;
    const usIterations: Record<string, number> = {};

    for (const line of lines) {
      const usMatch = line.match(/Starting User Story: (US-\d+)/i) || line.match(/Processing (US-\d+)/i);
      if (usMatch) {
        const usId = usMatch[1];
        if (currentUS && usStartTime) {
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

      if (currentUS && line.match(/iteration|retry|attempt/i)) {
        usIterations[currentUS] = (usIterations[currentUS] || 0) + 1;
      }
    }

    if (currentUS && usStartTime) {
      const lastTimestamp = Date.now();
      const duration = Math.round((lastTimestamp - usStartTime) / 1000);
      stats.userStories[currentUS] = {
        duration,
        iterations: usIterations[currentUS] || 1
      };
    }
  } catch {
    // Ignore log parsing failures.
  }

  return stats;
}

function extractTimestamp(line: string): number | null {
  const isoMatch = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  if (isoMatch) {
    return new Date(isoMatch[0]).getTime();
  }

  const unixMatch = line.match(/\[(\d{13})\]/);
  if (unixMatch) {
    return parseInt(unixMatch[1], 10);
  }

  return null;
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

    for (const userStory of stats.userStories) {
      console.log(
        userStory.id.padEnd(10) +
        truncate(userStory.title, 33).padEnd(35) +
        formatDuration(userStory.duration).padEnd(12) +
        userStory.iterations.toString().padEnd(12) +
        formatStatus(userStory.status)
      );
    }
    console.log('─'.repeat(80));
  }
  console.log();
}

function printSummary(stats: TaskStats): void {
  const completed = stats.userStories.filter((userStory) => userStory.status === 'completed').length;
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
    allStats.push(await calculateStats(task));
  }

  if (format === 'json') {
    console.log(JSON.stringify(allStats, null, 2));
    return;
  }

  console.log('\n📊 All Tasks Statistics\n');
  console.log('─'.repeat(100));
  console.log(
    'Task ID'.padEnd(30) +
    'Status'.padEnd(18) +
    'Duration'.padEnd(12) +
    'US Done'.padEnd(12) +
    'Iterations'.padEnd(12) +
    'Success Rate'
  );
  console.log('─'.repeat(100));

  for (const stats of allStats) {
    const completed = stats.userStories.filter((userStory) => userStory.status === 'completed').length;
    const total = stats.userStories.length;

    console.log(
      truncate(stats.taskId, 28).padEnd(30) +
      truncate(formatStatus(stats.status), 16).padEnd(18) +
      formatDuration(stats.duration).padEnd(12) +
      `${completed}/${total}`.padEnd(12) +
      stats.totalIterations.toString().padEnd(12) +
      `${(stats.successRate * 100).toFixed(0)}%`
    );
  }
  console.log('─'.repeat(100));
  console.log();
}

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  }

  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

function formatStatus(status: string): string {
  const statusMap: Record<string, string> = {
    completed: '✅ completed',
    running: '🔄 running',
    'in-progress': '🔄 in-progress',
    pending: '⏳ pending',
    ready_to_finalize: '🧹 ready_to_finalize',
    finalizing: '🧹 finalizing',
    failed: '❌ failed',
    'needs-repair': '🛠 needs-repair',
    failed_finalize: '❌ failed_finalize',
    stagnant: '⚠️ stagnant'
  };
  return statusMap[status] || status;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) {
    return str;
  }
  return `${str.substring(0, maxLen - 3)}...`;
}
