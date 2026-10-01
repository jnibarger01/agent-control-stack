import type { DatabaseSync } from "node:sqlite";
import { ControlStackError, auditEventHash, auditEventSchema } from "@agent-control-stack/shared";
import { changeSetManifestHash, changeSetRecordSchema, type ChangeSetRecord } from "./change-set.js";

interface RevisionRow {
  mission_id: string;
  revision: number;
  submission_id: string;
  manifest_hash: string;
  audit_event_id: string;
  parent_manifest_hash: string | null;
  snapshot_json: string;
  created_by_actor_id: string;
  created_at: string;
}

function readRevision(db: DatabaseSync, row: RevisionRow): ChangeSetRecord {
  try {
    const snapshot: unknown = JSON.parse(row.snapshot_json);
    const record = changeSetRecordSchema.parse({
      snapshot,
      manifestHash: row.manifest_hash,
      auditEventId: row.audit_event_id,
      submissionId: row.submission_id,
      createdByActorId: row.created_by_actor_id,
      createdAt: row.created_at
    });
    if (
      changeSetManifestHash(snapshot) !== record.manifestHash ||
      record.snapshot.definition.missionId !== row.mission_id ||
      record.snapshot.revision !== row.revision ||
      record.snapshot.parentManifestHash !== row.parent_manifest_hash
    ) {
      throw new Error("revision binding mismatch");
    }
    const event = db.prepare("SELECT * FROM audit_events WHERE id = ?").get(record.auditEventId) as
      | {
          sequence: number;
          id: string;
          name: string;
          time_unix_nano: string;
          attributes: string;
          body: string;
          previous_hash: string;
          event_hash: string;
        }
      | undefined;
    if (!event) throw new Error("submission audit event missing");
    const parsedEvent = auditEventSchema.parse({
      id: event.id,
      name: event.name,
      timeUnixNano: event.time_unix_nano,
      attributes: JSON.parse(event.attributes),
      body: JSON.parse(event.body)
    });
    if (
      auditEventHash({ ...parsedEvent, sequence: event.sequence, previousHash: event.previous_hash }) !==
        event.event_hash ||
      parsedEvent.name !== "change_set.submitted" ||
      parsedEvent.body.missionId !== row.mission_id ||
      parsedEvent.body.revision !== row.revision ||
      parsedEvent.body.manifestHash !== row.manifest_hash ||
      parsedEvent.body.parentManifestHash !== row.parent_manifest_hash ||
      parsedEvent.body.submissionId !== record.submissionId ||
      parsedEvent.body.createdByActorId !== record.createdByActorId ||
      parsedEvent.body.createdAt !== record.createdAt ||
      parsedEvent.body.executingActorId !== record.snapshot.definition.executingActorId
    ) {
      throw new Error("submission audit event mismatch");
    }
    return record;
  } catch {
    throw new ControlStackError("change_set_integrity_mismatch", "persisted change set failed integrity verification");
  }
}

/** Storage helper only. The owning store supplies the transaction and audit. */
export function readChangeSet(db: DatabaseSync, missionId: string, revision?: number): ChangeSetRecord | undefined {
  let selectedRevision = revision;
  let headHash: string | undefined;
  if (selectedRevision === undefined) {
    // Observe the head and latest revision in one SQLite read snapshot. A
    // concurrent append cannot make a legitimate read look like head rollback.
    const head = db
      .prepare(
        `SELECT
      (SELECT revision FROM change_set_heads WHERE mission_id = ?) AS revision,
      (SELECT manifest_hash FROM change_set_heads WHERE mission_id = ?) AS manifest_hash,
      (SELECT MAX(revision) FROM change_set_revisions WHERE mission_id = ?) AS latest_revision`
      )
      .get(missionId, missionId, missionId) as {
      revision: number | null;
      manifest_hash: string | null;
      latest_revision: number | null;
    };
    if (head.revision === null) {
      if (head.latest_revision !== null)
        throw new ControlStackError("change_set_integrity_mismatch", "change set head missing");
      return undefined;
    }
    if (head.latest_revision !== head.revision || head.manifest_hash === null)
      throw new ControlStackError("change_set_integrity_mismatch", "change set head is stale");
    selectedRevision = head.revision;
    headHash = head.manifest_hash;
  }
  const rows = db
    .prepare("SELECT * FROM change_set_revisions WHERE mission_id = ? AND revision <= ? ORDER BY revision ASC")
    .all(missionId, selectedRevision) as unknown as RevisionRow[];
  if (!rows.some((row) => row.revision === selectedRevision)) {
    if (headHash !== undefined)
      throw new ControlStackError("change_set_integrity_mismatch", "change set head revision missing");
    return undefined;
  }
  let previous: ChangeSetRecord | undefined;
  for (const row of rows) {
    const record = readRevision(db, row);
    if (
      record.snapshot.revision !== (previous?.snapshot.revision ?? 0) + 1 ||
      record.snapshot.parentManifestHash !== (previous?.manifestHash ?? null)
    ) {
      throw new ControlStackError("change_set_integrity_mismatch", "change set revision chain mismatch");
    }
    previous = record;
  }
  if (headHash !== undefined && previous?.manifestHash !== headHash) {
    throw new ControlStackError("change_set_integrity_mismatch", "change set head hash mismatch");
  }
  return previous;
}

export function readChangeSetSubmission(
  db: DatabaseSync,
  missionId: string,
  submissionId: string
): ChangeSetRecord | undefined {
  const row = db
    .prepare("SELECT revision FROM change_set_revisions WHERE mission_id = ? AND submission_id = ?")
    .get(missionId, submissionId) as { revision: number } | undefined;
  return row ? readChangeSet(db, missionId, row.revision) : undefined;
}

export function insertChangeSetRevision(db: DatabaseSync, record: ChangeSetRecord): void {
  const { snapshot } = record;
  db.prepare(
    `INSERT INTO change_set_revisions
    (mission_id, revision, submission_id, manifest_hash, audit_event_id, parent_manifest_hash, snapshot_json, created_by_actor_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    snapshot.definition.missionId,
    snapshot.revision,
    record.submissionId,
    record.manifestHash,
    record.auditEventId,
    snapshot.parentManifestHash,
    JSON.stringify(snapshot),
    record.createdByActorId,
    record.createdAt
  );
  db.prepare(
    `INSERT INTO change_set_heads (mission_id, revision, manifest_hash) VALUES (?, ?, ?)
    ON CONFLICT(mission_id) DO UPDATE SET revision = excluded.revision, manifest_hash = excluded.manifest_hash`
  ).run(snapshot.definition.missionId, snapshot.revision, record.manifestHash);
}
