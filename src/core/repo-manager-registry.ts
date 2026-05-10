import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getManagerStatus } from './manager-state';
import { getDefaultRalphHome, resolveRalphHome } from './paths';

export interface RepoManagerClaim {
  source: 'launchd' | 'manager-state';
  repoPath: string;
  ralphHome: string;
  active: boolean;
  processRunning: boolean;
  heartbeatStale: boolean;
  pid?: number;
  label?: string;
  plistPath?: string;
  statePath?: string;
  argv?: string[];
  message?: string;
}

export interface DuplicateRepoManagerReport {
  repoPath: string;
  currentRalphHome: string;
  duplicateRepoManagers: boolean;
  activeClaims: RepoManagerClaim[];
  otherActiveClaims: RepoManagerClaim[];
}

interface PlistManagerCandidate {
  label?: string;
  plistPath: string;
  ralphHome: string;
  repoPath?: string;
  argv: string[];
}

function unescapeXml(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function extractStringAfterKey(xml: string, key: string): string | undefined {
  const pattern = new RegExp(`<key>\\s*${key}\\s*<\\/key>\\s*<string>([\\s\\S]*?)<\\/string>`, 'm');
  const match = xml.match(pattern);
  return match?.[1] ? unescapeXml(match[1].trim()) : undefined;
}

function extractStringArrayAfterKey(xml: string, key: string): string[] {
  const pattern = new RegExp(`<key>\\s*${key}\\s*<\\/key>\\s*<array>([\\s\\S]*?)<\\/array>`, 'm');
  const match = xml.match(pattern);
  if (!match?.[1]) {
    return [];
  }

  return [...match[1].matchAll(/<string>([\s\S]*?)<\/string>/g)]
    .map((entry) => unescapeXml(entry[1].trim()))
    .filter(Boolean);
}

function extractEnvValue(xml: string, key: string): string | undefined {
  const envPattern = /<key>\s*EnvironmentVariables\s*<\/key>\s*<dict>([\s\S]*?)<\/dict>/m;
  const envMatch = xml.match(envPattern);
  if (!envMatch?.[1]) {
    return undefined;
  }

  return extractStringAfterKey(envMatch[1], key);
}

function readTextFile(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}

function findArgValue(argv: string[], name: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === name) {
      return argv[index + 1];
    }

    if (value.startsWith(`${name}=`)) {
      return value.slice(name.length + 1);
    }
  }

  return undefined;
}

function normalizeMaybePath(value?: string): string | undefined {
  return typeof value === 'string' && value.trim()
    ? path.resolve(value.trim())
    : undefined;
}

function canonicalizeExistingPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isRalphManagerArgv(argv: string[]): boolean {
  const hasCliEntrypoint = argv.some((entry) => /\/ralph$|\/ralph\.js$|dist\/cli\.js/.test(entry));
  const hasManagerSubcommand = argv.includes('manager');
  return hasCliEntrypoint && hasManagerSubcommand;
}

function resolveLaunchAgentDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, 'Library', 'LaunchAgents');
}

function listRalphLaunchdPlists(homeDir: string = os.homedir()): string[] {
  const launchAgentDir = resolveLaunchAgentDir(homeDir);
  if (!fs.existsSync(launchAgentDir)) {
    return [];
  }

  try {
    return fs.readdirSync(launchAgentDir)
      .filter((entry) => entry.endsWith('.plist') && /ralph/i.test(entry))
      .map((entry) => path.join(launchAgentDir, entry))
      .sort();
  } catch {
    return [];
  }
}

export function listLaunchdManagerCandidates(options: { homeDir?: string } = {}): PlistManagerCandidate[] {
  const homeDir = options.homeDir ?? os.homedir();
  return listRalphLaunchdPlists(homeDir)
    .map((plistPath): PlistManagerCandidate | undefined => {
      const xml = readTextFile(plistPath);
      if (!xml) {
        return undefined;
      }

      const argv = extractStringArrayAfterKey(xml, 'ProgramArguments');
      if (!isRalphManagerArgv(argv)) {
        return undefined;
      }

      const label = extractStringAfterKey(xml, 'Label');
      const ralphHome = normalizeMaybePath(extractEnvValue(xml, 'RALPH_HOME') || findArgValue(argv, '--home'))
        ?? getDefaultRalphHome({ homeDir });
      const repoPath = normalizeMaybePath(findArgValue(argv, '--repo'));

      return {
        label,
        plistPath,
        ralphHome,
        repoPath,
        argv,
      };
    })
    .filter((candidate): candidate is PlistManagerCandidate => candidate !== undefined);
}

function buildClaimFromCandidate(candidate: PlistManagerCandidate): RepoManagerClaim | undefined {
  const status = getManagerStatus({ ralphHome: candidate.ralphHome });
  const repoPath = normalizeMaybePath(status.state?.repo) ?? candidate.repoPath;
  if (!repoPath) {
    return undefined;
  }

  return {
    source: 'launchd',
    repoPath,
    ralphHome: canonicalizeExistingPath(candidate.ralphHome),
    active: status.active,
    processRunning: status.processRunning,
    heartbeatStale: status.heartbeatStale,
    pid: status.state?.pid,
    label: candidate.label,
    plistPath: candidate.plistPath,
    statePath: status.statePath,
    argv: status.state?.argv ?? candidate.argv,
    message: status.message,
  };
}

function uniqueClaims(claims: RepoManagerClaim[]): RepoManagerClaim[] {
  const seen = new Set<string>();
  const output: RepoManagerClaim[] = [];

  for (const claim of claims) {
    const key = [
      claim.repoPath,
      claim.ralphHome,
    ].join('\0');
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(claim);
  }

  return output;
}

export function listRepoManagerClaims(options: {
  repoPath?: string;
  currentRalphHome?: string;
  includeCurrentState?: boolean;
  homeDir?: string;
} = {}): RepoManagerClaim[] {
  const targetRepoPath = normalizeMaybePath(options.repoPath);
  const currentRalphHome = canonicalizeExistingPath(options.currentRalphHome ?? resolveRalphHome());
  const claims = listLaunchdManagerCandidates({ homeDir: options.homeDir })
    .map(buildClaimFromCandidate)
    .filter((claim): claim is RepoManagerClaim => Boolean(claim));

  if (options.includeCurrentState !== false) {
    const status = getManagerStatus({ ralphHome: currentRalphHome });
    const repoPath = normalizeMaybePath(status.state?.repo);
    if (repoPath) {
      claims.push({
        source: 'manager-state',
        repoPath,
        ralphHome: currentRalphHome,
        active: status.active,
        processRunning: status.processRunning,
        heartbeatStale: status.heartbeatStale,
        pid: status.state?.pid,
        statePath: status.statePath,
        argv: status.state?.argv,
        message: status.message,
      });
    }
  }

  return uniqueClaims(claims)
    .filter((claim) => !targetRepoPath || path.resolve(claim.repoPath) === targetRepoPath)
    .sort((left, right) => (
      left.repoPath.localeCompare(right.repoPath)
      || left.ralphHome.localeCompare(right.ralphHome)
      || (left.label ?? '').localeCompare(right.label ?? '')
    ));
}

export function detectDuplicateRepoManagers(options: {
  repoPath: string;
  currentRalphHome?: string;
  homeDir?: string;
}): DuplicateRepoManagerReport {
  const repoPath = path.resolve(options.repoPath);
  const currentRalphHome = canonicalizeExistingPath(options.currentRalphHome ?? resolveRalphHome());
  const activeClaims = listRepoManagerClaims({
    repoPath,
    currentRalphHome,
    homeDir: options.homeDir,
  }).filter((claim) => claim.active);
  const activeHomes = new Set(activeClaims.map((claim) => canonicalizeExistingPath(claim.ralphHome)));
  const otherActiveClaims = activeClaims.filter((claim) => canonicalizeExistingPath(claim.ralphHome) !== currentRalphHome);

  return {
    repoPath,
    currentRalphHome,
    duplicateRepoManagers: activeHomes.size > 1,
    activeClaims,
    otherActiveClaims,
  };
}

export function assertNoDuplicateRepoManagers(options: {
  repoPath?: string;
  currentRalphHome?: string;
  operation: string;
  allowDuplicateRepoManagers?: boolean;
}): DuplicateRepoManagerReport | undefined {
  if (!options.repoPath) {
    return undefined;
  }

  const envOverride = process.env.RALPH_ALLOW_DUPLICATE_REPO_MANAGERS?.trim().toLowerCase();
  const allowDuplicateRepoManagers = options.allowDuplicateRepoManagers
    || envOverride === '1'
    || envOverride === 'true'
    || envOverride === 'yes';
  const report = detectDuplicateRepoManagers({
    repoPath: options.repoPath,
    currentRalphHome: options.currentRalphHome,
  });

  if (!allowDuplicateRepoManagers && report.otherActiveClaims.length > 0) {
    const details = report.otherActiveClaims
      .map((claim) => `${claim.ralphHome}${claim.pid ? ` pid=${claim.pid}` : ''}${claim.label ? ` label=${claim.label}` : ''}`)
      .join('; ');
    throw new Error(`Refusing to ${options.operation}: repo ${report.repoPath} is already managed by another active Ralph home (${details}). Stop the duplicate manager or set RALPH_ALLOW_DUPLICATE_REPO_MANAGERS=1 for an explicit override.`);
  }

  return report;
}
