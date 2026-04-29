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
    observedPackageSurface: ['apps/api', 'packages/db'],
    observedWriteSurface: ['apps/api/src/service.ts', 'packages/db/prisma/schema.prisma'],
  }, story);

  assert.match(result.title, /Finalize repair/);
  assert.match(result.description, /not a new feature pass/i);
  assert.match(result.description, /Failed gate: requested=typecheck, actual=typecheck, package=apps\/api/);
  assert.match(result.description, /Failed symbols: sourceType/);
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
