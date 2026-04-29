const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  captureFinalizeRepairSnapshot,
  decideFinalizeRepairRequeue,
  evaluateFinalizeRepairFailure,
} = require('../dist/core/finalize-repair-policy.js');

function git(cwd, args) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function createRepairConfig(overrides = {}) {
  return {
    repairPolicy: 'progress',
    maxRepairAttempts: 1,
    maxNoProgressRepairRounds: 2,
    repairDeadlineSeconds: 7200,
    repairHardCap: 20,
    ...overrides,
  };
}

test('evaluateFinalizeRepairFailure does not treat HEAD churn as progress for merge-conflict loops', () => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalize-repair-merge-stall-'));

  try {
    git(repoPath, ['init']);
    git(repoPath, ['config', 'user.email', 'test@example.com']);
    git(repoPath, ['config', 'user.name', 'Test User']);

    const filePath = path.join(repoPath, 'tracked.txt');
    fs.writeFileSync(filePath, 'base\n');
    git(repoPath, ['add', 'tracked.txt']);
    git(repoPath, ['commit', '-m', 'initial']);

    const baseCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();

    fs.writeFileSync(filePath, 'first repair\n');
    git(repoPath, ['add', 'tracked.txt']);
    git(repoPath, ['commit', '-m', 'repair']);

    const previousSnapshot = {
      headSha: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoPath,
        encoding: 'utf8',
      }).trim(),
      commitsAheadOfBase: 1,
      changedFiles: 1,
      worktreeDiffSignature: 'conflict-state-1',
      failureKind: 'merge_conflict',
      failureSignature: 'Merge conflicts detected: src/a.ts, src/b.ts',
      conflictSignature: 'src/a.ts\nsrc/b.ts',
      capturedAt: 100,
    };

    fs.writeFileSync(filePath, 'amended repair\n');
    git(repoPath, ['add', 'tracked.txt']);
    git(repoPath, ['commit', '--amend', '-m', 'repair amended']);

    const state = evaluateFinalizeRepairFailure({
      worktree: repoPath,
      baseCommitSha,
      lastError: 'Merge conflicts detected: src/a.ts, src/b.ts',
      mergeConflictFiles: ['src/a.ts', 'src/b.ts'],
      finalizeRepairStartedAt: 50,
      finalizeRepairDeadlineAt: 5000,
      finalizeRepairLastFailureSnapshot: previousSnapshot,
      finalizeRepairLastProgressAt: 80,
      finalizeRepairLastProgressReason: 'older progress',
      finalizeRepairConsecutiveNoProgress: 1,
    }, createRepairConfig(), 200);

    assert.equal(state.consecutiveNoProgress, 2);
    assert.equal(state.lastProgressAt, 80);
    assert.equal(state.lastProgressReason, 'older progress');
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
});

test('evaluateFinalizeRepairFailure increments the no-progress counter when failure snapshot is unchanged', () => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalize-repair-stalled-'));

  try {
    git(repoPath, ['init']);
    git(repoPath, ['config', 'user.email', 'test@example.com']);
    git(repoPath, ['config', 'user.name', 'Test User']);

    const filePath = path.join(repoPath, 'tracked.txt');
    fs.writeFileSync(filePath, 'base\n');
    git(repoPath, ['add', 'tracked.txt']);
    git(repoPath, ['commit', '-m', 'initial']);

    const baseCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();

    fs.writeFileSync(filePath, 'repair\n');
    git(repoPath, ['add', 'tracked.txt']);
    git(repoPath, ['commit', '-m', 'repair']);

    const previousSnapshot = captureFinalizeRepairSnapshot({
      worktree: repoPath,
      baseCommitSha,
      lastError: 'Quality gate "test" failed',
    }, 100);

    const state = evaluateFinalizeRepairFailure({
      worktree: repoPath,
      baseCommitSha,
      lastError: 'Quality gate "test" failed',
      finalizeRepairStartedAt: 50,
      finalizeRepairDeadlineAt: 5000,
      finalizeRepairLastFailureSnapshot: previousSnapshot,
      finalizeRepairLastProgressAt: 80,
      finalizeRepairLastProgressReason: 'older progress',
      finalizeRepairConsecutiveNoProgress: 1,
    }, createRepairConfig(), 200);

    assert.equal(state.consecutiveNoProgress, 2);
    assert.equal(state.lastProgressAt, 80);
    assert.equal(state.lastProgressReason, 'older progress');
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
});

test('evaluateFinalizeRepairFailure does not reset no-progress for HEAD-only churn when diagnostics are unchanged', () => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalize-repair-structured-stalled-'));

  try {
    git(repoPath, ['init']);
    git(repoPath, ['config', 'user.email', 'test@example.com']);
    git(repoPath, ['config', 'user.name', 'Test User']);

    const filePath = path.join(repoPath, 'tracked.txt');
    fs.writeFileSync(filePath, 'base\n');
    git(repoPath, ['add', 'tracked.txt']);
    git(repoPath, ['commit', '-m', 'initial']);

    const baseCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();

    fs.writeFileSync(filePath, 'repair\n');
    git(repoPath, ['add', 'tracked.txt']);
    git(repoPath, ['commit', '-m', 'repair']);

    const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();

    const state = evaluateFinalizeRepairFailure({
      worktree: repoPath,
      baseCommitSha,
      lastError: 'Quality gate "typecheck" failed',
      finalizerFailure: {
        failureKind: 'quality_gate',
        class: 'generated_type_drift',
        gate: 'typecheck',
        requestedGate: 'typecheck',
        packageLabel: 'apps/api',
        cwd: repoPath,
        command: 'pnpm run typecheck',
        diagnosticCount: 3,
        diagnosticSignature: 'a\nb\nc',
        failedFiles: ['src/a.ts', 'src/b.ts'],
        failedCodes: ['TS2322', 'TS2353', 'TS2677'],
        failedSymbols: ['sourceType', 'importFailedReason', 'followUpQuestions'],
        rawMessage: 'Quality gate "typecheck" failed',
      },
      finalizeRepairStartedAt: 50,
      finalizeRepairDeadlineAt: 5000,
      finalizeRepairLastFailureSnapshot: {
        headSha: `${currentHead}-older`,
        commitsAheadOfBase: 1,
        changedFiles: 1,
        worktreeDiffSignature: 'older-diff',
        failureKind: 'quality_gate',
        failureSignature: 'a\nb\nc',
        failureClass: 'generated_type_drift',
        gate: 'typecheck',
        packageLabel: 'apps/api',
        diagnosticCount: 3,
        diagnosticSignature: 'a\nb\nc',
        failedFilesSignature: 'src/a.ts\nsrc/b.ts',
        failedCodesSignature: 'TS2322\nTS2353\nTS2677',
        failedSymbolsSignature: 'followUpQuestions\nimportFailedReason\nsourceType',
        capturedAt: 100,
      },
      finalizeRepairLastProgressAt: 80,
      finalizeRepairLastProgressReason: 'older progress',
      finalizeRepairConsecutiveNoProgress: 1,
    }, createRepairConfig(), 200);

    assert.equal(state.consecutiveNoProgress, 2);
    assert.equal(state.lastProgressAt, 80);
    assert.equal(state.lastProgressReason, 'older progress');
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
});

test('evaluateFinalizeRepairFailure treats shrinking diagnostic count as progress', () => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalize-repair-structured-progress-'));

  try {
    git(repoPath, ['init']);
    git(repoPath, ['config', 'user.email', 'test@example.com']);
    git(repoPath, ['config', 'user.name', 'Test User']);

    const filePath = path.join(repoPath, 'tracked.txt');
    fs.writeFileSync(filePath, 'base\n');
    git(repoPath, ['add', 'tracked.txt']);
    git(repoPath, ['commit', '-m', 'initial']);

    const baseCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();

    fs.writeFileSync(filePath, 'repair\n');
    git(repoPath, ['add', 'tracked.txt']);
    git(repoPath, ['commit', '-m', 'repair']);

    const previousSnapshot = {
      headSha: 'same-head',
      commitsAheadOfBase: 1,
      changedFiles: 1,
      worktreeDiffSignature: 'same-diff',
      failureKind: 'quality_gate',
      failureSignature: 'diag-3',
      failureClass: 'generated_type_drift',
      gate: 'typecheck',
      packageLabel: 'apps/api',
      diagnosticCount: 3,
      diagnosticSignature: 'diag-3',
      failedFilesSignature: 'src/a.ts\nsrc/b.ts',
      failedCodesSignature: 'TS2322\nTS2353\nTS2677',
      failedSymbolsSignature: 'followUpQuestions\nimportFailedReason\nsourceType',
      capturedAt: 100,
    };

    const state = evaluateFinalizeRepairFailure({
      worktree: repoPath,
      baseCommitSha,
      lastError: 'Quality gate "typecheck" failed',
      finalizerFailure: {
        failureKind: 'quality_gate',
        class: 'generated_type_drift',
        gate: 'typecheck',
        requestedGate: 'typecheck',
        packageLabel: 'apps/api',
        cwd: repoPath,
        command: 'pnpm run typecheck',
        diagnosticCount: 2,
        diagnosticSignature: 'diag-2',
        failedFiles: ['src/a.ts'],
        failedCodes: ['TS2322', 'TS2353'],
        failedSymbols: ['importFailedReason', 'sourceType'],
        rawMessage: 'Quality gate "typecheck" failed',
      },
      finalizeRepairStartedAt: 50,
      finalizeRepairDeadlineAt: 5000,
      finalizeRepairLastFailureSnapshot: previousSnapshot,
      finalizeRepairLastProgressAt: 80,
      finalizeRepairLastProgressReason: 'older progress',
      finalizeRepairConsecutiveNoProgress: 1,
    }, createRepairConfig(), 200);

    assert.equal(state.consecutiveNoProgress, 0);
    assert.equal(state.lastProgressAt, 200);
    assert.match(state.lastProgressReason, /diagnostic count 3 -> 2/i);
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
});

test('evaluateFinalizeRepairFailure treats shrinking merge conflict set as progress', () => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalize-repair-merge-progress-'));

  try {
    git(repoPath, ['init']);
    git(repoPath, ['config', 'user.email', 'test@example.com']);
    git(repoPath, ['config', 'user.name', 'Test User']);

    const filePath = path.join(repoPath, 'tracked.txt');
    fs.writeFileSync(filePath, 'base\n');
    git(repoPath, ['add', 'tracked.txt']);
    git(repoPath, ['commit', '-m', 'initial']);

    const baseCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();

    fs.writeFileSync(filePath, 'repair\n');
    git(repoPath, ['add', 'tracked.txt']);
    git(repoPath, ['commit', '-m', 'repair']);

    const previousSnapshot = {
      headSha: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoPath,
        encoding: 'utf8',
      }).trim(),
      commitsAheadOfBase: 1,
      changedFiles: 1,
      worktreeDiffSignature: 'conflict-state-1',
      failureKind: 'merge_conflict',
      failureSignature: 'Merge conflicts detected: src/a.ts, src/b.ts',
      conflictSignature: 'src/a.ts\nsrc/b.ts',
      capturedAt: 100,
    };

    const state = evaluateFinalizeRepairFailure({
      worktree: repoPath,
      baseCommitSha,
      lastError: 'Merge conflicts detected: src/a.ts',
      mergeConflictFiles: ['src/a.ts'],
      finalizeRepairStartedAt: 50,
      finalizeRepairDeadlineAt: 5000,
      finalizeRepairLastFailureSnapshot: previousSnapshot,
      finalizeRepairLastProgressAt: 80,
      finalizeRepairLastProgressReason: 'older progress',
      finalizeRepairConsecutiveNoProgress: 1,
    }, createRepairConfig(), 200);

    assert.equal(state.consecutiveNoProgress, 0);
    assert.equal(state.lastProgressAt, 200);
    assert.match(state.lastProgressReason, /conflict file set shrank/i);
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
});

test('decideFinalizeRepairRequeue allows progress mode to continue beyond legacy attempt counts', () => {
  const decision = decideFinalizeRepairRequeue({
    task: {
      finalizerAttempts: 7,
      finalizeRepairStartedAt: Date.now() - 1000,
      finalizeRepairDeadlineAt: Date.now() + 60_000,
      finalizeRepairConsecutiveNoProgress: 0,
      finalizeRepairTotalRequeues: 5,
      finalizeRepairLastProgressReason: 'HEAD changed',
    },
    config: createRepairConfig({
      maxRepairAttempts: 1,
    }),
    mergeConflict: false,
    hasUnrunMergeRepair: false,
  });

  assert.equal(decision.shouldRequeue, true);
  assert.match(decision.reason, /HEAD changed/i);
});
