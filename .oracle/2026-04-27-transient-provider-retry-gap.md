# Ralph follow-up: transient provider failure recovery gap

Date: 2026-04-27
Repo: `/Users/shawn/Project/ralph-cli`
Ralph home: `/Users/shawn/.ralph`

## Why this follow-up exists

The earlier Oracle follow-up correctly identified the remaining merge mechanism gap:

- worker-level merge repair can fail the exact probe
- task exits through generic `failed`
- there is no bounded watcher-level auto-recovery branch

While checking current live failures, a second mechanism class showed up:

- a non-merge task failed because the agent/backend hit explicit transient errors
- the worker already has per-story transient retries
- after that local retry budget is exhausted, the task still exits through generic `failed`
- there is no watcher-level bounded recovery branch for terminal transient provider failures

This packet asks whether that is also a state-machine gap that should be fixed, and how it should coexist with the merge-repair redesign.

## Concrete live example

Task:

- `task-1777167246318-auq43nzhc`
- PRD: `ez4ielts-speaking-recording-transcription-prd`

Current state:

- `status: failed`
- no merge repair context
- no merge conflict files
- no post-finalize merge probe requirement

Observed failure in `agent.log`:

- `ERROR: Reconnecting... 1/5`
- `ERROR: Reconnecting... 2/5`
- `ERROR: Reconnecting... 3/5`
- `ERROR: Reconnecting... 4/5`
- `ERROR: Reconnecting... 5/5`
- `ERROR: We're currently experiencing high demand, which may cause temporary errors.`

The task died after two story attempts. It did not auto-requeue later.

## Important current code facts

### Worker already has local transient retry

`src/worker.ts`

The worker classifies explicit retryable failures via:

- `classifyAgentFailureOutput(...)`

It recognizes:

- `backend_high_demand`
- `backend_rate_limited`
- `transport_reconnecting`
- `transport_timeout`
- `browser_automation_failure`

These map to retryable classes like:

- `transient_backend`
- `transport`
- `browser_automation`

When:

- failure is explicit
- failure is retryable
- and there is no objective progress evidence

the worker performs in-process transient retries using:

- `runner.maxTransientRetriesPerStory` (default `3`)
- backoff from `runner.transientRetryBaseDelaySeconds` / `runner.transientRetryMaxDelaySeconds`

### But budget exhaustion still goes terminal

If the transient retry budget is exhausted inside the worker, the current code does:

- records `lastErrorKind`, `lastErrorClass`, `lastErrorRetryable`
- records `transientRetryCount`, `transientRetryBudget`
- story status -> `failed`
- `finalizeTask(task, 'failed', ...)`

So the task becomes generically terminal after a single worker session exhausts its local retry budget.

### Watcher has no matching recovery branch

`src/core/dependency-watcher.ts`

Current watcher recovery branches cover:

- soft failed tasks that look actually done
- failed finalize tasks
- completed blocked-conflict tasks

But there is no dedicated branch for:

- `status: failed`
- `lastErrorRetryable: true`
- `lastErrorClass: transient_backend | transport | browser_automation`
- transient retry budget exhausted inside the worker

## The mechanism question for Oracle

Please review the attached code and live task state, then answer:

1. Is terminal `failed` after exhausting in-worker transient retries also a mechanism gap, or is that acceptable policy?
2. Should Ralph add a watcher-level bounded auto-recovery branch for transient provider/transport failures after worker-level retry exhaustion?
3. If yes, should this be:
   - a generic `recoverFailedTransientTasks()` watcher path, or
   - part of a broader unified failed-task recovery policy shared with merge repair, or
   - intentionally left manual?
4. What should be the boundary between:
   - in-worker short backoff retries, and
   - watcher-level cross-loop requeue retries?
5. How should Ralph avoid infinite requeue loops on long vendor outages?
6. What durable state fields should exist for terminal transient failures so operators can see:
   - why it was retried
   - how many bounded retries remain
   - when it stopped permanently
7. Should transient provider failure recovery be available for all tasks, or only for tasks with zero objective progress?
8. How should this new branch coexist with the merge-repair auto-recovery redesign so the two mechanisms do not conflict?

## Specific design axes Oracle should evaluate

- whether `lastErrorRetryable: true` is enough as a selector, or whether typed `lastErrorKind` / `lastErrorClass` gating is required
- whether objective progress evidence should suppress watcher-level transient auto-requeue
- whether bounded transient recovery should have:
  - its own deadline
  - hard cap
  - consecutive no-progress / repeated same-signature counters
- whether vendor outage signatures like `backend_high_demand` and `transport_reconnecting` should share the same policy
- whether browser automation failures should be treated as a separate class from backend demand/rate limit
- whether retry counters should reset after real worktree progress
- what queue/status UX should show for “waiting on bounded transient recovery” vs “permanently stopped”

## Requested Oracle output

Please give:

- root-cause statement
- whether this is a mechanism bug or intentional policy gap
- recommended state-machine redesign
- how it should coexist with the merge-repair redesign
- P0 / P1 patch order
- concrete tests to add
