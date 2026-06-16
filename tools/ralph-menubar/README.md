# Ralph Menu Bar

Lightweight macOS menu bar monitor for local Ralph task progress.

## What it shows

- active Ralph tasks from registered Ralph homes
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
  "projects": [
    {
      "name": "default",
      "ralphHome": "~/.ralph"
    }
  ],
  "autoDiscoverHomes": false,
  "refreshSeconds": 5,
  "staleHeartbeatSeconds": 900,
  "recentCompletedWindowSeconds": 7200,
  "recentCompletedLimit": 5
}
```

Use `ralph init` to register a project with the menu bar:

```bash
ralph --home ~/.ralph-homes/my-project init --repo ~/Project/my-project --name my-project
```

Use the menu item `Edit Config` to change watched Ralph homes or the refresh interval.
`ralphHome` is kept for backward compatibility; `projects` is the active registered project list.

When `autoDiscoverHomes` is explicitly `true`, the app can also discover Ralph homes from:

- `~/.ralph`
- `~/.ralph-*`
- `~/.ralph-homes/*`

Auto-discovery is off by default so old temporary homes do not appear as projects. Discovered directories are shown only when they look like active Ralph homes, such as having tasks or manager state. Registered `projects` entries win on duplicate homes.
