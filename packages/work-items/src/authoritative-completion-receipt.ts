import type { DatabaseSync } from "node:sqlite";
import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import { z } from "zod";
import { readVerifiedChangeSetAuthorityEvent } from "./change-set-approval-store.js";
import { changeSetOperationVerification } from "./change-set-operation-permit.js";
import { executionActionHash } from "./work-item.js";
import type { ChangeSetRecord } from "./change-set.js";
import type { ChangeSetProgress } from "./change-set-progress.js";
import type { WorkItemStore } from "./store.js";

/**
 * These receipts are assembled by ACS from its authoritative, persisted
 * execution evidence, inside the same write transaction as mission completion.
 * They are NOT caller-supplied attestations and cannot grant authority.
 * "acceptedResultReadbackHash" binds the durable ACS result projection; it
 * does NOT claim to be a fresh filesystem or production-state readback.
 */
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z.string().min(1).max(256);
export const authoritativeOperationReceiptCoreSchema = z
  .object({
    schemaVersion: z.literal("acs.change-set.operation-receipt.v1"),
    missionId: id,
    changeSetManifestHash: hash,
    operationId: id,
    permitId: id,
    permitHash: hash,
    permitAuditEventHash: hash,
    workItemId: id,
    attemptId: id,
    workerId: id,
    leaseId: id,
    actionHash: hash,
    resultId: id,
    resultPayloadHash: hash,
    resultAuditEventHash: hash,
    acceptedResultReadbackHash: hash,
    evidenceManifestHash: hash.optional(),
    verificationAuditEventHash: hash.optional()
  })
  .strict();
export const authoritativeOperationReceiptSchema = authoritativeOperationReceiptCoreSchema
  .extend({ receiptHash: hash })
  .strict();
export type AuthoritativeOperationReceipt = z.infer<typeof authoritativeOperationReceiptSchema>;

export function authoritativeOperationReceiptHash(
  core: z.infer<typeof authoritativeOperationReceiptCoreSchema>
): string {
  return stableHash({ domain: "acs.change-set.operation-receipt.v1", core });
}
export function authoritativeReceiptBundleHash(receipts: readonly AuthoritativeOperationReceipt[]): string {
  return stableHash({ domain: "acs.change-set.receipt-bundle.v1", receipts });
}

function invalid(): never {
  throw new ControlStackError(
    "change_set_receipt_integrity_mismatch",
    "authoritative completion evidence is missing or inconsistent"
  );
}
function auditHash(db: DatabaseSync, eventId: string, name: string): string {
  const row = db.prepare("SELECT event_hash FROM audit_events WHERE id = ?").get(eventId) as
    { event_hash: string } | undefined;
  if (!row || !hash.safeParse(row.event_hash).success) invalid();
  const event = readVerifiedChangeSetAuthorityEvent(db, eventId);
  if (event.name !== name) invalid();
  return row.event_hash;
}

/**
 * Produce per-operation receipts only from persisted ACS truth.
 * readChangeSetProgress has already independently checked child result
 * acceptance, result payload hashes, consumed leases, fencing, verified
 * reviews, audit event contents, and policy requirements. This function
 * binds their identity and rechecks ledger integrity atomically at completion.
 */
export function buildAuthoritativeCompletionReceipts(
  db: DatabaseSync,
  store: WorkItemStore,
  record: ChangeSetRecord,
  progress: ChangeSetProgress
): AuthoritativeOperationReceipt[] {
  const chain = store.verifyAuditChain();
  if (!chain.ok) invalid();
  if (
    progress.missionId !== record.snapshot.definition.missionId ||
    progress.manifestHash !== record.manifestHash ||
    progress.operations.length !== record.snapshot.definition.operations.length
  )
    invalid();

  const receipts = progress.operations.map((operation) => {
    if (
      operation.status !== "succeeded" ||
      !operation.permitId ||
      !operation.permitHash ||
      !operation.executionWorkItemId ||
      !operation.attemptId ||
      !operation.resultId ||
      !operation.resultPayloadHash ||
      !operation.resultAuditEventId
    )
      invalid();
    const permit = store.getChangeSetOperationPermit(operation.permitId);
    const child = store.get(operation.executionWorkItemId);
    const attempt = store.getAttempt(operation.attemptId);
    const result = store.getExecutionResult(operation.resultId);
    if (
      !permit ||
      !child ||
      !attempt ||
      !result ||
      permit.missionId !== progress.missionId ||
      permit.manifestHash !== progress.manifestHash ||
      permit.operationId !== operation.operationId ||
      permit.permitHash !== operation.permitHash ||
      permit.executionWorkItemId !== child.id ||
      permit.workerId !== result.workerId ||
      attempt.workItemId !== child.id ||
      attempt.attemptId !== operation.attemptId ||
      attempt.status !== "succeeded" ||
      attempt.claimedByWorkerId !== result.workerId ||
      result.workItemId !== child.id ||
      result.outcome !== "succeeded" ||
      result.actionHash !== executionActionHash(child) ||
      result.resultId !== operation.resultId ||
      result.payloadHash !== operation.resultPayloadHash ||
      child.result?.resultId !== result.resultId ||
      child.result.payloadHash !== result.payloadHash ||
      child.status !== "succeeded"
    )
      invalid();
    const resultEvent = readVerifiedChangeSetAuthorityEvent(db, operation.resultAuditEventId);
    if (
      resultEvent.body.attemptId !== attempt.attemptId ||
      resultEvent.body.workItemId !== child.id ||
      resultEvent.body.leaseId !== result.leaseId ||
      resultEvent.body.workerId !== result.workerId ||
      resultEvent.body.payloadHash !== result.payloadHash ||
      resultEvent.body.outcome !== "succeeded"
    )
      invalid();
    const required = changeSetOperationVerification(record, operation.operationId);
    let verificationAuditEventHash: string | undefined;
    if (required) {
      if (!operation.evidenceManifestHash) invalid();
      const decision = store.getVerificationDecision(attempt.attemptId);
      if (
        !decision ||
        decision.outcome !== "attempt_accepted" ||
        decision.evidenceManifestHash !== operation.evidenceManifestHash
      )
        invalid();
      const decisionRow = db
        .prepare(
          "SELECT id FROM audit_events WHERE name = 'verification.decision' AND json_extract(body, '$.attemptId') = ? ORDER BY sequence DESC LIMIT 1"
        )
        .get(attempt.attemptId) as { id: string } | undefined;
      if (!decisionRow) invalid();
      const event = readVerifiedChangeSetAuthorityEvent(db, decisionRow.id);
      if (
        event.body.workItemId !== child.id ||
        event.body.evidenceManifestHash !== operation.evidenceManifestHash ||
        event.body.outcome !== "attempt_accepted"
      )
        invalid();
      verificationAuditEventHash = auditHash(db, decisionRow.id, "verification.decision");
    } else if (operation.evidenceManifestHash) invalid();
    const core = authoritativeOperationReceiptCoreSchema.parse({
      schemaVersion: "acs.change-set.operation-receipt.v1",
      missionId: record.snapshot.definition.missionId,
      changeSetManifestHash: record.manifestHash,
      operationId: operation.operationId,
      permitId: permit.permitId,
      permitHash: permit.permitHash,
      permitAuditEventHash: auditHash(db, permit.auditEventId, "change_set.operation_permitted"),
      workItemId: child.id,
      attemptId: attempt.attemptId,
      workerId: result.workerId,
      leaseId: result.leaseId,
      actionHash: result.actionHash,
      resultId: result.resultId,
      resultPayloadHash: result.payloadHash,
      resultAuditEventHash: auditHash(db, operation.resultAuditEventId, "execution_attempt.result_accepted"),
      acceptedResultReadbackHash: stableHash({
        domain: "acs.change-set.accepted-result-readback.v1",
        workItemId: child.id,
        status: child.status,
        resultId: child.result.resultId,
        payloadHash: child.result.payloadHash
      }),
      ...(operation.evidenceManifestHash ? { evidenceManifestHash: operation.evidenceManifestHash } : {}),
      ...(verificationAuditEventHash ? { verificationAuditEventHash } : {})
    });
    return authoritativeOperationReceiptSchema.parse({
      ...core,
      receiptHash: authoritativeOperationReceiptHash(core)
    });
  });
  const tail = store.verifyAuditChain();
  if (!tail.ok || tail.eventCount !== chain.eventCount || tail.headHash !== chain.headHash) invalid();
  return receipts;
}
