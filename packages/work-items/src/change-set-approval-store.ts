import { readChangeSet } from "./change-set-store.js";
import type { DatabaseSync } from "node:sqlite";
import { ControlStackError, auditEventHash, auditEventSchema } from "@agent-control-stack/shared";
import {
  changeSetApprovalHash,
  changeSetApprovalSchema,
  changeSetPolicyHash,
  type ChangeSetApproval
} from "./change-set-approval.js";

export function readVerifiedChangeSetAuthorityEvent(db: DatabaseSync, id: string) {
  const row = db.prepare("SELECT * FROM audit_events WHERE id = ?").get(id) as
    | {
        id: string;
        name: string;
        time_unix_nano: string;
        attributes: string;
        body: string;
        sequence: number;
        previous_hash: string;
        event_hash: string;
      }
    | undefined;
  if (!row) throw new ControlStackError("change_set_approval_integrity_mismatch", "authority audit event missing");
  try {
    const event = auditEventSchema.parse({
      id: row.id,
      name: row.name,
      timeUnixNano: row.time_unix_nano,
      attributes: JSON.parse(row.attributes),
      body: JSON.parse(row.body)
    });
    if (auditEventHash({ ...event, sequence: row.sequence, previousHash: row.previous_hash }) !== row.event_hash)
      throw new Error("audit hash mismatch");
    return event;
  } catch {
    throw new ControlStackError("change_set_approval_integrity_mismatch", "authority audit event invalid");
  }
}

export function readChangeSetApproval(db: DatabaseSync, approvalId: string): ChangeSetApproval | undefined {
  const row = db.prepare("SELECT * FROM change_set_approvals WHERE approval_id = ?").get(approvalId) as
    | {
        approval_id: string;
        mission_id: string;
        revision: number;
        manifest_hash: string;
        request_id: string;
        record_json: string;
        approval_hash: string;
        audit_event_id: string;
      }
    | undefined;
  if (!row) return undefined;
  try {
    const record = changeSetApprovalSchema.parse(JSON.parse(row.record_json));
    const { approvalHash, auditEventId, ...core } = record;
    if (
      changeSetApprovalHash(core) !== approvalHash ||
      row.approval_hash !== approvalHash ||
      row.approval_id !== record.approvalId ||
      row.mission_id !== record.missionId ||
      row.revision !== record.revision ||
      row.manifest_hash !== record.manifestHash ||
      row.request_id !== record.requestId ||
      row.audit_event_id !== auditEventId
    )
      throw new Error("approval binding mismatch");
    const event = readVerifiedChangeSetAuthorityEvent(db, auditEventId);
    if (
      event.name !== "change_set.approved" ||
      event.body.approvalId !== approvalId ||
      event.body.approvalHash !== approvalHash ||
      event.body.manifestHash !== record.manifestHash ||
      event.body.approvedByActorId !== record.approvedByActorId ||
      event.body.missionId !== record.missionId ||
      event.body.policyHash !== record.policyHash
    )
      throw new Error("approval provenance mismatch");
    const snapshot = readChangeSet(db, record.missionId, record.revision);
    if (
      !snapshot ||
      snapshot.manifestHash !== record.manifestHash ||
      snapshot.snapshot.definition.executingActorId !== record.executingActorId ||
      snapshot.snapshot.definition.subjectInputHash !== record.subjectInputHash ||
      Date.parse(record.expiresAt) > Date.parse(snapshot.snapshot.definition.expiresAt) ||
      Date.parse(record.expiresAt) <= Date.parse(record.createdAt)
    )
      throw new Error("approved snapshot binding mismatch");
    const policy = readVerifiedChangeSetAuthorityEvent(db, record.policyAuditEventId);
    const decision = policy.body.decision as { decision?: string } | undefined;
    const operations = policy.body.operations as
      Array<{ operationId?: string; decision?: { decision?: string } }> | undefined;
    if (
      policy.name !== "change_set.policy_evaluated" ||
      policy.body.missionId !== record.missionId ||
      policy.body.manifestHash !== record.manifestHash ||
      policy.body.actorId !== record.approvedByActorId ||
      policy.body.revision !== record.revision ||
      !["allow", "require_approval"].includes(decision?.decision ?? "") ||
      !Array.isArray(operations) ||
      operations.length !== snapshot.snapshot.definition.operations.length ||
      operations.some(
        (operation, index) =>
          operation.operationId !== snapshot.snapshot.definition.operations[index]?.operationId ||
          !["allow", "require_approval"].includes(operation.decision?.decision ?? "")
      ) ||
      changeSetPolicyHash(policy.body) !== record.policyHash
    )
      throw new Error("policy provenance mismatch");
    return record;
  } catch {
    throw new ControlStackError("change_set_approval_integrity_mismatch", "approval integrity mismatch");
  }
}

export function readChangeSetApprovalByRequest(db: DatabaseSync, missionId: string, requestId: string) {
  const row = db
    .prepare("SELECT approval_id FROM change_set_approvals WHERE mission_id = ? AND request_id = ?")
    .get(missionId, requestId) as { approval_id: string } | undefined;
  return row ? readChangeSetApproval(db, row.approval_id) : undefined;
}

/** A missing projection must never resurrect a revocation retained in the audit log. */
export function readChangeSetApprovalRevocation(db: DatabaseSync, approvalId: string): boolean {
  const row = db.prepare("SELECT * FROM change_set_approval_revocations WHERE approval_id = ?").get(approvalId) as
    { approval_id: string; revoked_by_actor_id: string; reason: string; audit_event_id: string } | undefined;
  const events = db
    .prepare(
      `SELECT id FROM audit_events WHERE name = 'change_set.approval_revoked'
    AND CASE WHEN json_valid(body) THEN json_extract(body, '$.approvalId') = ? ELSE 1 END LIMIT 2`
    )
    .all(approvalId) as Array<{ id: string }>;
  if (!row && events.length === 0) return false;
  if (!row || events.length !== 1 || events[0]?.id !== row.audit_event_id)
    throw new ControlStackError("change_set_approval_integrity_mismatch", "revocation projection mismatch");
  const event = readVerifiedChangeSetAuthorityEvent(db, row.audit_event_id);
  if (
    event.name !== "change_set.approval_revoked" ||
    event.body.approvalId !== approvalId ||
    event.body.actorId !== row.revoked_by_actor_id ||
    event.body.reason !== row.reason
  )
    throw new ControlStackError("change_set_approval_integrity_mismatch", "revocation provenance mismatch");
  return true;
}
