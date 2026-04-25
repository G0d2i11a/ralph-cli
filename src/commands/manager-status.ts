import { getManagerStatus } from '../core/manager-state';
import { resolveRalphHome } from '../core/paths';

interface ManagerStatusCommandOptions {
  staleAfterMs?: string | number;
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

  console.log(JSON.stringify({
    ok: !status.active || !status.heartbeatStale,
    ...status,
  }));
}
