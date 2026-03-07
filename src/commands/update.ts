import { StateManager } from '../core/state';
import * as fs from 'fs';
import * as path from 'path';

interface UpdateOptions {
  passes?: boolean;
  notes?: string;
  storyId?: string;
}

export async function updateCommand(taskId: string, options: UpdateOptions) {
  const stateManager = new StateManager();

  try {
    if (!options.storyId) {
      console.error(JSON.stringify({ error: '--story-id is required' }));
      process.exit(1);
    }

    const task = await stateManager.loadTask(taskId);
    if (!task) {
      console.error(JSON.stringify({ error: `Task ${taskId} not found` }));
      process.exit(1);
    }

    // Read PRD file from worktree
    const prdPath = path.join(task.worktree, 'prd.json');
    if (!fs.existsSync(prdPath)) {
      console.error(JSON.stringify({ error: `PRD file not found at ${prdPath}` }));
      process.exit(1);
    }

    const prd = JSON.parse(fs.readFileSync(prdPath, 'utf-8'));
    
    // Find and update the user story
    const story = prd.userStories?.find((s: any) => s.id === options.storyId);
    if (!story) {
      console.error(JSON.stringify({ error: `Story ${options.storyId} not found in PRD` }));
      process.exit(1);
    }

    if (options.passes !== undefined) {
      story.passes = options.passes;
    }
    if (options.notes !== undefined) {
      story.notes = options.notes;
    }

    // Write back to PRD
    fs.writeFileSync(prdPath, JSON.stringify(prd, null, 2));

    // Update task's completed stories list
    if (options.passes && !task.completedUS.includes(options.storyId)) {
      task.completedUS.push(options.storyId);
      await stateManager.saveTask(task);
    }

    console.log(JSON.stringify({
      success: true,
      taskId,
      storyId: options.storyId,
      passes: story.passes,
      notes: story.notes
    }));
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    }));
    process.exit(1);
  }
}
