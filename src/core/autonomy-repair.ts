import { ConfigManager } from '../config/manager';
import { Task, TaskAutonomyRepairKind } from '../types/task';
import { buildBaselineFailureSignature } from './baseline-quality-gate';
import { appendTaskEvent } from './events';
import { isDedicatedBaselineRepairTask } from './baseline-repair';
import { resolveAutonomyRepairConfig } from './auto-recovery-policy';
import { resolveTaskIntegrationStatus } from './task-delivery';
import { StateManager } from './state';

export interface AutonomyRepairResult {
  repaired: number;
  stopped: number;
  skipped: number;
  repairedTaskIds: string[];
  stoppedTaskIds: string[];
}

interface AutonomyRepairBudget {
  allowed: boolean;
  stoppedUpdates?: Partial<Task>;
  stoppedMessage?: string;
  startedAt: number;
  deadlineAt: number;
  totalRequeues: number;
  signature: string;
}

interface AutonomyRepairDeps {
  stateManager: StateManager;
  configManager: Pick<ConfigManager, 'get'>;
  now?: () => number;
  logger?: Pick<typeof console, 'log' | 'error'>;
}

function isBaselineExhausted(task: Task): boolean {
  return Boolean(
    task.status === 'failed_finalize'
    && task.baselineQualityGate?.kind === 'baseline_quality_gate_failure'
    && (
      task.baselineQualityGate.stopReason === 'baseline_repair_exhausted'
      || task.autoRecoveryStopReason === 'baseline_repair_exhausted'
    )
  );
}

function isSupersededProductBaselineRole(task: Task): boolean {
  return Boolean(
    !isDedicatedBaselineRepairTask(task)
    && (
      task.lastErrorKind === 'baseline_repair_superseded'
      || task.baselineRepair?.status === 'superseded'
      || task.baselineRepair?.supersededByRepairTaskId
      || task.baselineQualityGate?.supersededByRepairTaskId
    )
  );
}

function allStoriesPassed(task: Task): boolean {
  if (!task.storyProgress?.length) {
    return task.completedUS.length > 0;
  }

  return task.storyProgress.every((story) => story.status === 'passed');
}

function autonomyRepairSignature(task: Task): string {
  return task.latestFailure?.signature
    ?? task.baselineQualityGate?.latestFailureSignature
    ?? task.baselineQualityGate?.taskFailureSignature
    ?? (task.finalizerFailure ? buildBaselineFailureSignature(task.finalizerFailure, task) : undefined)
    ?? task.lastErrorSignature
    ?? task.lastError
    ?? task.baselineQualityGate?.signature
    ?? task.id;
}

function prepareBudget(input: {
  task: Task;
  kind: TaskAutonomyRepairKind;
  signature: string;
  now: number;
  config: ReturnType<typeof resolveAutonomyRepairConfig>;
}): AutonomyRepairBudget {
  const repairKind = input.task.autonomyRepairKind;
  const lastSignature = input.task.autonomyRepairLastSignature;
  const repairStartedAt = input.task.autonomyRepairStartedAt;
  const repairDeadlineAt = input.task.autonomyRepairDeadlineAt;
  const repairTotalRequeues = input.task.autonomyRepairTotalRequeues;
  const repairNextEligibleAt = input.task.autonomyRepairNextEligibleAt;
  const sameKind = repairKind === input.kind;
  const sameSignature = lastSignature === input.signature;
  const startedAt = sameKind && sameSignature && repairStartedAt
    ? repairStartedAt
    : input.now;
  const deadlineAt = sameKind && sameSignature && repairDeadlineAt
    ? repairDeadlineAt
    : startedAt + input.config.autonomyRepairDeadlineSeconds * 1000;
  const totalRequeues = sameKind && sameSignature
    ? repairTotalRequeues ?? 0
    : 0;

  if (repairNextEligibleAt && repairNextEligibleAt > input.now) {
    return {
      allowed: false,
      startedAt,
      deadlineAt,
      totalRequeues,
      signature: input.signature,
    };
  }

  if (input.now > deadlineAt) {
    const stoppedMessage = `Autonomy repair deadline exhausted for ${input.kind}`;
    return {
      allowed: false,
      stoppedMessage,
      startedAt,
      deadlineAt,
      totalRequeues,
      signature: input.signature,
      stoppedUpdates: {
        autonomyRepairKind: input.kind,
        autonomyRepairStartedAt: startedAt,
        autonomyRepairDeadlineAt: deadlineAt,
        autonomyRepairLastSignature: input.signature,
        autonomyRepairStoppedAt: input.now,
        autonomyRepairStopReason: 'autonomy_repair_deadline_exhausted',
        autonomyRepairLastReason: stoppedMessage,
      },
    };
  }

  if (totalRequeues >= input.config.autonomyRepairHardCap) {
    const stoppedMessage = `Autonomy repair hard cap reached for ${input.kind}`;
    return {
      allowed: false,
      stoppedMessage,
      startedAt,
      deadlineAt,
      totalRequeues,
      signature: input.signature,
      stoppedUpdates: {
        autonomyRepairKind: input.kind,
        autonomyRepairStartedAt: startedAt,
        autonomyRepairDeadlineAt: deadlineAt,
        autonomyRepairLastSignature: input.signature,
        autonomyRepairStoppedAt: input.now,
        autonomyRepairStopReason: 'autonomy_repair_hard_cap_reached',
        autonomyRepairLastReason: stoppedMessage,
      },
    };
  }

  return {
    allowed: true,
    startedAt,
    deadlineAt,
    totalRequeues,
    signature: input.signature,
  };
}

function buildActiveAutonomyRepairUpdates(input: {
  task: Task;
  kind: TaskAutonomyRepairKind;
  budget: AutonomyRepairBudget;
  now: number;
  message: string;
}): Partial<Task> {
  return {
    autonomyRepairKind: input.kind,
    autonomyRepairStartedAt: input.budget.startedAt,
    autonomyRepairDeadlineAt: input.budget.deadlineAt,
    autonomyRepairTotalRequeues: input.budget.totalRequeues + 1,
    autonomyRepairLastSignature: input.budget.signature,
    autonomyRepairLastProgressReason: input.message,
    autonomyRepairLastRequeuedAt: input.now,
    autonomyRepairNextEligibleAt: undefined,
    autonomyRepairStoppedAt: undefined,
    autonomyRepairStopReason: undefined,
    autonomyRepairLastReason: input.message,
    autoRecoveryTotalRequeues: (input.task.autoRecoveryTotalRequeues ?? 0) + 1,
    autoRecoveryLastRequeuedAt: input.now,
  };
}

export class AutonomyRepairController {
  private readonly stateManager: StateManager;
  private readonly configManager: Pick<ConfigManager, 'get'>;
  private readonly now: () => number;
  private readonly logger: Pick<typeof console, 'log' | 'error'>;

  constructor(deps: AutonomyRepairDeps) {
    this.stateManager = deps.stateManager;
    this.configManager = deps.configManager;
    this.now = deps.now ?? (() => Date.now());
    this.logger = deps.logger ?? console;
  }

  async run(): Promise<AutonomyRepairResult> {
    const config = resolveAutonomyRepairConfig(this.configManager);
    const result: AutonomyRepairResult = {
      repaired: 0,
      stopped: 0,
      skipped: 0,
      repairedTaskIds: [],
      stoppedTaskIds: [],
    };

    if (!config.autoRecoverBlockedTasks) {
      return result;
    }

    const tasks = (await this.stateManager.listTasks())
      .slice()
      .sort((a, b) => a.startTime - b.startTime);

    for (const task of tasks) {
      if (isBaselineExhausted(task)) {
        const repaired = await this.repairBaselineExhaustion(task, config);
        if (repaired === 'repaired') {
          result.repaired += 1;
          result.repairedTaskIds.push(task.id);
        } else if (repaired === 'stopped') {
          result.stopped += 1;
          result.stoppedTaskIds.push(task.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }

      if (isSupersededProductBaselineRole(task)) {
        const repaired = await this.migrateSupersededProductBaselineRole(task, config);
        if (repaired === 'repaired') {
          result.repaired += 1;
          result.repairedTaskIds.push(task.id);
        } else if (repaired === 'stopped') {
          result.stopped += 1;
          result.stoppedTaskIds.push(task.id);
        } else {
          result.skipped += 1;
        }
      }
    }

    return result;
  }

  private async repairBaselineExhaustion(
    task: Task,
    config: ReturnType<typeof resolveAutonomyRepairConfig>,
  ): Promise<'repaired' | 'stopped' | 'skipped'> {
    const now = this.now();
    const signature = autonomyRepairSignature(task);
    const budget = prepareBudget({
      task,
      kind: 'baseline_exhaustion',
      signature,
      now,
      config,
    });

    if (!budget.allowed) {
      if (budget.stoppedUpdates) {
        await this.stateManager.updateTask(task.id, budget.stoppedUpdates);
        appendTaskEvent(task, {
          type: 'autonomy_repair_stopped',
          status: task.status,
          message: budget.stoppedMessage,
          data: {
            kind: 'baseline_exhaustion',
            signature,
            totalRequeues: budget.totalRequeues,
            deadlineAt: budget.deadlineAt,
          },
        });
        this.logger.log(`Task ${task.id} autonomy repair stopped: ${budget.stoppedMessage}`);
        return 'stopped';
      }
      return 'skipped';
    }

    const baseline = task.baselineQualityGate;
    const message = 'Baseline repair was exhausted; clearing stale baseline state so the manager can reclassify the current finalizer failure';
    await this.stateManager.updateTask(task.id, {
      status: 'failed_finalize',
      endTime: undefined,
      pid: undefined,
      leaseOwner: undefined,
      leaseHeartbeatAt: undefined,
      leaseExpiresAt: undefined,
      currentUS: undefined,
      lastErrorKind: 'quality_gate_failure',
      autoRecoveryKind: undefined,
      autoRecoveryStoppedAt: undefined,
      autoRecoveryStopReason: undefined,
      autoRecoveryLastReason: message,
      finalizeRepairStoppedAt: undefined,
      finalizeRepairStopReason: undefined,
      baselineQualityGate: undefined,
      baselineQualityGateHistory: baseline
        ? [
            ...(task.baselineQualityGateHistory ?? []),
            {
              ...baseline,
              phase: 'stopped',
              lastUpdatedAt: now,
              stoppedAt: baseline.stoppedAt ?? now,
              stopReason: baseline.stopReason ?? 'baseline_repair_exhausted',
            },
          ]
        : task.baselineQualityGateHistory,
      baselineRepair: task.baselineRepair
        ? {
            ...task.baselineRepair,
            updatedAt: now,
            status: 'needs_more_repair',
            lastPostRepairFailureSignature: signature,
            lastPostRepairClassification: 'probe_ambiguous',
            message,
          }
        : undefined,
      ...buildActiveAutonomyRepairUpdates({
        task,
        kind: 'baseline_exhaustion',
        budget,
        now,
        message,
      }),
    });
    appendTaskEvent(task, {
      type: 'baseline_exhaustion_reclassified',
      status: 'failed_finalize',
      message,
      data: {
        signature,
        previousRepairTaskId: baseline?.repairTaskId,
        totalRequeues: budget.totalRequeues + 1,
      },
    });
    this.logger.log(`Task ${task.id} baseline exhaustion returned to finalizer reclassification`);
    return 'repaired';
  }

  private async migrateSupersededProductBaselineRole(
    task: Task,
    config: ReturnType<typeof resolveAutonomyRepairConfig>,
  ): Promise<'repaired' | 'stopped' | 'skipped'> {
    const now = this.now();
    const canonicalRepairTaskId = task.baselineRepair?.supersededByRepairTaskId
      ?? task.baselineQualityGate?.supersededByRepairTaskId
      ?? task.baselineRepair?.repairTaskId
      ?? task.baselineQualityGate?.repairTaskId;
    const signature = [
      autonomyRepairSignature(task),
      canonicalRepairTaskId,
    ].filter(Boolean).join('|');
    const budget = prepareBudget({
      task,
      kind: 'baseline_supersession_migration',
      signature,
      now,
      config,
    });

    if (!budget.allowed) {
      if (budget.stoppedUpdates) {
        await this.stateManager.updateTask(task.id, budget.stoppedUpdates);
        appendTaskEvent(task, {
          type: 'autonomy_repair_stopped',
          status: task.status,
          message: budget.stoppedMessage,
          data: {
            kind: 'baseline_supersession_migration',
            signature,
            totalRequeues: budget.totalRequeues,
            deadlineAt: budget.deadlineAt,
          },
        });
        this.logger.log(`Task ${task.id} autonomy repair stopped: ${budget.stoppedMessage}`);
        return 'stopped';
      }
      return 'skipped';
    }

    const repairTask = canonicalRepairTaskId
      ? await this.stateManager.loadTask(canonicalRepairTaskId)
      : null;
    const repairIntegrated = Boolean(
      repairTask
      && repairTask.status === 'completed'
      && resolveTaskIntegrationStatus(repairTask) === 'integrated'
    );
    const nextStatus: Task['status'] = repairIntegrated && allStoriesPassed(task)
      ? 'ready_to_finalize'
      : 'failed_finalize';
    const message = repairIntegrated
      ? `Migrated superseded product task back to demand role after canonical baseline repair ${canonicalRepairTaskId} integrated`
      : canonicalRepairTaskId
        ? `Migrated superseded product task back to demand role waiting for canonical baseline repair ${canonicalRepairTaskId}`
        : 'Migrated superseded product task back to demand role';

    await this.stateManager.updateTask(task.id, {
      status: nextStatus,
      endTime: nextStatus === 'ready_to_finalize' || nextStatus === 'failed_finalize'
        ? undefined
        : task.endTime,
      pid: undefined,
      leaseOwner: undefined,
      leaseHeartbeatAt: undefined,
      leaseExpiresAt: undefined,
      currentUS: undefined,
      lastErrorKind: nextStatus === 'ready_to_finalize'
        ? 'quality_gate_failure'
        : task.lastErrorKind === 'baseline_repair_superseded'
          ? 'baseline_quality_gate_failure'
          : task.lastErrorKind,
      lastError: task.lastErrorKind === 'baseline_repair_superseded' ? undefined : task.lastError,
      autoRecoveryKind: repairIntegrated ? undefined : 'baseline_repair',
      autoRecoveryStoppedAt: undefined,
      autoRecoveryStopReason: undefined,
      autoRecoveryLastReason: message,
      finalizeRepairStoppedAt: undefined,
      finalizeRepairStopReason: undefined,
      baselineRepairRole: 'demand_task',
      baselineQualityGate: task.baselineQualityGate
        ? {
            ...task.baselineQualityGate,
            repairTaskId: canonicalRepairTaskId ?? task.baselineQualityGate.repairTaskId,
            phase: repairIntegrated ? 'baseline_repair_integrated' : 'waiting_for_baseline_repair',
            lastUpdatedAt: now,
            stoppedAt: undefined,
            stopReason: undefined,
          }
        : undefined,
      baselineRepair: task.baselineRepair
        ? {
            ...task.baselineRepair,
            repairTaskId: canonicalRepairTaskId ?? task.baselineRepair.repairTaskId,
            status: repairIntegrated ? 'integrated' : 'waiting',
            updatedAt: now,
            message,
          }
        : undefined,
      ...buildActiveAutonomyRepairUpdates({
        task,
        kind: 'baseline_supersession_migration',
        budget,
        now,
        message,
      }),
    });
    appendTaskEvent(task, {
      type: 'baseline_supersession_migrated',
      status: nextStatus,
      message,
      data: {
        canonicalRepairTaskId,
        repairIntegrated,
        totalRequeues: budget.totalRequeues + 1,
      },
    });
    this.logger.log(`Task ${task.id} migrated from superseded baseline repair role to ${nextStatus}`);
    return 'repaired';
  }
}
