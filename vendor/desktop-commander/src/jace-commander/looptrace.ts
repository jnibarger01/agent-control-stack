/**
 * LoopTrace-compatible event chain (agentos://schemas/trace-event/1.0).
 *
 * Byte-compatible with agent-control-stack packages/agentos-contracts
 * src/trace-events.js: hash_i = sha256(prev_hash + '\n' + canonical(body)),
 * GENESIS = 64 zeros, run_id/seq inside the hashed body, secret VALUES
 * redacted before hashing.
 *
 * Authority note (ACS ADR 0011): ACS's SQLite audit_events chain is the only
 * canonical audit record. Chains written here are local evidence/telemetry
 * that LoopTrace and the visualizer can read; they never stand in for an ACS
 * approval or result.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const LOOPTRACE_EVENT_TYPES = Object.freeze([
  'task_received', 'task_validated', 'risk_classified', 'route_selected',
  'approval_requested', 'approval_decision', 'rollback_checkpoint_created',
  'agent_started', 'tool_call_started', 'tool_call_finished',
  'file_diff_detected', 'verification_started', 'verification_finished',
  'promotion_blocked', 'promotion_completed', 'run_failed', 'run_completed',
  'run_replay_started', 'replay_divergence_detected', 'trace_sealed',
] as const);
export type LoopTraceEventType = typeof LOOPTRACE_EVENT_TYPES[number];

export const GENESIS_HASH = '0'.repeat(64);
const RUN_ID_PATTERN = /^[A-Za-z0-9._:-]{6,128}$/;
const TYPE_SET = new Set<string>(LOOPTRACE_EVENT_TYPES);

export interface LoopTraceEvent {
  run_id: string;
  seq: number;
  ts: string;
  type: LoopTraceEventType;
  payload: Record<string, unknown>;
  redacted: boolean;
  prev_hash: string;
  hash: string;
}

const SECRET_PATTERNS: ReadonlyArray<{ re: RegExp; cat: string }> = [
  { re: /sk-[A-Za-z0-9_-]{16,}/g, cat: 'api_key' },
  { re: /ghp_[A-Za-z0-9]{20,}/g, cat: 'github_token' },
  { re: /github_pat_[A-Za-z0-9_]{20,}/g, cat: 'github_token' },
  { re: /AKIA[0-9A-Z]{16}/g, cat: 'aws_key' },
  { re: /(?:^|[\s"'=:])(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/g, cat: 'jwt' },
  { re: /bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, cat: 'bearer_token' },
  { re: /(password|passwd|secret|token|api[_-]?key)\s*[=:]\s*(?!\[REDACTED:)[^\s"']{6,}/gi, cat: 'credential_assignment' },
];

export function redactSecrets(text: string): { text: string; redacted: boolean } {
  let out = String(text);
  let redacted = false;
  for (const { re, cat } of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      redacted = true;
      return `[REDACTED:${cat}]`;
    });
  }
  return { text: out, redacted };
}

// An argv entry naming a secret-bearing option whose value is the NEXT entry
// (`--password X`), or a bare `Bearer` / `Authorization:` word. Mirrors
// redactJaceCommanderArgv in ACS (packages/desktop-commander-adapter).
const SECRET_OPTION_ENTRY =
  /^(?:-{1,2}[A-Za-z0-9_.-]{0,64}(?:secret|token|passw(?:or)?d|pass|pwd|api[-_]?key|private[-_]?key|credential|auth(?:orization)?|bearer|cookie)[A-Za-z0-9_.-]{0,64}|bearer|basic|(?:proxy-)?authorization:?|cookie:?|[A-Za-z0-9_.-]{0,64}(?:secret|token|passw(?:or)?d|api[-_]?key)[A-Za-z0-9_.-]{0,64}[:=])$/i;
// 32+ token characters mixing upper case, lower case and digits (API keys).
// Lower-case hex and UUIDs do not match; "/" is excluded so paths never do.
const KEY_SHAPED_RUN = /[A-Za-z0-9+_=-]{32,4096}/g;

/**
 * Argv-aware redaction for evidence (the privileged audit chain): secret
 * values after a secret-bearing option, key-shaped values, and everything
 * redactSecrets catches. The exact argv stays bound through the capability's
 * invocation hash, which the audit records alongside.
 */
export function redactArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  let hideNext = false;
  for (const entry of argv) {
    if (hideNext) {
      out.push('[REDACTED:option_value]');
      hideNext = /^(?:bearer|basic)$/i.test(entry);
      continue;
    }
    const text = redactSecrets(entry).text.replace(KEY_SHAPED_RUN, (run) =>
      /[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run) ? '[REDACTED:key_shaped]' : run,
    );
    out.push(text);
    hideNext = SECRET_OPTION_ENTRY.test(entry);
  }
  return out;
}

function redactDeep(value: unknown): { payload: unknown; redacted: boolean } {
  let redacted = false;
  const walk = (entry: unknown): unknown => {
    if (typeof entry === 'string') {
      const result = redactSecrets(entry);
      redacted ||= result.redacted;
      return result.text;
    }
    if (Array.isArray(entry)) return entry.map(walk);
    if (entry && typeof entry === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(entry)) out[key] = walk(item);
      return out;
    }
    return entry;
  };
  return { payload: walk(value), redacted };
}

/** Same stable-key canonical form as agentos-contracts `canonical()`. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function buildEvent(
  runId: string,
  seq: number,
  prevHash: string,
  type: LoopTraceEventType,
  payload: Record<string, unknown>,
  ts: string,
): LoopTraceEvent {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error('invalid run_id');
  if (!TYPE_SET.has(type)) throw new Error(`unknown event type: ${type}`);
  // Hash exactly what will be persisted: JSON drops undefined-valued keys,
  // but canonical() would hash them as `undefined`, making the stored chain
  // unverifiable. Round-tripping first keeps hash input == file bytes.
  const persisted = JSON.parse(JSON.stringify(payload ?? {})) as Record<string, unknown>;
  const { payload: safePayload, redacted } = redactDeep(persisted);
  const body = { run_id: runId, seq, ts, type, payload: safePayload as Record<string, unknown>, redacted, prev_hash: prevHash };
  return Object.freeze({ ...body, hash: sha256(`${prevHash}\n${canonical(body)}`) });
}

export interface ChainVerification {
  ok: boolean;
  index: number;
  reason: string | null;
}

export function verifyChain(events: readonly unknown[]): ChainVerification {
  let prev = GENESIS_HASH;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index] as Partial<LoopTraceEvent> | null;
    if (!event || typeof event !== 'object') return { ok: false, index, reason: 'event is not an object' };
    if (event.seq !== index) return { ok: false, index, reason: `seq mismatch: expected ${index}, got ${String(event.seq)}` };
    if (event.prev_hash !== prev) return { ok: false, index, reason: 'prev_hash mismatch (chain broken)' };
    const { hash, ...body } = event;
    if (hash !== sha256(`${prev}\n${canonical(body)}`)) return { ok: false, index, reason: 'hash mismatch (event tampered)' };
    prev = hash;
  }
  return { ok: true, index: events.length, reason: null };
}

const MAX_TRACE_BYTES = 32 * 1024 * 1024;

/** Parses a JSONL trace file. Malformed lines are reported, never skipped. */
export function readTraceFile(filePath: string): { events: unknown[]; parseError?: { line: number; reason: string } } {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('trace path is not a regular file');
  if (stat.size > MAX_TRACE_BYTES) throw new Error(`trace file exceeds ${MAX_TRACE_BYTES} bytes`);
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const events: unknown[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      return { events, parseError: { line: index + 1, reason: 'invalid JSON' } };
    }
  }
  return { events };
}

/**
 * Append-only JSONL chain writer with a cross-process O_EXCL lock. The tail
 * is re-read and re-verified under the lock before every append, so a
 * tampered or truncated file is detected instead of silently extended.
 */
export class JsonlTraceChain {
  constructor(private readonly filePath: string, private readonly runId: string, private readonly fileMode = 0o600) {
    if (!RUN_ID_PATTERN.test(runId)) throw new Error('invalid run_id');
  }

  append(type: LoopTraceEventType, payload: Record<string, unknown>, ts = new Date().toISOString()): LoopTraceEvent {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const lockPath = `${this.filePath}.lock`;
    const lock = acquireLock(lockPath);
    try {
      let events: unknown[] = [];
      if (fs.existsSync(this.filePath)) {
        const parsed = readTraceFile(this.filePath);
        if (parsed.parseError) throw new Error(`trace chain unreadable at line ${parsed.parseError.line}`);
        events = parsed.events;
        const check = verifyChain(events);
        if (!check.ok) throw new Error(`trace chain invalid at index ${check.index}: ${check.reason}`);
      }
      const last = events[events.length - 1] as LoopTraceEvent | undefined;
      const event = buildEvent(this.runId, events.length, last?.hash ?? GENESIS_HASH, type, payload, ts);
      const fd = fs.openSync(this.filePath, 'a', this.fileMode);
      try {
        fs.writeSync(fd, `${JSON.stringify(event)}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return event;
    } finally {
      releaseLock(lockPath, lock);
    }
  }
}

function acquireLock(lockPath: string): string {
  const token = crypto.randomBytes(16).toString('hex');
  const deadline = Date.now() + 5_000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
      fs.closeSync(fd);
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (lockHolderDead(lockPath)) {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error('trace chain lock timeout');
      Atomics.wait(wait, 0, 0, 10);
    }
  }
}

function lockHolderDead(lockPath: string): boolean {
  try {
    const { pid } = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: unknown };
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function releaseLock(lockPath: string, token: string): void {
  try {
    const held = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { token?: unknown };
    if (held.token === token) fs.rmSync(lockPath, { force: true });
  } catch {
    // Never remove a lock we no longer own.
  }
}
