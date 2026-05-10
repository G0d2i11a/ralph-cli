import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isProcessRunning } from '../utils/helpers';
import { getRalphPaths, resolveRalphHome } from './paths';

export type ManagerStateStatus = 'running' | 'stopping' | 'stopped' | 'error';

export interface ManagerRuntimeState {
  pid: number;
  status: ManagerStateStatus;
  startedAt: number;
  updatedAt: number;
  lastHeartbeatAt: number;
  lastLoopStartedAt?: number;
  lastLoopCompletedAt?: number;
  lastError?: string;
  stoppedAt?: number;
  pollIntervalMs: number;
  autoIngestEnabled: boolean;
  autoIngestExistingOnStartup?: boolean;
  repo?: string;
  agent?: string;
  backend?: string;
  ez4ieltsDir?: string;
  hostname: string;
  argv: string[];
}

export interface ManagerStatus {
  ralphHome: string;
  statePath: string;
  lockDir: string;
  state: ManagerRuntimeState | null;
  stateExists: boolean;
  processRunning: boolean;
  active: boolean;
  heartbeatStale: boolean;
  staleAfterMs: number;
  ageMs?: number;
  lastHeartbeatAgeMs?: number;
  managerEntryPath?: string;
  managerEntryModifiedAt?: number;
  managerCodeRootPath?: string;
  managerCodeLatestPath?: string;
  managerCodeLatestModifiedAt?: number;
  codeDriftDetected: boolean;
  codeDriftReason?: string;
  message: string;
}

export interface ManagerStatePaths {
  homeDir?: string;
  ralphHome?: string;
  managerDir?: string;
}

export const DEFAULT_MANAGER_HEARTBEAT_STALE_MS = 15 * 60 * 1000;

interface ManagerCodeInspection {
  entryPath?: string;
  entryModifiedAt?: number;
  codeRootPath?: string;
  latestPath?: string;
  latestModifiedAt?: number;
  codeDriftDetected: boolean;
  codeDriftReason?: string;
}

export function getManagerDir(options: ManagerStatePaths = {}): string {
  return options.managerDir || getRalphPaths(options).managerDir;
}

export function getManagerStatePath(options: ManagerStatePaths = {}): string {
  return options.managerDir
    ? path.join(getManagerDir(options), 'state.json')
    : getRalphPaths(options).managerStatePath;
}

export function getManagerLockDir(options: ManagerStatePaths = {}): string {
  return getRalphPaths(options).managerLockDir;
}

function ensureParentDir(filePath: string): void {
  const parentDir = path.dirname(filePath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }
}

function sanitizeStatePatch(
  state: ManagerRuntimeState
): ManagerRuntimeState {
  const sanitized: ManagerRuntimeState = {
    ...state,
    argv: Array.isArray(state.argv) ? state.argv : [],
    hostname: state.hostname || os.hostname(),
  };

  if (!sanitized.lastError) {
    delete sanitized.lastError;
  }

  return sanitized;
}

function resolveManagerEntryPath(state: ManagerRuntimeState): string | undefined {
  if (!Array.isArray(state.argv) || state.argv.length < 2) {
    return undefined;
  }

  const candidate = typeof state.argv[1] === 'string' ? state.argv[1].trim() : '';
  if (!candidate) {
    return undefined;
  }

  return path.resolve(candidate);
}

function resolveManagerCodeRoot(entryPath: string): string {
  const normalizedEntryPath = path.resolve(entryPath);
  const distSegment = `${path.sep}dist${path.sep}`;
  const distIndex = normalizedEntryPath.lastIndexOf(distSegment);

  if (distIndex >= 0) {
    return normalizedEntryPath.slice(0, distIndex + distSegment.length - 1);
  }

  const entryDir = path.dirname(normalizedEntryPath);
  if (path.basename(entryDir) === 'dist') {
    return entryDir;
  }

  return normalizedEntryPath;
}

function findLatestModifiedEntry(targetPath: string): { path: string; modifiedAt: number } | undefined {
  if (!fs.existsSync(targetPath)) {
    return undefined;
  }

  let latestFile: { path: string; modifiedAt: number } | undefined;
  let latest: { path: string; modifiedAt: number } | undefined;
  const stack = [path.resolve(targetPath)];

  while (stack.length > 0) {
    const currentPath = stack.pop();
    if (!currentPath) {
      continue;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(currentPath);
    } catch {
      continue;
    }

    if (!latest || stat.mtimeMs > latest.modifiedAt) {
      latest = {
        path: currentPath,
        modifiedAt: stat.mtimeMs,
      };
    }

    if (!stat.isDirectory()) {
      if (!latestFile || stat.mtimeMs > latestFile.modifiedAt) {
        latestFile = {
          path: currentPath,
          modifiedAt: stat.mtimeMs,
        };
      }
      continue;
    }

    let entries: string[];
    try {
      entries = fs.readdirSync(currentPath);
    } catch {
      continue;
    }

    for (const entry of entries) {
      stack.push(path.join(currentPath, entry));
    }
  }

  return latestFile ?? latest;
}

function inspectManagerCode(state: ManagerRuntimeState): ManagerCodeInspection {
  const entryPath = resolveManagerEntryPath(state);

  if (!entryPath || !fs.existsSync(entryPath)) {
    return {
      entryPath,
      codeDriftDetected: false,
    };
  }

  let entryModifiedAt: number | undefined;
  try {
    entryModifiedAt = fs.statSync(entryPath).mtimeMs;
  } catch {
    entryModifiedAt = undefined;
  }

  const codeRootPath = resolveManagerCodeRoot(entryPath);
  const latestEntry = findLatestModifiedEntry(codeRootPath);
  const latestModifiedAt = latestEntry?.modifiedAt ?? entryModifiedAt;
  const latestPath = latestEntry?.path ?? entryPath;
  const codeDriftDetected = typeof latestModifiedAt === 'number' && latestModifiedAt > state.startedAt;

  return {
    entryPath,
    entryModifiedAt,
    codeRootPath,
    latestPath,
    latestModifiedAt,
    codeDriftDetected,
    codeDriftReason: codeDriftDetected
      ? `manager started at ${new Date(state.startedAt).toISOString()} before ${latestPath} changed at ${new Date(latestModifiedAt!).toISOString()}`
      : undefined,
  };
}

export function writeManagerState(
  state: ManagerRuntimeState,
  options: ManagerStatePaths = {}
): ManagerRuntimeState {
  const statePath = getManagerStatePath(options);
  ensureParentDir(statePath);

  const sanitizedState = sanitizeStatePatch(state);
  const tempPath = `${statePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(sanitizedState, null, 2));
  fs.renameSync(tempPath, statePath);

  return sanitizedState;
}

export function readManagerState(
  options: ManagerStatePaths = {}
): ManagerRuntimeState | null {
  const statePath = getManagerStatePath(options);

  if (!fs.existsSync(statePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(statePath, 'utf-8');
    return JSON.parse(content) as ManagerRuntimeState;
  } catch {
    return null;
  }
}

export function removeManagerState(options: ManagerStatePaths = {}): void {
  fs.rmSync(getManagerStatePath(options), { force: true });
}

export interface ManagerStateWriterOptions extends ManagerStatePaths {
  pollIntervalMs: number;
  autoIngestEnabled: boolean;
  autoIngestExistingOnStartup?: boolean;
  repo?: string;
  agent?: string;
  backend?: string;
  ez4ieltsDir?: string;
  now?: () => number;
}

export class ManagerStateWriter {
  private state: ManagerRuntimeState | null = null;
  private readonly now: () => number;

  constructor(private readonly options: ManagerStateWriterOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  start(): ManagerRuntimeState {
    const timestamp = this.now();
    this.state = writeManagerState({
      pid: process.pid,
      status: 'running',
      startedAt: timestamp,
      updatedAt: timestamp,
      lastHeartbeatAt: timestamp,
      pollIntervalMs: this.options.pollIntervalMs,
      autoIngestEnabled: this.options.autoIngestEnabled,
      autoIngestExistingOnStartup: this.options.autoIngestExistingOnStartup,
      repo: this.options.repo,
      agent: this.options.agent,
      backend: this.options.backend,
      ez4ieltsDir: this.options.ez4ieltsDir,
      hostname: os.hostname(),
      argv: process.argv.slice(),
    }, this.options);

    return this.state;
  }

  update(patch: Partial<ManagerRuntimeState> = {}): ManagerRuntimeState {
    const timestamp = this.now();
    const previous = this.state ?? readManagerState(this.options);
    const base = previous ?? this.start();

    this.state = writeManagerState({
      ...base,
      ...patch,
      updatedAt: timestamp,
      lastHeartbeatAt: patch.lastHeartbeatAt ?? timestamp,
    }, this.options);

    return this.state;
  }

  loopStarted(): ManagerRuntimeState {
    const timestamp = this.now();
    return this.update({
      status: 'running',
      lastLoopStartedAt: timestamp,
      lastError: undefined,
    });
  }

  loopCompleted(): ManagerRuntimeState {
    const timestamp = this.now();
    return this.update({
      status: 'running',
      lastLoopCompletedAt: timestamp,
      lastError: undefined,
    });
  }

  error(error: unknown): ManagerRuntimeState {
    return this.update({
      status: 'error',
      lastError: error instanceof Error ? error.message : String(error),
    });
  }

  stopping(): ManagerRuntimeState {
    return this.update({
      status: 'stopping',
    });
  }

  stopped(): ManagerRuntimeState {
    const timestamp = this.now();
    return this.update({
      status: 'stopped',
      stoppedAt: timestamp,
      lastHeartbeatAt: timestamp,
    });
  }
}

export function getManagerStatus(options: ManagerStatePaths & {
  now?: () => number;
  staleAfterMs?: number;
  isProcessRunning?: (pid: number) => boolean;
} = {}): ManagerStatus {
  const now = options.now ?? (() => Date.now());
  const state = readManagerState(options);
  const staleAfterMs = Number.isFinite(options.staleAfterMs) && Number(options.staleAfterMs) > 0
    ? Number(options.staleAfterMs)
    : DEFAULT_MANAGER_HEARTBEAT_STALE_MS;

  if (!state) {
    return {
      statePath: getManagerStatePath(options),
      lockDir: getManagerLockDir(options),
      ralphHome: resolveRalphHome(options),
      state: null,
      stateExists: false,
      processRunning: false,
      active: false,
      heartbeatStale: false,
      staleAfterMs,
      codeDriftDetected: false,
      message: 'manager state not found',
    };
  }

  const processChecker = options.isProcessRunning ?? isProcessRunning;
  const processRunning = typeof state.pid === 'number' && processChecker(state.pid);
  const lastHeartbeatAgeMs = Math.max(0, now() - state.lastHeartbeatAt);
  const heartbeatStale = state.status === 'running' && lastHeartbeatAgeMs > staleAfterMs;
  const active = state.status === 'running' && processRunning;
  const codeInspection = inspectManagerCode(state);

  let message = 'manager is stopped';
  if (active && heartbeatStale && codeInspection.codeDriftDetected) {
    message = `manager process ${state.pid} is running but heartbeat is stale and loaded code is older than current code on disk`;
  } else if (active && codeInspection.codeDriftDetected) {
    message = `manager process ${state.pid} is running but loaded code is older than current code on disk`;
  } else if (active && heartbeatStale) {
    message = `manager process ${state.pid} is running but heartbeat is stale`;
  } else if (active) {
    message = `manager process ${state.pid} is running`;
  } else if (state.status === 'running') {
    message = `manager process ${state.pid} is not running`;
  } else if (state.status === 'error') {
    message = state.lastError
      ? `manager stopped after error: ${state.lastError}`
      : 'manager stopped after error';
  }

  return {
    statePath: getManagerStatePath(options),
    lockDir: getManagerLockDir(options),
    ralphHome: resolveRalphHome(options),
    stateExists: true,
    state,
    processRunning,
    active,
    heartbeatStale,
    staleAfterMs,
    ageMs: Math.max(0, now() - state.startedAt),
    lastHeartbeatAgeMs,
    managerEntryPath: codeInspection.entryPath,
    managerEntryModifiedAt: codeInspection.entryModifiedAt,
    managerCodeRootPath: codeInspection.codeRootPath,
    managerCodeLatestPath: codeInspection.latestPath,
    managerCodeLatestModifiedAt: codeInspection.latestModifiedAt,
    codeDriftDetected: codeInspection.codeDriftDetected,
    codeDriftReason: codeInspection.codeDriftReason,
    message,
  };
}
