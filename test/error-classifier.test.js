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

test('classifyAgentFailureOutput marks Codex context-window exhaustion as retryable agent-session errors', () => {
  const result = classifyAgentFailureOutput(
    'ERROR: Codex ran out of room in the model context window. Start a new thread or clear earlier history before retrying.',
  );

  assert.equal(result.kind, 'agent_context_window_exhausted');
  assert.equal(result.class, 'agent_session');
  assert.equal(result.retryable, true);
  assert.equal(result.explicit, true);
});

test('classifyAgentFailureOutput still treats browser context closed as browser automation failure', () => {
  const result = classifyAgentFailureOutput('Playwright target closed because the browser context closed.');

  assert.equal(result.kind, 'browser_automation_failure');
  assert.equal(result.class, 'browser_automation');
  assert.equal(result.retryable, true);
  assert.equal(result.explicit, true);
});

test('classifyAgentFailureOutput marks auth/config failures as explicit non-retryable errors', () => {
  const result = classifyAgentFailureOutput('Unauthorized: API key missing, login required.');

  assert.equal(result.kind, 'auth_or_config_error');
  assert.equal(result.retryable, false);
  assert.equal(result.explicit, true);
});
