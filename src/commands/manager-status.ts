import { getManagerStatus } from '../core/manager-state';

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
  const status = getManagerStatus({ staleAfterMs });

  console.log(JSON.stringify({
    ok: !status.active || !status.heartbeatStale,
    ...status,
  }));
}
