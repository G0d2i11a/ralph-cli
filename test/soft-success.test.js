const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectCompletionSignals,
  shouldTreatNonZeroExitAsSuccess,
} = require('../dist/core/soft-success.js');

test('detectCompletionSignals recognizes completion summary, validation, and commit message', () => {
  const output = `
**Done**
- Reworked the exception layer

**Validation**
- 8 suites, 233 tests passed

Suggested commit message: refactor(api): replace raw service errors with domain exceptions
`;

  const signals = detectCompletionSignals(output);
  assert.equal(signals.hasCompletionSummary, true);
  assert.equal(signals.hasValidationSignal, true);
  assert.equal(signals.hasSuggestedCommitMessage, true);
  assert.deepEqual(signals.matchedSignals, [
    'completion_summary',
    'validation',
    'suggested_commit_message',
  ]);
});

test('shouldTreatNonZeroExitAsSuccess accepts non-zero exit when progress and completion signals exist', () => {
  const decision = shouldTreatNonZeroExitAsSuccess({
    output: `
**Done**
- Implemented the change

**Validation**
- 8 suites, 233 tests passed

Suggested commit message: feat: finalize soft success
`,
    progress: {
      hasProgress: true,
      filesChanged: 12,
      newCommits: 0,
    },
  });

  assert.equal(decision.shouldTreatAsSuccess, true);
  assert.match(decision.reason, /progress \+ signals/i);
});

test('shouldTreatNonZeroExitAsSuccess rejects non-zero exit without strong completion evidence', () => {
  const decision = shouldTreatNonZeroExitAsSuccess({
    output: 'ERROR: exceeded retry limit, last status: 429 Too Many Requests',
    progress: {
      hasProgress: false,
      filesChanged: 0,
      newCommits: 0,
    },
  });

  assert.equal(decision.shouldTreatAsSuccess, false);
});
