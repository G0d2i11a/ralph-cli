import { ConfigManager } from '../config/manager';
import { Task } from '../types/task';

export interface WorkerLeaseStateManager {
  updateTask(taskId: string, updates: Partial<Task>): Promise<void>;
}

export interface WorkerLeaseLogger {
  error(message?: unknown, ...optionalParams: unknown[]): void;
}

export function resolveWorkerLeaseTimeoutMs(configManager: Pick<ConfigManager, 'get'>): number {
  const rawValue = Number(configManager.get('runner.leaseTimeout'));

  if (!Number.isFinite(rawValue) || rawValue <= 0) {
    return 5 * 60 * 1000;
  }

  return rawValue * 1000;
}

export function resolveWorkerLeaseHeartbeatIntervalMs(configManager: Pick<ConfigManager, 'get'>): number {
  const configuredIntervalSeconds = Number(configManager.get('runner.leaseHeartbeatInterval'));

  if (Number.isFinite(configuredIntervalSeconds) && configuredIntervalSeconds > 0) {
    return configuredIntervalSeconds * 1000;
  }

  const leaseTimeoutMs = resolveWorkerLeaseTimeoutMs(configManager);
  return Math.min(60_000, Math.max(5_000, Math.floor(leaseTimeoutMs / 3)));
}

export function createWorkerLeaseUpdate(
  configManager: Pick<ConfigManager, 'get'>,
  pid = process.pid
): Pick<Task, 'leaseOwner' | 'leaseHeartbeatAt' | 'leaseExpiresAt'> {
  const now = Date.now();
  return {
    leaseOwner: `worker:${pid}`,
    leaseHeartbeatAt: now,
    leaseExpiresAt: now + resolveWorkerLeaseTimeoutMs(configManager),
  };
}

export function startWorkerLeaseHeartbeat(
  taskId: string,
  stateManager: WorkerLeaseStateManager,
  configManager: Pick<ConfigManager, 'get'>,
  options: {
    logger?: WorkerLeaseLogger;
    pid?: number;
  } = {}
): { stop: () => void } {
  const intervalMs = resolveWorkerLeaseHeartbeatIntervalMs(configManager);
  let stopped = false;
  let inFlight = false;

  const writeHeartbeat = async () => {
    if (stopped || inFlight) {
      return;
    }

    inFlight = true;
    try {
      await stateManager.updateTask(taskId, createWorkerLeaseUpdate(configManager, options.pid));
    } catch (error) {
      options.logger?.error(`[Worker] Failed to refresh lease heartbeat for task ${taskId}:`, error);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    void writeHeartbeat();
  }, intervalMs);
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
