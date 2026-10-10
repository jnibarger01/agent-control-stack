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
  | "unrecorded_evidence";

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
  legacyEventCount: number;
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
 * Recomputes the whole chain for a mission and cross-checks it against the operational tables. Reads only.
 * Never throws on tampering; tampering is a finding.
 */
export function verifyFlightRecord(db: DatabaseSync, missionId: string): FlightVerification {
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

  const epochRow = db
    .prepare(`SELECT last_legacy_event_id, last_legacy_evidence_rowid FROM mission_flight_epoch WHERE singleton = 1`)
    .get() as { last_legacy_event_id: number; last_legacy_evidence_rowid: number } | undefined;
  if (!epochRow) {
    findings.push({ kind: "unrecorded_event", detail: "recorder epoch row is missing" });
  }
  const legacyCutoff = epochRow?.last_legacy_event_id ?? 0;
  const legacyEvidenceCutoff = epochRow?.last_legacy_evidence_rowid ?? 0;

  const events = db
    .prepare(`SELECT event_id, name, body_json, created_at FROM coding_events WHERE mission_id = ? ORDER BY event_id`)
    .all(missionId) as Array<{ event_id: number; name: string; body_json: string; created_at: string }>;
  const eventsById = new Map(events.map((event) => [event.event_id, event]));
  const chainedEventIds = new Set<number>();
  for (const row of rows) {
    if (row.event_id === null) continue;
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
    if (event.event_id <= legacyCutoff) legacyEventCount += 1;
    else {
      findings.push({
        kind: "unrecorded_event",
        eventId: event.event_id,
        detail: "event was written after the recorder epoch without a chained record"
      });
    }
  }

  legacyEventCount += verifyEvidence(db, missionId, rows, legacyEvidenceCutoff, findings);

  const verdict: FlightVerdict =
    findings.length > 0 ? "tampered" : legacyEventCount > 0 ? "partial_legacy" : "verified";
  return { verdict, recordCount: rows.length, headHash: previousHash, legacyEventCount, findings };
}

function verifyEvidence(
  db: DatabaseSync,
  missionId: string,
  rows: RecordRow[],
  legacyCutoff: number,
  findings: FlightFinding[]
): number {
  const recorded = new Map<string, { payloadHash: string; seq: number }>();
  for (const row of rows) {
    if (row.kind !== "evidence.recorded") continue;
    try {
      const body = JSON.parse(row.body_json) as { evidenceId?: unknown; payloadHash?: unknown };
      if (typeof body.evidenceId === "string" && typeof body.payloadHash === "string") {
        recorded.set(body.evidenceId, { payloadHash: body.payloadHash, seq: row.seq });
      }
    } catch {
      // A body that is not valid JSON already fails the record hash or the SQL json_valid check.
    }
  }
  const evidence = db
    .prepare(
      `SELECT rowid AS row_id, evidence_id, payload_hash, payload_json FROM coding_evidence WHERE mission_id = ?`
    )
    .all(missionId) as Array<{ row_id: number; evidence_id: string; payload_hash: string; payload_json: string }>;
  const seen = new Set<string>();
  let legacy = 0;
  for (const row of evidence) {
    seen.add(row.evidence_id);
    const chained = recorded.get(row.evidence_id);
    if (!chained) {
      if (row.row_id <= legacyCutoff) legacy += 1;
      else {
        findings.push({
          kind: "unrecorded_evidence",
          evidenceId: row.evidence_id,
          detail: "evidence row has no chained record"
        });
      }
      continue;
    }
    let recomputed: string | undefined;
    try {
      recomputed = stableHash(JSON.parse(row.payload_json));
    } catch {
      recomputed = undefined;
    }
    if (row.payload_hash !== chained.payloadHash || recomputed !== chained.payloadHash) {
      findings.push({
        kind: "evidence_modified",
        seq: chained.seq,
        evidenceId: row.evidence_id,
        detail: "evidence payload no longer matches the hash that was chained when it was stored"
      });
    }
  }
  for (const [evidenceId, chained] of recorded) {
    if (!seen.has(evidenceId)) {
      findings.push({
        kind: "evidence_missing",
        seq: chained.seq,
        evidenceId,
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
    units: Record<string, "created" | "ready" | "completed" | "failed" | "retry_scheduled">;
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
  const verification = verifyFlightRecord(db, missionId);
  const all = readFlightRecords(db, missionId, { limit: 5000 });
  const stateHistory: MissionFlightRecord["reconstruction"]["stateHistory"] = [];
  const units: MissionFlightRecord["reconstruction"]["units"] = {};
  const unitEvents: Record<string, MissionFlightRecord["reconstruction"]["units"][string]> = {
    "work_unit.created": "created",
    "work_unit.ready": "ready",
    "work_unit.completed": "completed",
    "work_unit.failed": "failed",
    "work_unit.retry_scheduled": "retry_scheduled"
  };
  for (const record of all) {
    const body = safeParse(record.bodyJson);
    if (record.kind === "mission.created" || record.kind === "coding_mission.created") {
      if (typeof body.state === "string") {
        stateHistory.push({ seq: record.seq, from: null, to: body.state, at: record.createdAt });
      }
    } else if (typeof body.to === "string" && (typeof body.from === "string" || body.from === null)) {
      stateHistory.push({ seq: record.seq, from: body.from as string | null, to: body.to, at: record.createdAt });
    }
    const unitStatus = unitEvents[record.kind];
    if (unitStatus && typeof body.unitId === "string") units[body.unitId] = unitStatus;
  }
  const derivedState = stateHistory.at(-1)?.to ?? null;
  const live = db.prepare(`SELECT state FROM coding_missions WHERE mission_id = ?`).get(missionId) as
    { state: string } | undefined;
  const liveState = live?.state ?? null;

  const afterSeq = window.afterSeq ?? 0;
  const limit = Math.min(Math.max(window.limit ?? 200, 1), 1000);
  const page = all.filter((record) => record.seq > afterSeq).slice(0, limit + 1);
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
      body: safeParse(record.bodyJson)
    })),
    ...(page.length > limit ? { nextAfterSeq: shown.at(-1)!.seq } : {}),
    trustAssumptions: FLIGHT_TRUST_ASSUMPTIONS
  };
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
