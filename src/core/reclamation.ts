import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../config/manager';
import { Task, TaskStatus } from '../types/task';
import { appendTaskEvent } from './events';
import { withDirectoryLock } from './locks';
import { getRalphPaths, RalphHomeOptions, resolveRalphHome } from './paths';
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
}

export interface ReclamationSectionReport {
  scanned: number;
  candidates: number;
  removed: number;
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
}

const TERMINAL_STATUSES = new Set<TaskStatus>([
  'completed',
  'failed',
  'failed_finalize',
  'stagnant',
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
  private readonly now: () => number;

  constructor(deps: ReclamationServiceDeps = {}) {
    this.ralphHome = deps.stateManager?.getRalphHome?.() ?? resolveRalphHome(deps);
    this.stateManager = deps.stateManager ?? new StateManager({ ralphHome: this.ralphHome });
    this.configManager = deps.configManager ?? new ConfigManager({ ralphHome: this.ralphHome });
    this.worktreeManager = deps.worktreeManager ?? new WorktreeManager();
    this.now = deps.now ?? (() => Date.now());
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
      worktrees: { scanned: 0, candidates: 0, removed: 0, skipped: 0 },
      tempDirs: { scanned: 0, candidates: 0, removed: 0, skipped: 0 },
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
    const retentionHours = options.olderThanHours ?? getNumber(this.configManager.get('reclamation.worktrees.orphanRetentionHours'), 24);

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
        candidates.push({
          kind: 'orphan_worktree',
          status: 'orphan',
          repoPath,
          worktree,
          finishedAt: statMs,
          ageHours,
          retentionHours,
          tier: 'orphan_clean_worktree',
          reclaimable: ageHours >= retentionHours && !inspection.dirty,
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

    const skipReason = this.getSkipReason(candidate, options);
    if (skipReason) {
      result.reason = skipReason;
      report.skipped.push(result);
      report.worktrees.skipped++;
      return;
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

    if (candidate.kind === 'orphan_worktree' && candidate.inspection?.dirty) {
      return 'dirty_orphan_retained';
    }

    if (
      candidate.task
      && candidate.task.status !== 'completed'
      && candidate.inspection?.dirty
      && !getBoolean(this.configManager.get('reclamation.worktrees.removeDirtyFailedWorktrees'), false)
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
      return getNumber(this.configManager.get('reclamation.worktrees.failedFinalizeRetentionHours'), 168);
    }

    if (task.status === 'stagnant') {
      return getNumber(this.configManager.get('reclamation.worktrees.stagnantRetentionHours'), 168);
    }

    if (
      inspection?.dirty
      && getBoolean(this.configManager.get('reclamation.worktrees.removeDirtyFailedWorktrees'), false)
    ) {
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
