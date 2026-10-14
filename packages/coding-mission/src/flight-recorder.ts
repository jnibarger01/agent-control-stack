import type { DatabaseSync } from "node:sqlite";
import { ControlStackError, domainHash, redactValue, stableHash } from "@agent-control-stack/shared";

/**
 * Execution Flight Recorder.
 *
 * A per-mission, append-only, hash-chained record. It is tamper EVIDENCE: it lets a reader prove that the records it
 * is shown are the ones that were written, in order, with nothing removed from the middle. It does not prevent a
 * principal who can write the database file from rewriting the whole chain; only an externally held head hash can
 * detect that (see docs/flight-recorder.md). Records contain redacted bodies only.
 */
export const FLIGHT_RECORD_SCHEMA_VERSION = "acs.flight-record.v1" as const;
const HASH_DOMAIN = "acs.flight-record.v1";

export interface FlightRecord {
  missionId: string;
  seq: number;
  eventId: number | null;
  kind: string;
  bodyJson: string;
  createdAt: string;
  previousHash: string;
  recordHash: string;
}

export type FlightFindingKind =
  | "record_hash_mismatch"
  | "previous_hash_mismatch"
  | "sequence_gap"
  | "event_missing"
  | "event_modified"
  | "unrecorded_event"
  | "evidence_missing"
  | "evidence_modified"
  | "unrecorded_evidence"
  | "unlinked_record"
  | "legacy_binding";

export interface FlightFinding {
  kind: FlightFindingKind;
  seq?: number;
  eventId?: number;
  evidenceId?: string;
  detail: string;
}

/**
 * verified: every check passed.
 * partial_legacy: chain intact, but earlier events predate the recorder and cannot be proven.
 * tampered: at least one finding. A tampered verdict says the record cannot be trusted, not who changed it.
 */
export type FlightVerdict = "verified" | "partial_legacy" | "tampered";

export interface FlightVerification {
  verdict: FlightVerdict;
  recordCount: number;
  headHash: string;
  /** Operational events that predate the recorder and so were never chained. */
  legacyEventCount: number;
  /** Evidence rows that predate the recorder and so were never chained. */
  legacyEvidenceCount: number;
  findings: FlightFinding[];
}

interface RecordRow {
  mission_id: string;
  seq: number;
  event_id: number | null;
  kind: string;
  body_json: string;
  created_at: string;
  previous_hash: string;
  record_hash: string;
}

export function flightRecordHash(input: Omit<FlightRecord, "recordHash">): string {
  return domainHash(HASH_DOMAIN, {
    missionId: input.missionId,
    seq: input.seq,
    eventId: input.eventId,
    kind: input.kind,
    bodyJson: input.bodyJson,
    createdAt: input.createdAt,
    previousHash: input.previousHash
  });
}

/** A label safe to show: secret-shaped values in an identifier are masked. Never used as a lookup key. */
function safeLabel(value: string): string {
  return String(redactValue(value));
}

/**
 * The chained body for one evidence row. Evidence ids and kinds can embed caller-supplied identifiers, so the chain
 * stores a hash of each for integrity (`evidenceRef`, `metaHash`) and only a redacted label for display.
 */
export function evidenceBindingBody(evidenceId: string, kind: string, payloadHash: string): string {
  return JSON.stringify({
    evidenceRef: stableHash(evidenceId),
    metaHash: stableHash({ evidenceId, kind }),
    payloadHash,
    evidenceId: safeLabel(evidenceId),
    kind: safeLabel(kind)
  });
}

/** Removes secrets by key (existing behavior) and by value pattern before anything is persisted or hashed. */
export function redactFlightBody(body: unknown): string {
  return JSON.stringify(redactValue(dropSensitiveKeys(body)) ?? null);
}

function dropSensitiveKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => dropSensitiveKeys(entry));
  if (value && typeof value === "object") {
    const clean: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (/token|secret|authorization|password|cookie|credential/i.test(key)) continue;
      clean[key] = dropSensitiveKeys(child);
    }
    return clean;
  }
  return value;
}

function toRecord(row: RecordRow): FlightRecord {
  return {
    missionId: row.mission_id,
    seq: row.seq,
    eventId: row.event_id,
    kind: row.kind,
    bodyJson: row.body_json,
    createdAt: row.created_at,
    previousHash: row.previous_hash,
    recordHash: row.record_hash
  };
}

/**
 * Appends one record. The caller must hold a write transaction so that reading the head and inserting the successor
 * are atomic; SQLite's single writer then serialises concurrent appends and `seq` cannot fork.
 */
export function appendFlightRecord(
  db: DatabaseSync,
  input: { missionId: string; eventId: number | null; kind: string; bodyJson: string; createdAt: string }
): FlightRecord {
  if (!db.isTransaction) {
    throw new ControlStackError(
      "flight_recorder_no_transaction",
      "flight records must be appended inside a transaction"
    );
  }
  const head = db
    .prepare(`SELECT seq, record_hash FROM mission_flight_records WHERE mission_id = ? ORDER BY seq DESC LIMIT 1`)
    .get(input.missionId) as { seq: number; record_hash: string } | undefined;
  const unhashed = {
    missionId: input.missionId,
    seq: (head?.seq ?? 0) + 1,
    eventId: input.eventId,
    kind: input.kind,
    bodyJson: input.bodyJson,
    createdAt: input.createdAt,
    previousHash: head?.record_hash ?? ""
  };
  const record: FlightRecord = { ...unhashed, recordHash: flightRecordHash(unhashed) };
  db.prepare(
    `INSERT INTO mission_flight_records
       (mission_id, seq, event_id, kind, body_json, created_at, previous_hash, record_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.missionId,
    record.seq,
    record.eventId,
    record.kind,
    record.bodyJson,
    record.createdAt,
    record.previousHash,
    record.recordHash
  );
  return record;
}

/** Writes an operational coding_events row and its chained record as one unit. */
export function appendMissionEvent(
  db: DatabaseSync,
  missionId: string,
  name: string,
  body: unknown,
  now: string
): FlightRecord {
  const bodyJson = redactFlightBody(body);
  const inserted = db
    .prepare(`INSERT INTO coding_events (mission_id, name, body_json, created_at) VALUES (?, ?, ?, ?)`)
    .run(missionId, name, bodyJson, now);
  return appendFlightRecord(db, {
    missionId,
    eventId: Number(inserted.lastInsertRowid),
    kind: name,
    bodyJson,
    createdAt: now
  });
}

export function readFlightRecords(
  db: DatabaseSync,
  missionId: string,
  window: { afterSeq?: number; limit?: number } = {}
): FlightRecord[] {
  const afterSeq = window.afterSeq ?? 0;
  const limit = Math.min(Math.max(window.limit ?? 500, 1), 5000);
  return (
    db
      .prepare(`SELECT * FROM mission_flight_records WHERE mission_id = ? AND seq > ? ORDER BY seq LIMIT ?`)
      .all(missionId, afterSeq, limit) as unknown as RecordRow[]
  ).map(toRecord);
}

/**
 * Runs `work` against one consistent database snapshot. Verification and replay each issue several queries; without a
 * shared read transaction a concurrent writer committing between them makes a legitimate event look unrecorded, or
 * lets the returned records include ones the verdict never checked. If the caller already holds a transaction, that
 * transaction is the snapshot.
 */
function withReadSnapshot<T>(db: DatabaseSync, work: () => T): T {
  if (db.isTransaction) return work();
  db.exec("BEGIN");
  try {
    return work();
  } finally {
    db.exec("ROLLBACK");
  }
}

/** Visits every record of a mission in order, in bounded batches, so no mission size makes records unreachable. */
function forEachRecord(db: DatabaseSync, missionId: string, visit: (record: FlightRecord) => void): void {
  let cursor = 0;
  for (;;) {
    const batch = readFlightRecords(db, missionId, { afterSeq: cursor, limit: 5000 });
    for (const record of batch) visit(record);
    if (batch.length < 5000) return;
    cursor = batch[batch.length - 1]!.seq;
  }
}

/**
 * Recomputes the whole chain for a mission and cross-checks it against the operational tables. Reads only.
 * Never throws on tampering; tampering is a finding.
 */
export function verifyFlightRecord(db: DatabaseSync, missionId: string): FlightVerification {
  return withReadSnapshot(db, () => verifyUnderSnapshot(db, missionId));
}

function verifyUnderSnapshot(db: DatabaseSync, missionId: string): FlightVerification {
  const findings: FlightFinding[] = [];
  const rows = db
    .prepare(`SELECT * FROM mission_flight_records WHERE mission_id = ? ORDER BY seq`)
    .all(missionId) as unknown as RecordRow[];

  let previousHash = "";
  let expectedSeq = 1;
  for (const row of rows) {
    const record = toRecord(row);
    if (record.seq !== expectedSeq) {
      findings.push({
        kind: "sequence_gap",
        seq: record.seq,
        detail: `expected sequence ${expectedSeq}, found ${record.seq}`
      });
      expectedSeq = record.seq;
    }
    if (record.previousHash !== previousHash) {
      findings.push({
        kind: "previous_hash_mismatch",
        seq: record.seq,
        detail: "record does not link to its predecessor"
      });
    }
    const { recordHash, ...unhashed } = record;
    if (flightRecordHash(unhashed) !== recordHash) {
      findings.push({
        kind: "record_hash_mismatch",
        seq: record.seq,
        detail: "record content does not match its hash"
      });
    }
    previousHash = record.recordHash;
    expectedSeq += 1;
  }

  const legacyEvents = new Set(
    (
      db
        .prepare(
          `SELECT e.event_id FROM coding_events AS e
           JOIN mission_flight_legacy_events AS l ON l.event_id = e.event_id WHERE e.mission_id = ?`
        )
        .all(missionId) as Array<{ event_id: number }>
    ).map((row) => row.event_id)
  );
  const legacyEvidence = new Set(
    (
      db
        .prepare(`SELECT evidence_id FROM mission_flight_legacy_evidence WHERE mission_id = ?`)
        .all(missionId) as Array<{ evidence_id: string }>
    ).map((row) => row.evidence_id)
  );

  const events = db
    .prepare(`SELECT event_id, name, body_json, created_at FROM coding_events WHERE mission_id = ? ORDER BY event_id`)
    .all(missionId) as Array<{ event_id: number; name: string; body_json: string; created_at: string }>;
  const eventsById = new Map(events.map((event) => [event.event_id, event]));
  const chainedEventIds = new Set<number>();
  for (const row of rows) {
    if (row.event_id === null) {
      // Only evidence bindings are written without an operational event row. Anything else unlinked is an insert that
      // bypassed the recorder, however well it hashes.
      if (row.kind !== "evidence.recorded") {
        findings.push({
          kind: "unlinked_record",
          seq: row.seq,
          detail: "record has no operational event row and is not an evidence binding"
        });
      }
      continue;
    }
    if (legacyEvents.has(row.event_id)) {
      // Records are only written after the epoch, so a record bound to an older event was inserted afterwards to make
      // unprovable history look recorded. The event stays counted as legacy.
      findings.push({
        kind: "legacy_binding",
        seq: row.seq,
        eventId: row.event_id,
        detail: "record is bound to an event that predates the recorder"
      });
      continue;
    }
    chainedEventIds.add(row.event_id);
    const event = eventsById.get(row.event_id);
    if (!event) {
      findings.push({
        kind: "event_missing",
        seq: row.seq,
        eventId: row.event_id,
        detail: "chained record has no operational event row"
      });
    } else if (event.name !== row.kind || event.body_json !== row.body_json || event.created_at !== row.created_at) {
      findings.push({
        kind: "event_modified",
        seq: row.seq,
        eventId: row.event_id,
        detail: "operational event row differs from its chained record"
      });
    }
  }
  let legacyEventCount = 0;
  for (const event of events) {
    if (chainedEventIds.has(event.event_id)) continue;
    if (legacyEvents.has(event.event_id)) legacyEventCount += 1;
    else {
      findings.push({
        kind: "unrecorded_event",
        eventId: event.event_id,
        detail: "event was written after the recorder epoch without a chained record"
      });
    }
  }

  const legacyEvidenceCount = verifyEvidence(db, missionId, rows, legacyEvidence, findings);

  const verdict: FlightVerdict =
    findings.length > 0 ? "tampered" : legacyEventCount + legacyEvidenceCount > 0 ? "partial_legacy" : "verified";
  return {
    verdict,
    recordCount: rows.length,
    headHash: previousHash,
    legacyEventCount,
    legacyEvidenceCount,
    findings
  };
}

function verifyEvidence(
  db: DatabaseSync,
  missionId: string,
  rows: RecordRow[],
  legacyEvidence: ReadonlySet<string>,
  findings: FlightFinding[]
): number {
  const recorded = new Map<
    string,
    { payloadHash: string; metaHash: string; createdAt: string; label: string; seq: number }
  >();
  for (const row of rows) {
    if (row.kind !== "evidence.recorded") continue;
    const body = safeParse(row.body_json);
    const valid =
      typeof body.evidenceRef === "string" &&
      typeof body.metaHash === "string" &&
      typeof body.payloadHash === "string" &&
      typeof body.evidenceId === "string";
    if (!valid) {
      findings.push({ kind: "unlinked_record", seq: row.seq, detail: "malformed evidence binding" });
      continue;
    }
    const ref = body.evidenceRef as string;
    if (recorded.has(ref)) {
      findings.push({
        kind: "unlinked_record",
        seq: row.seq,
        evidenceId: body.evidenceId as string,
        detail: "evidence is bound by more than one chained record"
      });
      continue;
    }
    recorded.set(ref, {
      payloadHash: body.payloadHash as string,
      metaHash: body.metaHash as string,
      createdAt: row.created_at,
      label: body.evidenceId as string,
      seq: row.seq
    });
  }
  const evidence = db
    .prepare(
      `SELECT evidence_id, kind, created_at, payload_hash, payload_json
       FROM coding_evidence WHERE mission_id = ?`
    )
    .all(missionId) as Array<{
    evidence_id: string;
    kind: string;
    created_at: string;
    payload_hash: string;
    payload_json: string;
  }>;
  const seen = new Set<string>();
  let legacy = 0;
  for (const row of evidence) {
    const ref = stableHash(row.evidence_id);
    seen.add(ref);
    const label = safeLabel(row.evidence_id);
    const chained = recorded.get(ref);
    if (legacyEvidence.has(row.evidence_id)) {
      legacy += 1;
      if (chained) {
        findings.push({
          kind: "legacy_binding",
          seq: chained.seq,
          evidenceId: label,
          detail: "record is bound to evidence that predates the recorder"
        });
      }
      continue;
    }
    if (!chained) {
      findings.push({ kind: "unrecorded_evidence", evidenceId: label, detail: "evidence row has no chained record" });
      continue;
    }
    let recomputed: string | undefined;
    try {
      recomputed = stableHash(JSON.parse(row.payload_json));
    } catch {
      recomputed = undefined;
    }
    if (
      row.payload_hash !== chained.payloadHash ||
      recomputed !== chained.payloadHash ||
      stableHash({ evidenceId: row.evidence_id, kind: row.kind }) !== chained.metaHash ||
      row.created_at !== chained.createdAt
    ) {
      findings.push({
        kind: "evidence_modified",
        seq: chained.seq,
        evidenceId: label,
        detail: "evidence payload, kind or timestamp no longer matches what was chained when it was stored"
      });
    }
  }
  for (const [ref, chained] of recorded) {
    if (!seen.has(ref)) {
      findings.push({
        kind: "evidence_missing",
        seq: chained.seq,
        evidenceId: chained.label,
        detail: "chained evidence record has no evidence row"
      });
    }
  }
  return legacy;
}

export const FLIGHT_TRUST_ASSUMPTIONS = [
  "Tamper evidence, not tamper prevention: anyone who can write the database file can rewrite the whole chain consistently.",
  "A consistent full rewrite is detectable only by comparing headHash with a value recorded outside the database writer's reach.",
  "The append-only triggers stop application-level UPDATE and DELETE; they can be dropped by a database owner.",
  "Records show what ACS recorded. They do not prove an external side effect (a push, a merge, a deployment) happened.",
  "Events written before migration 062 are not chained and are reported as legacy."
] as const;

export interface FlightReplayRecord {
  seq: number;
  eventId: number | null;
  kind: string;
  createdAt: string;
  recordHash: string;
  previousHash: string;
  body: unknown;
}

export interface MissionFlightRecord {
  schemaVersion: typeof FLIGHT_RECORD_SCHEMA_VERSION;
  missionId: string;
  verification: FlightVerification;
  /** False whenever verification found a problem; replay is then a lead for investigation, not evidence. */
  trustworthy: boolean;
  reconstruction: {
    stateHistory: Array<{ seq: number; from: string | null; to: string; at: string }>;
    derivedState: string | null;
    liveState: string | null;
    /** null when either side is unknown. */
    consistentWithLive: boolean | null;
    units: Record<
      string,
      | "created"
      | "ready"
      | "claimed"
      | "verifying"
      | "completed"
      | "failed"
      | "retryable"
      | "retry_scheduled"
      | "cancelled"
      | "pending"
      | "conflict"
      | "unknown"
    >;
  };
  records: FlightReplayRecord[];
  nextAfterSeq?: number;
  trustAssumptions: readonly string[];
}

/**
 * Mission-level replay and inspection. Verification always covers the whole chain; only the returned `records`
 * window is paged. Reconstruction is derived from the chain alone and then compared with the live mission row.
 */
export function readMissionFlightRecord(
  db: DatabaseSync,
  missionId: string,
  window: { afterSeq?: number; limit?: number } = {}
): MissionFlightRecord {
  return withReadSnapshot(db, () => readUnderSnapshot(db, missionId, window));
}

function readUnderSnapshot(
  db: DatabaseSync,
  missionId: string,
  window: { afterSeq?: number; limit?: number }
): MissionFlightRecord {
  const verification = verifyUnderSnapshot(db, missionId);
  const stateHistory: MissionFlightRecord["reconstruction"]["stateHistory"] = [];
  const units: MissionFlightRecord["reconstruction"]["units"] = {};
  const unitEvents: Record<string, MissionFlightRecord["reconstruction"]["units"][string]> = {
    "work_unit.created": "created",
    "work_unit.ready": "ready",
    "work_unit.claimed": "claimed",
    "verification.started": "verifying",
    "work_unit.completed": "completed",
    "work_unit.cancelled": "cancelled",
    "work_unit.retry_scheduled": "retry_scheduled",
    "work_unit.claim_released": "pending",
    "work_unit.recovered": "pending",
    "work_unit.poisoned": "failed",
    "work_unit.unknown": "unknown"
  };
  forEachRecord(db, missionId, (record) => {
    const body = safeParse(record.bodyJson);
    if (record.kind === "coding_mission.plan_replaced") {
      // A replan deletes and re-creates the operations, so units recorded before it no longer exist.
      for (const key of Object.keys(units)) delete units[key];
    }
    if (record.kind === "mission.created" || record.kind === "coding_mission.created") {
      if (typeof body.state === "string") {
        stateHistory.push({ seq: record.seq, from: null, to: body.state, at: record.createdAt });
      }
    } else if (typeof body.to === "string" && (typeof body.from === "string" || body.from === null)) {
      stateHistory.push({ seq: record.seq, from: body.from as string | null, to: body.to, at: record.createdAt });
    }
    if (typeof body.unitId !== "string") return;
    if (record.kind === "work_unit.failed") units[body.unitId] = body.next === "retryable" ? "retryable" : "failed";
    else if (record.kind === "work_unit.marked") {
      if (body.status === "conflict" || body.status === "unknown" || body.status === "failed") {
        units[body.unitId] = body.status;
      }
    } else {
      const unitStatus = unitEvents[record.kind];
      if (unitStatus) units[body.unitId] = unitStatus;
    }
  });
  const derivedState = stateHistory.at(-1)?.to ?? null;
  const live = db.prepare(`SELECT state FROM coding_missions WHERE mission_id = ?`).get(missionId) as
    { state: string } | undefined;
  const liveState = live?.state ?? null;

  const afterSeq = window.afterSeq ?? 0;
  const limit = Math.min(Math.max(window.limit ?? 200, 1), 1000);
  const page = readFlightRecords(db, missionId, { afterSeq, limit: limit + 1 });
  const shown = page.slice(0, limit);
  return {
    schemaVersion: FLIGHT_RECORD_SCHEMA_VERSION,
    missionId,
    verification,
    trustworthy: verification.verdict !== "tampered",
    reconstruction: {
      stateHistory,
      derivedState,
      liveState,
      consistentWithLive: derivedState === null || liveState === null ? null : derivedState === liveState,
      units
    },
    records: shown.map((record) => ({
      seq: record.seq,
      eventId: record.eventId,
      kind: record.kind,
      createdAt: record.createdAt,
      recordHash: record.recordHash,
      previousHash: record.previousHash,
      body: parseBody(record.bodyJson)
    })),
    ...(page.length > limit ? { nextAfterSeq: shown.at(-1)!.seq } : {}),
    trustAssumptions: FLIGHT_TRUST_ASSUMPTIONS
  };
}

/** The body exactly as persisted and verified (any JSON value), for display. */
function parseBody(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

/** Object bodies only, for deriving state and unit fields. Other JSON values carry no such fields. */
function safeParse(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
