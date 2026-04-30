# Ralph CLI Mechanism Audit Packet

Date: 2026-04-27
Repo under review: `/Users/shawn/Project/ralph-cli`
Ralph home under review: `/Users/shawn/.ralph`
Requested by user: use workshop Oracle browser mode to explain why this fork repeatedly runs into recovery / merge / queue / manager issues, and why the original `snarktank/ralph` appears not to.

## Questions Oracle must answer

1. What are the root mechanism gaps in the current Ralph CLI design that explain the repeated stuck / retry / blocked / misleading-status incidents?
2. Which issues are implementation bugs versus architectural complexity mismatches?
3. Why does the original `snarktank/ralph` appear to avoid many of these failure modes?
4. What invariants should this fork enforce if it wants to support:
   - long-lived manager
   - shared Ralph home
   - multiple repos
   - auto recovery
   - merge repair
   - overlap-aware finalize and integration
5. Give a prioritized fix plan:
   - immediate stop-the-bleeding
   - short-term hardening
   - medium refactor
   - features that should be removed, simplified, or made opt-in

## Current runtime facts

- `manager-status --home /Users/shawn/.ralph` currently reports:
  - `repoCount: 2`
  - `mixedRepos: true`
  - `repoPaths: ["/Users/shawn/Project/atta", "/Users/shawn/Project/ez4ielts"]`
  - one canonical active manager on `~/.ralph`
  - `codeDriftDetected: false`
- `~/.ralph/manager.lock/owner.json` currently points to PID `53378`
- `~/.ralph/manager/state.json` currently records repo `/Users/shawn/Project/atta`
- process inspection observed:
  - a canonical manager for `atta`
  - an additional process launched as `manager --repo /Users/shawn/Project/ez4ielts`
  - at minimum, the operator experience makes it look like multi-manager execution is plausible even though the home-level lock is global
- `queue --home /Users/shawn/.ralph` currently shows active tasks from both repos in the same home

## Key runtime symptoms

### Symptom A: recurrent merge-repair loops on the same Atta task

Task:
- `task-1777205961227-xv47odlvq`
- `prdId: atta-operator-overview-home-v1`

Observed pattern:
- the same anchored story repeatedly passes
- then returns to merge repair
- then fails exact mergeability probe again
- then gets retried again
- conflict surface evolves as other tasks modify overlapping files

Current state excerpt:
- `status: running`
- `currentUS: US-003`
- `repairContext.mode: merge`
- `integrationStatus: blocked_conflict`
- merge conflicts currently include:
  - `packages/control-plane/src/routes/org-routes.ts`
  - `packages/control-plane/src/self-improvement-experiment.ts`
  - `packages/control-plane/src/skill-materialization.ts`
  - `packages/control-plane/src/types.ts`

Interpretation to check:
- the task is not just failing one static conflict
- the moving integration target and overlapping write surface may be causing a conflict horizon that keeps changing faster than repair can converge

### Symptom B: another Atta task is also in merge repair on overlapping surfaces

Task:
- `task-1777215173368-jxvhvjtu0`
- `prdId: atta-autonomy-truth-surface-consistency-v1`

Current state excerpt:
- `status: running`
- `currentUS: US-003`
- `repairContext.mode: merge`
- overlaps shared control-plane / docs surfaces

### Symptom C: ready_to_finalize task blocked by overlap coordination

Task:
- `task-1777215173973-2bl47c1rk`
- `prdId: atta-incidents-persistence-and-repair-ingestion-v1`

Current state excerpt:
- `status: ready_to_finalize`
- `coordinationStatus: blocked_observed_overlap`
- blockers:
  - `task-1777205961227-xv47odlvq`
  - `task-1777215173368-jxvhvjtu0`

Interpretation to check:
- coordination is doing something semantically reasonable
- but the combined system may be creating long dependency chains where one moving merge-repair task can freeze unrelated finalize progress for too long

### Symptom D: stagnant auto-recovery still heavily used

Task:
- `task-1777215174957-r1q8uhu7m`
- `prdId: atta-skill-materialization-monitoring-v1`

Current state excerpt:
- `status: running`
- `autoRecoveryKind: stagnant`
- `autoRecoveryTotalRequeues: 3`

Interpretation to check:
- even after recent fixes, the system is still relying heavily on auto-requeue as a normal operating mode
- determine whether this means poor worker prompting, poor task sizing, missing progress heartbeat semantics, or state-machine overreach

## Recently fixed bug that should be considered but not re-litigated

We already fixed one concrete issue locally:
- when a merge-repair task was auto-requeued from `stagnant`, the system reused stale `mergeRepairRecovery*` timing / deadline state
- this caused merge-repair recovery to re-enter `failed attention` too quickly

Fix was added in:
- `src/core/dependency-watcher.ts`
- covered by:
  - `test/failed-recovery.test.js`

Oracle should treat that as one bug fix, but still answer whether the larger mechanism is too coupled / fragile.

## Architecture concerns to evaluate

### 1. Home isolation boundary

This fork currently treats `RALPH_HOME` as a global shared state container for:
- tasks
- manager heartbeat/state
- scheduler locks
- merge / finalize locks
- cross-repo queue visibility

At runtime, one home is currently mixing:
- `atta`
- `ez4ielts`

Questions:
- Is mixed-repo shared home a sound default?
- If not, should repo-scoped home be the default invariant?
- If shared home remains allowed, what invariants must become explicit?

### 2. Manager semantics vs user-facing mental model

Observed:
- `manager-status` summarizes one canonical manager state for the home
- yet it is operationally easy to launch additional `manager --repo ...` processes
- one may block on the same global home lock or otherwise confuse operators

Questions:
- Is the system actually single-manager-per-home?
- If yes, should the product completely reject or auto-route additional manager launches instead of letting them appear plausible?
- Should there be one manager per repo instead of one per home?

### 3. Scheduler / concurrency model

Current fork adds:
- shared queue
- dependency gating
- concurrency slots
- running leases
- finalizing leases
- recovery termination logic

Questions:
- Are these mechanisms coherent when tasks from multiple repos share one home?
- Is the concurrency boundary repo-scoped, home-scoped, or lane-scoped?
- Is the current model overfitting for a shell-loop product?

### 4. Recovery state machine complexity

Current fork includes:
- soft failed recovery
- failed worker merge-repair recovery
- transient failure recovery
- stagnant recovery
- failed finalize recovery
- completed blocked_conflict recovery
- explicit retry command

Questions:
- Which of these are essential?
- Which of these interact in ways that make invariants hard to reason about?
- Is there a simpler state model that would preserve reliability better?

### 5. Merge repair semantics

Current fork expects Ralph to:
- detect exact worktree mergeability
- anchor repair to the last story
- preserve integrated behavior and task behavior
- requeue for bounded merge repair
- coordinate with other overlapping tasks

Observed failure mode:
- when multiple long-running tasks touch shared files, merge-repair may become a moving target instead of a bounded repair

Questions:
- Does automatic merge repair only work when integration target is relatively stable?
- Should overlapping tasks on the same surface be serialized much earlier?
- Is merge repair being used as a substitute for missing branch/integration topology discipline?

### 6. Coordination / overlap model

Current fork tracks:
- declared write surface
- observed write surface
- observed package surface
- integration lane blockers
- finalize blockers

Questions:
- Is this too late in the pipeline?
- Should conflicting tasks be prevented from running concurrently much earlier?
- Are there better invariants than “let them run, then coordination blocks finalize/integration”?

### 7. Original Ralph comparison

Original repo:
- GitHub: `https://github.com/snarktank/ralph`
- README says each iteration is a fresh instance with clean context
- memory is only via git history, `progress.txt`, and `prd.json`
- main loop is a thin shell script: `ralph.sh`
- no long-lived central manager
- no multi-repo shared home
- no persistent global scheduler
- no automated merge-repair state machine

From the original README and shell loop, the product seems intentionally much narrower:
- one project
- one PRD branch
- one story at a time
- fresh AI process every iteration
- commit / mark pass / continue

Oracle should explicitly compare whether this fork's repeated issues are caused by:
- implementation defects in otherwise valid new features
- or expanding Ralph beyond the original architecture without first defining stronger invariants

## What I want back

Please return:

1. A mechanism-by-mechanism diagnosis table:
   - mechanism
   - intended invariant
   - current gap
   - user-visible symptom
   - severity
2. A direct answer to:
   - “why does this fork keep producing these issues?”
   - “why does original Ralph appear to avoid them?”
3. A concrete plan:
   - immediate fixes
   - architecture changes
   - defaults to change
   - features to remove / simplify / make opt-in
4. If the real answer is “shared multi-repo home plus long-lived recovery-heavy manager is the wrong default”, say that directly.

