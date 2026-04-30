# Ralph follow-up: failed merge-repair auto-retry gap

Date: 2026-04-27
Repo: `/Users/shawn/Project/ralph-cli`
Ralph home: `/Users/shawn/.ralph`
Control plane under load: `/Users/shawn/Project/atta`

## Why this follow-up exists

The earlier Oracle-guided patch fixed the proof-of-repair problem:

- merge repair is now exact-probe-first
- post-finalize merge probe is durable
- merge-conflict finalize loops no longer count HEAD churn as progress

Those fixes are implemented locally and tests pass.

However, a new operator-facing gap remains:

- when merge repair is blocked by the exact mergeability probe, the task lands in `failed`
- it does **not** automatically requeue into another bounded merge-repair loop
- it only continues if a human runs `ralph retry <task>`

So the mechanism now correctly rejects fake convergence, but still lacks an automatic convergence path for `failed merge-repair`.

## Concrete live example

Task:

- `task-1777205961227-xv47odlvq`
- PRD: `atta-operator-overview-home-v1`

Current live behavior:

- worker executed merge repair on anchored story `US-003`
- agent summary claimed semantic resolution and test success
- Oracle/Codex then probed the real task worktree/branch
- both exact probes still reported real conflicts:
  - `packages/control-plane/src/routes/org-routes.ts`
  - `packages/control-plane/src/types.ts`
- task was marked `failed`
- Ralph did **not** automatically retry it
- a manual `node dist/cli.js retry task-1777205961227-xv47odlvq` was required

## Important current observations

### 1. This is not old stale manager code

Manager was restarted after the recent mechanism patch and now reports:

- `codeDriftDetected: false`

So the current behavior is coming from the new code, not an outdated manager.

### 2. This is not a false-positive probe

Both exact probes still fail for the live task:

- `probeTaskWorktreeMergeability(...)`
- `probeTaskMergeability(...)`

Both currently return:

- `mergeable: false`
- `alreadyIntegrated: false`
- conflict files:
  - `packages/control-plane/src/routes/org-routes.ts`
  - `packages/control-plane/src/types.ts`

### 3. The agent is still overclaiming completion

The task log shows a typical bad pattern:

- the agent says the semantic resolution already exists in the current worktree
- says tests passed
- says a temp clone merge was resolved by replacing files with current worktree versions

But the real task worktree/branch still fails Ralph’s exact probe.

So the remaining mechanism problem is no longer proof acceptance. It is automatic recovery / requeue behavior after proof rejection.

## Relevant code paths

### Worker

`src/worker.ts`

Current behavior:

- merge repair exact probe failure happens inside normal story execution
- after attempts are exhausted, the worker does:
  - story status -> `failed`
  - `finalizeTask(task, 'failed', ...)`

This means failed merge-repair exits through the generic terminal `failed` path rather than a dedicated merge-repair recovery loop.

### Scheduler terminal transition

`src/core/scheduler.ts`

`finalizeTask(...)` only:

- marks the task terminal
- clears lease
- schedules pending tasks

It does not distinguish failed merge-repair from ordinary failed feature execution.

### Soft failed recovery

`src/core/dependency-watcher.ts` -> `recoverSoftFailedTasks()`

This only upgrades `failed` tasks when evidence says they are actually done.

For merge repair it now correctly blocks soft recovery unless the exact worktree probe passes.

That is good, but it also means a genuine failed merge-repair has no automatic next step.

### Failed finalize recovery

`src/core/dependency-watcher.ts` -> `recoverFailedFinalizeTasks()`

This path **does** have:

- progress/deadline/hard-cap based requeue logic
- exact probe refresh
- merge repair requeue

But it only covers `failed_finalize`, not worker-level `failed` merge repair.

### Prompt / repair contract

`src/core/repair-context.ts`
`src/core/dependency-watcher.ts`
`src/commands/retry.ts`

Prompt text was tightened further after observing this issue:

- the actual task branch/worktree must pass exact probe
- temp clone / manual merge rehearsal is advisory only
- agent must materialize resolution in the real task worktree/branch

This reduces false claims, but it does not address the missing automatic retry loop.

## The mechanism question for Oracle

Please review the current Ralph code and this live failure pattern, then answer:

1. What remaining mechanism gaps still exist after the recent proof-of-repair patch?
2. Is the lack of auto-retry for `failed merge-repair` the main missing state-machine branch, or are there deeper issues too?
3. What is the smallest safe redesign to make failed merge-repair automatically requeue with bounded convergence control?
4. Should failed merge-repair:
   - stay in `failed` and be auto-recovered by watcher into `pending merge repair`, or
   - use a new dedicated status / recovery state, or
   - be converted into `failed_finalize`-style repair state?
5. How should progress / no-progress be measured for worker-level merge repair loops so Ralph does not spin forever on genuine semantic conflicts?
6. What regression tests should be added so this exact gap does not come back?

## Specific design axes Oracle should evaluate

- whether worker-level merge repair should share the same bounded loop policy as finalize repair
- whether `failed merge-repair` needs durable counters/deadline/hard cap separate from finalize repair
- whether the watcher should auto-requeue `failed` merge-repair only when:
  - conflict signature changed, or
  - attempt budget not exhausted, or
  - deadline/hard cap not reached
- whether exact probe failures should immediately increment a merge-repair no-progress counter
- whether the current agent prompt still needs stronger structured acceptance criteria
- whether observed write-surface drift / extra file churn should be treated as a risk signal during merge repair

## Requested Oracle output

Please give:

- root-cause statement for the remaining gap(s)
- recommended state-machine redesign
- P0 / P1 patch order
- concrete tests to add
- any operator UX changes needed so queue/status clearly explain why a task was auto-requeued vs stopped
