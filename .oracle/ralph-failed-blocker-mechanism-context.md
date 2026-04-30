# Ralph failed-blocker queue context

Date: 2026-04-28

Project: `/Users/shawn/Project/ralph-cli`

Runtime homes:

- Atta Ralph home: `/Users/shawn/Project/atta/.ralph-cli-home`
- ez4ielts Ralph home: `/Users/shawn/Project/ez4ielts/.ralph-cli-home`

Both launchd managers are running and healthy. `codeDriftDetected=false` for both.

Current queue symptom:

- Atta manager is alive, but its only active item is `pending`, not `running`.
- ez4ielts manager is alive, but its two active items are `pending`, not `running`.
- The user asked whether this is normal and whether it is a mechanism problem.

Atta queue state:

```text
task-1777215175044-40al65fbt
PRD: atta-self-improvement-rollback-actuation-v1
Title: Actuate rollback and fallback from self-improvement monitoring signals
Status: pending
Completed stories: 2/3
Next action shown after queue display fix:
wait for integrated dependencies: atta-skill-materialization-monitoring-v1, atta-incidents-persistence-and-repair-ingestion-v1
```

Atta blocker states:

```text
atta-skill-materialization-monitoring-v1
task-1777215174957-r1q8uhu7m
status=failed
integrationStatus=failed
completedUS=2/3
lastErrorKind=story_incomplete
lastError=Task task-1777215174957-r1q8uhu7m cannot finalize: 1/3 stories are incomplete (US-001:failed:2)

atta-incidents-persistence-and-repair-ingestion-v1
task-1777215173973-2bl47c1rk
status=failed
integrationStatus=failed
completedUS=2/3
lastErrorKind=story_incomplete
lastError=Task task-1777215173973-2bl47c1rk cannot finalize: 1/3 stories are incomplete (US-001:pending:2)

atta-autonomy-rollback-controller-v1
task-1777215173234-3j44fxd6r
status=completed
integrationStatus=integrated
completed/integrated normally
```

ez4ielts queue state:

```text
prd-resumable-learning-sessions
task-1777205696174-wa0tembkn
status=pending
completedUS=2/3
nextAction=wait for earlier overlapping task(s) to integrate: task-1777205696155-exvwuddgi

prd-learning-artifacts-history
task-1777205696209-04as732go
status=pending
completedUS=0/3
nextAction=wait for integrated dependencies: prd-resumable-learning-sessions, prd-selection-action-loop
```

ez4ielts blocker state:

```text
prd-selection-action-loop
task-1777205696155-exvwuddgi
status=failed
integrationStatus=not_started
completedUS=4/5
lastErrorKind=merge_conflict
lastError=Merge conflicts detected: apps/api/src/modules/practice-chat/practice-chat.service.ts, apps/api/src/modules/targeted-drill/targeted-drill.service.ts, apps/web/tsconfig.json, docs/MEMORY-WIKI-ARCHITECTURE.md, docs/TODO.md
```

Relevant current code behavior:

- `checkDependencies` in `src/utils/helpers.ts` requires dependency task status `completed` plus integrated markers (`integratedAt`, `integrationCommitSha`, `mergedAt`, or `mergeCommitSha`).
- `TaskScheduler.schedulePendingTasks` in `src/core/scheduler.ts` skips pending tasks when dependencyState is not satisfied.
- `findCoordinationBlockers` in `src/core/task-coordination.ts` blocks on earlier overlapping tasks in statuses including `pending`, `running`, `ready_to_finalize`, `finalizing`, `failed_finalize`, and `completed`.
- Failed tasks are not considered blocking coordination by status, but dependency checks block on failed dependency PRDs because they are not integrated.

Recent related fixes already implemented:

- A task can no longer become `completed`/`integrated` unless all stories are passed.
- Manager audits historical `completed`/`finalizing`/`ready_to_finalize` tasks and invalidates incomplete story states.
- Queue `nextAction` display was changed so dependency/coordination blockers take priority over repair-context text.
- Stale merge-repair residue can no longer auto-recover ordinary failed stories.

Question for Oracle:

Is the current behavior a mechanism defect or an acceptable queue policy?

Please propose a concrete mechanism plan for Ralph CLI so dependent queues do not silently stall behind failed blockers. The plan should distinguish:

1. Hard correctness gates that should remain blocking.
2. Failed blocker states that should be auto-retried or converted into repair tasks.
3. Cases that should surface as attention instead of hidden pending.
4. UI/queue semantics for `pending`, `queued`, `blocked_by_failed_dependency`, `blocked_by_coordination`, and `needs_attention`.
5. Whether a downstream task should ever start when an upstream dependency is failed but partially complete.
6. The safest implementation order and tests to add.

Assume this is a local autonomous coding queue for multiple repos, with launchd managers and per-project Ralph homes.
