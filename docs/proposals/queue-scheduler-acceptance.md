# Queue Scheduler Acceptance

## Scenario Run

Ran an isolated local acceptance flow against the built CLI with `runner.maxConcurrent` set to `1`.

- Created a temporary git repo and temporary `HOME` so task state, config, logs, and worktrees stayed isolated from the developer environment.
- Put a fake local `claude` executable at the front of `PATH` so the real worker and scheduler paths could run safely without any network access.
- Started one long-running task, then started a second ready task while the first was still running.
- Let the first task reach a terminal state and observed the queued task auto-start without running `ralph watch`.
- Started a failing task, confirmed it reached `failed`, then retried it while another long-running blocker task occupied the only scheduler slot.

## Commands / Approach

- `node --test test/scheduler.test.js`
- `npm run build`
- `node /tmp/queue-scheduler-acceptance.js`

The acceptance harness used the real `dist/cli.js start` and `dist/cli.js retry` commands, real worker forks, real task state files under `~/.ralph/tasks`, and real git worktree creation inside a temporary repository.

## Observed Results

- The first task entered `running` immediately.
- The second task returned `status: pending`, `reason: queued`, and `concurrencyLimit: 1` while the first task was still running.
- At the queue check point, exactly one task was `running` and the extra task remained `pending`, confirming `maxConcurrent` was enforced.
- When the first task transitioned to `completed`, the queued task auto-started and moved to `running` without a watcher.
- A failed task retried while capacity was full returned `currentStatus: pending` with `reason: queued`.
- When the blocker task completed, the retried task auto-started under the same scheduler flow and then failed again as instructed by the fake agent.

## Caveats

- The acceptance used a fake local `claude` shim, so it validates scheduler, queueing, retry, worker, and worktree behavior without exercising any external agent service.
- The harness was executed from `/tmp` and is not committed; this note records the scenario and results from that local run.
