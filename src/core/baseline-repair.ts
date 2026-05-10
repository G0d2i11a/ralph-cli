import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../config/manager';
import { BaselineQualityGateRootCause, FinalizerFailureDetails, Task } from '../types/task';
import { enqueueTaskFromPrd } from './task-intake';
import { TaskScheduler } from './scheduler';
import { StateManager } from './state';
import { appendTaskEvent } from './events';
import { deriveBaselineRepairGroupKey } from './baseline-quality-gate';

export interface EnsureBaselineRepairTaskInput {
  repoPath: string;
  targetBranch: string;
  failure: FinalizerFailureDetails;
  signature: string;
  repairKey?: string;
  repairGroupKey?: string;
  rootCause?: BaselineQualityGateRootCause;
  demandTaskIds: string[];
  stateManager: StateManager;
  scheduler: TaskScheduler;
  configManager: Pick<ConfigManager, 'get'>;
}

export interface EnsureBaselineRepairTaskResult {
  taskId: string;
  alreadyExists: boolean;
  prdId: string;
  repairKey: string;
}

function signatureHash(signature: string): string {
  return createHash('sha256').update(signature).digest('hex').slice(0, 16);
}

function escapeJsonString(value: string): string {
  return JSON.stringify(value);
}

function getStateManagerRalphHome(stateManager: StateManager): string {
  if (typeof stateManager.getRalphHome === 'function') {
    return stateManager.getRalphHome();
  }

  throw new Error('baseline repair task creation requires a StateManager with getRalphHome()');
}

export function isDedicatedBaselineRepairTask(task: Pick<Task, 'prdId' | 'prdPath' | 'baselineRepair' | 'baselineRepairRole'>): boolean {
  return Boolean(
    task.baselineRepairRole === 'dedicated_repair_task'
    || task.baselineRepair?.dedicatedRepairTask === true
    || task.prdId?.startsWith('baseline-quality-gate:')
    || task.prdPath?.split(path.sep).includes('baseline-repairs')
  );
}

async function findExistingRepairTask(input: {
  stateManager: StateManager;
  repoPath: string;
  prdId: string;
  repairGroupKey?: string;
}): Promise<Task | undefined> {
  const repoPath = path.resolve(input.repoPath);
  const tasks = await input.stateManager.listTasks();

  if (input.repairGroupKey) {
    const groupMatch = tasks.find((task) => (
      path.resolve(task.repoPath) === repoPath
      && isDedicatedBaselineRepairTask(task)
      && task.baselineRepair?.repairGroupKey === input.repairGroupKey
      && task.baselineRepair?.status !== 'superseded'
      && !task.baselineRepair?.supersededByRepairTaskId
    ));
    if (groupMatch) {
      return groupMatch;
    }
  }

  return tasks.find((task) => (
    task.prdId === input.prdId
    && path.resolve(task.repoPath) === repoPath
    && isDedicatedBaselineRepairTask(task)
    && task.baselineRepair?.status !== 'superseded'
    && !task.baselineRepair?.supersededByRepairTaskId
  ));
}

function buildRepairPrd(input: {
  prdId: string;
  title: string;
  targetBranch: string;
  failure: FinalizerFailureDetails;
  signature: string;
  repairKey: string;
  repairGroupKey: string;
  rootCause?: BaselineQualityGateRootCause;
  demandTaskIds: string[];
}) {
  const failedFiles = input.failure.failedFiles?.length
    ? input.failure.failedFiles
    : undefined;
  const writeSurface = failedFiles ?? [
    input.failure.packageLabel,
  ].filter(Boolean);

  return {
    id: input.prdId,
    title: input.title,
    description: [
      'Repair the shared target-branch baseline quality gate failure.',
      `Target branch: ${input.targetBranch}`,
      `Gate: ${input.failure.gate}`,
      `Package: ${input.failure.packageLabel}`,
      `Command: ${input.failure.command}`,
      `Root cause: ${input.rootCause ?? 'shared_baseline_code_debt'}`,
      `Demand tasks: ${input.demandTaskIds.join(', ')}`,
      `Signature: ${input.signature}`,
      `Repair key: ${input.repairKey}`,
      `Repair group: ${input.repairGroupKey}`,
      `Baseline failure: ${input.failure.rawMessage}`,
      'Ralph will execute this PRD inside a dedicated baseline repair worktree.',
      'Only modify the current Ralph repair worktree. Do not modify the source repository checkout, other task worktrees, or sibling projects.',
      'If another checkout already contains a passing fix, copy only the minimal relevant repair into this current worktree and prove it here.',
      'Do not force-reset, clean, use destructive merge strategy, or push.',
    ].join('\n'),
    dependencies: [],
    writeSurface,
    conflictDomains: [
      'baseline-quality-gate',
      input.failure.packageLabel,
    ].filter(Boolean),
    integrationLane: `baseline-quality-gate-${signatureHash(input.signature)}`,
    userStories: [
      {
        id: 'US-001',
        title: 'Repair shared baseline quality gate',
        description: [
          `Make ${input.failure.packageLabel} pass ${input.failure.gate} on ${input.targetBranch}.`,
          `Run command: ${input.failure.command}`,
          input.failure.validationCommands?.length
            ? `Do not run the full finalizer sequence inside this worker; Ralph restricted finalizer will run it after the exact failed gate passes. Finalizer sequence for context: ${input.failure.validationCommands.join(' && ')}`
            : undefined,
          input.failure.preparationCommands?.length
            ? `Preparation commands observed before the failed gate: ${input.failure.preparationCommands.join(' && ')}`
            : undefined,
          `Use this baseline evidence as the repair source: ${input.failure.rawMessage}`,
          'Work only in the current Ralph baseline repair worktree. Do not use the dirty source checkout as proof.',
          'If the source checkout appears to already pass, reproduce the minimal fix in this repair worktree before reporting success.',
          'Ralph will reject success without objective diff or commit evidence in this repair worktree.',
        ].filter(Boolean).join('\n'),
        acceptanceCriteria: [
          `The command ${escapeJsonString(input.failure.command)} passes from the baseline package cwd inside the current Ralph repair worktree.`,
          ...(input.failure.validationCommands?.length
            ? ['Do not spend worker time running the full finalizer sequence; leave the repair ready for Ralph restricted finalizer to validate and integrate.']
            : []),
          'Capture bounded proof output for the exact failed gate; excessive logs must not become the repair signal.',
          'All repair changes are materialized in the current Ralph repair worktree, not only in the source checkout.',
          'The fix is safe to integrate through Ralph normal finalizer and integration flow.',
          'No force reset, clean, destructive merge strategy, or push is used.',
        ],
      },
    ],
  };
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

async function attachDemandToRepairTask(input: {
  task: Task;
  stateManager: StateManager;
  repairKey: string;
  repairGroupKey: string;
  rootCause?: BaselineQualityGateRootCause;
  targetBranch: string;
  failure: FinalizerFailureDetails;
  prdId: string;
  demandTaskIds: string[];
}): Promise<void> {
  const now = Date.now();
  const existingDemand = input.task.baselineRepair?.demandTaskIds ?? [];
  const nextDemand = unique([...existingDemand, ...input.demandTaskIds]);
  const currentRepairKey = input.task.baselineRepair?.repairKey ?? input.repairKey;
  const repairKeyAliases = unique([
    currentRepairKey,
    ...(input.task.baselineRepair?.repairKeyAliases ?? []),
    input.repairKey,
  ]);

  if (
    input.task.baselineRepair?.repairKey === currentRepairKey
    && input.task.baselineRepair?.repairGroupKey === input.repairGroupKey
    && existingDemand.join('\n') === nextDemand.join('\n')
    && (input.task.baselineRepair?.repairKeyAliases ?? []).join('\n') === repairKeyAliases.join('\n')
  ) {
    return;
  }

  await input.stateManager.updateTask(input.task.id, {
    baselineRepair: {
      ...input.task.baselineRepair,
      repairKey: currentRepairKey,
      repairGroupKey: input.repairGroupKey,
      repairKeyAliases,
      rootCause: input.rootCause,
      targetBranch: input.targetBranch,
      gate: input.failure.gate,
      packageLabel: input.failure.packageLabel,
      demandTaskIds: nextDemand,
      repairTaskId: input.task.id,
      repairPrdId: input.prdId,
      dedicatedRepairTask: true,
      startedAt: input.task.baselineRepair?.startedAt ?? now,
      updatedAt: now,
      status: input.task.status === 'completed' ? 'integrated' : 'waiting',
      message: `Repair demanded by ${nextDemand.length} task(s)`,
    },
    baselineRepairRole: 'dedicated_repair_task',
  });

  appendTaskEvent(input.task, {
    type: 'baseline_repair_demand_attached',
    status: input.task.status,
    message: `Attached baseline repair demand from ${input.demandTaskIds.join(', ')}`,
    data: {
      repairKey: input.repairKey,
      repairGroupKey: input.repairGroupKey,
      rootCause: input.rootCause,
      demandTaskIds: nextDemand,
    },
  });
}

export async function ensureBaselineRepairTask(
  input: EnsureBaselineRepairTaskInput,
): Promise<EnsureBaselineRepairTaskResult> {
  const repairKey = input.repairKey ?? input.signature;
  const repairGroupKey = input.repairGroupKey ?? deriveBaselineRepairGroupKey({
    targetBranch: input.targetBranch,
    packageLabel: input.failure.packageLabel,
  });
  const hash = signatureHash(repairKey);
  const prdId = `baseline-quality-gate:${hash}`;
  const existingTask = await findExistingRepairTask({
    stateManager: input.stateManager,
    repoPath: input.repoPath,
    prdId,
    repairGroupKey,
  });

  if (existingTask) {
    const existingPrdId = existingTask.prdId ?? prdId;
    await attachDemandToRepairTask({
      task: existingTask,
      stateManager: input.stateManager,
      repairKey,
      repairGroupKey,
      rootCause: input.rootCause,
      targetBranch: input.targetBranch,
      failure: input.failure,
      prdId: existingPrdId,
      demandTaskIds: input.demandTaskIds,
    });
    return {
      taskId: existingTask.id,
      alreadyExists: true,
      prdId: existingPrdId,
      repairKey,
    };
  }

  const ralphHome = getStateManagerRalphHome(input.stateManager);
  const repairDir = path.join(ralphHome, 'baseline-repairs');
  const prdPath = path.join(repairDir, `baseline-quality-gate-${hash}.json`);
  const prd = buildRepairPrd({
    prdId,
    title: `Repair shared baseline quality gate ${input.failure.gate} for ${input.failure.packageLabel}`,
    targetBranch: input.targetBranch,
    failure: input.failure,
    signature: input.signature,
    repairKey,
    repairGroupKey,
    rootCause: input.rootCause,
    demandTaskIds: input.demandTaskIds,
  });

  fs.mkdirSync(repairDir, { recursive: true });
  fs.writeFileSync(prdPath, `${JSON.stringify(prd, null, 2)}\n`);

  const result = await enqueueTaskFromPrd(prdPath, {
    repoPath: input.repoPath,
    ralphHome,
    stateManager: input.stateManager,
    scheduler: input.scheduler,
    configManager: input.configManager,
  });

  const createdTask = await input.stateManager.loadTask(result.taskId);
  if (createdTask) {
    await attachDemandToRepairTask({
      task: createdTask,
      stateManager: input.stateManager,
      repairKey,
      repairGroupKey,
      rootCause: input.rootCause,
      targetBranch: input.targetBranch,
      failure: input.failure,
      prdId,
      demandTaskIds: input.demandTaskIds,
    });
  }

  return {
    taskId: result.taskId,
    alreadyExists: result.alreadyExists,
    prdId,
    repairKey,
  };
}
