import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getRalphPaths, RalphHomeOptions } from './paths';

export interface ManagerControlState {
  schemaVersion: 1;
  schedulingPaused: boolean;
  updatedAt?: number;
  pausedAt?: number;
  pausedBy?: string;
  pauseReason?: string;
  resumedAt?: number;
  resumedBy?: string;
}

export interface ManagerControlSnapshot extends ManagerControlState {
  controlPath: string;
  stateExists: boolean;
  readable: boolean;
  error?: 'manager_control_unreadable' | 'manager_control_invalid';
  errorMessage?: string;
}

export interface SetSchedulingPausedOptions extends RalphHomeOptions {
  pausedBy?: string;
  reason?: string;
  now?: () => number;
}

const DEFAULT_MANAGER_CONTROL: ManagerControlState = {
  schemaVersion: 1,
  schedulingPaused: false,
};

export function getManagerControlPath(options: RalphHomeOptions = {}): string {
  return path.join(getRalphPaths(options).managerDir, 'control.json');
}

function ensureParentDir(filePath: string): void {
  const parentDir = path.dirname(filePath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }
}

function sanitizeManagerControl(raw: unknown): ManagerControlState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_MANAGER_CONTROL };
  }

  const value = raw as Record<string, unknown>;
  return {
    schemaVersion: 1,
    schedulingPaused: value.schedulingPaused === true,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : undefined,
    pausedAt: typeof value.pausedAt === 'number' ? value.pausedAt : undefined,
    pausedBy: typeof value.pausedBy === 'string' ? value.pausedBy : undefined,
    pauseReason: typeof value.pauseReason === 'string' ? value.pauseReason : undefined,
    resumedAt: typeof value.resumedAt === 'number' ? value.resumedAt : undefined,
    resumedBy: typeof value.resumedBy === 'string' ? value.resumedBy : undefined,
  };
}

function describeControlReadError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failClosedManagerControl(
  controlPath: string,
  error: ManagerControlSnapshot['error'],
  errorMessage: string,
): ManagerControlSnapshot {
  return {
    schemaVersion: 1,
    schedulingPaused: true,
    pauseReason: error,
    controlPath,
    stateExists: true,
    readable: false,
    error,
    errorMessage,
  };
}

export function readManagerControl(options: RalphHomeOptions = {}): ManagerControlSnapshot {
  const controlPath = getManagerControlPath(options);
  if (!fs.existsSync(controlPath)) {
    return {
      ...DEFAULT_MANAGER_CONTROL,
      controlPath,
      stateExists: false,
      readable: true,
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(controlPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return failClosedManagerControl(
        controlPath,
        'manager_control_invalid',
        'manager control state must be a JSON object',
      );
    }

    if (typeof (parsed as Record<string, unknown>).schedulingPaused !== 'boolean') {
      return failClosedManagerControl(
        controlPath,
        'manager_control_invalid',
        'manager control state is missing boolean schedulingPaused',
      );
    }

    return {
      ...sanitizeManagerControl(parsed),
      controlPath,
      stateExists: true,
      readable: true,
    };
  } catch (error) {
    return failClosedManagerControl(
      controlPath,
      'manager_control_unreadable',
      describeControlReadError(error),
    );
  }
}

export function writeManagerControl(
  state: ManagerControlState,
  options: RalphHomeOptions = {},
): ManagerControlSnapshot {
  const controlPath = getManagerControlPath(options);
  ensureParentDir(controlPath);

  const sanitized = sanitizeManagerControl(state);
  const tempPath = `${controlPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(sanitized, null, 2)}\n`);
  fs.renameSync(tempPath, controlPath);

  return {
    ...sanitized,
    controlPath,
    stateExists: true,
    readable: true,
  };
}

export function setSchedulingPaused(
  schedulingPaused: boolean,
  options: SetSchedulingPausedOptions = {},
): ManagerControlSnapshot {
  const now = options.now?.() ?? Date.now();
  const previous = readManagerControl(options);
  const actor = options.pausedBy || `${os.userInfo().username}@${os.hostname()}`;
  const next: ManagerControlState = {
    ...previous,
    schemaVersion: 1,
    schedulingPaused,
    updatedAt: now,
  };

  if (schedulingPaused) {
    next.pausedAt = previous.schedulingPaused ? previous.pausedAt ?? now : now;
    next.pausedBy = actor;
    next.pauseReason = options.reason?.trim() || previous.pauseReason || 'operator_paused';
    next.resumedAt = undefined;
    next.resumedBy = undefined;
  } else {
    next.schedulingPaused = false;
    next.resumedAt = now;
    next.resumedBy = actor;
    next.pauseReason = undefined;
  }

  return writeManagerControl(next, options);
}
