import * as path from 'path';
import { Task } from '../types/task';
import { DEPENDENCY_REPAIR_PRIORITY_CLASS } from './dependency-identity';

export const PENDING_TASK_PRIORITY_RANK = {
  dependencyRepair: 0,
  baselineRepair: 1,
  taskRepair: 1,
  ordinary: 1,
} as const;

type PendingTaskOrderingFields = Pick<
  Task,
  | 'id'
  | 'priorityClass'
  | 'baselineRepair'
  | 'baselineRepairRole'
  | 'prdId'
  | 'prdPath'
  | 'repairContext'
  | 'enqueuedAt'
  | 'startTime'
>;

function isBaselineRepairTask(task: Pick<
  Task,
  'id' | 'baselineRepair' | 'baselineRepairRole' | 'prdId' | 'prdPath'
>): boolean {
  return Boolean(
    task.baselineRepairRole === 'dedicated_repair_task'
    || task.baselineRepair?.dedicatedRepairTask === true
    || task.baselineRepair?.repairTaskId === task.id
    || task.prdId?.startsWith('baseline-quality-gate:')
    || task.prdPath?.split(path.sep).includes('baseline-repairs')
  );
}

function isMergeOrFinalizeRepairTask(task: Pick<Task, 'repairContext'>): boolean {
  return task.repairContext?.mode === 'merge' || task.repairContext?.mode === 'finalize';
}

export function pendingTaskPriorityRank(task: Pick<
  Task,
  'id' | 'priorityClass' | 'baselineRepair' | 'baselineRepairRole' | 'prdId' | 'prdPath' | 'repairContext'
>): number {
  if (task.priorityClass === DEPENDENCY_REPAIR_PRIORITY_CLASS) {
    return PENDING_TASK_PRIORITY_RANK.dependencyRepair;
  }

  if (isBaselineRepairTask(task)) {
    return PENDING_TASK_PRIORITY_RANK.baselineRepair;
  }

  if (isMergeOrFinalizeRepairTask(task)) {
    return PENDING_TASK_PRIORITY_RANK.taskRepair;
  }

  return PENDING_TASK_PRIORITY_RANK.ordinary;
}

export function comparePendingTaskScheduleOrder(
  left: PendingTaskOrderingFields,
  right: PendingTaskOrderingFields,
): number {
  const priorityDiff = pendingTaskPriorityRank(left) - pendingTaskPriorityRank(right);
  if (priorityDiff !== 0) {
    return priorityDiff;
  }

  const leftEnqueuedAt = left.enqueuedAt ?? left.startTime;
  const rightEnqueuedAt = right.enqueuedAt ?? right.startTime;
  if (leftEnqueuedAt !== rightEnqueuedAt) {
    return leftEnqueuedAt - rightEnqueuedAt;
  }

  if (left.startTime !== right.startTime) {
    return left.startTime - right.startTime;
  }

  return left.id.localeCompare(right.id);
}

export function pendingTaskHasHigherPriorityThanCandidate(task: Task, candidate: Task): boolean {
  return candidate.status === 'pending'
    && pendingTaskPriorityRank(task) < pendingTaskPriorityRank(candidate);
}
