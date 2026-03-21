import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Task, TaskStatus } from '../types/task';
import { parsePRD } from '../utils/helpers';

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

  async saveTask(task: Task): Promise<void> {
    const taskDir = this.getTaskDir(task.id);
    if (!fs.existsSync(taskDir)) {
      fs.mkdirSync(taskDir, { recursive: true });
    }

    const statePath = this.getStatePath(task.id);
    const tempPath = `${statePath}.tmp`;

    fs.writeFileSync(tempPath, JSON.stringify(task, null, 2));
    fs.renameSync(tempPath, statePath);
  }

  async loadTask(taskId: string): Promise<Task | null> {
    const statePath = this.getStatePath(taskId);
    if (!fs.existsSync(statePath)) {
      return null;
    }

    const content = fs.readFileSync(statePath, 'utf-8');
    return JSON.parse(content) as Task;
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

  async getTaskByPrdId(prdId: string): Promise<Task | null> {
    const tasks = await this.listTasks();

    return tasks.find((task) => {
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
