import { StateManager } from './core/state';
import { AgentRunner, AgentType } from './core/agent';
import { bootstrapWorktreeDeps } from './core/bootstrap';
import { finalizeTask } from './core/scheduler';
import { shouldTreatNonZeroExitAsSuccess } from './core/soft-success';
import { parsePRD, detectStagnation } from './utils/helpers';
import { execSync } from 'child_process';
import * as fs from 'fs';

async function runWorker(taskId: string) {
  console.log(`[Worker] Starting worker for task ${taskId}`);
  
  const stateManager = new StateManager();
  const task = await stateManager.loadTask(taskId);
  
  if (!task) {
    console.error(`[Worker] Task ${taskId} not found`);
    process.exit(1);
  }
  
  console.log(`[Worker] Task loaded: ${task.id}`);
  console.log(`[Worker] PRD path: ${task.prdPath}`);
  console.log(`[Worker] Worktree: ${task.worktree}`);
  console.log(`[Worker] Agent: ${task.agent}`);
  
  try {
    if (task.worktree) {
      bootstrapWorktreeDeps(task.worktree, {
        repoPath: task.repoPath,
        logPath: task.logPath,
      });
    }

    // Parse PRD
    console.log(`[Worker] Parsing PRD from ${task.prdPath}`);
    const prd = parsePRD(task.prdPath);
    console.log(`[Worker] PRD parsed: ${prd.title}`);
    console.log(`[Worker] User stories: ${prd.userStories.length}`);
    
    const runner = new AgentRunner();
    
    // Run each user story
    for (const us of prd.userStories) {
      // Skip already completed user stories
      if (task.completedUS.includes(us.id)) {
        console.log(`[Worker] Skipping completed User Story: ${us.id}`);
        continue;
      }
      
      // Update current US
      task.currentUS = us.id;
      await stateManager.saveTask(task);
      
      console.log(`Running User Story: ${us.id} - ${us.title}`);
      
      // Record baseline state before running user story
      const baselineState = captureProgressBaseline(task.worktree);
      
      const result = await runner.runUserStory(
        us,
        task.worktree,
        task.agent as AgentType,
        task.logPath,
        task.sessionId
      );

      // Save sessionId if returned
      if (result.sessionId) {
        task.sessionId = result.sessionId;
        await stateManager.saveTask(task);
      }
      
      // Detect progress using multiple signals
      const progressDetected = detectProgress(
        task.worktree,
        task.logPath,
        baselineState
      );
      
      // Update loop metrics
      task.loopCount++;
      task.lastFilesChanged = progressDetected.filesChanged;
      
      // Reset consecutiveNoProgress if ANY progress signal detected
      if (progressDetected.hasProgress) {
        task.consecutiveNoProgress = 0;
        task.lastProgressTime = Date.now();
        console.log(`[Worker] Progress detected: ${progressDetected.reason}`);
      } else {
        task.consecutiveNoProgress++;
        console.log(`[Worker] No progress detected (consecutive: ${task.consecutiveNoProgress})`);
      }
      
      if (!result.success) {
        task.consecutiveErrors++;
        task.lastError = result.output.slice(-500); // Last 500 chars
      } else {
        task.consecutiveErrors = 0;
        task.lastError = undefined;
      }
      
      await stateManager.saveTask(task);
      
      // Check for stagnation
      const stagnationCheck = detectStagnation(task);
      if (stagnationCheck.isStagnant) {
        console.error(`Stagnation detected: ${stagnationCheck.reason}`);
        await finalizeTask(task, 'stagnant', { stateManager });
        process.exit(1);
      }
      
      if (!result.success) {
        const softSuccess = shouldTreatNonZeroExitAsSuccess({
          output: result.output,
          progress: progressDetected,
        });

        if (softSuccess.shouldTreatAsSuccess) {
          console.log(`[Worker] Treating non-zero exit as soft success: ${softSuccess.reason}`);
          task.consecutiveErrors = 0;
          task.lastError = undefined;
          await stateManager.saveTask(task);
        } else {
          console.error(`Failed to complete User Story: ${us.id}`);
          await finalizeTask(task, 'failed', { stateManager });
          process.exit(1);
        }
      }

      // Mark as completed
      task.completedUS.push(us.id);
      await stateManager.saveTask(task);
    }

    // Implementation phase is done; leave commit/merge to the restricted finalizer.
    task.status = 'ready_to_finalize';
    task.currentUS = undefined;
    task.pid = undefined;
    await stateManager.saveTask(task);

    console.log(`Task ${taskId} implementation complete; awaiting finalizer`);
    
  } catch (error) {
    console.error(`[Worker] Worker error: ${error}`);
    if (error instanceof Error) {
      console.error(`[Worker] Error stack: ${error.stack}`);
    }
    await finalizeTask(task, 'failed', { stateManager });
    process.exit(1);
  }
}

/**
 * Capture baseline state before running a user story iteration
 */
interface ProgressBaseline {
  commitSHA: string;
  commitCount: number;
  workingTreeFiles: number;
  logSize: number;
}

function captureProgressBaseline(worktreePath: string): ProgressBaseline {
  return {
    commitSHA: getLatestCommitSHA(worktreePath),
    commitCount: getCommitCount(worktreePath),
    workingTreeFiles: getChangedFilesCount(worktreePath),
    logSize: 0 // Will be set by caller if needed
  };
}

/**
 * Detect progress using multiple signals:
 * 1. New commits (most reliable - code was committed)
 * 2. Working tree changes (code modified but not committed yet)
 * 3. Agent log success messages (agent reported completion)
 */
interface ProgressResult {
  hasProgress: boolean;
  reason: string;
  filesChanged: number;
  newCommits: number;
}

function detectProgress(
  worktreePath: string,
  logPath: string,
  baseline: ProgressBaseline
): ProgressResult {
  // Check 1: New commits (highest priority)
  const currentCommitCount = getCommitCount(worktreePath);
  const newCommits = currentCommitCount - baseline.commitCount;
  
  if (newCommits > 0) {
    return {
      hasProgress: true,
      reason: `${newCommits} new commit(s)`,
      filesChanged: 0, // Commits already captured changes
      newCommits
    };
  }
  
  // Check 2: Working tree changes
  const currentFiles = getChangedFilesCount(worktreePath);
  const filesChanged = Math.abs(currentFiles - baseline.workingTreeFiles);
  
  if (filesChanged > 0) {
    return {
      hasProgress: true,
      reason: `${filesChanged} file(s) changed in working tree`,
      filesChanged,
      newCommits: 0
    };
  }
  
  // Check 3: Agent log success indicators
  const hasSuccessMessage = checkAgentLogForSuccess(logPath);
  
  if (hasSuccessMessage) {
    return {
      hasProgress: true,
      reason: 'Agent reported success in log',
      filesChanged: 0,
      newCommits: 0
    };
  }
  
  // No progress detected
  return {
    hasProgress: false,
    reason: 'No commits, no file changes, no success messages',
    filesChanged: 0,
    newCommits: 0
  };
}

/**
 * Get the latest commit SHA in the worktree
 */
function getLatestCommitSHA(worktreePath: string): string {
  try {
    const sha = execSync('git rev-parse HEAD', {
      cwd: worktreePath,
      encoding: 'utf-8'
    });
    return sha.trim();
  } catch {
    return '';
  }
}

/**
 * Get total commit count in current branch
 */
function getCommitCount(worktreePath: string): number {
  try {
    const count = execSync('git rev-list --count HEAD', {
      cwd: worktreePath,
      encoding: 'utf-8'
    });
    return parseInt(count.trim(), 10);
  } catch {
    return 0;
  }
}

/**
 * Count files with changes in working tree (staged + unstaged)
 */
function getChangedFilesCount(worktreePath: string): number {
  try {
    const output = execSync('git status --porcelain', { 
      cwd: worktreePath,
      encoding: 'utf-8'
    });
    return output.trim().split('\n').filter((line: string) => line.length > 0).length;
  } catch {
    return 0;
  }
}

/**
 * Check agent.log for success indicators
 * Looks for patterns like "completed", "success", "done", etc.
 */
function checkAgentLogForSuccess(logPath: string): boolean {
  try {
    if (!fs.existsSync(logPath)) {
      return false;
    }
    
    // Read last 50KB of log (avoid reading huge files)
    const stats = fs.statSync(logPath);
    const readSize = Math.min(50 * 1024, stats.size);
    const buffer = Buffer.alloc(readSize);
    
    const fd = fs.openSync(logPath, 'r');
    fs.readSync(fd, buffer, 0, readSize, Math.max(0, stats.size - readSize));
    fs.closeSync(fd);
    
    const logTail = buffer.toString('utf-8');
    
    // Success patterns (case-insensitive)
    const successPatterns = [
      /user story.*completed/i,
      /successfully.*implemented/i,
      /all.*tests.*pass/i,
      /implementation.*complete/i,
      /task.*done/i,
      /✓.*success/i,
      /✅/
    ];
    
    return successPatterns.some(pattern => pattern.test(logTail));
  } catch {
    return false;
  }
}

// Get task ID from command line
const taskId = process.argv[2];
if (!taskId) {
  console.error('Task ID required');
  process.exit(1);
}

runWorker(taskId);
