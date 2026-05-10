import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WatchCommandOptions } from '../core/dependency-watcher';
import { getRalphPaths, hashRalphHome, isDefaultRalphHome, resolveRalphHome } from '../core/paths';
import { assertNoDuplicateRepoManagers, listRepoManagerClaims } from '../core/repo-manager-registry';

interface ManagerInstallOptions extends WatchCommandOptions {
  label?: string;
  plist?: string;
  profile?: string;
  dryRun?: boolean;
  load?: boolean;
  disableAutoIngestEz4ielts?: boolean;
}

interface ManagerUninstallOptions {
  label?: string;
  plist?: string;
  repo?: string;
  dryRun?: boolean;
}

const DEFAULT_LABEL = 'com.ralph.manager';

function resolveLaunchAgentDir(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents');
}

function resolvePlistPath(label: string, plistPath?: string): string {
  return path.resolve(plistPath || path.join(resolveLaunchAgentDir(), `${label}.plist`));
}

function resolveManagerLabel(label?: string): string {
  if (typeof label === 'string' && label.trim()) {
    return label.trim();
  }

  const ralphHome = resolveRalphHome();
  return isDefaultRalphHome(ralphHome)
    ? DEFAULT_LABEL
    : `${DEFAULT_LABEL}.${hashRalphHome(ralphHome)}`;
}

function resolveCliPath(): string {
  const cliPath = process.argv[1];
  if (!cliPath) {
    throw new Error('Unable to resolve Ralph CLI path from process.argv[1]');
  }

  return fs.realpathSync(path.resolve(cliPath));
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
    'RALPH_HOME',
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

function buildManagerArgs(options: ManagerInstallOptions): string[] {
  const args = ['manager'];
  const ez4ieltsAutonomous = options.profile === 'ez4ielts-autonomous';

  if (options.interval !== undefined) {
    args.push('--interval', String(options.interval));
  }

  if (options.repo) {
    args.push('--repo', path.resolve(options.repo));
  }

  if (options.agent) {
    args.push('--agent', options.agent);
  }

  if (options.backend) {
    args.push('--backend', options.backend);
  }

  if (options.disableAutoIngestEz4ielts && !ez4ieltsAutonomous) {
    args.push('--disable-auto-ingest-ez4ielts');
  } else if (options.autoIngestEz4ielts || ez4ieltsAutonomous) {
    args.push('--auto-ingest-ez4ielts');
  }

  if (options.ingestExistingEz4ielts) {
    args.push('--ingest-existing-ez4ielts');
  }

  if (options.ez4ieltsDir) {
    args.push('--ez4ielts-dir', path.resolve(options.ez4ieltsDir));
  }

  return args;
}

function createLaunchdPlist(options: {
  label: string;
  cliPath: string;
  managerArgs: string[];
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
}): string {
  const programArguments = [
    process.execPath,
    options.cliPath,
    ...options.managerArgs,
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
  <key>WorkingDirectory</key>
  <string>${escapeXml(options.workingDirectory)}</string>
${envEntries()}  <key>StandardOutPath</key>
  <string>${escapeXml(options.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(options.stderrPath)}</string>
</dict>
</plist>
`;
}

function launchdTarget(label: string): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  return uid === undefined ? label : `gui/${uid}/${label}`;
}

function launchdDomain(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid === undefined) {
    throw new Error('launchd manager install requires a numeric user id');
  }

  return `gui/${uid}`;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tryLaunchctl(args: string[]): boolean {
  try {
    execFileSync('launchctl', args, {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function isLaunchdServiceLoaded(label: string): boolean {
  return tryLaunchctl(['print', launchdTarget(label)]);
}

function waitForLaunchdServiceState(label: string, loaded: boolean, timeoutMs = 3000): boolean {
  const deadline = Date.now() + timeoutMs;

  do {
    if (isLaunchdServiceLoaded(label) === loaded) {
      return true;
    }
    sleepSync(100);
  } while (Date.now() < deadline);

  return isLaunchdServiceLoaded(label) === loaded;
}

function ensureParentDir(filePath: string): void {
  const parentDir = path.dirname(filePath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }
}

function reloadLaunchdService(label: string, plistPath: string): { bootedOut: boolean; bootstrapped: boolean; kickstarted: boolean } {
  const bootedOut = [
    ['bootout', launchdTarget(label)],
    ['bootout', launchdDomain(), plistPath],
    ['remove', label],
  ].some((args) => tryLaunchctl(args));

  if (bootedOut) {
    waitForLaunchdServiceState(label, false);
  }

  let bootstrapped = tryLaunchctl(['bootstrap', launchdDomain(), plistPath]);
  if (!bootstrapped) {
    sleepSync(300);
    bootstrapped = tryLaunchctl(['bootstrap', launchdDomain(), plistPath]);
  }
  if (!bootstrapped) {
    const fallbackBootedOut = tryLaunchctl(['bootout', launchdDomain(), plistPath]);
    if (fallbackBootedOut) {
      waitForLaunchdServiceState(label, false);
    }
    bootstrapped = tryLaunchctl(['bootstrap', launchdDomain(), plistPath]);
  }
  if (!bootstrapped && !isLaunchdServiceLoaded(label)) {
    execFileSync('launchctl', ['bootstrap', launchdDomain(), plistPath], {
      stdio: 'ignore',
    });
    bootstrapped = true;
  }
  if (!bootstrapped && isLaunchdServiceLoaded(label)) {
    // A previous service definition is still loaded; keep it alive but report
    // that this install did not apply the rewritten plist.
    throw new Error(`launchd service ${label} is still loaded and could not be reloaded from ${plistPath}`);
  }

  const kickstarted = tryLaunchctl(['kickstart', '-k', launchdTarget(label)]);

  return {
    bootedOut,
    bootstrapped,
    kickstarted,
  };
}

export async function managerInstallCommand(options: ManagerInstallOptions = {}): Promise<void> {
  const ralphHome = resolveRalphHome();
  const profile = typeof options.profile === 'string' && options.profile.trim()
    ? options.profile.trim()
    : undefined;
  if (profile && profile !== 'ez4ielts-autonomous') {
    throw new Error(`Unknown manager profile: ${profile}`);
  }
  if (profile === 'ez4ielts-autonomous' && !options.ez4ieltsDir) {
    throw new Error('manager-install --profile ez4ielts-autonomous requires --ez4ielts-dir');
  }
  assertNoDuplicateRepoManagers({
    repoPath: options.repo,
    currentRalphHome: ralphHome,
    operation: 'install the Ralph manager service',
  });
  const label = resolveManagerLabel(options.label);
  const plistPath = resolvePlistPath(label, options.plist);
  const logDir = getRalphPaths({ ralphHome }).logsDir;
  const stdoutPath = path.join(logDir, 'manager.out.log');
  const stderrPath = path.join(logDir, 'manager.err.log');
  const cliPath = resolveCliPath();
  const managerArgs = buildManagerArgs(options);
  const workingDirectory = options.repo ? path.resolve(options.repo) : process.cwd();
  const plist = createLaunchdPlist({
    label,
    cliPath,
    managerArgs,
    workingDirectory,
    stdoutPath,
    stderrPath,
  });
  let loadResult: ReturnType<typeof reloadLaunchdService> | undefined;

  if (!options.dryRun) {
    ensureParentDir(plistPath);
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(plistPath, plist);

    if (options.load) {
      loadResult = reloadLaunchdService(label, plistPath);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun: Boolean(options.dryRun),
    loaded: Boolean(options.load && !options.dryRun),
    ralphHome,
    profile,
    label,
    plistPath,
    cliPath,
    managerArgs,
    workingDirectory,
    stdoutPath,
    stderrPath,
    loadResult,
  }));
}

export async function managerUninstallCommand(options: ManagerUninstallOptions = {}): Promise<void> {
  const ralphHome = resolveRalphHome();
  if (options.repo) {
    const targets = listRepoManagerClaims({
      repoPath: path.resolve(options.repo),
      currentRalphHome: ralphHome,
    }).filter((claim) => claim.plistPath && claim.label);
    const results = targets.map((claim) => {
      let unloaded = false;
      let removed = false;

      if (!options.dryRun) {
        try {
          execFileSync('launchctl', ['bootout', launchdTarget(claim.label as string)], {
            stdio: 'ignore',
          });
          unloaded = true;
        } catch {
          unloaded = false;
        }

        if (claim.plistPath && fs.existsSync(claim.plistPath)) {
          fs.rmSync(claim.plistPath, { force: true });
          removed = true;
        }
      }

      return {
        label: claim.label,
        plistPath: claim.plistPath,
        ralphHome: claim.ralphHome,
        pid: claim.pid,
        active: claim.active,
        unloaded,
        removed,
      };
    });

    console.log(JSON.stringify({
      ok: true,
      dryRun: Boolean(options.dryRun),
      repoPath: path.resolve(options.repo),
      ralphHome,
      targetCount: results.length,
      targets: results,
    }));
    return;
  }

  const label = resolveManagerLabel(options.label);
  const plistPath = resolvePlistPath(label, options.plist);
  let unloaded = false;
  let removed = false;

  if (!options.dryRun) {
    try {
      execFileSync('launchctl', ['bootout', launchdTarget(label)], {
        stdio: 'ignore',
      });
      unloaded = true;
    } catch {
      unloaded = false;
    }

    if (fs.existsSync(plistPath)) {
      fs.rmSync(plistPath, { force: true });
      removed = true;
    }
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun: Boolean(options.dryRun),
    ralphHome,
    label,
    plistPath,
    unloaded,
    removed,
  }));
}
