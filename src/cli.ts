#!/usr/bin/env node

import { Command } from 'commander';
import * as path from 'path';
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
import { managerCommand } from './commands/manager';
import { managerInstallCommand, managerUninstallCommand } from './commands/manager-service';
import { managerStatusCommand } from './commands/manager-status';
import { doctorCommand } from './commands/doctor';
import { queueCommand } from './commands/queue';
import { watchdogCommand, watchdogInstallCommand, watchdogUninstallCommand } from './commands/watchdog';
import { cleanupCommand } from './commands/cleanup';
import { DEFAULT_AGENT, DEFAULT_BACKEND } from './core/agent';

const program = new Command();

function collectRepeatedOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

program
  .name('ralph')
  .description('PRD-driven autonomous development CLI')
  .version('0.2.0')
  .option('--home <path>', 'Ralph home directory (overrides RALPH_HOME)')
  .option('--allow-mixed-home', 'Allow multiple repos to share the same Ralph home');

program.hook('preAction', (_thisCommand, actionCommand) => {
  const options = actionCommand.optsWithGlobals();
  const home = options.home;
  if (typeof home === 'string' && home.trim()) {
    process.env.RALPH_HOME = path.resolve(home);
  }

  if (options.allowMixedHome) {
    process.env.RALPH_ALLOW_MIXED_HOME = '1';
  } else {
    delete process.env.RALPH_ALLOW_MIXED_HOME;
  }
});

program
  .command('start <prd-path>')
  .description('Start a new task from a PRD file')
  .option('--repo <path>', 'Repository path (defaults to current directory)')
  .option('--agent <name>', 'Agent to use (claude|codex)', DEFAULT_AGENT)
  .option('--backend <name>', `Backend to use (cli|agent-runners, default: ${DEFAULT_BACKEND})`)
  .option('--allow-duplicate', 'Allow enqueueing a duplicate active PRD for the same repo')
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
  .option('--allow-duplicate', 'Allow enqueueing duplicate active PRDs for the same repo')
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
  .option('--finalize-only', 'For failed_finalize tasks, rerun only the finalizer path without rescheduling worker stories')
  .addHelpText('after', `
Examples:
  $ ralph retry task-1772544497775-wdat8zyr5
  $ ralph retry task-1772544497775-wdat8zyr5 --finalize-only`)
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
  .option('--disable-auto-ingest-ez4ielts', 'Disable configured ez4ielts auto-ingestion for this watcher run')
  .option('--ingest-existing-ez4ielts', 'Queue existing matching PRD files on startup instead of only watching new files')
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

  With --auto-ingest-ez4ielts enabled, Ralph watches for ez4ielts-*.json PRDs.
  By default it skips the existing backlog on startup and queues new PRDs only
  once. Add --ingest-existing-ez4ielts to explicitly queue the current backlog.
  
  Ralph now auto-starts queued tasks when running tasks finish, fail, stop,
  or transition into ready_to_finalize and complete via the restricted finalizer.
  This watcher remains useful as a polling safety net for pending tasks.
  
  Press Ctrl+C to stop the watcher.`)
  .action((options) => watch({
    interval: options.interval ? parseInt(options.interval, 10) : undefined,
    repo: options.repo,
    agent: options.agent,
    backend: options.backend,
    autoIngestEz4ielts: options.disableAutoIngestEz4ielts ? false : options.autoIngestEz4ielts,
    ingestExistingEz4ielts: options.ingestExistingEz4ielts,
    ez4ieltsDir: options.ez4ieltsDir,
  }));

program
  .command('manager')
  .description('Run the canonical Ralph manager loop (schedule, recover, finalize, and optionally auto-ingest PRDs)')
  .option('--interval <ms>', 'Polling interval in milliseconds')
  .option('--repo <path>', 'Repository path for auto-ingested tasks (defaults to the watched docs directory parent)')
  .option('--agent <name>', 'Agent to use (claude|codex)', DEFAULT_AGENT)
  .option('--backend <name>', `Backend to use for auto-ingested tasks (cli|agent-runners, default: ${DEFAULT_BACKEND})`)
  .option('--auto-ingest-ez4ielts', 'Auto-enqueue new ez4ielts-*.json files discovered by the manager')
  .option('--disable-auto-ingest-ez4ielts', 'Disable configured ez4ielts auto-ingestion for this manager run')
  .option('--ingest-existing-ez4ielts', 'Queue existing matching PRD files on startup instead of only watching new files')
  .option('--ez4ielts-dir <path>', 'Directory to scan for ez4ielts-*.json files')
  .addHelpText('after', `
Examples:
  $ ralph manager
  $ ralph manager --auto-ingest-ez4ielts --ez4ielts-dir ~/Project/ez4ielts/docs

Description:
  Alias for the authoritative manager loop. It performs the same queue,
  recovery, finalization, and optional auto-ingestion duties as watch, but
  is named for the intended always-on control-plane role.`)
  .action((options) => managerCommand({
    interval: options.interval ? parseInt(options.interval, 10) : undefined,
    repo: options.repo,
    agent: options.agent,
    backend: options.backend,
    autoIngestEz4ielts: options.disableAutoIngestEz4ielts ? false : options.autoIngestEz4ielts,
    ingestExistingEz4ielts: options.ingestExistingEz4ielts,
    ez4ieltsDir: options.ez4ieltsDir,
  }));

program
  .command('manager-status')
  .description('Show Ralph manager heartbeat, PID, loop timing, and stale status')
  .option('--stale-after-ms <ms>', 'Heartbeat age threshold used to mark the manager stale')
  .option('--all', 'Include Ralph launchd manager claims from ~/Library/LaunchAgents')
  .addHelpText('after', `
Examples:
  $ ralph manager-status
  $ ralph manager-status --stale-after-ms 300000
  $ ralph manager-status --all`)
  .action(managerStatusCommand);

program
  .command('manager-install')
  .description('Install a macOS launchd service that keeps the Ralph manager running')
  .option('--label <label>', 'launchd label')
  .option('--plist <path>', 'Path to write the launchd plist')
  .option('--profile <name>', 'Manager install profile (ez4ielts-autonomous)')
  .option('--interval <ms>', 'Polling interval in milliseconds')
  .option('--repo <path>', 'Repository path for auto-ingested tasks')
  .option('--agent <name>', 'Agent to use (claude|codex)', DEFAULT_AGENT)
  .option('--backend <name>', `Backend to use (cli|agent-runners, default: ${DEFAULT_BACKEND})`)
  .option('--auto-ingest-ez4ielts', 'Auto-enqueue new ez4ielts-*.json files discovered by the manager')
  .option('--disable-auto-ingest-ez4ielts', 'Disable configured ez4ielts auto-ingestion for this launchd manager')
  .option('--ingest-existing-ez4ielts', 'Queue existing matching PRD files on startup instead of only watching new files')
  .option('--ez4ielts-dir <path>', 'Directory to scan for ez4ielts-*.json files')
  .option('--load', 'Load and kickstart the launchd service after writing the plist')
  .option('--dry-run', 'Print the resolved launchd config without writing or loading it')
  .addHelpText('after', `
Examples:
  $ ralph manager-install --repo ~/Project/atta
  $ ralph manager-install --repo ~/Project/atta --load
  $ ralph manager-install --dry-run --interval 10000`)
  .action(managerInstallCommand);

program
  .command('manager-uninstall')
  .description('Unload and remove the macOS launchd service for the Ralph manager')
  .option('--label <label>', 'launchd label')
  .option('--plist <path>', 'Path to the launchd plist')
  .option('--repo <path>', 'Unload/remove Ralph launchd services that claim this repository')
  .option('--dry-run', 'Print what would be removed without unloading or deleting')
  .addHelpText('after', `
Examples:
  $ ralph manager-uninstall
  $ ralph manager-uninstall --dry-run
  $ ralph manager-uninstall --repo ~/Project/ez4ielts --dry-run`)
  .action(managerUninstallCommand);

program
  .command('doctor')
  .description('Run preflight checks for git, repo state, agent binaries, and backend config')
  .option('--repo <path>', 'Repository path to check (defaults to current directory)')
  .addHelpText('after', `
Examples:
  $ ralph doctor
  $ ralph doctor --repo ~/Project/my-project`)
  .action(doctorCommand);

program
  .command('queue')
  .description('Inspect active queue state, blockers, leases, and next actions')
  .option('--watch', 'Continuously emit aggregated queue snapshots using one process')
  .option('--interval <ms>', 'Polling interval in milliseconds for --watch mode', '10000')
  .option('--stale-after-ms <ms>', 'Override the manager heartbeat stale threshold used in queue snapshots')
  .option('--recent-completed-window-seconds <seconds>', 'Recent integrated task window for queue snapshots', '7200')
  .option('--recent-completed-limit <count>', 'Maximum recent integrated tasks to include in queue snapshots', '5')
  .option('--compact', 'Emit trimmed task payloads for lightweight consumers like the menubar')
  .addHelpText('after', `
Examples:
  $ ralph queue
  $ ralph queue --watch
  $ ralph queue --watch --interval 30000
  $ ralph queue --compact`)
  .action((options) => queueCommand({
    watch: options.watch,
    interval: options.interval,
    staleAfterMs: options.staleAfterMs,
    recentCompletedWindowSeconds: options.recentCompletedWindowSeconds,
    recentCompletedLimit: options.recentCompletedLimit,
    compact: options.compact,
  }));

program
  .command('watchdog')
  .description('Continuously monitor Ralph managers and auto-restart stale or code-drifted launchd services')
  .option('--interval <ms>', 'Polling interval in milliseconds', '30000')
  .option('--stale-after-ms <ms>', 'Override the manager heartbeat stale threshold used in queue snapshots')
  .option('--recent-completed-window-seconds <seconds>', 'Recent integrated task window for queue snapshots', '7200')
  .option('--recent-completed-limit <count>', 'Maximum recent integrated tasks to include in queue snapshots', '5')
  .option('--home-path <path>', 'Ralph home to monitor (repeatable); defaults to discovered launchd managers', collectRepeatedOption, [])
  .option('--homes <paths>', 'Comma-separated Ralph homes to monitor')
  .option('--log <path>', 'JSONL watchdog event log path')
  .option('--once', 'Run one watchdog check and exit')
  .option('--dry-run', 'Report restart actions without running launchctl')
  .option('--no-restart-code-drift', 'Do not auto-restart managers whose loaded code is older than disk')
  .option('--no-restart-stale', 'Do not auto-restart stale, down, or missing-state managers')
  .addHelpText('after', `
Examples:
  $ ralph watchdog --once
  $ ralph watchdog --home-path ~/.ralph --home-path ~/.ralph-ez4ielts
  $ ralph watchdog --interval 30000

Description:
  The watchdog monitors every launchd Ralph manager it can discover.
  It automatically kickstarts manager services when queue snapshots report
  code drift ("older than current code"), stale heartbeats, down managers, or
  missing manager state. Concrete queue actions such as blocked, awaiting
  approval, policy-blocked, or diagnostics states are recorded to the JSONL
  event log for higher-level repair workflows; the watchdog does not kill
  active finalizers or blindly retry semantic task failures.`)
  .action((options) => watchdogCommand(options));

program
  .command('watchdog-install')
  .description('Install a macOS launchd service that keeps the Ralph watchdog running')
  .option('--label <label>', 'launchd label')
  .option('--plist <path>', 'Path to write the launchd plist')
  .option('--interval <ms>', 'Polling interval in milliseconds', '30000')
  .option('--stale-after-ms <ms>', 'Override the manager heartbeat stale threshold used in queue snapshots')
  .option('--home-path <path>', 'Ralph home to monitor (repeatable); defaults to discovered launchd managers', collectRepeatedOption, [])
  .option('--homes <paths>', 'Comma-separated Ralph homes to monitor')
  .option('--log <path>', 'JSONL watchdog event log path')
  .option('--load', 'Load and kickstart the launchd watchdog after writing the plist')
  .option('--dry-run', 'Print the resolved launchd config without writing or loading it')
  .option('--no-restart-code-drift', 'Do not auto-restart managers whose loaded code is older than disk')
  .option('--no-restart-stale', 'Do not auto-restart stale, down, or missing-state managers')
  .addHelpText('after', `
Examples:
  $ ralph watchdog-install --load
  $ ralph watchdog-install --home-path ~/.ralph --home-path ~/.ralph-ez4ielts --load
  $ ralph watchdog-install --dry-run`)
  .action(watchdogInstallCommand);

program
  .command('watchdog-uninstall')
  .description('Unload and remove the macOS launchd service for the Ralph watchdog')
  .option('--label <label>', 'launchd label')
  .option('--plist <path>', 'Path to the launchd plist')
  .option('--dry-run', 'Print what would be removed without unloading or deleting')
  .addHelpText('after', `
Examples:
  $ ralph watchdog-uninstall
  $ ralph watchdog-uninstall --dry-run`)
  .action(watchdogUninstallCommand);

program
  .command('cleanup')
  .description('Remove old terminal task worktrees according to a retention window')
  .option('--older-than-hours <hours>', 'Only clean terminal tasks older than this many hours', '24')
  .option('--include-orphans', 'Also reclaim unreferenced clean Ralph worktrees')
  .option('--archive-dirty', 'Archive evidence for eligible dirty terminal worktrees without removing them')
  .option('--include-dirty-failed', 'Archive then reclaim eligible dirty failed/finalize/stagnant worktrees')
  .option('--include-dirty-orphans', 'Archive eligible dirty orphan worktrees when --include-orphans is also used')
  .option('--reclaim-archived-dirty', 'Allow explicit archive-then-reclaim behavior for dirty cleanup candidates')
  .option('--abandon-retryable', 'Allow explicit dirty cleanup for retry-attention failures')
  .option('--repo <path>', 'Repository path to scan for orphan worktrees')
  .option('--max-removals <count>', 'Maximum number of worktrees to remove in this run')
  .option('--dry-run', 'Show cleanup candidates without removing worktrees')
  .addHelpText('after', `
Examples:
  $ ralph cleanup --dry-run
  $ ralph cleanup --older-than-hours 168
  $ ralph cleanup --archive-dirty --older-than-hours 336
  $ ralph cleanup --include-dirty-failed --older-than-hours 336
  $ ralph cleanup --include-orphans --repo ~/Project/myproject --dry-run`)
  .action(cleanupCommand);

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
