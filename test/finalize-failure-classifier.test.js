const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyQualityGateFailure,
  QualityGateFailure,
  isQualityGateFailure,
} = require('../dist/core/finalize-failure-classifier.js');

test('classifyQualityGateFailure detects generated type drift from TypeScript diagnostics', () => {
  const details = classifyQualityGateFailure({
    requestedScript: 'typecheck',
    actualScript: 'typecheck',
    cwd: '/repo/apps/api',
    packageLabel: 'apps/api',
    command: 'pnpm run typecheck',
    rawMessage: 'Quality gate "typecheck" failed: type errors detected',
    stderr: [
      "src/service.ts(12,5): error TS2353: Object literal may only specify known properties, and 'sourceType' does not exist in type 'SpeakingPersonaWhereInput'.",
      "src/service.ts(18,5): error TS2339: Property 'sourceType' does not exist on type '{ id: string; }'.",
    ].join('\n'),
    exitCode: 2,
  });

  assert.equal(details.class, 'generated_type_drift');
  assert.equal(details.diagnosticCount, 2);
  assert.deepEqual(details.failedCodes, ['TS2339', 'TS2353']);
  assert.deepEqual(details.failedSymbols, ['sourceType']);
  assert.match(details.diagnosticSignature, /TS2353/);
});

test('classifyQualityGateFailure detects enum drift from TypeScript diagnostics', () => {
  const details = classifyQualityGateFailure({
    requestedScript: 'typecheck',
    actualScript: 'typecheck',
    cwd: '/repo/apps/api',
    packageLabel: 'apps/api',
    command: 'pnpm run typecheck',
    rawMessage: 'Quality gate "typecheck" failed: enum mismatch',
    stderr: 'src/service.ts(24,9): error TS2322: Type \'"REVIEWING_QUESTIONS"\' is not assignable to type \'PersonaStatus | undefined\'.',
    exitCode: 2,
  });

  assert.equal(details.class, 'enum_drift');
  assert.equal(details.failedSymbols?.includes('REVIEWING_QUESTIONS'), true);
});

test('QualityGateFailure preserves structured details on the thrown error', () => {
  const details = classifyQualityGateFailure({
    requestedScript: 'typecheck',
    actualScript: 'typecheck',
    cwd: '/repo/apps/api',
    packageLabel: 'apps/api',
    command: 'pnpm run typecheck',
    rawMessage: 'Quality gate "typecheck" timed out after 30s',
    timedOut: true,
  });

  const error = new QualityGateFailure(details);

  assert.equal(isQualityGateFailure(error), true);
  assert.equal(error.message, 'Quality gate "typecheck" timed out after 30s');
  assert.equal(error.details.class, 'quality_gate_timeout');
});
