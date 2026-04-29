import { TaskErrorClass } from '../types/task';

export type AgentErrorKind =
  | 'backend_high_demand'
  | 'backend_rate_limited'
  | 'transport_reconnecting'
  | 'transport_timeout'
  | 'browser_automation_failure'
  | 'auth_or_config_error'
  | 'agent_no_objective_evidence'
  | 'quality_gate_failure'
  | 'merge_conflict'
  | 'unknown_no_progress';

export interface ErrorClassification {
  kind: AgentErrorKind;
  class: TaskErrorClass;
  retryable: boolean;
  explicit: boolean;
  signature: string;
  message: string;
}

function normalizeOutput(output: string): string {
  return output.trim().slice(-1000);
}

export function classifyAgentFailureOutput(output: string): ErrorClassification {
  const normalized = normalizeOutput(output);

  if (/high demand|overloaded|temporarily errors/i.test(normalized)) {
    return {
      kind: 'backend_high_demand',
      class: 'transient_backend',
      retryable: true,
      explicit: true,
      signature: 'backend_high_demand',
      message: 'Backend reported high demand or temporary availability issues',
    };
  }

  if (/rate limit|too many requests|retry after/i.test(normalized)) {
    return {
      kind: 'backend_rate_limited',
      class: 'transient_backend',
      retryable: true,
      explicit: true,
      signature: 'backend_rate_limited',
      message: 'Backend reported rate limiting',
    };
  }

  if (/reconnecting|connection lost|connection reset|econnreset|network error/i.test(normalized)) {
    return {
      kind: 'transport_reconnecting',
      class: 'transport',
      retryable: true,
      explicit: true,
      signature: 'transport_reconnecting',
      message: 'Transport/session reconnecting or connection was lost',
    };
  }

  if (/timeout|timed out|deadline exceeded/i.test(normalized)) {
    return {
      kind: 'transport_timeout',
      class: 'transport',
      retryable: true,
      explicit: true,
      signature: 'transport_timeout',
      message: 'Transport or backend timed out',
    };
  }

  if (/browser|playwright|cdp|target closed|context closed|page crashed/i.test(normalized)) {
    return {
      kind: 'browser_automation_failure',
      class: 'browser_automation',
      retryable: true,
      explicit: true,
      signature: 'browser_automation_failure',
      message: 'Browser automation failed',
    };
  }

  if (/unauthorized|forbidden|permission|api key|authentication|login required/i.test(normalized)) {
    return {
      kind: 'auth_or_config_error',
      class: 'unknown',
      retryable: false,
      explicit: true,
      signature: 'auth_or_config_error',
      message: 'Authentication or configuration error',
    };
  }

  return {
    kind: 'unknown_no_progress',
    class: 'unknown',
    retryable: false,
    explicit: false,
    signature: 'unknown_no_progress',
    message: normalized,
  };
}

