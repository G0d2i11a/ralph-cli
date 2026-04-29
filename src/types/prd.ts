export interface UserStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  passes?: boolean;
  notes?: string;
  priority?: string;
}

export interface PRD {
  id: string;
  title: string;
  description: string;
  status?: string;
  priority?: string;
  executable?: boolean;
  acceptanceCriteria?: string[];
  userStories: UserStory[];
  dependencies?: string[];
  writeSurface?: string[];
  conflictDomains?: string[];
  integrationLane?: string;
}
