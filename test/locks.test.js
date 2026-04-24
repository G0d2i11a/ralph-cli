const test = require('node:test');
const assert = require('node:assert/strict');

const {
  withRepoMergeLock,
  withTaskFinalizeLock,
} = require('../dist/core/locks.js');

test('withTaskFinalizeLock serializes concurrent callers for the same task', async () => {
  const events = [];
  let releaseFirst;
  let secondStarted = false;

  const first = withTaskFinalizeLock('task-lock-test', async () => {
    events.push('first-start');
    await new Promise((resolve) => {
      releaseFirst = resolve;
    });
    events.push('first-end');
  });

  await new Promise((resolve) => setTimeout(resolve, 100));

  const second = withTaskFinalizeLock('task-lock-test', async () => {
    secondStarted = true;
    events.push('second-start');
    events.push('second-end');
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(secondStarted, false);

  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(events, [
    'first-start',
    'first-end',
    'second-start',
    'second-end',
  ]);
});

test('withRepoMergeLock serializes concurrent callers for the same repository', async () => {
  const events = [];
  let releaseFirst;
  let secondStarted = false;
  const repoPath = '/tmp/ralph-lock-repo';

  const first = withRepoMergeLock(repoPath, async () => {
    events.push('first-start');
    await new Promise((resolve) => {
      releaseFirst = resolve;
    });
    events.push('first-end');
  });

  await new Promise((resolve) => setTimeout(resolve, 100));

  const second = withRepoMergeLock(repoPath, async () => {
    secondStarted = true;
    events.push('second-start');
    events.push('second-end');
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(secondStarted, false);

  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(events, [
    'first-start',
    'first-end',
    'second-start',
    'second-end',
  ]);
});
