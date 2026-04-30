# Ralph follow-up: recurring merge-repair root cause after home isolation

Date: 2026-04-28
Repo under review: `/Users/shawn/Project/ralph-cli`
Live homes under review:
- `/Users/shawn/.ralph` for `atta`
- `/Users/shawn/Project/ez4ielts/.ralph-cli-home` for `ez4ielts`

## Why this follow-up exists

The high-value control-plane bugs identified earlier have already been fixed locally:

- mixed active repos in one `RALPH_HOME` are now rejected by default
- `atta` and `ez4ielts` are now split into separate live homes
- old manager code drift was removed by restart
- retry/recovery reset logic was unified
- scheduler now resets runtime counters such as `lastProgressTime` when a pending task restarts

So the current problem is no longer "shared home pollution" or "stale manager code".

The remaining issue is narrower and more structural:

- both repos still keep landing in recurring merge-repair
- the specific task ids change, but the queue keeps re-forming around overlapping integration surfaces
- from the operator view, Ralph is healthy but still appears to "get stuck" because the moving conflict frontier never really collapses

We need Oracle to identify the new root cause and recommend the smallest mechanism change that prevents this class from recurring.

## Current live facts

### Control plane health

Both managers are healthy and on current code:

- `atta`
  - home: `/Users/shawn/.ralph`
  - `manager-status.ok = true`
  - `mixedRepos = false`
  - `codeDriftDetected = false`
- `ez4ielts`
  - home: `/Users/shawn/Project/ez4ielts/.ralph-cli-home`
  - `manager-status.ok = true`
  - `mixedRepos = false`
  - `codeDriftDetected = false`

So this review should assume the earlier home-isolation bug is already mitigated.

## Current symptom pattern

### Symptom A: `atta` still rotates through merge-repair on overlapping control-plane surfaces

Current head task:

- `task-1777215174957-r1q8uhu7m`
- PRD: `atta-skill-materialization-monitoring-v1`
- status: `running`
- `repairContext.mode = merge`

Current conflict files include:

- `packages/control-plane/src/routes/harness-routes.ts`
- `packages/control-plane/src/routes/skill-routes.ts`
- `packages/control-plane/src/self-improvement-experiment.ts`
- `packages/control-plane/src/skill-materialization.ts`
- `packages/control-plane/src/types.ts`
- `packages/control-plane/test/http-server.test.js`
- `packages/control-plane/test/skill-candidate-promotion.test.js`

Observed package surface:

- `packages/control-plane`

Interpretation:

- this is not a random one-off file conflict
- it is a broad shared control-plane surface
- a task that enters merge repair here is contending with a moving integration target

### Symptom B: a previous `atta` merge-repair task is now terminal but still blocks dependency progress

Failed task:

- `task-1777205961227-xv47odlvq`
- PRD: `atta-operator-overview-home-v1`
- status: `failed`

Recent state:

- task was previously recovered from stale/orphaned worker state
- it re-entered bounded merge-repair
- it failed again after exact mergeability still did not converge
- queue now shows: `wait for merge_repair auto-recovery requeue`

Interpretation:

- the recovery machinery is active
- but the merge-repair surface is still unstable enough that the task does not converge before a different overlapping task takes the active lane

### Symptom C: downstream `atta` tasks remain dependency-blocked behind a task that is still on the same hot surface

Examples:

- `task-1777215175044-40al65fbt`
  - `atta-self-improvement-rollback-actuation-v1`
  - pending on `atta-skill-materialization-monitoring-v1`
- `task-1777215173549-o07r3hj4o`
  - `atta-final-controlled-company-rollout-v1`
  - pending on `atta-operator-overview-home-v1`

Interpretation:

- queue semantics are correct
- operator pain is not fake state
- the system is doing what it was told, but the integration topology is not collapsing fast enough

### Symptom D: `ez4ielts` shows the same recurring pattern on a smaller surface

Current head task:

- `task-1777205696174-wa0tembkn`
- PRD: `prd-resumable-learning-sessions`
- status: `running`
- `repairContext.mode = merge`

Current conflict files include:

- `apps/web/app/(practice)/practice/_components/dashboard.tsx`
- `apps/web/app/(practice)/practice/_components/__tests__/dashboard.test.tsx`
- `docs/TODO.md`

Interpretation:

- this repo is smaller, but the same mechanism pattern is visible
- a running feature task reaches merge repair and contends with a changed integration target instead of converging quickly

## What changed since the last Oracle review

The following conditions are now true and should not be re-diagnosed as the primary cause:

1. mixed `RALPH_HOME` state is no longer the live default
2. current managers are not running stale code
3. restart-time runtime counters are now reset in scheduler, including `lastProgressTime`
4. `retry` and watcher reset semantics are more aligned than before

Therefore the new answer must explain why the system still keeps reforming merge-repair pressure after those fixes.

## Suspected remaining mechanism gap

The likely remaining gap is this:

- overlap detection exists
- but the most expensive serialization happens too late
- tasks with broad shared surfaces are allowed to progress far enough that merge repair becomes the main serialization point
- by the time repair starts, the integration target may already be moving due to another task on the same repo/lane/surface

That suggests a missing invariant such as one of:

1. earlier serialization of broad or known-hot overlap surfaces
2. quarantine of failed merge-repair tasks so later overlapping work cannot overtake them
3. stronger repo-local "one hot overlap cluster at a time" scheduling
4. explicit distinction between feature execution lanes and integration/repair lanes

## Questions for Oracle

Please inspect the attached code and answer these specifically:

1. What is the primary remaining root cause now that home isolation and code drift issues are fixed?
2. Is the real problem "merge repair starts too late in the pipeline"?
3. Should Ralph prevent a second overlapping task from running once an earlier task on the same observed surface has entered merge repair or blocked conflict?
4. Should failed merge-repair tasks on a hot shared surface effectively reserve that overlap cluster until they either integrate or are explicitly demoted/stopped?
5. Is the current `declaredWriteSurface` / `observedWriteSurface` model too weak because it only blocks later at start/finalize/merge, but not across the full conflict lifecycle?
6. What is the smallest safe redesign that prevents recurring moving-target merge repair without collapsing the entire repo into single-threaded execution?
7. What exact patches should be made first in:
   - `src/core/task-coordination.ts`
   - `src/core/scheduler.ts`
   - `src/core/dependency-watcher.ts`
   - `src/commands/retry.ts`
8. What regression tests are missing so this class does not come back?

## What I want back

Please return:

1. A direct root-cause statement for the current recurring issue
2. A clear answer to whether this is mainly:
   - late overlap serialization
   - bad merge-repair lane ownership
   - weak conflict-cluster invariants
   - or some combination
3. A small, practical fix plan in priority order
4. Any mechanism that should become opt-in rather than default
5. Concrete test cases to add

Focus on preventing recurrence, not on generic advice.
