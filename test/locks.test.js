const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  getIntegrationLaneLockDir,
  getRepoMergeLockDir,
  getTaskFinalizeLockDir,
  withIntegrationLaneLock,
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

test('lock directories are isolated across different Ralph homes', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-lock-home-'));
  const homeA = path.join(tempDir, 'ralph-a');
  const homeB = path.join(tempDir, 'ralph-b');
  const taskLockA = getTaskFinalizeLockDir('shared-task', { ralphHome: homeA });
  const taskLockB = getTaskFinalizeLockDir('shared-task', { ralphHome: homeB });
  const mergeLockA = getRepoMergeLockDir('/tmp/repo', { ralphHome: homeA });
  const mergeLockB = getRepoMergeLockDir('/tmp/repo', { ralphHome: homeB });

  try {
    assert.notEqual(taskLockA, taskLockB);
    assert.notEqual(mergeLockA, mergeLockB);

    await Promise.all([
      withTaskFinalizeLock('shared-task', async () => {}, { ralphHome: homeA }),
      withTaskFinalizeLock('shared-task', async () => {}, { ralphHome: homeB }),
      withRepoMergeLock('/tmp/repo', async () => {}, { ralphHome: homeA }),
      withRepoMergeLock('/tmp/repo', async () => {}, { ralphHome: homeB }),
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('withIntegrationLaneLock serializes concurrent callers for the same repo and lane', async () => {
  const events = [];
  let releaseFirst;
  let secondStarted = false;
  const repoPath = '/tmp/ralph-lock-repo';
  const lane = 'main';

  const first = withIntegrationLaneLock(repoPath, lane, async () => {
    events.push('first-start');
    await new Promise((resolve) => {
      releaseFirst = resolve;
    });
    events.push('first-end');
  });

  await new Promise((resolve) => setTimeout(resolve, 100));

  const second = withIntegrationLaneLock(repoPath, lane, async () => {
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

test('integration lane lock directories vary by lane', () => {
  const laneA = getIntegrationLaneLockDir('/tmp/repo', 'main');
  const laneB = getIntegrationLaneLockDir('/tmp/repo', 'contracts');

  assert.notEqual(laneA, laneB);
});
