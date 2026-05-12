import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../config/manager';
import { PRD, UserStory } from '../types/prd';
import { FailureObservation, Task } from '../types/task';
import { TaskScheduler } from './scheduler';
import { StateManager } from './state';
import { enqueueTaskFromPrd } from './task-intake';
import { appendTaskEvent } from './events';
import { DEPENDENCY_REPAIR_PRIORITY_CLASS } from './dependency-identity';

const DEFAULT_REPAIR_STARVATION_BLOCKED_MS = 600000;
const DEPENDENCY_REPAIR_HARD_CAP_REASONS = new Set([
  'story_repair_hard_cap_reached',
  'failed_blocker_hard_cap_reached',
  'failed_blocker_recovery_hard_cap_reached',
]);

export interface GeneratedPrd {
  prd: PRD;
  signature: string;
}

export interface BuildFollowupPrdInput {
  task: Task;
  reason: string;
  failure?: FailureObservation;
  recommendedStories: string[];
  scope?: string[];
}

export interface EnqueueFollowupPrdInput {
  task: Task;
  stateManager: StateManager;
  scheduler: TaskScheduler;
  configManager: Pick<ConfigManager, 'get'> & Partial<Pick<ConfigManager, 'has'>>;
  reason: string;
  failure?: FailureObservation;
  recommendedStories?: string[];
  scope?: string[];
  now?: () => number;
}

export interface EnqueueFollowupPrdResult {
  prdId: string;
  taskId: string;
  prdPath: string;
}

function signatureHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function safeIdPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'task';
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function formatInlineList(values?: string[]): string | undefined {
  const normalized = uniqueStrings(values ?? []);
  return normalized.length ? normalized.join(', ') : undefined;
}

function isDependencyRepairFollowup(input: BuildFollowupPrdInput): boolean {
  if (input.task.status !== 'failed') {
    return false;
  }

  return DEPENDENCY_REPAIR_HARD_CAP_REASONS.has(input.reason);
}

function buildWriteSurface(input: BuildFollowupPrdInput): string[] {
  const narrowedScope = uniqueStrings([
    ...(input.scope ?? []),
    ...(input.failure?.failedFiles ?? []),
  ]);

  if (isDependencyRepairFollowup(input) && narrowedScope.length > 0) {
    return narrowedScope;
  }

  return uniqueStrings([
    ...narrowedScope,
    ...(input.task.declaredWriteSurface ?? []),
    input.failure?.packageLabel,
  ]);
}

function getTaskOraclePacket(task: Task): unknown {
  const taskWithOracle = task as Task & {
    oraclePacket?: unknown;
    oracleGuidancePacket?: unknown;
    oracleGuidance?: unknown;
    oracle?: unknown;
  };

  return taskWithOracle.oraclePacket
    ?? taskWithOracle.oracleGuidancePacket
    ?? taskWithOracle.oracleGuidance
    ?? taskWithOracle.oracle;
}

function buildOracleGuidanceSummary(task: Task): string[] {
  if (getTaskOraclePacket(task) === undefined) {
    return [];
  }

  return [
    'Oracle guidance: an Oracle packet is attached; treat it as candidate_only guidance, verify it against current failure evidence, and do not expand scope solely because Oracle suggested it.',
  ];
}

function buildFailureSummary(failure: FailureObservation | undefined, fallbackSignature: string): string[] {
  if (!failure) {
    return [
      `Failure signature: ${fallbackSignature}`,
    ];
  }

  return [
    `Failure kind: ${failure.kind}`,
    failure.class ? `Failure class: ${failure.class}` : undefined,
    failure.gate ? `Gate: ${failure.gate}` : undefined,
    failure.packageLabel ? `Package: ${failure.packageLabel}` : undefined,
    failure.command ? `Command: ${failure.command}` : undefined,
    `Failure signature: ${failure.signature}`,
    failure.rawMessage ? `Raw message: ${failure.rawMessage.slice(0, 2000)}` : undefined,
  ].filter((line): line is string => Boolean(line));
}

function storyFromRecommendation(text: string, index: number, dependencyRepair: boolean): UserStory {
  const trimmed = text.trim();
  const title = trimmed.length > 90 ? `${trimmed.slice(0, 87)}...` : trimmed;

  return {
    id: `US-${String(index + 1).padStart(3, '0')}`,
    title,
    description: trimmed,
    acceptanceCriteria: [
      'The referenced failure is reproduced or explicitly ruled stale.',
      'The fix is implemented within the declared write surface.',
      'Relevant quality gates pass and evidence is recorded in task logs.',
      ...(dependencyRepair
        ? [
            'If a full quality gate fails on unrelated target-branch baseline debt, Ralph creates a separate baseline repair PRD instead of expanding this dependency repair surface.',
          ]
        : []),
    ],
  };
}

function defaultStories(input: BuildFollowupPrdInput): string[] {
  return [
    `Classify the stopped recovery for ${input.task.id} and confirm the current failure signature.`,
    'Implement the smallest safe repair or split needed to unblock the original task.',
    'Run the relevant verification command and document the result in the task output.',
  ];
}

export function buildFollowupPrdForTask(input: BuildFollowupPrdInput): GeneratedPrd {
  const signatureSource = [
    input.task.id,
    input.task.prdId,
    input.reason,
    input.failure?.signature,
    input.task.lastErrorSignature,
    input.task.lastError,
  ].filter(Boolean).join('|');
  const signature = input.failure?.signature ?? input.task.lastErrorSignature ?? signatureSource;
  const hash = signatureHash(signatureSource || signature);
  const sourcePrd = input.task.prdId ?? path.basename(input.task.prdPath, path.extname(input.task.prdPath));
  const scope = buildWriteSurface(input);
  const recommendations = input.recommendedStories.length
    ? input.recommendedStories
    : defaultStories(input);
  const dependencyRepair = isDependencyRepairFollowup(input);
  const demandTaskIds = uniqueStrings([
    ...(input.task.failedBlockerRecoveryDemandTaskIds ?? []),
    ...(input.task.storyRepairRecoveryDemandTaskIds ?? []),
  ]);
  const dependencyRepairDescription = dependencyRepair
    ? [
        'Release semantics: this is a schedulable dependency repair mission that releases downstream work for the original PRD when completed.',
        formatInlineList(demandTaskIds) ? `Demand task ids: ${formatInlineList(demandTaskIds)}` : undefined,
        formatInlineList(scope) ? `Repair write surface: ${formatInlineList(scope)}` : undefined,
        'Baseline debt policy: if a full quality gate fails on unrelated target-branch baseline debt, create a separate baseline repair PRD instead of expanding this dependency repair surface.',
      ].filter((line): line is string => Boolean(line))
    : [];
  const prd: PRD = {
    id: `followup:${safeIdPart(sourcePrd)}:${hash}`,
    title: `Follow up ${input.task.prdTitle ?? sourcePrd}: ${input.reason}`,
    description: [
      'Generated by Ralph after an autonomous recovery path exhausted or required safe decomposition.',
      `Original task id: ${input.task.id}`,
      `Original PRD id: ${sourcePrd}`,
      `Reason: ${input.reason}`,
      `Original status: ${input.task.status}`,
      ...buildFailureSummary(input.failure, signature),
      ...dependencyRepairDescription,
      ...buildOracleGuidanceSummary(input.task),
    ].join('\n'),
    userStories: recommendations.map((recommendation, index) => storyFromRecommendation(
      recommendation,
      index,
      dependencyRepair,
    )),
    writeSurface: scope.length ? scope : undefined,
    conflictDomains: input.task.declaredConflictDomains,
    integrationLane: input.task.integrationLane,
  };

  if (dependencyRepair) {
    const releasesDependenciesFor = [sourcePrd];
    prd.priorityClass = DEPENDENCY_REPAIR_PRIORITY_CLASS;
    prd.repairOf = {
      prdId: sourcePrd,
      taskId: input.task.id,
      reason: input.reason,
    };
    prd.releasesDependenciesFor = releasesDependenciesFor;
    prd.schedulerHints = {
      priorityClass: DEPENDENCY_REPAIR_PRIORITY_CLASS,
      effectiveDependencyPrdId: sourcePrd,
      releasesDependenciesFor,
      repairTaskId: input.task.id,
      repairReason: input.reason,
      demandTaskIds,
      bypassPendingDownstreamOverlaps: true,
      doNotBypassRunningOverlaps: true,
      parkNonRepairPendingOverlaps: true,
      emitRepairStarvationIfBlockedForMs: DEFAULT_REPAIR_STARVATION_BLOCKED_MS,
    };
  }

  return { prd, signature };
}

function getStateManagerRalphHome(stateManager: StateManager): string {
  if (typeof stateManager.getRalphHome === 'function') {
    return stateManager.getRalphHome();
  }

  throw new Error('follow-up PRD generation requires a StateManager with getRalphHome()');
}

export async function enqueueFollowupPrd(input: EnqueueFollowupPrdInput): Promise<EnqueueFollowupPrdResult> {
  const now = input.now?.() ?? Date.now();
  const generated = buildFollowupPrdForTask({
    task: input.task,
    reason: input.reason,
    failure: input.failure,
    recommendedStories: input.recommendedStories ?? [],
    scope: input.scope,
  });
  const sameSignature = input.task.followupGenerationLastSignature === generated.signature;
  const generationTotal = sameSignature ? input.task.followupGenerationTotal ?? 0 : 0;
  const hardCap = input.task.followupGenerationHardCap ?? 1;

  if (generationTotal >= hardCap) {
    throw new Error(`Follow-up PRD generation hard cap reached for task ${input.task.id}`);
  }

  const ralphHome = getStateManagerRalphHome(input.stateManager);
  const generatedDir = path.join(ralphHome, 'generated-prds', input.task.id);
  const prdPath = path.join(generatedDir, `${now}-followup.json`);
  fs.mkdirSync(generatedDir, { recursive: true });
  fs.writeFileSync(prdPath, `${JSON.stringify(generated.prd, null, 2)}\n`);

  const result = await enqueueTaskFromPrd(prdPath, {
    repoPath: input.task.repoPath,
    ralphHome,
    stateManager: input.stateManager,
    scheduler: input.scheduler,
    configManager: input.configManager,
  });
  const nextFollowupPrdIds = uniqueStrings([...(input.task.followupPrdIds ?? []), generated.prd.id]);
  const nextFollowupTaskIds = uniqueStrings([...(input.task.followupTaskIds ?? []), result.taskId]);

  await input.stateManager.updateTask(input.task.id, {
    followupPrdIds: nextFollowupPrdIds,
    followupTaskIds: nextFollowupTaskIds,
    followupGeneratedAt: now,
    followupReason: input.reason,
    followupGenerationLastSignature: generated.signature,
    followupGenerationTotal: generationTotal + 1,
    followupGenerationHardCap: hardCap,
  });
  appendTaskEvent(input.task, {
    type: 'followup_prd_generated',
    status: input.task.status,
    message: `Generated follow-up PRD ${generated.prd.id}`,
    data: {
      prdId: generated.prd.id,
      taskId: result.taskId,
      prdPath,
      reason: input.reason,
      signature: generated.signature,
    },
  });

  return {
    prdId: generated.prd.id,
    taskId: result.taskId,
    prdPath,
  };
}
