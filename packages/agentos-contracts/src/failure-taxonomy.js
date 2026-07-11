/**
 * Canonical failure taxonomy for the agent OS.
 * Every run_failed / promotion_blocked event MUST carry one of these codes.
 * Frozen: adding a code is a contract change (bump schema_version).
 */
export const FAILURE_CODES = Object.freeze([
  'policy_blocked',
  'approval_required',
  'tool_unavailable',
  'timeout',
  'test_failed',
  'typecheck_failed',
  'lint_failed',
  'network_blocked',
  'dirty_worktree',
  'unexpected_diff',
  'secret_detected',
  'unsafe_command',
  'replay_diverged',
  'human_interrupted',
  'gate_missing_evidence',
  'trace_missing',
  'unknown_failure',
]);

const SET = new Set(FAILURE_CODES);

/** Return a valid failure code; anything unrecognized collapses to unknown_failure (fail-closed). */
export function normalizeFailureCode(code) {
  return SET.has(code) ? code : 'unknown_failure';
}

export function isFailureCode(code) {
  return SET.has(code);
}
