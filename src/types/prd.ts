export interface UserStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

export interface PRD {
  id: string;
  title: string;
  description: string;
  userStories: UserStory[];
  dependencies?: string[];
}
