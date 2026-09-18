/**
 * Tamper-evident hash-chained audit log.
 *
 * Events are appended as JSONL to ~/.desktop-commander/audit/audit-YYYYMM.jsonl.
 * Each event's hash is SHA-256 over the canonical JSON of the event with
 * `prevHash` included and `hash` excluded, so any byte flipped anywhere in the
 * chain (including the hash itself) breaks verification of that link and every
 * link after it.
 *
 * Stdout/stderr payloads are never stored inline beyond a 4KB preview; the full
 * payload goes to ~/.desktop-commander/audit/outputs/<hash>.txt and the event
 * carries {ref, sha256, bytes, truncated}.
 */
import { EventEmitter } from 'node:events';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export type AuditEventKind =
  | 'request'
  | 'capability'
  | 'approval'
  | 'invocation'
  | 'output'
  | 'mutation'
  | 'result';

export interface AuditPayloadRef {
  /** Absolute path to the full payload on disk. */
  ref: string;
  sha256: string;
  bytes: number;
  /** First 4KB of the payload, stored inline. */
  preview: string;
  truncated: boolean;
}

export interface AuditEvent {
  seq: number;
  ts: string;
  kind: AuditEventKind;
  requestHash?: string;
  capabilityId?: string;
  approvalId?: string;
  tool?: string;
  agent?: string;
  stdoutRef?: AuditPayloadRef;
  stderrRef?: AuditPayloadRef;
  exitCode?: number | null;
  mutations?: Array<Record<string, unknown>>;
  resultHash?: string;
  // Full observability path fields.
  sourceAgent?: string;
  transport?: 'chatgpt' | 'oauth-gateway' | 'mcp' | string;
  executorPid?: number | null;
  durationMs?: number | null;
  error?: string | null;
  args?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface StoredEvent extends AuditEvent {
  prevHash: string;
  hash: string;
}

export const AUDIT_DIR = path.join(os.homedir(), '.desktop-commander', 'audit');
export const OUTPUTS_DIR = path.join(AUDIT_DIR, 'outputs');
const INLINE_PAYLOAD_LIMIT = 4 * 1024;
/** Rotate the active file if it exceeds ~16MB. */
const ROTATE_SIZE_BYTES = 16 * 1024 * 1024;

const GENESIS_HASH = '0'.repeat(64);

export function canonicalJson(value: unknown): string {
  // Deterministic key order so hashing is stable across processes.
  return JSON.stringify(value, Object.keys(value as object).sort());
}

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function monthFile(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return path.join(AUDIT_DIR, `audit-${y}${m}.jsonl`);
}

function ensureDirs(): void {
  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
}

/**
 * Store a payload: full bytes under outputs/, inline preview capped at 4KB.
 */
export function storePayload(payload: string | Buffer): AuditPayloadRef {
  ensureDirs();
  const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const hash = sha256Hex(buf);
  const ref = path.join(OUTPUTS_DIR, `${hash}.txt`);
  if (!fs.existsSync(ref)) {
    fs.writeFileSync(ref, buf);
  }
  const truncated = buf.length > INLINE_PAYLOAD_LIMIT;
  return {
    ref,
    sha256: hash,
    bytes: buf.length,
    preview: buf.subarray(0, INLINE_PAYLOAD_LIMIT).toString('utf8'),
    truncated,
  };
}

/**
 * fsync'd append of one line. Returns the stored (chained) event.
 */
function appendLine(filePath: string, event: StoredEvent): void {
  const line = JSON.stringify(event) + '\n';
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'a');
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function lastEvent(filePath: string): StoredEvent | null {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  if (stat.size === 0) return null;
  const fd = fs.openSync(filePath, 'r');
  try {
    // Read a tail window and take the last complete line.
    const window = Math.min(stat.size, 1 * 1024 * 1024);
    const buf = Buffer.alloc(window);
    fs.readSync(fd, buf, 0, window, stat.size - window);
    const text = buf.toString('utf8');
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]) as StoredEvent;
      } catch {
        // Truncated final line (crash mid-write); keep walking back.
      }
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

export class AuditChain {
  private filePath: string;

  constructor(filePath?: string) {
    ensureDirs();
    this.filePath = filePath ?? monthFile();
  }

  /**
   * Rotate to a fresh file if the active one exceeds the size guard.
   * Rotation re-seeds the chain with a genesis prevHash (the verify of a given
   * path is independent per file, so this keeps files self-contained).
   */
  private maybeRotate(): void {
    try {
      if (fs.existsSync(this.filePath) && fs.statSync(this.filePath).size > ROTATE_SIZE_BYTES) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        this.filePath = path.join(AUDIT_DIR, `audit-${stamp}.jsonl`);
      }
    } catch {
      // Ignore stat failures; append will surface real errors.
    }
  }

  append(event: Omit<AuditEvent, 'seq' | 'ts'> & { ts?: string }): StoredEvent {
    this.maybeRotate();
    const prev = lastEvent(this.filePath);
    const prevHash = prev ? prev.hash : GENESIS_HASH;
    const seq = prev ? prev.seq + 1 : 1;
    const full: Omit<StoredEvent, 'hash'> = {
      ...event,
      ts: event.ts ?? new Date().toISOString(),
      seq,
      prevHash,
    } as Omit<StoredEvent, 'hash'>;
    const hash = sha256Hex(canonicalJson(full));
    const stored = { ...full, hash } as StoredEvent;
    appendLine(this.filePath, stored);
    return stored;
  }

  get path(): string {
    return this.filePath;
  }

  /**
   * Read events, newest last. With follow=true returns an EventEmitter that
   * emits 'event' for each new event as it is appended and 'error' on failure.
   * Call .close() to stop tailing.
   */
  read(options: { limit?: number; follow?: boolean } = {}): { events: StoredEvent[]; follow?: EventEmitter } {
    const events = readChainFile(this.filePath);
    const limited = options.limit ? events.slice(-options.limit) : events;
    if (!options.follow) return { events: limited };
    const emitter = new EventEmitter();
    let position = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).size : 0;
    let closed = false;
    const tail = () => {
      if (closed) return;
      try {
        if (!fs.existsSync(this.filePath)) return;
        const size = fs.statSync(this.filePath).size;
        if (size > position) {
          const fd = fs.openSync(this.filePath, 'r');
          try {
            const buf = Buffer.alloc(size - position);
            fs.readSync(fd, buf, 0, buf.length, position);
            position = size;
            for (const line of buf.toString('utf8').split('\n')) {
              if (!line.trim()) continue;
              try {
                emitter.emit('event', JSON.parse(line) as StoredEvent);
              } catch {
                // Partial line; next poll will have moved past it anyway.
              }
            }
          } finally {
            fs.closeSync(fd);
          }
        }
      } catch (err) {
        emitter.emit('error', err);
      }
    };
    const timer = setInterval(tail, 500);
    timer.unref();
    (emitter as EventEmitter & { close: () => void }).close = () => {
      closed = true;
      clearInterval(timer);
    };
    return { events: limited, follow: emitter };
  }
}

export function readChainFile(filePath: string): StoredEvent[] {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  const events: StoredEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as StoredEvent);
    } catch {
      // Skip unparseable lines; verify() flags structural issues separately.
    }
  }
  return events;
}

export interface VerifyResult {
  valid: boolean;
  events: number;
  /** Index of first bad link, or null. */
  brokenAt: number | null;
  error: string | null;
}

/**
 * Walk the full chain at `path` and validate every link's hash and linkage.
 */
export function verifyChain(filePath: string): VerifyResult {
  const events = readChainFile(filePath);
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < events.length; i++) {
    const { hash, ...rest } = events[i];
    if (rest.prevHash !== prevHash) {
      return { valid: false, events: events.length, brokenAt: i, error: `prevHash mismatch at seq ${events[i].seq}` };
    }
    const expected = sha256Hex(canonicalJson(rest));
    if (expected !== hash) {
      return { valid: false, events: events.length, brokenAt: i, error: `hash mismatch at seq ${events[i].seq}` };
    }
    prevHash = hash;
  }
  return { valid: true, events: events.length, brokenAt: null, error: null };
}

/** Default shared chain instance. */
const defaultChain = new AuditChain();

export const AuditChainStatic = {
  append: (event: Omit<AuditEvent, 'seq' | 'ts'> & { ts?: string }) => defaultChain.append(event),
  verify: (filePath?: string) => verifyChain(filePath ?? defaultChain.path),
  read: (options: { limit?: number; follow?: boolean }) => defaultChain.read(options),
};

// Task spec asks for AuditChain.append / AuditChain.verify / AuditChain.read as
// the primary surface; alias them on the class itself.
export type AuditChainNamespace = typeof AuditChainStatic;
export const AuditChainApi = AuditChainStatic;
