import { createHash } from 'crypto';
import { Task } from '../types/task';
import { appendTaskEvent } from './events';
import { deriveBaselineRepairGroupKey } from './baseline-quality-gate';
import { isDedicatedBaselineRepairTask } from './baseline-repair';
import { buildTaskRepairContext } from './repair-context';
import { StateManager } from './state';

export interface BaselineRepairGraphNode {
  taskId: string;
  isRepairTask: boolean;
  repairKey?: string;
  repairGroupKey?: string;
  repairTaskId?: string;
  status: Task['status'];
}

export interface BaselineRepairEdge {
  fromTaskId: string;
  toTaskId: string;
  reason: 'waiting_for_repair' | 'repair_task_failed_on_repair';
}

export interface BaselineRepairGraph {
  nodes: BaselineRepairGraphNode[];
  edges: BaselineRepairEdge[];
}

export interface BaselineRepairScc {
  id: string;
  taskIds: string[];
  repairGroupKeys: string[];
  repairKeys: string[];
  sameGroup: boolean;
  hasSelfWait: boolean;
}

export interface BaselineRepairCoalesceResult {
  collapsed: number;
  cycles: BaselineRepairScc[];
  canonicalTaskIds: string[];
  supersededTaskIds: string[];
}

function unique(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value)))).sort();
}

function isBaselineRepairTask(task: Task): boolean {
  return isDedicatedBaselineRepairTask(task);
}

function isSupersededBaselineRepairTask(task: Task): boolean {
  return task.baselineRepair?.status === 'superseded'
    || Boolean(task.baselineRepair?.supersededByRepairTaskId);
}

function resolveRepairGroupKey(task: Task): string | undefined {
  const explicitGroupKey = task.baselineRepair?.repairGroupKey
    ?? task.baselineQualityGate?.repairGroupKey;
  if (explicitGroupKey) {
    return explicitGroupKey;
  }

  const targetBranch = task.baselineRepair?.targetBranch
    ?? task.baselineQualityGate?.targetBranch;
  const packageLabel = task.baselineRepair?.packageLabel
    ?? task.baselineQualityGate?.packageLabel;
  if (targetBranch && packageLabel) {
    return deriveBaselineRepairGroupKey({ targetBranch, packageLabel });
  }

  return undefined;
}

function resolveRepairKey(task: Task): string | undefined {
  return task.baselineRepair?.repairKey
    ?? task.baselineQualityGate?.repairKey;
}

function cycleId(taskIds: string[]): string {
  return `baseline-repair-cycle:${createHash('sha256').update(taskIds.slice().sort().join('|')).digest('hex').slice(0, 12)}`;
}

function groupId(repairGroupKey: string, taskIds: string[]): string {
  return `baseline-repair-group:${createHash('sha256').update(`${repairGroupKey}|${taskIds.slice().sort().join('|')}`).digest('hex').slice(0, 12)}`;
}

export function buildBaselineRepairGraph(tasks: Task[]): BaselineRepairGraph {
  const taskIds = new Set(tasks.map((task) => task.id));
  const nodes = tasks
    .filter((task) => (
      !isSupersededBaselineRepairTask(task)
      && (
        isBaselineRepairTask(task)
        || Boolean(task.baselineQualityGate?.repairTaskId)
      )
    ))
    .map((task) => ({
      taskId: task.id,
      isRepairTask: isBaselineRepairTask(task),
      repairKey: resolveRepairKey(task),
      repairGroupKey: resolveRepairGroupKey(task),
      repairTaskId: task.baselineQualityGate?.repairTaskId,
      status: task.status,
    }));
  const nodeIds = new Set(nodes.map((node) => node.taskId));
  const edges: BaselineRepairEdge[] = [];

  for (const task of tasks) {
    if (isSupersededBaselineRepairTask(task)) {
      continue;
    }

    const repairTaskId = task.baselineQualityGate?.repairTaskId;
    if (!repairTaskId || !taskIds.has(repairTaskId) || !nodeIds.has(task.id)) {
      continue;
    }

    edges.push({
      fromTaskId: task.id,
      toTaskId: repairTaskId,
      reason: isBaselineRepairTask(task) ? 'repair_task_failed_on_repair' : 'waiting_for_repair',
    });
  }

  return { nodes, edges };
}

export function findBaselineRepairSccs(graph: BaselineRepairGraph): BaselineRepairScc[] {
  const adjacency = new Map<string, string[]>();
  const nodesById = new Map(graph.nodes.map((node) => [node.taskId, node]));

  for (const node of graph.nodes) {
    adjacency.set(node.taskId, []);
  }

  for (const edge of graph.edges) {
    adjacency.get(edge.fromTaskId)?.push(edge.toTaskId);
  }

  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const components: string[][] = [];

  function strongConnect(taskId: string): void {
    indices.set(taskId, index);
    lowlinks.set(taskId, index);
    index += 1;
    stack.push(taskId);
    onStack.add(taskId);

    for (const nextTaskId of adjacency.get(taskId) ?? []) {
      if (!indices.has(nextTaskId)) {
        strongConnect(nextTaskId);
        lowlinks.set(taskId, Math.min(lowlinks.get(taskId) ?? 0, lowlinks.get(nextTaskId) ?? 0));
      } else if (onStack.has(nextTaskId)) {
        lowlinks.set(taskId, Math.min(lowlinks.get(taskId) ?? 0, indices.get(nextTaskId) ?? 0));
      }
    }

    if (lowlinks.get(taskId) !== indices.get(taskId)) {
      return;
    }

    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop();
      if (!member) {
        break;
      }
      onStack.delete(member);
      component.push(member);
      if (member === taskId) {
        break;
      }
    }
    components.push(component.sort());
  }

  for (const node of graph.nodes) {
    if (!indices.has(node.taskId)) {
      strongConnect(node.taskId);
    }
  }

  return components
    .map((taskIds) => {
      const hasSelfWait = graph.edges.some((edge) => (
        edge.fromTaskId === edge.toTaskId
        && taskIds.includes(edge.fromTaskId)
      ));
      const isCycle = taskIds.length > 1 || hasSelfWait;
      if (!isCycle) {
        return undefined;
      }

      const repairGroupKeys = unique(taskIds.map((taskId) => nodesById.get(taskId)?.repairGroupKey));
      const repairKeys = unique(taskIds.map((taskId) => nodesById.get(taskId)?.repairKey));
      return {
        id: cycleId(taskIds),
        taskIds,
        repairGroupKeys,
        repairKeys,
        sameGroup: repairGroupKeys.length === 1,
        hasSelfWait,
      };
    })
    .filter((scc): scc is BaselineRepairScc => Boolean(scc));
}

export function selectCanonicalBaselineRepairTask(
  scc: BaselineRepairScc,
  tasksById: Map<string, Task>,
): Task {
  const candidates = scc.taskIds
    .map((taskId) => tasksById.get(taskId))
    .filter((task): task is Task => Boolean(task))
    .filter(isBaselineRepairTask)
    .filter((task) => !isSupersededBaselineRepairTask(task));

  if (candidates.length === 0) {
    throw new Error(`baseline repair SCC ${scc.id} has no repair task candidate`);
  }

  const statusRank: Record<Task['status'], number> = {
    completed: 6,
    ready_to_finalize: 5,
    finalizing: 4,
    running: 3,
    pending: 2,
    failed_finalize: 1,
    stagnant: 0,
    failed: 0,
  };

  return candidates.sort((left, right) => {
    const leftRank = statusRank[left.status] ?? 0;
    const rightRank = statusRank[right.status] ?? 0;
    if (leftRank !== rightRank) {
      return rightRank - leftRank;
    }

    const leftDemand = left.baselineRepair?.demandTaskIds?.length ?? 0;
    const rightDemand = right.baselineRepair?.demandTaskIds?.length ?? 0;
    if (leftDemand !== rightDemand) {
      return rightDemand - leftDemand;
    }

    const leftFiles = left.lastFilesChanged ?? 0;
    const rightFiles = right.lastFilesChanged ?? 0;
    if (leftFiles !== rightFiles) {
      return rightFiles - leftFiles;
    }

    const leftUpdatedAt = left.updatedAt ?? left.startTime;
    const rightUpdatedAt = right.updatedAt ?? right.startTime;
    if (leftUpdatedAt !== rightUpdatedAt) {
      return rightUpdatedAt - leftUpdatedAt;
    }

    return left.id.localeCompare(right.id);
  })[0];
}

function resetCanonicalRepairStory(task: Task, message: string, updatedAt: number): {
  completedUS: string[];
  currentUS: undefined;
  storyProgress: Task['storyProgress'];
  repairContext?: Task['repairContext'];
} {
  const storyId = task.currentUS
    ?? task.completedUS[task.completedUS.length - 1]
    ?? task.storyProgress?.[task.storyProgress.length - 1]?.id;

  if (!storyId) {
    return {
      completedUS: task.completedUS,
      currentUS: undefined,
      storyProgress: task.storyProgress,
      repairContext: undefined,
    };
  }

  return {
    completedUS: task.completedUS.filter((candidate) => candidate !== storyId),
    currentUS: undefined,
    storyProgress: (task.storyProgress || []).map((story) => story.id === storyId
      ? {
          ...story,
          status: 'needs_repair' as const,
          attempts: 0,
          lastError: message,
          updatedAt,
          history: [
            ...(story.history || []),
            {
              attempt: story.attempts,
              status: 'needs_repair' as const,
              message,
              updatedAt,
            },
          ],
        }
      : story),
    repairContext: buildTaskRepairContext({
      mode: 'finalize',
      storyId,
      reason: message,
      createdAt: updatedAt,
    }),
  };
}

export async function coalesceBaselineRepairGraph(input: {
  tasks: Task[];
  stateManager: StateManager;
  now?: () => number;
  logger?: Pick<typeof console, 'log' | 'error'>;
}): Promise<BaselineRepairCoalesceResult> {
  const now = input.now?.() ?? Date.now();

  for (const task of input.tasks) {
    if (!isSupersededBaselineRepairTask(task)) {
      continue;
    }

    if (!isBaselineRepairTask(task)) {
      const canonicalRepairTaskId = task.baselineRepair?.supersededByRepairTaskId;
      const message = canonicalRepairTaskId
        ? `Migrated product task back to baseline repair demand; waiting for canonical repair task ${canonicalRepairTaskId}`
        : 'Migrated product task back to baseline repair demand';

      await input.stateManager.updateTask(task.id, {
        status: (
          task.status === 'running'
          || task.status === 'finalizing'
          || task.status === 'completed'
        )
          ? task.status
          : 'failed_finalize',
        endTime: (
          task.status === 'running'
          || task.status === 'finalizing'
          || task.status === 'completed'
        )
          ? task.endTime
          : undefined,
        pid: (
          task.status === 'running'
          || task.status === 'finalizing'
        )
          ? task.pid
          : undefined,
        leaseOwner: (
          task.status === 'running'
          || task.status === 'finalizing'
        )
          ? task.leaseOwner
          : undefined,
        leaseHeartbeatAt: (
          task.status === 'running'
          || task.status === 'finalizing'
        )
          ? task.leaseHeartbeatAt
          : undefined,
        leaseExpiresAt: (
          task.status === 'running'
          || task.status === 'finalizing'
        )
          ? task.leaseExpiresAt
          : undefined,
        lastErrorKind: task.lastErrorKind === 'baseline_repair_superseded'
          ? 'quality_gate_failure'
          : task.lastErrorKind,
        lastError: task.lastErrorKind === 'baseline_repair_superseded'
          ? undefined
          : task.lastError,
        autoRecoveryKind: 'baseline_repair',
        autoRecoveryStoppedAt: undefined,
        autoRecoveryStopReason: undefined,
        autoRecoveryLastReason: message,
        baselineRepairRole: 'demand_task',
        baselineQualityGate: task.baselineQualityGate
          ? {
              ...task.baselineQualityGate,
              repairTaskId: canonicalRepairTaskId ?? task.baselineQualityGate.repairTaskId,
              phase: 'waiting_for_baseline_repair',
              lastUpdatedAt: now,
              stoppedAt: undefined,
              stopReason: undefined,
            }
          : undefined,
        baselineRepair: task.baselineRepair
          ? {
              ...task.baselineRepair,
              repairTaskId: canonicalRepairTaskId ?? task.baselineRepair.repairTaskId,
              status: 'waiting',
              updatedAt: now,
              message,
            }
          : undefined,
      });
      appendTaskEvent(task, {
        type: 'baseline_repair_product_role_migrated',
        status: 'failed_finalize',
        message,
        data: {
          canonicalRepairTaskId,
        },
      });
      continue;
    }

    if (
      task.status === 'pending'
      || task.status === 'ready_to_finalize'
      || task.status === 'failed_finalize'
      || task.status === 'stagnant'
    ) {
      await input.stateManager.updateTask(task.id, {
        status: 'failed',
        endTime: task.endTime ?? now,
        pid: undefined,
        leaseOwner: undefined,
        leaseHeartbeatAt: undefined,
        leaseExpiresAt: undefined,
        currentUS: undefined,
        lastErrorKind: 'baseline_repair_superseded',
        lastError: task.baselineRepair?.message
          ?? `Superseded by canonical baseline repair task ${task.baselineRepair?.supersededByRepairTaskId}`,
        autoRecoveryKind: undefined,
        autoRecoveryStoppedAt: task.autoRecoveryStoppedAt ?? now,
        autoRecoveryStopReason: 'baseline_repair_superseded',
      });
    }
  }

  const graph = buildBaselineRepairGraph(input.tasks);
  const sccs = findBaselineRepairSccs(graph).filter((scc) => scc.sameGroup);
  const repairTasksByGroup = new Map<string, Task[]>();

  for (const task of input.tasks) {
    if (!isBaselineRepairTask(task) || isSupersededBaselineRepairTask(task)) {
      continue;
    }

    const repairGroupKey = resolveRepairGroupKey(task);
    if (!repairGroupKey) {
      continue;
    }

    repairTasksByGroup.set(repairGroupKey, [
      ...(repairTasksByGroup.get(repairGroupKey) ?? []),
      task,
    ]);
  }

  const groupComponents: BaselineRepairScc[] = Array.from(repairTasksByGroup.entries())
    .filter(([, tasks]) => tasks.length > 1)
    .map(([repairGroupKey, tasks]) => {
      const taskIds = tasks.map((task) => task.id).sort();
      return {
        id: groupId(repairGroupKey, taskIds),
        taskIds,
        repairGroupKeys: [repairGroupKey],
        repairKeys: unique(tasks.flatMap((task) => [
          task.baselineRepair?.repairKey,
          ...(task.baselineRepair?.repairKeyAliases ?? []),
          task.baselineQualityGate?.repairKey,
        ])),
        sameGroup: true,
        hasSelfWait: false,
      };
    });
  const groupedTaskIds = new Set(groupComponents.flatMap((component) => component.taskIds));
  const components = [
    ...groupComponents,
    ...sccs.filter((scc) => !scc.taskIds.some((taskId) => groupedTaskIds.has(taskId))),
  ];
  const tasksById = new Map(input.tasks.map((task) => [task.id, task]));
  const canonicalTaskIds: string[] = [];
  const supersededTaskIds: string[] = [];

  for (const scc of components) {
    const canonical = selectCanonicalBaselineRepairTask(scc, tasksById);
    const canonicalId = canonical.id;
    const supersededIds = scc.taskIds.filter((taskId) => taskId !== canonicalId);
    const members = scc.taskIds
      .map((taskId) => tasksById.get(taskId))
      .filter((task): task is Task => Boolean(task));
    const demandTaskIds = unique(members.flatMap((task) => task.baselineRepair?.demandTaskIds ?? [task.id]));
    const repairKeyAliases = unique(members.flatMap((task) => [
      task.baselineRepair?.repairKey,
      ...(task.baselineRepair?.repairKeyAliases ?? []),
      task.baselineQualityGate?.repairKey,
    ]));
    const repairGroupKey = scc.repairGroupKeys[0] ?? canonical.baselineRepair?.repairGroupKey;
    const message = `Coalesced baseline repair cycle ${scc.id}; continuing canonical repair ${canonicalId}`;
    const shouldRequeueCanonical = ![
      'running',
      'ready_to_finalize',
      'finalizing',
      'completed',
    ].includes(canonical.status);
    const reset = shouldRequeueCanonical
      ? resetCanonicalRepairStory(canonical, message, now)
      : undefined;

    await input.stateManager.updateTask(canonicalId, {
      ...(shouldRequeueCanonical
        ? {
            status: 'pending' as const,
            endTime: undefined,
            pid: undefined,
            leaseOwner: undefined,
            leaseHeartbeatAt: undefined,
            leaseExpiresAt: undefined,
            currentUS: reset?.currentUS,
            completedUS: reset?.completedUS,
            storyProgress: reset?.storyProgress,
            repairContext: reset?.repairContext,
          }
        : {}),
      autoRecoveryKind: 'baseline_repair',
      autoRecoveryStoppedAt: undefined,
      autoRecoveryStopReason: undefined,
      autoRecoveryLastReason: message,
      finalizeRepairStoppedAt: undefined,
      finalizeRepairStopReason: undefined,
      baselineQualityGate: canonical.baselineQualityGate
        ? {
            ...canonical.baselineQualityGate,
            repairTaskId: canonical.baselineQualityGate.repairTaskId === canonicalId
              || supersededIds.includes(canonical.baselineQualityGate.repairTaskId ?? '')
              ? undefined
              : canonical.baselineQualityGate.repairTaskId,
            repairGroupKey,
            cycleId: scc.id,
            cycleTaskIds: scc.taskIds,
            lastUpdatedAt: now,
            phase: 'classified',
            stoppedAt: undefined,
            stopReason: undefined,
          }
        : undefined,
      baselineRepair: canonical.baselineRepair
        ? {
            ...canonical.baselineRepair,
            repairGroupKey,
            repairKeyAliases,
            coalescedFromRepairTaskIds: unique([
              ...(canonical.baselineRepair.coalescedFromRepairTaskIds ?? []),
              ...supersededIds,
            ]),
            cycleId: scc.id,
            cycleTaskIds: scc.taskIds,
            demandTaskIds,
            repairTaskId: canonicalId,
            updatedAt: now,
            status: 'needs_more_repair',
            message,
          }
        : undefined,
    });
    canonicalTaskIds.push(canonicalId);

    for (const taskId of supersededIds) {
      const task = tasksById.get(taskId);
      if (!task) {
        continue;
      }

      await input.stateManager.updateTask(taskId, {
        status: (
          task.status === 'running'
          || task.status === 'finalizing'
          || task.status === 'completed'
        )
          ? task.status
          : 'failed',
        endTime: (
          task.status === 'running'
          || task.status === 'finalizing'
          || task.status === 'completed'
        )
          ? task.endTime
          : task.endTime ?? now,
        pid: (
          task.status === 'running'
          || task.status === 'finalizing'
        )
          ? task.pid
          : undefined,
        leaseOwner: (
          task.status === 'running'
          || task.status === 'finalizing'
        )
          ? task.leaseOwner
          : undefined,
        leaseHeartbeatAt: (
          task.status === 'running'
          || task.status === 'finalizing'
        )
          ? task.leaseHeartbeatAt
          : undefined,
        leaseExpiresAt: (
          task.status === 'running'
          || task.status === 'finalizing'
        )
          ? task.leaseExpiresAt
          : undefined,
        lastErrorKind: 'baseline_repair_superseded',
        lastError: `Superseded by canonical baseline repair task ${canonicalId}`,
        autoRecoveryKind: undefined,
        autoRecoveryStoppedAt: now,
        autoRecoveryStopReason: 'baseline_repair_superseded',
        autoRecoveryLastReason: `Superseded by canonical baseline repair task ${canonicalId}`,
        baselineQualityGate: task.baselineQualityGate
          ? {
              ...task.baselineQualityGate,
              repairTaskId: canonicalId,
              repairGroupKey,
              cycleId: scc.id,
              cycleTaskIds: scc.taskIds,
              supersededByRepairTaskId: canonicalId,
              lastUpdatedAt: now,
            }
          : undefined,
        baselineRepair: task.baselineRepair
          ? {
              ...task.baselineRepair,
              repairGroupKey,
              repairKeyAliases: unique([
                task.baselineRepair.repairKey,
                ...(task.baselineRepair.repairKeyAliases ?? []),
              ]),
              coalescedFromRepairTaskIds: unique([
                ...(task.baselineRepair.coalescedFromRepairTaskIds ?? []),
                taskId,
              ]),
              cycleId: scc.id,
              cycleTaskIds: scc.taskIds,
              supersededByRepairTaskId: canonicalId,
              supersededAt: now,
              supersessionReason: `Coalesced into canonical baseline repair task ${canonicalId}`,
              updatedAt: now,
              status: 'superseded',
              message: `Superseded by canonical baseline repair task ${canonicalId}`,
            }
          : undefined,
      });
      supersededTaskIds.push(taskId);
    }

    for (const task of input.tasks) {
      if (scc.taskIds.includes(task.id)) {
        continue;
      }

      let changed = false;
      const updates: Partial<Task> = {};
      if (task.baselineQualityGate?.repairTaskId && supersededIds.includes(task.baselineQualityGate.repairTaskId)) {
        updates.baselineQualityGate = {
          ...task.baselineQualityGate,
          repairTaskId: canonicalId,
          repairGroupKey: task.baselineQualityGate.repairGroupKey ?? repairGroupKey,
          cycleId: scc.id,
          cycleTaskIds: scc.taskIds,
          lastUpdatedAt: now,
        };
        changed = true;
      }

      if (task.baselineRepair?.repairTaskId && supersededIds.includes(task.baselineRepair.repairTaskId)) {
        updates.baselineRepair = {
          ...task.baselineRepair,
          repairTaskId: canonicalId,
          repairGroupKey: task.baselineRepair.repairGroupKey ?? repairGroupKey,
          updatedAt: now,
          message: `Waiting for coalesced baseline repair task ${canonicalId}`,
        };
        changed = true;
      }

      if (changed) {
        await input.stateManager.updateTask(task.id, updates);
      }
    }

    appendTaskEvent(canonical, {
      type: 'baseline_repair_cycle_coalesced',
      status: 'pending',
      message,
      data: {
        cycleId: scc.id,
        repairGroupKey,
        canonicalTaskId: canonicalId,
        supersededTaskIds: supersededIds,
        demandTaskIds,
        repairKeyAliases,
      },
    });
    input.logger?.log(message);
  }

  return {
    collapsed: components.length,
    cycles: components,
    canonicalTaskIds,
    supersededTaskIds,
  };
}
