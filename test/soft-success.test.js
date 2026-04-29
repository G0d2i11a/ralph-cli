const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  detectCompletionSignals,
  detectCurrentWorktreeEvidence,
  hasObjectiveProgressEvidence,
  reuseTaskLevelEvidenceForStorySuccess,
  shouldTreatNonZeroExitAsSuccess,
} = require('../dist/core/soft-success.js');

function git(cwd, args) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('detectCompletionSignals recognizes completion summary, validation, and commit message', () => {
  const output = `
**Done**
- Reworked the exception layer

**Validation**
- 8 suites, 233 tests passed

Suggested commit message: refactor(api): replace raw service errors with domain exceptions
`;

  const signals = detectCompletionSignals(output);
  assert.equal(signals.hasCompletionSummary, true);
  assert.equal(signals.hasValidationSignal, true);
  assert.equal(signals.hasSuggestedCommitMessage, true);
  assert.deepEqual(signals.matchedSignals, [
    'completion_summary',
    'validation',
    'suggested_commit_message',
  ]);
});

test('shouldTreatNonZeroExitAsSuccess accepts non-zero exit when progress and completion signals exist', () => {
  const decision = shouldTreatNonZeroExitAsSuccess({
    output: `
**Done**
- Implemented the change

**Validation**
- 8 suites, 233 tests passed

Suggested commit message: feat: finalize soft success
`,
    progress: {
      hasProgress: true,
      filesChanged: 12,
      newCommits: 0,
    },
  });

  assert.equal(decision.shouldTreatAsSuccess, true);
  assert.match(decision.reason, /progress \+ signals/i);
});

test('shouldTreatNonZeroExitAsSuccess rejects non-zero exit without strong completion evidence', () => {
  const decision = shouldTreatNonZeroExitAsSuccess({
    output: 'ERROR: exceeded retry limit, last status: 429 Too Many Requests',
    progress: {
      hasProgress: false,
      filesChanged: 0,
      newCommits: 0,
    },
  });

  assert.equal(decision.shouldTreatAsSuccess, false);
});

test('detectCompletionSignals recognizes implemented-and-validated summaries', () => {
  const output = `
Implemented and validated; all acceptance criteria are covered.

**Validation**
- Passed targeted tests

Suggested commit message: feat(api): continue event bus rollout
`;

  const signals = detectCompletionSignals(output);
  assert.equal(signals.hasCompletionSummary, true);
  assert.equal(signals.hasValidationSignal, true);
  assert.equal(signals.hasSuggestedCommitMessage, true);
});

test('detectCompletionSignals recognizes result and verification in large logs', () => {
  const output = `
**Result**
The worktree now enforces the topology approval boundaries in code and tests.

**Verification**
\`npm test\` at the repo root passed.

${'x'.repeat(60000)}

Suggested commit message: feat: recover finalizer repair
`;

  const signals = detectCompletionSignals(output);
  assert.equal(signals.hasCompletionSummary, true);
  assert.equal(signals.hasValidationSignal, true);
  assert.equal(signals.hasSuggestedCommitMessage, true);
});

test('detectCurrentWorktreeEvidence detects dirty worktree relative to base commit', () => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-soft-success-worktree-'));

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

    fs.writeFileSync(filePath, 'changed after finalize failure\n');

    const evidence = detectCurrentWorktreeEvidence({
      worktreePath: repoPath,
      baseCommitSha,
    });

    assert.equal(evidence.hasProgress, true);
    assert.equal(evidence.filesChanged > 0, true);
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
});

test('detectCurrentWorktreeEvidence ignores .git-local-only worktree changes', () => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-soft-success-git-local-'));

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

    fs.mkdirSync(path.join(repoPath, '.git-local'), { recursive: true });
    fs.writeFileSync(path.join(repoPath, '.git-local', 'HEAD'), 'metadata only\n');

    const evidence = detectCurrentWorktreeEvidence({
      worktreePath: repoPath,
      baseCommitSha,
    });

    assert.equal(evidence.hasProgress, false);
    assert.equal(evidence.filesChanged, 0);
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
});

test('hasObjectiveProgressEvidence rejects zero-diff completion claims', () => {
  assert.equal(hasObjectiveProgressEvidence({
    hasProgress: true,
    filesChanged: 0,
    newCommits: 0,
  }), false);

  assert.equal(hasObjectiveProgressEvidence({
    hasProgress: true,
    filesChanged: 1,
    newCommits: 0,
  }), true);
});

test('hasObjectiveProgressEvidence accepts HEAD-only progress', () => {
  assert.equal(hasObjectiveProgressEvidence({
    hasProgress: true,
    filesChanged: 0,
    newCommits: 0,
    headChanged: true,
  }), true);
});

test('reuseTaskLevelEvidenceForStorySuccess accepts retained base-relative evidence with strong completion signals', () => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-retained-task-evidence-'));

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

    fs.writeFileSync(filePath, 'retained task evidence\n');

    const reusedEvidence = reuseTaskLevelEvidenceForStorySuccess({
      output: `
**Done**
- Hooked review/drill intake to the existing source metadata

**Validation**
- Passed targeted tests
`,
      worktreePath: repoPath,
      baseCommitSha,
      storyId: 'US-004',
    });

    assert.ok(reusedEvidence);
    assert.equal(reusedEvidence.hasProgress, true);
    assert.equal(reusedEvidence.filesChanged > 0, true);
    assert.match(reusedEvidence.reason, /Retained task-level worktree evidence/);
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
});
