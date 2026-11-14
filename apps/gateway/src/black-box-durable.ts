import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  GENESIS_HASH,
  canonicalJson,
  isJcKernelWitnessReceiptV2,
  verifyRecorderChain,
  type JcKernelWitnessReceipt,
  type ObserverKeyRecord,
  type ObserverKeyRegistry,
  type PreparedRecorderDraft,
  type RecorderEvent,
  type RecorderStore,
  type WormChainHeadAnchor,
  type WormEvidenceSink,
  type WormIntegrityReport,
  type WormReceiptEnvelope
} from "@agent-control-stack/black-box-recorder";
import {
  auditEventHash,
  createEvent
} from "@agent-control-stack/shared";
import type { StoredAuditEvent } from "@agent-control-stack/work-items";

export type FaultBoundary =
  | "B1_BEFORE_VERIFY"
  | "B2_AFTER_VERIFY_BEFORE_TX"
  | "B3_INSIDE_TX_AFTER_AUDIT_INSERT"
  | "B4_INSIDE_TX_AFTER_EVENT_INSERT"
  | "B5_INSIDE_TX_AFTER_CHAIN_STATE_UPDATE"
  | "B6_INSIDE_TX_BEFORE_COMMIT"
  | "B7_AFTER_COMMIT_BEFORE_MEMORY_SYNC"
  | "B8_BEFORE_WORM_OUTBOX_SEND"
  | "B9_DURING_WORM_SINK_PUT"
  | "B10_AFTER_WORM_PUT_BEFORE_OUTBOX_MARK_ANCHORED";

export type FaultInjector = (boundary: FaultBoundary) => void | Promise<void>;

export interface DurableBlackBoxEventRow {
  event: RecorderEvent;
  producerKey: string;
  fingerprint: string;
  evidenceHash: string | null;
  auditEventId: string | null;
  auditEventHash: string | null;
  receiptSchema: string | null;
  receiptJson: string | null;
  receiptSignature: string | null;
  observerKeyId: string | null;
  workItemId: string | null;
  attemptId: string | null;
  leaseId: string | null;
  invocationHash: string | null;
}

export interface WormOutboxRow {
  seq: number;
  eventId: string;
  evidenceHash: string;
  eventHash: string;
  previousHash: string;
  receiptJson: string;
  eventJson: string;
  auditEventId: string;
  auditEventHash: string;
  idempotencyKey: string | null;
  status: "pending" | "sending" | "anchored" | "failed";
  wormProvider: string | null;
  wormObjectKey: string | null;
  wormVersionId: string | null;
  wormEtagSha256: string | null;
  retentionMode: string | null;
  retainUntil: string | null;
  attemptCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  anchoredAt: string | null;
}

export interface ExecutionBindingVerification {
  workItemExists: boolean;
  anchorVerified: boolean;
  reasons: string[];
}

function sha256HexSync(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function computeEventHashSync(
  seq: number,
  previousHash: string,
  eventId: string,
  payloadSha256: string
): string {
  return sha256HexSync(
    canonicalJson({ seq, previousHash, eventId, payloadSha256 })
  );
}

const auditProcessId = String(process.pid);
const auditProcessStartedAt = new Date(
  Date.now() - process.uptime() * 1000
).toISOString();

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
        `SELECT event_json, producer_key, fingerprint, evidence_hash, audit_event_id, audit_event_hash,
                receipt_schema, receipt_json, receipt_signature, observer_key_id,
                work_item_id, attempt_id, lease_id, invocation_hash
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
      receipt_schema: string | null;
      receipt_json: string | null;
      receipt_signature: string | null;
      observer_key_id: string | null;
      work_item_id: string | null;
      attempt_id: string | null;
      lease_id: string | null;
      invocation_hash: string | null;
    }>;

    return rows.map((row) => ({
      event: JSON.parse(row.event_json) as RecorderEvent,
      producerKey: row.producer_key,
      fingerprint: row.fingerprint,
      evidenceHash: row.evidence_hash,
      auditEventId: row.audit_event_id,
      auditEventHash: row.audit_event_hash,
      receiptSchema: row.receipt_schema,
      receiptJson: row.receipt_json,
      receiptSignature: row.receipt_signature,
      observerKeyId: row.observer_key_id,
      workItemId: row.work_item_id,
      attemptId: row.attempt_id,
      leaseId: row.lease_id,
      invocationHash: row.invocation_hash
    }));
  }

  loadChainState(): { seq: number; headHash: string } {
    const row = this.#db
      .prepare(`SELECT seq, head_hash FROM black_box_chain_state WHERE id = 1`)
      .get() as { seq: number; head_hash: string } | undefined;
    if (!row) {
      return { seq: 0, headHash: GENESIS_HASH };
    }
    return { seq: row.seq, headHash: row.head_hash };
  }

  async verifyAndHydrateStore(
    recorderStore: RecorderStore,
    seenEvidenceHashes: Set<string>
  ): Promise<void> {
    const persistedEvents = this.loadEvents();
    const chainState = this.loadChainState();
    await recorderStore.hydrate(persistedEvents, chainState);
    for (const row of persistedEvents) {
      if (row.evidenceHash) {
        seenEvidenceHashes.add(row.evidenceHash);
      }
    }
  }

  /**
   * Synchronizes any committed rows from SQLite that have not yet been reflected
   * in the in-memory RecorderStore (for example, after a crash at B7_AFTER_COMMIT_BEFORE_MEMORY_SYNC).
   */
  syncPendingFromDatabase(
    recorderStore: RecorderStore,
    seenEvidenceHashes: Set<string>
  ): void {
    const rows = this.loadEvents();
    for (const row of rows) {
      recorderStore.syncCommittedEvent({
        event: row.event,
        producerKey: row.producerKey,
        fingerprint: row.fingerprint,
        evidenceHash: row.evidenceHash
      });
      if (row.evidenceHash) {
        seenEvidenceHashes.add(row.evidenceHash);
      }
    }
  }

  verifyExecutionBinding(
    receipt: JcKernelWitnessReceipt,
    options?: {
      workItemExistsInController?: boolean;
      strictExecutionBinding?: boolean;
    }
  ): ExecutionBindingVerification {
    const reasons: string[] = [];
    const workItemRow = this.#db
      .prepare(`SELECT id FROM work_items WHERE id = ?`)
      .get(receipt.workItemId) as { id: string } | undefined;
    const workItemExists = Boolean(
      workItemRow || options?.workItemExistsInController
    );
    if (!workItemExists) {
      reasons.push(`workItemId ${receipt.workItemId} does not exist in ACS`);
    }

    const validAnchorPrefix =
      typeof receipt.acsAnchorRef === "string" &&
      (receipt.acsAnchorRef === `acs:work_item:${receipt.workItemId}` ||
        receipt.acsAnchorRef === `acs:mission:${receipt.workItemId}` ||
        receipt.acsAnchorRef.startsWith(`acs:work_item:${receipt.workItemId}:`) ||
        receipt.acsAnchorRef.startsWith(`acs:mission:${receipt.workItemId}:`));
    if (!validAnchorPrefix) {
      reasons.push(
        `acsAnchorRef '${receipt.acsAnchorRef}' does not bind to workItemId '${receipt.workItemId}'`
      );
    }

    // Check execution_attempts table
    const attemptRow = this.#db
      .prepare(
        `SELECT work_item_id FROM execution_attempts WHERE attempt_id = ?`
      )
      .get(receipt.attemptId) as { work_item_id: string } | undefined;
    if (attemptRow) {
      if (attemptRow.work_item_id !== receipt.workItemId) {
        reasons.push(
          `attemptId '${receipt.attemptId}' is bound to workItemId '${attemptRow.work_item_id}', not '${receipt.workItemId}'`
        );
      }
    } else {
      const attemptCount = (
        this.#db
          .prepare(
            `SELECT COUNT(*) AS cnt FROM execution_attempts WHERE work_item_id = ?`
          )
          .get(receipt.workItemId) as { cnt: number }
      ).cnt;
      if (attemptCount > 0 || options?.strictExecutionBinding) {
        reasons.push(
          `attemptId '${receipt.attemptId}' is not registered in execution_attempts for workItemId '${receipt.workItemId}'`
        );
      }
    }

    // Check attempt_leases table
    const leaseRow = this.#db
      .prepare(
        `SELECT work_item_id, attempt_id FROM attempt_leases WHERE lease_id = ?`
      )
      .get(receipt.leaseId) as
      | { work_item_id: string; attempt_id: string }
      | undefined;
    if (leaseRow) {
      if (
        leaseRow.work_item_id !== receipt.workItemId ||
        leaseRow.attempt_id !== receipt.attemptId
      ) {
        reasons.push(
          `leaseId '${receipt.leaseId}' is bound to (${leaseRow.work_item_id}, ${leaseRow.attempt_id}), not (${receipt.workItemId}, ${receipt.attemptId})`
        );
      }
    } else {
      const leaseCount = (
        this.#db
          .prepare(
            `SELECT COUNT(*) AS cnt FROM attempt_leases WHERE work_item_id = ? AND attempt_id = ?`
          )
          .get(receipt.workItemId, receipt.attemptId) as { cnt: number }
      ).cnt;
      if (leaseCount > 0 || options?.strictExecutionBinding) {
        reasons.push(
          `leaseId '${receipt.leaseId}' is not registered in attempt_leases for (${receipt.workItemId}, ${receipt.attemptId})`
        );
      }
    }

    // Check jace_commander_capability_issuances table
    const capRow = this.#db
      .prepare(
        `SELECT work_item_id, attempt_id, lease_id FROM jace_commander_capability_issuances WHERE invocation_hash = ?`
      )
      .get(receipt.invocationHash) as
      | { work_item_id: string; attempt_id: string; lease_id: string }
      | undefined;
    if (capRow) {
      if (
        capRow.work_item_id !== receipt.workItemId ||
        capRow.attempt_id !== receipt.attemptId ||
        capRow.lease_id !== receipt.leaseId
      ) {
        reasons.push(
          `invocationHash '${receipt.invocationHash}' is bound to (${capRow.work_item_id}, ${capRow.attempt_id}, ${capRow.lease_id})`
        );
      }
    } else {
      const capCount = (
        this.#db
          .prepare(
            `SELECT COUNT(*) AS cnt FROM jace_commander_capability_issuances WHERE work_item_id = ? AND attempt_id = ?`
          )
          .get(receipt.workItemId, receipt.attemptId) as { cnt: number }
      ).cnt;
      if (capCount > 0) {
        reasons.push(
          `invocationHash '${receipt.invocationHash}' does not match any issued capability for (${receipt.workItemId}, ${receipt.attemptId})`
        );
      }
    }

    return {
      workItemExists,
      anchorVerified: workItemExists && reasons.length === 0,
      reasons
    };
  }

  #appendAuditEventInTx(input: {
    name: string;
    body: Record<string, unknown>;
    attributes: Record<string, string | number | boolean>;
  }): StoredAuditEvent {
    const rawEvent = createEvent(input.name, input.body, {
      ...input.attributes,
      "acs.process.id": auditProcessId,
      "acs.process.started_at": auditProcessStartedAt,
      "acs.instance": "local",
      "acs.release_sha": "unreleased"
    });
    const prevRow = this.#db
      .prepare(
        `SELECT event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1`
      )
      .get() as { event_hash: string } | undefined;
    const previousHash = prevRow?.event_hash ?? "";

    this.#db
      .prepare(
        `INSERT INTO audit_events (id, name, time_unix_nano, attributes, body, previous_hash, event_hash)
         VALUES (?, ?, ?, ?, ?, ?, '')`
      )
      .run(
        rawEvent.id,
        rawEvent.name,
        rawEvent.timeUnixNano,
        JSON.stringify(rawEvent.attributes),
        JSON.stringify(rawEvent.body),
        previousHash
      );

    const insertedRow = this.#db
      .prepare(
        `SELECT sequence, id, name, time_unix_nano, attributes, body, previous_hash, event_hash
         FROM audit_events WHERE id = ?`
      )
      .get(rawEvent.id) as {
      sequence: number;
      id: string;
      name: string;
      time_unix_nano: string;
      attributes: string;
      body: string;
      previous_hash: string;
      event_hash: string;
    };

    const stored: StoredAuditEvent = {
      sequence: insertedRow.sequence,
      id: insertedRow.id,
      name: insertedRow.name,
      timeUnixNano: insertedRow.time_unix_nano,
      attributes: JSON.parse(
        insertedRow.attributes
      ) as StoredAuditEvent["attributes"],
      body: JSON.parse(insertedRow.body) as StoredAuditEvent["body"],
      previousHash: insertedRow.previous_hash,
      eventHash: ""
    };
    const computedHash = auditEventHash(stored);
    this.#db
      .prepare(`UPDATE audit_events SET event_hash = ? WHERE sequence = ?`)
      .run(computedHash, stored.sequence);
    return {
      ...stored,
      eventHash: computedHash
    };
  }

  #readAuditEventById(id: string): StoredAuditEvent | null {
    const row = this.#db
      .prepare(
        `SELECT sequence, id, name, time_unix_nano, attributes, body, previous_hash, event_hash
         FROM audit_events WHERE id = ?`
      )
      .get(id) as
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
    if (!row) return null;
    return {
      sequence: row.sequence,
      id: row.id,
      name: row.name,
      timeUnixNano: row.time_unix_nano,
      attributes: JSON.parse(row.attributes) as StoredAuditEvent["attributes"],
      body: JSON.parse(row.body) as StoredAuditEvent["body"],
      previousHash: row.previous_hash,
      eventHash: row.event_hash
    };
  }

  /**
   * Executes atomic receipt ingestion in a single BEGIN IMMEDIATE transaction:
   * 1. Appends audit_events row
   * 2. Inserts black_box_events row
   * 3. Advances black_box_chain_state with CAS check (WHERE id = 1 AND seq = ? AND head_hash = ?)
   * 4. Enqueues black_box_worm_outbox row
   */
  ingestWitnessReceiptTransactional(input: {
    receipt: JcKernelWitnessReceipt;
    prepared: PreparedRecorderDraft;
    observed: boolean;
    actor: string;
    idempotencyKey?: string | null;
    allowUnkeyedIdempotentRecovery?: boolean;
    faultInjector?: FaultInjector;
  }):
    | {
        status: "created" | "duplicate";
        event: RecorderEvent;
        producerKey: string;
        fingerprint: string;
        auditEvent: StoredAuditEvent;
        recordedAudit: boolean;
      }
    | {
        status: "conflict" | "replay";
        existingEvent: RecorderEvent;
        rejectedSha256: string;
        reason: string;
      } {
    const {
      receipt,
      prepared,
      observed,
      actor,
      idempotencyKey,
      allowUnkeyedIdempotentRecovery,
      faultInjector
    } = input;

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      // Check existing by producer_key or evidence_hash inside the transaction
      const existingRow = this.#db
        .prepare(
          `SELECT event_json, producer_key, fingerprint, evidence_hash, audit_event_id, audit_event_hash
           FROM black_box_events
           WHERE producer_key = ? OR evidence_hash = ?
           LIMIT 1`
        )
        .get(prepared.producerKey, receipt.evidenceHash) as
        | {
            event_json: string;
            producer_key: string;
            fingerprint: string;
            evidence_hash: string | null;
            audit_event_id: string | null;
            audit_event_hash: string | null;
          }
        | undefined;

      if (existingRow) {
        const existingEvent = JSON.parse(
          existingRow.event_json
        ) as RecorderEvent;
        const isExactSamePayload =
          existingRow.producer_key === prepared.producerKey &&
          existingRow.fingerprint === prepared.fingerprint &&
          existingRow.evidence_hash === receipt.evidenceHash;

        if (!isExactSamePayload) {
          this.#db.exec("ROLLBACK");
          return {
            status: "conflict",
            existingEvent,
            rejectedSha256: prepared.payloadSha256,
            reason:
              existingRow.producer_key === prepared.producerKey
                ? "conflicting witness receipt payload for existing producer identity"
                : "replayed evidenceHash under a different producer identity"
          };
        }

        // Exact same receipt already committed in SQLite.
        // Check if idempotencyKey matches or if recovering from a B7 crash.
        const outboxRow = this.#db
          .prepare(
            `SELECT idempotency_key FROM black_box_worm_outbox WHERE event_id = ?`
          )
          .get(existingEvent.eventId) as
          | { idempotency_key: string | null }
          | undefined;

        const isIdempotentRetry =
          Boolean(
            idempotencyKey &&
              (outboxRow?.idempotency_key === idempotencyKey ||
                outboxRow?.idempotency_key === null)
          ) || Boolean(allowUnkeyedIdempotentRecovery);

        if (!isIdempotentRetry) {
          this.#db.exec("ROLLBACK");
          return {
            status: "replay",
            existingEvent,
            rejectedSha256: prepared.payloadSha256,
            reason: `replayed witness receipt evidenceHash ${receipt.evidenceHash}`
          };
        }

        const existingAudit = existingRow.audit_event_id
          ? this.#readAuditEventById(existingRow.audit_event_id)
          : null;
        this.#db.exec("COMMIT");
        return {
          status: "duplicate",
          event: existingEvent,
          producerKey: existingRow.producer_key,
          fingerprint: existingRow.fingerprint,
          auditEvent:
            existingAudit ?? {
              sequence: 0,
              id: existingRow.audit_event_id ?? "audit_recovered",
              name: observed
                ? "black_box.witness_observed"
                : "black_box.witness_incomplete",
              timeUnixNano: "0",
              attributes: {},
              body: {},
              previousHash: "",
              eventHash: existingRow.audit_event_hash ?? GENESIS_HASH
            },
          recordedAudit: false
        };
      }

      if (idempotencyKey) {
        const existingIdemp = this.#db
          .prepare(
            `SELECT b.event_json FROM black_box_worm_outbox o
             JOIN black_box_events b ON b.seq = o.seq
             WHERE o.idempotency_key = ? LIMIT 1`
          )
          .get(idempotencyKey) as { event_json: string } | undefined;
        if (existingIdemp) {
          const existingEvent = JSON.parse(
            existingIdemp.event_json
          ) as RecorderEvent;
          this.#db.exec("ROLLBACK");
          return {
            status: "conflict",
            existingEvent,
            rejectedSha256: prepared.payloadSha256,
            reason: `idempotency key '${idempotencyKey}' was already used for a different receipt`
          };
        }
      }

      const chainState = this.loadChainState();
      const seq = chainState.seq + 1;
      const previousHash = chainState.headHash;
      const eventHash = computeEventHashSync(
        seq,
        previousHash,
        prepared.partial.eventId,
        prepared.payloadSha256
      );

      const event: RecorderEvent = {
        ...prepared.partial,
        evidence: {
          ...prepared.partial.evidence,
          payloadSha256: prepared.payloadSha256,
          seq,
          previousHash,
          eventHash
        }
      };

      const auditEvent = this.#appendAuditEventInTx({
        name: observed
          ? "black_box.witness_observed"
          : "black_box.witness_incomplete",
        attributes: {
          "work_item.id": receipt.workItemId,
          "witness.attempt_id": receipt.attemptId,
          "witness.lease_id": receipt.leaseId,
          "witness.evidence_hash": receipt.evidenceHash,
          "witness.observed": observed,
          "black_box.actor": actor
        },
        body: {
          schemaVersion: receipt.schemaVersion,
          observerId: receipt.observerId,
          observerMode: receipt.observerMode,
          status: receipt.status,
          cgroupId: receipt.cgroupId,
          droppedEvents: receipt.droppedEvents,
          sequenceGaps: receipt.sequenceGaps,
          evidenceHash: receipt.evidenceHash,
          previousEvidenceHash: receipt.previousEvidenceHash,
          acsAnchorRef: receipt.acsAnchorRef,
          ...(isJcKernelWitnessReceiptV2(receipt)
            ? {
                observationScope: receipt.observationScope,
                categoryCompleteness: receipt.categoryCompleteness
              }
            : {})
        }
      });

      faultInjector?.("B3_INSIDE_TX_AFTER_AUDIT_INSERT");

      const receiptJson = canonicalJson(receipt);
      const eventJson = JSON.stringify(event);
      const observationScopeJson = isJcKernelWitnessReceiptV2(receipt)
        ? canonicalJson(receipt.observationScope)
        : null;
      const categoryCompletenessJson = isJcKernelWitnessReceiptV2(receipt)
        ? canonicalJson(receipt.categoryCompleteness)
        : null;

      this.#db
        .prepare(
          `INSERT INTO black_box_events (
            seq, event_id, producer_key, run_id, mission_id, correlation_id,
            event_type, trust_level, evidence_hash, payload_sha256, previous_hash,
            event_hash, event_json, fingerprint, audit_event_id, audit_event_hash, ingested_at,
            receipt_schema, receipt_json, receipt_signature, observer_key_id,
            work_item_id, attempt_id, lease_id, invocation_hash,
            observation_scope_json, category_completeness_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          seq,
          event.eventId,
          prepared.producerKey,
          event.runId,
          event.missionId,
          event.correlationId,
          event.eventType,
          event.trustLevel,
          receipt.evidenceHash,
          event.evidence.payloadSha256,
          previousHash,
          eventHash,
          eventJson,
          prepared.fingerprint,
          auditEvent.id,
          auditEvent.eventHash,
          event.ingestedAt,
          receipt.schemaVersion,
          receiptJson,
          receipt.signature,
          receipt.signingKeyId,
          receipt.workItemId,
          receipt.attemptId,
          receipt.leaseId,
          receipt.invocationHash,
          observationScopeJson,
          categoryCompletenessJson
        );

      faultInjector?.("B4_INSIDE_TX_AFTER_EVENT_INSERT");

      const casResult = this.#db
        .prepare(
          `UPDATE black_box_chain_state
           SET seq = ?, head_hash = ?, updated_at = ?
           WHERE id = 1 AND seq = ? AND head_hash = ?`
        )
        .run(
          seq,
          eventHash,
          event.ingestedAt,
          chainState.seq,
          chainState.headHash
        );
      if (casResult.changes !== 1) {
        throw new Error(
          `black_box_chain_cas_conflict: expected (seq=${chainState.seq}, headHash=${chainState.headHash})`
        );
      }

      faultInjector?.("B5_INSIDE_TX_AFTER_CHAIN_STATE_UPDATE");

      this.#db
        .prepare(
          `INSERT INTO black_box_worm_outbox (
            seq, event_id, evidence_hash, event_hash, previous_hash,
            receipt_json, event_json, audit_event_id, audit_event_hash,
            idempotency_key, status, attempt_count, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`
        )
        .run(
          seq,
          event.eventId,
          receipt.evidenceHash,
          eventHash,
          previousHash,
          receiptJson,
          eventJson,
          auditEvent.id,
          auditEvent.eventHash,
          idempotencyKey ?? null,
          event.ingestedAt,
          event.ingestedAt
        );

      faultInjector?.("B6_INSIDE_TX_BEFORE_COMMIT");

      this.#db.exec("COMMIT");

      return {
        status: "created",
        event,
        producerKey: prepared.producerKey,
        fingerprint: prepared.fingerprint,
        auditEvent,
        recordedAudit: true
      };
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Transaction may already be rolled back.
      }
      throw error;
    }
  }

  appendEvent(input: {
    event: RecorderEvent;
    producerKey: string;
    fingerprint: string;
    evidenceHash: string | null;
    auditEventId: string | null;
    auditEventHash: string | null;
  }): void {
    const {
      event,
      producerKey,
      fingerprint,
      evidenceHash,
      auditEventId,
      auditEventHash
    } = input;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const chainState = this.loadChainState();
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
      const cas = this.#db
        .prepare(
          `UPDATE black_box_chain_state
           SET seq = ?, head_hash = ?, updated_at = ?
           WHERE id = 1 AND seq = ? AND head_hash = ?`
        )
        .run(
          event.evidence.seq,
          event.evidence.eventHash,
          event.ingestedAt,
          chainState.seq,
          chainState.headHash
        );
      if (cas.changes !== 1) {
        throw new Error("black_box_chain_cas_conflict");
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  loadObserverKeys(): ObserverKeyRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT key_id, observer_id, public_key_pem, public_key_fingerprint_sha256,
                status, registered_at, registered_by,
                rotated_at, rotated_to_key_id, retired_at, retired_by,
                revoked_at, revoked_by, revocation_reason, audit_event_id
         FROM black_box_observer_keys
         ORDER BY registered_at ASC, key_id ASC`
      )
      .all() as Array<{
      key_id: string;
      observer_id: string;
      public_key_pem: string;
      public_key_fingerprint_sha256: string;
      status: "active" | "rotated" | "retired" | "revoked";
      registered_at: string;
      registered_by: string;
      rotated_at: string | null;
      rotated_to_key_id: string | null;
      retired_at: string | null;
      retired_by: string | null;
      revoked_at: string | null;
      revoked_by: string | null;
      revocation_reason: string | null;
      audit_event_id: string | null;
    }>;

    return rows.map((row) => ({
      keyId: row.key_id,
      observerId: row.observer_id,
      publicKeyPem: row.public_key_pem,
      publicKeyFingerprintSha256: row.public_key_fingerprint_sha256,
      status: row.status,
      registeredAt: row.registered_at,
      registeredBy: row.registered_by,
      rotatedAt: row.rotated_at,
      rotatedToKeyId: row.rotated_to_key_id,
      retiredAt: row.retired_at,
      retiredBy: row.retired_by,
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
          key_id, observer_id, public_key_pem, public_key_fingerprint_sha256,
          status, registered_at, registered_by,
          rotated_at, rotated_to_key_id, retired_at, retired_by,
          revoked_at, revoked_by, revocation_reason, audit_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key_id) DO UPDATE SET
          status = excluded.status,
          rotated_at = excluded.rotated_at,
          rotated_to_key_id = excluded.rotated_to_key_id,
          retired_at = excluded.retired_at,
          retired_by = excluded.retired_by,
          revoked_at = excluded.revoked_at,
          revoked_by = excluded.revoked_by,
          revocation_reason = excluded.revocation_reason`
      )
      .run(
        record.keyId,
        record.observerId,
        record.publicKeyPem,
        record.publicKeyFingerprintSha256 ?? "",
        record.status,
        record.registeredAt,
        record.registeredBy,
        record.rotatedAt,
        record.rotatedToKeyId,
        record.retiredAt ?? null,
        record.retiredBy ?? null,
        record.revokedAt,
        record.revokedBy,
        record.revocationReason,
        record.auditEventId
      );
  }

  registerObserverKeyTransactional(input: {
    record: ObserverKeyRecord;
    actor: string;
  }): { record: ObserverKeyRecord; auditEvent: StoredAuditEvent } {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const auditEvent = this.#appendAuditEventInTx({
        name: "black_box.observer_key_registered",
        attributes: {
          "observer.id": input.record.observerId,
          "observer.key_id": input.record.keyId,
          "observer.fingerprint_sha256":
            input.record.publicKeyFingerprintSha256 ?? "",
          "black_box.actor": input.actor
        },
        body: {
          keyId: input.record.keyId,
          observerId: input.record.observerId,
          publicKeyFingerprintSha256:
            input.record.publicKeyFingerprintSha256 ?? ""
        }
      });
      const finalRecord: ObserverKeyRecord = {
        ...input.record,
        auditEventId: auditEvent.id
      };
      this.upsertObserverKey(finalRecord);
      this.#db.exec("COMMIT");
      return { record: finalRecord, auditEvent };
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw error;
    }
  }

  rotateObserverKeyTransactional(input: {
    oldRecord: ObserverKeyRecord;
    newRecord: ObserverKeyRecord;
    actor: string;
  }): {
    oldRecord: ObserverKeyRecord;
    newRecord: ObserverKeyRecord;
    auditEvent: StoredAuditEvent;
  } {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const auditEvent = this.#appendAuditEventInTx({
        name: "black_box.observer_key_rotated",
        attributes: {
          "observer.old_key_id": input.oldRecord.keyId,
          "observer.new_key_id": input.newRecord.keyId,
          "black_box.actor": input.actor
        },
        body: {
          oldKeyId: input.oldRecord.keyId,
          newKeyId: input.newRecord.keyId,
          newKeyFingerprintSha256:
            input.newRecord.publicKeyFingerprintSha256 ?? ""
        }
      });
      const finalNewRecord: ObserverKeyRecord = {
        ...input.newRecord,
        auditEventId: auditEvent.id
      };
      this.upsertObserverKey(input.oldRecord);
      this.upsertObserverKey(finalNewRecord);
      this.#db.exec("COMMIT");
      return {
        oldRecord: input.oldRecord,
        newRecord: finalNewRecord,
        auditEvent
      };
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw error;
    }
  }

  retireObserverKeyTransactional(input: {
    record: ObserverKeyRecord;
    actor: string;
  }): { record: ObserverKeyRecord; auditEvent: StoredAuditEvent } {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const auditEvent = this.#appendAuditEventInTx({
        name: "black_box.observer_key_retired",
        attributes: {
          "observer.key_id": input.record.keyId,
          "black_box.actor": input.actor
        },
        body: {
          keyId: input.record.keyId,
          retiredAt: input.record.retiredAt
        }
      });
      this.upsertObserverKey(input.record);
      this.#db.exec("COMMIT");
      return { record: input.record, auditEvent };
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw error;
    }
  }

  revokeObserverKeyTransactional(input: {
    record: ObserverKeyRecord;
    reason: string;
    actor: string;
  }): { record: ObserverKeyRecord; auditEvent: StoredAuditEvent } {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const auditEvent = this.#appendAuditEventInTx({
        name: "black_box.observer_key_revoked",
        attributes: {
          "observer.key_id": input.record.keyId,
          "black_box.actor": input.actor
        },
        body: {
          keyId: input.record.keyId,
          reason: input.reason,
          revokedAt: input.record.revokedAt
        }
      });
      this.upsertObserverKey(input.record);
      this.#db.exec("COMMIT");
      return { record: input.record, auditEvent };
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw error;
    }
  }

  listWormOutbox(): WormOutboxRow[] {
    const rows = this.#db
      .prepare(
        `SELECT seq, event_id, evidence_hash, event_hash, previous_hash,
                receipt_json, event_json, audit_event_id, audit_event_hash,
                idempotency_key, status, worm_provider, worm_object_key,
                worm_version_id, worm_etag_sha256, retention_mode, retain_until,
                attempt_count, last_error, created_at, updated_at, anchored_at
         FROM black_box_worm_outbox
         ORDER BY seq ASC`
      )
      .all() as Array<{
      seq: number;
      event_id: string;
      evidence_hash: string;
      event_hash: string;
      previous_hash: string;
      receipt_json: string;
      event_json: string;
      audit_event_id: string;
      audit_event_hash: string;
      idempotency_key: string | null;
      status: "pending" | "sending" | "anchored" | "failed";
      worm_provider: string | null;
      worm_object_key: string | null;
      worm_version_id: string | null;
      worm_etag_sha256: string | null;
      retention_mode: string | null;
      retain_until: string | null;
      attempt_count: number;
      last_error: string | null;
      created_at: string;
      updated_at: string;
      anchored_at: string | null;
    }>;

    return rows.map((r) => ({
      seq: r.seq,
      eventId: r.event_id,
      evidenceHash: r.evidence_hash,
      eventHash: r.event_hash,
      previousHash: r.previous_hash,
      receiptJson: r.receipt_json,
      eventJson: r.event_json,
      auditEventId: r.audit_event_id,
      auditEventHash: r.audit_event_hash,
      idempotencyKey: r.idempotency_key,
      status: r.status,
      wormProvider: r.worm_provider,
      wormObjectKey: r.worm_object_key,
      wormVersionId: r.worm_version_id,
      wormEtagSha256: r.worm_etag_sha256,
      retentionMode: r.retention_mode,
      retainUntil: r.retain_until,
      attemptCount: r.attempt_count,
      lastError: r.last_error,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      anchoredAt: r.anchored_at
    }));
  }

  /**
   * Flushes all unanchored rows in black_box_worm_outbox to the configured off-host WORM sink.
   * Supports crash recovery across boundaries B8, B9, and B10.
   */
  async flushWormOutbox(
    sink: WormEvidenceSink,
    keyRegistry: ObserverKeyRegistry,
    faultInjector?: FaultInjector
  ): Promise<{ anchoredCount: number; failedCount: number }> {
    const pending = this.listWormOutbox().filter(
      (row) => row.status !== "anchored"
    );
    let anchoredCount = 0;
    let failedCount = 0;

    for (const row of pending) {
      await faultInjector?.("B8_BEFORE_WORM_OUTBOX_SEND");

      const nowIso = new Date().toISOString();
      this.#db
        .prepare(
          `UPDATE black_box_worm_outbox
           SET status = 'sending', attempt_count = attempt_count + 1, updated_at = ?
           WHERE seq = ?`
        )
        .run(nowIso, row.seq);

      try {
        await faultInjector?.("B9_DURING_WORM_SINK_PUT");

        const eventRow = this.#db
          .prepare(
            `SELECT producer_key, fingerprint, observer_key_id FROM black_box_events WHERE seq = ?`
          )
          .get(row.seq) as
          | {
              producer_key: string;
              fingerprint: string;
              observer_key_id: string | null;
            }
          | undefined;
        if (!eventRow) {
          throw new Error(`missing black_box_events row for seq ${row.seq}`);
        }

        const receipt = JSON.parse(row.receiptJson) as JcKernelWitnessReceipt;
        const recorderEvent = JSON.parse(row.eventJson) as RecorderEvent;
        const keyId = eventRow.observer_key_id ?? receipt.signingKeyId;
        const keyRecord = keyRegistry.get(keyId);

        const envelope: WormReceiptEnvelope = {
          schema: "acs.black-box.worm-envelope.v1",
          seq: row.seq,
          eventId: row.eventId,
          previousHash: row.previousHash,
          eventHash: row.eventHash,
          payloadSha256: recorderEvent.evidence.payloadSha256,
          evidenceHash: row.evidenceHash,
          receiptSchema: receipt.schemaVersion,
          receipt,
          recorderEvent,
          producerKey: eventRow.producer_key,
          fingerprint: eventRow.fingerprint,
          observerKeyId: keyId,
          observerPublicKeyPem: keyRecord?.publicKeyPem,
          anchoredAt: row.createdAt
        };

        const putRes = await sink.putReceiptEnvelope(envelope);
        const headAnchor: WormChainHeadAnchor = {
          schema: "acs.black-box.worm-head.v1",
          seq: row.seq,
          headHash: row.eventHash,
          evidenceHash: row.evidenceHash,
          anchoredAt: row.createdAt
        };
        await sink.putChainHeadAnchor(headAnchor);

        await faultInjector?.(
          "B10_AFTER_WORM_PUT_BEFORE_OUTBOX_MARK_ANCHORED"
        );

        const anchoredAt = new Date().toISOString();
        this.#db
          .prepare(
            `UPDATE black_box_worm_outbox
             SET status = 'anchored',
                 worm_provider = ?,
                 worm_object_key = ?,
                 worm_version_id = ?,
                 worm_etag_sha256 = ?,
                 retention_mode = ?,
                 retain_until = ?,
                 last_error = NULL,
                 anchored_at = ?,
                 updated_at = ?
             WHERE seq = ?`
          )
          .run(
            sink.providerId,
            putRes.objectKey,
            putRes.versionId,
            putRes.etagSha256,
            putRes.retentionMode,
            putRes.retainUntilIso,
            anchoredAt,
            anchoredAt,
            row.seq
          );
        anchoredCount += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.#db
          .prepare(
            `UPDATE black_box_worm_outbox
             SET status = 'failed', last_error = ?, updated_at = ?
             WHERE seq = ?`
          )
          .run(message, new Date().toISOString(), row.seq);
        failedCount += 1;
        throw err;
      }
    }

    return { anchoredCount, failedCount };
  }

  /**
   * Reconstructs the local SQLite Black Box tables and in-memory RecorderStore
   * from an independent off-host WORM sink after local DB loss.
   */
  async reconstructFromWormSink(
    sink: WormEvidenceSink,
    keyRegistry: ObserverKeyRegistry,
    recorderStore: RecorderStore,
    seenEvidenceHashes: Set<string>
  ): Promise<{
    reconstructedCount: number;
    headSeq: number;
    headHash: string;
    integrityReport: WormIntegrityReport;
  }> {
    const integrityReport = await sink.verifySinkIntegrity(keyRegistry);
    if (!integrityReport.valid) {
      throw new Error(
        `WORM sink integrity verification failed: ${integrityReport.findings.map((f) => f.detail).join("; ")}`
      );
    }

    const envelopes = await sink.listReceiptEnvelopes();
    const existingSeqs = new Set(
      this.loadEvents().map((r) => r.event.evidence.seq)
    );

    let reconstructedCount = 0;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const env of envelopes) {
        if (
          env.observerPublicKeyPem &&
          !keyRegistry.get(env.observerKeyId)
        ) {
          const rec = await keyRegistry.registerKey({
            keyId: env.observerKeyId,
            observerId: env.receipt.observerId,
            publicKeyPem: env.observerPublicKeyPem,
            registeredAt: "1970-01-01T00:00:00.000Z",
            registeredBy: "worm-recovery"
          });
          this.upsertObserverKey(rec);
        }

        if (existingSeqs.has(env.seq)) continue;

        const chainState = this.loadChainState();
        if (
          env.seq !== chainState.seq + 1 ||
          env.previousHash !== chainState.headHash
        ) {
          throw new Error(
            `WORM reconstruction sequence mismatch at seq ${env.seq}`
          );
        }

        const observed =
          env.recorderEvent.eventType === "witness.observation.verified" &&
          env.recorderEvent.trustLevel === "independently_verified";

        const auditEvent = this.#appendAuditEventInTx({
          name: observed
            ? "black_box.witness_observed"
            : "black_box.witness_incomplete",
          attributes: {
            "work_item.id": env.receipt.workItemId,
            "witness.attempt_id": env.receipt.attemptId,
            "witness.lease_id": env.receipt.leaseId,
            "witness.evidence_hash": env.evidenceHash,
            "witness.observed": observed,
            "black_box.actor": "worm-recovery"
          },
          body: {
            schemaVersion: env.receipt.schemaVersion,
            observerId: env.receipt.observerId,
            observerMode: env.receipt.observerMode,
            status: env.receipt.status,
            cgroupId: env.receipt.cgroupId,
            droppedEvents: env.receipt.droppedEvents,
            sequenceGaps: env.receipt.sequenceGaps,
            evidenceHash: env.evidenceHash,
            previousEvidenceHash: env.receipt.previousEvidenceHash,
            acsAnchorRef: env.receipt.acsAnchorRef
          }
        });

        const receiptJson = canonicalJson(env.receipt);
        const eventJson = JSON.stringify(env.recorderEvent);
        const observationScopeJson = isJcKernelWitnessReceiptV2(env.receipt)
          ? canonicalJson(env.receipt.observationScope)
          : null;
        const categoryCompletenessJson = isJcKernelWitnessReceiptV2(env.receipt)
          ? canonicalJson(env.receipt.categoryCompleteness)
          : null;

        this.#db
          .prepare(
            `INSERT INTO black_box_events (
              seq, event_id, producer_key, run_id, mission_id, correlation_id,
              event_type, trust_level, evidence_hash, payload_sha256, previous_hash,
              event_hash, event_json, fingerprint, audit_event_id, audit_event_hash, ingested_at,
              receipt_schema, receipt_json, receipt_signature, observer_key_id,
              work_item_id, attempt_id, lease_id, invocation_hash,
              observation_scope_json, category_completeness_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            env.seq,
            env.eventId,
            env.producerKey,
            env.recorderEvent.runId,
            env.recorderEvent.missionId,
            env.recorderEvent.correlationId,
            env.recorderEvent.eventType,
            env.recorderEvent.trustLevel,
            env.evidenceHash,
            env.payloadSha256,
            env.previousHash,
            env.eventHash,
            eventJson,
            env.fingerprint,
            auditEvent.id,
            auditEvent.eventHash,
            env.recorderEvent.ingestedAt,
            env.receiptSchema,
            receiptJson,
            env.receipt.signature,
            env.observerKeyId,
            env.receipt.workItemId,
            env.receipt.attemptId,
            env.receipt.leaseId,
            env.receipt.invocationHash,
            observationScopeJson,
            categoryCompletenessJson
          );

        this.#db
          .prepare(
            `UPDATE black_box_chain_state
             SET seq = ?, head_hash = ?, updated_at = ?
             WHERE id = 1 AND seq = ? AND head_hash = ?`
          )
          .run(
            env.seq,
            env.eventHash,
            env.anchoredAt,
            chainState.seq,
            chainState.headHash
          );

        this.#db
          .prepare(
            `INSERT INTO black_box_worm_outbox (
              seq, event_id, evidence_hash, event_hash, previous_hash,
              receipt_json, event_json, audit_event_id, audit_event_hash,
              idempotency_key, status, worm_provider, worm_object_key,
              worm_version_id, worm_etag_sha256, retention_mode, retain_until,
              attempt_count, created_at, updated_at, anchored_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'anchored', ?, ?, ?, ?, 'FS_IMMUTABLE', ?, 1, ?, ?, ?)`
          )
          .run(
            env.seq,
            env.eventId,
            env.evidenceHash,
            env.eventHash,
            env.previousHash,
            receiptJson,
            eventJson,
            auditEvent.id,
            auditEvent.eventHash,
            sink.providerId,
            `receipts/seq-${String(env.seq).padStart(8, "0")}-${env.eventId}.json`,
            `v1-${env.eventHash.slice(0, 16)}`,
            env.eventHash,
            env.anchoredAt,
            env.anchoredAt,
            env.anchoredAt,
            env.anchoredAt
          );

        reconstructedCount += 1;
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw error;
    }

    this.syncPendingFromDatabase(recorderStore, seenEvidenceHashes);
    const allEvents = this.loadEvents().map((r) => r.event);
    const chainCheck = await verifyRecorderChain(allEvents);
    if (!chainCheck.valid) {
      throw new Error(
        `Reconstructed chain failed verification: ${chainCheck.findings.map((f) => f.detail).join("; ")}`
      );
    }

    return {
      reconstructedCount,
      headSeq: chainCheck.eventCount,
      headHash: chainCheck.headHash,
      integrityReport
    };
  }
}
