import { stableHash } from "@agent-control-stack/shared";
import { z } from "zod";

const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const timestamp = z.string().datetime({ offset: true });
export const changeSetApprovalCoreSchema = z
  .object({
    schemaVersion: z.literal("acs.change-set.approval.v1"),
    approvalId: id,
    missionId: id,
    revision: z.number().int().positive(),
    manifestHash: hash,
    requestId: id,
    approvedByActorId: id,
    executingActorId: id,
    subjectInputHash: hash,
    policyHash: hash,
    policyAuditEventId: id,
    reason: z.string().min(1).max(4_000),
    createdAt: timestamp,
    expiresAt: timestamp
  })
  .strict();
export const changeSetApprovalSchema = changeSetApprovalCoreSchema
  .extend({ approvalHash: hash, auditEventId: id })
  .strict();
export const grantChangeSetApprovalSchema = z
  .object({
    missionId: id,
    expectedManifestHash: hash,
    requestId: id,
    approvedByActorId: id,
    policyHash: hash,
    policyAuditEventId: id,
    reason: z.string().min(1).max(4_000),
    expiresAt: timestamp
  })
  .strict();
export type ChangeSetApproval = z.infer<typeof changeSetApprovalSchema>;
export type GrantChangeSetApproval = z.infer<typeof grantChangeSetApprovalSchema>;
export function changeSetApprovalHash(input: unknown): string {
  return stableHash({ domain: "acs.change-set.approval.v1", record: changeSetApprovalCoreSchema.parse(input) });
}
export function changeSetPolicyHash(input: Record<string, unknown>): string {
  return stableHash({ domain: "acs.change-set.policy.v1", evaluation: input });
}
