import { watchCommand } from '../core/dependency-watcher';

export async function watch(options: { interval?: number }): Promise<void> {
  await watchCommand(options);
}
