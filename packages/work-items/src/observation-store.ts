import type { CanonicalTraceEvent } from "./trace-event.js";
import {
  observationalIdentity,
  type ObservationCapacity,
  type ObservationCompletion,
  type ObservationOutboxEntry
} from "./observation-outbox.js";

interface ObservationSql {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes?: number | bigint };
  };
}

interface ObservationRow {
  observation_id: string;
  work_item_id: string;
  trace_id: string;
  question_set_version: string;
  classifier_version: string;
  status: ObservationOutboxEntry["status"];
  attempts: number;
  max_attempts: number;
  created_at: string;
  available_at: string;
  started_at: string | null;
  completed_at: string | null;
  classifier_outcome: string | null;
  telemetry_correlation_id: string | null;
  error: string | null;
}

export interface ObservationStoreConfig {
  questionSetVersion: string;
  classifierVersion: string;
  maxQueued: number;
  maxAttempts: number;
}

export function enqueueObservationAfterAuthority(
  db: ObservationSql,
  config: ObservationStoreConfig,
  workItemId: string
): ObservationOutboxEntry | undefined {
  const mission = db.prepare("SELECT trace_id FROM trace_missions WHERE work_item_id = ?").get(workItemId) as
    { trace_id: string } | undefined;
  if (!mission) return undefined;
  const capacity = getObservationCapacity(db, config.maxQueued);
  if (capacity.saturated) return undefined;
  const observationId = observationalIdentity({
    traceId: mission.trace_id,
    questionSetVersion: config.questionSetVersion,
    classifierVersion: config.classifierVersion
  });
  const now = new Date().toISOString();
  db.prepare(
    "INSERT OR IGNORE INTO jev_observation_outbox " +
      "(observation_id, work_item_id, trace_id, question_set_version, classifier_version, " +
      "status, attempts, max_attempts, created_at, available_at) " +
      "VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)"
  ).run(
    observationId,
    workItemId,
    mission.trace_id,
    config.questionSetVersion,
    config.classifierVersion,
    config.maxAttempts,
    now,
    now
  );
  return readObservation(db, observationId);
}

export function claimNextObservation(db: ObservationSql, now: Date = new Date()): ObservationOutboxEntry | undefined {
  const nowIso = now.toISOString();
  const row = db
    .prepare(
      "SELECT * FROM jev_observation_outbox " +
        "WHERE status = 'pending' AND available_at <= ? AND attempts < max_attempts " +
        "ORDER BY created_at ASC, observation_id ASC LIMIT 1"
    )
    .get(nowIso) as ObservationRow | undefined;
  if (!row) return undefined;
  const claimed = db
    .prepare(
      "UPDATE jev_observation_outbox " +
        "SET status = 'running', attempts = attempts + 1, started_at = ?, error = NULL " +
        "WHERE observation_id = ? AND status = 'pending' AND attempts < max_attempts"
    )
    .run(nowIso, row.observation_id);
  if (Number(claimed.changes ?? 0) !== 1) return undefined;
  return readObservation(db, row.observation_id);
}

export function loadCanonicalTrace(
  db: ObservationSql,
  workItemId: string,
  traceId: string,
  maxEvents: number
): CanonicalTraceEvent[] {
  const rows = db
    .prepare("SELECT canonical_json FROM trace_outbox WHERE work_item_id = ? ORDER BY seq ASC LIMIT ?")
    .all(workItemId, maxEvents) as Array<{ canonical_json: string }>;
  const events: CanonicalTraceEvent[] = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.canonical_json) as CanonicalTraceEvent;
      if (parsed.trace_id === traceId) events.push(parsed);
    } catch {
      // Malformed observational evidence degrades upstream; it never affects authority.
    }
  }
  return events;
}

export function completeObservation(
  db: ObservationSql,
  observationId: string,
  completion: ObservationCompletion,
  now: Date = new Date()
): void {
  db.prepare(
    "UPDATE jev_observation_outbox SET status = ?, completed_at = ?, classifier_outcome = ?, " +
      "telemetry_correlation_id = ?, error = ? WHERE observation_id = ? AND status = 'running'"
  ).run(
    completion.status,
    now.toISOString(),
    completion.classifierOutcome,
    completion.telemetryCorrelationId,
    completion.error ? completion.error.slice(0, 500) : null,
    observationId
  );
}

export function retryObservation(
  db: ObservationSql,
  observationId: string,
  error: string,
  now: Date = new Date()
): "pending" | "failed" {
  const row = db
    .prepare("SELECT attempts, max_attempts FROM jev_observation_outbox WHERE observation_id = ?")
    .get(observationId) as { attempts: number; max_attempts: number } | undefined;
  if (!row) return "failed";
  const terminal = row.attempts >= row.max_attempts;
  const status = terminal ? "failed" : "pending";
  const nowIso = now.toISOString();
  db.prepare(
    "UPDATE jev_observation_outbox SET status = ?, available_at = ?, completed_at = ?, error = ? " +
      "WHERE observation_id = ? AND status = 'running'"
  ).run(status, nowIso, terminal ? nowIso : null, error.slice(0, 500), observationId);
  return status;
}

export function getObservationCapacity(db: ObservationSql, maxQueued: number): ObservationCapacity {
  const counts = db
    .prepare(
      "SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS queued, " +
        "SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running FROM jev_observation_outbox"
    )
    .get() as { queued: number | null; running: number | null };
  const queued = Number(counts.queued ?? 0);
  const running = Number(counts.running ?? 0);
  return { queued, running, maxQueued, saturated: queued + running >= maxQueued };
}

function readObservation(db: ObservationSql, observationId: string): ObservationOutboxEntry | undefined {
  const row = db.prepare("SELECT * FROM jev_observation_outbox WHERE observation_id = ?").get(observationId) as
    ObservationRow | undefined;
  if (!row) return undefined;
  return {
    observationId: row.observation_id,
    workItemId: row.work_item_id,
    traceId: row.trace_id,
    questionSetVersion: row.question_set_version,
    classifierVersion: row.classifier_version,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    status: row.status,
    createdAt: row.created_at,
    availableAt: row.available_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    classifierOutcome: row.classifier_outcome,
    telemetryCorrelationId: row.telemetry_correlation_id,
    error: row.error
  };
}
