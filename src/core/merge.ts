import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Task } from '../types/task';
import {
  filterGitInternalPaths,
} from './git-internal-paths';
import { withRepoMergeLock } from './locks';
import {
  filterOperationalArtifactPaths,
  isOperationalArtifactPath,
} from './operational-artifacts';

export type MergeStrategy = 'ours' | 'theirs' | 'manual';

export interface MergeResult {
  success: boolean;
  hasConflicts: boolean;
  message: string;
  commitSha?: string;
  alreadyMerged?: boolean;
  integrationBranch?: string;
  integrationWorktree?: string;
  targetSynced?: boolean;
  targetSyncMessage?: string;
  conflictFiles?: string[];
  sourceBranch?: string;
  targetBranch?: string;
  baseCommitSha?: string;
}

export interface MergeabilityProbeResult {
  mergeable: boolean;
  alreadyIntegrated: boolean;
  message: string;
  integrationBranch: string;
  integrationWorktree: string;
  conflictFiles?: string[];
  failurePhase?: MergeFailurePhase;
  sourceKind?: MergeProofSourceKind;
  worktreeMergeState?: WorktreeMergeState;
}

export type WorktreeMergeStateKind = 'none' | 'unresolved' | 'resolved_pending_commit';
export type MergeProofSourceKind = 'branch_head' | 'worktree_snapshot' | 'resolved_pending_merge';
export type MergeFailurePhase = 'integration_sync' | 'source_merge' | 'worktree_unresolved';

export interface WorktreeMergeState {
  kind: WorktreeMergeStateKind;
  usesGitLocal: boolean;
  gitDir: string;
  headSha?: string;
  mergeParents: string[];
  unmergedFiles: string[];
  changedFiles: string[];
  statusPorcelain: string;
  statusSignature: string;
}

export interface MergeOptions {
  pullLatest?: boolean;
  useIntegrationWorktree?: boolean;
  integrationWorktreeDir?: string;
  syncTargetBranch?: boolean;
}

interface GitWorktree {
  path: string;
  branch?: string;
}

export class MergeQueue {
  private queue: string[] = [];
  private processing = false;

  add(taskId: string): void {
    if (!this.queue.includes(taskId)) {
      this.queue.push(taskId);
    }
  }

  remove(taskId: string): void {
    this.queue = this.queue.filter(id => id !== taskId);
  }

  getNext(): string | null {
    return this.queue[0] || null;
  }

  isProcessing(): boolean {
    return this.processing;
  }

  setProcessing(value: boolean): void {
    this.processing = value;
  }

  getQueue(): string[] {
    return [...this.queue];
  }
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function runGitRaw(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runGitWithEnv(cwd: string, args: string[], env: NodeJS.ProcessEnv, input?: string): string {
  return execFileSync('git', args, {
    cwd,
    env,
    input,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function runGitRawWithEnv(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, {
    cwd,
    env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function tryRunGit(cwd: string, args: string[]): string | null {
  try {
    return runGit(cwd, args);
  } catch {
    return null;
  }
}

function tryRunGitRaw(cwd: string, args: string[]): string | null {
  try {
    return runGitRaw(cwd, args);
  } catch {
    return null;
  }
}

function tryRunGitRawWithEnv(cwd: string, args: string[], env: NodeJS.ProcessEnv): string | null {
  try {
    return runGitRawWithEnv(cwd, args, env);
  } catch {
    return null;
  }
}

function tryRunGitWithEnv(cwd: string, args: string[], env: NodeJS.ProcessEnv): string | null {
  try {
    return runGitWithEnv(cwd, args, env);
  } catch {
    return null;
  }
}

function normalizeBranchName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '').trim();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sanitizePathSegment(value: string): string {
  return normalizeBranchName(value).replace(/[^A-Za-z0-9._-]+/g, '-');
}

function getHeadCommit(repoPath: string): string | undefined {
  return tryRunGit(repoPath, ['rev-parse', 'HEAD']) || undefined;
}

function getCurrentBranch(repoPath: string): string | undefined {
  return tryRunGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']) || undefined;
}

function getPorcelainStatus(repoPath: string): string {
  const status = tryRunGitRaw(repoPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']) || '';
  return parsePorcelainStatusRecords(status)
    .filter((record) => !record.paths.every((filePath) => isOperationalArtifactPath(filePath)))
    .map((record) => record.summary)
    .join('\n');
}

function parsePorcelainStatusRecords(status: string): Array<{ paths: string[]; summary: string }> {
  const entries = status.split('\0').filter(Boolean);
  const records: Array<{ paths: string[]; summary: string }> = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const code = entry.slice(0, 2);
    const firstPath = entry.slice(3);
    if (!firstPath) {
      continue;
    }

    if (code.includes('R') || code.includes('C')) {
      const secondPath = entries[index + 1];
      if (secondPath) {
        index += 1;
        records.push({
          paths: [firstPath, secondPath],
          summary: `${code} ${firstPath} -> ${secondPath}`,
        });
        continue;
      }
    }

    records.push({
      paths: [firstPath],
      summary: `${code} ${firstPath}`,
    });
  }

  return records;
}

function summarizeDirtyStatus(status: string, limit = 10): string[] {
  return status
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(0, limit);
}

function hasUpstream(repoPath: string): boolean {
  return Boolean(tryRunGit(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']));
}

function tryAbortMerge(repoPath: string): void {
  try {
    runGit(repoPath, ['merge', '--abort']);
  } catch {
    // Ignore when no merge is active.
  }
}

function branchExists(repoPath: string, branchName: string): boolean {
  return tryRunGit(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]) !== null;
}

function isGitWorktree(worktreePath: string): boolean {
  return tryRunGit(worktreePath, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

function listWorktrees(repoPath: string): GitWorktree[] {
  const output = tryRunGit(repoPath, ['worktree', 'list', '--porcelain']) || '';
  const worktrees: GitWorktree[] = [];
  let current: GitWorktree | null = null;

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) {
        worktrees.push(current);
      }
      current = { path: line.slice('worktree '.length) };
      continue;
    }

    if (current && line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length);
    }
  }

  if (current) {
    worktrees.push(current);
  }

  return worktrees;
}

function resolveWorktreeGitEnv(worktreePath: string): NodeJS.ProcessEnv {
  const localGitDir = path.join(worktreePath, '.git-local');

  if (!fs.existsSync(localGitDir) || !fs.statSync(localGitDir).isDirectory()) {
    return process.env;
  }

  return {
    ...process.env,
    GIT_DIR: localGitDir,
    GIT_WORK_TREE: worktreePath,
  };
}

function resolveRepoObjectsDir(repoPath: string): string | undefined {
  return tryRunGit(repoPath, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']) || undefined;
}

function splitObjectDirectories(value: string | undefined): string[] {
  return (value || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function uniqueExistingObjectDirs(dirs: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const dir of dirs) {
    if (!dir) {
      continue;
    }

    const resolved = path.resolve(dir);
    if (seen.has(resolved) || !fs.existsSync(resolved)) {
      continue;
    }

    seen.add(resolved);
    result.push(resolved);
  }

  return result;
}

function resolveWorktreeObjectDirs(worktreePath: string, env: NodeJS.ProcessEnv): string[] {
  return uniqueExistingObjectDirs([
    tryRunGitWithEnv(worktreePath, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'], env) || undefined,
    ...splitObjectDirectories(env.GIT_ALTERNATE_OBJECT_DIRECTORIES),
  ]);
}

function buildAlternateObjectEnv(
  baseEnv: NodeJS.ProcessEnv,
  objectDirs: string[],
): Partial<NodeJS.ProcessEnv> {
  const alternates = uniqueExistingObjectDirs([
    ...splitObjectDirectories(baseEnv.GIT_ALTERNATE_OBJECT_DIRECTORIES),
    ...objectDirs,
  ]);

  return alternates.length > 0
    ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates.join(path.delimiter) }
    : {};
}

function buildSanitizedProofRef(task: Task, headCommit: string, artifactFiles: string[]): string {
  const taskSegment = sanitizePathSegment(task.id || 'task');
  const signature = sha256([
    headCommit,
    ...artifactFiles,
  ].join('\0')).slice(0, 40);

  return `refs/ralph/sanitized/${taskSegment}/${signature}`;
}

function objectExistsInRepo(repoPath: string, objectRef: string): boolean {
  return tryRunGit(repoPath, ['cat-file', '-e', `${objectRef}^{object}`]) !== null;
}

function deleteRef(cwd: string, refName: string, env?: NodeJS.ProcessEnv): void {
  try {
    if (env) {
      runGitWithEnv(cwd, ['update-ref', '-d', refName], env);
    } else {
      runGit(cwd, ['update-ref', '-d', refName]);
    }
  } catch {
    // Best-effort cleanup for temporary object export refs.
  }
}

function importWorktreeObjectGraph(
  task: Task,
  worktreeMergeState: WorktreeMergeState,
  objectRefs: string[],
): void {
  if (!worktreeMergeState.usesGitLocal || objectRefs.length === 0) {
    return;
  }

  const sourceGitDir = worktreeMergeState.gitDir;
  if (!sourceGitDir || !fs.existsSync(sourceGitDir)) {
    return;
  }

  const sourceEnv = {
    ...process.env,
    GIT_DIR: sourceGitDir,
    GIT_WORK_TREE: task.worktree,
  };

  for (const objectRef of objectRefs) {
    if (!objectRef || objectExistsInRepo(task.repoPath, objectRef)) {
      continue;
    }

    const tempRef = `refs/ralph/object-export/${process.pid}-${Date.now()}-${objectRef.slice(0, 12)}`;

    try {
      runGitWithEnv(task.worktree, ['update-ref', tempRef, objectRef], sourceEnv);
      runGit(task.repoPath, ['fetch', '--no-tags', sourceGitDir, `${tempRef}:${tempRef}`]);
    } catch {
      // Alternate object directories below still allow read-only probes to produce a useful diagnosis.
    } finally {
      deleteRef(task.worktree, tempRef, sourceEnv);
      deleteRef(task.repoPath, tempRef);
    }
  }
}

function readWorktreeMergeParents(worktreePath: string, env: NodeJS.ProcessEnv): string[] {
  let gitDir: string;

  try {
    gitDir = runGitWithEnv(worktreePath, ['rev-parse', '--path-format=absolute', '--git-dir'], env);
  } catch {
    return [];
  }

  const mergeHeadPath = path.join(gitDir, 'MERGE_HEAD');
  if (!fs.existsSync(mergeHeadPath)) {
    return [];
  }

  return fs.readFileSync(mergeHeadPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function listUnmergedWorktreeFiles(worktreePath: string, env: NodeJS.ProcessEnv): string[] {
  const output = tryRunGitRawWithEnv(worktreePath, ['diff', '--name-only', '--diff-filter=U', '-z'], env) || '';
  return filterGitInternalPaths(output.split('\0').filter(Boolean));
}

export function inspectTaskWorktreeMergeState(worktreePath: string): WorktreeMergeState {
  const env = resolveWorktreeGitEnv(worktreePath);
  const usesGitLocal = Boolean(env.GIT_DIR && String(env.GIT_DIR).endsWith('.git-local'));
  const gitDir = runGitWithEnv(worktreePath, ['rev-parse', '--path-format=absolute', '--git-dir'], env);
  const headSha = (tryRunGitRawWithEnv(worktreePath, ['rev-parse', 'HEAD'], env) || '').trim() || undefined;
  const mergeParents = readWorktreeMergeParents(worktreePath, env);
  const unmergedFiles = listUnmergedWorktreeFiles(worktreePath, env);
  const changedFiles = listChangedWorktreeFiles(worktreePath, env);
  const statusPorcelain = tryRunGitRawWithEnv(worktreePath, ['status', '--porcelain=v1', '-z'], env) || '';
  const statusSignature = sha256([
    headSha || '',
    mergeParents.join('\n'),
    unmergedFiles.join('\n'),
    changedFiles.join('\n'),
    statusPorcelain,
  ].join('\0'));

  return {
    kind: mergeParents.length === 0
      ? 'none'
      : unmergedFiles.length > 0
        ? 'unresolved'
        : 'resolved_pending_commit',
    usesGitLocal,
    gitDir,
    headSha,
    mergeParents,
    unmergedFiles,
    changedFiles,
    statusPorcelain,
    statusSignature,
  };
}

function ensureIntegrationWorktree(
  repoPath: string,
  targetBranch: string,
  integrationWorktreeDir: string,
): { integrationBranch: string; integrationWorktree: string } {
  const normalizedTarget = normalizeBranchName(targetBranch);
  const integrationBranch = `ralph/integration/${normalizedTarget}`;
  const integrationRoot = path.isAbsolute(integrationWorktreeDir)
    ? integrationWorktreeDir
    : path.join(repoPath, integrationWorktreeDir);
  const integrationWorktree = path.join(integrationRoot, sanitizePathSegment(normalizedTarget));
  const currentWorktree = listWorktrees(repoPath).find((worktree) => worktree.path === integrationWorktree);

  fs.mkdirSync(path.dirname(integrationWorktree), { recursive: true });

  if (currentWorktree && currentWorktree.branch !== integrationBranch) {
    runGit(repoPath, ['worktree', 'remove', '--force', integrationWorktree]);
  } else if (fs.existsSync(integrationWorktree) && !isGitWorktree(integrationWorktree)) {
    fs.rmSync(integrationWorktree, { recursive: true, force: true });
  }

  if (!branchExists(repoPath, integrationBranch)) {
    runGit(repoPath, ['branch', integrationBranch, normalizedTarget]);
  }

  if (!fs.existsSync(integrationWorktree) || !isGitWorktree(integrationWorktree)) {
    runGit(repoPath, ['worktree', 'add', integrationWorktree, integrationBranch]);
  }

  return { integrationBranch, integrationWorktree };
}

function listChangedWorktreeFiles(worktreePath: string, env?: NodeJS.ProcessEnv): string[] {
  const effectiveEnv = env || process.env;
  const diffFiles = tryRunGitRawWithEnv(worktreePath, ['diff', '--name-only', '-z', 'HEAD', '--'], effectiveEnv) || '';
  const untrackedFiles = tryRunGitRawWithEnv(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z'], effectiveEnv) || '';

  return filterOperationalArtifactPaths(filterGitInternalPaths([
    ...diffFiles.split('\0').filter(Boolean),
    ...untrackedFiles.split('\0').filter(Boolean),
  ]));
}

function listTreeOperationalArtifactFiles(cwd: string, treeish: string, env: NodeJS.ProcessEnv): string[] {
  const output = tryRunGitRawWithEnv(cwd, ['ls-tree', '-r', '-z', '--name-only', treeish], env) || '';
  return output
    .split('\0')
    .filter(Boolean)
    .filter((file) => isOperationalArtifactPath(file));
}

function resolveTempCommitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || process.env.GIT_COMMITTER_NAME || 'Ralph',
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || process.env.GIT_COMMITTER_EMAIL || 'ralph@example.com',
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || process.env.GIT_AUTHOR_NAME || 'Ralph',
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || process.env.GIT_AUTHOR_EMAIL || 'ralph@example.com',
  };
}

function createTemporaryWorktreeCommit(
  task: Task,
  worktreeMergeState: WorktreeMergeState,
): {
  sourceRef: string;
  sourceLabel: string;
  sourceKind: MergeProofSourceKind;
  sourceEnv?: NodeJS.ProcessEnv;
  cleanup: () => void;
} {
  const worktreeGitEnv = resolveWorktreeGitEnv(task.worktree);
  const branchName = runGitWithEnv(task.worktree, ['rev-parse', '--abbrev-ref', 'HEAD'], worktreeGitEnv);
  const changedFiles = worktreeMergeState.changedFiles;
  const mergeParents = worktreeMergeState.mergeParents;
  const headCommit = worktreeMergeState.headSha
    || runGitWithEnv(task.worktree, ['rev-parse', 'HEAD'], worktreeGitEnv);
  const artifactFiles = listTreeOperationalArtifactFiles(task.worktree, headCommit, worktreeGitEnv);
  const repoObjectsDir = resolveRepoObjectsDir(task.repoPath);
  const worktreeObjectDirs = resolveWorktreeObjectDirs(task.worktree, worktreeGitEnv);
  const privateObjectDirs = uniqueExistingObjectDirs(
    worktreeObjectDirs.filter((dir) => !repoObjectsDir || path.resolve(dir) !== path.resolve(repoObjectsDir)),
  );
  const sourceEnv = privateObjectDirs.length > 0
    ? {
        ...process.env,
        ...buildAlternateObjectEnv(process.env, privateObjectDirs),
      }
    : undefined;
  const sanitizedProofRef = mergeParents.length === 0 && changedFiles.length === 0 && artifactFiles.length > 0
    ? buildSanitizedProofRef(task, headCommit, artifactFiles)
    : undefined;
  const existingSanitizedRef = sanitizedProofRef
    ? tryRunGit(task.repoPath, ['rev-parse', '--verify', sanitizedProofRef])
    : null;

  importWorktreeObjectGraph(
    task,
    worktreeMergeState,
    [worktreeMergeState.headSha, ...mergeParents].filter((ref): ref is string => Boolean(ref)),
  );

  if (sanitizedProofRef && existingSanitizedRef) {
    return {
      sourceRef: sanitizedProofRef,
      sourceLabel: `${branchName} (sanitized branch head)`,
      sourceKind: 'worktree_snapshot',
      sourceEnv,
      cleanup: () => undefined,
    };
  }

  if (changedFiles.length === 0 && mergeParents.length === 0 && artifactFiles.length === 0) {
    if (worktreeMergeState.usesGitLocal && worktreeMergeState.headSha) {
      return {
        sourceRef: worktreeMergeState.headSha,
        sourceLabel: `${branchName} (local head)`,
        sourceKind: 'worktree_snapshot',
        sourceEnv,
        cleanup: () => undefined,
      };
    }

    return {
      sourceRef: branchName,
      sourceLabel: branchName,
      sourceKind: 'branch_head',
      sourceEnv,
      cleanup: () => undefined,
    };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-merge-probe-'));
  const tempIndexPath = path.join(tempDir, 'index');
  const env = {
    ...worktreeGitEnv,
    ...resolveTempCommitEnv(),
    GIT_INDEX_FILE: tempIndexPath,
    ...(repoObjectsDir ? { GIT_OBJECT_DIRECTORY: repoObjectsDir } : {}),
    ...buildAlternateObjectEnv(worktreeGitEnv, privateObjectDirs),
  };

  runGitWithEnv(task.worktree, ['read-tree', headCommit], env);
  if (artifactFiles.length > 0) {
    runGitWithEnv(
      task.worktree,
      ['rm', '-r', '--cached', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'],
      env,
      artifactFiles.join('\0'),
    );
  }

  if (changedFiles.length > 0) {
    runGitWithEnv(
      task.worktree,
      ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'],
      env,
      changedFiles.join('\0'),
    );
  }

  const treeSha = runGitWithEnv(task.worktree, ['write-tree'], env);
  const commitSha = runGitWithEnv(
    task.worktree,
    [
      'commit-tree',
      treeSha,
      '-p',
      headCommit,
      ...mergeParents.flatMap((parentSha) => ['-p', parentSha]),
      '-m',
      `chore(ralph): merge probe ${task.id}`,
    ],
    env,
  );

  if (sanitizedProofRef) {
    runGit(task.repoPath, ['update-ref', sanitizedProofRef, commitSha]);
  }

  return {
    sourceRef: sanitizedProofRef || commitSha,
    sourceLabel: mergeParents.length > 0
      ? `${branchName} (resolved pending merge)`
      : artifactFiles.length > 0 && changedFiles.length === 0
        ? `${branchName} (sanitized branch head)`
        : `${branchName} (worktree snapshot)`,
    sourceKind: mergeParents.length > 0
      ? 'resolved_pending_merge'
      : 'worktree_snapshot',
    sourceEnv,
    cleanup: () => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function resolveTargetSync(
  options: MergeOptions,
  repoPath: string,
  normalizedTarget: string,
  commitSha: string | undefined,
): { synced: boolean; message: string } {
  if (options.syncTargetBranch === false || !commitSha) {
    return { synced: false, message: 'target sync disabled' };
  }

  try {
    return syncTargetBranchIfSafe(repoPath, normalizedTarget, commitSha);
  } catch (error) {
    return {
      synced: false,
      message: `target sync failed after integration: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function resetIntegrationWorktree(integrationWorktree: string): void {
  tryAbortMerge(integrationWorktree);
  runGit(integrationWorktree, ['reset', '--hard']);
  runGit(integrationWorktree, ['clean', '-fd']);
}

function mergeIntoIntegration(
  integrationWorktree: string,
  sourceRef: string,
  message: string,
  env?: NodeJS.ProcessEnv,
): void {
  try {
    if (env) {
      runGitWithEnv(integrationWorktree, ['merge', '--ff-only', sourceRef], env);
    } else {
      runGit(integrationWorktree, ['merge', '--ff-only', sourceRef]);
    }
  } catch {
    if (env) {
      runGitWithEnv(integrationWorktree, ['merge', sourceRef, '--no-ff', '-m', message], env);
    } else {
      runGit(integrationWorktree, ['merge', sourceRef, '--no-ff', '-m', message]);
    }
  }
}

function syncTargetBranchIfSafe(
  repoPath: string,
  targetBranch: string,
  commitSha: string,
): { synced: boolean; message: string } {
  const normalizedTarget = normalizeBranchName(targetBranch);
  const targetCheckouts = listWorktrees(repoPath).filter((worktree) => worktree.branch === normalizedTarget);

  if (targetCheckouts.length === 0) {
    const currentTarget = tryRunGit(repoPath, ['rev-parse', normalizedTarget]);
    if (currentTarget) {
      runGit(repoPath, ['update-ref', `refs/heads/${normalizedTarget}`, commitSha, currentTarget]);
    } else {
      runGit(repoPath, ['update-ref', `refs/heads/${normalizedTarget}`, commitSha]);
    }

    return {
      synced: true,
      message: `${normalizedTarget} updated to ${commitSha}`,
    };
  }

  const dirtyCheckout = targetCheckouts.find((worktree) => getPorcelainStatus(worktree.path));
  if (dirtyCheckout) {
    const dirtyStatus = getPorcelainStatus(dirtyCheckout.path);
    const summary = summarizeDirtyStatus(dirtyStatus);
    const lines = [
      `${normalizedTarget} sync deferred: checkout ${dirtyCheckout.path} has uncommitted changes`,
      ...summary.map((line) => `  ${line}`),
    ];
    const totalDirtyPaths = dirtyStatus
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0).length;
    if (totalDirtyPaths > summary.length) {
      lines.push(`  ... ${totalDirtyPaths - summary.length} more`);
    }
    return {
      synced: false,
      message: lines.join('\n'),
    };
  }

  for (const worktree of targetCheckouts) {
    runGit(worktree.path, ['merge', '--ff-only', commitSha]);
  }

  return {
    synced: true,
    message: `${normalizedTarget} fast-forwarded to ${commitSha}`,
  };
}

function mergeConflictResult(
  repoPath: string,
  conflicts: string[],
  details: Partial<Pick<MergeResult, 'sourceBranch' | 'targetBranch' | 'baseCommitSha'>> = {},
): MergeResult {
  tryAbortMerge(repoPath);
  return {
    success: false,
    hasConflicts: true,
    message: `Merge conflicts detected: ${conflicts.join(', ')}`,
    conflictFiles: conflicts,
    ...details,
  };
}

async function mergeBranchInLiveCheckout(
  task: Task,
  targetBranch: string,
  strategy: MergeStrategy,
  options: MergeOptions,
): Promise<MergeResult> {
  const repoPath = task.repoPath;
  const originalBranch = getCurrentBranch(repoPath);
  let mergeInProgress = false;

  try {
    const pullLatest = options.pullLatest !== false;
    const dirtyStatus = getPorcelainStatus(repoPath);

    if (dirtyStatus) {
      return {
        success: false,
        hasConflicts: false,
        message: 'Merge refused: repository working tree has uncommitted changes',
      };
    }

    runGit(repoPath, ['checkout', targetBranch]);

    if (pullLatest && hasUpstream(repoPath)) {
      runGit(repoPath, ['pull', '--ff-only']);
    }

    const branchName = runGit(task.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);

    try {
      runGit(repoPath, ['merge-base', '--is-ancestor', branchName, 'HEAD']);
      return {
        success: true,
        hasConflicts: false,
        alreadyMerged: true,
        commitSha: getHeadCommit(repoPath),
        targetSynced: true,
        message: `${branchName} is already merged into ${targetBranch}`,
      };
    } catch {
      // Not merged yet.
    }

    try {
      mergeInProgress = true;
      runGit(repoPath, ['merge', branchName, '--no-ff']);
      mergeInProgress = false;
      return {
        success: true,
        hasConflicts: false,
        commitSha: getHeadCommit(repoPath),
        targetSynced: true,
        message: `Successfully merged ${branchName} into ${targetBranch}`,
      };
    } catch (error) {
      const conflicts = detectConflicts(repoPath);

      if (conflicts.length === 0) {
        return {
          success: false,
          hasConflicts: false,
          message: `Merge failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      if (strategy === 'manual') {
        mergeInProgress = false;
        return mergeConflictResult(repoPath, conflicts, {
          sourceBranch: branchName,
          targetBranch,
          baseCommitSha: task.baseCommitSha,
        });
      }

      if (strategy === 'ours') {
        runGit(repoPath, ['checkout', '--ours', '.']);
      } else {
        runGit(repoPath, ['checkout', '--theirs', '.']);
      }

      runGit(repoPath, ['add', '.']);
      runGit(repoPath, ['commit', '-m', `feat: merge ${branchName} (auto-resolved with ${strategy})`]);
      mergeInProgress = false;

      return {
        success: true,
        hasConflicts: true,
        commitSha: getHeadCommit(repoPath),
        targetSynced: true,
        message: `Merged ${branchName} with conflicts auto-resolved using ${strategy} strategy`,
      };
    }
  } catch (error) {
    return {
      success: false,
      hasConflicts: false,
      message: `Merge failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (mergeInProgress) {
      tryAbortMerge(repoPath);
    }

    const currentBranch = getCurrentBranch(repoPath);
    if (originalBranch && currentBranch && currentBranch !== originalBranch) {
      tryRunGit(repoPath, ['checkout', originalBranch]);
    }
  }
}

async function mergeBranchInIntegrationWorktree(
  task: Task,
  targetBranch: string,
  strategy: MergeStrategy,
  options: MergeOptions,
): Promise<MergeResult> {
  const normalizedTarget = normalizeBranchName(targetBranch);
  const repoPath = task.repoPath;
  const branchName = runGit(task.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const worktreeMergeState = inspectTaskWorktreeMergeState(task.worktree);
  const integration = ensureIntegrationWorktree(
    repoPath,
    normalizedTarget,
    options.integrationWorktreeDir || '.ralph-integration',
  );
  const mergeSource = worktreeMergeState.kind === 'unresolved'
    ? undefined
    : createTemporaryWorktreeCommit(task, worktreeMergeState);
  const sourceRef = mergeSource?.sourceRef || branchName;
  const sourceLabel = mergeSource?.sourceLabel || branchName;
  let mergeInProgress = false;

  try {
    if (worktreeMergeState.kind === 'unresolved') {
      return {
        success: false,
        hasConflicts: true,
        message: `Task worktree still has unresolved merge entries: ${worktreeMergeState.unmergedFiles.join(', ')}`,
        conflictFiles: worktreeMergeState.unmergedFiles,
        integrationBranch: integration.integrationBranch,
        integrationWorktree: integration.integrationWorktree,
        sourceBranch: branchName,
        targetBranch: integration.integrationBranch,
        baseCommitSha: task.baseCommitSha,
      };
    }

    resetIntegrationWorktree(integration.integrationWorktree);

    if (options.pullLatest !== false && hasUpstream(repoPath)) {
      runGit(integration.integrationWorktree, ['fetch']);
    }

    try {
      mergeIntoIntegration(
        integration.integrationWorktree,
        normalizedTarget,
        `chore: sync ${normalizedTarget} into ${integration.integrationBranch}`,
      );
    } catch (error) {
      const conflicts = detectConflicts(integration.integrationWorktree);
      if (conflicts.length > 0) {
        return {
          ...mergeConflictResult(integration.integrationWorktree, conflicts, {
            sourceBranch: normalizedTarget,
            targetBranch: integration.integrationBranch,
            baseCommitSha: task.baseCommitSha,
          }),
          integrationBranch: integration.integrationBranch,
          integrationWorktree: integration.integrationWorktree,
        };
      }

      return {
        success: false,
        hasConflicts: false,
        integrationBranch: integration.integrationBranch,
        integrationWorktree: integration.integrationWorktree,
        message: `Integration branch sync failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    try {
      if (mergeSource?.sourceEnv) {
        runGitWithEnv(integration.integrationWorktree, ['merge-base', '--is-ancestor', sourceRef, 'HEAD'], mergeSource.sourceEnv);
      } else {
        runGit(integration.integrationWorktree, ['merge-base', '--is-ancestor', sourceRef, 'HEAD']);
      }
      const commitSha = getHeadCommit(integration.integrationWorktree);
      const targetSync = resolveTargetSync(options, repoPath, normalizedTarget, commitSha);

      return {
        success: true,
        hasConflicts: false,
        alreadyMerged: true,
        commitSha,
        integrationBranch: integration.integrationBranch,
        integrationWorktree: integration.integrationWorktree,
        targetSynced: targetSync.synced,
        targetSyncMessage: targetSync.message,
        message: `${sourceLabel} is already integrated in ${integration.integrationBranch}; ${targetSync.message}`,
      };
    } catch {
      if (mergeSource?.sourceLabel.includes('(sanitized branch head)')) {
        try {
          runGit(integration.integrationWorktree, ['merge-base', '--is-ancestor', branchName, 'HEAD']);
          const commitSha = getHeadCommit(integration.integrationWorktree);
          const targetSync = resolveTargetSync(options, repoPath, normalizedTarget, commitSha);

          return {
            success: true,
            hasConflicts: false,
            alreadyMerged: true,
            commitSha,
            integrationBranch: integration.integrationBranch,
            integrationWorktree: integration.integrationWorktree,
            targetSynced: targetSync.synced,
            targetSyncMessage: targetSync.message,
            message: `${sourceLabel} is already integrated in ${integration.integrationBranch}; ${targetSync.message}`,
          };
        } catch {
          // Fall through to merge the sanitized proof ref.
        }
      }
      // Not merged yet.
    }

    try {
      mergeInProgress = true;
      if (mergeSource?.sourceEnv) {
        runGitWithEnv(integration.integrationWorktree, ['merge', sourceRef, '--no-ff'], mergeSource.sourceEnv);
      } else {
        runGit(integration.integrationWorktree, ['merge', sourceRef, '--no-ff']);
      }
      mergeInProgress = false;
    } catch (error) {
      const conflicts = detectConflicts(integration.integrationWorktree);

      if (conflicts.length === 0) {
        return {
          success: false,
          hasConflicts: false,
          integrationBranch: integration.integrationBranch,
          integrationWorktree: integration.integrationWorktree,
          message: `Merge failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      if (strategy === 'manual') {
        mergeInProgress = false;
        return {
          ...mergeConflictResult(integration.integrationWorktree, conflicts, {
            sourceBranch: sourceLabel,
            targetBranch: integration.integrationBranch,
            baseCommitSha: task.baseCommitSha,
          }),
          integrationBranch: integration.integrationBranch,
          integrationWorktree: integration.integrationWorktree,
        };
      }

      if (strategy === 'ours') {
        runGit(integration.integrationWorktree, ['checkout', '--ours', '.']);
      } else {
        runGit(integration.integrationWorktree, ['checkout', '--theirs', '.']);
      }

      runGit(integration.integrationWorktree, ['add', '.']);
      runGit(integration.integrationWorktree, ['commit', '-m', `feat: merge ${sourceLabel} (auto-resolved with ${strategy})`]);
      mergeInProgress = false;
    }

    const commitSha = getHeadCommit(integration.integrationWorktree);
    const targetSync = resolveTargetSync(options, repoPath, normalizedTarget, commitSha);
    const syncSuffix = targetSync.synced
      ? `; ${targetSync.message}`
      : `; ${targetSync.message}`;

    return {
      success: true,
      hasConflicts: false,
      commitSha,
      integrationBranch: integration.integrationBranch,
      integrationWorktree: integration.integrationWorktree,
      targetSynced: targetSync.synced,
      targetSyncMessage: targetSync.message,
      message: `Integrated ${sourceLabel} into ${integration.integrationBranch}${syncSuffix}`,
    };
  } catch (error) {
    return {
      success: false,
      hasConflicts: false,
      integrationBranch: integration.integrationBranch,
      integrationWorktree: integration.integrationWorktree,
      message: `Merge failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (mergeInProgress) {
      tryAbortMerge(integration.integrationWorktree);
    }
    mergeSource?.cleanup();
  }
}

async function probeBranchMergeabilityInIntegrationWorktree(
  task: Task,
  targetBranch: string,
  options: MergeOptions,
  sourceOverride?: {
    sourceRef: string;
    sourceLabel: string;
    sourceKind: MergeProofSourceKind;
    worktreeMergeState?: WorktreeMergeState;
    sourceEnv?: NodeJS.ProcessEnv;
  },
): Promise<MergeabilityProbeResult> {
  const normalizedTarget = normalizeBranchName(targetBranch);
  const repoPath = task.repoPath;
  const branchName = runGit(task.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const sourceRef = sourceOverride?.sourceRef || branchName;
  const sourceLabel = sourceOverride?.sourceLabel || branchName;
  const sourceKind = sourceOverride?.sourceKind || 'branch_head';
  const worktreeMergeState = sourceOverride?.worktreeMergeState;
  const sourceEnv = sourceOverride?.sourceEnv;
  const integration = ensureIntegrationWorktree(
    repoPath,
    normalizedTarget,
    options.integrationWorktreeDir || '.ralph-integration',
  );
  let mergeInProgress = false;

  try {
    resetIntegrationWorktree(integration.integrationWorktree);

    if (options.pullLatest !== false && hasUpstream(repoPath)) {
      runGit(integration.integrationWorktree, ['fetch']);
    }

    try {
      mergeIntoIntegration(
        integration.integrationWorktree,
        normalizedTarget,
        `chore: sync ${normalizedTarget} into ${integration.integrationBranch}`,
      );
    } catch (error) {
      const conflicts = detectConflicts(integration.integrationWorktree);
      if (conflicts.length > 0) {
        return {
          mergeable: false,
          alreadyIntegrated: false,
        message: `Integration branch sync failed with conflicts: ${conflicts.join(', ')}`,
        conflictFiles: conflicts,
        failurePhase: 'integration_sync',
        integrationBranch: integration.integrationBranch,
        integrationWorktree: integration.integrationWorktree,
        sourceKind,
          worktreeMergeState,
        };
      }

      return {
        mergeable: false,
        alreadyIntegrated: false,
        message: `Integration branch sync failed: ${error instanceof Error ? error.message : String(error)}`,
        failurePhase: 'integration_sync',
        integrationBranch: integration.integrationBranch,
        integrationWorktree: integration.integrationWorktree,
        sourceKind,
        worktreeMergeState,
      };
    }

    try {
      if (sourceEnv) {
        runGitWithEnv(integration.integrationWorktree, ['merge-base', '--is-ancestor', sourceRef, 'HEAD'], sourceEnv);
      } else {
        runGit(integration.integrationWorktree, ['merge-base', '--is-ancestor', sourceRef, 'HEAD']);
      }
      return {
        mergeable: true,
        alreadyIntegrated: true,
        message: `${sourceLabel} is already integrated in ${integration.integrationBranch}`,
        integrationBranch: integration.integrationBranch,
        integrationWorktree: integration.integrationWorktree,
        sourceKind,
        worktreeMergeState,
      };
    } catch {
      // Not integrated yet; continue with an exact no-commit merge probe.
    }

    try {
      mergeInProgress = true;
      if (sourceEnv) {
        runGitWithEnv(integration.integrationWorktree, ['merge', '--no-ff', '--no-commit', sourceRef], sourceEnv);
      } else {
        runGit(integration.integrationWorktree, ['merge', '--no-ff', '--no-commit', sourceRef]);
      }
      mergeInProgress = false;
      tryAbortMerge(integration.integrationWorktree);

      return {
        mergeable: true,
        alreadyIntegrated: false,
        message: `${sourceLabel} can merge cleanly into ${integration.integrationBranch}`,
        integrationBranch: integration.integrationBranch,
        integrationWorktree: integration.integrationWorktree,
        sourceKind,
        worktreeMergeState,
      };
    } catch (error) {
      const conflicts = detectConflicts(integration.integrationWorktree);

      if (conflicts.length > 0) {
        return {
          mergeable: false,
          alreadyIntegrated: false,
          message: `Merge conflicts detected: ${conflicts.join(', ')}`,
          conflictFiles: conflicts,
          failurePhase: 'source_merge',
          integrationBranch: integration.integrationBranch,
          integrationWorktree: integration.integrationWorktree,
          sourceKind,
          worktreeMergeState,
        };
      }

      return {
        mergeable: false,
        alreadyIntegrated: false,
        message: `Merge probe failed: ${error instanceof Error ? error.message : String(error)}`,
        failurePhase: 'source_merge',
        integrationBranch: integration.integrationBranch,
        integrationWorktree: integration.integrationWorktree,
        sourceKind,
        worktreeMergeState,
      };
    }
  } finally {
    if (mergeInProgress) {
      tryAbortMerge(integration.integrationWorktree);
    }

    resetIntegrationWorktree(integration.integrationWorktree);
  }
}

export async function mergeBranch(
  task: Task,
  targetBranch: string = 'main',
  strategy: MergeStrategy = 'manual',
  options: MergeOptions = {}
): Promise<MergeResult> {
  return withRepoMergeLock(task.repoPath, async () => {
    if (options.useIntegrationWorktree === false) {
      return mergeBranchInLiveCheckout(task, targetBranch, strategy, options);
    }

    return mergeBranchInIntegrationWorktree(task, targetBranch, strategy, options);
  });
}

export async function probeTaskMergeability(
  task: Task,
  targetBranch: string = 'main',
  options: MergeOptions = {}
): Promise<MergeabilityProbeResult> {
  return withRepoMergeLock(task.repoPath, async () => {
    if (options.useIntegrationWorktree === false) {
      throw new Error('Exact mergeability probe requires integration worktree mode');
    }

    return probeBranchMergeabilityInIntegrationWorktree(task, targetBranch, options);
  });
}

export async function probeTaskWorktreeMergeability(
  task: Task,
  targetBranch: string = 'main',
  options: MergeOptions = {}
): Promise<MergeabilityProbeResult> {
  return withRepoMergeLock(task.repoPath, async () => {
    if (options.useIntegrationWorktree === false) {
      throw new Error('Exact mergeability probe requires integration worktree mode');
    }

    const worktreeMergeState = inspectTaskWorktreeMergeState(task.worktree);
    if (worktreeMergeState.kind === 'unresolved') {
      const integration = ensureIntegrationWorktree(
        task.repoPath,
        normalizeBranchName(targetBranch),
        options.integrationWorktreeDir || '.ralph-integration',
      );

      resetIntegrationWorktree(integration.integrationWorktree);
      return {
        mergeable: false,
        alreadyIntegrated: false,
        message: `Task worktree still has unresolved merge entries: ${worktreeMergeState.unmergedFiles.join(', ')}`,
        conflictFiles: worktreeMergeState.unmergedFiles,
        failurePhase: 'worktree_unresolved',
        integrationBranch: integration.integrationBranch,
        integrationWorktree: integration.integrationWorktree,
        sourceKind: 'worktree_snapshot',
        worktreeMergeState,
      };
    }

    const temporaryCommit = createTemporaryWorktreeCommit(task, worktreeMergeState);
    try {
      const probeResult = await probeBranchMergeabilityInIntegrationWorktree(
        task,
        targetBranch,
        options,
        {
          sourceRef: temporaryCommit.sourceRef,
          sourceLabel: temporaryCommit.sourceLabel,
          sourceKind: temporaryCommit.sourceKind,
          sourceEnv: temporaryCommit.sourceEnv,
          worktreeMergeState,
        },
      );

      if (
        worktreeMergeState.kind === 'resolved_pending_commit'
        && probeResult.mergeable
        && !probeResult.alreadyIntegrated
      ) {
        return {
          ...probeResult,
          message: `Resolved pending merge in task worktree can be finalized against ${probeResult.integrationBranch}`,
        };
      }

      return probeResult;
    } finally {
      temporaryCommit.cleanup();
    }
  });
}

export function detectConflicts(repoPath: string): string[] {
  try {
    const output = runGit(repoPath, ['diff', '--name-only', '--diff-filter=U']);
    return output.trim().split('\n').filter(line => line.length > 0);
  } catch {
    return [];
  }
}
