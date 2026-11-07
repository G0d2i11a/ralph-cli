# Oracle Output: Ralph docs/status integration-sync conflict resolver

*Source request and constraints are from the attached transcript.* 

## 1. Ralph-compatible PRD

```json
{
  "id": "PRD-ralph-safe-docs-integration-sync-conflict-resolver",
  "title": "Safe automatic repair for allowlisted docs/status integration sync conflicts",
  "description": "Fix Ralph so low-risk integration sync conflicts in status documents such as docs/TODO.md and docs/PROJECT-STATUS.md do not permanently block the queue. Ralph must not weaken merge safety for code, config, schema, migrations, security-sensitive files, or lockfiles, and must not perform automatic ours/theirs winner selection. Instead, add a narrow deterministic docs resolver that preserves both sides' facts, records proof, exposes a manual repair-conflicts command, and lets manager auto-recovery try the resolver before stopping with merge_repair_integration_sync_conflict.",
  "userStories": [
    {
      "id": "US-001",
      "title": "Deterministically resolve allowlisted status-doc conflicts",
      "description": "As a Ralph operator, I want integration-sync conflicts limited to docs/TODO.md and docs/PROJECT-STATUS.md to be repaired by a deterministic union/preservation resolver so that low-risk status-doc drift does not block the whole queue.",
      "acceptanceCriteria": [
        "Resolver only runs when every conflict file is allowlisted and under configured size/count limits.",
        "Resolver removes Git conflict markers and preserves facts from both sides of every conflict hunk.",
        "Resolver refuses code/config/schema/migration/security/lockfile/binary conflicts and leaves the existing blocked_by_policy/manual path intact.",
        "Resolver does not use git checkout --ours, git checkout --theirs, or equivalent whole-file winner selection."
      ]
    },
    {
      "id": "US-002",
      "title": "Expose repair-conflicts CLI command",
      "description": "As an operator, I can run ralph repair-conflicts <task-id> --dry-run or --apply to inspect and safely apply deterministic docs conflict repair.",
      "acceptanceCriteria": [
        "Command supports --dry-run, --apply, --json, and --allow-llm flags.",
        "--dry-run reports eligibility, files, retained-fact counts, warnings, and candidate proof without writing files.",
        "--apply writes the resolved files, stages them, commits the integration-sync merge when appropriate, records proof, and runs/reports the exact mergeability probe.",
        "LLM mode remains optional and disabled/stubbed for this first slice; deterministic repair is sufficient."
      ]
    },
    {
      "id": "US-003",
      "title": "Manager auto-recovery tries docs repair before policy stop",
      "description": "As a queue user, I want the Ralph manager to attempt safe deterministic repair for eligible docs/status integration-sync conflicts before declaring a manual policy block.",
      "acceptanceCriteria": [
        "recoverFailedWorkerMergeRepairTasks calls the shared resolver when the exact probe fails in integration_sync.",
        "Successful repair writes an integration_sync_conflict_auto_resolved event and ConflictRepairProof evidence.",
        "If repair is ineligible, unsafe, or post-repair probe still cannot prove a clean state, manager keeps the existing stopped/manual policy path.",
        "The current ez4ielts scenario with docs/TODO.md and docs/PROJECT-STATUS.md can be auto-repaired or manually repaired by command without dropping either side; after repair, retry/manager recovery can proceed and unblock task-1778930252543-1nh52v22l."
      ]
    }
  ],
  "acceptanceCriteria": [
    "Given docs/TODO.md conflict where both sides add different TODO bullets, repair-conflicts --apply keeps both bullets, removes conflict markers, records evidence, and permits the exact mergeability probe to proceed.",
    "Given docs/PROJECT-STATUS.md conflict where both sides add task status entries, resolver preserves both entries and produces stable output.",
    "Given same TODO item with conflicting states, resolver preserves both facts or emits a conservative combined note; it must not silently discard either side.",
    "Given any conflict outside the docs/status allowlist, including src/*.ts, package-lock.json, migrations, schema, config, or security-sensitive files, resolver refuses and queue remains blocked_by_policy/manual_repair.",
    "Every applied repair writes ConflictRepairProof with conflict files, strategy, before/after hashes, retained-fact counts, droppedFacts, warnings, commit SHA, and exact-probe result when available.",
    "Manager auto-recovery attempts deterministic docs conflict repair before stopping with merge_repair_integration_sync_conflict.",
    "No automatic ours/theirs winner selection is introduced anywhere."
  ],
  "writeSurface": [
    "src/core/conflict-resolution.ts",
    "src/commands/repair-conflicts.ts",
    "src/core/dependency-watcher.ts",
    "src/commands/queue.ts",
    "src/core/repair-context.ts",
    "src/cli.ts",
    "src/types/task.ts",
    "test/conflict-resolution.test.js",
    "test/failed-recovery.test.js"
  ],
  "conflictDomains": [
    "ralph-cli-conflict-resolution",
    "ralph-cli-manager-auto-recovery",
    "ralph-cli-task-state-proof",
    "ralph-cli-operator-commands"
  ],
  "integrationLane": "ralph-cli-control-plane",
  "dependencies": [],
  "referenceImplementation": {
    "strategy": "deterministic_project_status_todo",
    "allowlist": ["docs/TODO.md", "docs/PROJECT-STATUS.md"],
    "manualCommand": "ralph repair-conflicts <task-id> --dry-run|--apply [--json]",
    "managerHook": "DependencyWatcher.recoverFailedWorkerMergeRepairTasks tries resolveIntegrationSyncConflict before stopping integration_sync conflicts",
    "proofType": "TaskConflictRepairProof"
  }
}
```

## 2. Implementation bundle

### Touched files

1. New: `src/core/conflict-resolution.ts`
2. New: `src/commands/repair-conflicts.ts`
3. Changed: `src/types/task.ts`
4. Changed: `src/cli.ts`
5. Changed: `src/core/dependency-watcher.ts`
6. Changed: `src/commands/queue.ts`
7. Changed: `src/core/repair-context.ts`
8. New: `test/conflict-resolution.test.js`
9. Changed: `test/failed-recovery.test.js`

### Apply order

1. Add the new core resolver and proof types.
2. Add CLI command file and wire `src/cli.ts`.
3. Patch dependency watcher to call the resolver before the existing integration-sync stop path.
4. Patch queue/repair-context messaging.
5. Add tests.
6. Run `npm run build`, then `npm test`, then targeted tests listed below.

---

## 3. New file: `src/core/conflict-resolution.ts`

```ts
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type {
  Task,
  TaskConflictRepairProof,
  TaskConflictRepairStrategy,
  TaskMergeConflictPhase,
} from '../types/task';

export const CONFLICT_RESOLVER_VERSION = 'docs-status-v1';

export const DEFAULT_DOCS_CONFLICT_ALLOWLIST = [
  'docs/TODO.md',
  'docs/PROJECT-STATUS.md',
];

export interface ConflictResolverConfigReader {
  get(key: string): unknown;
}

export interface DocsConflictRepairConfig {
  enabled: boolean;
  allowlist: string[];
  maxFiles: number;
  maxBytesPerFile: number;
  requireEvidence: boolean;
  requireExactProbe: boolean;
  llmEnabled: boolean;
}

export interface MergeProbeLike {
  mergeable?: boolean;
  alreadyIntegrated?: boolean;
  message?: string;
  conflictFiles?: string[];
  failurePhase?: TaskMergeConflictPhase;
  integrationBranch?: string;
  integrationWorktree?: string;
}

export interface ResolveIntegrationSyncConflictInput {
  task: Pick<
    Task,
    | 'id'
    | 'mergeConflictFiles'
    | 'mergeConflictPhase'
    | 'integrationBranch'
    | 'integrationWorktree'
  >;
  targetBranch: string;
  conflictFiles?: string[];
  integrationBranch?: string;
  integrationWorktree?: string;
  mergeProbeResult?: MergeProbeLike;
  configManager?: ConflictResolverConfigReader;
  apply?: boolean;
  allowLlm?: boolean;
  triggeredBy?: 'manager' | 'manual' | 'test';
  now?: number;
}

export interface ResolveKnownDocsConflictInput {
  worktreePath: string;
  conflictFiles: string[];
  targetBranch: string;
  integrationBranch?: string;
  taskId?: string;
  config?: DocsConflictRepairConfig;
  apply?: boolean;
  now?: number;
}

export interface MarkdownFact {
  raw: string;
  normalized: string;
  kind: 'heading' | 'todo' | 'bullet' | 'table' | 'paragraph';
}

export interface ConflictFileRepairResult {
  path: string;
  originalSha: string;
  candidateSha: string;
  beforeConflictHunksSha: string;
  conflictHunkCount: number;
  retainedOursFacts: number;
  retainedTheirsFacts: number;
  droppedFacts: string[];
  warnings: string[];
  candidateContent: string;
}

export interface ConflictResolutionResult {
  resolved: boolean;
  applied: boolean;
  status: 'resolved' | 'refused' | 'noop';
  strategy?: TaskConflictRepairStrategy;
  message: string;
  stopReason?: string;
  conflictFiles: string[];
  proof?: TaskConflictRepairProof;
  files?: ConflictFileRepairResult[];
  warnings?: string[];
}

interface ConflictHunk {
  index: number;
  oursLabel: string;
  theirsLabel: string;
  ours: string[];
  base: string[];
  theirs: string[];
  raw: string;
}

interface FileResolution {
  content: string;
  hunks: ConflictHunk[];
  retainedOursFacts: number;
  retainedTheirsFacts: number;
  droppedFacts: string[];
  warnings: string[];
}

function toBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function toPositiveInteger(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function toStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const normalized = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(normalizeRelativePath)
    .filter(Boolean);

  return normalized.length > 0 ? [...new Set(normalized)] : fallback;
}

export function resolveDocsConflictRepairConfig(
  configManager?: ConflictResolverConfigReader,
): DocsConflictRepairConfig {
  return {
    enabled: toBool(configManager?.get('merge.autoResolveDocsConflicts.enabled'), true),
    allowlist: toStringArray(
      configManager?.get('merge.autoResolveDocsConflicts.allowlist'),
      DEFAULT_DOCS_CONFLICT_ALLOWLIST,
    ),
    maxFiles: toPositiveInteger(configManager?.get('merge.autoResolveDocsConflicts.maxFiles'), 3),
    maxBytesPerFile: toPositiveInteger(
      configManager?.get('merge.autoResolveDocsConflicts.maxBytesPerFile'),
      200_000,
    ),
    requireEvidence: toBool(configManager?.get('merge.autoResolveDocsConflicts.requireEvidence'), true),
    requireExactProbe: toBool(configManager?.get('merge.autoResolveDocsConflicts.requireExactProbe'), true),
    llmEnabled: toBool(configManager?.get('merge.autoResolveDocsConflicts.llm.enabled'), false),
  };
}

export async function resolveIntegrationSyncConflict(
  input: ResolveIntegrationSyncConflictInput,
): Promise<ConflictResolutionResult> {
  const config = resolveDocsConflictRepairConfig(input.configManager);
  const apply = Boolean(input.apply);
  const phase = input.mergeProbeResult?.failurePhase ?? input.task.mergeConflictPhase;
  const conflictFiles = uniqueStrings([
    ...(input.conflictFiles ?? []),
    ...(input.mergeProbeResult?.conflictFiles ?? []),
    ...(input.task.mergeConflictFiles ?? []),
  ].map(normalizeRelativePath));
  const integrationWorktree = input.integrationWorktree
    ?? input.mergeProbeResult?.integrationWorktree
    ?? input.task.integrationWorktree;
  const integrationBranch = input.integrationBranch
    ?? input.mergeProbeResult?.integrationBranch
    ?? input.task.integrationBranch;

  if (!config.enabled && input.triggeredBy === 'manager') {
    return refused(
      conflictFiles,
      'docs_conflict_repair_disabled',
      'Docs/status conflict auto-repair is disabled by policy',
    );
  }

  if (phase && phase !== 'integration_sync') {
    return refused(
      conflictFiles,
      'not_integration_sync_conflict',
      `Safe docs resolver only handles integration_sync conflicts, not ${phase}`,
    );
  }

  if (!integrationWorktree || !integrationWorktree.trim()) {
    return refused(
      conflictFiles,
      'missing_integration_worktree',
      'Cannot repair integration sync conflict because integrationWorktree is unknown',
    );
  }

  const worktreePath = path.resolve(integrationWorktree);
  if (!fs.existsSync(worktreePath)) {
    return refused(
      conflictFiles,
      'missing_integration_worktree',
      `Integration worktree does not exist: ${worktreePath}`,
    );
  }

  const gitUnmergedFiles = listUnmergedFiles(worktreePath);
  const effectiveConflictFiles = uniqueStrings([
    ...conflictFiles,
    ...gitUnmergedFiles,
  ].map(normalizeRelativePath));

  const result = resolveKnownDocsConflict({
    worktreePath,
    conflictFiles: effectiveConflictFiles,
    targetBranch: input.targetBranch,
    integrationBranch,
    taskId: input.task.id,
    config,
    apply,
    now: input.now,
  });

  if (!result.resolved && input.allowLlm && !config.llmEnabled) {
    return {
      ...result,
      warnings: [
        ...(result.warnings ?? []),
        'LLM conflict repair was requested but merge.autoResolveDocsConflicts.llm.enabled is false; deterministic resolver only.',
      ],
    };
  }

  if (!result.resolved && input.allowLlm && config.llmEnabled) {
    return {
      ...result,
      warnings: [
        ...(result.warnings ?? []),
        'LLM repair fallback is intentionally stubbed in this first slice; deterministic resolver refused, so manual repair is still required.',
      ],
    };
  }

  return result;
}

export function resolveKnownDocsConflict(input: ResolveKnownDocsConflictInput): ConflictResolutionResult {
  const config = input.config ?? resolveDocsConflictRepairConfig();
  const conflictFiles = uniqueStrings(input.conflictFiles.map(normalizeRelativePath));
  const allowlist = new Set(config.allowlist.map(normalizeRelativePath));
  const now = input.now ?? Date.now();

  if (conflictFiles.length === 0) {
    return refused([], 'no_conflict_files', 'No conflict files were reported or found');
  }

  if (conflictFiles.length > config.maxFiles) {
    return refused(
      conflictFiles,
      'docs_conflict_repair_too_many_files',
      `Docs conflict repair is limited to ${config.maxFiles} file(s); saw ${conflictFiles.length}`,
    );
  }

  const nonAllowlisted = conflictFiles.filter((file) => !allowlist.has(file));
  if (nonAllowlisted.length > 0) {
    return refused(
      conflictFiles,
      'docs_conflict_repair_not_allowlisted',
      `Refusing deterministic docs repair because non-allowlisted conflict file(s) are present: ${nonAllowlisted.join(', ')}`,
    );
  }

  const fileResults: ConflictFileRepairResult[] = [];
  const warnings: string[] = [];
  const droppedFacts: string[] = [];

  for (const relativePath of conflictFiles) {
    const filePath = safeJoin(input.worktreePath, relativePath);
    if (!fs.existsSync(filePath)) {
      return refused(conflictFiles, 'docs_conflict_file_missing', `Conflict file is missing: ${relativePath}`);
    }

    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return refused(conflictFiles, 'docs_conflict_file_not_regular', `Conflict path is not a regular file: ${relativePath}`);
    }

    if (stats.size > config.maxBytesPerFile) {
      return refused(
        conflictFiles,
        'docs_conflict_file_too_large',
        `Conflict file ${relativePath} is ${stats.size} bytes, above limit ${config.maxBytesPerFile}`,
      );
    }

    const original = fs.readFileSync(filePath);
    if (original.includes(0)) {
      return refused(conflictFiles, 'docs_conflict_binary_file', `Conflict file appears binary: ${relativePath}`);
    }

    const originalText = original.toString('utf8');
    let resolution: FileResolution;
    try {
      resolution = resolveKnownDocsConflictFile(relativePath, originalText);
    } catch (error) {
      return refused(
        conflictFiles,
        'docs_conflict_parse_failed',
        `Could not parse conflict markers in ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (resolution.hunks.length === 0) {
      return refused(
        conflictFiles,
        'docs_conflict_markers_missing',
        `No Git conflict markers found in ${relativePath}; refusing to guess`,
      );
    }

    if (containsConflictMarkers(resolution.content)) {
      return refused(
        conflictFiles,
        'docs_conflict_markers_remain',
        `Resolved candidate for ${relativePath} still contains conflict markers`,
      );
    }

    if (config.requireEvidence && resolution.droppedFacts.length > 0) {
      return refused(
        conflictFiles,
        'docs_conflict_evidence_retention_failed',
        `Resolved candidate for ${relativePath} did not retain all side facts`,
      );
    }

    warnings.push(...resolution.warnings.map((warning) => `${relativePath}: ${warning}`));
    droppedFacts.push(...resolution.droppedFacts.map((fact) => `${relativePath}: ${fact}`));

    fileResults.push({
      path: relativePath,
      originalSha: sha256(originalText),
      candidateSha: sha256(resolution.content),
      beforeConflictHunksSha: sha256(resolution.hunks.map((hunk) => hunk.raw).join('\n---ralph-conflict-hunk---\n')),
      conflictHunkCount: resolution.hunks.length,
      retainedOursFacts: resolution.retainedOursFacts,
      retainedTheirsFacts: resolution.retainedTheirsFacts,
      droppedFacts: resolution.droppedFacts,
      warnings: resolution.warnings,
      candidateContent: resolution.content,
    });
  }

  const proof = buildConflictRepairProof({
    taskId: input.taskId,
    phase: 'integration_sync',
    strategy: strategyForFiles(conflictFiles),
    conflictFiles,
    worktreePath: input.worktreePath,
    integrationBranch: input.integrationBranch,
    targetBranch: input.targetBranch,
    fileResults,
    warnings,
    droppedFacts,
    observedAt: now,
  });

  if (!input.apply) {
    return {
      resolved: true,
      applied: false,
      status: 'resolved',
      strategy: proof.strategy,
      message: `Dry-run: deterministic docs repair is eligible for ${conflictFiles.join(', ')}`,
      conflictFiles,
      proof,
      files: fileResults,
      warnings,
    };
  }

  for (const fileResult of fileResults) {
    fs.writeFileSync(safeJoin(input.worktreePath, fileResult.path), fileResult.candidateContent, 'utf8');
  }

  git(input.worktreePath, ['add', '--', ...conflictFiles]);

  const remainingUnmerged = listUnmergedFiles(input.worktreePath);
  if (remainingUnmerged.length > 0) {
    return refused(
      conflictFiles,
      'docs_conflict_unmerged_files_remain',
      `Unmerged files remain after staging docs repair: ${remainingUnmerged.join(', ')}`,
      proof,
      fileResults,
      warnings,
    );
  }

  const diffCheck = gitMaybe(input.worktreePath, ['diff', '--check', '--', ...conflictFiles]);
  if (diffCheck.status !== 0) {
    return refused(
      conflictFiles,
      'docs_conflict_diff_check_failed',
      `git diff --check failed after docs conflict repair: ${diffCheck.stderr || diffCheck.stdout}`,
      proof,
      fileResults,
      warnings,
    );
  }

  const commitMessage = [
    'Resolve Ralph integration sync docs conflicts',
    '',
    `Strategy: ${proof.strategy}`,
    `Files: ${conflictFiles.join(', ')}`,
    `Resolver: ${CONFLICT_RESOLVER_VERSION}`,
  ].join('\n');

  let commitSha = gitMaybe(input.worktreePath, ['rev-parse', 'HEAD']).stdout || undefined;
  const stagedChanges = gitMaybe(input.worktreePath, ['diff', '--cached', '--name-only']).stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (stagedChanges.length > 0 || isMergeInProgress(input.worktreePath)) {
    const commit = gitMaybe(input.worktreePath, ['commit', '-m', commitMessage]);
    if (commit.status !== 0) {
      return refused(
        conflictFiles,
        'docs_conflict_commit_failed',
        `Could not commit docs conflict repair: ${commit.stderr || commit.stdout}`,
        proof,
        fileResults,
        warnings,
      );
    }
    commitSha = git(input.worktreePath, ['rev-parse', 'HEAD']);
  } else {
    warnings.push('Resolved content matched the current index; no new commit was created.');
  }

  const appliedProof: TaskConflictRepairProof = {
    ...proof,
    commitSha,
    warnings,
  };

  return {
    resolved: true,
    applied: true,
    status: 'resolved',
    strategy: appliedProof.strategy,
    message: `Applied deterministic docs conflict repair for ${conflictFiles.join(', ')}`,
    conflictFiles,
    proof: appliedProof,
    files: fileResults.map((file) => ({ ...file, candidateContent: '' })),
    warnings,
  };
}

export function resolveKnownDocsConflictFile(relativePath: string, content: string): FileResolution {
  const endsWithNewline = /\r?\n$/.test(content);
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (endsWithNewline) {
    lines.pop();
  }

  const output: string[] = [];
  const hunks: ConflictHunk[] = [];
  const warnings: string[] = [];
  let retainedOursFacts = 0;
  let retainedTheirsFacts = 0;
  const droppedFacts: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith('<<<<<<<')) {
      output.push(line);
      continue;
    }

    const hunkStart = index;
    const oursLabel = line.replace(/^<<<<<<<\s*/, '').trim() || 'ours';
    const ours: string[] = [];
    const base: string[] = [];
    const theirs: string[] = [];
    let mode: 'ours' | 'base' | 'theirs' = 'ours';
    let theirsLabel = 'theirs';
    let closed = false;

    index += 1;
    for (; index < lines.length; index += 1) {
      const current = lines[index];
      if (current.startsWith('|||||||')) {
        mode = 'base';
        continue;
      }
      if (current.startsWith('=======')) {
        mode = 'theirs';
        continue;
      }
      if (current.startsWith('>>>>>>>')) {
        theirsLabel = current.replace(/^>>>>>>>\s*/, '').trim() || 'theirs';
        closed = true;
        break;
      }

      if (mode === 'ours') {
        ours.push(current);
      } else if (mode === 'base') {
        base.push(current);
      } else {
        theirs.push(current);
      }
    }

    if (!closed) {
      throw new Error(`unclosed conflict marker starting at line ${hunkStart + 1}`);
    }

    const raw = lines.slice(hunkStart, index + 1).join('\n');
    const hunk: ConflictHunk = {
      index: hunks.length,
      oursLabel,
      theirsLabel,
      ours,
      base,
      theirs,
      raw,
    };
    hunks.push(hunk);

    const merged = mergeConflictSides(relativePath, hunk);
    output.push(...merged.lines);
    warnings.push(...merged.warnings);

    const verification = verifyUniqueFactsRetained(
      extractFacts(ours).map((fact) => fact.raw),
      extractFacts(theirs).map((fact) => fact.raw),
      merged.lines.join('\n'),
    );
    retainedOursFacts += verification.retainedOursFacts;
    retainedTheirsFacts += verification.retainedTheirsFacts;
    droppedFacts.push(...verification.droppedFacts);
  }

  return {
    content: `${output.join('\n')}${endsWithNewline ? '\n' : ''}`,
    hunks,
    retainedOursFacts,
    retainedTheirsFacts,
    droppedFacts,
    warnings,
  };
}

export function parseTodoMarkdown(markdown: string): MarkdownFact[] {
  return extractFacts(splitLines(markdown));
}

export function parseProjectStatus(markdown: string): MarkdownFact[] {
  return extractFacts(splitLines(markdown));
}

export function mergeTodoDocuments(ours: string, theirs: string): string {
  return tidyMarkdownLines(unionMarkdownLines(splitLines(ours), splitLines(theirs))).join('\n');
}

export function mergeProjectStatusDocuments(ours: string, theirs: string): string {
  const oursLines = splitLines(ours);
  const theirsLines = splitLines(theirs);

  if (isSimpleMarkdownBlock(oursLines) && isSimpleMarkdownBlock(theirsLines)) {
    return tidyMarkdownLines(unionMarkdownLines(oursLines, theirsLines)).join('\n');
  }

  return buildPreservationBlock('PROJECT-STATUS.md', 'integration branch', oursLines, 'merge target', theirsLines).join('\n');
}

export function verifyNoConflictMarkers(content: string): boolean {
  return !containsConflictMarkers(content);
}

export function verifyUniqueFactsRetained(
  oursFactsInput: string[],
  theirsFactsInput: string[],
  output: string,
): { retainedOursFacts: number; retainedTheirsFacts: number; droppedFacts: string[] } {
  const normalizedOutput = normalizeFact(output);
  const oursFacts = uniqueStrings(oursFactsInput.map(normalizeFact).filter(Boolean));
  const theirsFacts = uniqueStrings(theirsFactsInput.map(normalizeFact).filter(Boolean));
  const droppedOurs = oursFacts.filter((fact) => !normalizedOutput.includes(fact));
  const droppedTheirs = theirsFacts.filter((fact) => !normalizedOutput.includes(fact));

  return {
    retainedOursFacts: oursFacts.length - droppedOurs.length,
    retainedTheirsFacts: theirsFacts.length - droppedTheirs.length,
    droppedFacts: [
      ...droppedOurs.map((fact) => `ours:${fact}`),
      ...droppedTheirs.map((fact) => `theirs:${fact}`),
    ],
  };
}

export function buildConflictRepairProof(input: {
  taskId?: string;
  phase: TaskMergeConflictPhase;
  strategy: TaskConflictRepairStrategy;
  conflictFiles: string[];
  worktreePath: string;
  integrationBranch?: string;
  targetBranch: string;
  fileResults: ConflictFileRepairResult[];
  warnings: string[];
  droppedFacts: string[];
  observedAt: number;
}): TaskConflictRepairProof {
  const gitMetadata = readGitMergeMetadata(input.worktreePath);

  return {
    taskId: input.taskId,
    observedAt: input.observedAt,
    phase: input.phase,
    strategy: input.strategy,
    conflictFiles: input.conflictFiles,
    integrationBranch: input.integrationBranch,
    integrationWorktree: input.worktreePath,
    targetBranch: input.targetBranch,
    baseSha: gitMetadata.baseSha,
    oursSha: gitMetadata.oursSha,
    theirsSha: gitMetadata.theirsSha,
    resolverVersion: CONFLICT_RESOLVER_VERSION,
    beforeConflictHunksSha: sha256(input.fileResults.map((file) => `${file.path}:${file.beforeConflictHunksSha}`).join('\n')),
    afterFilesSha: sha256(input.fileResults.map((file) => `${file.path}:${file.candidateSha}`).join('\n')),
    retainedOursFacts: input.fileResults.reduce((sum, file) => sum + file.retainedOursFacts, 0),
    retainedTheirsFacts: input.fileResults.reduce((sum, file) => sum + file.retainedTheirsFacts, 0),
    droppedFacts: input.droppedFacts,
    warnings: input.warnings,
    validationCommands: [
      `git diff --check -- ${input.conflictFiles.join(' ')}`,
      'git diff --name-only --diff-filter=U',
      'Ralph exact worktree mergeability probe after repair',
    ],
  };
}

function mergeConflictSides(relativePath: string, hunk: ConflictHunk): { lines: string[]; warnings: string[] } {
  const normalizedPath = normalizeRelativePath(relativePath);
  const warnings: string[] = [];

  if (normalizedPath === 'docs/TODO.md') {
    const lines = tidyMarkdownLines(unionMarkdownLines(hunk.ours, hunk.theirs));
    return { lines, warnings };
  }

  if (normalizedPath === 'docs/PROJECT-STATUS.md') {
    const oursSimple = isSimpleMarkdownBlock(hunk.ours);
    const theirsSimple = isSimpleMarkdownBlock(hunk.theirs);

    if (oursSimple && theirsSimple) {
      return { lines: tidyMarkdownLines(unionMarkdownLines(hunk.ours, hunk.theirs)), warnings };
    }

    warnings.push('non-list status conflict preserved in an explicit Ralph evidence block instead of choosing one side');
    return {
      lines: buildPreservationBlock(
        'PROJECT-STATUS.md',
        hunk.oursLabel || 'integration branch',
        hunk.ours,
        hunk.theirsLabel || 'merge target',
        hunk.theirs,
      ),
      warnings,
    };
  }

  throw new Error(`unsupported docs conflict path: ${relativePath}`);
}

function unionMarkdownLines(ours: string[], theirs: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const line of [...stripOuterBlankLines(ours), ...stripOuterBlankLines(theirs)]) {
    const normalized = normalizeLineForDedup(line);
    if (!normalized) {
      if (result.length > 0 && result[result.length - 1] !== '') {
        result.push('');
      }
      continue;
    }

    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(line);
  }

  return result;
}

function buildPreservationBlock(
  documentLabel: string,
  oursLabel: string,
  ours: string[],
  theirsLabel: string,
  theirs: string[],
): string[] {
  return tidyMarkdownLines([
    '',
    `<!-- Ralph deterministic docs resolver preserved both sides of a ${documentLabel} integration-sync conflict. -->`,
    '### Ralph preserved integration-sync status facts',
    '',
    `#### ${oursLabel}`,
    ...quoteMarkdownLines(stripOuterBlankLines(ours)),
    '',
    `#### ${theirsLabel}`,
    ...quoteMarkdownLines(stripOuterBlankLines(theirs)),
    '',
  ]);
}

function quoteMarkdownLines(lines: string[]): string[] {
  if (lines.length === 0) {
    return ['> (empty side)'];
  }

  return lines.map((line) => line.trim() ? `> ${line}` : '>');
}

function extractFacts(lines: string[]): MarkdownFact[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith('<!-- Ralph deterministic docs resolver'))
    .map((line) => ({
      raw: line.replace(/^>\s?/, '').trim(),
      normalized: normalizeFact(line),
      kind: classifyMarkdownFact(line),
    }))
    .filter((fact) => fact.normalized.length > 0);
}

function classifyMarkdownFact(line: string): MarkdownFact['kind'] {
  const trimmed = line.trim();
  if (/^#{1,6}\s+/.test(trimmed)) {
    return 'heading';
  }
  if (/^[-*+]\s+\[[ xX-]\]/.test(trimmed)) {
    return 'todo';
  }
  if (/^([-*+]\s+|\d+\.\s+)/.test(trimmed)) {
    return 'bullet';
  }
  if (/^\|.*\|$/.test(trimmed)) {
    return 'table';
  }
  return 'paragraph';
}

function isSimpleMarkdownBlock(lines: string[]): boolean {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .every((line) => (
      /^#{1,6}\s+/.test(line)
      || /^([-*+]\s+|\d+\.\s+)/.test(line)
      || /^\|.*\|$/.test(line)
      || /^`{3}/.test(line)
      || /^>\s*/.test(line)
    ));
}

function tidyMarkdownLines(lines: string[]): string[] {
  const result: string[] = [];
  for (const line of stripOuterBlankLines(lines)) {
    if (line === '' && result[result.length - 1] === '') {
      continue;
    }
    result.push(line);
  }
  return stripOuterBlankLines(result);
}

function stripOuterBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') {
    start += 1;
  }
  while (end > start && lines[end - 1].trim() === '') {
    end -= 1;
  }
  return lines.slice(start, end);
}

function splitLines(value: string): string[] {
  if (!value) {
    return [];
  }
  return value.replace(/\r\n/g, '\n').split('\n');
}

function containsConflictMarkers(content: string): boolean {
  return /^(<<<<<<<|=======|>>>>>>>)(\s|$)/m.test(content);
}

function normalizeFact(value: string): string {
  return value
    .replace(/^>\s?/gm, '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeLineForDedup(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeRelativePath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/')
    .trim();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function safeJoin(root: string, relativePath: string): string {
  const normalizedRoot = path.resolve(root);
  const candidate = path.resolve(normalizedRoot, relativePath);
  if (candidate !== normalizedRoot && !candidate.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`unsafe path outside worktree: ${relativePath}`);
  }
  return candidate;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function strategyForFiles(files: string[]): TaskConflictRepairStrategy {
  const fileSet = new Set(files.map(normalizeRelativePath));
  if (fileSet.has('docs/TODO.md') || fileSet.has('docs/PROJECT-STATUS.md')) {
    return 'deterministic_project_status_todo';
  }
  return 'markdown_union';
}

function git(worktreePath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: worktreePath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitMaybe(worktreePath: string, args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    return { status: 0, stdout: git(worktreePath, args), stderr: '' };
  } catch (error) {
    const anyError = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return {
      status: typeof anyError.status === 'number' ? anyError.status : 1,
      stdout: Buffer.isBuffer(anyError.stdout) ? anyError.stdout.toString('utf8') : String(anyError.stdout ?? ''),
      stderr: Buffer.isBuffer(anyError.stderr) ? anyError.stderr.toString('utf8') : String(anyError.stderr ?? anyError.message ?? ''),
    };
  }
}

function listUnmergedFiles(worktreePath: string): string[] {
  const result = gitMaybe(worktreePath, ['diff', '--name-only', '--diff-filter=U']);
  if (result.status !== 0) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => normalizeRelativePath(line.trim()))
    .filter(Boolean);
}

function readGitMergeMetadata(worktreePath: string): {
  baseSha?: string;
  oursSha?: string;
  theirsSha?: string;
} {
  const oursSha = gitMaybe(worktreePath, ['rev-parse', 'HEAD']).stdout || undefined;
  const theirsSha = gitMaybe(worktreePath, ['rev-parse', 'MERGE_HEAD']).stdout || undefined;
  const baseSha = oursSha && theirsSha
    ? gitMaybe(worktreePath, ['merge-base', oursSha, theirsSha]).stdout || undefined
    : undefined;

  return { baseSha, oursSha, theirsSha };
}

function isMergeInProgress(worktreePath: string): boolean {
  const gitDirResult = gitMaybe(worktreePath, ['rev-parse', '--git-dir']);
  if (gitDirResult.status !== 0 || !gitDirResult.stdout) {
    return false;
  }

  const gitDir = path.isAbsolute(gitDirResult.stdout)
    ? gitDirResult.stdout
    : path.resolve(worktreePath, gitDirResult.stdout);
  return fs.existsSync(path.join(gitDir, 'MERGE_HEAD'));
}

function refused(
  conflictFiles: string[],
  stopReason: string,
  message: string,
  proof?: TaskConflictRepairProof,
  files?: ConflictFileRepairResult[],
  warnings?: string[],
): ConflictResolutionResult {
  return {
    resolved: false,
    applied: false,
    status: 'refused',
    stopReason,
    message,
    conflictFiles,
    proof,
    files,
    warnings,
  };
}
```

---

## 4. New file: `src/commands/repair-conflicts.ts`

```ts
import { ConfigManager } from '../config/manager';
import { appendTaskEvent } from '../core/events';
import { resolveIntegrationPolicy } from '../core/integration-policy';
import { probeTaskWorktreeMergeability } from '../core/merge';
import { buildMergeRepairProof, deriveMergeRepairDisplayStatus } from '../core/merge-task-updates';
import { StateManager } from '../core/state';
import { resolveIntegrationSyncConflict } from '../core/conflict-resolution';
import type { Task, TaskConflictRepairProof } from '../types/task';

interface RepairConflictsCommandOptions {
  dryRun?: boolean;
  apply?: boolean;
  json?: boolean;
  allowLlm?: boolean;
}

function serializeProbe(probe?: Awaited<ReturnType<typeof probeTaskWorktreeMergeability>>) {
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
  probe?: Awaited<ReturnType<typeof probeTaskWorktreeMergeability>>,
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

function compactRepairResult(result: Awaited<ReturnType<typeof resolveIntegrationSyncConflict>>) {
  return {
    ...result,
    files: result.files?.map((file) => ({
      path: file.path,
      originalSha: file.originalSha,
      candidateSha: file.candidateSha,
      beforeConflictHunksSha: file.beforeConflictHunksSha,
      conflictHunkCount: file.conflictHunkCount,
      retainedOursFacts: file.retainedOursFacts,
      retainedTheirsFacts: file.retainedTheirsFacts,
      droppedFacts: file.droppedFacts,
      warnings: file.warnings,
    })),
  };
}

async function initialProbeForTask(
  task: Task,
  configManager: ConfigManager,
): Promise<Awaited<ReturnType<typeof probeTaskWorktreeMergeability>> | undefined> {
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

    let postRepairProbe: Awaited<ReturnType<typeof probeTaskWorktreeMergeability>> | undefined;
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
    process.exit(1);
  }
}
```

---

## 5. Patch: `src/types/task.ts`

```diff
@@
 export type TaskMergeRepairDisplayStatus = 'unresolved' | 'resolved_pending_finalize' | 'probe_mergeable' | 'requeued' | 'stopped';
 export type TaskMergeProofSourceKind = 'branch_head' | 'worktree_snapshot' | 'resolved_pending_merge';
 export type TaskWorktreeMergeStateKind = 'none' | 'unresolved' | 'resolved_pending_commit';
 export type TaskMergeConflictPhase = 'integration_sync' | 'source_merge' | 'worktree_unresolved';
+export type TaskConflictRepairStrategy =
+  | 'deterministic_project_status_todo'
+  | 'markdown_union'
+  | 'llm_patch'
+  | 'manual';
@@
 export interface TaskMergeRepairProof {
   observedAt: number;
   sourceKind?: TaskMergeProofSourceKind;
   worktreeMergeKind?: TaskWorktreeMergeStateKind;
   failurePhase?: TaskMergeConflictPhase;
@@
   integrationBranch?: string;
 }
+
+export interface TaskConflictRepairProof {
+  taskId?: string;
+  observedAt: number;
+  phase: TaskMergeConflictPhase;
+  strategy: TaskConflictRepairStrategy;
+  conflictFiles: string[];
+  integrationBranch?: string;
+  integrationWorktree?: string;
+  targetBranch?: string;
+  baseSha?: string;
+  oursSha?: string;
+  theirsSha?: string;
+  resolverVersion: string;
+  beforeConflictHunksSha: string;
+  afterFilesSha: string;
+  retainedOursFacts: number;
+  retainedTheirsFacts: number;
+  droppedFacts: string[];
+  warnings?: string[];
+  validationCommands?: string[];
+  exactProbe?: {
+    mergeable: boolean;
+    alreadyIntegrated: boolean;
+    message: string;
+    conflictFiles?: string[];
+    failurePhase?: TaskMergeConflictPhase;
+  };
+  commitSha?: string;
+}
@@
   mergeRepairDisplayStatus?: TaskMergeRepairDisplayStatus;
   mergeRepairProof?: TaskMergeRepairProof;
+  conflictRepairProof?: TaskConflictRepairProof;
+  conflictRepairProofs?: TaskConflictRepairProof[];
   mergeRepairRecoveryStartedAt?: number;
```

---

## 6. Patch: `src/cli.ts`

```diff
@@
 import { retryCommand } from './commands/retry';
+import { repairConflictsCommand } from './commands/repair-conflicts';
 import { resetStagnationCommand } from './commands/reset-stagnation';
@@
 program
   .command('retry <task-id>')
@@
   .action(retryCommand);
+
+program
+  .command('repair-conflicts <task-id>')
+  .description('Safely repair allowlisted docs/status integration-sync conflicts')
+  .option('--dry-run', 'Inspect deterministic docs repair without writing files')
+  .option('--apply', 'Apply deterministic docs repair, commit it, and record proof')
+  .option('--json', 'Emit compact JSON')
+  .option('--allow-llm', 'Allow optional LLM fallback when configured; deterministic resolver remains first')
+  .addHelpText('after', `
+Examples:
+  $ ralph repair-conflicts task-1778924163997-o2q8jdxkx --dry-run
+  $ ralph repair-conflicts task-1778924163997-o2q8jdxkx --apply
+
+Description:
+  Repairs only narrow, allowlisted docs/status conflicts such as docs/TODO.md
+  and docs/PROJECT-STATUS.md. The command preserves both sides' facts and
+  refuses code/config/schema/security/lockfile conflicts.`)
+  .action(repairConflictsCommand);
```

---

## 7. Patch: `src/core/dependency-watcher.ts`

```diff
@@
 import {
   buildSuccessfulMergeTaskUpdates,
   buildMergeRepairObservationSignature,
   buildMergeRepairProof,
   deriveMergeRepairDisplayStatus,
 } from './merge-task-updates';
+import { resolveIntegrationSyncConflict } from './conflict-resolution';
@@
   cleanupWorktreeProcesses?: typeof cleanupWorktreeProcesses;
   reclamationService?: Pick<ReclamationService, 'run' | 'isAutomaticReclamationEnabled' | 'getIntervalMs' | 'getStartupDelayMs' | 'getCleanTerminalSweepIntervalMs'>;
+  resolveIntegrationSyncConflict?: typeof resolveIntegrationSyncConflict;
   statfs?: (path: string) => DiskStatFs;
   lifecycle?: DependencyWatcherLifecycleHooks;
 }
@@
   private readonly cleanupWorktreeProcessesFn: typeof cleanupWorktreeProcesses;
+  private readonly resolveIntegrationSyncConflictFn: typeof resolveIntegrationSyncConflict;
   private readonly reclamationService: Pick<ReclamationService, 'run' | 'isAutomaticReclamationEnabled' | 'getIntervalMs' | 'getStartupDelayMs' | 'getCleanTerminalSweepIntervalMs'>;
@@
     this.repairTaskWorktreeDependencyBootstrapFn = deps.repairTaskWorktreeDependencyBootstrap ?? repairTaskWorktreeDependencyBootstrap;
     this.cleanupWorktreeProcessesFn = deps.cleanupWorktreeProcesses ?? cleanupWorktreeProcesses;
+    this.resolveIntegrationSyncConflictFn = deps.resolveIntegrationSyncConflict ?? resolveIntegrationSyncConflict;
     this.reclamationService = deps.reclamationService ?? new ReclamationService({ stateManager, configManager });
```

Replace the current `integrationSyncConflict` stop block in `recoverFailedWorkerMergeRepairTasks()`:

```diff
@@
       const integrationSyncConflict = mergeProbeResult.failurePhase === 'integration_sync';
       let stopReason: string | undefined;
       let stopMessage: string | undefined;
 
       if (integrationSyncConflict) {
-        stopReason = 'merge_repair_integration_sync_conflict';
-        stopMessage = 'Integration branch sync conflict must be resolved before task merge repair can continue';
+        const docsRepair = await this.resolveIntegrationSyncConflictFn({
+          task,
+          targetBranch: integrationPolicy.targetBranch,
+          conflictFiles: mergeProbeResult.conflictFiles,
+          integrationBranch: mergeProbeResult.integrationBranch,
+          integrationWorktree: mergeProbeResult.integrationWorktree,
+          mergeProbeResult,
+          configManager: this.configManager,
+          apply: true,
+          triggeredBy: 'manager',
+          now,
+        });
+
+        if (docsRepair.resolved) {
+          let postRepairProbe: Awaited<ReturnType<typeof probeTaskWorktreeMergeability>> | undefined;
+          try {
+            postRepairProbe = await this.probeWorktreeMergeability(task, integrationPolicy.targetBranch, {
+              pullLatest: integrationPolicy.pullLatest,
+              integrationWorktreeDir: integrationPolicy.integrationWorktreeDir,
+              syncTargetBranch: false,
+            });
+          } catch (error) {
+            this.logger.error(
+              `Exact post-repair mergeability probe failed for ${task.id}: ${error instanceof Error ? error.message : String(error)}`,
+            );
+          }
+
+          const postRepairClean = Boolean(postRepairProbe?.alreadyIntegrated || postRepairProbe?.mergeable);
+          const proof = docsRepair.proof
+            ? {
+                ...docsRepair.proof,
+                exactProbe: postRepairProbe
+                  ? {
+                      mergeable: postRepairProbe.mergeable,
+                      alreadyIntegrated: postRepairProbe.alreadyIntegrated,
+                      message: postRepairProbe.message,
+                      conflictFiles: postRepairProbe.conflictFiles,
+                      failurePhase: postRepairProbe.failurePhase,
+                    }
+                  : undefined,
+              }
+            : undefined;
+
+          if (postRepairProbe && !postRepairClean && postRepairProbe.failurePhase === 'integration_sync') {
+            stopReason = 'merge_repair_integration_sync_conflict_post_repair_probe_failed';
+            stopMessage = `Docs conflict repair applied but exact integration-sync probe still failed: ${postRepairProbe.message}`;
+          } else {
+            const previousProofs = task.conflictRepairProofs ?? [];
+            await this.stateManager.updateTask(task.id, {
+              ...commonUpdates,
+              conflictRepairProof: proof,
+              conflictRepairProofs: proof ? [...previousProofs, proof].slice(-20) : previousProofs,
+              mergeRepairDisplayStatus: postRepairProbe
+                ? deriveMergeRepairDisplayStatus(postRepairProbe)
+                : commonUpdates.mergeRepairDisplayStatus,
+              mergeRepairProof: postRepairProbe
+                ? buildMergeRepairProof(postRepairProbe, now)
+                : commonUpdates.mergeRepairProof,
+              mergeError: postRepairClean ? undefined : postRepairProbe?.message ?? commonUpdates.mergeError,
+              mergeConflictFiles: postRepairClean ? undefined : postRepairProbe?.conflictFiles ?? commonUpdates.mergeConflictFiles,
+              mergeConflictPhase: postRepairClean ? undefined : postRepairProbe?.failurePhase ?? commonUpdates.mergeConflictPhase,
+              mergeConflictAt: postRepairClean ? undefined : commonUpdates.mergeConflictAt,
+              integrationBranch: postRepairProbe?.integrationBranch ?? mergeProbeResult.integrationBranch,
+              integrationWorktree: postRepairProbe?.integrationWorktree ?? mergeProbeResult.integrationWorktree,
+              mergeRepairRecoveryStoppedAt: undefined,
+              mergeRepairRecoveryStopReason: undefined,
+              autoRecoveryKind: 'merge_repair',
+              autoRecoveryStoppedAt: undefined,
+              autoRecoveryStopReason: undefined,
+              autoRecoveryLastReason: docsRepair.message,
+            });
+            appendTaskEvent(task, {
+              type: 'integration_sync_conflict_auto_resolved',
+              status: task.status,
+              storyId: repairStoryId,
+              message: docsRepair.message,
+              data: {
+                strategy: docsRepair.strategy,
+                conflictFiles: docsRepair.conflictFiles,
+                proof,
+                exactProbeMessage: postRepairProbe?.message,
+                exactProbeClean: postRepairClean,
+              },
+            });
+            this.logger.log(`Task ${task.id} repaired allowlisted docs integration-sync conflict (${docsRepair.conflictFiles.join(', ')})`);
+            continue;
+          }
+        } else {
+          stopReason = docsRepair.stopReason ?? 'merge_repair_integration_sync_conflict';
+          stopMessage = docsRepair.message ?? 'Integration branch sync conflict must be resolved before task merge repair can continue';
+        }
       } else if (currentTotalRequeues >= repairConfig.repairHardCap || currentAutoRequeues >= repairConfig.repairHardCap) {
         stopReason = 'merge_repair_hard_cap_reached';
         stopMessage = 'Worker merge repair hard cap reached';
       }
```

This candidate deliberately lets the next manager loop reuse the existing clean-probe recovery path instead of duplicating the large story-completion promotion block. Ralph can later factor that block into a helper to promote immediately.

---

## 8. Patch: `src/commands/queue.ts`

```diff
@@
     if (task.mergeConflictPhase === 'integration_sync') {
-      return 'resolve the integration branch sync conflict, then retry the blocked task';
+      return `run ralph repair-conflicts ${task.id} --dry-run; if only allowlisted docs/status conflicts are reported, run --apply, then let manager re-probe or retry the blocked task`;
     }
```

The policy object should continue to say `prohibitedAction: automatic conflict winner selection`; this change does not permit winner selection. It just adds a safe command path.

---

## 9. Patch: `src/core/repair-context.ts`

```diff
@@
   if (task.mergeConflictPhase === 'integration_sync') {
+    const docsConflictHint = task.mergeConflictFiles?.every((file) => (
+      file === 'docs/TODO.md' || file === 'docs/PROJECT-STATUS.md'
+    ))
+      ? ' These conflicts are in Ralph allowlisted status docs; first try `ralph repair-conflicts <task-id> --dry-run` / `--apply` to run deterministic fact-preserving docs repair.'
+      : '';
+
     return [
       'Integration branch sync repair required by Ralph.',
       `Conflict files: ${conflictFiles}.`,
       `Integration target: ${integrationTarget}.`,
       'The integration branch cannot sync the merge target before this task is checked.',
       'Resolve the conflict between the integration branch and the merge target first; editing only the task branch may not change the probe result.',
+      docsConflictHint.trim() || undefined,
       'Do not compare against origin/main unless it is the configured merge target.',
       task.mergeError || task.lastError ? `Original merge error: ${task.mergeError || task.lastError}` : undefined,
     ].filter(Boolean).join(' ');
   }
```

---

## 10. New file: `test/conflict-resolution.test.js`

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  mergeProjectStatusDocuments,
  mergeTodoDocuments,
  resolveIntegrationSyncConflict,
  verifyNoConflictMarkers,
} = require('../dist/core/conflict-resolution.js');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-docs-conflict-'));
  git(repoDir, ['init', '-b', 'main']);
  git(repoDir, ['config', 'user.name', 'Ralph Test']);
  git(repoDir, ['config', 'user.email', 'ralph@example.com']);
  fs.mkdirSync(path.join(repoDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'base\n');
  git(repoDir, ['add', 'README.md']);
  git(repoDir, ['commit', '-m', 'base']);
  return repoDir;
}

function createTask(repoDir, overrides = {}) {
  return {
    id: 'task-doc-conflict',
    status: 'failed',
    prdPath: path.join(repoDir, 'prd.json'),
    startTime: 1,
    completedUS: ['US-001'],
    worktree: repoDir,
    logPath: path.join(repoDir, 'agent.log'),
    agent: 'codex',
    repoPath: repoDir,
    loopCount: 0,
    consecutiveNoProgress: 0,
    consecutiveErrors: 0,
    lastProgressTime: 1,
    lastFilesChanged: 0,
    mergeConflictPhase: 'integration_sync',
    integrationBranch: 'ralph/integration/main',
    integrationWorktree: repoDir,
    ...overrides,
  };
}

test('mergeTodoDocuments preserves both sides and does not pick a checkbox winner', () => {
  const merged = mergeTodoDocuments(
    '- [x] Release cache provider guardrails validated\n- [ ] Keep existing target TODO',
    '- [ ] Release cache provider guardrails blocked pending QA\n- [ ] Keep task TODO',
  );

  assert.match(merged, /Release cache provider guardrails validated/);
  assert.match(merged, /Release cache provider guardrails blocked pending QA/);
  assert.match(merged, /Keep existing target TODO/);
  assert.match(merged, /Keep task TODO/);
});

test('mergeProjectStatusDocuments preserves non-list status facts in an explicit evidence block', () => {
  const merged = mergeProjectStatusDocuments(
    'Release cache provider guardrails integrated.\nTarget branch remains stable.',
    'QA cost-aware UI is pending after integration sync repair.',
  );

  assert.match(merged, /Ralph preserved integration-sync status facts/);
  assert.match(merged, /Release cache provider guardrails integrated/);
  assert.match(merged, /QA cost-aware UI is pending/);
});

test('resolveIntegrationSyncConflict applies allowlisted docs repair and commits proof', async () => {
  const repoDir = createRepo();
  try {
    fs.writeFileSync(path.join(repoDir, 'docs', 'TODO.md'), [
      '# TODO',
      '<<<<<<< HEAD',
      '- [ ] Keep target TODO',
      '=======',
      '- [ ] Keep task TODO',
      '>>>>>>> task',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(repoDir, 'docs', 'PROJECT-STATUS.md'), [
      '# Project Status',
      '<<<<<<< HEAD',
      '- Target status fact',
      '=======',
      '- Task status fact',
      '>>>>>>> task',
      '',
    ].join('\n'));
    git(repoDir, ['add', 'docs/TODO.md', 'docs/PROJECT-STATUS.md']);
    git(repoDir, ['commit', '-m', 'add conflicted docs fixture']);

    const task = createTask(repoDir, {
      mergeConflictFiles: ['docs/TODO.md', 'docs/PROJECT-STATUS.md'],
    });
    const result = await resolveIntegrationSyncConflict({
      task,
      targetBranch: 'main',
      conflictFiles: task.mergeConflictFiles,
      integrationWorktree: repoDir,
      integrationBranch: 'ralph/integration/main',
      apply: true,
      triggeredBy: 'test',
    });

    const todo = fs.readFileSync(path.join(repoDir, 'docs', 'TODO.md'), 'utf8');
    const status = fs.readFileSync(path.join(repoDir, 'docs', 'PROJECT-STATUS.md'), 'utf8');

    assert.equal(result.resolved, true);
    assert.equal(result.applied, true);
    assert.equal(result.strategy, 'deterministic_project_status_todo');
    assert.equal(verifyNoConflictMarkers(todo), true);
    assert.equal(verifyNoConflictMarkers(status), true);
    assert.match(todo, /Keep target TODO/);
    assert.match(todo, /Keep task TODO/);
    assert.match(status, /Target status fact/);
    assert.match(status, /Task status fact/);
    assert.ok(result.proof.commitSha);
    assert.equal(result.proof.droppedFacts.length, 0);
    assert.equal(git(repoDir, ['rev-parse', 'HEAD']), result.proof.commitSha);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('resolveIntegrationSyncConflict refuses non-doc code conflicts', async () => {
  const repoDir = createRepo();
  try {
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'src', 'conflict.ts'), [
      '<<<<<<< HEAD',
      'export const value = 1;',
      '=======',
      'export const value = 2;',
      '>>>>>>> task',
      '',
    ].join('\n'));
    git(repoDir, ['add', 'src/conflict.ts']);
    git(repoDir, ['commit', '-m', 'add conflicted code fixture']);

    const task = createTask(repoDir, {
      mergeConflictFiles: ['src/conflict.ts'],
    });
    const result = await resolveIntegrationSyncConflict({
      task,
      targetBranch: 'main',
      conflictFiles: task.mergeConflictFiles,
      integrationWorktree: repoDir,
      integrationBranch: 'ralph/integration/main',
      apply: true,
      triggeredBy: 'test',
    });

    assert.equal(result.resolved, false);
    assert.equal(result.stopReason, 'docs_conflict_repair_not_allowlisted');
    assert.match(result.message, /non-allowlisted/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
```

---

## 11. Patch: `test/failed-recovery.test.js`

Add these tests near the existing worker merge-repair integration-sync tests. Keep the existing non-doc/unknown worktree stop test; it still verifies refusal when resolver is ineligible.

```diff
@@
 test('dependency watcher stops task repair immediately on integration sync conflicts', async () => {
@@
 });
+
+test('dependency watcher auto-repairs allowlisted docs integration sync conflicts before stopping', async () => {
+  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-manager-docs-sync-repair-'));
+  const integrationDir = path.join(tempDir, 'integration');
+  fs.mkdirSync(path.join(integrationDir, 'docs'), { recursive: true });
+  git(integrationDir, ['init', '-b', 'main']);
+  git(integrationDir, ['config', 'user.name', 'Ralph Test']);
+  git(integrationDir, ['config', 'user.email', 'ralph@example.com']);
+  fs.writeFileSync(path.join(integrationDir, 'docs', 'TODO.md'), [
+    '# TODO',
+    '<<<<<<< HEAD',
+    '- [ ] Target TODO fact',
+    '=======',
+    '- [ ] Task TODO fact',
+    '>>>>>>> task',
+    '',
+  ].join('\n'));
+  fs.writeFileSync(path.join(integrationDir, 'docs', 'PROJECT-STATUS.md'), [
+    '# Project Status',
+    '<<<<<<< HEAD',
+    '- Target project status fact',
+    '=======',
+    '- Task project status fact',
+    '>>>>>>> task',
+    '',
+  ].join('\n'));
+  git(integrationDir, ['add', 'docs/TODO.md', 'docs/PROJECT-STATUS.md']);
+  git(integrationDir, ['commit', '-m', 'conflicted docs fixture']);
+
+  const stateManager = new FakeStateManager([
+    {
+      id: 'failed-worker-docs-integration-sync-conflict',
+      prdPath: path.join(tempDir, 'prd.json'),
+      status: 'failed',
+      startTime: 100,
+      completedUS: ['US-001'],
+      storyProgress: [
+        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
+        { id: 'US-002', status: 'failed', attempts: 2, lastError: 'merge failed', updatedAt: 1 },
+      ],
+      worktree: path.join(tempDir, 'task-worktree'),
+      logPath: path.join(tempDir, 'agent.log'),
+      agent: 'codex',
+      repoPath: tempDir,
+      loopCount: 4,
+      consecutiveNoProgress: 1,
+      consecutiveErrors: 1,
+      lastProgressTime: 100,
+      lastFilesChanged: 0,
+      repairContext: {
+        mode: 'merge',
+        storyId: 'US-002',
+        createdAt: Date.now(),
+        reason: 'Merge repair required by Ralph.',
+      },
+      mergeError: 'Integration branch sync failed with conflicts: docs/TODO.md, docs/PROJECT-STATUS.md',
+      mergeConflictFiles: ['docs/TODO.md', 'docs/PROJECT-STATUS.md'],
+      mergeConflictPhase: 'integration_sync',
+      integrationBranch: 'ralph/integration/main',
+      integrationWorktree: integrationDir,
+      postFinalizeMergeProbeRequired: true,
+    },
+  ]);
+  let probeCalls = 0;
+  const watcher = new DependencyWatcher(
+    {},
+    {
+      stateManager,
+      configManager: createConfigManager(),
+      scheduler: { schedulePendingTasks: async () => [] },
+      sleep: async () => undefined,
+      logger: { log() {}, error() {} },
+      probeWorktreeMergeability: async () => {
+        probeCalls += 1;
+        if (probeCalls === 1) {
+          return {
+            mergeable: false,
+            alreadyIntegrated: false,
+            message: 'Integration branch sync failed with conflicts: docs/TODO.md, docs/PROJECT-STATUS.md',
+            conflictFiles: ['docs/TODO.md', 'docs/PROJECT-STATUS.md'],
+            failurePhase: 'integration_sync',
+            integrationBranch: 'ralph/integration/main',
+            integrationWorktree: integrationDir,
+          };
+        }
+        return {
+          mergeable: true,
+          alreadyIntegrated: false,
+          message: 'exact worktree mergeability probe passed after docs repair',
+          conflictFiles: [],
+          integrationBranch: 'ralph/integration/main',
+          integrationWorktree: integrationDir,
+        };
+      },
+    },
+  );
+
+  await watcher.recoverFailedWorkerMergeRepairTasks();
+  const task = stateManager.tasks.get('failed-worker-docs-integration-sync-conflict');
+  const todo = fs.readFileSync(path.join(integrationDir, 'docs', 'TODO.md'), 'utf8');
+  const status = fs.readFileSync(path.join(integrationDir, 'docs', 'PROJECT-STATUS.md'), 'utf8');
+
+  assert.equal(task.mergeRepairRecoveryStoppedAt, undefined);
+  assert.equal(task.autoRecoveryStoppedAt, undefined);
+  assert.equal(task.mergeRepairRecoveryStopReason, undefined);
+  assert.equal(task.conflictRepairProof.strategy, 'deterministic_project_status_todo');
+  assert.equal(task.conflictRepairProof.droppedFacts.length, 0);
+  assert.match(todo, /Target TODO fact/);
+  assert.match(todo, /Task TODO fact/);
+  assert.match(status, /Target project status fact/);
+  assert.match(status, /Task project status fact/);
+  assert.doesNotMatch(todo + status, /<<<<<<<|=======|>>>>>>>/);
+
+  fs.rmSync(tempDir, { recursive: true, force: true });
+});
+
+test('dependency watcher still refuses non-doc integration sync conflicts', async () => {
+  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-manager-code-sync-refuse-'));
+  const integrationDir = path.join(tempDir, 'integration');
+  fs.mkdirSync(path.join(integrationDir, 'src'), { recursive: true });
+  git(integrationDir, ['init', '-b', 'main']);
+  git(integrationDir, ['config', 'user.name', 'Ralph Test']);
+  git(integrationDir, ['config', 'user.email', 'ralph@example.com']);
+  fs.writeFileSync(path.join(integrationDir, 'src', 'conflict.ts'), [
+    '<<<<<<< HEAD',
+    'export const value = 1;',
+    '=======',
+    'export const value = 2;',
+    '>>>>>>> task',
+    '',
+  ].join('\n'));
+  git(integrationDir, ['add', 'src/conflict.ts']);
+  git(integrationDir, ['commit', '-m', 'conflicted code fixture']);
+
+  const stateManager = new FakeStateManager([
+    {
+      id: 'failed-worker-code-integration-sync-conflict',
+      prdPath: path.join(tempDir, 'prd.json'),
+      status: 'failed',
+      startTime: 100,
+      completedUS: ['US-001'],
+      storyProgress: [
+        { id: 'US-001', status: 'passed', attempts: 1, updatedAt: 1 },
+        { id: 'US-002', status: 'failed', attempts: 2, lastError: 'merge failed', updatedAt: 1 },
+      ],
+      worktree: path.join(tempDir, 'task-worktree'),
+      logPath: path.join(tempDir, 'agent.log'),
+      agent: 'codex',
+      repoPath: tempDir,
+      loopCount: 4,
+      consecutiveNoProgress: 1,
+      consecutiveErrors: 1,
+      lastProgressTime: 100,
+      lastFilesChanged: 0,
+      repairContext: {
+        mode: 'merge',
+        storyId: 'US-002',
+        createdAt: Date.now(),
+        reason: 'Merge repair required by Ralph.',
+      },
+      mergeError: 'Integration branch sync failed with conflicts: src/conflict.ts',
+      mergeConflictFiles: ['src/conflict.ts'],
+      mergeConflictPhase: 'integration_sync',
+      integrationBranch: 'ralph/integration/main',
+      integrationWorktree: integrationDir,
+      postFinalizeMergeProbeRequired: true,
+    },
+  ]);
+  const watcher = new DependencyWatcher(
+    {},
+    {
+      stateManager,
+      configManager: createConfigManager(),
+      scheduler: { schedulePendingTasks: async () => [] },
+      sleep: async () => undefined,
+      logger: { log() {}, error() {} },
+      probeWorktreeMergeability: async () => ({
+        mergeable: false,
+        alreadyIntegrated: false,
+        message: 'Integration branch sync failed with conflicts: src/conflict.ts',
+        conflictFiles: ['src/conflict.ts'],
+        failurePhase: 'integration_sync',
+        integrationBranch: 'ralph/integration/main',
+        integrationWorktree: integrationDir,
+      }),
+    },
+  );
+
+  await watcher.recoverFailedWorkerMergeRepairTasks();
+  const task = stateManager.tasks.get('failed-worker-code-integration-sync-conflict');
+  assert.equal(task.status, 'failed');
+  assert.equal(task.mergeRepairDisplayStatus, 'stopped');
+  assert.equal(task.mergeRepairRecoveryStopReason, 'docs_conflict_repair_not_allowlisted');
+  assert.equal(task.autoRecoveryStopReason, 'docs_conflict_repair_not_allowlisted');
+
+  fs.rmSync(tempDir, { recursive: true, force: true });
+});
```

---

## 12. Commands

```bash
npm run build
npm test
node --test test/conflict-resolution.test.js
node --test test/failed-recovery.test.js --test-name-pattern='integration sync'
node --test test/queue-status.test.js --test-name-pattern='integration sync'
```

Manual scenario commands:

```bash
export RALPH_HOME=/Users/shawn/.ralph-ez4ielts
cd /Users/shawn/Project/ralph-cli
npm run build

cd /Users/shawn/Project/ez4ielts
ralph repair-conflicts task-1778924163997-o2q8jdxkx --dry-run --json
ralph repair-conflicts task-1778924163997-o2q8jdxkx --apply --json
ralph retry task-1778924163997-o2q8jdxkx
ralph queue --compact | jq '.actionability, .actions'
```

## 13. Assumptions and known risks

* The attached source is treated as the live dirty baseline. The bundle uses targeted diffs for existing files to avoid reverting unrelated work.
* The deterministic resolver is intentionally narrow. It only accepts `docs/TODO.md` and `docs/PROJECT-STATUS.md` by default.
* For `PROJECT-STATUS.md` paragraph conflicts, it may create an explicit Ralph preservation block rather than trying to invent a perfect summary. This is intentionally conservative: the first slice prioritizes not dropping facts.
* The manager patch records the repair and lets the next manager loop reuse the existing clean-probe recovery path instead of duplicating the large ready-to-finalize promotion logic. Ralph can later refactor the existing success branch into a helper and call it immediately after post-repair probe success.
* LLM repair is stubbed. The command accepts `--allow-llm`, but the resolver refuses unless deterministic repair succeeds. A later slice can add a constrained patch-only LLM worker with exact-probe and fact-retention verification.
* Git commit requires a configured user name/email in the integration worktree. Ralph test fixtures set these; production repos usually already have them.
* This implementation does not weaken policy for code/config/schema/migration/security/lockfile conflicts and never performs whole-file ours/theirs selection.
