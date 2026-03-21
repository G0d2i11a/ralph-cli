#!/usr/bin/env node

import { Command } from 'commander';
import { startCommand } from './commands/start';
import { batchStartCommand } from './commands/batch-start';
import { statusCommand } from './commands/status';
import { listCommand } from './commands/list';
import { stopCommand } from './commands/stop';
import { mergeCommand } from './commands/merge';
import { finalizeCommand } from './commands/finalize';
import { statsCommand } from './commands/stats';
import { updateCommand } from './commands/update';
import { retryCommand } from './commands/retry';
import { resetStagnationCommand } from './commands/reset-stagnation';
import { completionCommand } from './commands/completion';
import { watch } from './commands/watch';
import { DEFAULT_AGENT, DEFAULT_BACKEND } from './core/agent';

const program = new Command();

program
  .name('ralph')
  .description('PRD-driven autonomous development CLI')
  .version('0.2.0');

program
  .command('start <prd-path>')
  .description('Start a new task from a PRD file')
  .option('--repo <path>', 'Repository path (defaults to current directory)')
  .option('--agent <name>', 'Agent to use (claude|codex)', DEFAULT_AGENT)
  .option('--backend <name>', `Backend to use (cli|agent-runners, default: ${DEFAULT_BACKEND})`)
  .addHelpText('after', `
Examples:
  $ ralph start prd.md
  $ ralph start prd.md --repo ~/Project/myproject
  $ ralph start prd.json --agent claude
  $ ralph start prd.json --backend agent-runners`)
  .action(startCommand);

program
  .command('status [task-id]')
  .description('Show status of a task or all running tasks')
  .option('--detailed', 'Show detailed status including user stories and stagnation analysis')
  .addHelpText('after', `
Examples:
  $ ralph status
  $ ralph status task-1772544497775-wdat8zyr5
  $ ralph status task-1772544497775-wdat8zyr5 --detailed`)
  .action(statusCommand);

program
  .command('list')
  .description('List all tasks')
  .option('--status <status>', 'Filter by status (pending|running|ready_to_finalize|finalizing|completed|failed|failed_finalize|stagnant)')
  .addHelpText('after', `
Examples:
  $ ralph list
  $ ralph list --status running
  $ ralph list --status completed`)
  .action(listCommand);

program
  .command('stop <task-id>')
  .description('Stop a running task')
  .addHelpText('after', `
Examples:
  $ ralph stop task-1772544497775-wdat8zyr5`)
  .action(stopCommand);

program
  .command('merge <task-id>')
  .description('Merge a completed task')
  .option('--auto', 'Auto-resolve conflicts')
  .option('--strategy <strategy>', 'Conflict resolution strategy (ours|theirs|manual)', 'manual')
  .option('--target <branch>', 'Target branch to merge into', 'main')
  .addHelpText('after', `
Examples:
  $ ralph merge task-1772544497775-wdat8zyr5
  $ ralph merge task-1772544497775-wdat8zyr5 --auto
  $ ralph merge task-1772544497775-wdat8zyr5 --strategy ours --target develop`)
  .action(mergeCommand);

program
  .command('finalize <task-id>')
  .description('Commit task changes using the restricted finisher flow')
  .addHelpText('after', `
Examples:
  $ ralph finalize task-1772544497775-wdat8zyr5`)
  .action(finalizeCommand);

program
  .command('stats [task-id]')
  .description('Show performance statistics for a task')
  .option('--format <type>', 'Output format: json, table, summary (default: table)', 'table')
  .option('--all', 'Show stats for all tasks')
  .addHelpText('after', `
Examples:
  $ ralph stats task-1772544497775-wdat8zyr5
  $ ralph stats task-1772544497775-wdat8zyr5 --format json
  $ ralph stats --all`)
  .action(statsCommand);

program
  .command('batch-start <prd-paths...>')
  .description('Start multiple tasks from PRD files')
  .option('--repo <path>', 'Repository path (defaults to current directory)')
  .option('--agent <name>', 'Agent to use (claude|codex)', DEFAULT_AGENT)
  .option('--backend <name>', `Backend to use (cli|agent-runners, default: ${DEFAULT_BACKEND})`)
  .addHelpText('after', `
Examples:
  $ ralph batch-start prd1.md prd2.md prd3.md
  $ ralph batch-start prds/*.md --agent codex
  $ ralph batch-start prds/*.md --backend agent-runners`)
  .action(batchStartCommand);

program
  .command('update <task-id>')
  .description('Update a task or user story status')
  .option('--story-id <id>', 'User story ID (e.g., US-001)')
  .option('--passes', 'Mark story as passing')
  .option('--notes <text>', 'Implementation notes')
  .addHelpText('after', `
Examples:
  $ ralph update task-123 --story-id US-001 --passes
  $ ralph update task-123 --story-id US-002 --notes "Fixed type errors"`)
  .action(updateCommand);

program
  .command('retry <task-id>')
  .description('Retry a failed or stopped task')
  .addHelpText('after', `
Examples:
  $ ralph retry task-1772544497775-wdat8zyr5`)
  .action(retryCommand);

program
  .command('reset-stagnation <task-id>')
  .description('Reset stagnation counters for a task')
  .addHelpText('after', `
Examples:
  $ ralph reset-stagnation task-1772544497775-wdat8zyr5`)
  .action(resetStagnationCommand);

program
  .command('watch')
  .description('Poll pending tasks and optionally auto-ingest new ez4ielts PRDs into the queue')
  .option('--interval <ms>', 'Polling interval in milliseconds')
  .option('--repo <path>', 'Repository path for auto-ingested tasks (defaults to the watched docs directory parent)')
  .option('--agent <name>', 'Agent to use (claude|codex)', DEFAULT_AGENT)
  .option('--backend <name>', `Backend to use for auto-ingested tasks (cli|agent-runners, default: ${DEFAULT_BACKEND})`)
  .option('--auto-ingest-ez4ielts', 'Auto-enqueue new ez4ielts-*.json files discovered by the watcher')
  .option('--ez4ielts-dir <path>', 'Directory to scan for ez4ielts-*.json files')
  .addHelpText('after', `
Examples:
  $ ralph watch
  $ ralph watch --interval 10000
  $ ralph watch --auto-ingest-ez4ielts
  $ ralph watch --auto-ingest-ez4ielts --repo ~/Project/ez4ielts --ez4ielts-dir ~/Project/ez4ielts/docs
  $ ralph watch --auto-ingest-ez4ielts --backend agent-runners
  
Description:
  Starts a background watcher that reconciles the pending queue.
  When a task's dependencies are satisfied and a concurrency slot is available,
  it automatically starts the task.

  With --auto-ingest-ez4ielts enabled, Ralph also watches for brand new
  ez4ielts-*.json PRDs, skips the existing backlog on startup, and queues each
  new PRD only once.
  
  Ralph now auto-starts queued tasks when running tasks finish, fail, stop,
  or transition into ready_to_finalize and complete via the restricted finalizer.
  This watcher remains useful as a polling safety net for pending tasks.
  
  Press Ctrl+C to stop the watcher.`)
  .action((options) => watch({
    interval: options.interval ? parseInt(options.interval, 10) : undefined,
    repo: options.repo,
    agent: options.agent,
    backend: options.backend,
    autoIngestEz4ielts: options.autoIngestEz4ielts,
    ez4ieltsDir: options.ez4ieltsDir,
  }));

program
  .command('completion <shell>')
  .description('Generate shell completion script')
  .addHelpText('after', `
Arguments:
  shell                 Shell type: bash or zsh

Examples:
  $ ralph completion bash > /etc/bash_completion.d/ralph
  $ ralph completion zsh > ~/.zsh/completions/_ralph
  
Installation:
  Bash:
    $ ralph completion bash | sudo tee /etc/bash_completion.d/ralph
    $ source /etc/bash_completion.d/ralph
  
  Zsh:
    $ mkdir -p ~/.zsh/completions
    $ ralph completion zsh > ~/.zsh/completions/_ralph
    $ echo 'fpath=(~/.zsh/completions $fpath)' >> ~/.zshrc
    $ echo 'autoload -Uz compinit && compinit' >> ~/.zshrc`)
  .action(completionCommand);

program.parse();
