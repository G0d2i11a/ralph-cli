# No Generic Operator Queue State

Oracle session: `ralph-no-human-attention-plan`

Oracle output source: `/tmp/ralph-no-human-attention-oracle-output.md`

## Goal

Ralph should not expose a generic operator-needed product state. The queue should describe concrete runtime states that Ralph can either keep handling autonomously or safely classify as a specific approval, policy block, environment block, dependency block, or diagnostic path.

## Public State Model

Default `ralph queue` output is schema v2:

- `schemaVersion: 2`
- per-task `queueState`
- top-level `actions`
- top-level `systemBlocks`
- summary counts for `running`, `recovering`, `awaitingApproval`, `blocked`, `blockedByPolicy`, `diagnostics`, and `queued`

Per-task phases:

- `queued`
- `running`
- `finalizing`
- `recovering`
- `blocked`
- `awaiting_approval`
- `blocked_by_policy`
- `diagnostics`
- `completed`

Default output must not emit deprecated operator-needed payloads or the old actionability status.

## Compatibility

The compatibility adapters have been removed. Ralph now exposes only the concrete queue model:

- no alternate schema selector
- no deprecated queue adapter payload
- no persisted repair-field mirroring or config fallback
- no menubar decode fallback to old task-level operator-needed fields

## State Mapping

Recoverable cases become `recovering`, not actions:

- transient retry
- agent-context retry
- story repair
- merge repair while still bounded
- baseline repair or baseline exhaustion reclassification
- finalize repair
- stagnation repair

Concrete blocked cases become `blocked`:

- failed dependency
- failed coordination owner
- active baseline repair dependency
- dirty target checkout
- ingestion configuration backlog
- scheduler deadlock with a concrete blocker

Safety boundaries become explicit:

- `awaiting_approval` when Ralph can proceed after a narrow approval with command, risk, and scope.
- `blocked_by_policy` when Ralph must not proceed unattended and the user must change config/PRD, stop duplicate managers, or manually repair.

Unknown or unclassified failures become `diagnostics`, not a generic operator state.

## Implemented In This Pass

- Added queue state types and derivation in `src/commands/queue.ts`.
- Changed default queue snapshots to v2 `queueState/actions/systemBlocks`.
- Replaced `needs_operator` actionability with concrete `blocked`, `blocked_by_policy`, `awaiting_approval`, `diagnostics`, `recovering`, `running`, `runnable`, `ingestion_backlog`, or `idle`.
- Updated watchdog events to use concrete queue action terminology.
- Updated menubar model, grouping, badges, header, tooltip, and summary pills to use approval/blocked/recovering language.
- Updated README queue documentation.
- Updated tests to assert the concrete queue-state model.

## Follow-Up Phase Completion

The persisted-state compatibility layer has been removed:

- `src/core/autonomy-repair.ts` is the primary implementation.
- `AutonomyRepairController`, `AutonomyRepairResult`, and `TaskAutonomyRepairKind` are the primary names.
- New config keys are `runner.autoRecoverBlockedTasks` and `runner.autonomyRepair*`.
- New event emissions use `autonomy_repair_stopped`, `baseline_exhaustion_reclassified`, and `baseline_supersession_migrated`.
- Queue generation no longer calls the removed generic operator adapter path.
- Follow-up PRD helpers now generate deterministic repair PRDs under `$RALPH_HOME/generated-prds/<task-id>/`, enqueue them, and record source task linkage/budget state.
- The watcher now runs stopped transient, agent-context, story/failed-blocker, and finalize repair follow-up generation before the finalizer loop.
