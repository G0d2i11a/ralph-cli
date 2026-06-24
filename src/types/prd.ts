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

export interface PRDOperatorGate {
  [key: string]: unknown;
  status?: string;
}

export interface PRDOperatorGates {
  [key: string]: unknown;
  preEnqueueGate?: PRDOperatorGate;
  postApplyPreRunGate?: PRDOperatorGate;
}

export interface PRDExecutionPhase {
  [key: string]: unknown;
  successStatus?: string;
}

export interface PRDExecutionPhases {
  [key: string]: unknown;
  requiresTwoPhaseApplyRunHold?: boolean;
  phase1ApplyAndSeal?: PRDExecutionPhase;
}

export interface PRD {
  [key: string]: unknown;
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
  operator?: PRDOperatorGates;
  ralphExecutionPhases?: PRDExecutionPhases;
  enqueueBlockedUntil?: string[];
  runBlockedUntil?: string[];
  requiredRalphGuarantees?: string[];
  applyOnlyStatus?: string;
  ccoReview?: Record<string, unknown>;
  validationEvidence?: Record<string, unknown>;
}
