import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager } from '../config/manager';
import { DEFAULT_AGENT, DEFAULT_BACKEND, resolveAgentBackend, resolveAgentType } from '../core/agent';
import { getRalphPaths, resolveRalphHome } from '../core/paths';

interface InitCommandOptions {
  repo?: string;
  name?: string;
  agent?: string;
  backend?: string;
  maxConcurrent?: string;
  registerMenubar?: boolean;
  menubarConfig?: string;
}

interface MenuBarProjectEntry {
  name: string;
  ralphHome: string;
  repoPath?: string;
}

interface MenuBarConfig {
  ralphHome?: string;
  projects?: MenuBarProjectEntry[];
  selectedProjectId?: string;
  autoDiscoverHomes?: boolean;
  refreshSeconds?: number;
  staleHeartbeatSeconds?: number;
  recentCompletedWindowSeconds?: number;
  recentCompletedLimit?: number;
}

function expandUserPath(value: string): string {
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function resolvePath(value: string): string {
  return path.resolve(expandUserPath(value));
}

function inferProjectName(repoPath: string): string {
  const name = path.basename(repoPath).trim();
  return name || 'default';
}

function parsePositiveInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const numericValue = Number(value);
  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return numericValue;
}

function resolveMenuBarConfigPath(configPath?: string): string {
  if (configPath?.trim()) {
    return resolvePath(configPath.trim());
  }

  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'RalphMenuBar',
    'config.json'
  );
}

function readMenuBarConfig(configPath: string): MenuBarConfig {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function canonicalizeExistingOrResolved(filePath: string): string {
  const resolved = resolvePath(filePath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function writeMenuBarConfig(configPath: string, config: MenuBarConfig): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(tempPath, configPath);
}

function registerMenuBarProject(input: {
  configPath?: string;
  projectName: string;
  ralphHome: string;
  repoPath: string;
}): string {
  const configPath = resolveMenuBarConfigPath(input.configPath);
  const config = readMenuBarConfig(configPath);
  const ralphHome = canonicalizeExistingOrResolved(input.ralphHome);
  const repoPath = canonicalizeExistingOrResolved(input.repoPath);
  const nextProject: MenuBarProjectEntry = {
    name: input.projectName,
    ralphHome,
    repoPath,
  };

  const projects = Array.isArray(config.projects) ? config.projects : [];
  const nextProjects = projects
    .filter((project) => {
      if (!project || typeof project !== 'object') {
        return false;
      }

      const existingHome = typeof project.ralphHome === 'string'
        ? canonicalizeExistingOrResolved(project.ralphHome)
        : '';
      const existingRepo = typeof project.repoPath === 'string'
        ? canonicalizeExistingOrResolved(project.repoPath)
        : '';
      const existingName = typeof project.name === 'string'
        ? project.name.trim().toLowerCase()
        : '';
      const nextName = input.projectName.trim().toLowerCase();

      return existingHome !== ralphHome && existingRepo !== repoPath && existingName !== nextName;
    })
    .concat(nextProject);

  writeMenuBarConfig(configPath, {
    ralphHome: config.ralphHome || ralphHome,
    projects: nextProjects,
    selectedProjectId: ralphHome,
    autoDiscoverHomes: false,
    refreshSeconds: config.refreshSeconds ?? 5,
    staleHeartbeatSeconds: config.staleHeartbeatSeconds ?? 900,
    recentCompletedWindowSeconds: config.recentCompletedWindowSeconds ?? 7200,
    recentCompletedLimit: config.recentCompletedLimit ?? 5,
  });

  return configPath;
}

function inspectRepo(repoPath: string): string[] {
  const warnings: string[] = [];

  try {
    execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    warnings.push('repo is not a valid git worktree');
    return warnings;
  }

  try {
    execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    warnings.push('repo has no valid HEAD; Ralph tasks need an initial commit before worktrees can be created');
  }

  return warnings;
}

export async function initCommand(options: InitCommandOptions = {}): Promise<void> {
  try {
    const repoPath = resolvePath(options.repo || process.cwd());
    if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
      throw new Error(`Repository path does not exist or is not a directory: ${repoPath}`);
    }

    const projectName = options.name?.trim() || inferProjectName(repoPath);
    const ralphHome = resolveRalphHome();
    const paths = getRalphPaths({ ralphHome });
    const agent = resolveAgentType(options.agent || DEFAULT_AGENT);
    const backend = resolveAgentBackend(options.backend || DEFAULT_BACKEND);
    const maxConcurrent = parsePositiveInteger(options.maxConcurrent, '--max-concurrent');

    fs.mkdirSync(paths.tasksDir, { recursive: true });
    fs.mkdirSync(paths.managerDir, { recursive: true });
    fs.mkdirSync(paths.locksDir, { recursive: true });
    fs.mkdirSync(paths.logsDir, { recursive: true });

    const configManager = new ConfigManager({ ralphHome });
    configManager.set('project.name', projectName);
    configManager.set('project.repoPath', repoPath);
    configManager.set('project.initializedAt', new Date().toISOString());
    configManager.set('agent.path', agent);
    configManager.set('agent.backend', backend);
    if (maxConcurrent !== undefined) {
      configManager.set('runner.maxConcurrent', maxConcurrent);
    }

    const shouldRegisterMenuBar = options.registerMenubar !== false;
    const menubarConfigPath = shouldRegisterMenuBar
      ? registerMenuBarProject({
          configPath: options.menubarConfig,
          projectName,
          ralphHome,
          repoPath,
        })
      : undefined;

    const warnings = inspectRepo(repoPath);

    console.log(JSON.stringify({
      success: true,
      projectName,
      repoPath,
      ralphHome,
      configPath: paths.configPath,
      agent,
      backend,
      maxConcurrent: maxConcurrent ?? configManager.get('runner.maxConcurrent'),
      menubarRegistered: shouldRegisterMenuBar,
      menubarConfigPath,
      warnings,
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }, null, 2));
    process.exit(1);
  }
}
