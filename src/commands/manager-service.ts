import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WatchCommandOptions } from '../core/dependency-watcher';
import { getRalphPaths, hashRalphHome, isDefaultRalphHome, resolveRalphHome } from '../core/paths';

interface ManagerInstallOptions extends WatchCommandOptions {
  label?: string;
  plist?: string;
  dryRun?: boolean;
  load?: boolean;
  disableAutoIngestEz4ielts?: boolean;
}

interface ManagerUninstallOptions {
  label?: string;
  plist?: string;
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

  if (options.disableAutoIngestEz4ielts) {
    args.push('--disable-auto-ingest-ez4ielts');
  } else if (options.autoIngestEz4ielts) {
    args.push('--auto-ingest-ez4ielts');
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
  <string>${escapeXml(process.cwd())}</string>
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

function ensureParentDir(filePath: string): void {
  const parentDir = path.dirname(filePath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }
}

export async function managerInstallCommand(options: ManagerInstallOptions = {}): Promise<void> {
  const ralphHome = resolveRalphHome();
  const label = resolveManagerLabel(options.label);
  const plistPath = resolvePlistPath(label, options.plist);
  const logDir = getRalphPaths({ ralphHome }).logsDir;
  const stdoutPath = path.join(logDir, 'manager.out.log');
  const stderrPath = path.join(logDir, 'manager.err.log');
  const cliPath = resolveCliPath();
  const managerArgs = buildManagerArgs(options);
  const plist = createLaunchdPlist({
    label,
    cliPath,
    managerArgs,
    stdoutPath,
    stderrPath,
  });

  if (!options.dryRun) {
    ensureParentDir(plistPath);
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(plistPath, plist);

    if (options.load) {
      execFileSync('launchctl', ['bootstrap', launchdDomain(), plistPath], {
        stdio: 'ignore',
      });
      execFileSync('launchctl', ['kickstart', '-k', launchdTarget(label)], {
        stdio: 'ignore',
      });
    }
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun: Boolean(options.dryRun),
    loaded: Boolean(options.load && !options.dryRun),
    ralphHome,
    label,
    plistPath,
    cliPath,
    managerArgs,
    stdoutPath,
    stderrPath,
  }));
}

export async function managerUninstallCommand(options: ManagerUninstallOptions = {}): Promise<void> {
  const ralphHome = resolveRalphHome();
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
