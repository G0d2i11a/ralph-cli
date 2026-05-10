import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager, DirtyWorktreeReclamationMode } from '../config/manager';
import { Task, TaskErrorClass, TaskStatus } from '../types/task';
import { appendTaskEvent } from './events';
import { withDirectoryLock } from './locks';
import { getRalphPaths, RalphHomeOptions, resolveRalphHome } from './paths';
import { EvidenceArchiveResult, WorktreeEvidenceArchiver } from './reclamation-evidence';
import {
  ReclamationAttentionState,
  ReclamationDecision,
  ReclamationDecisionAction,
  ReclamationSafetyGate,
} from './reclamation-policy';
import { StateManager } from './state';
import { resolveTaskIntegrationStatus, resolveTaskTargetSyncStatus } from './task-delivery';
import { WorktreeInspection, WorktreeManager } from './worktree';

export type ReclamationMode =
  | 'manager_startup'
  | 'manager_periodic'
  | 'disk_pressure'
  | 'watchdog'
  | 'manual';

export interface ReclamationRunOptions {
  mode?: ReclamationMode;
  dryRun?: boolean;
  repoPath?: string;
  includeWorktrees?: boolean;
  includeOrphanWorktrees?: boolean;
  maxDurationMs?: number;
  olderThanHours?: number;
  maxRemovals?: number;
  lockTimeoutMs?: number;
  dirtyTerminalModeOverride?: DirtyWorktreeReclamationMode;
  dirtyOrphanModeOverride?: DirtyWorktreeReclamationMode;
  includeDirtyOrphanWorktrees?: boolean;
  abandonRetryable?: boolean;
}

export interface ReclamationSectionReport {
  scanned: number;
  candidates: number;
  removed: number;
  archived: number;
  skipped: number;
}

export interface ReclamationCandidateReport {
  kind: 'task_worktree' | 'orphan_worktree';
  taskId?: string;
  status?: TaskStatus | 'orphan';
  repoPath: string;
  worktree: string;
  existed: boolean;
  removed: boolean;
  wouldRemove: boolean;
  ageHours?: number;
  retentionHours?: number;
  tier: string;
  reason?: string;
  dirty?: boolean;
  attentionState?: ReclamationAttentionState;
  decisionAction?: ReclamationDecisionAction;
  evidencePath?: string;
  evidenceManifestPath?: string;
  evidenceComplete?: boolean;
  evidenceBytes?: number;
  dirtySummary?: {
    changedFileCount?: number;
    untrackedFileCount?: number;
    hasStagedChanges?: boolean;
    hasUnstagedChanges?: boolean;
    hasUntrackedFiles?: boolean;
    hasUnmergedPaths?: boolean;
    hasSubmoduleChanges?: boolean;
  };
  safetyGates?: ReclamationSafetyGate[];
  registeredGitWorktree?: boolean;
  pathInsideRalphWorktrees?: boolean;
}

export interface ReclamationReport {
  ok: boolean;
  dryRun: boolean;
  mode: ReclamationMode;
  ralphHome: string;
  startedAt: string;
  finishedAt?: string;
  olderThanHours?: number;
  removed: number;
  worktrees: ReclamationSectionReport;
  tempDirs: ReclamationSectionReport;
  candidates: ReclamationCandidateReport[];
  skipped: ReclamationCandidateReport[];
  errors: Array<{
    kind: string;
    path?: string;
    taskId?: string;
    message: string;
  }>;
  reportPath?: string;
}

interface ReclamationServiceDeps extends RalphHomeOptions {
  stateManager?: StateManager;
  configManager?: Pick<ConfigManager, 'get'>;
  worktreeManager?: WorktreeManager;
  evidenceArchiver?: WorktreeEvidenceArchiver;
  now?: () => number;
}

interface WorktreeCandidate {
  kind: 'task_worktree' | 'orphan_worktree';
  task?: Task;
  taskId?: string;
  status?: TaskStatus | 'orphan';
  repoPath: string;
  worktree: string;
  finishedAt?: number;
  ageHours?: number;
  retentionHours?: number;
  tier: string;
  reason?: string;
  reclaimable: boolean;
  existed: boolean;
  inspection?: WorktreeInspection;
  evidence?: EvidenceArchiveResult;
}

const TERMINAL_STATUSES = new Set<TaskStatus>([
  'completed',
  'failed',
  'failed_finalize',
  'stagnant',
]);

const RETRY_ATTENTION_ERROR_CLASSES = new Set<TaskErrorClass>([
  'transport',
  'transient_backend',
  'agent_session',
  'browser_automation',
  'orphaned_worker',
  'stagnation',
]);

function getNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function getBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function isPidRunning(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseLeaseOwnerPid(leaseOwner: string | undefined): number | undefined {
  const match = /:(\d+)$/.exec(leaseOwner || '');
  if (!match) {
    return undefined;
  }

  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function getTaskFinishedAt(task: Task): number {
  return task.endTime ?? task.updatedAt ?? task.startTime;
}

function sortByFinishedAtDesc(a: WorktreeCandidate, b: WorktreeCandidate): number {
  return (b.finishedAt ?? 0) - (a.finishedAt ?? 0);
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

export class ReclamationService {
  private readonly ralphHome: string;
  private readonly stateManager: StateManager;
  private readonly configManager: Pick<ConfigManager, 'get'>;
  private readonly worktreeManager: WorktreeManager;
  private readonly evidenceArchiver: WorktreeEvidenceArchiver;
  private readonly now: () => number;

  constructor(deps: ReclamationServiceDeps = {}) {
    this.ralphHome = deps.stateManager?.getRalphHome?.() ?? resolveRalphHome(deps);
    this.stateManager = deps.stateManager ?? new StateManager({ ralphHome: this.ralphHome });
    this.configManager = deps.configManager ?? new ConfigManager({ ralphHome: this.ralphHome });
    this.worktreeManager = deps.worktreeManager ?? new WorktreeManager();
    this.now = deps.now ?? (() => Date.now());
    this.evidenceArchiver = deps.evidenceArchiver ?? new WorktreeEvidenceArchiver({
      ralphHome: this.ralphHome,
      configManager: this.configManager,
      worktreeManager: this.worktreeManager,
      now: this.now,
    });
  }

  isAutomaticReclamationEnabled(): boolean {
    if (process.env.RALPH_DISABLE_AUTO_RECLAMATION === '1') {
      return false;
    }

    return getBoolean(this.configManager.get('reclamation.enabled'), false)
      && getBoolean(this.configManager.get('reclamation.worktrees.enabled'), false);
  }

  getIntervalMs(): number {
    return Math.max(1, getNumber(this.configManager.get('reclamation.intervalSeconds'), 900)) * 1000;
  }

  getStartupDelayMs(): number {
    return Math.max(0, getNumber(this.configManager.get('reclamation.startupDelaySeconds'), 30)) * 1000;
  }

  async run(options: ReclamationRunOptions = {}): Promise<ReclamationReport> {
    const mode = options.mode ?? 'manual';
    const dryRun = Boolean(options.dryRun);
    const startedAtMs = this.now();
    const report: ReclamationReport = {
      ok: true,
      dryRun,
      mode,
      ralphHome: this.ralphHome,
      startedAt: new Date(startedAtMs).toISOString(),
      olderThanHours: options.olderThanHours,
      removed: 0,
      worktrees: { scanned: 0, candidates: 0, removed: 0, archived: 0, skipped: 0 },
      tempDirs: { scanned: 0, candidates: 0, removed: 0, archived: 0, skipped: 0 },
      candidates: [],
      skipped: [],
      errors: [],
    };
    const shouldWriteReport = !(dryRun && mode === 'manual');

    if (shouldWriteReport && getBoolean(this.configManager.get('reclamation.reporting.writeLastRun'), true)) {
      report.reportPath = path.join(this.ralphHome, 'reclamation', 'last-run.json');
    }

    try {
      await withDirectoryLock(
        path.join(this.ralphHome, 'reclamation.lock'),
        async () => {
          if (options.includeWorktrees !== false) {
            await this.reclaimWorktrees(report, options, startedAtMs);
          }

          report.finishedAt = new Date(this.now()).toISOString();
          this.writeReport(report, !shouldWriteReport);
        },
        {
          timeoutMs: options.lockTimeoutMs ?? 5000,
          staleMs: 5 * 60 * 1000,
        },
      );
    } catch (error) {
      report.ok = false;
      report.finishedAt = new Date(this.now()).toISOString();
      report.errors.push({
        kind: 'reclamation_run_error',
        message: error instanceof Error ? error.message : String(error),
      });
    }

    return report;
  }

  private async reclaimWorktrees(
    report: ReclamationReport,
    options: ReclamationRunOptions,
    startedAtMs: number,
  ): Promise<void> {
    const tasks = await this.stateManager.listTasks();
    const taskCandidates = await this.collectTaskWorktreeCandidates(tasks, options);
    const shouldIncludeOrphans = options.includeOrphanWorktrees
      ?? (options.mode !== 'manual' && this.shouldCleanupOrphans());
    const orphanCandidates = shouldIncludeOrphans
      ? await this.collectOrphanWorktreeCandidates(tasks, options)
      : [];
    const candidates = [...taskCandidates, ...orphanCandidates];
    const maxRunMs = options.maxDurationMs ?? Math.max(1, getNumber(this.configManager.get('reclamation.maxRunSeconds'), 30)) * 1000;
    const maxRemovals = options.maxRemovals
      ?? (options.mode === 'manual'
        ? Number.POSITIVE_INFINITY
        : Math.max(1, getNumber(this.configManager.get('reclamation.worktrees.maxRemovalsPerRun'), 25)));

    report.worktrees.scanned = tasks.length + orphanCandidates.length;

    for (const candidate of candidates) {
      if (this.now() - startedAtMs > maxRunMs) {
        report.errors.push({
          kind: 'reclamation_deadline_exceeded',
          message: `Stopped after ${maxRunMs}ms reclamation budget`,
        });
        break;
      }

      if (report.worktrees.removed >= maxRemovals) {
        report.errors.push({
          kind: 'reclamation_removal_limit_reached',
          message: `Stopped after ${maxRemovals} worktree removal(s)`,
        });
        break;
      }

      await this.processWorktreeCandidate(candidate, report, options);
    }

    if (!options.dryRun && getBoolean(this.configManager.get('reclamation.worktrees.pruneGitWorktreeMetadata'), true)) {
      for (const repoPath of new Set(candidates.map((candidate) => candidate.repoPath))) {
        await this.worktreeManager.pruneWorktreeMetadata(repoPath);
      }
    }
  }

  private async collectTaskWorktreeCandidates(
    tasks: Task[],
    options: ReclamationRunOptions,
  ): Promise<WorktreeCandidate[]> {
    const now = this.now();
    const groupedByRepo = new Map<string, WorktreeCandidate[]>();
    const candidates: WorktreeCandidate[] = [];

    for (const task of tasks) {
      if (!TERMINAL_STATUSES.has(task.status) || !task.worktree) {
        continue;
      }

      const finishedAt = getTaskFinishedAt(task);
      const ageHours = Math.max(0, (now - finishedAt) / (60 * 60 * 1000));
      const inspection = await this.worktreeManager.inspectWorktree(task.repoPath, task.worktree);
      const retentionHours = this.getTaskRetentionHours(task, options, inspection);
      const candidate: WorktreeCandidate = {
        kind: 'task_worktree',
        task,
        taskId: task.id,
        status: task.status,
        repoPath: task.repoPath,
        worktree: task.worktree,
        finishedAt,
        ageHours,
        retentionHours,
        tier: this.getTaskTier(task, options),
        reclaimable: ageHours >= retentionHours,
        existed: inspection.exists,
        inspection,
      };

      if (!candidate.reclaimable) {
        candidate.reason = `retained_until_${retentionHours}h`;
      }

      const repoCandidates = groupedByRepo.get(task.repoPath) ?? [];
      repoCandidates.push(candidate);
      groupedByRepo.set(task.repoPath, repoCandidates);
      candidates.push(candidate);
    }

    if (options.mode !== 'manual' && options.olderThanHours === undefined) {
      const keepNewestPerRepo = Math.max(0, getNumber(this.configManager.get('reclamation.worktrees.keepNewestPerRepo'), 5));

      for (const repoCandidates of groupedByRepo.values()) {
        for (const candidate of repoCandidates.slice().sort(sortByFinishedAtDesc).slice(0, keepNewestPerRepo)) {
          candidate.reclaimable = false;
          candidate.reason = 'keep_newest_per_repo';
        }
      }
    }

    return candidates.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  }

  private async collectOrphanWorktreeCandidates(
    tasks: Task[],
    options: ReclamationRunOptions,
  ): Promise<WorktreeCandidate[]> {
    const now = this.now();
    const referencedWorktrees = new Set(
      tasks
        .map((task) => task.worktree)
        .filter(Boolean)
        .map((worktree) => path.resolve(worktree)),
    );
    const repoPaths = new Set(
      tasks
        .map((task) => task.repoPath)
        .filter(Boolean)
        .map((repoPath) => path.resolve(repoPath)),
    );

    if (options.repoPath) {
      repoPaths.add(path.resolve(options.repoPath));
    }

    const candidates: WorktreeCandidate[] = [];
    const cleanRetentionHours = options.olderThanHours ?? getNumber(this.configManager.get('reclamation.worktrees.orphanRetentionHours'), 24);
    const dirtyRetentionHours = options.olderThanHours ?? getNumber(this.configManager.get('reclamation.worktrees.dirtyOrphanRetentionHours'), 720);

    for (const repoPath of repoPaths) {
      if (!fs.existsSync(path.join(repoPath, '.git'))) {
        continue;
      }

      const ralphWorktreesDir = path.join(repoPath, '.ralph-worktrees');
      const worktrees = await this.worktreeManager.listWorktrees(repoPath);

      for (const worktree of worktrees.map((entry) => path.resolve(entry))) {
        if (referencedWorktrees.has(worktree) || !isPathInside(ralphWorktreesDir, worktree)) {
          continue;
        }

        const inspection = await this.worktreeManager.inspectWorktree(repoPath, worktree);
        const statMs = inspection.exists ? fs.statSync(worktree).mtimeMs : now;
        const ageHours = Math.max(0, (now - statMs) / (60 * 60 * 1000));
        const retentionHours = inspection.dirty ? dirtyRetentionHours : cleanRetentionHours;
        candidates.push({
          kind: 'orphan_worktree',
          status: 'orphan',
          repoPath,
          worktree,
          finishedAt: statMs,
          ageHours,
          retentionHours,
          tier: inspection.dirty ? 'orphan_dirty_worktree' : 'orphan_clean_worktree',
          reclaimable: ageHours >= retentionHours,
          existed: inspection.exists,
          inspection,
          reason: inspection.dirty ? 'dirty_orphan_retained' : undefined,
        });
      }
    }

    return candidates.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  }

  private async processWorktreeCandidate(
    candidate: WorktreeCandidate,
    report: ReclamationReport,
    options: ReclamationRunOptions,
  ): Promise<void> {
    const result = this.toReportCandidate(candidate);
    report.worktrees.candidates++;

    const decision = this.decideWorktreeReclamation(candidate, options);
    result.attentionState = decision.attentionState;
    result.decisionAction = decision.action;
    result.reason = decision.reason;
    result.safetyGates = decision.safetyGates;

    if (decision.action === 'skip' || decision.action === 'retain') {
      report.skipped.push(result);
      report.worktrees.skipped++;
      return;
    }

    if (decision.action === 'archive_only' || decision.action === 'archive_then_reclaim') {
      const archiveLimit = Math.max(0, getNumber(this.configManager.get('reclamation.worktrees.maxDirtyArchivesPerRun'), 10));
      if (!options.dryRun && this.countDirtyArchived(report) >= archiveLimit) {
        result.reason = 'dirty_archive_limit_reached';
        report.skipped.push(result);
        report.worktrees.skipped++;
        return;
      }

      if (options.dryRun) {
        if (decision.action === 'archive_only') {
          result.reason = 'dirty_worktree_would_archive';
          report.skipped.push(result);
          report.worktrees.skipped++;
          return;
        }
      } else {
        const evidence = await this.evidenceArchiver.archive(candidate, decision, { mode: options.mode });
        candidate.evidence = evidence;
        result.evidencePath = evidence.dir;
        result.evidenceManifestPath = evidence.manifestPath;
        result.evidenceComplete = evidence.complete;
        result.evidenceBytes = evidence.bytes;

        if (!evidence.ok || !evidence.complete) {
          result.reason = evidence.error || 'evidence_archive_incomplete';
          report.skipped.push(result);
          report.worktrees.skipped++;
          report.errors.push({
            kind: 'worktree_evidence_archive_failed',
            path: candidate.worktree,
            taskId: candidate.taskId,
            message: result.reason,
          });
          return;
        }

        report.worktrees.archived++;

        if (decision.action === 'archive_only') {
          result.reason = this.getArchiveOnlyReason(decision);
          report.skipped.push(result);
          report.worktrees.skipped++;
          await this.recordTaskWorktreeArchived(candidate, evidence, report, decision);
          return;
        }
      }

      const dirtyRemovalLimit = Math.max(0, getNumber(this.configManager.get('reclamation.worktrees.maxDirtyRemovalsPerRun'), 5));
      if (!options.dryRun && this.countDirtyRemoved(report) >= dirtyRemovalLimit) {
        result.reason = 'dirty_removal_limit_reached';
        report.skipped.push(result);
        report.worktrees.skipped++;
        return;
      }
    }

    result.wouldRemove = true;
    report.candidates.push(result);

    if (options.dryRun || !candidate.existed) {
      return;
    }

    const removal = await this.worktreeManager.removeWorktreeSafe(candidate.repoPath, candidate.worktree, { force: true });
    if (!removal.removed) {
      result.reason = removal.error || 'remove_failed';
      report.errors.push({
        kind: 'worktree_remove_failed',
        path: candidate.worktree,
        taskId: candidate.taskId,
        message: removal.error || 'failed to remove worktree',
      });
      return;
    }

    result.removed = true;
    report.removed++;
    report.worktrees.removed++;
    await this.recordTaskWorktreeReclaimed(candidate, report);
  }

  private decideWorktreeReclamation(
    candidate: WorktreeCandidate,
    options: ReclamationRunOptions,
  ): ReclamationDecision {
    const skipReason = this.getSkipReason(candidate, options);
    if (skipReason) {
      return {
        attentionState: skipReason.includes('retry') ? 'retry' : 'retained',
        action: 'skip',
        reason: skipReason,
        safetyGates: [],
      };
    }

    if (!candidate.inspection?.dirty) {
      return {
        attentionState: 'reclamation',
        action: 'remove_clean',
        reason: candidate.tier,
        safetyGates: [],
      };
    }

    const mode = this.getDirtyReclamationMode(candidate, options);
    const attentionState = this.classifyWorktreeAttention(candidate, options);
    const safetyGates = this.getDirtySafetyGates(candidate, attentionState, options);

    if (mode === 'retain') {
      return {
        attentionState,
        action: 'retain',
        reason: candidate.kind === 'orphan_worktree' ? 'dirty_orphan_retained' : 'dirty_terminal_worktree_retained',
        safetyGates,
      };
    }

    if (mode === 'archive_only') {
      return {
        attentionState,
        action: 'archive_only',
        reason: 'dirty_worktree_archive_only',
        safetyGates,
      };
    }

    const failedGate = safetyGates.find((gate) => !gate.passed);
    if (failedGate) {
      return {
        attentionState,
        action: 'archive_only',
        reason: failedGate.reason || `${failedGate.name}_failed`,
        safetyGates,
      };
    }

    return {
      attentionState,
      action: 'archive_then_reclaim',
      reason: 'dirty_worktree_archive_then_reclaim',
      safetyGates,
    };
  }

  private getSkipReason(candidate: WorktreeCandidate, options: ReclamationRunOptions): string | undefined {
    if (!candidate.reclaimable) {
      return candidate.reason || 'retained_by_policy';
    }

    if (!candidate.existed) {
      return undefined;
    }

    if (!candidate.inspection?.pathInsideRalphWorktrees) {
      return 'path_outside_ralph_worktrees';
    }

    if (candidate.task && isPidRunning(candidate.task.pid)) {
      return 'task_pid_running';
    }

    const leasePid = candidate.task ? parseLeaseOwnerPid(candidate.task.leaseOwner) : undefined;
    if (leasePid && isPidRunning(leasePid)) {
      return 'task_lease_owner_running';
    }

    if (candidate.task?.leaseExpiresAt && candidate.task.leaseExpiresAt > this.now()) {
      return 'task_lease_fresh';
    }

    if (
      candidate.kind === 'orphan_worktree'
      && candidate.inspection?.dirty
      && this.getDirtyReclamationMode(candidate, options) === 'retain'
    ) {
      return 'dirty_orphan_retained';
    }

    if (
      candidate.task
      && candidate.inspection?.dirty
      && this.getDirtyReclamationMode(candidate, options) === 'retain'
    ) {
      return 'dirty_terminal_worktree_retained';
    }

    if (candidate.task?.status === 'completed' && options.mode !== 'manual' && options.olderThanHours === undefined) {
      const integrationStatus = resolveTaskIntegrationStatus(candidate.task);
      if (integrationStatus === 'failed' || integrationStatus === 'blocked_conflict') {
        return 'completed_integration_not_reclaimable';
      }
    }

    return undefined;
  }

  private getDirtyReclamationMode(
    candidate: WorktreeCandidate,
    options: ReclamationRunOptions,
  ): DirtyWorktreeReclamationMode {
    if (candidate.kind === 'orphan_worktree') {
      if (options.dirtyOrphanModeOverride) {
        return options.dirtyOrphanModeOverride;
      }

      if (options.mode === 'manual' && !options.includeDirtyOrphanWorktrees) {
        return 'retain';
      }

      return this.readDirtyMode('reclamation.worktrees.dirtyOrphanMode', 'retain');
    }

    if (options.dirtyTerminalModeOverride) {
      return options.dirtyTerminalModeOverride;
    }

    if (options.mode === 'manual') {
      return 'retain';
    }

    const configured = this.configManager.get('reclamation.worktrees.dirtyTerminalMode');
    if (configured === 'retain' || configured === 'archive_only' || configured === 'archive_then_reclaim') {
      return configured;
    }

    return getBoolean(this.configManager.get('reclamation.worktrees.removeDirtyFailedWorktrees'), false)
      ? 'archive_then_reclaim'
      : 'retain';
  }

  private readDirtyMode(key: string, fallback: DirtyWorktreeReclamationMode): DirtyWorktreeReclamationMode {
    const value = this.configManager.get(key);
    return value === 'retain' || value === 'archive_only' || value === 'archive_then_reclaim'
      ? value
      : fallback;
  }

  private classifyWorktreeAttention(
    candidate: WorktreeCandidate,
    options: ReclamationRunOptions,
  ): ReclamationAttentionState {
    if (!candidate.task) {
      return candidate.kind === 'orphan_worktree' ? 'manual_review' : 'reclamation';
    }

    if (this.isTargetSyncAttention(candidate.task)) {
      return 'target_sync';
    }

    if (!options.abandonRetryable && this.isRetryAttention(candidate.task)) {
      return 'retry';
    }

    if (this.isManualReviewAttention(candidate.task, candidate.inspection)) {
      return 'manual_review';
    }

    return 'reclamation';
  }

  private isRetryAttention(task: Task): boolean {
    if (task.lastErrorRetryable === true) {
      return true;
    }

    if (task.lastErrorClass && RETRY_ATTENTION_ERROR_CLASSES.has(task.lastErrorClass)) {
      return true;
    }

    if (
      task.autoRecoveryStoppedAt
      || task.transientRecoveryStoppedAt
      || task.agentContextRecoveryStoppedAt
      || task.failedBlockerRecoveryStoppedAt
      || task.storyRepairRecoveryStoppedAt
      || task.finalizeRepairStoppedAt
    ) {
      return true;
    }

    return false;
  }

  private isTargetSyncAttention(task: Task): boolean {
    if (task.status !== 'completed') {
      return false;
    }

    const targetSyncStatus = resolveTaskTargetSyncStatus(task);
    return targetSyncStatus === 'deferred_dirty_checkout' || targetSyncStatus === 'failed';
  }

  private isManualReviewAttention(task: Task, inspection?: WorktreeInspection): boolean {
    const integrationStatus = resolveTaskIntegrationStatus(task);
    return integrationStatus === 'failed'
      || integrationStatus === 'blocked_conflict'
      || Boolean(task.mergeConflictFiles?.length)
      || task.mergeRepairDisplayStatus === 'unresolved'
      || task.mergeRepairDisplayStatus === 'resolved_pending_finalize'
      || task.mergeRepairDisplayStatus === 'probe_mergeable'
      || task.mergeRepairProof?.worktreeMergeKind === 'unresolved'
      || task.postFinalizeMergeProbeRequired === true
      || inspection?.hasUnmergedPaths === true
      || Boolean(inspection?.statusError);
  }

  private getDirtySafetyGates(
    candidate: WorktreeCandidate,
    attentionState: ReclamationAttentionState,
    options: ReclamationRunOptions,
  ): ReclamationSafetyGate[] {
    const gates: ReclamationSafetyGate[] = [];
    const addGate = (name: string, passed: boolean, reason?: string) => {
      gates.push({ name, passed, reason: passed ? undefined : reason });
    };
    const inspection = candidate.inspection;

    addGate('terminal_status_allowed', candidate.kind === 'orphan_worktree' || Boolean(candidate.task && TERMINAL_STATUSES.has(candidate.task.status)), 'status_not_terminal');
    addGate('task_not_active', !candidate.task || (!isPidRunning(candidate.task.pid) && !(candidate.task.leaseExpiresAt && candidate.task.leaseExpiresAt > this.now())), 'task_active_or_leased');
    addGate('path_confined', Boolean(inspection?.pathInsideRalphWorktrees), 'path_outside_ralph_worktrees');

    if (
      candidate.task
      && getBoolean(this.configManager.get('reclamation.worktrees.skipDirtyIfBranchUnexpected'), true)
      && inspection?.branch
    ) {
      const expectedBranch = `refs/heads/ralph/${candidate.task.id}`;
      const expectedShortBranch = `ralph/${candidate.task.id}`;
      addGate(
        'expected_branch',
        inspection.branch === expectedBranch || inspection.branch === expectedShortBranch,
        'unexpected_dirty_worktree_branch',
      );
    }

    if (getBoolean(this.configManager.get('reclamation.evidence.skipStatusErrors'), true)) {
      addGate('status_readable', !inspection?.statusError, 'dirty_status_unreadable');
    }

    if (getBoolean(this.configManager.get('reclamation.evidence.skipUnmerged'), true)) {
      addGate('no_unmerged_paths', inspection?.hasUnmergedPaths !== true, 'dirty_unmerged_paths');
    }

    if (getBoolean(this.configManager.get('reclamation.evidence.skipSubmoduleChanges'), true)) {
      addGate('no_submodule_changes', inspection?.hasSubmoduleChanges !== true, 'dirty_submodule_changes');
    }

    if (getBoolean(this.configManager.get('reclamation.worktrees.skipDirtyIfRetryableFailure'), true)) {
      addGate('no_retry_attention', attentionState !== 'retry' || Boolean(options.abandonRetryable), 'dirty_retry_attention');
    }

    if (getBoolean(this.configManager.get('reclamation.worktrees.skipDirtyIfTargetSyncAttention'), true)) {
      addGate('no_target_sync_attention', attentionState !== 'target_sync', 'dirty_target_sync_attention');
    }

    if (getBoolean(this.configManager.get('reclamation.worktrees.skipDirtyIfIntegrationBlocked'), true)) {
      addGate('not_manual_review_attention', attentionState !== 'manual_review', 'dirty_manual_review_attention');
    }

    addGate('evidence_required', getBoolean(this.configManager.get('reclamation.evidence.requireForDirtyReclaim'), true), 'dirty_evidence_not_required_by_config');

    return gates;
  }

  private getArchiveOnlyReason(decision: ReclamationDecision): string {
    if (decision.attentionState === 'retry') {
      return 'dirty_worktree_archived_retry_attention';
    }

    if (decision.attentionState === 'target_sync') {
      return 'dirty_worktree_archived_target_sync_attention';
    }

    if (decision.attentionState === 'manual_review') {
      return 'dirty_worktree_archived_manual_review';
    }

    return 'dirty_worktree_archived_retained';
  }

  private countDirtyArchived(report: ReclamationReport): number {
    return report.skipped.filter((candidate) => candidate.dirty && candidate.evidenceComplete).length
      + report.candidates.filter((candidate) => candidate.dirty && candidate.evidenceComplete).length;
  }

  private countDirtyRemoved(report: ReclamationReport): number {
    return report.candidates.filter((candidate) => candidate.dirty && candidate.removed).length;
  }

  private async recordTaskWorktreeArchived(
    candidate: WorktreeCandidate,
    evidence: EvidenceArchiveResult,
    report: ReclamationReport,
    decision: ReclamationDecision,
  ): Promise<void> {
    if (!candidate.task) {
      return;
    }

    const archivedAt = this.now();

    try {
      await this.stateManager.updateTask(candidate.task.id, {
        worktreeReclaimEvidencePath: evidence.dir,
        worktreeReclaimEvidenceManifestPath: evidence.manifestPath,
        worktreeReclaimEvidenceCreatedAt: archivedAt,
        worktreeReclaimDecision: decision.action,
      });
    } catch {
      // Evidence is already on disk; state annotation is best effort.
    }

    if (getBoolean(this.configManager.get('reclamation.reporting.emitTaskEvents'), true)) {
      appendTaskEvent(candidate.task, {
        type: 'worktree_reclamation_evidence_archived',
        status: candidate.task.status,
        message: `Archived dirty ${candidate.task.status} task worktree evidence`,
        data: {
          path: candidate.worktree,
          mode: report.mode,
          tier: candidate.tier,
          attentionState: decision.attentionState,
          action: decision.action,
          evidencePath: evidence.dir,
          manifestPath: evidence.manifestPath,
          reportPath: report.reportPath,
        },
      });
    }
  }

  private async recordTaskWorktreeReclaimed(candidate: WorktreeCandidate, report: ReclamationReport): Promise<void> {
    if (!candidate.task) {
      return;
    }

    const reclaimedAt = this.now();
    const reportPath = report.reportPath;
    const reclaimedBy = report.mode === 'watchdog'
      ? 'watchdog'
      : report.mode === 'manual'
        ? 'manual'
        : 'manager';
    const reason = candidate.tier;

    try {
      await this.stateManager.updateTask(candidate.task.id, {
        worktreeReclaimedAt: reclaimedAt,
        worktreeReclaimedBy: reclaimedBy,
        worktreeReclaimReason: reason,
        worktreeReclaimReportPath: reportPath,
        worktreeReclaimEvidencePath: candidate.evidence?.dir,
        worktreeReclaimEvidenceManifestPath: candidate.evidence?.manifestPath,
        worktreeReclaimEvidenceCreatedAt: candidate.evidence ? reclaimedAt : undefined,
        worktreeReclaimDecision: candidate.evidence ? 'archive_then_reclaim' : 'remove_clean',
      });
    } catch {
      // The worktree has already been removed; state annotation is best effort.
    }

    if (getBoolean(this.configManager.get('reclamation.reporting.emitTaskEvents'), true)) {
      appendTaskEvent(candidate.task, {
        type: 'worktree_reclaimed',
        status: candidate.task.status,
        message: `Reclaimed ${candidate.task.status} task worktree`,
        data: {
          path: candidate.worktree,
          mode: report.mode,
          tier: candidate.tier,
          ageHours: candidate.ageHours,
          reportPath,
          evidencePath: candidate.evidence?.dir,
          evidenceManifestPath: candidate.evidence?.manifestPath,
        },
      });
    }
  }

  private toReportCandidate(candidate: WorktreeCandidate): ReclamationCandidateReport {
    return {
      kind: candidate.kind,
      taskId: candidate.taskId,
      status: candidate.status,
      repoPath: candidate.repoPath,
      worktree: candidate.worktree,
      existed: candidate.existed,
      removed: false,
      wouldRemove: false,
      ageHours: candidate.ageHours,
      retentionHours: candidate.retentionHours,
      tier: candidate.tier,
      reason: candidate.reason,
      dirty: candidate.inspection?.dirty,
      dirtySummary: candidate.inspection
        ? {
            changedFileCount: candidate.inspection.changedFileCount,
            untrackedFileCount: candidate.inspection.untrackedFileCount,
            hasStagedChanges: candidate.inspection.hasStagedChanges,
            hasUnstagedChanges: candidate.inspection.hasUnstagedChanges,
            hasUntrackedFiles: candidate.inspection.hasUntrackedFiles,
            hasUnmergedPaths: candidate.inspection.hasUnmergedPaths,
            hasSubmoduleChanges: candidate.inspection.hasSubmoduleChanges,
          }
        : undefined,
      registeredGitWorktree: candidate.inspection?.registered,
      pathInsideRalphWorktrees: candidate.inspection?.pathInsideRalphWorktrees,
    };
  }

  private getTaskRetentionHours(
    task: Task,
    options: ReclamationRunOptions,
    inspection?: WorktreeInspection,
  ): number {
    if (options.olderThanHours !== undefined) {
      return options.olderThanHours;
    }

    if (task.status === 'completed') {
      const targetSyncStatus = resolveTaskTargetSyncStatus(task);
      if (targetSyncStatus === 'deferred_dirty_checkout' || targetSyncStatus === 'failed') {
        return getNumber(this.configManager.get('reclamation.worktrees.targetSyncDeferredRetentionHours'), 72);
      }

      return getNumber(this.configManager.get('reclamation.worktrees.completedRetentionHours'), 24);
    }

    if (task.status === 'failed_finalize') {
      if (inspection?.dirty) {
        return getNumber(
          this.configManager.get('reclamation.worktrees.dirtyFailedFinalizeRetentionHours'),
          getNumber(this.configManager.get('reclamation.worktrees.dirtyFailedRetentionHours'), 336),
        );
      }

      return getNumber(this.configManager.get('reclamation.worktrees.failedFinalizeRetentionHours'), 168);
    }

    if (task.status === 'stagnant') {
      if (inspection?.dirty) {
        return getNumber(
          this.configManager.get('reclamation.worktrees.dirtyStagnantRetentionHours'),
          getNumber(this.configManager.get('reclamation.worktrees.dirtyFailedRetentionHours'), 336),
        );
      }

      return getNumber(this.configManager.get('reclamation.worktrees.stagnantRetentionHours'), 168);
    }

    if (inspection?.dirty) {
      return getNumber(this.configManager.get('reclamation.worktrees.dirtyFailedRetentionHours'), 336);
    }

    return getNumber(this.configManager.get('reclamation.worktrees.failedRetentionHours'), 168);
  }

  private getTaskTier(task: Task, options: ReclamationRunOptions): string {
    if (options.olderThanHours !== undefined) {
      return 'manual_retention';
    }

    if (task.status === 'completed') {
      const targetSyncStatus = resolveTaskTargetSyncStatus(task);
      if (targetSyncStatus === 'deferred_dirty_checkout' || targetSyncStatus === 'failed') {
        return 'safe_completed_target_sync_deferred';
      }

      return 'safe_completed';
    }

    return `debug_${task.status}`;
  }

  private shouldCleanupOrphans(): boolean {
    return getBoolean(this.configManager.get('reclamation.worktrees.cleanupOrphans'), true);
  }

  private writeReport(report: ReclamationReport, skipWrite: boolean): void {
    if (skipWrite) {
      return;
    }

    const paths = getRalphPaths({ ralphHome: this.ralphHome });
    const configuredLogPath = this.configManager.get('reclamation.reporting.logPath');
    const logPath = typeof configuredLogPath === 'string' && configuredLogPath.trim()
      ? path.resolve(configuredLogPath)
      : path.join(paths.logsDir, 'reclamation.jsonl');
    const lastRunPath = report.reportPath ?? path.join(this.ralphHome, 'reclamation', 'last-run.json');

    if (getBoolean(this.configManager.get('reclamation.reporting.writeLastRun'), true)) {
      try {
        fs.mkdirSync(path.dirname(lastRunPath), { recursive: true });
        report.reportPath = lastRunPath;
        fs.writeFileSync(lastRunPath, JSON.stringify(report, null, 2));
      } catch (error) {
        report.errors.push({
          kind: 'reclamation_report_write_failed',
          path: lastRunPath,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (getBoolean(this.configManager.get('reclamation.reporting.logJsonl'), true)) {
      try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.appendFileSync(logPath, `${JSON.stringify(report)}\n`);
      } catch (error) {
        report.errors.push({
          kind: 'reclamation_log_write_failed',
          path: logPath,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

export function isLegacyTempDirName(name: string, patterns: string[]): boolean {
  return patterns.some((pattern) => wildcardToRegExp(pattern).test(name));
}
