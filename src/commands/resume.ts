import { resolveRalphHome } from '../core/paths';
import { setSchedulingPaused } from '../core/manager-control';

export async function resumeCommand(): Promise<void> {
  try {
    const control = setSchedulingPaused(false);

    console.log(JSON.stringify({
      ok: true,
      ralphHome: resolveRalphHome(),
      paused: control.schedulingPaused,
      resumedAt: control.resumedAt ? new Date(control.resumedAt).toISOString() : undefined,
      resumedBy: control.resumedBy,
      controlPath: control.controlPath,
      message: 'Ralph scheduling is resumed',
    }));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exit(1);
  }
}
