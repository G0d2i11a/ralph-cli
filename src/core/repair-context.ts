import { UserStory } from '../types/prd';
import {
  FinalizeFailureDiagnostic,
  FinalizerFailureDetails,
  TaskRepairContext,
  TaskRepairMode,
  TaskMergeConflictPhase,
} from '../types/task';

interface RepairContextTaskView {
  repairContext?: TaskRepairContext;
  finalizerFailure?: FinalizerFailureDetails;
  mergeConflictFiles?: string[];
  mergeConflictPhase?: TaskMergeConflictPhase;
  observedWriteSurface?: string[];
  observedPackageSurface?: string[];
  prdId?: string;
  prdTitle?: string;
}

type MergeRepairContextTaskView = Pick<
  RepairContextTaskView,
  'mergeConflictFiles'
  | 'mergeConflictPhase'
> & Pick<
  TaskRepairContextTaskState,
  'integrationBranch' | 'mergeTargetBranch' | 'intendedMergeTarget' | 'lastError' | 'mergeError'
>;

type TaskRepairContextTaskState = {
  integrationBranch?: string;
  mergeTargetBranch?: string;
  intendedMergeTarget?: string;
  mergeError?: string;
  lastError?: string;
};

export function buildTaskRepairContext(input: {
  storyId: string;
  mode: TaskRepairMode;
  reason: string;
  createdAt?: number;
}): TaskRepairContext {
  return {
    mode: input.mode,
    storyId: input.storyId,
    createdAt: input.createdAt ?? Date.now(),
    reason: input.reason,
  };
}

export function clearTaskRepairContext(): undefined {
  return undefined;
}

export function buildMergeRepairReason(task: MergeRepairContextTaskView): string {
  const conflictFiles = task.mergeConflictFiles?.length
    ? task.mergeConflictFiles.join(', ')
    : 'unknown conflict files';
  const integrationTarget = task.integrationBranch || task.mergeTargetBranch || task.intendedMergeTarget || 'main';
  if (task.mergeConflictPhase === 'integration_sync') {
    return [
      'Integration branch sync repair required by Ralph.',
      `Conflict files: ${conflictFiles}.`,
      `Integration target: ${integrationTarget}.`,
      'The integration branch cannot sync the merge target before this task is checked.',
      'Resolve the conflict between the integration branch and the merge target first; editing only the task branch may not change the probe result.',
      'Do not compare against origin/main unless it is the configured merge target.',
      task.mergeError || task.lastError ? `Original merge error: ${task.mergeError || task.lastError}` : undefined,
    ].filter(Boolean).join(' ');
  }

  const reason = [
    'Merge repair required by Ralph.',
    `Conflict files: ${conflictFiles}.`,
    `Integration target: ${integrationTarget}.`,
    'Resolve the semantic conflict by preserving the already-integrated target behavior and this task\'s intended behavior.',
    'Do not choose ours/theirs wholesale unless one side is provably obsolete.',
    'Ralph will only accept the repair when this actual task branch/worktree passes the exact mergeability probe against the integration target.',
    'Do not stop at a temp clone, a manual merge transcript, or a narrative that the merge could be resolved. Materialize the resolution in this task worktree/branch.',
    'Update the task branch so it can merge cleanly, and run the relevant tests before finishing.',
  ];

  if (task.mergeError || task.lastError) {
    reason.push(`Original merge error: ${task.mergeError || task.lastError}`);
  }

  return reason.join(' ');
}

export function buildStoryExecutionPayload(
  task: RepairContextTaskView,
  story: UserStory,
  lastStoryError?: string,
): UserStory {
  if (!task.repairContext || task.repairContext.storyId !== story.id) {
    if (!lastStoryError) {
      return story;
    }

    return {
      ...story,
      description: `${story.description}\n\nRepair context from Ralph: ${lastStoryError}`,
    };
  }

  if (task.repairContext.mode === 'merge') {
    return buildMergeRepairStory(task, story, lastStoryError);
  }

  return buildFinalizeRepairStory(task, story, lastStoryError);
}

function buildFinalizeRepairStory(
  task: RepairContextTaskView,
  story: UserStory,
  lastStoryError?: string,
): UserStory {
  const failure = task.finalizerFailure;
  const descriptionLines = [
    'Ralph is asking for a finalize repair, not a new feature pass.',
    'All PRD stories for this task have already passed. This user story is only the scheduling anchor for the repair.',
    'Repair only the failed integration/finalize condition. Do not expand product scope.',
    `Repair reason: ${formatRepairReason(task.repairContext?.reason || lastStoryError || 'Finalizer failed.')}`,
  ];

  if (task.prdTitle || task.prdId) {
    descriptionLines.push(`Task: ${[task.prdTitle, task.prdId].filter(Boolean).join(' / ')}`);
  }

  if (failure) {
    descriptionLines.push(...buildFinalizerFailureLines(failure));
  } else if (lastStoryError) {
    descriptionLines.push(`Latest failure summary: ${lastStoryError}`);
  }

  const packageSurface = formatInlineList(task.observedPackageSurface);
  if (packageSurface) {
    descriptionLines.push(`Observed package surface: ${packageSurface}`);
  }

  const writeSurface = formatInlineList(task.observedWriteSurface);
  if (writeSurface) {
    descriptionLines.push(`Observed write surface: ${writeSurface}`);
  }

  descriptionLines.push(
    '',
    `Original anchored user story (${story.id}: ${story.title})`,
    story.description,
  );

  return {
    ...story,
    title: `Finalize repair for ${story.id}: ${story.title}`,
    description: descriptionLines.join('\n'),
    acceptanceCriteria: [
      `Repair the failed finalizer${failure?.gate ? ` quality gate (${failure.gate})` : ''} without adding new product scope.`,
      'Preserve behavior already delivered by the completed PRD stories.',
      'Validate against the exact failed gate before finishing and report concrete evidence in the summary.',
      ...(failure?.validationCommands?.length
        ? ['Do not run the full finalizer sequence inside the repair worker; leave the worktree ready for Ralph restricted finalizer to validate and integrate.']
        : []),
      ...story.acceptanceCriteria.map((criterion) => `Preserve original requirement: ${criterion}`),
    ],
  };
}

function buildMergeRepairStory(
  task: RepairContextTaskView,
  story: UserStory,
  lastStoryError?: string,
): UserStory {
  const mergeFiles = formatInlineList(task.mergeConflictFiles);
  const isIntegrationSyncRepair = task.mergeConflictPhase === 'integration_sync'
    || /Integration branch sync failed/i.test(task.repairContext?.reason || lastStoryError || '');
  const descriptionLines = [
    'Ralph is asking for merge repair, not a new feature pass.',
    'All PRD stories for this task have already passed. This user story is only the scheduling anchor for the repair.',
    isIntegrationSyncRepair
      ? 'The current failure is in the integration-branch sync phase, before this task branch is merged. Inspect the configured integration branch and merge target instead of defaulting to origin/main.'
      : 'Resolve the integration conflict semantically. Preserve both the already-integrated target behavior and this task\'s intended behavior.',
    isIntegrationSyncRepair
      ? 'Ralph will only accept this repair after the integration branch can sync the configured merge target and then the task branch/worktree passes the exact mergeability probe.'
      : 'Ralph will only accept this repair when the actual task branch/worktree itself passes the exact mergeability probe against the integration target.',
    isIntegrationSyncRepair
      ? 'Materialize the repair in the branch/worktree that the exact probe uses. Do not stop at a temp clone, merge-tree transcript, or origin/main comparison.'
      : 'Do not stop at a temp clone, a manual merge transcript, a merge-tree grep, or a narrative about how the conflict could be resolved. Apply the resolution in this task worktree/branch.',
    'If you validate in a temp clone, treat that as advisory only. The real proof must still be the exact probe becoming clean without further manual edits.',
    `Repair reason: ${formatRepairReason(task.repairContext?.reason || lastStoryError || 'Merge repair required.')}`,
  ];

  if (mergeFiles) {
    descriptionLines.push(`Conflict files: ${mergeFiles}`);
  }

  const packageSurface = formatInlineList(task.observedPackageSurface);
  if (packageSurface) {
    descriptionLines.push(`Observed package surface: ${packageSurface}`);
  }

  const writeSurface = formatInlineList(task.observedWriteSurface);
  if (writeSurface) {
    descriptionLines.push(`Observed write surface: ${writeSurface}`);
  }

  descriptionLines.push(
    '',
    `Original anchored user story (${story.id}: ${story.title})`,
    story.description,
  );

  return {
    ...story,
    title: `Merge repair for ${story.id}: ${story.title}`,
    description: descriptionLines.join('\n'),
    acceptanceCriteria: [
      'Resolve the merge conflict without dropping either side\'s intended behavior.',
      'Keep all already-passed story behavior intact and do not expand scope.',
      isIntegrationSyncRepair
        ? 'Demonstrate that the integration branch can sync the configured merge target, then that the task branch/worktree can merge without content conflicts; tests alone are not sufficient.'
        : 'Demonstrate that the actual task branch/worktree can merge into the integration target without content conflicts; tests alone are not sufficient.',
      'A temp clone or manual merge rehearsal is not sufficient unless the same resolution is materialized where Ralph probes it.',
      'Leave the task branch ready for restricted finalization.',
      ...story.acceptanceCriteria.map((criterion) => `Preserve original requirement: ${criterion}`),
    ],
  };
}

function buildFinalizerFailureLines(failure: FinalizerFailureDetails): string[] {
  const lines = [
    `Failed gate: requested=${failure.requestedGate}, actual=${failure.gate}, package=${failure.packageLabel}`,
    `Failure class: ${failure.class}`,
  ];

  if (failure.command) {
    lines.push(`Gate command: ${failure.command}`);
  }

  const preparationCommands = formatInlineList(failure.preparationCommands);
  if (preparationCommands) {
    lines.push(`Finalizer preparation commands already run before this gate: ${preparationCommands}`);
  }

  const validationCommands = formatInlineList(failure.validationCommands);
  if (validationCommands) {
    lines.push(`Ralph restricted finalizer will validate this sequence after the repair worker finishes: ${validationCommands}`);
  }

  if (failure.diagnosticCount) {
    lines.push(`Diagnostic count: ${failure.diagnosticCount}`);
  }

  const failedSymbols = formatInlineList(failure.failedSymbols);
  if (failedSymbols) {
    lines.push(`Failed symbols: ${failedSymbols}`);
  }

  const failedFiles = formatInlineList(failure.failedFiles);
  if (failedFiles) {
    lines.push(`Failed files: ${failedFiles}`);
  }

  const failedCodes = formatInlineList(failure.failedCodes);
  if (failedCodes) {
    lines.push(`Failed codes: ${failedCodes}`);
  }

  const diagnostics = summarizeDiagnostics(failure.diagnostics);
  if (diagnostics.length > 0) {
    lines.push('Representative diagnostics:');
    lines.push(...diagnostics.map((diagnostic) => `- ${diagnostic}`));
  } else if (failure.rawMessage) {
    lines.push(`Failure summary: ${truncate(failure.rawMessage, 1200)}`);
  }

  return lines;
}

function summarizeDiagnostics(diagnostics?: FinalizeFailureDiagnostic[]): string[] {
  if (!diagnostics?.length) {
    return [];
  }

  const limit = 8;
  const summary = diagnostics.slice(0, limit).map((diagnostic) => {
    const location = diagnostic.file
      ? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}` : ''}${diagnostic.column ? `:${diagnostic.column}` : ''}`
      : diagnostic.code || diagnostic.severity;
    const code = diagnostic.code ? ` ${diagnostic.code}` : '';
    return `${location}${code} ${diagnostic.message}`.trim();
  });

  if (diagnostics.length > limit) {
    summary.push(`... ${diagnostics.length - limit} more diagnostic(s) omitted`);
  }

  return summary;
}

function formatInlineList(values?: string[], limit = 12): string | undefined {
  if (!values?.length) {
    return undefined;
  }

  const visible = values.slice(0, limit);
  const suffix = values.length > limit
    ? `, ... ${values.length - limit} more omitted`
    : '';
  return `${visible.join(', ')}${suffix}`;
}

function formatRepairReason(reason: string): string {
  return truncate(reason.replace(/\s+/g, ' ').trim(), 1600);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
