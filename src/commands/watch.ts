import { watchCommand, WatchCommandOptions } from '../core/dependency-watcher';

export async function watch(options: WatchCommandOptions): Promise<void> {
  await watchCommand(options);
}
