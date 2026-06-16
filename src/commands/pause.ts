import { resolveRalphHome } from '../core/paths';
import { setSchedulingPaused } from '../core/manager-control';

export async function pauseCommand(options: { reason?: string } = {}): Promise<void> {
  try {
    const control = setSchedulingPaused(true, {
      reason: options.reason,
    });

    console.log(JSON.stringify({
      ok: true,
      ralphHome: resolveRalphHome(),
      paused: control.schedulingPaused,
      pausedAt: control.pausedAt ? new Date(control.pausedAt).toISOString() : undefined,
      pausedBy: control.pausedBy,
      reason: control.pauseReason,
      controlPath: control.controlPath,
      message: 'Ralph scheduling is paused; running tasks are not killed',
    }));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exit(1);
  }
}
