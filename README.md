# Ralph CLI

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Lightweight Ralph loop**: PRD → `ralph start` → autonomous execution → done. Simple CLI tool for PRD-driven development with Codex or Claude Code.

Based on [Geoffrey Huntley's Ralph pattern](https://ghuntley.com/ralph/) and inspired by [ralph-mcp](https://github.com/G0d2i11a/ralph-mcp).

[中文文档](./README.zh-CN.md)

## Quick Start

```bash
# Build from source (recommended until an npm release is published)
npm install
npm run build
npm link

# Start a task (defaults to Codex on the `cli` backend)
ralph start ./my-prd.json

# Check status
ralph status

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

## Features

- **Simple CLI Interface** - Start, stop, and monitor tasks from command line
- **Git Worktree Isolation** - Each task runs in its own worktree, zero conflicts
- **Provider + Backend Support** - Keep `claude|codex` provider semantics and choose `cli` or `agent-runners`
- **State Persistence** - Task state survives restarts
- **Quality Gates** - Runs available `typecheck`, `lint`, and `build` scripts before the final commit
- **Batch Execution** - Start multiple PRDs at once
- **Watch + Auto-Ingestion** - Poll the queue and auto-enqueue new ez4ielts PRDs
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

### Start a new task

```bash
ralph start <prd-path> [options]

Options:
  --repo <path>    Repository path (defaults to current directory)
  --agent <name>   Agent to use: claude or codex (default: codex)
  --backend <name> Backend to use: cli or agent-runners (default: cli)
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
```

### Batch start multiple PRDs

```bash
ralph batch-start prds/*.json
```

Tasks beyond the configured concurrency limit stay `pending` and start automatically as running tasks finish.

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
- Auto-ingest requires an explicit watch directory via `--ez4ielts-dir`, `RALPH_EZ4IELTS_WATCH_DIR`, or `ingestion.ez4ielts.watchDir`.
- New files still respect dependency checks and the configured concurrency limit.

You can also enable the same mode through `~/.ralph/config.json` and then run plain `ralph watch`.

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

## How It Works

1. **Parse PRD** - Ralph reads your PRD file and extracts user stories
2. **Create Worktree** - Creates a git worktree for isolated development
3. **Spawn Agent** - Launches Codex by default, or Claude Code when requested
4. **Track Progress** - Maintains state in `~/.ralph/tasks/<task-id>/`
5. **Quality Gates** - Runs available `typecheck`, `lint`, and `build` scripts before the restricted final commit
6. **Watch + Queue** - `ralph watch` can keep the queue moving and auto-ingest new ez4ielts PRDs
7. **Complete** - Marks task as completed when all user stories pass

## State Management

Task state is stored in `~/.ralph/tasks/<task-id>/state.json`:

```json
{
  "id": "task-xxx",
  "prdId": "prd-auth",
  "status": "running",
  "currentUS": "US-001",
  "completedUS": [],
  "failedUS": [],
  "worktree": "/path/to/worktree",
  "logPath": "/path/to/log",
  "agent": "codex",
  "backend": "cli",
  "createdAt": "2026-03-07T10:00:00Z",
  "updatedAt": "2026-03-07T10:30:00Z"
}
```

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

Uses the unified agent-runners path and preserves Claude session IDs / Codex thread IDs across user stories.

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
    "model": "claude-opus-4-6-thinking-xchai"
  },
  "runner": {
    "maxConcurrent": 3,
    "stagnationTimeout": 1800,
    "pollInterval": 10
  },
  "ingestion": {
    "ez4ielts": {
      "enabled": false,
      "watchDir": "/absolute/path/to/your/ez4ielts-prds",
      // Or set RALPH_EZ4IELTS_WATCH_DIR to override this per machine.
      "pattern": "ez4ielts-*.json",
      "settleMs": 2000
    }
  }
}
```

`agent.backend` defaults to `cli` in new configs. New tasks also default to Codex unless `--agent claude` is passed. `agent.agentRunnersPath` (or `RALPH_AGENT_RUNNERS_CLI`) points at the unified agent-runners CLI when you choose the `agent-runners` backend, `agent.timeout` is measured in seconds, and `agent.model` is only used for Claude runs. `agent.path` is kept for Codex CLI path compatibility.

Legacy `agent.sdkRunnerPath` and `RALPH_SDK_RUNNER_CLI` are still accepted for compatibility.

If you already have an older config that points at `agent.sdkRunnerPath` (or exports `RALPH_SDK_RUNNER_CLI`) but does not set `agent.backend`, Ralph continues to resolve that setup as `agent-runners` until you explicitly set `agent.backend`.

Built-in notification delivery is not wired up yet, so the generated config intentionally omits any `notification` block.

Set concurrency to `2` by changing `runner.maxConcurrent`. `runner.pollInterval` is read from config in seconds when `ralph watch` is launched without `--interval`, and `runner.stagnationTimeout` is used in seconds to mark long-stalled workers as stagnant:

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
| **Interface** | Command line | MCP protocol (Claude Desktop) |
| **Agent Support** | Claude Code, Codex | Claude Code only |
| **Parallel Execution** | Automatic queueing up to configured concurrency | Automatic (Runner) |
| **Dependency Management** | Automatic task queueing | Automatic |
| **Stagnation Detection** | Manual reset | Automatic |
| **Notifications** | None | Windows Toast |
| **Best For** | CLI users, Codex support | Claude Desktop integration |

## Troubleshooting

### Task stuck in "running" state

```bash
# Check task status
ralph status <task-id>

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
- Inspired by [ralph-mcp](https://github.com/G0d2i11a/ralph-mcp)
- Built with [Commander.js](https://github.com/tj/commander.js)
