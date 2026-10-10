import { ControlStackError } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import { buildEvidenceManifest, type BuildEvidenceManifestInput } from "./evidence-manifest.js";
import {
  buildExecutionReceipt,
  verifyExecutionReceipt,
  receiptDefects,
  ExecutionReceiptIncompleteError,
  type ExecutionReceiptCore,
  type ReceiptBinding
} from "./execution-receipt.js";

const H = (c: string) => c.repeat(64);
const manifestInput: BuildEvidenceManifestInput = {
  attemptId: "attempt_1",
  workItemId: "work_1",
  workerId: "worker_1",
  admittedPlanHash: H("a"),
  planHash: H("b"),
  actionHash: H("c"),
  baseWorkspaceRevision: H("d"),
  resultWorkspaceRevision: H("e"),
  changedPaths: ["src/fix.ts"],
  diffHash: H("f"),
  commands: [
    { executable: "node", argvHash: H("1"), exitCode: 0, stdoutHash: H("2"), stderrHash: H("3"), durationMs: 10 }
  ],
  testEvidence: { validationRunId: "test_1", passed: true, checksPassed: 10, checksFailed: 0 },
  sandboxProfile: "desktop_commander",
  networkProfile: "none",
  networkDecisions: { allowed: 0, denied: 0 },
  observations: [],
  startedAt: "2026-10-08T12:00:00Z",
  finishedAt: "2026-10-08T12:01:00Z"
};
const approval = {
  approvalId: "approval_1",
  requestHash: H("8"),
  grantHash: H("9"),
  approverActorId: "approver_1",
  grantedAt: "2026-10-08T11:00:00Z",
  expiresAt: "2026-10-08T13:00:00Z",
  consumedAt: "2026-10-08T11:30:00Z",
  audit: { eventId: "approval_event_1", eventHash: H("d") }
};
const reviewers = [
  {
    reviewerPrincipalId: "reviewer_a",
    verifierEngineId: "claude",
    verifierProviderId: "anthropic",
    verdict: "pass" as const,
    audit: { eventId: "review_1", eventHash: H("0") }
  },
  {
    reviewerPrincipalId: "reviewer_b",
    verifierEngineId: "gemini",
    verifierProviderId: "google",
    verdict: "pass" as const,
    audit: { eventId: "review_2", eventHash: H("2") }
  }
];
const copyReviewers = (list: typeof reviewers) => list.map((reviewer) => ({ ...reviewer, audit: { ...reviewer.audit } }));

/** A sensitive attempt: approval required, and two independent reviewers (high-risk requirement). */
const core = (): ExecutionReceiptCore => {
  const manifest = buildEvidenceManifest(manifestInput);
  return {
    schemaVersion: "acs.execution-receipt.v1",
    manifest,
    authorization: {
      actorId: "operator_1",
      workerId: "worker_1",
      attemptId: "attempt_1",
      actionHash: H("c"),
      admittedPlanHash: H("a"),
      capabilityId: "cap_1",
      leaseId: "lease_1",
      claimTokenHash: H("4"),
      policyDecision: "require_approval",
      approval: { ...approval, audit: { ...approval.audit } },
      audit: { eventId: "auth_1", eventHash: H("5") }
    },
    verification: {
      implementerPrincipalId: "executor_1",
      implementerEngineId: "codex",
      implementerProviderId: "openai",
      reviewers: copyReviewers(reviewers),
      verdict: "pass",
      manifestHash: manifest.manifestHash,
      criteriaPassed: 3,
      criteriaFailed: 0,
      audit: { eventId: "verify_1", eventHash: H("6") }
    },
    readback: {
      resultWorkspaceRevision: H("e"),
      diffHash: H("f"),
      status: "succeeded",
      audit: { eventId: "readback_1", eventHash: H("7") }
    }
  };
};
/** The canonical binding a verifier derives from the audit chain and the verification requirement. */
const expected = (): ReceiptBinding => ({
  workItemId: "work_1",
  attemptId: "attempt_1",
  workerId: "worker_1",
  actorId: "operator_1",
  actionHash: H("c"),
  admittedPlanHash: H("a"),
  manifestHash: buildEvidenceManifest(manifestInput).manifestHash,
  validationRunId: "test_1",
  leaseId: "lease_1",
  claimTokenHash: H("4"),
  capabilityId: "cap_1",
  policyDecision: "require_approval",
  approval: { ...approval, audit: { ...approval.audit } },
  policyAudit: { eventId: "auth_1", eventHash: H("5") },
  implementerPrincipalId: "executor_1",
  implementerEngineId: "codex",
  implementerProviderId: "openai",
  reviewers: copyReviewers(reviewers),
  reviewersRequired: 2,
  requireIndependentPrincipal: true,
  requireIndependentProvider: true,
  criteriaPassed: 3,
  verificationAudit: { eventId: "verify_1", eventHash: H("6") },
  readbackAudit: { eventId: "readback_1", eventHash: H("7") }
});

describe("proof-of-execution receipt integrity", () => {
  it("builds content-addressed receipts and verifies expected bindings", () => {
    const receipt = buildExecutionReceipt(core());
    expect(receipt.receiptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyExecutionReceipt(receipt, expected())).toEqual({ ok: true, defects: [] });
  });

  it.each([
    ["worker", (c: ExecutionReceiptCore) => { c.authorization.workerId = "other"; }, "worker_mismatch"],
    ["attempt", (c: ExecutionReceiptCore) => { c.authorization.attemptId = "other"; }, "attempt_mismatch"],
    ["action", (c: ExecutionReceiptCore) => { c.authorization.actionHash = H("9"); }, "action_mismatch"],
    ["plan", (c: ExecutionReceiptCore) => { c.authorization.admittedPlanHash = H("9"); }, "admitted_plan_mismatch"],
    ["stale evidence", (c: ExecutionReceiptCore) => { c.verification.manifestHash = H("9"); }, "verification_manifest_mismatch"],
    ["no tests", (c: ExecutionReceiptCore) => { c.manifest.testEvidence = null; }, "tests_not_proven"],
    ["failed command", (c: ExecutionReceiptCore) => { c.manifest.commands[0]!.exitCode = 1; }, "command_execution_not_proven"],
    ["unknown outcome", (c: ExecutionReceiptCore) => { c.manifest.commands[0]!.exitCode = null as unknown as number; }, "command_execution_not_proven"],
    ["wrong final readback", (c: ExecutionReceiptCore) => { c.readback.diffHash = H("9"); }, "readback_mismatch"],
    ["reused audit id", (c: ExecutionReceiptCore) => { c.readback.audit.eventId = c.authorization.audit.eventId; }, "audit_event_reused"],
    ["inverted time", (c: ExecutionReceiptCore) => { c.manifest.startedAt = "2026-10-08T12:02:00Z"; }, "inverted_execution_time"],
    ["reviewer is implementer principal", (c: ExecutionReceiptCore) => { c.verification.reviewers[0]!.reviewerPrincipalId = "executor_1"; }, "verifier_not_independent"],
    ["duplicate reviewer principal", (c: ExecutionReceiptCore) => { c.verification.reviewers[1]!.reviewerPrincipalId = "reviewer_a"; }, "reviewer_not_distinct"],
    ["validation run missing", (c: ExecutionReceiptCore) => { c.manifest.testEvidence!.validationRunId = undefined; }, "validation_run_missing"]
  ] as const)("rejects an internally inconsistent receipt: %s", (_name, mutate, defect) => {
    const changed = core();
    mutate(changed);
    expect(receiptDefects(changed)).toContain(defect);
  });

  it("rejects tampered receipt body", () => {
    const receipt = buildExecutionReceipt(core());
    expect(
      verifyExecutionReceipt({ ...receipt, authorization: { ...receipt.authorization, actorId: "other" } }, expected()).defects
    ).toContain("receipt_hash_invalid");
  });

  it.each([
    ["leaseId", "different", "lease_mismatch"],
    ["claimTokenHash", H("8"), "claim_mismatch"],
    ["capabilityId", "different", "capability_mismatch"],
    ["workItemId", "different", "work_item_binding_mismatch"],
    ["attemptId", "different", "attempt_binding_mismatch"],
    ["workerId", "different", "worker_binding_mismatch"],
    ["manifestHash", H("8"), "manifest_binding_mismatch"],
    ["validationRunId", "other_run", "validation_run_binding_mismatch"]
  ] as const)("rejects reuse against a different canonical %s", (field, value, defect) => {
    const result = verifyExecutionReceipt(buildExecutionReceipt(core()), { ...expected(), [field]: value });
    expect(result.ok).toBe(false);
    expect(result.defects).toContain(defect);
  });

  it("rejects self-consistent forged evidence even with a recomputed receipt hash", () => {
    const changed = core();
    changed.manifest = buildEvidenceManifest({ ...manifestInput, changedPaths: ["src/forged.ts"] });
    changed.verification.manifestHash = changed.manifest.manifestHash;
    const forged = buildExecutionReceipt(changed);
    expect(forged.receiptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyExecutionReceipt(forged, expected()).defects).toContain("manifest_binding_mismatch");
  });

  it("accepts an independently valid actor identity containing email and path characters", () => {
    const valid = core();
    valid.authorization.actorId = "service-account@example.com/team/service";
    expect(buildExecutionReceipt(valid).authorization.actorId).toBe(valid.authorization.actorId);
  });

  it("accepts canonical engine identifiers containing a provider path", () => {
    const valid = core();
    valid.verification.reviewers[0]!.verifierEngineId = "anthropic/claude";
    const bound = expected();
    bound.reviewers[0]!.verifierEngineId = "anthropic/claude";
    expect(verifyExecutionReceipt(buildExecutionReceipt(valid), bound)).toEqual({ ok: true, defects: [] });
  });

  it("rejects untrusted approval claims and unknown fields", () => {
    const receipt = buildExecutionReceipt(core());
    expect(verifyExecutionReceipt({ ...receipt, modelClaimsApproved: true }, expected()).ok).toBe(false);
    expect(verifyExecutionReceipt(receipt, { ...expected(), bypass: true }).ok).toBe(false);
  });

  it("reports incomplete receipts as a typed ControlStackError with the defect list as data", () => {
    const changed = core();
    changed.authorization.approval!.consumedAt = "2026-10-08T14:00:00Z";
    let thrown: unknown;
    try {
      buildExecutionReceipt(changed);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ExecutionReceiptIncompleteError);
    expect(thrown).toBeInstanceOf(ControlStackError);
    expect((thrown as ControlStackError).code).toBe("execution_receipt_incomplete");
    expect((thrown as ExecutionReceiptIncompleteError).defects).toEqual(["approval_consumed_after_expiry"]);
  });

  describe("identity binding", () => {
    it.each([
      ["actor", (c: ExecutionReceiptCore) => { c.authorization.actorId = "someone_else"; }, "actor_binding_mismatch"],
      ["implementer principal", (c: ExecutionReceiptCore) => { c.verification.implementerPrincipalId = "other"; }, "implementer_binding_mismatch"],
      ["implementer engine", (c: ExecutionReceiptCore) => { c.verification.implementerEngineId = "other"; }, "implementer_binding_mismatch"],
      ["implementer provider", (c: ExecutionReceiptCore) => { c.verification.implementerProviderId = "other"; }, "implementer_provider_binding_mismatch"],
      ["reviewer engine", (c: ExecutionReceiptCore) => { c.verification.reviewers[0]!.verifierEngineId = "mistral"; }, "reviewer_binding_mismatch"],
      ["reviewer principal", (c: ExecutionReceiptCore) => { c.verification.reviewers[0]!.reviewerPrincipalId = "reviewer_z"; }, "reviewer_binding_mismatch"]
    ] as const)("rejects a swapped %s claim even with a recomputed receipt hash", (_name, mutate, defect) => {
      const changed = core();
      mutate(changed);
      expect(verifyExecutionReceipt(buildExecutionReceipt(changed), expected()).defects).toContain(defect);
    });
  });

  describe("canonical approval binding", () => {
    it("cannot represent a require_approval decision without a canonical grant", () => {
      const changed = core();
      changed.authorization.approval = undefined;
      expect(() => buildExecutionReceipt(changed)).toThrow();
    });

    it("cannot attach a grant to an allow decision", () => {
      const changed = core();
      changed.authorization.policyDecision = "allow";
      expect(() => buildExecutionReceipt(changed)).toThrow();
    });

    it.each([
      ["approval id", (c: ExecutionReceiptCore) => { c.authorization.approval!.approvalId = "approval_2"; }],
      ["request hash", (c: ExecutionReceiptCore) => { c.authorization.approval!.requestHash = H("7"); }],
      ["grant hash", (c: ExecutionReceiptCore) => { c.authorization.approval!.grantHash = H("7"); }],
      ["approver", (c: ExecutionReceiptCore) => { c.authorization.approval!.approverActorId = "approver_2"; }],
      ["consumption time", (c: ExecutionReceiptCore) => { c.authorization.approval!.consumedAt = "2026-10-08T11:45:00Z"; }],
      ["approval audit", (c: ExecutionReceiptCore) => { c.authorization.approval!.audit.eventId = "approval_event_2"; }]
    ] as const)("rejects a mismatched canonical grant: %s", (_name, mutate) => {
      const changed = core();
      mutate(changed);
      expect(verifyExecutionReceipt(buildExecutionReceipt(changed), expected()).defects).toContain("approval_binding_mismatch");
    });

    it("rejects a grant consumed before it was granted", () => {
      const changed = core();
      changed.authorization.approval!.consumedAt = "2026-10-08T10:00:00Z";
      expect(receiptDefects(changed)).toContain("approval_consumed_before_grant");
    });

    it("rejects a grant consumed at or after its expiry", () => {
      const changed = core();
      changed.authorization.approval!.consumedAt = "2026-10-08T13:00:00Z";
      expect(receiptDefects(changed)).toContain("approval_consumed_after_expiry");
    });

    it("accepts a grant consumed before expiry even when execution starts after the deadline", () => {
      const changed = core();
      changed.manifest = buildEvidenceManifest({
        ...manifestInput,
        startedAt: "2026-10-08T13:10:00Z",
        finishedAt: "2026-10-08T13:11:00Z"
      });
      changed.verification.manifestHash = changed.manifest.manifestHash;
      const bound = expected();
      bound.manifestHash = changed.manifest.manifestHash;
      expect(verifyExecutionReceipt(buildExecutionReceipt(changed), bound)).toEqual({ ok: true, defects: [] });
    });

    it("rejects a receipt whose policy decision differs from the canonical decision", () => {
      const changed = core();
      changed.authorization.policyDecision = "allow";
      changed.authorization.approval = undefined;
      expect(verifyExecutionReceipt(buildExecutionReceipt(changed), expected()).defects).toContain("policy_decision_mismatch");
    });
  });

  describe("canonical reviewer requirement", () => {
    it("rejects a high-risk attempt that has one reviewer when two are required", () => {
      const changed = core();
      changed.verification.reviewers = [changed.verification.reviewers[0]!];
      const bound = expected();
      bound.reviewers = [bound.reviewers[0]!];
      const result = verifyExecutionReceipt(buildExecutionReceipt(changed), bound);
      expect(result.ok).toBe(false);
      expect(result.defects).toContain("canonical_reviewers_insufficient");
    });

    it("accepts a high-risk attempt with two distinct independent reviewers", () => {
      expect(verifyExecutionReceipt(buildExecutionReceipt(core()), expected()).ok).toBe(true);
    });

    it("accepts a low-risk read-only attempt that canonically requires zero reviewers", () => {
      const changed = core();
      changed.verification.reviewers = [];
      const bound = expected();
      bound.reviewers = [];
      bound.reviewersRequired = 0;
      bound.requireIndependentPrincipal = false;
      bound.requireIndependentProvider = false;
      expect(verifyExecutionReceipt(buildExecutionReceipt(changed), bound)).toEqual({ ok: true, defects: [] });
    });

    it("rejects an empty reviewer list when the canonical requirement needs reviewers", () => {
      const changed = core();
      changed.verification.reviewers = [];
      const bound = expected();
      bound.reviewers = [];
      expect(verifyExecutionReceipt(buildExecutionReceipt(changed), bound).defects).toContain("insufficient_reviewers");
    });

    it("rejects reviewers that share the executor's provider when independence is required", () => {
      const changed = core();
      changed.verification.reviewers[0]!.verifierProviderId = "openai";
      const bound = expected();
      bound.reviewers[0]!.verifierProviderId = "openai";
      expect(verifyExecutionReceipt(buildExecutionReceipt(changed), bound).defects).toContain("provider_not_independent");
    });

    it("accepts two distinct principals from one provider that is not the executor's provider", () => {
      const changed = core();
      changed.verification.reviewers[0]!.verifierProviderId = "anthropic";
      changed.verification.reviewers[1]!.verifierProviderId = "anthropic";
      const bound = expected();
      bound.reviewers[0]!.verifierProviderId = "anthropic";
      bound.reviewers[1]!.verifierProviderId = "anthropic";
      expect(verifyExecutionReceipt(buildExecutionReceipt(changed), bound)).toEqual({ ok: true, defects: [] });
    });

    it("does not require provider independence for a requirement that does not ask for it", () => {
      const changed = core();
      changed.verification.reviewers[0]!.verifierProviderId = "openai";
      const bound = expected();
      bound.reviewers[0]!.verifierProviderId = "openai";
      bound.requireIndependentProvider = false;
      expect(verifyExecutionReceipt(buildExecutionReceipt(changed), bound).ok).toBe(true);
    });
  });

  describe("bound evidence claims", () => {
    it("rejects an inflated criteria count", () => {
      const changed = core();
      changed.verification.criteriaPassed = 1;
      expect(verifyExecutionReceipt(buildExecutionReceipt(changed), expected()).defects).toContain("criteria_binding_mismatch");
    });

    it("rejects replaced audit event ids whose hashes are unchanged", () => {
      const changed = core();
      changed.verification.audit.eventId = "verify_forged";
      expect(verifyExecutionReceipt(buildExecutionReceipt(changed), expected()).defects).toContain("verification_audit_mismatch");
    });

    it("rejects a policy audit reference that does not match the canonical event", () => {
      const changed = core();
      changed.authorization.audit.eventId = "auth_forged";
      expect(verifyExecutionReceipt(buildExecutionReceipt(changed), expected()).defects).toContain("policy_audit_mismatch");
    });
  });

  describe("unverifiable evidence fails closed", () => {
    it("rejects a binding that omits a required canonical field", () => {
      const { validationRunId: _omitted, ...partial } = expected();
      expect(verifyExecutionReceipt(buildExecutionReceipt(core()), partial).defects).toEqual(["invalid_schema_or_binding"]);
    });

    it("rejects a binding that omits the canonical reviewer requirement", () => {
      const { reviewersRequired: _omitted, ...partial } = expected();
      expect(verifyExecutionReceipt(buildExecutionReceipt(core()), partial).defects).toEqual(["invalid_schema_or_binding"]);
    });
  });
});
