import { buildCoordinationState } from '../core/task-coordination';
import { buildAutoRecoveryState, buildDeliveryState, buildTransientRetryState } from '../core/task-delivery';
import { StateManager } from '../core/state';
import { TaskStatus } from '../types/task';
import { formatDuration, isProcessRunning } from '../utils/helpers';

export async function listCommand(options: { status?: string }): Promise<void> {
  try {
    const stateManager = new StateManager();
    const statusFilter = options.status as TaskStatus | undefined;

    const tasks = await stateManager.listTasks(statusFilter);

    const output = tasks.map(task => {
      const delivery = buildDeliveryState(task);
      const coordination = buildCoordinationState(task);
      const transientRetry = buildTransientRetryState(task);
      const autoRecovery = buildAutoRecoveryState(task);

      return {
        id: task.id,
        status: task.status,
        agent: task.agent,
        backend: task.backend,
        prdId: task.prdId,
        prdPath: task.prdPath,
        baseRef: task.baseRef,
        startTime: new Date(task.startTime).toISOString(),
        duration: task.endTime
          ? formatDuration(task.endTime - task.startTime)
          : formatDuration(Date.now() - task.startTime),
        currentUS: task.currentUS,
        completedUS: task.completedUS.length,
        running: task.pid ? isProcessRunning(task.pid) : false,
        integratedAt: task.integratedAt ? new Date(task.integratedAt).toISOString() : undefined,
        integrationStatus: delivery.integrationStatus,
        integrationCommitSha: task.integrationCommitSha,
        mergedAt: task.mergedAt ? new Date(task.mergedAt).toISOString() : undefined,
        mergeTargetBranch: task.mergeTargetBranch,
        mergeCommitSha: task.mergeCommitSha,
        targetSyncStatus: delivery.targetSyncStatus,
        targetSyncDeferredReason: task.targetSyncDeferredReason,
        lastErrorKind: task.lastErrorKind,
        lastErrorClass: task.lastErrorClass,
        transientRetryCount: task.transientRetryCount,
        autoRecovery,
        delivery,
        coordination,
        transientRetry,
      };
    });

    console.log(JSON.stringify({ tasks: output }));

  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    }));
    process.exit(1);
  }
}
