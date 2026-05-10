const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyQualityGateFailure,
  parseTurboNestedFailures,
} = require('../dist/core/finalize-failure-classifier.js');
const {
  buildFailureObservationFromTask,
} = require('../dist/core/failure-observation.js');

test('quality gate classifier normalizes root turbo api#test failure to apps/api', () => {
  const taskId = 'task-1777894813877-e6j0sr75q';
  const repoPath = '/repo/ez4ielts';
  const taskWorktree = `${repoPath}/.ralph-worktrees/${taskId}`;
  const output = [
    'api:test: ERROR: command finished with error: command (/repo/ez4ielts/.ralph-worktrees/task-1777894813877-e6j0sr75q/apps/api) /opt/homebrew/bin/pnpm run test exited (1)',
    'api#test: command (/repo/ez4ielts/.ralph-worktrees/task-1777894813877-e6j0sr75q/apps/api) /opt/homebrew/bin/pnpm run test exited (1)',
    "Nest can't resolve dependencies of the ContentExposureService (PrismaService, ?). Please make sure that the argument OpsAlertService at index [1] is available in the RootTestModule context.",
  ].join('\n');

  const details = classifyQualityGateFailure({
    requestedScript: 'test',
    actualScript: 'test',
    cwd: taskWorktree,
    packageLabel: taskId,
    command: 'pnpm run test',
    rawMessage: `Quality gate "test" failed: ${output}`,
    stdout: output,
    exitCode: 1,
    taskId,
    taskWorktree,
    repoPath,
  });

  assert.equal(details.packageLabel, 'apps/api');
  assert.equal(details.gate, 'test');
  assert.equal(details.cwd, `${taskWorktree}/apps/api`);
  assert.equal(details.parentCommand, 'pnpm run test');
  assert.equal(details.parentCwd, taskWorktree);
  assert.equal(details.class, 'test_module_provider_drift');
  assert.equal(details.nestedFailures.length, 1);
  assert.equal(details.nestedFailures[0].packageLabel, 'apps/api');
});

test('turbo nested parser deduplicates api:test and api#test lines', () => {
  const taskWorktree = '/repo/.ralph-worktrees/task-a';
  const output = [
    'api:test: ERROR: command finished with error: command (/repo/.ralph-worktrees/task-a/apps/api) /opt/homebrew/bin/pnpm run test exited (1)',
    'api#test: command (/repo/.ralph-worktrees/task-a/apps/api) /opt/homebrew/bin/pnpm run test exited (1)',
  ].join('\n');

  const failures = parseTurboNestedFailures({
    output,
    taskWorktree,
    repoPath: '/repo',
    parentCommand: 'pnpm run test',
  });

  assert.equal(failures.length, 1);
  assert.equal(failures[0].packageLabel, 'apps/api');
  assert.equal(failures[0].gate, 'test');
});

test('failure observation normalizes legacy persisted root turbo failure', () => {
  const taskId = 'task-1777894813877-e6j0sr75q';
  const repoPath = '/repo/ez4ielts';
  const taskWorktree = `${repoPath}/.ralph-worktrees/${taskId}`;
  const rawMessage = [
    'Quality gate "test" failed: • turbo 2.7.1',
    `api:test: ERROR: command finished with error: command (${taskWorktree}/apps/api) /opt/homebrew/bin/pnpm run test exited (1)`,
    `api#test: command (${taskWorktree}/apps/api) /opt/homebrew/bin/pnpm run test exited (1)`,
  ].join('\n');

  const observation = buildFailureObservationFromTask({
    id: taskId,
    repoPath,
    worktree: taskWorktree,
    lastErrorObservedAt: 1778001323674,
    finalizerFailure: {
      failureKind: 'quality_gate',
      class: 'quality_gate_failure',
      gate: 'test',
      requestedGate: 'test',
      packageLabel: taskId,
      cwd: taskWorktree,
      command: 'pnpm run test',
      exitCode: 1,
      rawMessage,
    },
  });

  assert.equal(observation.packageLabel, 'apps/api');
  assert.equal(observation.cwd, `${taskWorktree}/apps/api`);
  assert.equal(observation.command, '/opt/homebrew/bin/pnpm run test');
  assert.equal(observation.parentCommand, 'pnpm run test');
  assert.ok(observation.signature.includes('test|apps/api'));
});
