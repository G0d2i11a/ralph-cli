import { resolve } from 'path';
import { startCommand } from './start';

interface BatchStartOptions {
  repo?: string;
  agent?: string;
}

export async function batchStartCommand(prdPaths: string[], options: BatchStartOptions) {
  const repo = options.repo ? resolve(options.repo) : process.cwd();
  const agent = options.agent || 'claude';

  const results = [];

  for (const prdPath of prdPaths) {
    try {
      const absolutePrdPath = resolve(prdPath);
      
      // Capture stdout to get task info
      const originalLog = console.log;
      let taskInfo: any = null;
      console.log = (msg: string) => {
        try {
          taskInfo = JSON.parse(msg);
        } catch {
          originalLog(msg);
        }
      };

      await startCommand(absolutePrdPath, { repo, agent });
      
      console.log = originalLog;

      if (taskInfo && taskInfo.taskId) {
        results.push({
          prdPath,
          success: true,
          taskId: taskInfo.taskId,
          worktree: taskInfo.worktree,
          logPath: taskInfo.logPath,
        });
      }
    } catch (error) {
      results.push({
        prdPath,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Output results as JSON
  console.log(JSON.stringify({
    total: prdPaths.length,
    successful: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    results
  }));

  if (results.some(r => !r.success)) {
    process.exit(1);
  }
}
