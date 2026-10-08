import { describe, expect, it } from "vitest";
import { buildEvidenceManifest, type BuildEvidenceManifestInput } from "./evidence-manifest.js";
import {
  buildExecutionReceipt, verifyExecutionReceipt, receiptDefects,
  type ExecutionReceiptCore, type ReceiptBinding
} from "./execution-receipt.js";

const H = (c: string) => c.repeat(64);
const manifestInput: BuildEvidenceManifestInput = {
  attemptId: "attempt_1", workItemId: "work_1", workerId: "worker_1",
  admittedPlanHash: H("a"), planHash: H("b"), actionHash: H("c"),
  baseWorkspaceRevision: H("d"), resultWorkspaceRevision: H("e"),
  changedPaths: ["src/fix.ts"], diffHash: H("f"),
  commands: [{ executable: "node", argvHash: H("1"), exitCode: 0,
    stdoutHash: H("2"), stderrHash: H("3"), durationMs: 10 }],
  testEvidence: { validationRunId: "test_1", passed: true, checksPassed: 10, checksFailed: 0 },
  sandboxProfile: "desktop_commander", networkProfile: "none",
  networkDecisions: { allowed: 0, denied: 0 }, observations: [],
  startedAt: "2026-10-08T12:00:00Z", finishedAt: "2026-10-08T12:01:00Z"
};
const core = (): ExecutionReceiptCore => {
  const manifest = buildEvidenceManifest(manifestInput);
  return {
    schemaVersion: "acs.execution-receipt.v1", manifest,
    authorization: {
      actorId: "operator_1", workerId: "worker_1", attemptId: "attempt_1",
      actionHash: H("c"), admittedPlanHash: H("a"), capabilityId: "cap_1",
      leaseId: "lease_1", claimTokenHash: H("4"), policyDecision: "approved",
      audit: { eventId: "auth_1", eventHash: H("5") }
    },
    verification: {
      implementerEngineId: "codex", verifierEngineId: "claude",
      verdict: "pass", manifestHash: manifest.manifestHash,
      criteriaPassed: 3, criteriaFailed: 0,
      audit: { eventId: "verify_1", eventHash: H("6") }
    },
    readback: {
      resultWorkspaceRevision: H("e"), diffHash: H("f"), status: "succeeded",
      audit: { eventId: "readback_1", eventHash: H("7") }
    }
  };
};
const expected = (): ReceiptBinding => ({
  workItemId: "work_1", attemptId: "attempt_1", workerId: "worker_1",
  actionHash: H("c"), admittedPlanHash: H("a"), leaseId: "lease_1",
  claimTokenHash: H("4"), capabilityId: "cap_1", policyAuditEventHash: H("5"),
  verificationAuditEventHash: H("6"), readbackAuditEventHash: H("7")
});
describe("proof-of-execution receipt integrity", () => {
  it("builds content-addressed receipts and verifies expected bindings", () => {
    const receipt = buildExecutionReceipt(core());
    expect(receipt.receiptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyExecutionReceipt(receipt, expected())).toEqual({ ok: true, defects: [] });
  });
  it.each([
    ["worker", (v: ExecutionReceiptCore) => { v.authorization.workerId = "other"; }, "worker_mismatch"],
    ["attempt", (v: ExecutionReceiptCore) => { v.authorization.attemptId = "other"; }, "attempt_mismatch"],
    ["action", (v: ExecutionReceiptCore) => { v.authorization.actionHash = H("9"); }, "action_mismatch"],
    ["plan", (v: ExecutionReceiptCore) => { v.authorization.admittedPlanHash = H("9"); }, "admitted_plan_mismatch"],
    ["verifier", (v: ExecutionReceiptCore) => { v.verification.verifierEngineId = "codex"; }, "verifier_not_independent"],
    ["stale evidence", (v: ExecutionReceiptCore) => { v.verification.manifestHash = H("9"); }, "verification_manifest_mismatch"],
    ["no tests", (v: ExecutionReceiptCore) => { v.manifest.testEvidence = null; }, "tests_not_proven"],
    ["failed command", (v: ExecutionReceiptCore) => { v.manifest.commands[0]!.exitCode = 1; }, "command_execution_not_proven"],
    ["unknown outcome", (v: ExecutionReceiptCore) => { v.manifest.commands[0]!.exitCode = null; }, "command_execution_not_proven"],
    ["wrong final readback", (v: ExecutionReceiptCore) => { v.readback.diffHash = H("9"); }, "readback_mismatch"],
    ["reused audit id", (v: ExecutionReceiptCore) => { v.readback.audit.eventId = "auth_1"; }, "audit_event_reused"],
    ["clock inversion", (v: ExecutionReceiptCore) => { v.manifest.startedAt = "2026-10-08T13:00:00Z"; }, "inverted_execution_time"]
  ])("rejects %s", (_label, change, code) => {
    const value = core();
    change(value);
    expect(receiptDefects(value)).toContain(code);
    expect(() => buildExecutionReceipt(value)).toThrow("execution_receipt_incomplete");
  });
  it("rejects tampered receipt body", () => {
    const receipt = buildExecutionReceipt(core());
    expect(verifyExecutionReceipt({
      ...receipt, authorization: { ...receipt.authorization, actorId: "other" }
    }, expected()).defects).toContain("receipt_hash_invalid");
  });
  it.each([
    ["leaseId", "different"], ["claimTokenHash", H("8")], ["capabilityId", "different"],
    ["workItemId", "different"], ["attemptId", "different"], ["workerId", "different"],
    ["policyAuditEventHash", H("8")], ["verificationAuditEventHash", H("8")],
    ["readbackAuditEventHash", H("8")]
  ] as const)("rejects reuse against different %s", (field, value) => {
    expect(verifyExecutionReceipt(buildExecutionReceipt(core()), { ...expected(), [field]: value }).ok)
      .toBe(false);
  });
  it("rejects untrusted approval claims and unknown fields", () => {
    const receipt = buildExecutionReceipt(core());
    expect(verifyExecutionReceipt({ ...receipt, modelClaimsApproved: true }, expected()).ok).toBe(false);
    expect(verifyExecutionReceipt(receipt, { ...expected(), bypass: true }).ok).toBe(false);
  });
});
