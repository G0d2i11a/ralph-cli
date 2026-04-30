# Ralph stagnant/attention + menubar review

## Context

- Repo under review: `/Users/shawn/Project/ralph-cli`
- Ralph home: `~/.ralph`
- Manager is alive and heartbeat is current.
- Current runtime state is not "manager dead"; it is "no active running tasks, while several tasks are stuck in attention/stagnant states and downstream tasks are dependency-blocked".

## Current live facts

### Manager

- `manager-status` reports:
  - `ok: true`
  - `processRunning: true`
  - `heartbeatStale: false`
  - `codeDriftDetected: false`

### Queue

- `queue` currently shows `running: 0` and only dependency-blocked `pending` tasks:
  - `atta-self-improvement-rollback-actuation-v1`
    - blockers: `atta-skill-materialization-monitoring-v1`, `atta-incidents-persistence-and-repair-ingestion-v1`
  - `atta-away-mode-simulator-not-activation-v1`
    - blockers: `atta-final-controlled-company-rollout-v1`, `atta-autonomy-truth-surface-consistency-v1`
  - `atta-final-controlled-company-rollout-v1`
    - blockers: `atta-autonomy-truth-surface-consistency-v1`, `atta-operator-overview-home-v1`

### Attention tasks in `~/.ralph`

These are currently counted by the menubar as "Blocked":

1. `task-1777167246318-auq43nzhc`
   - PRD: `ez4ielts-speaking-recording-transcription-prd`
   - status: `stagnant`
   - lastError: `Running worker made no progress for 1802s; task was marked stagnant for retry`
   - detail: US-001..US-003 passed, US-004 is a merge-repair loop

2. `task-1777205961227-xv47odlvq`
   - PRD: `atta-operator-overview-home-v1`
   - status: `stagnant`
   - integrationStatus: `blocked_conflict`
   - lastError: `Running worker made no progress for 1804s; task was marked stagnant for retry`
   - detail: merge-repair loop

3. `task-1777215173368-jxvhvjtu0`
   - PRD: `atta-autonomy-truth-surface-consistency-v1`
   - status: `stagnant`
   - detail: older stuck task, blocked near the beginning

4. `task-1777215173973-2bl47c1rk`
   - PRD: `atta-incidents-persistence-and-repair-ingestion-v1`
   - status: `stagnant`
   - detail: older stuck task, blocked near the beginning

5. `task-1777215174957-r1q8uhu7m`
   - PRD: `atta-skill-materialization-monitoring-v1`
   - status: `stagnant`
   - detail: older stuck task, blocked near the beginning

## What looks wrong

### Mechanism question

There are two candidate mechanism issues:

1. **Stagnant tasks are not being automatically recovered/requeued**
   - Current watcher improvements cover:
     - soft-failed recovery
     - failed worker merge-repair recovery
     - failed transient recovery
   - But these tasks are now `stagnant`, and there appears to be no automatic path that turns `stagnant` tasks back into actionable work.
   - Result: queue drains to zero running tasks, but downstream dependency graph remains blocked forever.

2. **Completed blocked/stagnant tasks still poison dependent scheduling**
   - Downstream `pending` tasks only wait on integrated dependencies.
   - If an upstream task becomes `stagnant` and nothing auto-resumes it, the whole queue can deadlock operationally even though manager is healthy.

Question: Is this a real recovery-mechanism gap? If yes, what is the right recovery policy for `stagnant` tasks, especially merge-repair stagnation?

### Menubar/UI question

The menubar currently shows:

- `Running`
- `Blocked`
- `Recent`

But implementation says:

- `Blocked` pill is actually `attentionCount`
- `attentionCount` includes:
  - `failed`
  - `failed_finalize`
  - `stagnant`
  - completed tasks with `integrationStatus == blocked_conflict`

So the label `Blocked` is semantically wrong. It is broader than blocked merges. It is really "needs attention".

Also:

- `Recent` pill is `recentCompletedCount`, i.e. count of recently completed tasks in a time window, not "recent activity" overall.

Question: Is the current menubar information architecture wrong? Should the labels / grouping be redesigned to better reflect:

- Running
- Attention
- Recently Completed

and maybe break out blocked merge separately?

## Files to inspect

- `tools/ralph-menubar/Sources/RalphMenuBar/RalphMenuBarView.swift`
- `tools/ralph-menubar/Sources/RalphMenuBar/SnapshotLoader.swift`
- `tools/ralph-menubar/README.md`
- `src/core/dependency-watcher.ts`
- `src/commands/retry.ts`
- `src/core/task-delivery.ts`

## Ask

Please answer these concretely:

1. Is the current "all workers stopped, queue only dependency-blocked pending tasks, several upstream tasks marked stagnant" state a real Ralph mechanism gap? If yes, identify the root cause precisely.
2. What recovery mechanism should Ralph add for `stagnant` tasks? Be explicit about trigger conditions, safeguards, and state transitions.
3. Is the menubar labeling/aggregation wrong? If yes, propose a corrected information architecture and naming.
4. Give a minimal implementation plan in `ralph-cli` to fix both:
   - runtime recovery behavior
   - menubar snapshot/view semantics
