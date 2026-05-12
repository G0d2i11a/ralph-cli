export interface UserStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  passes?: boolean;
  notes?: string;
  priority?: string;
}

export type PRDPriorityClass = 'dependency_repair' | string;

export interface PRDRepairOf {
  prdId: string;
  taskId?: string;
  reason?: string;
}

export interface PRDSchedulerHints {
  [key: string]: unknown;
  priorityClass?: PRDPriorityClass;
  effectiveDependencyPrdId?: string;
  releasesDependenciesFor?: string[];
  repairTaskId?: string;
  repairReason?: string;
  demandTaskIds?: string[];
  bypassPendingDownstreamOverlaps?: boolean;
  doNotBypassRunningOverlaps?: boolean;
  parkNonRepairPendingOverlaps?: boolean;
  emitRepairStarvationIfBlockedForMs?: number;
}

export interface PRD {
  id: string;
  title: string;
  description: string;
  userStories: UserStory[];
  dependencies?: string[];
  writeSurface?: string[];
  conflictDomains?: string[];
  integrationLane?: string;
  priorityClass?: PRDPriorityClass;
  repairOf?: PRDRepairOf;
  releasesDependenciesFor?: string[];
  schedulerHints?: PRDSchedulerHints;
}
