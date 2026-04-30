# Ralph Merge Stall Root-Cause Packet

Date: 2026-04-27
Repo under review: `/Users/shawn/Project/ralph-cli`

## What changed before this packet

Earlier Oracle review already identified and we already implemented these mechanism fixes:

- filter `.git` / `.git-local` from finalizer/progress/evidence views
- make worker merge probe worktree-aware
- make finalizer bootstrap reuse-only
- add a post-finalize exact merge probe before completion

Those fixes build and test locally, but live tasks are still getting stuck in merge-repair / failed-finalize loops.

## Current question

We need the remaining root cause, not a generic review:

1. Why do merge-repair tasks still repeatedly get stuck after the earlier fixes?
2. Which remaining mechanism is actually wrong: worker repair execution, merge probe acceptance, finalizer/finalize-repair recovery, temp verification strategy, dependency bootstrap for temp repos, or task-state transitions?
3. Why does this keep surfacing as "卡住" from the operator point of view?
4. What is the clean design to stop this class of recurrence?

## Live failure sample A: `atta`

Task: `task-1777205961227-xv47odlvq`
PRD: `atta-operator-overview-home-v1`
Current status: `failed`

Important state facts:

- failure kind: exact mergeability probe still fails
- latest conflict files:
  - `packages/control-plane/src/routes/org-routes.ts`
  - `packages/control-plane/src/types.ts`
- task had real progress and tests, but Ralph still rejected merge repair

Relevant state snapshot:

- `status`: `failed`
- `repairContext.mode`: `merge`
- `lastError`: `Exact mergeability probe still fails against ralph/integration/main. Conflict files: packages/control-plane/src/routes/org-routes.ts, packages/control-plane/src/types.ts. Merge conflicts detected: packages/control-plane/src/routes/org-routes.ts, packages/control-plane/src/types.ts`

Important worker log facts:

- agent created a temp verification repo like `/tmp/atta-merge-verify.*`
- agent said semantic merge was repaired in source files
- agent said verification passed in temp repo
- agent also said it could not stage/commit the actual branch index because real git metadata was outside the writable sandbox
- worktree still showed helper `.git-local` changes from sandbox-local verification setup

This suggests a mechanism gap between:

- "repair proven in a temp repo"
- and "repair actually materialized in the real Ralph task worktree/branch in a way the exact probe accepts"

## Live failure sample B: `ez4ielts`

Task: `task-1777145974722-hqzfnajy8`
PRD: `prd-memory-wiki-coach-consumers`
Current status: `failed_finalize`

Important state facts:

- `completedUS`: `US-001`, `US-002`, `US-003`
- finalizer already committed:
  - `finalizerCommitSha`: `a385c5a5548db4495d10d7feb72eb62fe48b5326`
- current merge conflict files:
  - `docs/MEMORY-WIKI-ARCHITECTURE.md`
  - `docs/TODO.md`
- `integrationStatus`: `blocked_conflict`
- `finalizerAttempts`: `4`
- `finalizeRepairTotalRequeues`: `3`
- `mergeRepairAttempts`: `3`
- `lastErrorKind`: `merge_conflict`

Important timeline:

1. Earlier in this task, typecheck failed on missing `sharedKnowledgeText` payload fields.
2. Later, finalize prep failed on `db:generate:safe` because Prisma binary was missing from worktree node_modules.
3. After the reuse-only bootstrap / git-internal filtering fix, that Prisma problem stopped being the main blocker.
4. The task then moved into repeated doc merge-repair / failed-finalize cycles.

Important temp verification log facts:

- temp repo path like `/tmp/merge-repair-repo.*`
- offline `pnpm install --offline --frozen-lockfile` failed because local store was incomplete
- fallback copied/hard-linked `node_modules` trees from existing worktree
- temp repo still failed to run validation:
  - `tsc: command not found`
  - `tsx` module not found
- agent then still drifted back into "reported success / no objective diff or commit evidence" style behavior

This suggests another mechanism gap between:

- the environment in which merge/finalize repair is being validated
- and the actual task worktree dependency topology Ralph itself expects

## Why the operator perceives this as "stuck"

From the outside, Ralph often shows one of these patterns:

- a task stays `running` for a long time but is just bouncing through merge repair
- a task reaches `ready_to_finalize` or `failed_finalize`, then gets requeued, then lands back in the same conflict
- downstream tasks remain blocked by overlap/dependency rules

So even when the manager is alive, the queue looks frozen because the root blocking task is not converging.

## What we need from Oracle

Please answer concretely against the attached code and this packet:

1. Which mechanism is still fundamentally wrong after the earlier fixes?
2. Is the main remaining bug:
   - temp merge verification not being authoritative,
   - repair results not being materialized back into the real task branch/worktree,
   - finalizer/finalize-repair requeue logic accepting the wrong progress signal,
   - dependency/bootstrap assumptions for temp repos,
   - or a combination?
3. What invariant is missing that would force convergence instead of repeated requeue/fail loops?
4. What is the smallest safe mechanism redesign and patch order?
5. Which regression tests are missing for this exact recurrence class?

Please prioritize identifying the actual root cause over broad refactor advice.
