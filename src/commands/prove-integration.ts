import { ConfigManager } from '../config/manager';
import { appendTaskEvent } from '../core/events';
import { resolveIntegrationPolicy } from '../core/integration-policy';
import { probeTaskWorktreeMergeability, MergeabilityProbeResult } from '../core/merge';
import {
  buildMergeRepairProof,
  deriveMergeRepairDisplayStatus,
} from '../core/merge-task-updates';
import { clearQuarantineReleaseUpdates } from '../core/quarantine';
import { TaskScheduler } from '../core/scheduler';
import { StateManager } from '../core/state';
import {
  buildStoryCompletionInvariantFailureUpdates,
  evaluateTaskStoryCompletion,
  formatStoryCompletionInvariantMessage,
} from '../core/story-completion';
import { Task, StoryProgress } from '../types/task';

type ProveIntegrationCommandOptions = {
  target?: string;
};

function selectProofStoryId(task: Pick<Task, 'repairContext' | 'storyProgress' | 'completedUS'>): string | undefined {
  if (task.repairContext?.mode === 'merge') {
    return task.repairContext.storyId;
  }

  const needsRepairStory = task.storyProgress
    ?.slice()
    .reverse()
    .find((story) => story.status === 'needs_repair' || story.status === 'failed' || story.status === 'in_progress');

  return needsRepairStory?.id
    || task.completedUS[task.completedUS.length - 1]
    || task.storyProgress?.[task.storyProgress.length - 1]?.id;
}

function markProofStoryPassed(
  task: Task,
  storyId: string | undefined,
  message: string,
  updatedAt: number,
): {
  completedUS: string[];
  storyProgress: StoryProgress[] | undefined;
} {
  if (!storyId) {
    return {
      completedUS: task.completedUS,
      storyProgress: task.storyProgress,
    };
  }

  return {
    completedUS: task.completedUS.includes(storyId)
      ? task.completedUS
      : [...task.completedUS, storyId],
    storyProgress: task.storyProgress?.map((story) => {
      if (story.id !== storyId) {
        return story;
      }

      return {
        ...story,
        status: 'passed' as const,
        lastError: undefined,
        lastEvidence: story.lastEvidence || message,
        updatedAt,
        history: [
          ...(story.history || []),
          {
            attempt: story.attempts,
            status: 'passed' as const,
            message,
            evidence: story.lastEvidence || message,
            updatedAt,
          },
        ],
      };
    }),
  };
}

function buildCommonProofUpdates(
  probeResult: MergeabilityProbeResult,
  observedAt: number,
): Partial<Task> {
  return {
    pid: undefined,
    currentUS: undefined,
    leaseOwner: undefined,
    leaseHeartbeatAt: undefined,
    leaseExpiresAt: undefined,
    lastError: undefined,
    lastErrorKind: undefined,
    lastErrorClass: undefined,
    lastErrorRetryable: undefined,
    lastErrorObservedAt: undefined,
    lastErrorSignature: undefined,
    lastErrorHadObjectiveProgress: undefined,
    mergeError: undefined,
    mergeConflictFiles: undefined,
    mergeConflictAt: undefined,
    repairContext: undefined,
    integrationBranch: probeResult.integrationBranch,
    integrationWorktree: probeResult.integrationWorktree,
    mergeRepairDisplayStatus: deriveMergeRepairDisplayStatus(probeResult),
    mergeRepairProof: buildMergeRepairProof(probeResult, observedAt),
    autoRecoveryKind: undefined,
    autoRecoveryNextEligibleAt: undefined,
    autoRecoveryStoppedAt: undefined,
    autoRecoveryStopReason: undefined,
    autoRecoveryLastReason: probeResult.message,
    mergeRepairRecoveryStoppedAt: undefined,
    mergeRepairRecoveryStopReason: undefined,
    ...clearQuarantineReleaseUpdates(),
  };
}

function summarizeProbe(probeResult: MergeabilityProbeResult) {
  return {
    mergeable: probeResult.mergeable,
    alreadyIntegrated: probeResult.alreadyIntegrated,
    sourceKind: probeResult.sourceKind,
    message: probeResult.message,
    conflictFiles: probeResult.conflictFiles,
    integrationBranch: probeResult.integrationBranch,
    integrationWorktree: probeResult.integrationWorktree,
  };
}

export async function proveIntegrationCommand(
  taskId: string,
  options: ProveIntegrationCommandOptions = {},
): Promise<void> {
  try {
    const stateManager = new StateManager();
    const configManager = new ConfigManager();
    const integrationPolicy = resolveIntegrationPolicy(configManager);
    const targetBranch = options.target?.trim() || integrationPolicy.targetBranch;
    const task = await stateManager.loadTask(taskId);

    if (!task) {
      console.error(JSON.stringify({ error: `Task ${taskId} not found` }));
      process.exit(1);
    }

    const probeResult = await probeTaskWorktreeMergeability(task, targetBranch, {
      pullLatest: integrationPolicy.pullLatest,
      integrationWorktreeDir: integrationPolicy.integrationWorktreeDir,
      syncTargetBranch: false,
    });
    const observedAt = Date.now();

    if (!probeResult.alreadyIntegrated && !probeResult.mergeable) {
      await stateManager.updateTask(taskId, {
        lastError: probeResult.message,
        lastErrorKind: 'merge_conflict',
        lastErrorClass: 'merge_conflict',
        lastErrorRetryable: true,
        lastErrorObservedAt: observedAt,
        mergeError: probeResult.message,
        mergeConflictFiles: probeResult.conflictFiles,
        mergeConflictAt: observedAt,
        integrationBranch: probeResult.integrationBranch,
        integrationWorktree: probeResult.integrationWorktree,
        mergeRepairDisplayStatus: deriveMergeRepairDisplayStatus(probeResult),
        mergeRepairProof: buildMergeRepairProof(probeResult, observedAt),
      });
      appendTaskEvent(task, {
        type: 'merge_repair_exact_proof_failed',
        status: task.status,
        message: probeResult.message,
        data: {
          targetBranch,
          conflictFiles: probeResult.conflictFiles,
        },
      });
      console.error(JSON.stringify({
        success: false,
        cleared: false,
        taskId,
        proof: summarizeProbe(probeResult),
      }));
      process.exit(1);
    }

    const recoveryMessage = probeResult.alreadyIntegrated
      ? `Exact proof cleared quarantine because the task is already integrated in ${probeResult.integrationBranch}`
      : `Exact proof cleared quarantine because the task is mergeable against ${probeResult.integrationBranch}`;
    const proofStoryId = selectProofStoryId(task);
    const proofProgress = markProofStoryPassed(task, proofStoryId, recoveryMessage, observedAt);
    const storyCompletion = evaluateTaskStoryCompletion({
      ...task,
      completedUS: proofProgress.completedUS,
      storyProgress: proofProgress.storyProgress,
    });

    if (!storyCompletion.allStoriesPassed) {
      const message = formatStoryCompletionInvariantMessage(task.id, 'finalize', storyCompletion);
      await stateManager.updateTask(taskId, {
        ...buildCommonProofUpdates(probeResult, observedAt),
        status: 'failed',
        completedUS: proofProgress.completedUS,
        storyProgress: proofProgress.storyProgress,
        endTime: observedAt,
        postFinalizeMergeProbeRequired: undefined,
        mergeRepairDisplayStatus: undefined,
        mergeRepairProof: undefined,
        ...buildStoryCompletionInvariantFailureUpdates(message, observedAt),
      });
      appendTaskEvent(task, {
        type: 'story_completion_invariant_failed',
        status: 'failed',
        storyId: proofStoryId,
        message,
        data: {
          phase: 'finalize',
          exactProbeMessage: probeResult.message,
          incompleteStories: storyCompletion.incompleteStories,
        },
      });
      console.error(JSON.stringify({
        success: false,
        cleared: true,
        taskId,
        error: message,
        proof: summarizeProbe(probeResult),
      }));
      process.exit(1);
    }

    const commonUpdates = buildCommonProofUpdates(probeResult, observedAt);
    const statusUpdates: Partial<Task> = probeResult.alreadyIntegrated
      ? {
          status: 'completed',
          endTime: observedAt,
          integratedAt: observedAt,
          integrationStatus: 'integrated',
          postFinalizeMergeProbeRequired: undefined,
        }
      : task.status === 'completed' && probeResult.sourceKind === 'branch_head'
        ? {
            status: 'completed',
            integrationStatus: 'not_started',
            integratedAt: undefined,
            integrationCommitSha: undefined,
            mergedAt: undefined,
            mergeCommitSha: undefined,
            mergeMessage: undefined,
            targetSyncedAt: undefined,
            targetSyncStatus: 'not_requested',
            targetSyncDeferredReason: undefined,
            postFinalizeMergeProbeRequired: undefined,
          }
        : {
            status: 'ready_to_finalize',
            endTime: undefined,
            integrationStatus: 'not_started',
            integratedAt: undefined,
            integrationCommitSha: undefined,
            mergedAt: undefined,
            mergeCommitSha: undefined,
            mergeMessage: undefined,
            targetSyncedAt: undefined,
            targetSyncStatus: 'not_requested',
            targetSyncDeferredReason: undefined,
            postFinalizeMergeProbeRequired: true,
          };

    await stateManager.updateTask(taskId, {
      ...commonUpdates,
      ...statusUpdates,
      completedUS: proofProgress.completedUS,
      storyProgress: proofProgress.storyProgress,
      coordinationStatus: undefined,
      coordinationPhase: undefined,
      coordinationBlockers: undefined,
      coordinationReason: undefined,
    });

    const latestTask = await stateManager.loadTask(taskId);
    appendTaskEvent(latestTask || task, {
      type: probeResult.alreadyIntegrated
        ? 'merge_repair_already_integrated_proof'
        : 'merge_repair_exact_mergeability_proof',
      status: latestTask?.status || statusUpdates.status,
      storyId: proofStoryId,
      message: recoveryMessage,
      data: {
        targetBranch,
        proof: summarizeProbe(probeResult),
      },
    });

    await new TaskScheduler({ stateManager }).schedulePendingTasks();

    console.log(JSON.stringify({
      success: true,
      cleared: true,
      taskId,
      previousStatus: task.status,
      currentStatus: latestTask?.status || statusUpdates.status,
      outcome: probeResult.alreadyIntegrated ? 'already_integrated' : 'exact_mergeability',
      completedUS: latestTask?.completedUS.length ?? proofProgress.completedUS.length,
      proofStoryId,
      proof: summarizeProbe(probeResult),
    }));
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exit(1);
  }
}
