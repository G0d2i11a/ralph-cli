import type { PRD } from '../types/prd';

export type PRDExecutionGateReason = 'enqueue_blocked_until' | 'post_apply_pre_run_gate';

export interface PRDExecutionGateBlock {
  reason: PRDExecutionGateReason;
  blockers: string[];
  status?: string;
  detail: string;
  nextAction: string;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean))];
}

function isBlockedGateStatus(status?: string): boolean {
  return Boolean(status && /^(BLOCKED|PENDING|AWAITING|HOLD)/i.test(status));
}

export function describePrdExecutionGateBlock(prd: PRD): PRDExecutionGateBlock | undefined {
  const enqueueBlockers = stringList(prd.enqueueBlockedUntil);
  if (enqueueBlockers.length > 0) {
    return {
      reason: 'enqueue_blocked_until',
      blockers: enqueueBlockers,
      detail: 'PRD declares enqueueBlockedUntil entries',
      nextAction: `Resolve PRD enqueue gate: ${enqueueBlockers.join('; ')}`,
    };
  }

  const postApplyGate = prd.operator?.postApplyPreRunGate;
  const postApplyGateStatus = stringValue(postApplyGate?.status);
  const requiresTwoPhaseHold = prd.ralphExecutionPhases?.requiresTwoPhaseApplyRunHold === true;

  if (!requiresTwoPhaseHold || !isBlockedGateStatus(postApplyGateStatus)) {
    return undefined;
  }

  const runBlockers = stringList(prd.runBlockedUntil);
  const phase1SuccessStatus = stringValue(prd.ralphExecutionPhases?.phase1ApplyAndSeal?.successStatus);
  const applyOnlyStatus = stringValue(prd.applyOnlyStatus);
  const blockers = stringList([
    postApplyGateStatus,
    ...runBlockers,
  ]);
  const phase1Sealed = Boolean(
    applyOnlyStatus
    && phase1SuccessStatus
    && applyOnlyStatus === phase1SuccessStatus
  );

  return {
    reason: 'post_apply_pre_run_gate',
    blockers: blockers.length > 0 ? blockers : ['postApplyPreRunGate'],
    status: postApplyGateStatus,
    detail: phase1Sealed
      ? 'PRD phase-1 apply is sealed but post-apply/pre-run gate is still blocked'
      : 'PRD requires a two-phase apply/run hold before the normal worker may run',
    nextAction: phase1Sealed
      ? 'Wait for the operator-only post-apply/pre-run gate to be satisfied before running the gated effect.'
      : 'Use a Ralph two-phase apply/run-hold path or split the PRD before starting the normal worker.',
  };
}
