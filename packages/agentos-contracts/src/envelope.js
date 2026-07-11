/**
 * Task envelope: the single admission contract for every agent task.
 * validateEnvelope() is fail-closed:
 *   - missing/extra/mistyped fields  -> invalid
 *   - unknown enum values            -> invalid
 *   - policy invariant violations    -> invalid (with reasons)
 * An invalid envelope MUST NOT be routed or executed.
 */

export const ORIGINS = Object.freeze([
  'cli', 'telegram', 'imessage', 'dashboard', 'openclaw', 'hermes', 'api',
]);

export const TASK_TYPES = Object.freeze([
  'coding', 'research', 'memory_lookup', 'browser_scrape',
  'deal_analysis', 'system_admin', 'unknown',
]);

export const RISK_LEVELS = Object.freeze(['read_only', 'draft', 'write', 'destructive']);
export const NETWORK_MODES = Object.freeze(['none', 'declared', 'unrestricted']);

export const RISK_RANK = Object.freeze({ read_only: 0, draft: 1, write: 2, destructive: 3 });

const REQUIRED_FIELDS = Object.freeze([
  'schema_version', 'task_id', 'goal', 'origin', 'task_type', 'allowed_tools',
  'workspace', 'risk_level', 'approval_required', 'success_criteria',
  'timeout_seconds', 'trace_required', 'rollback_required',
  'network_access', 'human_notes',
]);

const isStr = (v) => typeof v === 'string';
const isBool = (v) => typeof v === 'boolean';
const isStrArray = (v) => Array.isArray(v) && v.every(isStr);

/**
 * @returns {{ ok: boolean, reasons: string[], envelope: object|null }}
 */
export function validateEnvelope(input) {
  const reasons = [];

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reasons: ['envelope must be a JSON object'], envelope: null };
  }

  for (const f of REQUIRED_FIELDS) {
    if (!(f in input)) reasons.push(`missing field: ${f}`);
  }
  for (const k of Object.keys(input)) {
    if (!REQUIRED_FIELDS.includes(k)) reasons.push(`unknown field: ${k}`);
  }
  if (reasons.length) return { ok: false, reasons, envelope: null };

  // Types
  if (!isStr(input.schema_version) || input.schema_version !== '1.0') {
    reasons.push('schema_version must be "1.0"');
  }
  if (!isStr(input.task_id) || !/^[A-Za-z0-9._:-]{6,128}$/.test(input.task_id)) {
    reasons.push('task_id must be 6-128 chars of [A-Za-z0-9._:-]');
  }
  if (!isStr(input.goal) || input.goal.trim().length === 0 || input.goal.length > 4000) {
    reasons.push('goal must be a non-empty string <= 4000 chars');
  }
  if (!ORIGINS.includes(input.origin)) reasons.push(`origin must be one of: ${ORIGINS.join('|')}`);
  if (!TASK_TYPES.includes(input.task_type)) reasons.push(`task_type must be one of: ${TASK_TYPES.join('|')}`);
  if (!isStrArray(input.allowed_tools)) reasons.push('allowed_tools must be string[]');
  if (!isStr(input.workspace)) reasons.push('workspace must be a string');
  if (!RISK_LEVELS.includes(input.risk_level)) reasons.push(`risk_level must be one of: ${RISK_LEVELS.join('|')}`);
  if (!isBool(input.approval_required)) reasons.push('approval_required must be boolean');
  if (!isStrArray(input.success_criteria)) reasons.push('success_criteria must be string[]');
  if (!Number.isInteger(input.timeout_seconds) || input.timeout_seconds < 1 || input.timeout_seconds > 86400) {
    reasons.push('timeout_seconds must be an integer in [1, 86400]');
  }
  if (!isBool(input.trace_required)) reasons.push('trace_required must be boolean');
  if (!isBool(input.rollback_required)) reasons.push('rollback_required must be boolean');
  if (!NETWORK_MODES.includes(input.network_access)) {
    reasons.push(`network_access must be one of: ${NETWORK_MODES.join('|')}`);
  }
  if (!isStr(input.human_notes) || input.human_notes.length > 4000) {
    reasons.push('human_notes must be a string <= 4000 chars');
  }
  if (reasons.length) return { ok: false, reasons, envelope: null };

  // Policy invariants (fail-closed; these are rejections, not silent fixes)
  const rank = RISK_RANK[input.risk_level];
  if (rank >= RISK_RANK.write && input.trace_required !== true) {
    reasons.push('policy: trace_required must be true for write/destructive (no trace, no write)');
  }
  if (rank >= RISK_RANK.write && input.approval_required !== true) {
    reasons.push('policy: approval_required must be true for write/destructive');
  }
  if (input.risk_level === 'destructive' && input.rollback_required !== true) {
    reasons.push('policy: rollback_required must be true for destructive');
  }
  if (rank >= RISK_RANK.write && input.success_criteria.length === 0) {
    reasons.push('policy: success_criteria must be non-empty for write/destructive');
  }
  if (input.task_type === 'coding' && input.workspace.trim().length === 0) {
    reasons.push('policy: workspace required for coding tasks');
  }

  if (reasons.length) return { ok: false, reasons, envelope: null };
  return { ok: true, reasons: [], envelope: Object.freeze({ ...input }) };
}

/** Convenience factory with safe defaults. Output still must pass validateEnvelope. */
export function makeEnvelope(partial) {
  return {
    schema_version: '1.0',
    task_id: partial.task_id ?? `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    goal: '',
    origin: 'cli',
    task_type: 'unknown',
    allowed_tools: [],
    workspace: '',
    risk_level: 'read_only',
    approval_required: true,
    success_criteria: [],
    timeout_seconds: 900,
    trace_required: true,
    rollback_required: false,
    network_access: 'none',
    human_notes: '',
    ...partial,
  };
}
