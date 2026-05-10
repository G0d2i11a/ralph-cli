import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { resolveWorkspacePackageDirs } from './workspaces';
import { buildRalphToolchainEnv } from './toolchain-env';

export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

export interface BootstrapResult {
  bootstrapped: boolean;
  packageManager: PackageManager | null;
  installRoot: string | null;
  needsInstall: boolean;
  installReason?: BootstrapInstallReason;
  message: string;
}

export interface BootstrapOptions {
  repoPath?: string;
  ralphHome?: string;
  logPath?: string;
  commandRunner?: CommandRunner;
  logger?: BootstrapLogger;
  installIfNeeded?: boolean;
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
  installReason?: BootstrapInstallReason;
  reason: string;
}

export type BootstrapInstallReason =
  | 'missing_artifacts'
  | 'next_turbopack_requires_local_install';

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

function hasDependency(manifest: PackageManifest | null, packageName: string): boolean {
  return Boolean(
    manifest?.dependencies?.[packageName]
    || manifest?.devDependencies?.[packageName]
    || manifest?.optionalDependencies?.[packageName]
  );
}

function isInsidePath(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function shouldSkipWorkspaceNodeModulesReuse(workspaceDir: string): string | null {
  const manifest = readManifest(workspaceDir);
  if (hasDependency(manifest, 'next')) {
    return 'Next/Turbopack rejects workspace node_modules symlinks that point outside the project root';
  }

  return null;
}

function hasNextDependencyInWorkspaceTree(installRoot: string, manifest: PackageManifest | null): boolean {
  if (hasDependency(manifest, 'next')) {
    return true;
  }

  return resolveWorkspacePackageDirs(installRoot, manifest).some((workspaceDir) =>
    hasDependency(readManifest(workspaceDir), 'next')
  );
}

function resolveSymlinkTarget(targetPath: string): string | null {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    try {
      return path.resolve(path.dirname(targetPath), fs.readlinkSync(targetPath));
    } catch {
      return null;
    }
  }
}

function isSymlinkToOutside(targetPath: string, rootPath: string): boolean {
  if (!fs.existsSync(targetPath)) {
    return false;
  }

  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(targetPath);
  } catch {
    return false;
  }

  if (!stats.isSymbolicLink()) {
    return false;
  }

  const resolvedTarget = resolveSymlinkTarget(targetPath);
  return !resolvedTarget || !isInsidePath(rootPath, resolvedTarget);
}

function hasExternalSymlinkEntry(nodeModulesPath: string, rootPath: string): boolean {
  if (!fs.existsSync(nodeModulesPath)) {
    return false;
  }

  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(nodeModulesPath);
  } catch {
    return false;
  }

  if (stats.isSymbolicLink()) {
    return isSymlinkToOutside(nodeModulesPath, rootPath);
  }

  if (!stats.isDirectory()) {
    return false;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(nodeModulesPath, { withFileTypes: true });
  } catch {
    return false;
  }

  const directDependencyPaths: string[] = [];
  for (const entry of entries) {
    if (entry.name === '.bin' || entry.name === '.cache' || entry.name === '.pnpm') {
      continue;
    }

    const entryPath = path.join(nodeModulesPath, entry.name);
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      try {
        for (const scopedEntry of fs.readdirSync(entryPath, { withFileTypes: true })) {
          directDependencyPaths.push(path.join(entryPath, scopedEntry.name));
        }
      } catch {
        // Ignore malformed scoped directories; a local install will recreate them if needed.
      }
      continue;
    }

    directDependencyPaths.push(entryPath);
  }

  return directDependencyPaths.some((entryPath) => isSymlinkToOutside(entryPath, rootPath));
}

function getNextWorkspaceDirs(installRoot: string, manifest: PackageManifest | null): string[] {
  const dirs: string[] = [];

  if (hasDependency(manifest, 'next')) {
    dirs.push(installRoot);
  }

  for (const workspaceDir of resolveWorkspacePackageDirs(installRoot, manifest)) {
    if (hasDependency(readManifest(workspaceDir), 'next')) {
      dirs.push(workspaceDir);
    }
  }

  return uniqueDirs(dirs);
}

function resolveNextTurbopackLocalInstallReason(
  installRoot: string,
  manifest: PackageManifest | null,
): string | null {
  if (!hasNextDependencyInWorkspaceTree(installRoot, manifest)) {
    return null;
  }

  const rootNodeModulesPath = path.join(installRoot, 'node_modules');
  if (isSymlinkToOutside(rootNodeModulesPath, installRoot)) {
    return 'Next/Turbopack requires worktree-local node_modules; root node_modules points outside the worktree';
  }

  for (const workspaceDir of getNextWorkspaceDirs(installRoot, manifest)) {
    const relativeWorkspace = path.relative(installRoot, workspaceDir) || path.basename(installRoot);
    const workspaceNodeModulesPath = path.join(workspaceDir, 'node_modules');
    if (!fs.existsSync(workspaceNodeModulesPath)) {
      return `Next/Turbopack requires local install artifacts for ${relativeWorkspace}`;
    }

    if (hasExternalSymlinkEntry(workspaceNodeModulesPath, installRoot)) {
      return `Next/Turbopack requires worktree-local dependency symlinks for ${relativeWorkspace}`;
    }
  }

  for (const workspaceDir of resolveWorkspacePackageDirs(installRoot, manifest)) {
    const workspaceManifest = readManifest(workspaceDir);
    const workspaceNodeModulesPath = path.join(workspaceDir, 'node_modules');
    if (
      !fs.existsSync(workspaceNodeModulesPath) &&
      hasDependencyEntries(workspaceManifest)
    ) {
      const relativeWorkspace = path.relative(installRoot, workspaceDir) || path.basename(installRoot);
      return `Next/Turbopack requires local install artifacts for ${relativeWorkspace}`;
    }

    if (
      isSymlinkToOutside(workspaceNodeModulesPath, installRoot) ||
      hasExternalSymlinkEntry(workspaceNodeModulesPath, installRoot)
    ) {
      const relativeWorkspace = path.relative(installRoot, workspaceDir) || path.basename(installRoot);
      return `Next/Turbopack requires worktree-local dependency symlinks for ${relativeWorkspace}`;
    }
  }

  return null;
}

function cleanupNextTurbopackInstallArtifacts(
  installRoot: string,
  manifest: PackageManifest | null,
  logger: BootstrapLogger,
): void {
  if (!hasNextDependencyInWorkspaceTree(installRoot, manifest)) {
    return;
  }

  const rootNodeModulesPath = path.join(installRoot, 'node_modules');
  if (isSymlinkToOutside(rootNodeModulesPath, installRoot)) {
    logger('Removed root node_modules symlink because Next/Turbopack requires worktree-local dependencies');
    removePathIfExists(rootNodeModulesPath);
  }

  for (const workspaceDir of resolveWorkspacePackageDirs(installRoot, manifest)) {
    const workspaceNodeModulesPath = path.join(workspaceDir, 'node_modules');
    if (!fs.existsSync(workspaceNodeModulesPath)) {
      continue;
    }

    const removedSymlink = removeSymlinkIfPresent(workspaceNodeModulesPath);
    const hasUnsafeEntries = !removedSymlink && hasExternalSymlinkEntry(workspaceNodeModulesPath, installRoot);
    if (removedSymlink || hasUnsafeEntries) {
      logger(`Removed ${path.relative(installRoot, workspaceNodeModulesPath)} because Next/Turbopack dependency symlinks point outside the worktree`);
      removePathIfExists(workspaceNodeModulesPath);
    }
  }
}

function shouldSkipRepoNodeModulesReuse(
  worktreeInstallRoot: string,
  manifest: PackageManifest | null,
): string | null {
  if (hasNextDependencyInWorkspaceTree(worktreeInstallRoot, manifest)) {
    return 'Next/Turbopack requires worktree-local install artifacts and rejects repo-external pnpm symlinks';
  }

  return null;
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

function removePathIfExists(targetPath: string): void {
  if (!fs.existsSync(targetPath)) {
    return;
  }

  fs.rmSync(targetPath, { recursive: true, force: true });
}

function removeSymlinkIfPresent(targetPath: string): boolean {
  if (!fs.existsSync(targetPath)) {
    return false;
  }

  const stats = fs.lstatSync(targetPath);
  if (!stats.isSymbolicLink()) {
    return false;
  }

  removePathIfExists(targetPath);
  return true;
}

function createDirSymlink(targetPath: string, linkPath: string): void {
  const symlinkType: fs.symlink.Type = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(targetPath, linkPath, symlinkType);
}

function maybeReuseWorkspaceInstallArtifacts(
  repoInstallRoot: string,
  worktreeInstallRoot: string,
  logger: BootstrapLogger,
): number {
  let reusedCount = 0;
  const repoManifest = readManifest(repoInstallRoot);
  const worktreeManifest = readManifest(worktreeInstallRoot);
  const repoWorkspaceDirs = resolveWorkspacePackageDirs(repoInstallRoot, repoManifest);
  const worktreeWorkspaceDirs = resolveWorkspacePackageDirs(worktreeInstallRoot, worktreeManifest);
  const worktreeDirsByRelativePath = new Map(
    worktreeWorkspaceDirs.map((workspaceDir) => [
      path.relative(worktreeInstallRoot, workspaceDir),
      workspaceDir,
    ]),
  );

  for (const repoWorkspaceDir of repoWorkspaceDirs) {
    const relativePath = path.relative(repoInstallRoot, repoWorkspaceDir);
    const worktreeWorkspaceDir = worktreeDirsByRelativePath.get(relativePath);
    if (!worktreeWorkspaceDir) {
      continue;
    }

    const repoNodeModulesPath = path.join(repoWorkspaceDir, 'node_modules');
    if (!fs.existsSync(repoNodeModulesPath)) {
      continue;
    }

    const worktreeNodeModulesPath = path.join(worktreeWorkspaceDir, 'node_modules');
    const skipReuseReason = shouldSkipWorkspaceNodeModulesReuse(worktreeWorkspaceDir);
    if (skipReuseReason) {
      logger(`Skipped workspace install artifact reuse for ${relativePath}: ${skipReuseReason}`);
      if (removeSymlinkIfPresent(worktreeNodeModulesPath)) {
        logger(`Removed existing workspace node_modules symlink for ${relativePath}: ${skipReuseReason}`);
      }
      continue;
    }

    try {
      if (fs.existsSync(worktreeNodeModulesPath)) {
        const existingStats = fs.lstatSync(worktreeNodeModulesPath);
        if (existingStats.isSymbolicLink()) {
          const linkedTarget = fs.realpathSync.native(worktreeNodeModulesPath);
          if (linkedTarget === fs.realpathSync.native(repoNodeModulesPath)) {
            continue;
          }
        }

        logger(`Replacing workspace install artifacts in ${worktreeNodeModulesPath} with a shared repo symlink`);
        removePathIfExists(worktreeNodeModulesPath);
      }

      createDirSymlink(repoNodeModulesPath, worktreeNodeModulesPath);
      logger(`Reused workspace install artifacts for ${relativePath}`);
      reusedCount += 1;
    } catch (error) {
      logger(
        `Workspace install reuse failed for ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    }
  }

  return reusedCount;
}

function maybeReuseRepoInstallArtifacts(
  inspection: Pick<BootstrapInspection, 'installRoot' | 'packageManager'>,
  repoPath: string | undefined,
  logger: BootstrapLogger,
): string | null {
  if (!repoPath || !inspection.installRoot || !inspection.packageManager) {
    return null;
  }

  const repoInstallRoot = findInstallRoot(repoPath, repoPath);
  if (!repoInstallRoot) {
    return null;
  }

  const resolvedRepoInstallRoot = path.resolve(repoInstallRoot);
  const resolvedWorktreeInstallRoot = path.resolve(inspection.installRoot);

  if (resolvedRepoInstallRoot === resolvedWorktreeInstallRoot) {
    return null;
  }

  if (!hasInstallArtifacts(resolvedRepoInstallRoot, inspection.packageManager)) {
    return null;
  }

  const worktreeManifest = readManifest(resolvedWorktreeInstallRoot);
  const skipRepoReuseReason = shouldSkipRepoNodeModulesReuse(
    resolvedWorktreeInstallRoot,
    worktreeManifest,
  );
  if (skipRepoReuseReason) {
    logger(`Skipped repo install artifact reuse for ${resolvedWorktreeInstallRoot}: ${skipRepoReuseReason}`);
    cleanupNextTurbopackInstallArtifacts(
      resolvedWorktreeInstallRoot,
      worktreeManifest,
      logger,
    );
    return null;
  }

  const repoNodeModulesPath = path.join(resolvedRepoInstallRoot, 'node_modules');
  if (!fs.existsSync(repoNodeModulesPath)) {
    return null;
  }

  const worktreeNodeModulesPath = path.join(resolvedWorktreeInstallRoot, 'node_modules');

  try {
    if (fs.existsSync(worktreeNodeModulesPath)) {
      const existingStats = fs.lstatSync(worktreeNodeModulesPath);
      if (existingStats.isSymbolicLink()) {
        const linkedTarget = fs.realpathSync.native(worktreeNodeModulesPath);
        if (linkedTarget === fs.realpathSync.native(repoNodeModulesPath)) {
          const reusedWorkspaceCount = maybeReuseWorkspaceInstallArtifacts(
            resolvedRepoInstallRoot,
            resolvedWorktreeInstallRoot,
            logger,
          );
          return reusedWorkspaceCount > 0
            ? `Reused workspace install artifacts from ${resolvedRepoInstallRoot}`
            : null;
        }
      }

      logger(`Replacing worktree install artifacts in ${worktreeNodeModulesPath} with a shared repo symlink`);
      removePathIfExists(worktreeNodeModulesPath);
    }

    createDirSymlink(repoNodeModulesPath, worktreeNodeModulesPath);
    maybeReuseWorkspaceInstallArtifacts(
      resolvedRepoInstallRoot,
      resolvedWorktreeInstallRoot,
      logger,
    );
    return `Reused repo install artifacts from ${resolvedRepoInstallRoot}`;
  } catch (error) {
    logger(
      `Repo install reuse failed for ${resolvedWorktreeInstallRoot}: ${error instanceof Error ? error.message : String(error)}`,
      'error',
    );
    return null;
  }
}

function defaultCommandRunner(
  command: string,
  args: string[],
  cwd: string,
  ralphHome?: string,
): CommandResult {
  const { env } = buildRalphToolchainEnv({
    baseEnv: { ...process.env, CI: '1' },
    installRoot: cwd,
    ralphHome: ralphHome ?? process.env.RALPH_HOME,
  });
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf-8',
    env,
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

  const nextTurbopackLocalInstallReason = resolveNextTurbopackLocalInstallReason(
    installRoot,
    installManifest,
  );
  if (nextTurbopackLocalInstallReason) {
    return {
      installRoot,
      packageManager,
      needsInstall: true,
      installReason: 'next_turbopack_requires_local_install',
      reason: nextTurbopackLocalInstallReason,
    };
  }

  if (!hasInstallArtifacts(installRoot, packageManager)) {
    return {
      installRoot,
      packageManager,
      needsInstall: true,
      installReason: 'missing_artifacts',
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
  let inspection = inspectBootstrap(worktreePath, options.repoPath);

  logger(inspection.reason);

  if (
    !options.commandRunner &&
    inspection.installRoot &&
    inspection.packageManager
  ) {
    const reuseMessage = maybeReuseRepoInstallArtifacts(inspection, options.repoPath, logger);
    if (reuseMessage) {
      logger(reuseMessage);
      inspection = inspectBootstrap(worktreePath, options.repoPath);
      logger(inspection.reason);
    }
  }

  if (!inspection.needsInstall || !inspection.installRoot || !inspection.packageManager) {
    return {
      bootstrapped: false,
      packageManager: inspection.packageManager,
      installRoot: inspection.installRoot,
      needsInstall: false,
      installReason: inspection.installReason,
      message: inspection.reason,
    };
  }

  if (options.installIfNeeded === false) {
    return {
      bootstrapped: false,
      packageManager: inspection.packageManager,
      installRoot: inspection.installRoot,
      needsInstall: true,
      installReason: inspection.installReason,
      message: `Dependency install skipped: ${inspection.reason}`,
    };
  }

  cleanupNextTurbopackInstallArtifacts(
    inspection.installRoot,
    readManifest(inspection.installRoot),
    logger,
  );

  logger(
    `Installing dependencies with ${inspection.packageManager} from ${inspection.installRoot}`,
  );
  try {
    const commandRunner = options.commandRunner
      ?? ((command, args, cwd) => defaultCommandRunner(command, args, cwd, options.ralphHome));
    runInstall(
      inspection.packageManager,
      inspection.installRoot,
      commandRunner,
      logger
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    logger(`Dependency bootstrap failed: ${message}`, 'error');
    throw error;
  }

  logger(
    `Dependencies installed with ${inspection.packageManager} in ${inspection.installRoot}`,
  );

  return {
    bootstrapped: true,
    packageManager: inspection.packageManager,
    installRoot: inspection.installRoot,
    needsInstall: false,
    installReason: inspection.installReason,
    message: `Dependencies installed with ${inspection.packageManager}`,
  };
}
