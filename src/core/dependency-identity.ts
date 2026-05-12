import type { PRD } from '../types/prd';
import type { Task } from '../types/task';

export const DEPENDENCY_REPAIR_PRIORITY_CLASS = 'dependency_repair';

function normalizeIdentity(value?: string): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

export function isDependencyRepairPriority(priorityClass?: string): boolean {
  return priorityClass === DEPENDENCY_REPAIR_PRIORITY_CLASS;
}

export function resolveEffectiveDependencyPrdIdFromPrd(prd: Pick<
  PRD,
  'id' | 'priorityClass' | 'repairOf' | 'releasesDependenciesFor'
>): string {
  if (!isDependencyRepairPriority(prd.priorityClass)) {
    return prd.id;
  }

  return normalizeIdentity(prd.repairOf?.prdId)
    ?? normalizeIdentity(prd.releasesDependenciesFor?.[0])
    ?? prd.id;
}

export function resolveEffectiveDependencyPrdIdFromTask(task: Pick<
  Task,
  'prdId' | 'priorityClass' | 'repairOf' | 'releasesDependenciesFor' | 'effectiveDependencyPrdId'
>): string | undefined {
  if (!isDependencyRepairPriority(task.priorityClass)) {
    return normalizeIdentity(task.prdId);
  }

  return normalizeIdentity(task.repairOf?.prdId)
    ?? normalizeIdentity(task.releasesDependenciesFor?.[0])
    ?? normalizeIdentity(task.effectiveDependencyPrdId)
    ?? normalizeIdentity(task.prdId);
}
