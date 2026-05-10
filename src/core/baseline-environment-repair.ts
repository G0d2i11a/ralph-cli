import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { detectPackageManager, findInstallRoot, PackageManager } from './bootstrap';
import { BaselineQualityGateEnvironmentRepairState, Task } from '../types/task';
import { buildRalphToolchainEnv } from './toolchain-env';

export interface BaselineEnvironmentRepairOptions {
  now?: () => number;
  logger?: Pick<typeof console, 'log' | 'error'>;
  commandRunner?: (
    command: string,
    args: string[],
    cwd: string,
  ) => { status: number | null; stdout?: string; stderr?: string; error?: Error };
}

const INSTALL_ATTEMPTS: Record<PackageManager, string[][]> = {
  pnpm: [['install', '--frozen-lockfile'], ['install']],
  yarn: [['install', '--immutable'], ['install', '--frozen-lockfile'], ['install']],
  bun: [['install', '--frozen-lockfile'], ['install']],
  npm: [['ci'], ['install']],
};

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function extractNodeModulesPaths(message: string, task: Task): string[] {
  const candidates = new Set<string>();
  const absoluteMatches = message.match(/(?:\/[^\s'")]+\/node_modules)(?=[\s'").:]|$)/g) ?? [];

  for (const match of absoluteMatches) {
    candidates.add(path.resolve(match));
  }

  const cwd = task.finalizerFailure?.cwd;
  if (cwd && isInside(task.worktree, cwd)) {
    let current = path.resolve(cwd);
    const worktree = path.resolve(task.worktree);

    while (isInside(worktree, current)) {
      candidates.add(path.join(current, 'node_modules'));
      if (current === worktree) {
        break;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }

      current = parent;
    }
  }

  candidates.add(path.join(path.resolve(task.worktree), 'node_modules'));
  return Array.from(candidates).filter((candidate) => isInside(task.worktree, candidate));
}

function removeInvalidNodeModulesSymlinks(task: Task): string[] {
  const message = task.finalizerFailure?.rawMessage ?? task.lastError ?? '';
  const candidates = extractNodeModulesPaths(message, task);
  const removed: string[] = [];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }

    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(candidate);
    } catch {
      continue;
    }

    if (!stats.isSymbolicLink()) {
      continue;
    }

    let realPath: string;
    try {
      realPath = fs.realpathSync.native(candidate);
    } catch {
      realPath = path.resolve(path.dirname(candidate), fs.readlinkSync(candidate));
    }

    if (isInside(task.worktree, realPath)) {
      continue;
    }

    fs.rmSync(candidate, { recursive: true, force: true });
    removed.push(candidate);
  }

  return removed;
}

function runInstall(input: {
  packageManager: PackageManager;
  installRoot: string;
  commandRunner?: BaselineEnvironmentRepairOptions['commandRunner'];
}): { ok: boolean; message: string } {
  const attempts = INSTALL_ATTEMPTS[input.packageManager];
  let lastMessage = `No install attempts configured for ${input.packageManager}`;

  for (const args of attempts) {
    const { env } = buildRalphToolchainEnv({
      baseEnv: { ...process.env, CI: '1' },
      installRoot: input.installRoot,
      ralphHome: process.env.RALPH_HOME,
    });
    const result = input.commandRunner
      ? input.commandRunner(input.packageManager, args, input.installRoot)
      : spawnSync(input.packageManager, args, {
          cwd: input.installRoot,
          encoding: 'utf-8',
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 5 * 60 * 1000,
        });

    if (result.status === 0) {
      return {
        ok: true,
        message: `${input.packageManager} ${args.join(' ')} completed`,
      };
    }

    const output = [result.stderr, result.stdout]
      .filter((value): value is string => Boolean(value?.trim()))
      .join('\n')
      .trim();
    lastMessage = result.error
      ? result.error.message
      : output.split(/\r?\n/).slice(-8).join('\n') || `exit code ${result.status ?? 'unknown'}`;
  }

  return {
    ok: false,
    message: lastMessage,
  };
}

export function repairTaskWorktreeDependencyBootstrap(
  task: Task,
  attempts: number,
  options: BaselineEnvironmentRepairOptions = {},
): BaselineQualityGateEnvironmentRepairState {
  const now = options.now ?? (() => Date.now());
  const attemptedAt = now();

  if (!task.worktree || !fs.existsSync(task.worktree)) {
    return {
      attemptedAt,
      attempts,
      repaired: false,
      message: 'task worktree does not exist; cannot repair dependency bootstrap environment',
    };
  }

  const installRoot = findInstallRoot(task.finalizerFailure?.cwd ?? task.worktree, task.repoPath);
  const packageManager = detectPackageManager(task.finalizerFailure?.cwd ?? task.worktree, task.repoPath);
  const removedPaths = removeInvalidNodeModulesSymlinks(task);

  if (!installRoot || !isInside(task.worktree, installRoot)) {
    return {
      attemptedAt,
      attempts,
      repaired: false,
      removedPaths,
      message: 'could not resolve a safe install root inside the task worktree',
    };
  }

  if (!packageManager) {
    return {
      attemptedAt,
      attempts,
      repaired: false,
      removedPaths,
      installRoot,
      message: 'could not detect package manager for task worktree environment repair',
    };
  }

  if (removedPaths.length === 0) {
    return {
      attemptedAt,
      attempts,
      repaired: false,
      removedPaths,
      installRoot,
      packageManager,
      message: 'no invalid node_modules symlink was found inside the task worktree',
    };
  }

  options.logger?.log(`Repairing task worktree dependency bootstrap with ${packageManager} in ${installRoot}`);
  const install = runInstall({
    packageManager,
    installRoot,
    commandRunner: options.commandRunner,
  });
  const postInstallRemovedPaths = removeInvalidNodeModulesSymlinks(task);
  const allRemovedPaths = [...new Set([...removedPaths, ...postInstallRemovedPaths])];

  return {
    attemptedAt,
    attempts,
    repaired: install.ok,
    removedPaths: allRemovedPaths,
    installRoot,
    packageManager,
    message: install.ok
      ? `removed invalid node_modules symlink(s) and ${install.message}`
      : `removed invalid node_modules symlink(s), but dependency install failed: ${install.message}`,
  };
}
