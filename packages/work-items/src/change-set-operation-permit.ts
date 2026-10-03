import { submitWorkResultSchema } from "./work-item.js";
import type { ChangeSetRecord } from "./change-set.js";
import type { DatabaseSync } from "node:sqlite";
import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import { z } from "zod";
import { readVerifiedChangeSetAuthorityEvent } from "./change-set-approval-store.js";

const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const changeSetOperationPermitCoreSchema = z
  .object({
    schemaVersion: z.enum(["acs.change-set.operation-permit.v1", "acs.change-set.operation-permit.v2"]),
    permitId: id,
    missionId: id,
    revision: z.number().int().positive(),
    manifestHash: hash,
    operationId: id,
    approvalId: id.optional(),
    authorizationId: id.optional(),
    policyHash: hash,
    executionWorkItemId: id,
    executionInputHash: hash,
    executingActorId: id,
    workerId: id,
    runtime: z.enum(["desktop_commander", "jace_commander"]),
    toolName: id,
    invocationHash: hash,
    createdAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true })
  })
  .strict()
  .refine(
    (value) =>
      value.schemaVersion === "acs.change-set.operation-permit.v1"
        ? value.approvalId !== undefined && value.authorizationId === undefined
        : value.authorizationId !== undefined && value.approvalId === undefined,
    "exactly one version-bound authority is required"
  );
export const changeSetOperationPermitSchema = changeSetOperationPermitCoreSchema
  .safeExtend({
    permitHash: hash,
    auditEventId: id
  })
  .strict();
export type ChangeSetOperationPermit = z.infer<typeof changeSetOperationPermitSchema>;
export type BindChangeSetOperationPermit = Pick<
  ChangeSetOperationPermit,
  | "missionId"
  | "manifestHash"
  | "operationId"
  | "approvalId"
  | "authorizationId"
  | "policyHash"
  | "executionWorkItemId"
  | "workerId"
  | "runtime"
  | "toolName"
  | "invocationHash"
>;
export function changeSetOperationPermitHash(input: unknown): string {
  return stableHash({
    domain: "acs.change-set.operation-permit.v1",
    record: changeSetOperationPermitCoreSchema.parse(input)
  });
}
export function readChangeSetOperationPermit(db: DatabaseSync, permitId: string): ChangeSetOperationPermit | undefined {
  const row = db.prepare("SELECT * FROM change_set_operation_permits WHERE permit_id = ?").get(permitId) as
    | {
        permit_id: string;
        mission_id: string;
        revision: number;
        manifest_hash: string;
        operation_id: string;
        approval_id: string | null;
        authorization_id: string | null;
        execution_work_item_id: string;
        record_json: string;
        permit_hash: string;
        audit_event_id: string;
      }
    | undefined;
  if (!row) return undefined;
  try {
    const record = changeSetOperationPermitSchema.parse(JSON.parse(row.record_json));
    const { permitHash, auditEventId, ...core } = record;
    if (
      changeSetOperationPermitHash(core) !== permitHash ||
      row.permit_hash !== permitHash ||
      row.permit_id !== record.permitId ||
      row.mission_id !== record.missionId ||
      row.revision !== record.revision ||
      row.manifest_hash !== record.manifestHash ||
      row.operation_id !== record.operationId ||
      (row.approval_id ?? undefined) !== record.approvalId ||
      (row.authorization_id ?? undefined) !== record.authorizationId ||
      row.execution_work_item_id !== record.executionWorkItemId ||
      row.audit_event_id !== auditEventId ||
      Date.parse(record.expiresAt) <= Date.parse(record.createdAt)
    )
      throw new Error("permit binding mismatch");
    const event = readVerifiedChangeSetAuthorityEvent(db, auditEventId);
    if (
      event.name !== "change_set.operation_permitted" ||
      event.body.permitId !== permitId ||
      event.body.permitHash !== permitHash ||
      event.body.executionWorkItemId !== record.executionWorkItemId ||
      event.body.missionId !== record.missionId ||
      event.body.manifestHash !== record.manifestHash ||
      event.body.operationId !== record.operationId ||
      event.body.approvalId !== record.approvalId ||
      event.body.bindingId !== record.authorizationId
    )
      throw new Error("permit audit mismatch");
    return record;
  } catch {
    throw new ControlStackError("change_set_permit_integrity_mismatch", "operation permit integrity mismatch");
  }
}

export const CHANGE_SET_VERIFICATION_POLICY = "acs.change-set.verification.v2";
export function changeSetOperationVerification(record: ChangeSetRecord, operationId: string) {
  const operation = record.snapshot.definition.operations.find((op) => op.operationId === operationId);
  if (!operation) throw new ControlStackError("change_set_operation_not_found", "operation missing");
  const requirements = record.snapshot.definition.verification.filter((rule) =>
    rule.operationIds.includes(operationId)
  );
  if (operation.effect === "read_only" && requirements.length === 0) return undefined;
  return {
    policyVersion: CHANGE_SET_VERIFICATION_POLICY,
    reviewersRequired: Math.max(
      operation.effect === "read_only" ? 0 : 1,
      requirements.filter((rule) => rule.kind === "independent_review").length
    ),
    requirement: {
      schemaVersion: CHANGE_SET_VERIFICATION_POLICY,
      missionId: record.snapshot.definition.missionId,
      manifestHash: record.manifestHash,
      operationId,
      requirements
    }
  };
}
export function changeSetResultSubmissionHash(input: unknown): string {
  return stableHash({ domain: "acs.change-set.result-submission.v1", result: submitWorkResultSchema.parse(input) });
}
