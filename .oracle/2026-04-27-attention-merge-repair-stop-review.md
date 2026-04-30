# Ralph Attention Regression Review

Context date: 2026-04-27

Review the current live Ralph state and determine whether the renewed `Attention: 1` condition is expected behavior or a mechanism gap. Focus on merge-repair recovery and stop conditions, not on generic queue semantics.

## Source of truth

- Ralph home: `/Users/shawn/.ralph`
- Ralph CLI repo: `/Users/shawn/Project/ralph-cli`
- Manager entry: `/Users/shawn/Project/ralph-cli/dist/cli.js`

## Live runtime facts

Manager is healthy and running current code:

```json
{
  "pid": 93248,
  "status": "running",
  "heartbeatStale": false,
  "codeDriftDetected": false,
  "repoPaths": [
    "/Users/shawn/Project/atta",
    "/Users/shawn/Project/ez4ielts"
  ]
}
```

Current menubar-style attention calculation over `~/.ralph/tasks` yields exactly one attention task:

```json
{
  "attentionCount": 1,
  "attention": [
    {
      "id": "task-1777205961227-xv47odlvq",
      "status": "failed",
      "prdId": "atta-operator-overview-home-v1",
      "repoPath": "/Users/shawn/Project/atta",
      "integrationStatus": "blocked_conflict",
      "updatedAt": 1777292462793,
      "lastError": "Merge conflicts detected: packages/control-plane/src/routes/org-routes.ts, packages/control-plane/src/self-improvement-experiment.ts, packages/control-plane/src/skill-materialization.ts, packages/control-plane/src/types.ts",
      "mergeError": "Merge conflicts detected: packages/control-plane/src/routes/org-routes.ts, packages/control-plane/src/self-improvement-experiment.ts, packages/control-plane/src/skill-materialization.ts, packages/control-plane/src/types.ts",
      "autoRecoveryKind": "merge_repair",
      "autoRecoveryStopReason": "merge_repair_deadline_exhausted"
    }
  ]
}
```

So the current `Attention` display appears to reflect a real failed task, not a stale menubar count.

## Why this is suspicious

This task previously participated in the new stagnant auto-recovery path:

```json
{
  "timestamp": 1777284294142,
  "type": "task_recovered_stagnant_running",
  "status": "stagnant",
  "message": "Running worker made no progress for 1804s; task was marked stagnant for retry"
}
```

Then the new watcher logic requeued it automatically:

```json
{
  "timestamp": 1777291295866,
  "type": "stagnant_recovery_auto_requeued",
  "status": "pending",
  "storyId": "US-003",
  "message": "Automatically requeued merge repair after stagnation",
  "data": {
    "repairMode": "merge",
    "totalRequeues": 1,
    "hardCap": 20
  }
}
```

It ran again, but then stopped as failed attention:

```json
{
  "timestamp": 1777292454155,
  "type": "story_failed",
  "status": "failed",
  "storyId": "US-003",
  "message": "Exact mergeability probe still fails against ralph/integration/main. Conflict files: packages/control-plane/src/routes/org-routes.ts, packages/control-plane/src/self-improvement-experiment.ts, packages/control-plane/src/skill-materialization.ts, packages/control-plane/src/types.ts. Merge conflicts detected: packages/control-plane/src/routes/org-routes.ts, packages/control-plane/src/self-improvement-experiment.ts, packages/control-plane/src/skill-materialization.ts, packages/control-plane/src/types.ts"
}
```

Immediately after that:

```json
{
  "timestamp": 1777292462793,
  "type": "merge_repair_stopped",
  "status": "failed",
  "storyId": "US-003",
  "message": "Worker merge repair deadline exhausted",
  "data": {
    "stopReason": "merge_repair_deadline_exhausted",
    "consecutiveNoProgress": 1,
    "totalRequeues": 0,
    "deadlineAt": 1777289711574
  }
}
```

The suspicious part is that after the stagnation auto-requeue, the merge-repair stop still appears to be governed by an older persisted deadline (`deadlineAt: 1777289711574`), so the task may have only gotten one more run before returning to permanent attention.

## Current task shape

Relevant current fields on the failed task:

```json
{
  "id": "task-1777205961227-xv47odlvq",
  "prdId": "atta-operator-overview-home-v1",
  "status": "failed",
  "integrationStatus": "blocked_conflict",
  "repairContext": {
    "mode": "merge",
    "storyId": "US-003"
  },
  "autoRecoveryKind": "merge_repair",
  "autoRecoveryStopReason": "merge_repair_deadline_exhausted",
  "mergeRepairRecoveryStopReason": "merge_repair_deadline_exhausted"
}
```

## Questions

1. Is the renewed `Attention: 1` state currently semantically correct?
2. Is the underlying reason a real recovery mechanism gap?
3. Specifically, should a task that was requeued by stagnant recovery continue to inherit an old merge-repair deadline and immediately stop on the next failed mergeability probe?
4. If that is a mechanism gap, what is the minimal, correct fix plan?
5. If this is intentional, what operator-facing behavior or state should be added so this does not look like Ralph regressed or got stuck again?

## Files to inspect

- `src/core/dependency-watcher.ts`
- `src/commands/retry.ts`
- `tools/ralph-menubar/Sources/RalphMenuBar/SnapshotLoader.swift`
- `tools/ralph-menubar/Sources/RalphMenuBar/RalphMenuBarView.swift`

Ground the answer in the attached files and the runtime facts above. Prefer a small, actionable plan over a broad redesign.
