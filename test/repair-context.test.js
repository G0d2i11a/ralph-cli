const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildStoryExecutionPayload,
  buildTaskRepairContext,
} = require('../dist/core/repair-context.js');

test('buildStoryExecutionPayload rewrites anchored story into finalize repair prompt', () => {
  const story = {
    id: 'US-007',
    title: 'Import speaking persona',
    description: 'Implement the import flow.',
    acceptanceCriteria: ['persona can be imported'],
  };

  const result = buildStoryExecutionPayload({
    prdTitle: 'Speaking Persona',
    prdId: 'prd-speaking-public-beta-user-import',
    repairContext: buildTaskRepairContext({
      mode: 'finalize',
      storyId: 'US-007',
      reason: 'Quality gate "typecheck" failed',
      createdAt: 1,
    }),
    finalizerFailure: {
      failureKind: 'quality_gate',
      class: 'generated_type_drift',
      gate: 'typecheck',
      requestedGate: 'typecheck',
      packageLabel: 'apps/api',
      cwd: '/repo/apps/api',
      command: 'pnpm --filter api check-types',
      diagnosticCount: 2,
      failedFiles: ['src/service.ts'],
      failedCodes: ['TS2353'],
      failedSymbols: ['sourceType'],
      diagnostics: [
        {
          file: 'src/service.ts',
          line: 42,
          column: 11,
          severity: 'error',
          code: 'TS2353',
          symbol: 'sourceType',
          message: 'Object literal may only specify known properties.',
        },
      ],
      rawMessage: 'Quality gate "typecheck" failed',
    },
    validationEvidence: {
      schemaVersion: 1,
      source: 'finalizer',
      taskId: 'repair-prompt-task',
      generatedAt: 1_700_000_000_000,
      configuredGates: ['typecheck', 'test', 'lint'],
      summary: {
        total: 3,
        passed: 1,
        failed: 1,
        skipped: 1,
        classifications: {
          passed: 1,
          quality_gate_timeout: 1,
          skipped: 1,
        },
      },
      runs: [
        {
          phase: 'quality_gate',
          requestedGate: 'typecheck',
          gate: 'typecheck',
          status: 'passed',
          classification: 'passed',
          packageLabel: 'apps/api',
          command: 'pnpm --filter api check-types',
          exitCode: 0,
          durationMs: 50,
        },
        {
          phase: 'quality_gate',
          requestedGate: 'test',
          gate: 'test',
          status: 'failed',
          classification: 'quality_gate_timeout',
          packageLabel: 'apps/api',
          command: 'pnpm --filter api test',
          durationMs: 10_000,
          timedOut: true,
        },
        {
          phase: 'quality_gate',
          requestedGate: 'lint',
          gate: 'lint',
          status: 'skipped',
          classification: 'skipped',
          packageLabel: 'apps/api',
          reason: 'script "lint" is not defined for apps/api',
        },
      ],
    },
    observedPackageSurface: ['apps/api', 'packages/db'],
    observedWriteSurface: ['apps/api/src/service.ts', 'packages/db/prisma/schema.prisma'],
  }, story);

  assert.match(result.title, /Finalize repair/);
  assert.match(result.description, /not a new feature pass/i);
  assert.match(result.description, /Failed gate: requested=typecheck, actual=typecheck, package=apps\/api/);
  assert.match(result.description, /Failed symbols: sourceType/);
  assert.match(result.description, /Latest validation evidence: total=3; passed=1; failed=1; skipped=1/);
  assert.match(result.description, /quality_gate typecheck->typecheck apps\/api: passed, exit=0, duration=50ms/);
  assert.match(result.description, /quality_gate test->test apps\/api: failed, quality_gate_timeout, timed out, duration=10000ms/);
  assert.match(result.description, /quality_gate lint->lint apps\/api: skipped, script "lint" is not defined for apps\/api/);
  assert.match(result.description, /Observed package surface: apps\/api, packages\/db/);
  assert.match(result.acceptanceCriteria[0], /Repair the failed finalizer quality gate/);
  assert.match(result.acceptanceCriteria[result.acceptanceCriteria.length - 1], /Preserve original requirement/);
});

test('buildStoryExecutionPayload rewrites anchored story into merge repair prompt', () => {
  const story = {
    id: 'US-003',
    title: 'Merge integration task',
    description: 'Original story body.',
    acceptanceCriteria: ['existing behavior preserved'],
  };

  const result = buildStoryExecutionPayload({
    repairContext: buildTaskRepairContext({
      mode: 'merge',
      storyId: 'US-003',
      reason: 'Merge repair required by Ralph.',
      createdAt: 1,
    }),
    mergeConflictFiles: ['apps/api/src/service.ts', 'packages/db/prisma/schema.prisma'],
  }, story);

  assert.match(result.title, /Merge repair/);
  assert.match(result.description, /merge repair/i);
  assert.match(result.description, /Conflict files: apps\/api\/src\/service\.ts, packages\/db\/prisma\/schema\.prisma/);
  assert.match(result.description, /actual task branch\/worktree itself passes the exact mergeability probe/i);
  assert.match(result.acceptanceCriteria[0], /Resolve the merge conflict/);
  assert.match(result.acceptanceCriteria[2], /tests alone are not sufficient/i);
});

test('buildStoryExecutionPayload truncates oversized inline repair context lists', () => {
  const story = {
    id: 'US-003',
    title: 'Merge integration task',
    description: 'Original story body.',
    acceptanceCriteria: ['existing behavior preserved'],
  };

  const observedWriteSurface = Array.from({ length: 15 }, (_, index) => `packages/app/file-${index + 1}.ts`);
  const result = buildStoryExecutionPayload({
    repairContext: buildTaskRepairContext({
      mode: 'merge',
      storyId: 'US-003',
      reason: 'Merge repair required by Ralph.',
      createdAt: 1,
    }),
    observedWriteSurface,
  }, story);

  assert.match(result.description, /packages\/app\/file-1\.ts/);
  assert.match(result.description, /\.\.\. 3 more omitted/);
  assert.doesNotMatch(result.description, /packages\/app\/file-15\.ts/);
});
