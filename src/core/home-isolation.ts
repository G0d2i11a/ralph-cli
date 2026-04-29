import * as path from 'path';
import { resolveRalphHome, RalphHomeOptions } from './paths';
import { StateManager } from './state';
import { summarizeActiveRepoPaths } from './task-home-summary';

type TaskStateStore = Pick<StateManager, 'listTasks'>;

export interface RalphHomeIsolationOptions extends RalphHomeOptions {
  repoPath?: string;
  allowMixedHome?: boolean;
  stateManager?: TaskStateStore;
  operation?: string;
}

export interface RalphHomeIsolationSummary {
  ralphHome: string;
  repoCount: number;
  mixedRepos: boolean;
  repoPaths: string[];
  intendedRepoPath?: string;
  compatible: boolean;
  reason?: 'mixed_repos' | 'foreign_repo';
  foreignRepoPath?: string;
}

function resolveAllowMixedHome(value?: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  const envValue = process.env.RALPH_ALLOW_MIXED_HOME?.trim().toLowerCase();
  return envValue === '1' || envValue === 'true' || envValue === 'yes';
}

export function evaluateRalphHomeIsolation(input: {
  repoPaths: string[];
  intendedRepoPath?: string;
}): Omit<RalphHomeIsolationSummary, 'ralphHome'> {
  const repoPaths = [...new Set(input.repoPaths.map((repoPath) => path.resolve(repoPath)))].sort();
  const intendedRepoPath = input.intendedRepoPath ? path.resolve(input.intendedRepoPath) : undefined;
  const mixedRepos = repoPaths.length > 1;

  if (mixedRepos) {
    return {
      repoCount: repoPaths.length,
      mixedRepos: true,
      repoPaths,
      intendedRepoPath,
      compatible: false,
      reason: 'mixed_repos',
    };
  }

  if (intendedRepoPath && repoPaths.length === 1 && repoPaths[0] !== intendedRepoPath) {
    return {
      repoCount: repoPaths.length,
      mixedRepos: false,
      repoPaths,
      intendedRepoPath,
      compatible: false,
      reason: 'foreign_repo',
      foreignRepoPath: repoPaths[0],
    };
  }

  return {
    repoCount: repoPaths.length,
    mixedRepos: false,
    repoPaths,
    intendedRepoPath,
    compatible: true,
  };
}

function buildIsolationErrorMessage(summary: RalphHomeIsolationSummary, operation: string): string {
  if (summary.reason === 'mixed_repos') {
    return `RALPH_HOME ${summary.ralphHome} already has active tasks from multiple repos (${summary.repoCount}): ${summary.repoPaths.join(', ')}. Refusing to ${operation} because default mode requires one repo per Ralph home. Use a repo-scoped --home path or rerun with --allow-mixed-home to override.`;
  }

  if (summary.reason === 'foreign_repo' && summary.foreignRepoPath && summary.intendedRepoPath) {
    return `RALPH_HOME ${summary.ralphHome} is already active for ${summary.foreignRepoPath}. Refusing to ${operation} for ${summary.intendedRepoPath} in the same home. Use a repo-scoped --home path or rerun with --allow-mixed-home to override.`;
  }

  return `RALPH_HOME ${summary.ralphHome} is not compatible with this operation. Use a repo-scoped --home path or rerun with --allow-mixed-home to override.`;
}

export async function assertRalphHomeIsolation(options: RalphHomeIsolationOptions = {}): Promise<RalphHomeIsolationSummary> {
  const ralphHome = resolveRalphHome(options);
  const operation = options.operation || 'continue';
  const stateManager = options.stateManager ?? new StateManager({ ralphHome });
  const tasks = await stateManager.listTasks();
  const repoSummary = summarizeActiveRepoPaths(tasks);
  const summary: RalphHomeIsolationSummary = {
    ralphHome,
    ...evaluateRalphHomeIsolation({
      repoPaths: repoSummary.repoPaths,
      intendedRepoPath: options.repoPath,
    }),
  };

  if (!resolveAllowMixedHome(options.allowMixedHome) && !summary.compatible) {
    throw new Error(buildIsolationErrorMessage(summary, operation));
  }

  return summary;
}
