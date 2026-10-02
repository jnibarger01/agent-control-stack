import type { DatabaseSync } from "node:sqlite";
import { ControlStackError } from "@agent-control-stack/shared";
import {
  autonomousAuthoritySchema,
  autonomousAuthorityHash,
  grantAuthorizationSchema,
  grantAuthorizationHash,
  assertChangeSetWithinGrant
} from "./autonomous-authority.js";
import { readChangeSet } from "./change-set-store.js";
import { changeSetPolicyHash } from "./change-set-approval.js";
import { readVerifiedChangeSetAuthorityEvent } from "./change-set-approval-store.js";

export function readAutonomousAuthority(db: DatabaseSync, grantId: string) {
  const row = db.prepare("SELECT * FROM autonomous_authority_grants WHERE grant_id = ?").get(grantId) as
    | {
        grant_id: string;
        mission_id: string;
        request_id: string;
        record_json: string;
        grant_hash: string;
        audit_event_id: string;
      }
    | undefined;
  if (!row) return undefined;
  try {
    const record = autonomousAuthoritySchema.parse(JSON.parse(row.record_json));
    const { grantHash, auditEventId, ...core } = record;
    if (
      autonomousAuthorityHash(core) !== grantHash ||
      row.grant_hash !== grantHash ||
      row.grant_id !== record.grantId ||
      row.mission_id !== record.missionId ||
      row.request_id !== record.requestId ||
      row.audit_event_id !== auditEventId ||
      Date.parse(record.createdAt) >= Date.parse(record.definition.expiresAt) ||
      record.issuedByActorId === record.definition.executingActorId
    )
      throw new Error("grant binding mismatch");
    const event = readVerifiedChangeSetAuthorityEvent(db, auditEventId);
    if (
      event.name !== "autonomous_authority.issued" ||
      event.body.grantId !== grantId ||
      event.body.grantHash !== grantHash ||
      event.body.missionId !== record.missionId ||
      event.body.issuedByActorId !== record.issuedByActorId ||
      event.body.executingActorId !== record.definition.executingActorId
    )
      throw new Error("grant audit mismatch");
    return record;
  } catch {
    throw new ControlStackError("autonomous_authority_integrity_mismatch", "grant integrity mismatch");
  }
}

export function readAutonomousAuthorityRevocation(db: DatabaseSync, grantId: string): boolean {
  const row = db.prepare("SELECT * FROM autonomous_authority_revocations WHERE grant_id = ?").get(grantId) as
    | {
        actor_id: string;
        reason: string;
        audit_event_id: string;
      }
    | undefined;
  const events = db
    .prepare(
      `SELECT id FROM audit_events WHERE name = 'autonomous_authority.revoked'
    AND CASE WHEN json_valid(body) THEN json_extract(body, '$.grantId') = ? ELSE 1 END LIMIT 2`
    )
    .all(grantId) as { id: string }[];
  if (!row && !events.length) return false;
  if (!row || events.length !== 1 || events[0]!.id !== row.audit_event_id)
    throw new ControlStackError("autonomous_authority_integrity_mismatch", "grant revocation projection mismatch");
  const event = readVerifiedChangeSetAuthorityEvent(db, row.audit_event_id);
  if (
    event.name !== "autonomous_authority.revoked" ||
    event.body.grantId !== grantId ||
    event.body.actorId !== row.actor_id ||
    event.body.reason !== row.reason
  )
    throw new ControlStackError("autonomous_authority_integrity_mismatch", "grant revocation provenance mismatch");
  return true;
}

export function readGrantAuthorization(db: DatabaseSync, authorizationId: string) {
  const row = db
    .prepare("SELECT * FROM change_set_grant_authorizations WHERE authorization_id = ?")
    .get(authorizationId) as
    | {
        authorization_id: string;
        grant_id: string;
        mission_id: string;
        revision: number;
        manifest_hash: string;
        record_json: string;
        authorization_hash: string;
        audit_event_id: string;
      }
    | undefined;
  if (!row) return undefined;
  try {
    const record = grantAuthorizationSchema.parse(JSON.parse(row.record_json));
    const { authorizationHash, auditEventId, ...core } = record;
    if (
      grantAuthorizationHash(core) !== authorizationHash ||
      row.authorization_hash !== authorizationHash ||
      row.authorization_id !== record.authorizationId ||
      row.grant_id !== record.grantId ||
      row.mission_id !== record.missionId ||
      row.revision !== record.revision ||
      row.manifest_hash !== record.manifestHash ||
      row.audit_event_id !== auditEventId ||
      Date.parse(record.createdAt) >= Date.parse(record.expiresAt)
    )
      throw new Error("authorization binding mismatch");
    const grant = readAutonomousAuthority(db, record.grantId);
    const snapshot = readChangeSet(db, record.missionId, record.revision);
    if (
      !grant ||
      !snapshot ||
      grant.grantHash !== record.grantHash ||
      snapshot.manifestHash !== record.manifestHash ||
      record.subjectInputHash !== snapshot.snapshot.definition.subjectInputHash ||
      record.executingActorId !== snapshot.snapshot.definition.executingActorId ||
      Date.parse(record.expiresAt) >
        Math.min(Date.parse(grant.definition.expiresAt), Date.parse(snapshot.snapshot.definition.expiresAt))
    )
      throw new Error("authorization scope binding mismatch");
    assertChangeSetWithinGrant(grant, snapshot);
    const event = readVerifiedChangeSetAuthorityEvent(db, auditEventId);
    if (
      event.name !== "change_set.grant_authorized" ||
      event.body.bindingId !== authorizationId ||
      event.body.bindingHash !== authorizationHash ||
      event.body.manifestHash !== record.manifestHash ||
      event.body.grantId !== grant.grantId ||
      event.body.grantHash !== grant.grantHash ||
      event.body.policyHash !== record.policyHash
    )
      throw new Error("authorization provenance mismatch");
    assertGrantPolicy(db, record.policyAuditEventId, record.policyHash, snapshot, record.executingActorId);
    return record;
  } catch {
    throw new ControlStackError("grant_authorization_integrity_mismatch", "grant authorization integrity mismatch");
  }
}

export function assertGrantPolicy(
  db: DatabaseSync,
  policyEventId: string,
  policyHash: string,
  snapshot: NonNullable<ReturnType<typeof readChangeSet>>,
  actorId: string
): void {
  const policy = readVerifiedChangeSetAuthorityEvent(db, policyEventId);
  const decision = policy.body.decision as { decision?: string } | undefined;
  const operations = policy.body.operations as { operationId?: string; decision?: { decision?: string } }[] | undefined;
  if (
    policy.name !== "change_set.policy_evaluated" ||
    changeSetPolicyHash(policy.body) !== policyHash ||
    policy.body.missionId !== snapshot.snapshot.definition.missionId ||
    policy.body.manifestHash !== snapshot.manifestHash ||
    policy.body.revision !== snapshot.snapshot.revision ||
    policy.body.actorId !== actorId ||
    !["allow", "require_approval"].includes(decision?.decision ?? "") ||
    !Array.isArray(operations) ||
    operations.length !== snapshot.snapshot.definition.operations.length ||
    operations.some(
      (operation, index) =>
        operation.operationId !== snapshot.snapshot.definition.operations[index]?.operationId ||
        !["allow", "require_approval"].includes(operation.decision?.decision ?? "")
    )
  )
    throw new ControlStackError(
      "grant_authorization_policy_mismatch",
      "grant authorization needs bound deterministic policy"
    );
}
