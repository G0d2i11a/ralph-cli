import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Task, TaskStatus } from '../types/task';
import { parsePRD } from '../utils/helpers';

export interface SaveTaskOptions {
  allowStaleWrite?: boolean;
}

export class StateManager {
  private baseDir: string;

  constructor() {
    this.baseDir = path.join(os.homedir(), '.ralph', 'tasks');
    this.ensureBaseDir();
  }

  private ensureBaseDir(): void {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  private getTaskDir(taskId: string): string {
    return path.join(this.baseDir, taskId);
  }

  private getStatePath(taskId: string): string {
    return path.join(this.getTaskDir(taskId), 'state.json');
  }

  private readTaskFromDisk(taskId: string): Task | null {
    const statePath = this.getStatePath(taskId);
    if (!fs.existsSync(statePath)) {
      return null;
    }

    const content = fs.readFileSync(statePath, 'utf-8');
    return JSON.parse(content) as Task;
  }

  async saveTask(task: Task, options: SaveTaskOptions = {}): Promise<void> {
    const taskDir = this.getTaskDir(task.id);
    if (!fs.existsSync(taskDir)) {
      fs.mkdirSync(taskDir, { recursive: true });
    }

    const statePath = this.getStatePath(task.id);
    const tempPath = `${statePath}.tmp`;
    const latestTask = this.readTaskFromDisk(task.id);
    const latestRevision = latestTask?.revision ?? 0;
    const taskRevision = task.revision ?? 0;

    if (
      latestTask
      && typeof task.revision === 'number'
      && taskRevision < latestRevision
      && !options.allowStaleWrite
    ) {
      throw new Error(`Stale task write rejected for ${task.id}: revision ${taskRevision} < ${latestRevision}`);
    }

    const nextTask: Task = {
      ...task,
      revision: latestRevision + 1,
      updatedAt: Date.now(),
    };

    fs.writeFileSync(tempPath, JSON.stringify(nextTask, null, 2));
    fs.renameSync(tempPath, statePath);
  }

  async loadTask(taskId: string): Promise<Task | null> {
    return this.readTaskFromDisk(taskId);
  }

  async listTasks(statusFilter?: TaskStatus): Promise<Task[]> {
    if (!fs.existsSync(this.baseDir)) {
      return [];
    }

    const taskDirs = fs.readdirSync(this.baseDir);
    const tasks: Task[] = [];

    for (const taskId of taskDirs) {
      const task = await this.loadTask(taskId);
      if (task && (!statusFilter || task.status === statusFilter)) {
        tasks.push(task);
      }
    }

    return tasks.sort((a, b) => b.startTime - a.startTime);
  }

  async updateTaskStatus(taskId: string, status: TaskStatus, endTime?: number): Promise<void> {
    const task = await this.loadTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    task.status = status;
    if (endTime) {
      task.endTime = endTime;
    }

    await this.saveTask(task);
  }

  async updateTask(taskId: string, updates: Partial<Task>): Promise<void> {
    const task = await this.loadTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    Object.assign(task, updates);
    await this.saveTask(task);
  }

  async getTaskByPrdId(prdId: string, options: { repoPath?: string } = {}): Promise<Task | null> {
    const tasks = await this.listTasks();
    const resolvedRepoPath = options.repoPath ? path.resolve(options.repoPath) : undefined;

    return tasks.find((task) => {
      if (resolvedRepoPath && path.resolve(task.repoPath) !== resolvedRepoPath) {
        return false;
      }

      if (task.prdId) {
        return task.prdId === prdId;
      }

      try {
        return parsePRD(task.prdPath).id === prdId;
      } catch {
        return false;
      }
    }) || null;
  }

  async getTaskByPrdPath(prdPath: string): Promise<Task | null> {
    const resolvedPrdPath = path.resolve(prdPath);
    const tasks = await this.listTasks();

    return tasks.find((task) => path.resolve(task.prdPath) === resolvedPrdPath) || null;
  }
}
