import { summarizeActiveRepoPaths } from '../core/task-home-summary';
import { getManagerStatus } from '../core/manager-state';
import { resolveRalphHome } from '../core/paths';
import { listRepoManagerClaims } from '../core/repo-manager-registry';
import { StateManager } from '../core/state';

interface ManagerStatusCommandOptions {
  staleAfterMs?: string | number;
  all?: boolean;
}

function parsePositiveNumber(value: string | number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : undefined;
}

export async function managerStatusCommand(
  options: ManagerStatusCommandOptions = {}
): Promise<void> {
  const staleAfterMs = parsePositiveNumber(options.staleAfterMs);
  const ralphHome = resolveRalphHome();
  const status = getManagerStatus({ ralphHome, staleAfterMs });
  const stateManager = new StateManager({ ralphHome });
  const repoSummary = summarizeActiveRepoPaths(await stateManager.listTasks());
  const repoManagerClaims = options.all
    ? listRepoManagerClaims({ currentRalphHome: ralphHome })
    : undefined;

  console.log(JSON.stringify({
    ok: !status.active || (!status.heartbeatStale && !status.codeDriftDetected),
    ...repoSummary,
    ...status,
    repoManagerClaims,
  }));
}
