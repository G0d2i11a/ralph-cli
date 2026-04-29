# Ralph Menu Bar

Lightweight macOS menu bar monitor for local Ralph task progress.

## What it shows

- active Ralph tasks from one `RALPH_HOME`
- attention tasks, including `failed`, `failed_finalize`, `stagnant`, and completed tasks blocked on merge conflicts
- recent completed tasks from the configured recent window
- manager heartbeat and code-drift status

The app prefers `ralph queue` as its single runtime snapshot source and falls back to direct `state.json` scanning only if the CLI snapshot is unavailable.

## Build

This machine only needs Apple Command Line Tools:

```bash
npm run build:menubar
```

Build output:

```text
tools/ralph-menubar/build/RalphMenuBar.app
```

## Run

```bash
open tools/ralph-menubar/build/RalphMenuBar.app
```

## Config

On first launch the app writes:

```text
~/Library/Application Support/RalphMenuBar/config.json
```

Default config:

```json
{
  "ralphHome": "~/.ralph",
  "refreshSeconds": 5,
  "staleHeartbeatSeconds": 900,
  "recentCompletedWindowSeconds": 7200,
  "recentCompletedLimit": 5
}
```

Use the menu item `Edit Config` to change the watched Ralph home or refresh interval.
