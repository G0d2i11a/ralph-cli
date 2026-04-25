import { createHash } from 'crypto';
import * as os from 'os';
import * as path from 'path';

export interface RalphHomeOptions {
  ralphHome?: string;
  homeDir?: string;
}

export interface RalphPaths {
  ralphHome: string;
  configPath: string;
  tasksDir: string;
  managerDir: string;
  managerStatePath: string;
  managerLockDir: string;
  schedulerLockDir: string;
  locksDir: string;
  logsDir: string;
}

export function getDefaultRalphHome(options: Pick<RalphHomeOptions, 'homeDir'> = {}): string {
  const baseHome = options.homeDir ? path.resolve(options.homeDir) : os.homedir();
  return path.join(baseHome, '.ralph');
}

export function resolveRalphHome(options: RalphHomeOptions = {}): string {
  const explicitHome = typeof options.ralphHome === 'string' ? options.ralphHome.trim() : '';
  const envHome = typeof process.env.RALPH_HOME === 'string' ? process.env.RALPH_HOME.trim() : '';
  return path.resolve(explicitHome || envHome || getDefaultRalphHome(options));
}

export function getRalphPaths(options: RalphHomeOptions = {}): RalphPaths {
  const ralphHome = resolveRalphHome(options);

  return {
    ralphHome,
    configPath: path.join(ralphHome, 'config.json'),
    tasksDir: path.join(ralphHome, 'tasks'),
    managerDir: path.join(ralphHome, 'manager'),
    managerStatePath: path.join(ralphHome, 'manager', 'state.json'),
    managerLockDir: path.join(ralphHome, 'manager.lock'),
    schedulerLockDir: path.join(ralphHome, 'scheduler.lock'),
    locksDir: path.join(ralphHome, 'locks'),
    logsDir: path.join(ralphHome, 'logs'),
  };
}

export function isDefaultRalphHome(
  ralphHome: string,
  options: Pick<RalphHomeOptions, 'homeDir'> = {}
): boolean {
  return path.resolve(ralphHome) === getDefaultRalphHome(options);
}

export function hashRalphHome(ralphHome: string): string {
  return createHash('sha1').update(path.resolve(ralphHome)).digest('hex').slice(0, 8);
}
