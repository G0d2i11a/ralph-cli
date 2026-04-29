const test = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateTaskStoryCompletion,
  formatStoryCompletionInvariantMessage,
  buildStoryCompletionInvariantFailureUpdates,
} = require('../dist/core/story-completion.js');

test('evaluateTaskStoryCompletion reports incomplete stories when a story is pending', () => {
  const summary = evaluateTaskStoryCompletion(
    {
      completedUS: ['US-002', 'US-003'],
      storyProgress: [
        { id: 'US-001', status: 'pending', attempts: 2, updatedAt: 1 },
        { id: 'US-002', status: 'passed', attempts: 1, updatedAt: 1 },
        { id: 'US-003', status: 'passed', attempts: 1, updatedAt: 1 },
      ],
    },
    ['US-001', 'US-002', 'US-003'],
  );

  assert.equal(summary.allStoriesPassed, false);
  assert.equal(summary.totalStories, 3);
  assert.deepEqual(summary.incompleteStories, [
    {
      id: 'US-001',
      status: 'pending',
      attempts: 2,
      completed: false,
    },
  ]);
});

test('formatStoryCompletionInvariantMessage names the blocked phase and story', () => {
  const message = formatStoryCompletionInvariantMessage('task-123', 'integrate', {
    allStoriesPassed: false,
    totalStories: 3,
    incompleteStories: [
      {
        id: 'US-001',
        status: 'pending',
        attempts: 2,
        completed: false,
      },
    ],
  });

  assert.match(message, /task-123/);
  assert.match(message, /cannot integrate/);
  assert.match(message, /US-001:pending:2/);
});

test('buildStoryCompletionInvariantFailureUpdates stops stale auto-recovery', () => {
  const updates = buildStoryCompletionInvariantFailureUpdates('story mismatch', 1234);

  assert.equal(updates.lastErrorKind, 'story_incomplete');
  assert.equal(updates.lastErrorClass, 'semantic');
  assert.equal(updates.lastErrorRetryable, false);
  assert.equal(updates.autoRecoveryStoppedAt, 1234);
  assert.equal(updates.autoRecoveryStopReason, 'story_incomplete');
  assert.equal(updates.autoRecoveryLastReason, 'story mismatch');
});
