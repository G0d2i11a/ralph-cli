import { FailureObservation, Task } from '../types/task';
import { buildBaselineFailureSignature } from './baseline-quality-gate';
import { parseTurboNestedFailures } from './finalize-failure-classifier';

const MAX_FAILURE_HISTORY = 20;

export function buildFailureObservationFromTask(
  task: Pick<
    Task,
    | 'id'
    | 'repoPath'
    | 'worktree'
    | 'finalizerFailure'
    | 'lastError'
    | 'lastErrorObservedAt'
  >,
  observedAt = Date.now(),
): FailureObservation | undefined {
  const failure = task.finalizerFailure;
  if (!failure) {
    return undefined;
  }

  const nestedFailures = failure.nestedFailures ?? parseTurboNestedFailures({
    output: failure.rawMessage,
    taskWorktree: task.worktree,
    repoPath: task.repoPath,
    parentCommand: failure.command,
  });
  const primaryNestedFailure = nestedFailures[0];
  const normalizedFailure = primaryNestedFailure
    ? {
        ...failure,
        packageLabel: primaryNestedFailure.packageLabel,
        cwd: primaryNestedFailure.cwd,
        command: primaryNestedFailure.command,
        gate: primaryNestedFailure.gate,
        parentCommand: failure.parentCommand ?? failure.command,
        parentCwd: failure.parentCwd ?? failure.cwd,
        nestedFailures,
      }
    : failure;
  const signature = buildBaselineFailureSignature(normalizedFailure, task);
  const timestamp = task.lastErrorObservedAt ?? observedAt;

  return {
    id: `failure:${timestamp}:${signature.slice(0, 120)}`,
    observedAt: timestamp,
    kind: failure.failureKind === 'merge_conflict'
      ? 'merge_conflict'
      : failure.failureKind === 'quality_gate'
        ? 'quality_gate'
        : 'finalizer_error',
    class: normalizedFailure.class,
    gate: normalizedFailure.gate,
    requestedGate: normalizedFailure.requestedGate,
    packageLabel: normalizedFailure.packageLabel,
    cwd: normalizedFailure.cwd,
    command: normalizedFailure.command,
    parentCommand: normalizedFailure.parentCommand,
    parentCwd: normalizedFailure.parentCwd,
    signature,
    rawMessage: normalizedFailure.rawMessage || task.lastError || '',
    nestedFailures: normalizedFailure.nestedFailures,
    failedFiles: normalizedFailure.failedFiles,
    failedTests: normalizedFailure.failedTests,
    failedSymbols: normalizedFailure.failedSymbols,
    diagnosticSignature: normalizedFailure.diagnosticSignature,
  };
}

export function appendFailureObservation(
  history: FailureObservation[] | undefined,
  observation: FailureObservation | undefined,
): FailureObservation[] | undefined {
  if (!observation) {
    return history;
  }

  const existing = history ?? [];
  if (existing[existing.length - 1]?.signature === observation.signature) {
    return existing;
  }

  return [...existing, observation].slice(-MAX_FAILURE_HISTORY);
}
