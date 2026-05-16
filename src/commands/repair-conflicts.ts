import { ConfigManager } from '../config/manager';
import {
  ConflictResolutionResult,
  resolveIntegrationSyncConflict,
} from '../core/conflict-resolution';
import { appendTaskEvent } from '../core/events';
import { resolveIntegrationPolicy } from '../core/integration-policy';
import { probeTaskWorktreeMergeability } from '../core/merge';
import { buildMergeRepairProof, deriveMergeRepairDisplayStatus } from '../core/merge-task-updates';
import { StateManager } from '../core/state';
import type { Task, TaskConflictRepairProof } from '../types/task';

interface RepairConflictsCommandOptions {
  dryRun?: boolean;
  apply?: boolean;
  json?: boolean;
  allowLlm?: boolean;
}

type MergeabilityProbe = Awaited<ReturnType<typeof probeTaskWorktreeMergeability>>;

function serializeProbe(probe?: MergeabilityProbe) {
  if (!probe) {
    return undefined;
  }

  return {
    mergeable: probe.mergeable,
    alreadyIntegrated: probe.alreadyIntegrated,
    message: probe.message,
    conflictFiles: probe.conflictFiles,
    failurePhase: probe.failurePhase,
    integrationBranch: probe.integrationBranch,
    integrationWorktree: probe.integrationWorktree,
  };
}

function withExactProbe(
  proof: TaskConflictRepairProof | undefined,
  probe?: MergeabilityProbe,
): TaskConflictRepairProof | undefined {
  if (!proof) {
    return undefined;
  }

  if (!probe) {
    return proof;
  }

  return {
    ...proof,
    exactProbe: {
      mergeable: probe.mergeable,
      alreadyIntegrated: probe.alreadyIntegrated,
      message: probe.message,
      conflictFiles: probe.conflictFiles,
      failurePhase: probe.failurePhase,
    },
  };
}

function compactRepairResult(result: ConflictResolutionResult): ConflictResolutionResult {
  return {
    ...result,
    files: result.files?.map((file) => ({
      ...file,
      candidateContent: '',
    })),
  };
}

async function initialProbeForTask(
  task: Task,
  configManager: ConfigManager,
): Promise<MergeabilityProbe | undefined> {
  const policy = resolveIntegrationPolicy(configManager);
  try {
    return await probeTaskWorktreeMergeability(task, policy.targetBranch, {
      pullLatest: policy.pullLatest,
      integrationWorktreeDir: policy.integrationWorktreeDir,
      syncTargetBranch: false,
    });
  } catch {
    return undefined;
  }
}

export async function repairConflictsCommand(
  taskId: string,
  options: RepairConflictsCommandOptions = {},
): Promise<void> {
  const stateManager = new StateManager();
  const configManager = new ConfigManager();
  const policy = resolveIntegrationPolicy(configManager);

  try {
    if (options.apply && options.dryRun) {
      throw new Error('Use either --dry-run or --apply, not both');
    }

    const apply = Boolean(options.apply);
    const task = await stateManager.loadTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    const initialProbe = await initialProbeForTask(task, configManager);
    const repair = await resolveIntegrationSyncConflict({
      task,
      targetBranch: policy.targetBranch,
      conflictFiles: initialProbe?.conflictFiles ?? task.mergeConflictFiles,
      integrationBranch: initialProbe?.integrationBranch ?? task.integrationBranch,
      integrationWorktree: initialProbe?.integrationWorktree ?? task.integrationWorktree,
      mergeProbeResult: initialProbe,
      configManager,
      apply,
      allowLlm: Boolean(options.allowLlm),
      triggeredBy: 'manual',
    });

    let postRepairProbe: MergeabilityProbe | undefined;
    let proof = repair.proof;

    if (apply && repair.resolved) {
      postRepairProbe = await probeTaskWorktreeMergeability(task, policy.targetBranch, {
        pullLatest: policy.pullLatest,
        integrationWorktreeDir: policy.integrationWorktreeDir,
        syncTargetBranch: false,
      });
      proof = withExactProbe(repair.proof, postRepairProbe);

      const clean = postRepairProbe.alreadyIntegrated || postRepairProbe.mergeable;
      const previousProofs = task.conflictRepairProofs ?? [];
      await stateManager.updateTask(task.id, {
        conflictRepairProof: proof,
        conflictRepairProofs: proof ? [...previousProofs, proof].slice(-20) : previousProofs,
        mergeRepairDisplayStatus: deriveMergeRepairDisplayStatus(postRepairProbe),
        mergeRepairProof: buildMergeRepairProof(postRepairProbe, Date.now()),
        mergeError: clean ? undefined : postRepairProbe.message,
        mergeConflictFiles: clean ? undefined : postRepairProbe.conflictFiles,
        mergeConflictPhase: clean ? undefined : postRepairProbe.failurePhase,
        mergeConflictAt: clean ? undefined : Date.now(),
        integrationBranch: postRepairProbe.integrationBranch ?? task.integrationBranch,
        integrationWorktree: postRepairProbe.integrationWorktree ?? task.integrationWorktree,
        postFinalizeMergeProbeRequired: true,
        autoRecoveryKind: 'merge_repair',
        autoRecoveryStoppedAt: undefined,
        autoRecoveryStopReason: undefined,
        autoRecoveryLastReason: repair.message,
        mergeRepairRecoveryStoppedAt: undefined,
        mergeRepairRecoveryStopReason: undefined,
      });

      appendTaskEvent(task, {
        type: 'integration_sync_conflict_auto_resolved',
        status: task.status,
        message: repair.message,
        data: {
          proof,
          exactProbe: serializeProbe(postRepairProbe),
          command: 'repair-conflicts',
        },
      });
    }

    const payload = {
      success: repair.resolved,
      taskId,
      mode: apply ? 'apply' : 'dry-run',
      repair: compactRepairResult({ ...repair, proof }),
      initialProbe: serializeProbe(initialProbe),
      postRepairProbe: serializeProbe(postRepairProbe),
      nextAction: apply && repair.resolved
        ? 'Ralph manager can re-probe this task; if needed, run ralph retry to reschedule the merge-repair path.'
        : repair.resolved
          ? `Review the dry-run proof, then run: ralph repair-conflicts ${taskId} --apply`
          : 'Manual repair is required; resolver refused this conflict class.',
    };

    console.log(JSON.stringify(payload, null, options.json ? 0 : 2));
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      taskId,
    }, null, options.json ? 0 : 2));
    process.exitCode = 1;
  }
}
