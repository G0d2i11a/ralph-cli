import * as path from 'path';
import { DependencyWatcher, WatchCommandOptions } from '../core/dependency-watcher';
import { assertRalphHomeIsolation } from '../core/home-isolation';
import { withDirectoryLock } from '../core/locks';
import {
  DEFAULT_MANAGER_HEARTBEAT_STALE_MS,
  getManagerLockDir,
  getManagerStatus,
  ManagerStateWriter,
} from '../core/manager-state';
import { assertNoDuplicateRepoManagers } from '../core/repo-manager-registry';

function resolveInitialPollIntervalMs(value: unknown): number {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : 0;
}

export async function managerCommand(options: WatchCommandOptions): Promise<void> {
  const lockDir = getManagerLockDir();
  let watcher: DependencyWatcher | undefined;
  let stateWriter: ManagerStateWriter | undefined;

  const writeStartupPhase = (phase: string): void => {
    try {
      console.log(`Ralph manager startup: ${phase}`);
      stateWriter?.update({
        status: 'running',
        startupPhase: phase,
        startupPhaseAt: Date.now(),
      });
    } catch (error) {
      console.error(`Failed to write manager startup phase ${phase}:`, error);
    }
  };

  const stopManager = (signal: NodeJS.Signals) => {
    console.log(`\nReceived ${signal}, stopping Ralph manager...`);
    try {
      stateWriter?.stopping();
    } catch (error) {
      console.error('Failed to write manager stopping state:', error);
    }
    watcher?.stop();
  };

  process.once('SIGINT', stopManager);
  process.once('SIGTERM', stopManager);

  try {
    await withDirectoryLock(lockDir, async () => {
      stateWriter = new ManagerStateWriter({
        pollIntervalMs: resolveInitialPollIntervalMs(options.interval),
        autoIngestEnabled: options.autoIngestEz4ielts === true,
        autoIngestExistingOnStartup: options.ingestExistingEz4ielts === true,
        repo: options.repo ? path.resolve(options.repo) : undefined,
        agent: options.agent,
        backend: options.backend,
        ez4ieltsDir: options.ez4ieltsDir ? path.resolve(options.ez4ieltsDir) : undefined,
      });
      stateWriter.start();

      writeStartupPhase('preflight_home_isolation');
      await assertRalphHomeIsolation({
        repoPath: options.repo,
        allowMixedHome: options.allowMixedHome,
        operation: 'start the Ralph manager',
      });
      writeStartupPhase('preflight_duplicate_manager_check');
      assertNoDuplicateRepoManagers({
        repoPath: options.repo,
        operation: 'start the Ralph manager',
      });

      writeStartupPhase('constructing_dependency_watcher');
      watcher = new DependencyWatcher(options, {
        lifecycle: {
          onStarted: () => {
            stateWriter?.update({
              startupPhase: undefined,
              startupPhaseAt: undefined,
              lastLoopStep: 'started',
              lastLoopStepAt: Date.now(),
            });
          },
          onLoopStarted: () => {
            stateWriter?.loopStarted();
          },
          onLoopStep: (step) => {
            stateWriter?.update({
              lastLoopStep: step,
              lastLoopStepAt: Date.now(),
            });
          },
          onLoopCompleted: () => {
            stateWriter?.loopCompleted();
            stateWriter?.update({
              lastLoopStep: 'sleeping',
              lastLoopStepAt: Date.now(),
            });
          },
          onLoopError: (error) => {
            stateWriter?.error(error);
          },
          onStopped: () => {
            stateWriter?.stopped();
          },
        },
      });
      stateWriter.update({
        pollIntervalMs: watcher.getPollIntervalMs(),
        autoIngestEnabled: watcher.isAutoIngestEnabled(),
        autoIngestExistingOnStartup: watcher.isAutoIngestExistingOnStartupEnabled(),
        startupPhase: 'starting_dependency_watcher_loop',
        startupPhaseAt: Date.now(),
      });

      try {
        await watcher.start();
      } catch (error) {
        stateWriter.error(error);
        throw error;
      }
    }, {
      timeoutMs: 0,
      staleMs: DEFAULT_MANAGER_HEARTBEAT_STALE_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Timed out waiting for lock')) {
      console.error(JSON.stringify({
        ok: false,
        error: 'another Ralph manager appears to be running',
        lockDir,
        manager: getManagerStatus(),
      }));
      process.exitCode = 1;
      return;
    }

    console.error(JSON.stringify({
      ok: false,
      error: message,
    }));
    process.exitCode = 1;
    return;
  } finally {
    process.removeListener('SIGINT', stopManager);
    process.removeListener('SIGTERM', stopManager);
  }
}
