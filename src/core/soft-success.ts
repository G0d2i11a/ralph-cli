import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { filterGitInternalPaths } from './git-internal-paths';
import { getLatestCommitSHA } from './worktree-progress';

const COMPLETION_SIGNAL_SCAN_CHARS = 250_000;
const REPAIR_EVIDENCE_ERROR_PATTERN = /no objective diff or commit evidence/i;
const WORKTREE_GIT_MAX_BUFFER = 20 * 1024 * 1024;

export interface ProgressLike {
  hasProgress: boolean;
  filesChanged: number;
  newCommits: number;
  headChanged?: boolean;
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
  recoverableStoryId?: string;
}

export function hasStrongCompletionSignals(signals: CompletionSignals): boolean {
  return Boolean(
    (signals.hasCompletionSummary && (signals.hasValidationSignal || signals.hasSuggestedCommitMessage))
    || signals.matchedSignals.length >= 3
  );
}

export function detectCompletionSignals(rawText: string): CompletionSignals {
  const text = rawText.slice(-COMPLETION_SIGNAL_SCAN_CHARS);
  const matchedSignals: string[] = [];

  const hasCompletionSummary = [
    /\*\*Done\*\*/i,
    /\*\*Result\*\*/i,
    /implementation complete/i,
    /implemented and validated/i,
    /acceptance criteria (are )?(covered|met)/i,
    /all acceptance criteria (are )?(covered|met)/i,
    /task .* completed successfully/i,
    /successfully.*implemented/i,
    /user story.*completed/i,
    /task.*done/i,
    /all done/i,
    /✓.*success/i,
    /✅/,
    /the worktree now .* code and tests/i,
  ].some((pattern) => pattern.test(text));

  if (hasCompletionSummary) {
    matchedSignals.push('completion_summary');
  }

  const hasValidationSignal = [
    /\*\*Validation\*\*/i,
    /\*\*Verification\*\*/i,
    /tests passed/i,
    /all.*tests.*pass/i,
    /tests?.*pass/i,
    /passed targeted/i,
    /validation.*pass/i,
    /jest validation/i,
    /\b\d+ suites?, \d+ tests passed\b/i,
    /npm test.*pass/i,
    /node --test.*pass/i,
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

  if (hasStrongCompletionSignals(signals)) {
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

export function hasObjectiveProgressEvidence(progress: ProgressLike): boolean {
  return progress.filesChanged > 0 || progress.newCommits > 0 || Boolean(progress.headChanged);
}

export interface CurrentWorktreeEvidence extends ProgressLike {
  reason: string;
}

export function reuseTaskLevelEvidenceForStorySuccess(input: {
  output: string;
  worktreePath?: string;
  baseCommitSha?: string;
  storyId?: string;
}): CurrentWorktreeEvidence | null {
  const signals = detectCompletionSignals(input.output);
  if (!hasStrongCompletionSignals(signals)) {
    return null;
  }

  const currentEvidence = detectCurrentWorktreeEvidence({
    worktreePath: input.worktreePath,
    baseCommitSha: input.baseCommitSha,
  });

  if (!currentEvidence.hasProgress) {
    return null;
  }

  const storyLabel = input.storyId ? ` for ${input.storyId}` : '';
  return {
    hasProgress: true,
    filesChanged: currentEvidence.filesChanged,
    newCommits: currentEvidence.newCommits,
    headChanged: currentEvidence.headChanged,
    reason: `Retained task-level worktree evidence${storyLabel}; ${currentEvidence.reason}; completion signals: ${signals.matchedSignals.join(', ')}`,
  };
}

function runGitInWorktree(worktreePath: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: worktreePath,
      encoding: 'utf-8',
      maxBuffer: WORKTREE_GIT_MAX_BUFFER,
    });
  } catch {
    return '';
  }
}

function listRelevantWorktreeChanges(worktreePath: string): string[] {
  const diffFiles = runGitInWorktree(worktreePath, ['diff', '--name-only', '-z', 'HEAD', '--']);
  const untrackedFiles = runGitInWorktree(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z']);

  return filterGitInternalPaths([
    ...diffFiles.split('\0').filter(Boolean),
    ...untrackedFiles.split('\0').filter(Boolean),
  ]);
}

function listRelevantBaseDiffFiles(worktreePath: string, baseCommitSha: string): string[] {
  const diffFiles = runGitInWorktree(worktreePath, ['diff', '--name-only', '-z', baseCommitSha, '--']);
  return filterGitInternalPaths(diffFiles.split('\0').filter(Boolean));
}

export function detectCurrentWorktreeEvidence(input: {
  worktreePath?: string;
  baseCommitSha?: string;
}): CurrentWorktreeEvidence {
  if (!input.worktreePath) {
    return {
      hasProgress: false,
      filesChanged: 0,
      newCommits: 0,
      reason: 'No worktree path available',
    };
  }

  const statusFiles = listRelevantWorktreeChanges(input.worktreePath).length;

  if (!input.baseCommitSha) {
    return {
      hasProgress: statusFiles > 0,
      filesChanged: statusFiles,
      newCommits: 0,
      reason: statusFiles > 0
        ? `${statusFiles} current changed file(s) in worktree`
        : 'No current worktree changes detected',
    };
  }

  const baseDiffFiles = listRelevantBaseDiffFiles(input.worktreePath, input.baseCommitSha).length;

  const commitsAheadRaw = runGitInWorktree(input.worktreePath, ['rev-list', '--count', `${input.baseCommitSha}..HEAD`]).trim();
  const parsedCommitsAhead = Number(commitsAheadRaw);
  const commitsAhead = Number.isFinite(parsedCommitsAhead) ? parsedCommitsAhead : 0;
  const filesChanged = Math.max(statusFiles, baseDiffFiles);
  const currentHeadSha = getLatestCommitSHA(input.worktreePath);
  const headChanged = Boolean(currentHeadSha && currentHeadSha !== input.baseCommitSha);
  const hasRelevantCommittedChanges = baseDiffFiles > 0;
  const hasProgress = filesChanged > 0 || (commitsAhead > 0 && hasRelevantCommittedChanges) || (headChanged && hasRelevantCommittedChanges);

  return {
    hasProgress,
    filesChanged,
    newCommits: commitsAhead,
    headChanged,
    reason: hasProgress
      ? headChanged && filesChanged === 0 && commitsAhead === 0
        ? 'HEAD changed relative to base'
        : `${filesChanged} current changed file(s), ${commitsAhead} commit(s) ahead of base`
      : 'No current worktree changes or commits ahead of base',
  };
}

export function findRecoverableFailedStoryId(
  storyProgress?: Array<{ id: string; status?: string; lastEvidence?: string; lastError?: string }>,
  fallbackError?: string,
): string | undefined {
  const recoverableStories = storyProgress
    ?.slice()
    .reverse()
    .filter((story) =>
      story.status === 'failed'
      && REPAIR_EVIDENCE_ERROR_PATTERN.test(story.lastError || fallbackError || '')
    );

  if (!recoverableStories?.length) {
    return undefined;
  }

  return recoverableStories.find((story) => Boolean(story.lastEvidence))?.id
    ?? recoverableStories[0]?.id;
}

export function evaluateFailedTaskForFinalizeRecovery(input: {
  logPath: string;
  worktreePath?: string;
  baseCommitSha?: string;
  lastFilesChanged?: number;
  storyProgress?: Array<{ id: string; status?: string; lastEvidence?: string; lastError?: string }>;
  lastError?: string;
}): SoftSuccessDecision {
  const output = fs.existsSync(input.logPath)
    ? fs.readFileSync(input.logPath, 'utf-8')
    : '';
  const recoverableStoryId = findRecoverableFailedStoryId(input.storyProgress, input.lastError);
  const currentWorktreeEvidence = detectCurrentWorktreeEvidence({
    worktreePath: input.worktreePath,
    baseCommitSha: input.baseCommitSha,
  });

  if (recoverableStoryId && !currentWorktreeEvidence.hasProgress) {
    return {
      shouldTreatAsSuccess: false,
      reason: 'No current worktree evidence remains for the failed repair story',
      signals: detectCompletionSignals(output),
      recoverableStoryId,
    };
  }

  const progress = currentWorktreeEvidence.hasProgress
    ? currentWorktreeEvidence
    : {
        hasProgress: (input.lastFilesChanged ?? 0) > 0,
        filesChanged: input.lastFilesChanged ?? 0,
        newCommits: 0,
        reason: (input.lastFilesChanged ?? 0) > 0
          ? `${input.lastFilesChanged} previously recorded changed file(s)`
          : 'No meaningful progress detected',
      };

  const decision = shouldTreatNonZeroExitAsSuccess({
    output,
    progress,
  });

  return {
    ...decision,
    recoverableStoryId: decision.shouldTreatAsSuccess ? recoverableStoryId : undefined,
  };
}
