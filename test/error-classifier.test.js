const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyAgentFailureOutput } = require('../dist/core/error-classifier.js');

test('classifyAgentFailureOutput marks backend high-demand failures as retryable transient backend errors', () => {
  const result = classifyAgentFailureOutput('The backend is under high demand and temporarily errors right now.');

  assert.equal(result.kind, 'backend_high_demand');
  assert.equal(result.class, 'transient_backend');
  assert.equal(result.retryable, true);
  assert.equal(result.explicit, true);
});

test('classifyAgentFailureOutput marks reconnecting transport failures as retryable transport errors', () => {
  const result = classifyAgentFailureOutput('Connection lost while streaming output, reconnecting now.');

  assert.equal(result.kind, 'transport_reconnecting');
  assert.equal(result.class, 'transport');
  assert.equal(result.retryable, true);
  assert.equal(result.explicit, true);
});

test('classifyAgentFailureOutput marks auth/config failures as explicit non-retryable errors', () => {
  const result = classifyAgentFailureOutput('Unauthorized: API key missing, login required.');

  assert.equal(result.kind, 'auth_or_config_error');
  assert.equal(result.retryable, false);
  assert.equal(result.explicit, true);
});
