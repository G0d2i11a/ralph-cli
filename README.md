# Ralph CLI

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Lightweight Ralph loop**: PRD → `ralph start` → autonomous execution → done. Simple CLI tool for PRD-driven development with Claude Code or Codex.

Based on [Geoffrey Huntley's Ralph pattern](https://ghuntley.com/ralph/) and inspired by [ralph-mcp](https://github.com/G0d2i11a/ralph-mcp).

[中文文档](./README.zh-CN.md)

## Quick Start

```bash
# Install
npm install -g ralph-cli

# Start a task
ralph start ./my-prd.json --agent claude

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
| Manual quality checks | Auto quality gates (type check, lint, build) |

## Features

- **Simple CLI Interface** - Start, stop, and monitor tasks from command line
- **Git Worktree Isolation** - Each task runs in its own worktree, zero conflicts
- **Dual Agent Support** - Use Claude Code or Codex CLI
- **State Persistence** - Task state survives restarts
- **Quality Gates** - Automatic type check, lint, and build before commits
- **Batch Execution** - Start multiple PRDs at once
- **Progress Tracking** - Monitor task status and completion

## Installation

### From npm (coming soon)

```bash
npm install -g ralph-cli
```

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
  --agent <name>   Agent to use: claude or codex (default: claude)
  --branch <name>  Base branch (default: main)
```

**Examples:**

```bash
# Start with Claude Code
ralph start ./prd-auth.json --agent claude

# Start with Codex
ralph start ./prd-payment.md --agent codex

# Specify repository
ralph start ./prd-api.json --repo ~/Code/my-project
```

### Batch start multiple PRDs

```bash
ralph batch-start prds/*.json --agent claude
```

Tasks beyond the configured concurrency limit stay `pending` and start automatically as running tasks finish.

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
ralph update <task-id> --status completed --notes "Implemented authentication"
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
ralph stats
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

## How It Works

1. **Parse PRD** - Ralph reads your PRD file and extracts user stories
2. **Create Worktree** - Creates a git worktree for isolated development
3. **Spawn Agent** - Launches Claude Code or Codex to implement each user story
4. **Track Progress** - Maintains state in `~/.ralph/tasks/<task-id>/`
5. **Quality Gates** - Runs type check, lint, and build before commits
6. **Complete** - Marks task as completed when all user stories pass

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
  "agent": "claude",
  "createdAt": "2026-03-07T10:00:00Z",
  "updatedAt": "2026-03-07T10:30:00Z"
}
```

## Agents

### Claude Code

Uses Claude Opus 4 via LiteLLM proxy.

**Requirements:**
- Claude Code CLI installed (`npm install -g @anthropic/claude-code`)
- LiteLLM running on `localhost:4000`
- Environment variables:
  ```bash
  export ANTHROPIC_BASE_URL=http://localhost:4000/v1
  export ANTHROPIC_API_KEY=<your-litellm-master-key>
  ```

**Command:**
```bash
ralph start ./prd.json --agent claude
```

### Codex

Uses GPT-5.3 Codex via LiteLLM proxy.

**Requirements:**
- Codex CLI installed
- LiteLLM running on `localhost:4000`
- Environment variables:
  ```bash
  export OPENAI_BASE_URL=http://localhost:4000/v1
  export OPENAI_API_KEY=<your-litellm-master-key>
  ```

**Command:**
```bash
ralph start ./prd.json --agent codex
```

## Configuration

Ralph CLI stores configuration in `~/.ralph/config.json`:

```json
{
  "agent": {
    "path": "claude",
    "timeout": 600,
    "model": "claude-opus-4-6-thinking-xchai"
  },
  "runner": {
    "maxConcurrent": 3,
    "stagnationTimeout": 1800,
    "pollInterval": 10
  },
  "notification": {
    "enabled": false,
    "channel": "feishu",
    "target": ""
  }
}
```

Set concurrency to `2` by changing `runner.maxConcurrent`:

```json
{
  "runner": {
    "maxConcurrent": 2
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

### LiteLLM connection error

Check that LiteLLM is running:

```bash
curl http://localhost:4000/health
```

## License

MIT

## Credits

- Based on [Geoffrey Huntley's Ralph pattern](https://ghuntley.com/ralph/)
- Inspired by [ralph-mcp](https://github.com/G0d2i11a/ralph-mcp)
- Built with [Commander.js](https://github.com/tj/commander.js)
