import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { applyControlPlaneMigrations, ControlStackError } from "@agent-control-stack/shared";

const GENESIS_PREV_HASH = "0".repeat(64);
/** One hash chain per ACS database. Process id is recorded on the event, not used as the chain key. */
export const TRACE_CHAIN_PRODUCER_KEY = "acs";
const UTC_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const RELEASE_RE = /^(?:[a-f0-9]{40}|unreleased)$/;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

interface Sql {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
}

export interface ApprovalTraceInput {
  instance: string;
  releaseSha: string;
  workItemId: string;
  actionHash: string;
  requestHash: string;
  actorId: string;
  actorType: "human" | "agent" | "system";
  kind: "acs.approval.granted" | "acs.approval.consumed";
  reason: string;
  status: "granted" | "consumed";
}

function fail(code: string, message: string): never {
  throw new ControlStackError(code, message);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("trace_event_invalid", "trace payload is not JSON");
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => normalize(entry));
  if (!value || typeof value !== "object") fail("trace_event_invalid", "trace payload is not JSON");
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry === undefined) fail("trace_event_invalid", "trace payload is not JSON");
    sorted[key] = normalize(entry);
  }
  return sorted;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function redactText(value: string): string {
  const redacted = value
    .replace(/(^|\s)Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1Bearer [REDACTED]")
    .replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_]{8,}\b/g, "[REDACTED]");
  if (/(^|\s)Bearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(redacted)) return "[REDACTED]";
  return redacted.slice(0, 256);
}

function createUlid(ms = Date.now(), random: Buffer = randomBytes(10)): string {
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(ms, 0, 6);
  random.copy(bytes, 6);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = "";
  for (let index = 0; index < 26; index += 1) {
    out = CROCKFORD[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

export function utcSpoolDay(ts: string): string {
  if (!UTC_TS.test(ts)) fail("trace_spool_timestamp_invalid", "spool filename requires a UTC timestamp");
  return ts.slice(0, 10);
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface TraceProducerConfig {
  instance: string;
  releaseSha: string;
}

/**
 * Validates the trace producer identity (`ACS_TRACE_INSTANCE` / `ACS_RELEASE_SHA`).
 * Operators control these values, so a bad value is a deployment error that must fail
 * at boot — never at approval time, where it would deny an otherwise-valid approval
 * (ADR 0021: a failed trace does not grant, deny, or approve anything).
 */
export function validateTraceProducerConfig(config: TraceProducerConfig): TraceProducerConfig {
  if (typeof config.instance !== "string" || !ID_RE.test(config.instance)) {
    fail(
      "trace_config_invalid",
      "ACS_TRACE_INSTANCE must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$ (no spaces or slashes)"
    );
  }
  if (typeof config.releaseSha !== "string" || !RELEASE_RE.test(config.releaseSha)) {
    fail("trace_config_invalid", "ACS_RELEASE_SHA must be a full 40-character lowercase hex sha or 'unreleased'");
  }
  return { instance: config.instance, releaseSha: config.releaseSha };
}

/**
 * Resolves the producer identity from explicit options, then the environment, then
 * defaults, and validates it. Throws `trace_config_invalid` on a bad value.
 */
export function resolveTraceProducerConfig(
  options: { traceInstance?: string; releaseSha?: string } = {},
  env: NodeJS.ProcessEnv = process.env
): TraceProducerConfig {
  return validateTraceProducerConfig({
    instance: options.traceInstance ?? env.ACS_TRACE_INSTANCE ?? `acs-${process.pid}`,
    releaseSha: options.releaseSha ?? env.ACS_RELEASE_SHA ?? "unreleased"
  });
}

/**
 * Trace identities must match the trace-event id grammar. Actor ids come from real
 * identity providers (`jace@example.com`, `auth0|123`), so an id outside the grammar is
 * replaced with a deterministic, non-reversible `h:` + 32-hex sha256 prefix instead of
 * failing the approval. The canonical audit log keeps the raw approver.
 */
export function normalizeTraceActorId(id: string): string {
  if (ID_RE.test(id)) return id;
  return `h:${sha256(String(id)).slice(0, 32)}`;
}

export function enqueueApprovalTraceEvent(db: Sql, rawInput: ApprovalTraceInput): void {
  const producer = validateTraceProducerConfig({ instance: rawInput.instance, releaseSha: rawInput.releaseSha });
  const input: ApprovalTraceInput = {
    ...rawInput,
    instance: producer.instance,
    releaseSha: producer.releaseSha,
    actorId: normalizeTraceActorId(rawInput.actorId)
  };
  if (!ID_RE.test(input.workItemId)) fail("trace_producer_invalid", "trace work item id is invalid");
  const ts = new Date().toISOString();
  db.prepare(`INSERT OR IGNORE INTO trace_missions (work_item_id, trace_id, created_at) VALUES (?, ?, ?)`).run(
    input.workItemId,
    randomBytes(16).toString("hex"),
    ts
  );
  const mission = db.prepare(`SELECT trace_id FROM trace_missions WHERE work_item_id = ?`).get(input.workItemId) as
    { trace_id: string } | undefined;
  if (!mission) fail("trace_mission_missing", "trace mission was not recorded");
  const traceId = mission.trace_id;
  db.prepare(`INSERT OR IGNORE INTO trace_chain_state (producer_key, seq, head_hash) VALUES (?, 0, ?)`).run(
    TRACE_CHAIN_PRODUCER_KEY,
    GENESIS_PREV_HASH
  );
  const head = db
    .prepare(`SELECT seq, head_hash FROM trace_chain_state WHERE producer_key = ?`)
    .get(TRACE_CHAIN_PRODUCER_KEY) as { seq: number; head_hash: string } | undefined;
  if (!head) fail("trace_chain_missing", "trace chain was not recorded");
  const seq = head.seq + 1;
  const payload = {
    action_hash: input.actionHash,
    request_hash: input.requestHash,
    status: input.status,
    reason: redactText(input.reason)
  };
  const event = {
    schema_version: "trace-event/1",
    event_id: createUlid(),
    trace_id: traceId,
    span_id: randomBytes(8).toString("hex"),
    source: {
      system: "acs",
      component: "approvals",
      instance: input.instance,
      release_sha: input.releaseSha
    },
    class: "authority",
    kind: input.kind,
    actor: { id: input.actorId, type: input.actorType },
    subject: { work_item_id: input.workItemId },
    seq,
    prev_hash: head.head_hash,
    ts,
    payload,
    payload_hash: sha256(canonicalJson(payload))
  };
  const canonical = canonicalJson(event);
  db.prepare(
    `INSERT INTO trace_outbox (event_id, work_item_id, seq, canonical_json, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(event.event_id, input.workItemId, seq, canonical, ts);
  const advanced = db
    .prepare(`UPDATE trace_chain_state SET seq = ?, head_hash = ? WHERE producer_key = ? AND seq = ?`)
    .run(seq, sha256(canonical), TRACE_CHAIN_PRODUCER_KEY, head.seq) as { changes?: number };
  if (advanced.changes !== 1) fail("trace_chain_conflict", "trace chain changed while appending an approval event");
}

export interface RelayOptions {
  /** When false, spool bytes are fsynced and rows stay unshipped. Tests use this to simulate a crash. */
  markShipped?: boolean;
}

export function relayTraceOutbox(dbPath: string, spoolDir: string, options: RelayOptions = {}): { shipped: number } {
  const markShipped = options.markShipped !== false;
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  try {
    applyControlPlaneMigrations(db);
    const rows = db
      .prepare(`SELECT event_id, canonical_json FROM trace_outbox WHERE shipped_at IS NULL ORDER BY seq ASC`)
      .all() as Array<{ event_id: string; canonical_json: string }>;
    let shipped = 0;
    for (const row of rows) {
      const event = JSON.parse(row.canonical_json) as { ts: string; source: { system: string } };
      const day = utcSpoolDay(event.ts);
      const dir = join(spoolDir, event.source.system);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${day}.ndjson`);
      const fd = openSync(file, "a", 0o600);
      try {
        writeSync(fd, `${row.canonical_json}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      // The new directory entry is durable before the row is marked shipped.
      fsyncDirectory(dir);
      fsyncDirectory(spoolDir);
      if (!markShipped) continue;
      const shippedAt = new Date().toISOString();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`UPDATE trace_outbox SET shipped_at = ? WHERE event_id = ? AND shipped_at IS NULL`).run(
          shippedAt,
          row.event_id
        );
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // The transaction may already be closed.
        }
        throw error;
      }
      shipped += 1;
    }
    return { shipped };
  } finally {
    db.close();
  }
}

export function spoolFileFor(spoolDir: string, day: string): string {
  return join(spoolDir, "acs", `${day}.ndjson`);
}
