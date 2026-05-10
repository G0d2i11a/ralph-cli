# Ralph CLI

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Lightweight Ralph loop**: PRD → `ralph start` → autonomous execution → done. Simple CLI tool for PRD-driven development with Codex or Claude Code.

Ralph CLI's main advantage is parallel local control: one CLI binary can run many isolated project managers, each with its own Ralph home, queue, locks, logs, integration worktree, and `runner.maxConcurrent` setting. Use it when you want Atta, ez4ielts, Ralph CLI itself, or any other repo moving at the same time without sharing one fragile global queue.

Based on [Geoffrey Huntley's Ralph pattern](https://ghuntley.com/ralph/) and inspired by [ralph-mcp](https://github.com/G0d2i11a/ralph-mcp).

Companion project: use [Ralph MCP](https://github.com/G0d2i11a/ralph-mcp) when you want the same Ralph workflow exposed as MCP tools inside Claude Code. Use Ralph CLI when you want a standalone terminal manager, launchd restart, lease/revision recovery, and a dedicated integration worktree.

[中文文档](./README.zh-CN.md)

## Quick Start

```bash
# Build from source (recommended until an npm release is published)
npm install
npm run build
npm link

# Start a task (defaults to Codex on the `cli` backend)
ralph start ./my-prd.json

# Use an isolated Ralph home for a specific project
ralph --home ~/.ralph-homes/my-project start ./my-prd.json

# Check status
ralph status

# Run the always-on manager loop
ralph manager

# List all tasks
ralph list
```

## Why Ralph CLI?

| Without Ralph | With Ralph CLI |
|---------------|----------------|
| Manual implementation | Autonomous agent execution |
| Lost progress on restart | Persistent state tracking |
| Manual git branch management | Automatic worktree isolation |
| No visibility into progress | Real-time status monitoring |
| Manual quality checks | Auto quality gates before finalize |
| One task watched by hand | Multiple project queues running in parallel |

## Features

- **Simple CLI Interface** - Start, stop, and monitor tasks from command line
- **Parallel Multi-Project Control Plane** - Run one always-on manager per repo, each with an isolated Ralph home and independent concurrency
- **Git Worktree Isolation** - Each task runs in its own worktree to avoid checkout collisions; merge conflicts can still happen later
- **Provider + Backend Support** - Keep `claude|codex` provider semantics and choose `cli` or `agent-runners`
- **State Persistence** - Task state survives restarts
- **Immutable Task Intake** - PRD identity, dependencies, source hash, base ref, and merge target are captured when a task is enqueued
- **Active PRD Dedupe** - The same active PRD is not queued twice for the same repo unless explicitly requested
- **Quality Gates** - Runs available `typecheck`, `lint`, `test`, and `build` scripts before the final commit
- **Batch Execution** - Start multiple PRDs at once; Ralph queues dependencies and runs safe work up to each home's configured concurrency
- **Repo-Scoped Integrated Dependencies** - PRD dependencies only resolve against integrated tasks from the same repository
- **Declared Coordination Metadata** - Optional PRD `writeSurface`, `conflictDomains`, and `integrationLane` hints are captured at intake
- **Repo-Scoped Overlap Protection** - Scheduler, finalize, and merge block only earlier overlapping tasks from the same repo
- **Lease + Revision Safety** - State updates are revisioned and stale `running` / `finalizing` leases are recoverable
- **Structured Event Log** - Task lifecycle events are written to `events.jsonl` and used by stats when available
- **Dedicated Integration Worktree** - Background merge runs in `.ralph-integration/` so dirty user checkouts do not block task integration
- **Watch + Auto-Ingestion** - Poll the queue and auto-enqueue new ez4ielts PRDs
- **Manager Health + launchd Restart** - The manager records heartbeat/status, prevents duplicate loops, and can install a macOS launchd service
- **Shared-Home Repo Visibility** - `queue`, `manager-status`, and `doctor` show when one Ralph home is carrying active tasks for multiple repos
- **Progress Tracking** - Monitor task status and completion

## Installation

### From source

```bash
git clone https://github.com/G0d2i11a/ralph-cli.git
cd ralph-cli
npm install
npm run build
npm link
```

## Usage

### Global Ralph Home

Ralph now supports an explicit control-plane home directory:

```bash
ralph --home ~/.ralph-homes/app-a queue
RALPH_HOME=~/.ralph-homes/app-b ralph manager
```

Resolution order is:

1. `--home <path>`
2. `RALPH_HOME`
3. default `~/.ralph`

Each Ralph home has its own `config.json`, `tasks/`, `manager/state.json`, `manager.lock`, `scheduler.lock`, `locks/`, `logs/`, queue view, and `runner.maxConcurrent`. This is the supported way to run two different repos on one machine with clean isolation while still sharing one Ralph CLI binary.

If you intentionally share one Ralph home across repos, coordination remains repo-scoped, and `ralph queue`, `ralph manager-status`, and `ralph doctor` report `repoCount`, `mixedRepos`, and active `repoPaths` so the mixed control plane is visible.

### Parallel Ralph

Ralph CLI is meant to be used as a small local control plane, not as a single foreground command that blocks one repository at a time.

- Use one Ralph CLI installation for every project on the machine.
- Use one `RALPH_HOME` per project to keep queues, locks, logs, manager state, and integration worktrees isolated.
- Run one manager per project, either in separate terminals or through `manager-install` launchd services.
- Set `runner.maxConcurrent` per home so heavy repos can run fewer workers and lighter repos can run more.
- Within one repo, Ralph still serializes unsafe integration through dependencies, overlap detection, and integration lane locks.

Example:

```bash
# Terminal or launchd service 1
ralph --home ~/.ralph-homes/atta manager --repo ~/Project/atta

# Terminal or launchd service 2
ralph --home ~/.ralph-homes/ez4ielts manager --repo ~/Project/ez4ielts

# Terminal or launchd service 3
ralph --home ~/.ralph-homes/ralph-cli manager --repo ~/Project/ralph-cli

# Feed each project independently
ralph --home ~/.ralph-homes/atta batch-start ~/Project/atta/docs/ralph-prds/*.json --repo ~/Project/atta
ralph --home ~/.ralph-homes/ez4ielts batch-start ~/Project/ez4ielts/tasks/*.md --repo ~/Project/ez4ielts

# Watch each control plane without spawning repeated status commands
ralph --home ~/.ralph-homes/atta queue --watch
ralph --home ~/.ralph-homes/ez4ielts queue --watch
```

This is the intended "parallel Ralph" workflow: many isolated managers, many queued PRDs, bounded per-project concurrency, and one shared CLI binary.

### Start a new task

```bash
ralph [--home <path>] start <prd-path> [options]

Options:
  --repo <path>        Repository path (defaults to current directory)
  --agent <name>       Agent to use: claude or codex (default: codex)
  --backend <name>     Backend to use: cli or agent-runners (default: cli)
  --allow-duplicate    Queue another active copy of the same PRD for this repo
```

**Examples:**

```bash
# Start with the default agent (Codex)
ralph start ./prd-auth.json

# Start with Claude Code explicitly
ralph start ./prd-payment.md --agent claude

# Use the unified agent-runners backend
ralph start ./prd-auth.json --backend agent-runners

# Specify repository
ralph start ./prd-api.json --repo ~/Code/my-project

# Queue a duplicate active PRD intentionally
ralph start ./prd-api.json --allow-duplicate
```

### Batch start multiple PRDs

```bash
ralph batch-start prds/*.json
```

Tasks beyond the configured concurrency limit stay `pending` and start automatically as running tasks finish.

Queued tasks are pinned to the repo base ref captured at intake. Changing the repo checkout later does not change the base used when the queued task eventually starts.

### Watch pending tasks and auto-ingest new ez4ielts PRDs

```bash
# Queue safety-net only
ralph watch

# Queue safety-net + auto-ingest brand new ez4ielts PRDs
ralph watch --auto-ingest-ez4ielts
```

When `--auto-ingest-ez4ielts` is enabled, Ralph polls the configured ez4ielts PRD directory (pass `--ez4ielts-dir`, set `RALPH_EZ4IELTS_WATCH_DIR`, or configure `ingestion.ez4ielts.watchDir` in `~/.ralph/config.json`) for new files matching `ez4ielts-*.json` and sends them through the same queue/start flow as `ralph start`.

- Existing matching files are treated as backlog and skipped when the watcher starts.
- Each new file is ingested once, even if it is modified again later.
- Auto-ingested tasks default to Codex unless `--agent claude` is passed.
- Auto-ingested tasks default to the `cli` backend unless `--backend agent-runners` is passed.
- Auto-ingested tasks default to the watched docs directory parent as their repo unless `--repo` is passed.
- Auto-ingest requires an explicit watch directory via `--ez4ielts-dir`, `RALPH_EZ4IELTS_WATCH_DIR`, or `ingestion.ez4ielts.watchDir` in `RALPH_HOME/config.json`.
- New files still respect dependency checks and the configured concurrency limit.

You can also enable the same mode through `RALPH_HOME/config.json` (default: `~/.ralph/config.json`) and then run plain `ralph watch`.

### Run the manager loop

```bash
ralph manager
ralph manager-status
```

`ralph manager` is the named always-on control-plane entry point. It performs queue movement, stale lease recovery, ready-to-finalize processing, optional auto-merge, and optional ez4ielts auto-ingestion. It writes a heartbeat to `~/.ralph/manager/state.json` and holds `~/.ralph/manager.lock` so a second manager does not accidentally run the same queue.

When you run multiple repos, point each one at a different Ralph home:

```bash
ralph --home ~/.ralph-homes/app-a manager --repo ~/Code/app-a
ralph --home ~/.ralph-homes/app-b manager --repo ~/Code/app-b
```

Each home gets its own manager state and lock, so those two managers can run concurrently.

Use `ralph manager-status` to inspect the current manager PID, heartbeat age, loop timing, stale status, and active repo summary for the current Ralph home. `ralph doctor` includes the same manager health signal in its JSON output.

### Keep the manager running with launchd

```bash
# Inspect the launchd config that would be generated
ralph --home ~/.ralph-homes/atta manager-install --dry-run --repo ~/Project/atta --disable-auto-ingest-ez4ielts

# Install and start the always-on manager for the current macOS user
ralph --home ~/.ralph-homes/atta manager-install --repo ~/Project/atta --disable-auto-ingest-ez4ielts --load

# Remove the launchd service
ralph --home ~/.ralph-homes/atta manager-uninstall
```

Ralph intentionally does not self-daemonize. The CLI owns internal health, heartbeat, lock, queue recovery, and status reporting; macOS `launchd` owns process restart via `KeepAlive`. This keeps restart behavior inspectable with normal OS tooling while avoiding duplicate manager loops.

Use `--disable-auto-ingest-ez4ielts` when you want the manager to process only the existing Ralph queue and not inherit a `ingestion.ez4ielts.enabled=true` setting from `RALPH_HOME/config.json`.

For the default home, launchd still uses the legacy label `com.ralph.manager`. For custom Ralph homes, `manager-install` derives a stable home-specific label such as `com.ralph.manager.<hash>` and writes logs under `<RALPH_HOME>/logs/`.

### Inspect the active queue

```bash
ralph queue
ralph queue --watch
```

The queue view now acts as the main aggregated runtime snapshot for one Ralph home. Default output is schema v2 and describes each task with `queueState`, plus top-level `actions` and `systemBlocks`. Ralph does not expose a generic operator-needed state: tasks are `queued`, `running`, `finalizing`, `recovering`, `blocked`, `awaiting_approval`, `blocked_by_policy`, `diagnostics`, or `completed`. A task can remain `pending` with reason `coordination` when an earlier same-repo task declared an overlapping write surface or conflict domain.

Use `ralph queue --watch` to keep one long-lived process open and emit fresh JSON snapshots on an interval instead of repeatedly spawning separate `queue`, `manager-status`, and `list` calls.

### Preflight the environment

```bash
ralph doctor
ralph doctor --repo ~/Code/my-project
```

`doctor` checks git availability, repo validity, dirty working tree risk, Codex availability, backend configuration, runner concurrency settings, manager health, and whether the current Ralph home is carrying active tasks for multiple repos.

### Cleanup old task worktrees

```bash
ralph cleanup --dry-run
ralph cleanup --older-than-hours 168
ralph cleanup --include-orphans --repo ~/Code/my-project --dry-run
```

`cleanup` runs the same policy-driven reclamation path as the manager and removes only terminal task worktrees after the retention window. Use `--dry-run` first to inspect candidates. Add `--include-orphans` with `--repo` to inspect clean unreferenced `.ralph-worktrees` entries.

The always-on manager also runs automatic worktree reclamation after startup and periodically after that. It skips active leases/PIDs, paths outside `.ralph-worktrees`, dirty orphan worktrees, dirty failed/stagnant/finalize worktrees by default, and recently completed worktrees retained by policy. Reclamation writes audit state under `<RALPH_HOME>/reclamation/last-run.json` and JSONL logs under `<RALPH_HOME>/logs/reclamation.jsonl`.

### Check task status

```bash
# Show all running tasks
ralph status

# Show specific task
ralph status <task-id>
```

### List all tasks

```bash
# List all tasks
ralph list

# Filter by status
ralph list --status running
ralph list --status completed
ralph list --status failed
```

### Stop a task

```bash
ralph stop <task-id>
```

### Update task progress

```bash
ralph update <task-id> --story-id US-001 --passes
ralph update <task-id> --story-id US-001 --notes "Implemented authentication"
```

### Retry failed task

```bash
ralph retry <task-id>
```

### Merge completed task

```bash
ralph merge <task-id>
```

Merge runs in a dedicated `.ralph-integration/<target>` worktree by default. Completed task branches are merged into `ralph/integration/<target>` first, so dirty user checkouts do not block autonomous integration. If the target branch checkout is clean, Ralph fast-forwards it; if the target checkout has uncommitted user changes, Ralph defers target sync and records the integration branch/worktree in task state.

Conflict handling is deliberately conservative. Unattended auto-merge defaults to `merge.strategy=manual`; when Git reports conflicts, Ralph records structured conflict metadata (`mergeConflictFiles`, integration branch/worktree, and repair attempts) and routes the task through merge-repair context instead of silently choosing `ours` or `theirs`. The destructive `ours`/`theirs` strategies are only intended for explicit manual merge commands, or for installations that deliberately set `merge.allowDestructiveAutoResolve=true`.

Before finalize or merge, Ralph also acquires a repo-scoped integration lane lock and can block on earlier same-repo tasks with overlapping declared or observed surfaces. This preserves shared integration state without forcing unrelated repos onto one global single queue.

### Reset stagnation detection

```bash
ralph reset-stagnation <task-id>
```

### View statistics

```bash
ralph stats <task-id>
ralph stats --all
```

## PRD Format

Ralph CLI supports both JSON and Markdown formats for PRD files.

### JSON Format

```json
{
  "id": "prd-auth",
  "title": "User Authentication System",
  "description": "Implement secure user authentication with JWT",
  "writeSurface": ["src/auth", "package.json"],
  "conflictDomains": ["auth", "db/users"],
  "integrationLane": "main",
  "userStories": [
    {
      "id": "US-001",
      "title": "User Registration",
      "description": "As a new user, I want to register an account",
      "acceptanceCriteria": [
        "Email validation",
        "Password strength check",
        "Duplicate email prevention"
      ]
    },
    {
      "id": "US-002",
      "title": "User Login",
      "description": "As a registered user, I want to log in",
      "acceptanceCriteria": [
        "JWT token generation",
        "Session management",
        "Invalid credentials handling"
      ]
    }
  ],
  "dependencies": []
}
```

### Markdown Format

```markdown
---
id: prd-auth
title: User Authentication System
description: Implement secure user authentication with JWT
writeSurface:
  - src/auth
  - package.json
conflictDomains:
  - auth
  - db/users
integrationLane: main
userStories:
  - id: US-001
    title: User Registration
    description: As a new user, I want to register an account
    acceptanceCriteria:
      - Email validation
      - Password strength check
      - Duplicate email prevention
  - id: US-002
    title: User Login
    description: As a registered user, I want to log in
    acceptanceCriteria:
      - JWT token generation
      - Session management
      - Invalid credentials handling
dependencies: []
---

## Additional Context

This PRD implements a secure authentication system using industry best practices.
```

Ralph also supports Markdown body sections like `## US-001: Title` or `### US-001: Title` with `**Description**` and `**Acceptance Criteria**` blocks.

Optional coordination fields:

- `writeSurface`: predicted files, directories, or package roots this task is expected to touch
- `conflictDomains`: coarse overlap tags when file lists would be too narrow or unstable
- `integrationLane`: serialization lane for finalize/merge; defaults to the merge target branch when omitted

Ralph uses declared coordination metadata at intake and queue start, then captures observed diff/package surface again before finalize or merge.

## How It Works

1. **Parse PRD** - Ralph reads your PRD file and extracts user stories
2. **Capture Intake Metadata** - Persists PRD id/title/dependencies/source hash, queue time, base ref, merge target, and optional coordination hints into task state
3. **Create Worktree** - Creates a git worktree from the captured base ref for isolated development
4. **Spawn Agent** - Launches Codex by default, or Claude Code when requested
5. **Track Progress** - Maintains revisioned state in `~/.ralph/tasks/<task-id>/`
6. **Require Objective Evidence** - A story is not marked passed from a success message alone; Ralph requires diff or commit evidence
7. **Quality Gates** - Runs available `typecheck`, `lint`, `test`, and `build` scripts before the restricted final commit
8. **Coordinate Queue Starts** - Before a pending task starts, Ralph compares its declared coordination metadata against earlier active tasks in the same repo
9. **Capture Observed Surface** - When a task becomes ready to finalize, Ralph records the actual changed files and affected package roots from git
10. **Serialize Finalize / Merge** - Finalize and merge run under a repo-scoped integration lane lock and re-check overlap before changing shared integration state
11. **Watch + Queue** - `ralph watch` can keep the queue moving, recover stale leases, finalize ready tasks, and auto-ingest new ez4ielts PRDs
12. **Complete / Integrate** - Marks task as completed after finalization; dependency chains wait for integrated upstream tasks

## State Management

Task state is stored in `~/.ralph/tasks/<task-id>/state.json`:

```json
{
  "id": "task-xxx",
  "prdPath": "/path/to/prd-auth.json",
  "prdId": "prd-auth",
  "prdTitle": "User Authentication System",
  "prdDependencies": [],
  "prdSourceHash": "sha256...",
  "enqueuedAt": 1772544497000,
  "baseRef": "main",
  "baseCommitSha": "abc123...",
  "intendedMergeTarget": "main",
  "status": "running",
  "revision": 3,
  "updatedAt": 1772544501000,
  "startTime": 1772544497775,
  "currentUS": "US-001",
  "completedUS": [],
  "storyProgress": [
    {
      "id": "US-001",
      "status": "in_progress",
      "attempts": 1,
      "updatedAt": 1772544500123
    }
  ],
  "worktree": "/path/to/worktree",
  "logPath": "/path/to/log",
  "eventLogPath": "/path/to/events.jsonl",
  "leaseOwner": "worker:12345",
  "leaseHeartbeatAt": 1772544500123,
  "leaseExpiresAt": 1772544800123,
  "agent": "codex",
  "backend": "cli",
  "repoPath": "/path/to/repo",
  "declaredWriteSurface": ["src/auth", "package.json"],
  "declaredConflictDomains": ["auth", "db/users"],
  "integrationLane": "main",
  "loopCount": 1,
  "consecutiveNoProgress": 0,
  "consecutiveErrors": 0,
  "lastProgressTime": 1772544500123,
  "lastFilesChanged": 3
}
```

Tasks that have reached finalize or merge can also record `observedWriteSurface`, `observedPackageSurface`, `surfaceCapturedAt`, `coordinationStatus`, `coordinationPhase`, `coordinationBlockers`, and `coordinationReason`. When Ralph detects overlap, it records a `coordination_blocked` event and leaves the task waiting instead of forcing a failed finalize/merge state.

## Agents

### CLI backend (default)

Runs the provider CLI directly.

**Codex command:** `codex exec <prompt> --full-auto`

**Claude command:** `claude -p <prompt> --model <model> --dangerously-skip-permissions --permission-mode bypassPermissions`

**Commands:**
```bash
ralph start ./prd.json
ralph start ./prd.json --agent claude
```

### agent-runners backend

Uses the unified agent-runners path. Claude session IDs are preserved for continuation, while Codex thread reuse is scoped by `agent.codexConversationScope` and defaults to same-story retry only.

**Command:**
```bash
ralph start ./prd.json --backend agent-runners
ralph start ./prd.json --agent claude --backend agent-runners
```

### Claude Code

Provider semantics stay the same on both backends: `--agent claude` means Claude Code.

**Requirements:**
- Claude Code CLI installed (`npm install -g @anthropic/claude-code`)
- For `agent-runners`, `agent.agentRunnersPath` or `RALPH_AGENT_RUNNERS_CLI` points at the agent-runners CLI
- Legacy `agent.sdkRunnerPath` and `RALPH_SDK_RUNNER_CLI` are still accepted
- If you route Claude traffic through LiteLLM or another proxy, set the corresponding env vars before starting Ralph

**Command:**
```bash
ralph start ./prd.json --agent claude
```

### Codex

Provider semantics stay the same on both backends: `--agent codex` means Codex.

**Requirements:**
- Codex CLI installed
- For `agent-runners`, `agent.agentRunnersPath` or `RALPH_AGENT_RUNNERS_CLI` points at the agent-runners CLI
- Legacy `agent.sdkRunnerPath` and `RALPH_SDK_RUNNER_CLI` are still accepted
- If you route OpenAI-compatible traffic through LiteLLM or another proxy, set the corresponding env vars before starting Ralph

**Command:**
```bash
ralph start ./prd.json
```

## Configuration

Ralph CLI stores configuration in `~/.ralph/config.json`:

```json
{
  "agent": {
    "backend": "cli",
    "path": "codex",
    "agentRunnersPath": "/absolute/path/to/agent-runners/dist/cli.js",
    "sdkRunnerPath": "",
    "timeout": 600,
    "extendIdleTimeoutForLongRunningCommands": true,
    "longRunningCommandPatterns": ["next build", "pnpm run build", "npm run build", "yarn build", "turbo build", "tsc"],
    "model": "claude-opus-4-6-thinking-xchai",
    "codexConversationScope": "story"
  },
  "runner": {
    "maxConcurrent": 3,
    "stagnationTimeout": 1800,
    "pollInterval": 10,
    "leaseTimeout": 300,
    "maxStoryAttempts": 2,
    "maxTransientRetriesPerStory": 3,
    "transientRetryBaseDelaySeconds": 15,
    "transientRetryMaxDelaySeconds": 180
  },
  "finalizer": {
    "qualityGateTimeout": 600,
    "leaseTimeout": 1800,
    "qualityGates": ["typecheck", "lint", "test", "build"],
    "repairPolicy": "progress",
    "maxRepairAttempts": 1,
    "maxNoProgressRepairRounds": 2,
    "repairDeadlineSeconds": 7200,
    "repairHardCap": 20
  },
  "ingestion": {
    "ez4ielts": {
      "enabled": false,
      "watchDir": "/absolute/path/to/your/ez4ielts-prds",
      "pattern": "ez4ielts-*.json",
      "settleMs": 2000
    }
  },
  "reclamation": {
    "enabled": true,
    "intervalSeconds": 900,
    "startupDelaySeconds": 30,
    "maxRunSeconds": 30,
    "worktrees": {
      "enabled": true,
      "completedRetentionHours": 24,
      "failedRetentionHours": 168,
      "failedFinalizeRetentionHours": 168,
      "stagnantRetentionHours": 168,
      "targetSyncDeferredRetentionHours": 72,
      "orphanRetentionHours": 24,
      "cleanupOrphans": true,
      "keepNewestPerRepo": 5,
      "maxRemovalsPerRun": 25,
      "removeDirtyFailedWorktrees": false
    }
  }
}
```

`agent.backend` defaults to `cli` in new configs. New tasks also default to Codex unless `--agent claude` is passed. `agent.agentRunnersPath` (or `RALPH_AGENT_RUNNERS_CLI`) points at the unified agent-runners CLI when you choose the `agent-runners` backend, `agent.timeout` is an idle timeout measured in seconds and is refreshed whenever the agent emits stdout or stderr, `agent.extendIdleTimeoutForLongRunningCommands` makes Ralph extend the idle wait instead of killing Codex when a configured long-running build command is still active inside the task worktree, `agent.codexConversationScope` accepts `attempt`, `story`, or `task` and controls whether agent-runners may pass `--resume-thread` for Codex, `runner.leaseTimeout` and `finalizer.leaseTimeout` are measured in seconds unless you pass a value >= 1000 (treated as milliseconds), `runner.maxStoryAttempts` controls bounded repair attempts per story, `runner.maxTransientRetriesPerStory` plus the transient retry delay settings control automatic backoff for transient provider/runtime failures, `finalizer.qualityGates` controls which package scripts run before final commit, `finalizer.repairPolicy=progress` keeps retrying while a repair round still makes measurable progress, `finalizer.maxRepairAttempts` bounds failed-finalize repair recycling, `finalizer.maxNoProgressRepairRounds` limits stagnant repair loops, `finalizer.repairDeadlineSeconds` applies a wall-clock cutoff, `finalizer.repairHardCap` is the absolute repair ceiling, `finalizer.qualityGateTimeout` follows the same unit rule, and `agent.model` is only used for Claude runs. `agent.path` is kept for Codex CLI path compatibility.

Legacy `agent.sdkRunnerPath` and `RALPH_SDK_RUNNER_CLI` are still accepted for compatibility.

If you already have an older config that points at `agent.sdkRunnerPath` (or exports `RALPH_SDK_RUNNER_CLI`) but does not set `agent.backend`, Ralph continues to resolve that setup as `agent-runners` until you explicitly set `agent.backend`.

Built-in notification delivery is not wired up yet, so the generated config intentionally omits any `notification` block.

Set concurrency to `2` by changing `runner.maxConcurrent`. `runner.pollInterval` is read from config in seconds when `ralph watch` is launched without `--interval`, `runner.stagnationTimeout` is used in seconds to mark long-stalled workers as stagnant only after their worker lease is no longer fresh, and `runner.leaseTimeout` controls how long a `running` task without a fresh worker heartbeat is trusted:

```json
{
  "runner": {
    "maxConcurrent": 2
  }
}
```

Enable ez4ielts auto-ingestion by changing `ingestion.ez4ielts.enabled` to `true`, setting `ingestion.ez4ielts.watchDir` (or `RALPH_EZ4IELTS_WATCH_DIR` / `--ez4ielts-dir`), and then running `ralph watch`:

```json
{
  "ingestion": {
    "ez4ielts": {
      "enabled": true
    }
  }
}
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run dev

# Run tests
npm test
```

## Architecture

```
src/
├── cli.ts              # CLI entry point
├── worker.ts           # Background worker process
├── types/
│   ├── prd.ts         # PRD data structures
│   └── task.ts        # Task data structures
├── core/
│   ├── state.ts       # State management
│   ├── worktree.ts    # Git worktree operations
│   ├── agent.ts       # Agent execution
│   ├── task-intake.ts # Shared PRD queueing logic
│   ├── task-coordination.ts # Repo-scoped overlap detection and integration lanes
│   ├── task-home-summary.ts # Active repo summary for shared Ralph homes
│   ├── merge-task-updates.ts # Shared task state updates for merge outcomes
│   ├── prd-auto-ingest.ts # ez4ielts PRD auto-ingestion
│   └── merge.ts       # Merge operations
├── commands/
│   ├── start.ts       # Start command
│   ├── batch-start.ts # Batch start command
│   ├── status.ts      # Status command
│   ├── list.ts        # List command
│   ├── stop.ts        # Stop command
│   ├── update.ts      # Update command
│   ├── retry.ts       # Retry command
│   ├── merge.ts       # Merge command
│   ├── queue.ts       # Queue inspection
│   ├── manager-status.ts # Manager heartbeat/status
│   ├── doctor.ts      # Environment + control-plane checks
│   ├── stats.ts       # Statistics command
│   └── completion.ts  # Shell completion
├── config/
│   └── manager.ts     # Configuration management
└── utils/
    └── helpers.ts     # Utility functions
```

## Comparison with Ralph MCP

| Feature | Ralph CLI | Ralph MCP |
|---------|-----------|-----------|
| **Interface** | Command line and always-on manager | MCP tools plus background runner |
| **Agent Support** | Claude Code, Codex via `cli` or `agent-runners` | Codex or Claude via `cli`, with SDK fallback |
| **Parallel Execution** | Multi-project managers plus per-home queueing up to configured concurrency | Automatic runner concurrency |
| **Dependency Management** | Repo-scoped integrated dependencies | Runner-managed dependencies |
| **Stagnation Detection** | Lease recovery, revision safety, and manager health | Automatic runner progress detection |
| **Auto-Ingestion** | `ralph watch --auto-ingest-ez4ielts` | `ralph-runner --watch-prds` |
| **Notifications** | None | Windows Toast |
| **Best For** | Terminal-first parallel automation, Codex-first workflows, finalizer/integration worktree safety | MCP-native Claude Code workflows |

## Troubleshooting

### Task stuck in "running" state

```bash
# Check task status
ralph status <task-id>

# Run the watcher/manager loop so stale leases are reconciled
ralph watch

# Reset stagnation detection
ralph reset-stagnation <task-id>

# Stop and retry
ralph stop <task-id>
ralph retry <task-id>
```

### Agent not found

Make sure the agent CLI is installed and in your PATH:

```bash
# For Claude Code
which claude

# For Codex
which codex
```

### Agent runners / proxy connection error

Check the following:

```bash
# agent-runners path
echo $RALPH_AGENT_RUNNERS_CLI

# Optional proxy variables if you use LiteLLM or another gateway
echo $ANTHROPIC_BASE_URL
echo $OPENAI_BASE_URL
```

## License

MIT

## Credits

- Based on [Geoffrey Huntley's Ralph pattern](https://ghuntley.com/ralph/)
- Companion to [ralph-mcp](https://github.com/G0d2i11a/ralph-mcp)
- Maintained by [G0d2i11a](https://github.com/G0d2i11a)
- Built with [Commander.js](https://github.com/tj/commander.js)
