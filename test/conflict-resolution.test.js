const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  areAllAllowlistedDocsConflictFiles,
  resolveDocsConflictRepairConfig,
  resolveIntegrationSyncConflict,
  resolveKnownDocsConflict,
  resolveKnownDocsConflictFile,
  verifyNoConflictMarkers,
} = require('../dist/core/conflict-resolution.js');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function createConflictedTodoRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-conflict-resolution-'));
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'ralph-tests@example.com']);
  git(repo, ['config', 'user.name', 'Ralph Tests']);
  writeFile(path.join(repo, 'docs/TODO.md'), '# TODO\n\n- [ ] Base item\n');
  git(repo, ['add', 'docs/TODO.md']);
  git(repo, ['commit', '-m', 'base']);
  git(repo, ['branch', '-M', 'main']);
  git(repo, ['checkout', '-b', 'ralph/integration/main']);
  writeFile(path.join(repo, 'docs/TODO.md'), '# TODO\n\n- [ ] Integration item\n');
  git(repo, ['commit', '-am', 'integration todo']);
  git(repo, ['checkout', 'main']);
  writeFile(path.join(repo, 'docs/TODO.md'), '# TODO\n\n- [ ] Target item\n');
  git(repo, ['commit', '-am', 'target todo']);
  git(repo, ['checkout', 'ralph/integration/main']);

  try {
    git(repo, ['merge', 'main']);
  } catch {
    // Expected: both branches edited the same status line.
  }

  return repo;
}

test('resolveKnownDocsConflict dry-run preserves both TODO sides without writing', () => {
  const repo = createConflictedTodoRepo();
  const before = fs.readFileSync(path.join(repo, 'docs/TODO.md'), 'utf8');

  const result = resolveKnownDocsConflict({
    worktreePath: repo,
    conflictFiles: ['docs/TODO.md'],
    targetBranch: 'main',
    integrationBranch: 'ralph/integration/main',
    apply: false,
    now: 123,
  });

  assert.equal(result.resolved, true);
  assert.equal(result.applied, false);
  assert.equal(result.proof.observedAt, 123);
  assert.equal(result.proof.strategy, 'deterministic_project_status_todo');
  assert.equal(result.proof.retainedOursFacts, 1);
  assert.equal(result.proof.retainedTheirsFacts, 1);
  assert.equal(result.proof.droppedFacts.length, 0);
  assert.match(result.files[0].candidateContent, /Integration item/);
  assert.match(result.files[0].candidateContent, /Target item/);
  assert.equal(verifyNoConflictMarkers(result.files[0].candidateContent), true);
  assert.equal(fs.readFileSync(path.join(repo, 'docs/TODO.md'), 'utf8'), before);

  fs.rmSync(repo, { recursive: true, force: true });
});

test('resolveKnownDocsConflict apply stages and commits allowlisted docs repair', () => {
  const repo = createConflictedTodoRepo();

  const result = resolveKnownDocsConflict({
    worktreePath: repo,
    conflictFiles: ['docs/TODO.md'],
    targetBranch: 'main',
    integrationBranch: 'ralph/integration/main',
    apply: true,
  });

  const content = fs.readFileSync(path.join(repo, 'docs/TODO.md'), 'utf8');
  const unmerged = git(repo, ['diff', '--name-only', '--diff-filter=U']);
  const subject = git(repo, ['log', '-1', '--pretty=%s']);

  assert.equal(result.resolved, true);
  assert.equal(result.applied, true);
  assert.equal(unmerged, '');
  assert.equal(subject, 'chore: resolve Ralph integration sync docs conflicts');
  assert.match(content, /Integration item/);
  assert.match(content, /Target item/);
  assert.equal(verifyNoConflictMarkers(content), true);
  assert.ok(result.proof.commitSha);

  fs.rmSync(repo, { recursive: true, force: true });
});

test('resolveIntegrationSyncConflict recreates probe-cleaned integration sync conflict state', async () => {
  const repo = createConflictedTodoRepo();
  git(repo, ['merge', '--abort']);

  const baseInput = {
    task: {
      id: 'task-docs-conflict',
      mergeConflictFiles: ['docs/TODO.md'],
      mergeConflictPhase: 'integration_sync',
      integrationBranch: 'ralph/integration/main',
      integrationWorktree: repo,
    },
    targetBranch: 'main',
    conflictFiles: ['docs/TODO.md'],
    integrationBranch: 'ralph/integration/main',
    integrationWorktree: repo,
    mergeProbeResult: {
      mergeable: false,
      alreadyIntegrated: false,
      failurePhase: 'integration_sync',
      conflictFiles: ['docs/TODO.md'],
      integrationBranch: 'ralph/integration/main',
      integrationWorktree: repo,
    },
  };

  const dryRun = await resolveIntegrationSyncConflict({
    ...baseInput,
    apply: false,
    now: 456,
  });

  assert.equal(dryRun.resolved, true);
  assert.equal(dryRun.applied, false);
  assert.equal(dryRun.proof.observedAt, 456);
  assert.equal(git(repo, ['status', '--short']), '');

  const applyResult = await resolveIntegrationSyncConflict({
    ...baseInput,
    apply: true,
  });
  const content = fs.readFileSync(path.join(repo, 'docs/TODO.md'), 'utf8');
  const unmerged = git(repo, ['diff', '--name-only', '--diff-filter=U']);
  const subject = git(repo, ['log', '-1', '--pretty=%s']);

  assert.equal(applyResult.resolved, true);
  assert.equal(applyResult.applied, true);
  assert.equal(unmerged, '');
  assert.equal(subject, 'chore: resolve Ralph integration sync docs conflicts');
  assert.match(content, /Integration item/);
  assert.match(content, /Target item/);
  assert.equal(verifyNoConflictMarkers(content), true);
  assert.ok(applyResult.proof.commitSha);

  fs.rmSync(repo, { recursive: true, force: true });
});

test('resolveKnownDocsConflict refuses non-allowlisted conflict files', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-conflict-resolution-refuse-'));

  const result = resolveKnownDocsConflict({
    worktreePath: repo,
    conflictFiles: ['src/app.ts'],
    targetBranch: 'main',
    apply: false,
  });

  assert.equal(result.resolved, false);
  assert.equal(result.stopReason, 'docs_conflict_repair_not_allowlisted');
  assert.match(result.message, /non-allowlisted/);

  fs.rmSync(repo, { recursive: true, force: true });
});

test('resolveKnownDocsConflictFile preserves prose status conflicts in an evidence block', () => {
  const content = [
    '# Project Status',
    '',
    '<<<<<<< integration',
    'Speaking coach is deployed with a floating assistant.',
    '=======',
    'Speaking coach still needs mobile layout verification.',
    '>>>>>>> main',
    '',
  ].join('\n');

  const result = resolveKnownDocsConflictFile('docs/PROJECT-STATUS.md', content);

  assert.equal(verifyNoConflictMarkers(result.content), true);
  assert.match(result.content, /Ralph preserved integration-sync status facts/);
  assert.match(result.content, /Speaking coach is deployed/);
  assert.match(result.content, /Speaking coach still needs mobile layout verification/);
  assert.equal(result.retainedOursFacts, 1);
  assert.equal(result.retainedTheirsFacts, 1);
});

test('allowlist helper only accepts known status docs', () => {
  assert.equal(areAllAllowlistedDocsConflictFiles(['docs/TODO.md', 'docs/PROJECT-STATUS.md']), true);
  assert.equal(areAllAllowlistedDocsConflictFiles(['docs/TODO.md', 'package-lock.json']), false);
});

test('docs conflict repair default accepts large project status files', () => {
  assert.equal(resolveDocsConflictRepairConfig().maxBytesPerFile, 1_000_000);
});
