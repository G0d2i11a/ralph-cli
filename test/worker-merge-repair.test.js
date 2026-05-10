const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveStoryCompletionDecision,
  verifyFinalizeRepairReadiness,
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

test('verifyMergeRepairReadiness marks git fetch timeouts as retryable transient probe failures', async () => {
  const task = createTask();
  const result = await verifyMergeRepairReadiness(
    task,
    createConfig(),
    async () => {
      throw new Error(
        'Command failed: git fetch\nConnection to 20.205.243.166 port 22 timed out\r\nfatal: Could not read from remote repository.'
      );
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.retryableTransient, true);
  assert.equal(result.errorClassification.kind, 'transport_timeout');
  assert.equal(result.errorClassification.retryable, true);
  assert.match(result.message, /Exact mergeability probe failed/);
});

test('verifyMergeRepairReadiness does not mark real conflicts as retryable transport failures', async () => {
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
  assert.equal(result.retryableTransient, false);
  assert.equal(result.errorClassification, undefined);
  assert.match(result.message, /docs\/TODO\.md/);
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

test('resolveStoryCompletionDecision accepts finalize repair only after exact gate proof passes', () => {
  const result = resolveStoryCompletionDecision({
    storyId: 'US-001',
    isMergeRepairAttempt: false,
    isFinalizeRepairAttempt: true,
    hasObjectiveEvidence: false,
    progressReason: 'no diff churn',
    finalizeRepairVerification: {
      ok: true,
      message: 'Exact finalize repair gate passed: pnpm run test',
    },
  });

  assert.equal(result.accepted, true);
  assert.equal(result.exactMergeabilityVerified, false);
  assert.match(result.message, /Exact finalize repair gate passed/);
});

test('resolveStoryCompletionDecision rejects finalize repair when exact gate still fails', () => {
  const result = resolveStoryCompletionDecision({
    storyId: 'US-001',
    isMergeRepairAttempt: false,
    isFinalizeRepairAttempt: true,
    hasObjectiveEvidence: true,
    progressReason: '2 file(s) changed',
    finalizeRepairVerification: {
      ok: false,
      message: 'Exact finalize repair gate still fails before Ralph finalizer: "pnpm run test" exited 1.',
    },
  });

  assert.equal(result.accepted, false);
  assert.equal(result.exactMergeabilityVerified, false);
  assert.match(result.message, /still fails/);
});

test('verifyFinalizeRepairReadiness runs recorded validation commands in the task worktree', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-finalize-repair-test-'));
  try {
    const task = createTask({
      id: 'task-finalize-repair',
      worktree: root,
      repoPath: root,
      repairContext: {
        mode: 'finalize',
        storyId: 'US-001',
        createdAt: Date.now(),
        reason: 'Quality gate failed.',
      },
      finalizerFailure: {
        failureKind: 'quality_gate',
        class: 'deterministic_fixture_drift',
        gate: 'test',
        requestedGate: 'test',
        packageLabel: 'packages/content-gen',
        cwd: root,
        command: 'node -e "process.exit(0)"',
        validationCommands: [
          'node -e "require(\\\"fs\\\").writeFileSync(\\\"proof.txt\\\", \\\"ok\\\")"',
          'node -e "process.exit(require(\\\"fs\\\").existsSync(\\\"proof.txt\\\") ? 0 : 1)"',
        ],
        rawMessage: 'failed',
      },
    });

    const result = await verifyFinalizeRepairReadiness(task, createConfig({
      'finalizer.qualityGateTimeout': 10,
    }));

    assert.equal(result.ok, true);
    assert.match(result.message, /Exact finalize repair gate passed/);
    assert.equal(fs.readFileSync(path.join(root, 'proof.txt'), 'utf8'), 'ok');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
