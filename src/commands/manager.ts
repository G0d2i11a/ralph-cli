import * as path from 'path';
import { DependencyWatcher, WatchCommandOptions } from '../core/dependency-watcher';
import { withDirectoryLock } from '../core/locks';
import {
  DEFAULT_MANAGER_HEARTBEAT_STALE_MS,
  getManagerLockDir,
  getManagerStatus,
  ManagerStateWriter,
} from '../core/manager-state';

export async function managerCommand(options: WatchCommandOptions): Promise<void> {
  const lockDir = getManagerLockDir();
  let watcher: DependencyWatcher | undefined;
  let stateWriter: ManagerStateWriter | undefined;

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
      watcher = new DependencyWatcher(options, {
        lifecycle: {
          onLoopStarted: () => {
            stateWriter?.loopStarted();
          },
          onLoopCompleted: () => {
            stateWriter?.loopCompleted();
          },
          onLoopError: (error) => {
            stateWriter?.error(error);
          },
          onStopped: () => {
            stateWriter?.stopped();
          },
        },
      });
      stateWriter = new ManagerStateWriter({
        pollIntervalMs: watcher.getPollIntervalMs(),
        autoIngestEnabled: watcher.isAutoIngestEnabled(),
        repo: options.repo ? path.resolve(options.repo) : undefined,
        agent: options.agent,
        backend: options.backend,
        ez4ieltsDir: options.ez4ieltsDir ? path.resolve(options.ez4ieltsDir) : undefined,
      });
      stateWriter.start();

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

    throw error;
  } finally {
    process.removeListener('SIGINT', stopManager);
    process.removeListener('SIGTERM', stopManager);
  }
}
