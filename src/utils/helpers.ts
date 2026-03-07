import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { PRD } from '../types/prd';
import { Task } from '../types/task';
import { StateManager } from '../core/state';

// Stagnation detection thresholds
export const STAGNATION_THRESHOLDS = {
  NO_PROGRESS_THRESHOLD: 3,
  CONSECUTIVE_ERRORS_THRESHOLD: 3,
  MAX_LOOPS: 10
};

export function generateTaskId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function parsePRD(prdPath: string): PRD {
  const content = fs.readFileSync(prdPath, 'utf-8');
  
  // Try JSON first
  if (prdPath.endsWith('.json')) {
    return JSON.parse(content) as PRD;
  }
  
  // Parse markdown with frontmatter
  const parsed = matter(content);
  const frontmatter = parsed.data;
  const body = parsed.content;
  
  // Parse user stories from markdown content
  const userStories = parseUserStoriesFromMarkdown(body);
  
  return {
    id: frontmatter.id || path.basename(prdPath, path.extname(prdPath)),
    title: frontmatter.title || 'Untitled PRD',
    description: frontmatter.description || '',
    userStories,
    dependencies: frontmatter.dependencies || []
  };
}

function parseUserStoriesFromMarkdown(markdown: string): PRD['userStories'] {
  const userStories: PRD['userStories'] = [];
  
  // Match user story sections (### US-XXX: Title)
  const usRegex = /###\s+(US-\d+):\s+(.+?)(?=###|$)/gs;
  let match;
  
  while ((match = usRegex.exec(markdown)) !== null) {
    const id = match[1];
    const title = match[2].trim();
    const content = match[0];
    
    // Extract description (text after title until Acceptance Criteria)
    const descMatch = content.match(/\*\*Description\*\*:\s*(.+?)(?=\*\*Acceptance Criteria\*\*|$)/s);
    const description = descMatch ? descMatch[1].trim() : '';
    
    // Extract acceptance criteria (bullet points after **Acceptance Criteria**)
    const acMatch = content.match(/\*\*Acceptance Criteria\*\*:\s*((?:[-*]\s+.+?\n?)+)/s);
    const acceptanceCriteria: string[] = [];
    
    if (acMatch) {
      const acText = acMatch[1];
      const acLines = acText.split('\n').filter(line => line.trim().match(/^[-*]\s+/));
      acLines.forEach(line => {
        const cleaned = line.trim().replace(/^[-*]\s+/, '');
        if (cleaned) {
          acceptanceCriteria.push(cleaned);
        }
      });
    }
    
    userStories.push({
      id,
      title,
      description,
      acceptanceCriteria
    });
  }
  
  return userStories;
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

export function detectStagnation(task: Task): { isStagnant: boolean; reason?: string } {
  if (task.consecutiveNoProgress >= STAGNATION_THRESHOLDS.NO_PROGRESS_THRESHOLD) {
    return { 
      isStagnant: true, 
      reason: `No progress for ${task.consecutiveNoProgress} consecutive loops` 
    };
  }
  
  if (task.consecutiveErrors >= STAGNATION_THRESHOLDS.CONSECUTIVE_ERRORS_THRESHOLD) {
    return { 
      isStagnant: true, 
      reason: `${task.consecutiveErrors} consecutive errors` 
    };
  }
  
  if (task.loopCount >= STAGNATION_THRESHOLDS.MAX_LOOPS) {
    return { 
      isStagnant: true, 
      reason: `Exceeded max loops (${task.loopCount})` 
    };
  }
  
  return { isStagnant: false };
}

export async function checkDependencies(prd: PRD, stateManager: StateManager): Promise<{ satisfied: boolean; pending: string[] }> {
  if (!prd.dependencies || prd.dependencies.length === 0) {
    return { satisfied: true, pending: [] };
  }
  
  const pending: string[] = [];
  
  for (const depId of prd.dependencies) {
    const depTask = await stateManager.getTaskByPrdId(depId);
    if (!depTask || depTask.status !== 'completed') {
      pending.push(depId);
    }
  }
  
  return { 
    satisfied: pending.length === 0, 
    pending 
  };
}
