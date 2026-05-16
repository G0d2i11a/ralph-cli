import { probeTaskWorktreeMergeability } from '../core/merge';
import { clearQuarantineReleaseUpdates } from '../core/quarantine';
import { StateManager } from '../core/state';
import { Task } from '../types/task';

function markAllStoriesPassed(task: Task, updatedAt: number): Pick<Task, 'completedUS' | 'storyProgress'> {
  const storyIds = new Set(task.completedUS);
  for (const story of task.storyProgress ?? []) {
    storyIds.add(story.id);
  }

  return {
    completedUS: [...storyIds],
    storyProgress: task.storyProgress?.map((story) => ({
      ...story,
      status: 'passed',
      lastError: undefined,
      updatedAt,
    })),
  };
}

export async function proveIntegrationCommand(
  taskId: string,
  options: { target?: string } = {},
): Promise<void> {
  try {
    const stateManager = new StateManager();
    const task = await stateManager.loadTask(taskId);

    if (!task) {
      console.error(JSON.stringify({ error: `Task ${taskId} not found` }));
      process.exit(1);
    }

    const targetBranch = options.target?.trim() || task.intendedMergeTarget || task.mergeTargetBranch || 'main';
    const proof = await probeTaskWorktreeMergeability(task, targetBranch, { syncTargetBranch: false });

    if (!proof.mergeable && !proof.alreadyIntegrated) {
      console.error(JSON.stringify({
        taskId,
        outcome: 'blocked',
        message: proof.message,
        conflictFiles: proof.conflictFiles,
      }));
      process.exit(1);
    }

    const provedAt = Date.now();
    const storyUpdates = markAllStoriesPassed(task, provedAt);
    const sharedUpdates: Partial<Task> = {
      status: 'completed',
      endTime: task.endTime ?? provedAt,
      currentUS: undefined,
      pid: undefined,
      leaseOwner: undefined,
      leaseHeartbeatAt: undefined,
      leaseExpiresAt: undefined,
      mergeError: undefined,
      mergeConflictFiles: undefined,
      mergeConflictAt: undefined,
      postFinalizeMergeProbeRequired: undefined,
      repairContext: undefined,
      mergeRepairDisplayStatus: undefined,
      mergeRepairProof: undefined,
      coordinationStatus: undefined,
      coordinationPhase: undefined,
      coordinationBlockers: undefined,
      coordinationConflicts: undefined,
      coordinationReason: undefined,
      ...clearQuarantineReleaseUpdates(),
      ...storyUpdates,
    };

    if (proof.alreadyIntegrated) {
      await stateManager.updateTask(taskId, {
        ...sharedUpdates,
        integrationStatus: 'integrated',
        integratedAt: provedAt,
        integrationBranch: proof.integrationBranch,
        integrationWorktree: proof.integrationWorktree,
      });
      console.log(JSON.stringify({
        taskId,
        outcome: 'already_integrated',
        message: proof.message,
      }));
      return;
    }

    await stateManager.updateTask(taskId, {
      ...sharedUpdates,
      integrationStatus: 'not_started',
      integratedAt: undefined,
      integrationCommitSha: undefined,
      integrationBranch: undefined,
      integrationWorktree: undefined,
      mergedAt: undefined,
      mergeCommitSha: undefined,
      mergeMessage: undefined,
      targetSyncStatus: 'not_requested',
      targetSyncedAt: undefined,
      targetSyncDeferredReason: undefined,
    });

    console.log(JSON.stringify({
      taskId,
      outcome: 'exact_mergeability',
      message: proof.message,
    }));
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exit(1);
  }
}
