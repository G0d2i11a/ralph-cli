export interface UserStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  passes?: boolean;
  notes?: string;
  priority?: string;
}

export interface PRDReferenceImplementation {
  [key: string]: unknown;
  status?: string;
  kind?: string;
  artifactPath?: string;
  artifactSha256?: string;
  touchedFiles?: string[];
  applyOrder?: string[];
  testCommands?: string[];
  assumptions?: unknown[];
  knownRisks?: unknown[];
  dependencyRechecks?: unknown[];
  rollbackNotes?: unknown[];
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
  referenceImplementation?: PRDReferenceImplementation;
}
