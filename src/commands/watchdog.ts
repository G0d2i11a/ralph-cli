import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildQueueSnapshot } from './queue';
import { listLaunchdManagerCandidates } from '../core/repo-manager-registry';
import { getDefaultRalphHome } from '../core/paths';

export interface WatchdogCommandOptions {
  interval?: string | number;
  staleAfterMs?: string | number;
  recentCompletedWindowSeconds?: string | number;
  recentCompletedLimit?: string | number;
  homePath?: string[] | string;
  homes?: string;
  log?: string;
  once?: boolean;
  dryRun?: boolean;
  restartCodeDrift?: boolean;
  restartStale?: boolean;
}

export interface WatchdogInstallOptions extends WatchdogCommandOptions {
  label?: string;
  plist?: string;
  load?: boolean;
}

export interface WatchdogUninstallOptions {
  label?: string;
  plist?: string;
  dryRun?: boolean;
}

interface WatchdogHomeTarget {
  ralphHome: string;
  label?: string;
  plistPath?: string;
  repoPath?: string;
}

type QueueSnapshot = Awaited<ReturnType<typeof buildQueueSnapshot>>;

interface WatchdogRestartDecision {
  needed: boolean;
  reasons: string[];
  deferredReason?: string;
}

const DEFAULT_WATCHDOG_LABEL = 'com.ralph.watchdog';
const DEFAULT_WATCHDOG_INTERVAL_MS = 30_000;
const DEFAULT_RECENT_COMPLETED_WINDOW_SECONDS = 7200;
const DEFAULT_RECENT_COMPLETED_LIMIT = 5;

function parsePositiveNumber(value: string | number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : fallback;
}

function normalizePath(value: string): string {
  return path.resolve(value.replace(/^~/, os.homedir()));
}

function canonicalizePath(value: string): string {
  const resolved = normalizePath(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    const canonical = canonicalizePath(value);
    if (seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    output.push(canonical);
  }

  return output;
}

function resolveHomeOptionValues(options: Pick<WatchdogCommandOptions, 'homePath' | 'homes'>): string[] {
  const homePathValues = Array.isArray(options.homePath)
    ? options.homePath
    : typeof options.homePath === 'string'
      ? [options.homePath]
      : [];
  const homesValues = typeof options.homes === 'string'
    ? options.homes.split(',').map((entry) => entry.trim()).filter(Boolean)
    : [];

  return uniqueStrings([...homePathValues, ...homesValues].filter(Boolean));
}

export function resolveWatchdogHomeTargets(options: Pick<WatchdogCommandOptions, 'homePath' | 'homes'> = {}): WatchdogHomeTarget[] {
  const candidates = listLaunchdManagerCandidates();
  const candidateByHome = new Map<string, WatchdogHomeTarget>();

  for (const candidate of candidates) {
    const canonicalHome = canonicalizePath(candidate.ralphHome);
    if (!candidateByHome.has(canonicalHome)) {
      candidateByHome.set(canonicalHome, {
        ralphHome: canonicalHome,
        label: candidate.label,
        plistPath: candidate.plistPath,
        repoPath: candidate.repoPath,
      });
    }
  }

  const explicitHomes = resolveHomeOptionValues(options);
  if (explicitHomes.length > 0) {
    return explicitHomes.map((ralphHome) => {
      const candidate = candidateByHome.get(ralphHome);
      return {
        ...candidate,
        ralphHome,
      };
    });
  }

  const discoveredTargets = [...candidateByHome.values()]
    .sort((left, right) => left.ralphHome.localeCompare(right.ralphHome));
  if (discoveredTargets.length > 0) {
    return discoveredTargets;
  }

  return [{
    ralphHome: canonicalizePath(process.env.RALPH_HOME || getDefaultRalphHome()),
  }];
}

function resolveWatchdogStateDir(): string {
  return path.join(os.homedir(), '.ralph-watchdog');
}

function resolveDefaultLogPath(): string {
  return path.join(resolveWatchdogStateDir(), 'watchdog.jsonl');
}

function ensureParentDir(filePath: string): void {
  const parentDir = path.dirname(filePath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }
}

function appendWatchdogEvent(logPath: string, event: Record<string, unknown>): void {
  ensureParentDir(logPath);
  fs.appendFileSync(logPath, `${JSON.stringify({
    at: new Date().toISOString(),
    ...event,
  })}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function launchdTarget(label: string): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  return uid === undefined ? label : `gui/${uid}/${label}`;
}

function launchdDomain(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid === undefined) {
    throw new Error('launchd commands require a numeric user id');
  }
  return `gui/${uid}`;
}

function tryLaunchctl(args: string[]): boolean {
  try {
    execFileSync('launchctl', args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function kickstartLaunchdService(target: WatchdogHomeTarget, dryRun: boolean): Record<string, unknown> {
  if (!target.label) {
    return {
      attempted: false,
      ok: false,
      reason: 'missing_launchd_label',
    };
  }

  if (dryRun) {
    return {
      attempted: true,
      ok: true,
      dryRun: true,
      label: target.label,
      plistPath: target.plistPath,
    };
  }

  let bootstrapped = false;
  let kickstarted = tryLaunchctl(['kickstart', '-k', launchdTarget(target.label)]);
  if (!kickstarted && target.plistPath && fs.existsSync(target.plistPath)) {
    bootstrapped = tryLaunchctl(['bootstrap', launchdDomain(), target.plistPath]);
    kickstarted = tryLaunchctl(['kickstart', '-k', launchdTarget(target.label)]);
  }

  return {
    attempted: true,
    ok: kickstarted,
    label: target.label,
    plistPath: target.plistPath,
    bootstrapped,
    kickstarted,
  };
}

function hasManagerOwnedFinalizer(snapshot: QueueSnapshot): boolean {
  if ('finalizerLease' in snapshot.manager && snapshot.manager.finalizerLease) {
    return true;
  }

  return snapshot.tasks.some((task: { status?: string }) => task.status === 'finalizing');
}

function hasActiveTaskWork(snapshot: QueueSnapshot): boolean {
  return snapshot.tasks.some((task: {
    status?: string;
    queueState?: { phase?: string };
  }) => (
    task.status === 'running'
    || task.status === 'finalizing'
    || task.queueState?.phase === 'running'
    || task.queueState?.phase === 'finalizing'
  ));
}

export function decideWatchdogRestart(
  snapshot: QueueSnapshot,
  options: Pick<WatchdogCommandOptions, 'restartCodeDrift' | 'restartStale'> = {},
): WatchdogRestartDecision {
  const restartCodeDrift = options.restartCodeDrift !== false;
  const restartStale = options.restartStale !== false;
  const reasons: string[] = [];
  const codeDriftDetected = restartCodeDrift && snapshot.manager.codeDriftDetected;
  const staleOrDown = restartStale && (
    snapshot.manager.heartbeatStale && !('heartbeatStaleSuppressed' in snapshot.manager && snapshot.manager.heartbeatStaleSuppressed === true)
    || snapshot.manager.stateExists && snapshot.manager.state?.status === 'running' && !snapshot.manager.processRunning
    || !snapshot.manager.stateExists
  );

  if (codeDriftDetected) {
    reasons.push('manager_code_drift');
  }

  if (staleOrDown) {
    reasons.push('manager_stale_or_down');
  }

  if (reasons.length === 0) {
    return {
      needed: false,
      reasons,
    };
  }

  if (hasManagerOwnedFinalizer(snapshot)) {
    return {
      needed: true,
      reasons,
      deferredReason: 'manager_owned_finalizer_active',
    };
  }

  if (codeDriftDetected && !staleOrDown && hasActiveTaskWork(snapshot)) {
    return {
      needed: true,
      reasons,
      deferredReason: 'active_tasks_in_flight',
    };
  }

  return {
    needed: true,
    reasons,
  };
}

async function buildSnapshotForHome(
  ralphHome: string,
  options: Required<Pick<WatchdogCommandOptions, 'recentCompletedWindowSeconds' | 'recentCompletedLimit'>> & {
    staleAfterMs?: number;
  },
): Promise<QueueSnapshot> {
  const previousRalphHome = process.env.RALPH_HOME;
  process.env.RALPH_HOME = ralphHome;
  try {
    return await buildQueueSnapshot(
      options.staleAfterMs,
      Number(options.recentCompletedWindowSeconds),
      Number(options.recentCompletedLimit),
      true,
    );
  } finally {
    if (previousRalphHome === undefined) {
      delete process.env.RALPH_HOME;
    } else {
      process.env.RALPH_HOME = previousRalphHome;
    }
  }
}

async function checkWatchdogTarget(
  target: WatchdogHomeTarget,
  options: WatchdogCommandOptions,
): Promise<Record<string, unknown>> {
  const logPath = path.resolve(options.log || resolveDefaultLogPath());
  const snapshot = await buildSnapshotForHome(target.ralphHome, {
    staleAfterMs: options.staleAfterMs === undefined ? undefined : parsePositiveNumber(options.staleAfterMs, 0),
    recentCompletedWindowSeconds: parsePositiveNumber(
      options.recentCompletedWindowSeconds,
      DEFAULT_RECENT_COMPLETED_WINDOW_SECONDS,
    ),
    recentCompletedLimit: parsePositiveNumber(options.recentCompletedLimit, DEFAULT_RECENT_COMPLETED_LIMIT),
  });
  const restartDecision = decideWatchdogRestart(snapshot, options);
  let restartResult: Record<string, unknown> | undefined;

  if (restartDecision.needed && !restartDecision.deferredReason) {
    restartResult = kickstartLaunchdService(target, Boolean(options.dryRun));
    appendWatchdogEvent(logPath, {
      event: 'manager_restart',
      ralphHome: target.ralphHome,
      label: target.label,
      reasons: restartDecision.reasons,
      result: restartResult,
      manager: {
        pid: snapshot.manager.state?.pid,
        active: snapshot.manager.active,
        heartbeatStale: snapshot.manager.heartbeatStale,
        codeDriftDetected: snapshot.manager.codeDriftDetected,
        message: snapshot.manager.message,
      },
    });
  } else if (restartDecision.deferredReason) {
    appendWatchdogEvent(logPath, {
      event: 'manager_restart_deferred',
      ralphHome: target.ralphHome,
      label: target.label,
      reasons: restartDecision.reasons,
      deferredReason: restartDecision.deferredReason,
    });
  }

  const totalActions = (snapshot.actions?.length ?? 0) + (snapshot.systemBlocks?.length ?? 0);
  if (totalActions > 0) {
    appendWatchdogEvent(logPath, {
      event: 'queue_action_detected',
      ralphHome: target.ralphHome,
      label: target.label,
      actionability: snapshot.actionability,
      totalActions,
      actions: snapshot.actions,
      systemBlocks: snapshot.systemBlocks,
    });
  }

  return {
    ralphHome: target.ralphHome,
    label: target.label,
    repoPath: target.repoPath,
    manager: {
      pid: snapshot.manager.state?.pid,
      active: snapshot.manager.active,
      heartbeatStale: snapshot.manager.heartbeatStale,
      codeDriftDetected: snapshot.manager.codeDriftDetected,
      message: snapshot.manager.message,
    },
    actionability: snapshot.actionability,
    totalActions,
    restartDecision,
    restartResult,
  };
}

export async function runWatchdogOnce(options: WatchdogCommandOptions = {}): Promise<Record<string, unknown>> {
  const targets = resolveWatchdogHomeTargets(options);
  const results: Record<string, unknown>[] = [];

  for (const target of targets) {
    try {
      results.push(await checkWatchdogTarget(target, options));
    } catch (error) {
      const logPath = path.resolve(options.log || resolveDefaultLogPath());
      const failure = {
        ralphHome: target.ralphHome,
        label: target.label,
        error: error instanceof Error ? error.message : String(error),
      };
      appendWatchdogEvent(logPath, {
        event: 'snapshot_error',
        ...failure,
      });
      results.push(failure);
    }
  }

  return {
    ok: results.every((result) => !('error' in result)),
    targetCount: targets.length,
    results,
  };
}

export async function watchdogCommand(options: WatchdogCommandOptions = {}): Promise<void> {
  const intervalMs = parsePositiveNumber(options.interval, DEFAULT_WATCHDOG_INTERVAL_MS);

  if (options.once) {
    console.log(JSON.stringify(await runWatchdogOnce(options)));
    return;
  }

  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    while (!stopped) {
      console.log(JSON.stringify(await runWatchdogOnce(options)));
      if (stopped) {
        break;
      }
      await sleep(intervalMs);
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

function resolveCliPath(): string {
  const cliPath = process.argv[1];
  if (!cliPath) {
    throw new Error('Unable to resolve Ralph CLI path from process.argv[1]');
  }

  return fs.realpathSync(path.resolve(cliPath));
}

function resolveLaunchAgentDir(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents');
}

function resolveWatchdogLabel(label?: string): string {
  return typeof label === 'string' && label.trim() ? label.trim() : DEFAULT_WATCHDOG_LABEL;
}

function resolveWatchdogPlistPath(label: string, plistPath?: string): string {
  return path.resolve(plistPath || path.join(resolveLaunchAgentDir(), `${label}.plist`));
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function stringEntry(value: string): string {
  return `    <string>${escapeXml(value)}</string>`;
}

function envEntries(): string {
  const envKeys = [
    'PATH',
    'HOME',
    'SHELL',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
  ];
  const entries = envKeys
    .filter((key) => process.env[key])
    .map((key) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(String(process.env[key]))}</string>`);

  return entries.length > 0
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n${entries.join('\n')}\n  </dict>\n`
    : '';
}

function buildWatchdogArgs(options: WatchdogInstallOptions): string[] {
  const args = ['watchdog'];
  const intervalMs = parsePositiveNumber(options.interval, DEFAULT_WATCHDOG_INTERVAL_MS);
  args.push('--interval', String(intervalMs));

  if (options.staleAfterMs !== undefined) {
    args.push('--stale-after-ms', String(options.staleAfterMs));
  }

  if (options.log) {
    args.push('--log', path.resolve(options.log));
  }

  for (const homePath of resolveHomeOptionValues(options)) {
    args.push('--home-path', homePath);
  }

  if (options.restartCodeDrift === false) {
    args.push('--no-restart-code-drift');
  }

  if (options.restartStale === false) {
    args.push('--no-restart-stale');
  }

  return args;
}

function createWatchdogLaunchdPlist(options: {
  label: string;
  cliPath: string;
  watchdogArgs: string[];
  stdoutPath: string;
  stderrPath: string;
}): string {
  const programArguments = [
    process.execPath,
    options.cliPath,
    ...options.watchdogArgs,
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(options.label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map(stringEntry).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
${envEntries()}  <key>StandardOutPath</key>
  <string>${escapeXml(options.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(options.stderrPath)}</string>
</dict>
</plist>
`;
}

function reloadLaunchdService(label: string, plistPath: string): Record<string, boolean> {
  const bootedOut = [
    ['bootout', launchdTarget(label)],
    ['bootout', launchdDomain(), plistPath],
    ['remove', label],
  ].some((args) => tryLaunchctl(args));
  const bootstrapped = tryLaunchctl(['bootstrap', launchdDomain(), plistPath]);
  const kickstarted = tryLaunchctl(['kickstart', '-k', launchdTarget(label)]);

  return {
    bootedOut,
    bootstrapped,
    kickstarted,
  };
}

export async function watchdogInstallCommand(options: WatchdogInstallOptions = {}): Promise<void> {
  const label = resolveWatchdogLabel(options.label);
  const plistPath = resolveWatchdogPlistPath(label, options.plist);
  const stateDir = resolveWatchdogStateDir();
  const stdoutPath = path.join(stateDir, 'watchdog.out.log');
  const stderrPath = path.join(stateDir, 'watchdog.err.log');
  const cliPath = resolveCliPath();
  const watchdogArgs = buildWatchdogArgs(options);
  const plist = createWatchdogLaunchdPlist({
    label,
    cliPath,
    watchdogArgs,
    stdoutPath,
    stderrPath,
  });
  let loadResult: Record<string, boolean> | undefined;

  if (!options.dryRun) {
    ensureParentDir(plistPath);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(plistPath, plist);
    if (options.load) {
      loadResult = reloadLaunchdService(label, plistPath);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun: Boolean(options.dryRun),
    loaded: Boolean(options.load && !options.dryRun),
    label,
    plistPath,
    cliPath,
    watchdogArgs,
    stdoutPath,
    stderrPath,
    loadResult,
  }));
}

export async function watchdogUninstallCommand(options: WatchdogUninstallOptions = {}): Promise<void> {
  const label = resolveWatchdogLabel(options.label);
  const plistPath = resolveWatchdogPlistPath(label, options.plist);
  let unloaded = false;
  let removed = false;

  if (!options.dryRun) {
    unloaded = tryLaunchctl(['bootout', launchdTarget(label)]);
    if (fs.existsSync(plistPath)) {
      fs.rmSync(plistPath, { force: true });
      removed = true;
    }
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun: Boolean(options.dryRun),
    label,
    plistPath,
    unloaded,
    removed,
  }));
}
