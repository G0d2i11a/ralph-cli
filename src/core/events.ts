import * as fs from 'fs';
import * as path from 'path';
import { Task } from '../types/task';

export interface TaskEvent {
  timestamp: number;
  taskId: string;
  type: string;
  status?: string;
  storyId?: string;
  message?: string;
  data?: Record<string, unknown>;
}

export function getTaskEventLogPath(task: Pick<Task, 'logPath' | 'eventLogPath'>): string {
  return task.eventLogPath || path.join(path.dirname(task.logPath), 'events.jsonl');
}

export function appendTaskEvent(
  task: Pick<Task, 'id' | 'logPath' | 'eventLogPath' | 'status'>,
  event: Omit<TaskEvent, 'timestamp' | 'taskId'>
): TaskEvent {
  const taskEvent: TaskEvent = {
    timestamp: Date.now(),
    taskId: task.id,
    status: event.status || task.status,
    ...event,
  };
  const eventLogPath = getTaskEventLogPath(task);
  const eventLogDir = path.dirname(eventLogPath);

  if (!fs.existsSync(eventLogDir)) {
    try {
      fs.mkdirSync(eventLogDir, { recursive: true });
    } catch {
      return taskEvent;
    }
  }

  try {
    fs.appendFileSync(eventLogPath, `${JSON.stringify(taskEvent)}\n`);
  } catch {
    // Event logging must not break task state transitions.
  }
  return taskEvent;
}

export function readTaskEvents(task: Pick<Task, 'logPath' | 'eventLogPath'>): TaskEvent[] {
  const eventLogPath = getTaskEventLogPath(task);
  if (!fs.existsSync(eventLogPath)) {
    return [];
  }

  return fs.readFileSync(eventLogPath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as TaskEvent];
      } catch {
        return [];
      }
    });
}
