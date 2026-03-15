import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

export interface BootstrapResult {
  bootstrapped: boolean;
  packageManager: PackageManager | null;
  installRoot: string | null;
  message: string;
}

export interface BootstrapOptions {
  repoPath?: string;
  logPath?: string;
  commandRunner?: CommandRunner;
  logger?: BootstrapLogger;
}

interface PackageManifest {
  packageManager?: string;
  workspaces?: string[] | { packages?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  bundledDependencies?: string[];
  bundleDependencies?: string[];
}

interface BootstrapInspection {
  installRoot: string | null;
  packageManager: PackageManager | null;
  needsInstall: boolean;
  reason: string;
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type CommandRunner = (
  command: string,
  args: string[],
  cwd: string
) => CommandResult;
export type BootstrapLogger = (
  message: string,
  level?: 'info' | 'error'
) => void;

const PACKAGE_MANAGER_PRIORITY: PackageManager[] = ['pnpm', 'yarn', 'bun', 'npm'];
const LOCKFILE_MAP: Record<PackageManager, string[]> = {
  pnpm: ['pnpm-lock.yaml'],
  yarn: ['yarn.lock'],
  bun: ['bun.lockb', 'bun.lock'],
  npm: ['package-lock.json'],
};
const INSTALL_ATTEMPTS: Record<PackageManager, string[][]> = {
  pnpm: [['install', '--frozen-lockfile'], ['install']],
  yarn: [['install', '--immutable'], ['install', '--frozen-lockfile'], ['install']],
  bun: [['install', '--frozen-lockfile'], ['install']],
  npm: [['ci'], ['install']],
};

function normalizeOptions(
  repoPathOrOptions?: string | BootstrapOptions
): BootstrapOptions {
  if (typeof repoPathOrOptions === 'string') {
    return { repoPath: repoPathOrOptions };
  }

  return repoPathOrOptions ?? {};
}

function createLogger(
  logPath?: string,
  logger?: BootstrapLogger
): BootstrapLogger {
  if (logger) {
    return logger;
  }

  return (message, level = 'info') => {
    const line = `[Bootstrap] ${message}`;
    process.stderr.write(`${line}\n`);

    if (!logPath) {
      return;
    }

    const logDir = path.dirname(logPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    fs.appendFileSync(logPath, `${line}\n`);
  };
}

function resolveGitTopLevel(dir: string): string | null {
  if (!fs.existsSync(dir)) {
    return null;
  }

  try {
    const output = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    return output.trim() ? path.resolve(output.trim()) : null;
  } catch {
    return null;
  }
}

function uniqueDirs(dirs: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const dir of dirs) {
    if (!dir) {
      continue;
    }

    const resolved = path.resolve(dir);
    if (seen.has(resolved)) {
      continue;
    }

    seen.add(resolved);
    result.push(resolved);
  }

  return result;
}

function hasPackageJson(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'package.json'));
}

function hasLockfile(dir: string): boolean {
  return PACKAGE_MANAGER_PRIORITY.some((packageManager) =>
    LOCKFILE_MAP[packageManager].some((lockfile) =>
      fs.existsSync(path.join(dir, lockfile))
    )
  );
}

function readManifest(dir: string): PackageManifest | null {
  const packageJsonPath = path.join(dir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as PackageManifest;
  } catch {
    return null;
  }
}

function hasWorkspaceConfig(dir: string, manifest: PackageManifest | null): boolean {
  if (
    fs.existsSync(path.join(dir, 'pnpm-workspace.yaml')) ||
    fs.existsSync(path.join(dir, 'pnpm-workspace.yml'))
  ) {
    return true;
  }

  const workspaces = manifest?.workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.length > 0;
  }

  return Boolean(workspaces && Array.isArray(workspaces.packages) && workspaces.packages.length > 0);
}

function resolveScopedWorktreePath(
  worktreeRoot: string,
  repoPath?: string
): string | null {
  if (!repoPath) {
    return null;
  }

  const repoTopLevel = resolveGitTopLevel(repoPath) ?? path.resolve(repoPath);
  const relativeScope = path.relative(repoTopLevel, path.resolve(repoPath));

  if (
    !relativeScope ||
    relativeScope === '.' ||
    relativeScope.startsWith('..')
  ) {
    return null;
  }

  const scopedPath = path.join(worktreeRoot, relativeScope);
  return fs.existsSync(scopedPath) ? scopedPath : null;
}

function hasDependencyEntries(manifest: PackageManifest | null): boolean {
  if (!manifest) {
    return false;
  }

  const dependencyKeys: Array<keyof PackageManifest> = [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
  ];

  for (const key of dependencyKeys) {
    const value = manifest[key];
    if (value && Object.keys(value as Record<string, string>).length > 0) {
      return true;
    }
  }

  const bundled = manifest.bundledDependencies ?? manifest.bundleDependencies;
  return Array.isArray(bundled) && bundled.length > 0;
}

function projectNeedsInstall(dir: string, manifest: PackageManifest | null): boolean {
  return hasDependencyEntries(manifest) || hasWorkspaceConfig(dir, manifest);
}

function parsePackageManagerField(value: string | undefined): PackageManager | null {
  if (!value) {
    return null;
  }

  const name = value.split('@')[0];
  if (PACKAGE_MANAGER_PRIORITY.includes(name as PackageManager)) {
    return name as PackageManager;
  }

  return null;
}

function getNodeModulesEntries(nodeModulesPath: string): string[] {
  try {
    return fs.readdirSync(nodeModulesPath).filter((entry) => entry !== '.cache');
  } catch {
    return [];
  }
}

function hasInstallArtifacts(installRoot: string, packageManager: PackageManager): boolean {
  if (
    packageManager === 'yarn' &&
    (
      fs.existsSync(path.join(installRoot, '.pnp.cjs')) ||
      fs.existsSync(path.join(installRoot, '.pnp.js')) ||
      fs.existsSync(path.join(installRoot, '.yarn', 'install-state.gz'))
    )
  ) {
    return true;
  }

  const nodeModulesPath = path.join(installRoot, 'node_modules');
  if (!fs.existsSync(nodeModulesPath)) {
    return false;
  }

  const entries = getNodeModulesEntries(nodeModulesPath);
  if (entries.length === 0) {
    return false;
  }

  if (packageManager === 'pnpm') {
    return (
      entries.includes('.pnpm') ||
      fs.existsSync(path.join(nodeModulesPath, '.modules.yaml'))
    );
  }

  return true;
}

function defaultCommandRunner(
  command: string,
  args: string[],
  cwd: string
): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5 * 60 * 1000,
  });

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(' ');
}

function formatFailure(result: CommandResult): string {
  const combinedOutput = [result.stderr, result.stdout]
    .filter((value) => value.trim().length > 0)
    .join('\n')
    .trim();

  if (combinedOutput.length > 0) {
    const lines = combinedOutput.split(/\r?\n/);
    return lines.slice(-10).join('\n');
  }

  if (result.error) {
    return result.error.message;
  }

  return `exit code ${result.status ?? 'unknown'}`;
}

function runInstall(
  packageManager: PackageManager,
  cwd: string,
  commandRunner: CommandRunner,
  logger: BootstrapLogger
): void {
  const attempts = INSTALL_ATTEMPTS[packageManager];
  let lastFailure = `Unable to install dependencies with ${packageManager}`;

  for (let index = 0; index < attempts.length; index++) {
    const args = attempts[index];
    logger(`Running ${formatCommand(packageManager, args)} in ${cwd}`);

    const result = commandRunner(packageManager, args, cwd);
    if (result.status === 0) {
      return;
    }

    const commandError = result.error as NodeJS.ErrnoException | undefined;
    if (commandError?.code === 'ENOENT') {
      throw new Error(`${packageManager} is not available in PATH`);
    }

    lastFailure = `${formatCommand(packageManager, args)} failed: ${formatFailure(result)}`;

    if (index < attempts.length - 1) {
      logger(`${lastFailure}. Retrying with ${formatCommand(packageManager, attempts[index + 1])}.`);
    }
  }

  throw new Error(lastFailure);
}

function inspectBootstrap(
  worktreePath: string,
  repoPath?: string
): BootstrapInspection {
  const installRoot = findInstallRoot(worktreePath, repoPath);
  if (!installRoot) {
    return {
      installRoot: null,
      packageManager: null,
      needsInstall: false,
      reason: 'No package.json found in the worktree; skipping dependency bootstrap',
    };
  }

  const worktreeRoot = resolveGitTopLevel(worktreePath) ?? path.resolve(worktreePath);
  const scopedPath = resolveScopedWorktreePath(worktreeRoot, repoPath);
  const installManifest = readManifest(installRoot);
  const scopedManifest =
    scopedPath && scopedPath !== installRoot ? readManifest(scopedPath) : null;

  if (!installManifest && !scopedManifest) {
    return {
      installRoot,
      packageManager: null,
      needsInstall: false,
      reason: `No package.json found in ${installRoot}; skipping dependency bootstrap`,
    };
  }

  const installRootNeedsInstall = projectNeedsInstall(installRoot, installManifest);
  const scopedPathNeedsInstall =
    scopedPath && scopedPath !== installRoot
      ? projectNeedsInstall(scopedPath, scopedManifest)
      : false;

  if (!installRootNeedsInstall && !scopedPathNeedsInstall) {
    return {
      installRoot,
      packageManager: null,
      needsInstall: false,
      reason: `No dependency install signals found at ${installRoot}; skipping dependency bootstrap`,
    };
  }

  const packageManager = detectPackageManager(worktreePath, repoPath);
  if (!packageManager) {
    return {
      installRoot,
      packageManager: null,
      needsInstall: false,
      reason: `No package manager detected for ${installRoot}; skipping dependency bootstrap`,
    };
  }

  if (!hasInstallArtifacts(installRoot, packageManager)) {
    return {
      installRoot,
      packageManager,
      needsInstall: true,
      reason: `Missing local install artifacts in ${installRoot}`,
    };
  }

  return {
    installRoot,
    packageManager,
    needsInstall: false,
    reason: `Dependencies already bootstrapped in ${installRoot}`,
  };
}

export function detectPackageManager(
  dir: string,
  repoRoot?: string
): PackageManager | null {
  const worktreeRoot = resolveGitTopLevel(dir) ?? path.resolve(dir);
  const repoPath = repoRoot ? path.resolve(repoRoot) : null;
  const repoTopLevel = repoRoot ? resolveGitTopLevel(repoRoot) : null;
  const scopedPath = resolveScopedWorktreePath(worktreeRoot, repoRoot);
  const installRoot = findInstallRoot(dir, repoRoot);
  const detectionDirs = uniqueDirs([
    installRoot,
    worktreeRoot,
    scopedPath,
    repoPath,
    repoTopLevel,
  ]);

  for (const packageManager of PACKAGE_MANAGER_PRIORITY) {
    const lockfiles = LOCKFILE_MAP[packageManager];
    if (
      detectionDirs.some((candidateDir) =>
        lockfiles.some((lockfile) => fs.existsSync(path.join(candidateDir, lockfile)))
      )
    ) {
      return packageManager;
    }
  }

  for (const packageManager of PACKAGE_MANAGER_PRIORITY) {
    if (
      detectionDirs.some((candidateDir) => {
        const manifest = readManifest(candidateDir);
        return parsePackageManagerField(manifest?.packageManager) === packageManager;
      })
    ) {
      return packageManager;
    }
  }

  return detectionDirs.some((candidateDir) => hasPackageJson(candidateDir))
    ? 'npm'
    : null;
}

export function findInstallRoot(
  dir: string,
  repoRoot?: string
): string | null {
  const resolvedDir = path.resolve(dir);
  const worktreeRoot = resolveGitTopLevel(resolvedDir) ?? resolvedDir;
  const worktreeManifest = readManifest(worktreeRoot);
  const scopedPath = resolveScopedWorktreePath(worktreeRoot, repoRoot);

  if (
    hasLockfile(worktreeRoot) ||
    hasWorkspaceConfig(worktreeRoot, worktreeManifest)
  ) {
    return worktreeRoot;
  }

  if (
    scopedPath &&
    hasPackageJson(scopedPath) &&
    (
      hasLockfile(scopedPath) ||
      !hasPackageJson(worktreeRoot) ||
      !projectNeedsInstall(worktreeRoot, worktreeManifest)
    )
  ) {
    return scopedPath;
  }

  if (hasPackageJson(worktreeRoot)) {
    return worktreeRoot;
  }

  let current = resolvedDir;
  while (true) {
    if (hasPackageJson(current) || hasLockfile(current)) {
      return current;
    }

    if (current === worktreeRoot) {
      break;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }

    current = parent;
  }

  return null;
}

export function needsBootstrap(dir: string, repoRoot?: string): boolean {
  return inspectBootstrap(dir, repoRoot).needsInstall;
}

export function bootstrapWorktreeDeps(
  worktreePath: string,
  repoPathOrOptions?: string | BootstrapOptions
): BootstrapResult {
  const options = normalizeOptions(repoPathOrOptions);
  const logger = createLogger(options.logPath, options.logger);
  const inspection = inspectBootstrap(worktreePath, options.repoPath);

  logger(inspection.reason);

  if (!inspection.needsInstall || !inspection.installRoot || !inspection.packageManager) {
    return {
      bootstrapped: false,
      packageManager: inspection.packageManager,
      installRoot: inspection.installRoot,
      message: inspection.reason,
    };
  }

  logger(
    `Installing dependencies with ${inspection.packageManager} from ${inspection.installRoot}`,
  );
  try {
    runInstall(
      inspection.packageManager,
      inspection.installRoot,
      options.commandRunner ?? defaultCommandRunner,
      logger
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    logger(`Dependency bootstrap failed: ${message}`, 'error');

    return {
      bootstrapped: false,
      packageManager: inspection.packageManager,
      installRoot: inspection.installRoot,
      message,
    };
  }

  logger(
    `Dependencies installed with ${inspection.packageManager} in ${inspection.installRoot}`,
  );

  return {
    bootstrapped: true,
    packageManager: inspection.packageManager,
    installRoot: inspection.installRoot,
    message: `Dependencies installed with ${inspection.packageManager}`,
  };
}
