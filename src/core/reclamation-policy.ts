export type ReclamationAttentionState =
  | 'retry'
  | 'target_sync'
  | 'reclamation'
  | 'manual_review'
  | 'retained';

export type ReclamationDecisionAction =
  | 'retain'
  | 'archive_only'
  | 'archive_then_reclaim'
  | 'remove_clean'
  | 'skip';

export interface ReclamationSafetyGate {
  name: string;
  passed: boolean;
  reason?: string;
}

export interface ReclamationDecision {
  attentionState: ReclamationAttentionState;
  action: ReclamationDecisionAction;
  reason: string;
  safetyGates: ReclamationSafetyGate[];
}
