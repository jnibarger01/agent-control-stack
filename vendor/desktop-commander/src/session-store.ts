import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

/**
 * Durable persistence for process sessions (P2.1), so a server restart can
 * tell the difference between "this session is still running", "it
 * finished before we came back up", and "we have no idea — treat it as
 * gone" instead of silently forgetting every in-flight process existed.
 *
 * Deliberately NOT persisted here: process output. Durably streaming every
 * byte of stdout/stderr to disk is a materially bigger feature (its own
 * backpressure/retention/redaction story) than "recover enough state to
 * classify and, where safe, terminate a session after a restart" — the
 * problem this module solves. A recovered session is therefore live-and-
 * terminable but not live-and-streamable: see terminal-manager.ts's
 * RecoveredSession handling for the explicit, user-facing statement of
 * that boundary. This keeps the persisted record itself small (one JSON
 * file per session, no unbounded growth from output) and keeps the
 * existing in-memory output buffer caps (MAX_BUFFERED_OUTPUT_CHARS) as the
 * only place output volume is bounded — nothing here bypasses them.
 */

const SESSION_SCHEMA_VERSION = 1;

export const SessionStatus = z.enum(['running', 'completed', 'terminated', 'stale']);
export type SessionStatus = z.infer<typeof SessionStatus>;

const PersistedSessionRecordSchema = z.object({
  schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
  sessionId: z.string().uuid(),
  pid: z.number().int().positive(),
  // Undefined when fingerprinting failed at spawn time (e.g. unsupported
  // platform) — such a record can never be recovered as 'alive', only ever
  // classified 'stale' on reconciliation. See process-identity.ts.
  processStartFingerprint: z.string().min(1).optional(),
  // Diagnostic/audit only — never used for authorization or for deciding
  // what a recovered session is allowed to do.
  command: z.string(),
  cwd: z.string().optional(),
  shell: z.string().optional(),
  ownerRuntimeId: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  status: SessionStatus,
  exitCode: z.number().int().nullable().optional(),
  exitSignal: z.string().nullable().optional(),
  completedAt: z.string().datetime().optional(),
  staleReason: z.string().optional(),
});

export type PersistedSessionRecord = z.infer<typeof PersistedSessionRecordSchema>;

export interface CorruptSessionRecord {
  file: string;
  error: string;
}

export interface SessionStoreOptions {
  stateDirectory?: string;
}

function resolveStateDirectory(options: SessionStoreOptions = {}): string {
  const configured = options.stateDirectory ?? process.env.DESKTOP_COMMANDER_STATE_DIR;
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.desktop-commander');
}

export function sessionsDirectory(options: SessionStoreOptions = {}): string {
  return path.join(resolveStateDirectory(options), 'sessions');
}

function recordPath(sessionId: string, options: SessionStoreOptions): string {
  return path.join(sessionsDirectory(options), `${sessionId}.json`);
}

export function newSessionId(): string {
  return crypto.randomUUID();
}

export function sessionSchemaVersion(): number {
  return SESSION_SCHEMA_VERSION;
}

/**
 * Writes a session record atomically: write to a unique temp file, then
 * rename() over the real path. rename() within the same directory is
 * atomic on every platform Node supports, so a reader can never observe a
 * partially written record — it sees either the previous complete write or
 * the new one, never a half-written file. Crash mid-write leaves only an
 * orphaned temp file (never mistaken for a real record — see readAll,
 * which only reads *.json) plus, at worst, the previous (still valid)
 * version of the record.
 */
export async function writeSessionRecord(
  record: PersistedSessionRecord,
  options: SessionStoreOptions = {},
): Promise<void> {
  const dir = sessionsDirectory(options);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const target = recordPath(record.sessionId, options);
  const temporaryPath = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const payload = `${JSON.stringify(record, null, 2)}\n`;
  try {
    await fs.writeFile(temporaryPath, payload, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporaryPath, target);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Reads and validates a single session record by id. Returns undefined for
 * a missing file OR a corrupt/invalid one (quarantining the latter, same
 * as readAllSessionRecords) — callers must treat "not found" and
 * "corrupt" identically: never as a live/valid record.
 */
export async function readSessionRecord(
  sessionId: string,
  options: SessionStoreOptions = {},
): Promise<PersistedSessionRecord | undefined> {
  const filePath = recordPath(sessionId, options);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return PersistedSessionRecordSchema.parse(JSON.parse(raw));
  } catch (error: any) {
    if (error?.code === 'ENOENT') return undefined;
    await quarantineCorruptRecord(filePath);
    return undefined;
  }
}

export async function deleteSessionRecord(sessionId: string, options: SessionStoreOptions = {}): Promise<void> {
  await fs.unlink(recordPath(sessionId, options)).catch((error: any) => {
    if (error?.code !== 'ENOENT') throw error;
  });
}

/**
 * Reads every persisted session record. A record that fails to parse or
 * fails schema validation — truncated/corrupted write, a future/foreign
 * schema version, hand-edited garbage — is never treated as a live or
 * even stale session: it is quarantined (renamed with a .corrupt suffix,
 * out of the *.json glob this function reads) and reported separately so
 * the caller can log/audit it, rather than either crashing startup or
 * silently resurrecting something we can't actually interpret.
 */
export async function readAllSessionRecords(options: SessionStoreOptions = {}): Promise<{
  valid: PersistedSessionRecord[];
  corrupt: CorruptSessionRecord[];
}> {
  const dir = sessionsDirectory(options);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { valid: [], corrupt: [] };
    throw error;
  }

  const valid: PersistedSessionRecord[] = [];
  const corrupt: CorruptSessionRecord[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue; // skip .tmp / .corrupt / anything else
    const filePath = path.join(dir, entry);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = PersistedSessionRecordSchema.parse(JSON.parse(raw));
      valid.push(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      corrupt.push({ file: entry, error: message });
      await quarantineCorruptRecord(filePath);
    }
  }

  return { valid, corrupt };
}

async function quarantineCorruptRecord(filePath: string): Promise<void> {
  try {
    await fs.rename(filePath, `${filePath}.corrupt`);
  } catch {
    // Best-effort — if even the rename fails (e.g. permissions), the file
    // is still excluded from readAllSessionRecords by its .json suffix
    // check failing on next read only if renamed; if the rename itself
    // failed, fall back to deleting it so it can never be misread as valid.
    await fs.unlink(filePath).catch(() => undefined);
  }
}

/**
 * Bounded retention: deterministically decides which terminal-state
 * records (completed/terminated/stale) to delete so persisted session
 * history cannot grow without bound. Pure function of the input records
 * and "now" — no I/O — so retention policy is directly unit-testable
 * independent of the filesystem.
 *
 * Policy: delete a terminal record once it is older than maxAgeMs; beyond
 * that, if more than maxCount terminal records remain, delete the oldest
 * (by updatedAt) until at most maxCount remain. 'running' records are
 * never pruned by age/count — only reconciliation moving them to a
 * terminal status makes them eligible.
 */
export interface RetentionPolicy {
  maxAgeMs: number;
  maxCount: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  maxAgeMs: 24 * 60 * 60 * 1000, // 24 hours
  maxCount: 500,
};

export function selectRecordsToPrune(
  records: readonly PersistedSessionRecord[],
  now: Date,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): PersistedSessionRecord[] {
  const terminal = records.filter((r) => r.status !== 'running');
  const nowMs = now.getTime();

  const byAge = terminal.filter((r) => nowMs - Date.parse(r.updatedAt) > policy.maxAgeMs);
  const byAgeIds = new Set(byAge.map((r) => r.sessionId));

  const survivingAge = terminal.filter((r) => !byAgeIds.has(r.sessionId));
  const sortedOldestFirst = [...survivingAge].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  const overCountCount = Math.max(0, sortedOldestFirst.length - policy.maxCount);
  const byCount = sortedOldestFirst.slice(0, overCountCount);

  return [...byAge, ...byCount];
}

export async function pruneSessionRecords(
  records: readonly PersistedSessionRecord[],
  now: Date,
  options: SessionStoreOptions = {},
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): Promise<number> {
  const toPrune = selectRecordsToPrune(records, now, policy);
  for (const record of toPrune) {
    await deleteSessionRecord(record.sessionId, options);
  }
  return toPrune.length;
}
