import { domainHash } from "@agent-control-stack/shared";
import { z } from "zod";
import { evidenceManifestSchema, verifyEvidenceManifestHash } from "./evidence-manifest.js";

/**
 * Content-addressed attempt receipt. Machine facts and audit references MUST
 * come from trusted ACS state. Hash agreement alone cannot prove provenance.
 * This module cannot authorize work or transition a mission to COMPLETED.
 */
export const EXECUTION_RECEIPT_SCHEMA_VERSION = "acs.execution-receipt.v1" as const;
export const EXECUTION_RECEIPT_HASH_DOMAIN = "acs:execution-receipt:v1" as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const auditRef = z.object({ eventId: id, eventHash: hash }).strict();

export const executionReceiptCoreSchema = z.object({
  schemaVersion: z.literal(EXECUTION_RECEIPT_SCHEMA_VERSION),
  manifest: evidenceManifestSchema,
  authorization: z.object({
    actorId: id, workerId: id, attemptId: id,
    actionHash: hash, admittedPlanHash: hash, capabilityId: id,
    leaseId: id, claimTokenHash: hash,
    policyDecision: z.enum(["allow", "approved"]),
    audit: auditRef
  }).strict(),
  verification: z.object({
    verifierEngineId: id, implementerEngineId: id, verdict: z.literal("pass"),
    manifestHash: hash, criteriaPassed: z.number().int().positive().max(512),
    criteriaFailed: z.literal(0), audit: auditRef
  }).strict(),
  readback: z.object({
    resultWorkspaceRevision: z.string().min(1).max(256),
    diffHash: hash, status: z.literal("succeeded"), audit: auditRef
  }).strict()
}).strict();
export const executionReceiptSchema = executionReceiptCoreSchema.extend({ receiptHash: hash }).strict();
export type ExecutionReceipt = z.infer<typeof executionReceiptSchema>;
export type ExecutionReceiptCore = z.infer<typeof executionReceiptCoreSchema>;
export function executionReceiptHash(core: ExecutionReceiptCore): string {
  return domainHash(EXECUTION_RECEIPT_HASH_DOMAIN, core);
}

/** Fail-closed completeness checks; not an independent source attestation. */
export function receiptDefects(core: ExecutionReceiptCore): string[] {
  const { manifest: m, authorization: a, verification: v, readback: r } = core;
  const defects: string[] = [];
  if (!verifyEvidenceManifestHash(m)) defects.push("manifest_hash_invalid");
  if (m.workerId !== a.workerId) defects.push("worker_mismatch");
  if (m.attemptId !== a.attemptId) defects.push("attempt_mismatch");
  if (m.actionHash !== a.actionHash) defects.push("action_mismatch");
  if (m.admittedPlanHash !== a.admittedPlanHash) defects.push("admitted_plan_mismatch");
  if (v.manifestHash !== m.manifestHash) defects.push("verification_manifest_mismatch");
  if (v.implementerEngineId === v.verifierEngineId) defects.push("verifier_not_independent");
  if (!m.testEvidence || !m.testEvidence.passed ||
      m.testEvidence.checksPassed < 1 || m.testEvidence.checksFailed !== 0)
    defects.push("tests_not_proven");
  if (m.commands.length === 0 || m.commands.some((c) => c.exitCode !== 0))
    defects.push("command_execution_not_proven");
  if (r.resultWorkspaceRevision !== m.resultWorkspaceRevision || r.diffHash !== m.diffHash)
    defects.push("readback_mismatch");
  if (Date.parse(m.startedAt) > Date.parse(m.finishedAt)) defects.push("inverted_execution_time");
  if (new Set([a.audit.eventId, v.audit.eventId, r.audit.eventId]).size !== 3)
    defects.push("audit_event_reused");
  return defects;
}

/** Build a receipt from machine-derived evidence, never a model's narrative. */
export function buildExecutionReceipt(input: unknown): ExecutionReceipt {
  const core = executionReceiptCoreSchema.parse(input);
  const defects = receiptDefects(core);
  if (defects.length) throw new Error(`execution_receipt_incomplete: ${defects.join(",")}`);
  return executionReceiptSchema.parse({ ...core, receiptHash: executionReceiptHash(core) });
}

/**
 * Binding expectations must be obtained independently from a VERIFIED
 * canonical audit chain and current attempt/lease state. Never use values
 * copied from the receipt as their own proof.
 */
export const receiptBindingSchema = z.object({
  workItemId: id, attemptId: id, workerId: id,
  actionHash: hash, admittedPlanHash: hash,
  leaseId: id, claimTokenHash: hash, capabilityId: id,
  policyAuditEventHash: hash, verificationAuditEventHash: hash, readbackAuditEventHash: hash
}).strict();
export type ReceiptBinding = z.infer<typeof receiptBindingSchema>;

export function verifyExecutionReceipt(receipt: unknown, expected: unknown): { ok: boolean; defects: string[] } {
  const parsed = executionReceiptSchema.safeParse(receipt);
  const binding = receiptBindingSchema.safeParse(expected);
  if (!parsed.success || !binding.success) return { ok: false, defects: ["invalid_schema_or_binding"] };
  const { receiptHash, ...core } = parsed.data;
  const defects = receiptDefects(core);
  if (executionReceiptHash(core) !== receiptHash) defects.push("receipt_hash_invalid");
  const { manifest: m, authorization: a, verification: v, readback: r } = core;
  const b = binding.data;
  if (m.workItemId !== b.workItemId) defects.push("work_item_binding_mismatch");
  if (m.attemptId !== b.attemptId) defects.push("attempt_binding_mismatch");
  if (m.workerId !== b.workerId) defects.push("worker_binding_mismatch");
  if (m.actionHash !== b.actionHash) defects.push("action_binding_mismatch");
  if (m.admittedPlanHash !== b.admittedPlanHash) defects.push("plan_binding_mismatch");
  if (a.leaseId !== b.leaseId) defects.push("lease_mismatch");
  if (a.claimTokenHash !== b.claimTokenHash) defects.push("claim_mismatch");
  if (a.capabilityId !== b.capabilityId) defects.push("capability_mismatch");
  if (a.audit.eventHash !== b.policyAuditEventHash) defects.push("policy_audit_mismatch");
  if (v.audit.eventHash !== b.verificationAuditEventHash) defects.push("verification_audit_mismatch");
  if (r.audit.eventHash !== b.readbackAuditEventHash) defects.push("readback_audit_mismatch");
  return { ok: defects.length === 0, defects };
}
