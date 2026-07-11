/**
 * LoopTrace event model (contract layer).
 * Events form a per-run hash chain:
 *   hash_i = sha256( prev_hash + '\n' + canonical(event_without_hash) )
 * run_id and seq are inside the hashed body, so events cannot be replayed
 * across runs or reordered without breaking the chain (closes cross-path replay).
 */
import { createHash } from 'node:crypto';
import { normalizeFailureCode } from './failure-taxonomy.js';

export const EVENT_TYPES = Object.freeze([
  'task_received',
  'task_validated',
  'risk_classified',
  'route_selected',
  'approval_requested',
  'approval_decision',
  'rollback_checkpoint_created',
  'agent_started',
  'tool_call_started',
  'tool_call_finished',
  'file_diff_detected',
  'verification_started',
  'verification_finished',
  'promotion_blocked',
  'promotion_completed',
  'run_failed',
  'run_completed',
  'run_replay_started',
  'replay_divergence_detected',
  'trace_sealed',
]);

const TYPE_SET = new Set(EVENT_TYPES);
export const GENESIS_HASH = '0'.repeat(64);

// --- secret redaction -------------------------------------------------------
const SECRET_PATTERNS = [
  { re: /sk-[A-Za-z0-9_-]{16,}/g, cat: 'api_key' },
  { re: /ghp_[A-Za-z0-9]{20,}/g, cat: 'github_token' },
  { re: /github_pat_[A-Za-z0-9_]{20,}/g, cat: 'github_token' },
  { re: /AKIA[0-9A-Z]{16}/g, cat: 'aws_key' },
  { re: /(?:^|[\s"'=:])(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/g, cat: 'jwt' },
  { re: /bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, cat: 'bearer_token' },
  { re: /(password|passwd|secret|token|api[_-]?key)\s*[=:]\s*(?!\[REDACTED:)[^\s"']{6,}/gi, cat: 'credential_assignment' },
];

/** Redact secret VALUES, keep the category. Applied to every string in payloads. */
export function redactSecrets(text) {
  let out = String(text);
  let redacted = false;
  for (const { re, cat } of SECRET_PATTERNS) {
    out = out.replace(re, () => { redacted = true; return `[REDACTED:${cat}]`; });
  }
  return { text: out, redacted };
}

function redactDeep(value) {
  let redacted = false;
  const walk = (v) => {
    if (typeof v === 'string') {
      const r = redactSecrets(v);
      redacted = redacted || r.redacted;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, val] of Object.entries(v)) o[k] = walk(val);
      return o;
    }
    return v;
  };
  return { payload: walk(value), redacted };
}

// --- canonical JSON (stable key order) --------------------------------------
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

export function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// --- trace writer ------------------------------------------------------------
/**
 * Create an in-memory trace writer for a run. Caller persists via sink(event)
 * (e.g., JSONL append). Pure core: no I/O here.
 */
export function createTrace(run_id, { sink = null, clock = () => new Date().toISOString() } = {}) {
  if (!/^[A-Za-z0-9._:-]{6,128}$/.test(String(run_id))) {
    throw new Error('invalid run_id');
  }
  const events = [];
  let prev = GENESIS_HASH;
  let seq = 0;
  let sealed = false;

  function append(type, payload = {}) {
    if (sealed) throw new Error('trace sealed');
    if (!TYPE_SET.has(type)) throw new Error(`unknown event type: ${type}`);
    if (type === 'run_failed' || type === 'promotion_blocked') {
      payload = { ...payload, failure_code: normalizeFailureCode(payload.failure_code) };
    }
    const { payload: safePayload, redacted } = redactDeep(payload);
    const body = { run_id: String(run_id), seq, ts: clock(), type, payload: safePayload, redacted, prev_hash: prev };
    const hash = sha256(prev + '\n' + canonical(body));
    const event = Object.freeze({ ...body, hash });
    events.push(event);
    prev = hash;
    seq += 1;
    if (sink) sink(event);
    if (type === 'trace_sealed') sealed = true;
    return event;
  }

  function seal() { return append('trace_sealed', { final_seq: seq }); }

  return { append, seal, events, get head() { return prev; }, get sealed() { return sealed; } };
}

/** Verify a full event chain. Returns first tamper point or ok. */
export function verifyChain(events) {
  let prev = GENESIS_HASH;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.seq !== i) return { ok: false, index: i, reason: `seq mismatch: expected ${i}, got ${e.seq}` };
    if (e.prev_hash !== prev) return { ok: false, index: i, reason: 'prev_hash mismatch (chain broken)' };
    const { hash, ...body } = e;
    const expect = sha256(prev + '\n' + canonical(body));
    if (hash !== expect) return { ok: false, index: i, reason: 'hash mismatch (event tampered)' };
    prev = hash;
  }
  return { ok: true, index: events.length, reason: null };
}

/**
 * Replay divergence detection: compare event type sequence + payload digests.
 * Timestamps and hashes are excluded (they legitimately differ across replays).
 */
export function detectReplayDivergence(original, replay) {
  const digest = (e) => `${e.type}:${sha256(canonical(e.payload))}`;
  const n = Math.min(original.length, replay.length);
  for (let i = 0; i < n; i++) {
    if (digest(original[i]) !== digest(replay[i])) {
      return { diverged: true, index: i, original: digest(original[i]), replay: digest(replay[i]) };
    }
  }
  if (original.length !== replay.length) {
    return { diverged: true, index: n, original: `len=${original.length}`, replay: `len=${replay.length}` };
  }
  return { diverged: false, index: -1, original: null, replay: null };
}
