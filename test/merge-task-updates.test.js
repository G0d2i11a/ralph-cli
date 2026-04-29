const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildFailedMergeTaskUpdates,
  buildSuccessfulMergeTaskUpdates,
} = require('../dist/core/merge-task-updates.js');

test('buildSuccessfulMergeTaskUpdates separates integration success from deferred target sync', () => {
  const updates = buildSuccessfulMergeTaskUpdates({
    success: true,
    hasConflicts: false,
    commitSha: 'abc123',
    integrationBranch: 'ralph/integration/main',
    integrationWorktree: '/tmp/integration',
    targetSynced: false,
    targetSyncMessage: 'main sync deferred: checkout /repo has uncommitted changes',
    message: 'Integrated task branch into integration branch',
  }, 'main', 'manual');

  assert.equal(updates.integrationStatus, 'integrated');
  assert.equal(updates.integrationCommitSha, 'abc123');
  assert.equal(updates.targetSyncStatus, 'deferred_dirty_checkout');
  assert.equal(updates.targetSyncedAt, undefined);
  assert.match(updates.targetSyncDeferredReason, /sync deferred/);
});

test('buildFailedMergeTaskUpdates marks conflicts as blocked integration and leaves target sync not requested', () => {
  const updates = buildFailedMergeTaskUpdates({
    success: false,
    hasConflicts: true,
    conflictFiles: ['src/app.ts'],
    failurePhase: 'integration_sync',
    integrationBranch: 'ralph/integration/main',
    integrationWorktree: '/tmp/integration',
    message: 'Merge conflicts detected: src/app.ts',
  }, 'main', 'manual');

  assert.equal(updates.integrationStatus, 'blocked_conflict');
  assert.equal(updates.targetSyncStatus, 'not_requested');
  assert.equal(updates.mergeCommitSha, undefined);
  assert.deepEqual(updates.mergeConflictFiles, ['src/app.ts']);
  assert.equal(updates.mergeConflictPhase, 'integration_sync');
  assert.ok(typeof updates.mergeConflictAt === 'number');
});
