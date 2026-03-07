# ralph-cli

PRD-driven autonomous development CLI tool.

## Installation

```bash
cd ~/Code/ralph-cli
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
```

Example:
```bash
ralph start ./my-prd.json --repo ~/Code/my-project --agent claude
```

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
```

### Stop a task

```bash
ralph stop <task-id>
```

## PRD Format

Ralph supports JSON and Markdown formats for PRD files.

### JSON Format

```json
{
  "id": "project-id",
  "title": "Project Title",
  "description": "Project description",
  "userStories": [
    {
      "id": "US-001",
      "title": "User Story Title",
      "description": "As a user, I want...",
      "acceptanceCriteria": [
        "Criterion 1",
        "Criterion 2"
      ]
    }
  ],
  "dependencies": ["US-001"]
}
```

### Markdown Format

```markdown
---
id: project-id
title: Project Title
description: Project description
userStories:
  - id: US-001
    title: User Story Title
    description: As a user, I want...
    acceptanceCriteria:
      - Criterion 1
      - Criterion 2
---

Additional content here...
```

## How It Works

1. **Parse PRD**: Ralph reads your PRD file and extracts user stories
2. **Create Worktree**: Creates a git worktree for isolated development
3. **Run Agent**: Spawns Claude Code or Codex to implement each user story
4. **Track Progress**: Maintains state in `~/.ralph/tasks/<task-id>/`
5. **Complete**: Marks task as completed when all user stories are done

## State Management

Task state is stored in `~/.ralph/tasks/<task-id>/state.json`:

```json
{
  "id": "task-xxx",
  "status": "running",
  "currentUS": "US-001",
  "completedUS": ["US-000"],
  "worktree": "/path/to/worktree",
  "logPath": "/path/to/log"
}
```

## Agents

### Claude Code

Uses Claude Opus 4 via LiteLLM proxy. Requires:
- LiteLLM running on localhost:4000
- LITELLM_MASTER_KEY environment variable

### Codex

Uses GPT-5.3 Codex via LiteLLM proxy. Requires:
- LiteLLM running on localhost:4000
- OPENAI_BASE_URL and OPENAI_API_KEY configured

## Development

```bash
# Build
npm run build

# Watch mode
npm run dev
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
│   └── agent.ts       # Agent execution
├── commands/
│   ├── start.ts       # Start command
│   ├── status.ts      # Status command
│   ├── list.ts        # List command
│   └── stop.ts        # Stop command
└── utils/
    └── helpers.ts     # Utility functions
```

## License

MIT
