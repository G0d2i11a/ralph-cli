export interface ProgressLike {
  hasProgress: boolean;
  filesChanged: number;
  newCommits: number;
}

export interface CompletionSignals {
  hasCompletionSummary: boolean;
  hasValidationSignal: boolean;
  hasSuggestedCommitMessage: boolean;
  matchedSignals: string[];
}

export interface SoftSuccessDecision {
  shouldTreatAsSuccess: boolean;
  reason: string;
  signals: CompletionSignals;
}

export function detectCompletionSignals(rawText: string): CompletionSignals {
  const text = rawText.slice(-50000);
  const matchedSignals: string[] = [];

  const hasCompletionSummary = [
    /\*\*Done\*\*/i,
    /implementation complete/i,
    /task .* completed successfully/i,
    /all done/i,
  ].some((pattern) => pattern.test(text));

  if (hasCompletionSummary) {
    matchedSignals.push('completion_summary');
  }

  const hasValidationSignal = [
    /\*\*Validation\*\*/i,
    /tests passed/i,
    /passed targeted/i,
    /validation.*pass/i,
    /jest validation/i,
    /\b\d+ suites?, \d+ tests passed\b/i,
  ].some((pattern) => pattern.test(text));

  if (hasValidationSignal) {
    matchedSignals.push('validation');
  }

  const hasSuggestedCommitMessage = /Suggested commit message:/i.test(text);
  if (hasSuggestedCommitMessage) {
    matchedSignals.push('suggested_commit_message');
  }

  return {
    hasCompletionSummary,
    hasValidationSignal,
    hasSuggestedCommitMessage,
    matchedSignals,
  };
}

export function shouldTreatNonZeroExitAsSuccess(input: {
  output: string;
  progress: ProgressLike;
}): SoftSuccessDecision {
  const signals = detectCompletionSignals(input.output);

  if (!input.progress.hasProgress) {
    return {
      shouldTreatAsSuccess: false,
      reason: 'No meaningful progress detected',
      signals,
    };
  }

  const signalCount = signals.matchedSignals.length;
  const hasStrongEvidence = signals.hasCompletionSummary
    && (signals.hasValidationSignal || signals.hasSuggestedCommitMessage);

  if (hasStrongEvidence || signalCount >= 3) {
    return {
      shouldTreatAsSuccess: true,
      reason: `Non-zero exit accepted due to progress + signals: ${signals.matchedSignals.join(', ')}`,
      signals,
    };
  }

  return {
    shouldTreatAsSuccess: false,
    reason: `Insufficient completion signals: ${signals.matchedSignals.join(', ') || 'none'}`,
    signals,
  };
}
