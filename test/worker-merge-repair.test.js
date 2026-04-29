const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveStoryCompletionDecision,
  verifyMergeRepairReadiness,
} = require('../dist/worker.js');

function createTask(overrides = {}) {
  return {
    id: 'task-merge-repair',
    prdPath: '/tmp/prd.json',
    status: 'running',
    startTime: Date.now(),
    completedUS: ['US-001'],
    worktree: '/tmp/worktree',
    logPath: '/tmp/agent.log',
    agent: 'codex',
    repoPath: '/tmp/repo',
    loopCount: 0,
    consecutiveNoProgress: 0,
    consecutiveErrors: 0,
    lastProgressTime: Date.now(),
    lastFilesChanged: 0,
    repairContext: {
      mode: 'merge',
      storyId: 'US-002',
      createdAt: Date.now(),
      reason: 'Merge repair required by Ralph.',
    },
    ...overrides,
  };
}

function createConfig(values = {}) {
  return {
    get(key) {
      const defaults = {
        'merge.targetBranch': 'main',
        'merge.pullLatest': true,
        'merge.useIntegrationWorktree': true,
        'merge.integrationWorktreeDir': '.ralph-integration',
        'merge.syncTargetBranch': true,
        'merge.autoIntegrate': true,
      };

      return values[key] ?? defaults[key];
    },
  };
}

test('verifyMergeRepairReadiness rejects merge repairs until the exact probe is clean', async () => {
  const task = createTask();
  const result = await verifyMergeRepairReadiness(
    task,
    createConfig(),
    async () => ({
      mergeable: false,
      alreadyIntegrated: false,
      message: 'Merge conflicts detected: docs/TODO.md',
      conflictFiles: ['docs/TODO.md'],
      integrationBranch: 'ralph/integration/main',
      integrationWorktree: '/tmp/integration',
    })
  );

  assert.equal(result.ok, false);
  assert.match(result.message, /Exact mergeability probe still fails/);
  assert.match(result.message, /docs\/TODO\.md/);
});

test('verifyMergeRepairReadiness accepts merge repairs when the exact probe passes', async () => {
  const task = createTask();
  const result = await verifyMergeRepairReadiness(
    task,
    createConfig(),
    async () => ({
      mergeable: true,
      alreadyIntegrated: false,
      message: 'ralph/task can merge cleanly',
      integrationBranch: 'ralph/integration/main',
      integrationWorktree: '/tmp/integration',
    })
  );

  assert.equal(result.ok, true);
  assert.match(result.message, /Exact mergeability probe passed/);
});

test('verifyMergeRepairReadiness recognizes resolved pending merges as finalizer-ready proof', async () => {
  const task = createTask();
  const result = await verifyMergeRepairReadiness(
    task,
    createConfig(),
    async () => ({
      mergeable: true,
      alreadyIntegrated: false,
      message: 'Resolved pending merge in task worktree can be finalized against ralph/integration/main',
      integrationBranch: 'ralph/integration/main',
      integrationWorktree: '/tmp/integration',
      sourceKind: 'resolved_pending_merge',
      worktreeMergeState: {
        kind: 'resolved_pending_commit',
        usesGitLocal: true,
        gitDir: '/tmp/worktree/.git-local',
        headSha: 'abc123',
        mergeParents: ['def456'],
        unmergedFiles: [],
        changedFiles: [],
        statusPorcelain: '',
        statusSignature: 'sig',
      },
    })
  );

  assert.equal(result.ok, true);
  assert.match(result.message, /awaiting finalizer commit/);
});

test('resolveStoryCompletionDecision accepts merge repair success with exact probe even without diff churn', () => {
  const result = resolveStoryCompletionDecision({
    storyId: 'US-002',
    isMergeRepairAttempt: true,
    hasObjectiveEvidence: false,
    progressReason: 'no diff churn',
    mergeRepairVerification: {
      ok: true,
      message: 'Exact mergeability probe passed against ralph/integration/main',
    },
  });

  assert.equal(result.accepted, true);
  assert.equal(result.exactMergeabilityVerified, true);
  assert.match(result.message, /Exact mergeability probe passed/);
});

test('resolveStoryCompletionDecision rejects merge repair success when exact probe still fails even if files changed', () => {
  const result = resolveStoryCompletionDecision({
    storyId: 'US-002',
    isMergeRepairAttempt: true,
    hasObjectiveEvidence: true,
    progressReason: '2 file\\(s\\) changed',
    mergeRepairVerification: {
      ok: false,
      message: 'Exact mergeability probe still fails against ralph/integration/main. Conflict files: docs/TODO.md.',
    },
  });

  assert.equal(result.accepted, false);
  assert.equal(result.exactMergeabilityVerified, false);
  assert.match(result.message, /still fails/);
});
