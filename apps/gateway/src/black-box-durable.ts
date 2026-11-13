import { DatabaseSync } from "node:sqlite";
import type {
  ObserverKeyRecord,
  RecorderEvent
} from "@agent-control-stack/black-box-recorder";

export interface DurableBlackBoxEventRow {
  event: RecorderEvent;
  producerKey: string;
  fingerprint: string;
  evidenceHash: string | null;
  auditEventId: string | null;
  auditEventHash: string | null;
}

export class SqliteBlackBoxPersistence {
  readonly #db: DatabaseSync;

  constructor(dbPath: string) {
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec("PRAGMA busy_timeout = 5000;");
  }

  close(): void {
    this.#db.close();
  }

  loadEvents(): DurableBlackBoxEventRow[] {
    const rows = this.#db
      .prepare(
        `SELECT event_json, producer_key, fingerprint, evidence_hash, audit_event_id, audit_event_hash
         FROM black_box_events
         ORDER BY seq ASC`
      )
      .all() as Array<{
      event_json: string;
      producer_key: string;
      fingerprint: string;
      evidence_hash: string | null;
      audit_event_id: string | null;
      audit_event_hash: string | null;
    }>;

    return rows.map((row) => ({
      event: JSON.parse(row.event_json) as RecorderEvent,
      producerKey: row.producer_key,
      fingerprint: row.fingerprint,
      evidenceHash: row.evidence_hash,
      auditEventId: row.audit_event_id,
      auditEventHash: row.audit_event_hash
    }));
  }

  loadChainState(): { seq: number; headHash: string } {
    const row = this.#db
      .prepare(`SELECT seq, head_hash FROM black_box_chain_state WHERE id = 1`)
      .get() as { seq: number; head_hash: string } | undefined;
    if (!row) {
      return { seq: 0, headHash: "0".repeat(64) };
    }
    return { seq: row.seq, headHash: row.head_hash };
  }

  appendEvent(input: {
    event: RecorderEvent;
    producerKey: string;
    fingerprint: string;
    evidenceHash: string | null;
    auditEventId: string | null;
    auditEventHash: string | null;
  }): void {
    const { event, producerKey, fingerprint, evidenceHash, auditEventId, auditEventHash } = input;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(
          `INSERT INTO black_box_events (
            seq, event_id, producer_key, run_id, mission_id, correlation_id,
            event_type, trust_level, evidence_hash, payload_sha256, previous_hash,
            event_hash, event_json, fingerprint, audit_event_id, audit_event_hash, ingested_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          event.evidence.seq,
          event.eventId,
          producerKey,
          event.runId,
          event.missionId,
          event.correlationId,
          event.eventType,
          event.trustLevel,
          evidenceHash,
          event.evidence.payloadSha256,
          event.evidence.previousHash,
          event.evidence.eventHash,
          JSON.stringify(event),
          fingerprint,
          auditEventId,
          auditEventHash,
          event.ingestedAt
        );
      this.#db
        .prepare(
          `UPDATE black_box_chain_state SET seq = ?, head_hash = ?, updated_at = ? WHERE id = 1`
        )
        .run(event.evidence.seq, event.evidence.eventHash, event.ingestedAt);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  loadObserverKeys(): ObserverKeyRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT key_id, observer_id, public_key_pem, status, registered_at, registered_by,
                rotated_at, rotated_to_key_id, revoked_at, revoked_by, revocation_reason, audit_event_id
         FROM black_box_observer_keys
         ORDER BY registered_at ASC, key_id ASC`
      )
      .all() as Array<{
      key_id: string;
      observer_id: string;
      public_key_pem: string;
      status: "active" | "rotated" | "revoked";
      registered_at: string;
      registered_by: string;
      rotated_at: string | null;
      rotated_to_key_id: string | null;
      revoked_at: string | null;
      revoked_by: string | null;
      revocation_reason: string | null;
      audit_event_id: string | null;
    }>;

    return rows.map((row) => ({
      keyId: row.key_id,
      observerId: row.observer_id,
      publicKeyPem: row.public_key_pem,
      status: row.status,
      registeredAt: row.registered_at,
      registeredBy: row.registered_by,
      rotatedAt: row.rotated_at,
      rotatedToKeyId: row.rotated_to_key_id,
      revokedAt: row.revoked_at,
      revokedBy: row.revoked_by,
      revocationReason: row.revocation_reason,
      auditEventId: row.audit_event_id
    }));
  }

  upsertObserverKey(record: ObserverKeyRecord): void {
    this.#db
      .prepare(
        `INSERT INTO black_box_observer_keys (
          key_id, observer_id, public_key_pem, status, registered_at, registered_by,
          rotated_at, rotated_to_key_id, revoked_at, revoked_by, revocation_reason, audit_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key_id) DO UPDATE SET
          status = excluded.status,
          rotated_at = excluded.rotated_at,
          rotated_to_key_id = excluded.rotated_to_key_id,
          revoked_at = excluded.revoked_at,
          revoked_by = excluded.revoked_by,
          revocation_reason = excluded.revocation_reason`
      )
      .run(
        record.keyId,
        record.observerId,
        record.publicKeyPem,
        record.status,
        record.registeredAt,
        record.registeredBy,
        record.rotatedAt,
        record.rotatedToKeyId,
        record.revokedAt,
        record.revokedBy,
        record.revocationReason,
        record.auditEventId
      );
  }
}
