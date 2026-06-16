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
}

export interface PRDReferenceImplementation {
  [key: string]: unknown;
  status?: string;
  kind?: string;
  touchedFiles?: string[];
  applyInstructions?: string;
  testCommands?: string[];
  assumptions?: unknown[];
  knownRisks?: unknown[];
  patch?: string;
  completeFiles?: Record<string, string>;
}

export interface PRD {
  id: string;
  title: string;
  description: string;
  userStories: UserStory[];
  acceptanceCriteria?: string[];
  nonGoals?: string[];
  safetyBoundaries?: string[];
  forbiddenWriteSurface?: string[];
  verificationCommands?: string[];
  dependencies?: string[];
  writeSurface?: string[];
  conflictDomains?: string[];
  integrationLane?: string;
  priorityClass?: PRDPriorityClass;
  repairOf?: PRDRepairOf;
  releasesDependenciesFor?: string[];
  schedulerHints?: PRDSchedulerHints;
  referenceImplementation?: PRDReferenceImplementation;
}
