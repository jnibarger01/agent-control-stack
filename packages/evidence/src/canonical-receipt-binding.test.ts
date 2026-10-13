import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  SqliteWorkItemStore,
  storedExecutionResultPayloadHash,
  type StoredExecutionResult
} from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { buildEvidenceManifest } from "./evidence-manifest.js";
import {
  executionReceiptRow,
  receiptBindingFromCanonicalRecords,
  verifyExecutionReceiptAgainstRecords,
  type CanonicalReceiptContext,
  type CanonicalReceiptRecords
} from "./canonical-receipt-binding.js";
import { buildExecutionReceipt, executionValidationChecksHash, type ExecutionReceiptCore } from "./execution-receipt.js";

const H = (c: string) => c.repeat(64);
const T = "2026-10-08T12:00:00.000Z";
const manifest = buildEvidenceManifest({
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
  testEvidence: { validationRunId: "test_1", passed: true, checksPassed: 1, checksFailed: 0 },
  sandboxProfile: "desktop_commander",
  networkProfile: "none",
  networkDecisions: { allowed: 0, denied: 0 },
  observations: [],
  startedAt: "2026-10-08T12:00:00Z",
  finishedAt: "2026-10-08T12:01:00Z"
});
const checks = [{ checkId: "check_1", runId: "test_1", name: "unit", passed: true, detail: "ok" }];
const validation = {
  runId: "test_1",
  attemptId: "attempt_1",
  workItemId: "work_1",
  passed: true,
  checksPassed: 1,
  checksFailed: 0,
  checksDigest: executionValidationChecksHash(checks)
};

function storedResult(): StoredExecutionResult {
  const base: StoredExecutionResult = {
    resultId: "result_1",
    workItemId: "work_1",
    leaseId: "lease_1",
    workerId: "worker_1",
    idempotencyKey: "idem_1",
    actionHash: H("c"),
    outcome: "succeeded",
    startedAt: T,
    finishedAt: T,
    exitCode: 0,
    summary: "done",
    structuredOutput: {},
    artifacts: [],
    simulationMetadata: {},
    payloadHash: "",
    createdAt: T
  };
  return { ...base, payloadHash: storedExecutionResultPayloadHash(base) };
}

const records = (): CanonicalReceiptRecords => ({
  attempt: {
    attemptId: "attempt_1",
    workItemId: "work_1",
    planId: "plan_1",
    planHash: H("b"),
    attemptNumber: 1,
    protocolVersion: "acs.worker.v1" as never,
    inputHash: H("9"),
    status: "succeeded",
    currentFencingEpoch: 1,
    claimedByWorkerId: "worker_1",
    createdAt: T,
    updatedAt: T
  },
  lease: {
    leaseId: "lease_1",
    attemptId: "attempt_1",
    workItemId: "work_1",
    admissionId: "admission_1",
    workerId: "worker_1",
    tokenHash: H("4"),
    planHash: H("b"),
    inputHash: H("9"),
    fencingEpoch: 1,
    protocolVersion: "acs.worker.v1" as never,
    policyVersion: "acs.policy.v1",
    policyDecisionHash: H("8"),
    issuedAt: T,
    expiresAt: T,
    maxExpiresAt: T,
    lastRenewedAt: T,
    status: "consumed"
  },
  result: storedResult(),
  requirement: {
    attemptId: "attempt_1",
    workItemId: "work_1",
    policyVersion: "acs.verification.v1",
    reviewersRequired: 1,
    requirement: { requireIndependentPrincipal: true, requireIndependentProvider: true },
    recordedAt: T
  },
  decision: {
    attemptId: "attempt_1",
    workItemId: "work_1",
    outcome: "attempt_accepted",
    evidenceManifestHash: manifest.manifestHash,
    reviewFindingHashes: [H("7")],
    verificationPolicyVersion: "acs.verification.v1",
    decidedAt: T
  },
  reviews: [
    {
      findingHash: H("7"),
      attemptId: "attempt_1",
      workItemId: "work_1",
      reviewerPrincipalId: "reviewer_a",
      reviewerProvider: "anthropic",
      verifierEngineId: "acs-credential:reviewer-a",
      evidenceManifestHash: manifest.manifestHash,
      verdict: "PASS",
      finding: {},
      createdAt: T
    }
  ]
});

const context = (): CanonicalReceiptContext => ({
  actorId: "operator_1",
  capabilityId: "cap_1",
  admittedPlanHash: H("a"),
  validation: { ...validation, checks },
  approvals: [],
  implementer: { principalId: "executor_1", engineId: "codex", providerId: "openai" },
  policyAudit: { eventId: "auth_1", eventHash: H("5") },
  verificationAudit: { eventId: "verify_1", eventHash: H("6") },
  readbackAudit: { eventId: "readback_1", eventHash: H("0") },
  reviewAudit: { [H("7")]: { eventId: "review_1", eventHash: H("2") } }
});

const core = (): ExecutionReceiptCore => ({
  schemaVersion: "acs.execution-receipt.v1",
  manifest,
  validation,
  authorization: {
    actorId: "operator_1",
    workerId: "worker_1",
    attemptId: "attempt_1",
    actionHash: H("c"),
    admittedPlanHash: H("a"),
    attemptPlanHash: H("b"),
    capabilityId: "cap_1",
    leaseId: "lease_1",
    claimTokenHash: H("4"),
    policyDecision: "allow",
    policyVersion: "acs.policy.v1",
    policyDecisionHash: H("8"),
    approvals: [],
    audit: { eventId: "auth_1", eventHash: H("5") }
  },
  verification: {
    implementerPrincipalId: "executor_1",
    implementerEngineId: "codex",
    implementerProviderId: "openai",
    reviewers: [
      {
        reviewerPrincipalId: "reviewer_a",
        verifierEngineId: "acs-credential:reviewer-a",
        verifierProviderId: "anthropic",
        verdict: "pass",
        audit: { eventId: "review_1", eventHash: H("2") }
      }
    ],
    verdict: "pass",
    manifestHash: manifest.manifestHash,
    criteriaPassed: 1,
    criteriaFailed: 0,
    audit: { eventId: "verify_1", eventHash: H("6") }
  },
  readback: {
    resultWorkspaceRevision: H("e"),
    diffHash: H("f"),
    status: "succeeded",
    resultId: "result_1",
    resultPayloadHash: storedResult().payloadHash,
    audit: { eventId: "readback_1", eventHash: H("0") }
  }
});

describe("receipt binding derived only from stored canonical records", () => {
  it("verifies a receipt against the binding derived from the attempt, lease, result, decision and reviews", () => {
    const binding = receiptBindingFromCanonicalRecords(records(), context());
    expect(binding.attemptPlanHash).toBe(H("b"));
    expect(binding.policyDecisionHash).toBe(H("8"));
    expect(binding.policyVersion).toBe("acs.policy.v1");
    expect(binding.resultPayloadHash).toBe(storedResult().payloadHash);
    expect(verifyExecutionReceiptAgainstRecords(buildExecutionReceipt(core()), records(), context())).toEqual({
      ok: true,
      defects: []
    });
  });

  it("refuses a lease whose plan hash differs from the attempt", () => {
    const changed = records();
    changed.lease.planHash = H("9");
    expect(verifyExecutionReceiptAgainstRecords(buildExecutionReceipt(core()), changed, context()).defects).toContain(
      "lease_plan_hash"
    );
  });

  it("refuses a stored result whose payload was altered after ingest", () => {
    const changed = records();
    changed.result.summary = "rewritten";
    expect(verifyExecutionReceiptAgainstRecords(buildExecutionReceipt(core()), changed, context()).defects).toContain(
      "result_payload_hash"
    );
  });

  it("rejects a receipt citing a different lease decision hash", () => {
    const changed = records();
    changed.lease.policyDecisionHash = H("1");
    expect(verifyExecutionReceiptAgainstRecords(buildExecutionReceipt(core()), changed, context()).defects).toContain(
      "policy_decision_hash_mismatch"
    );
  });

  it("checks the receipt's verifier engine against the stored review record", () => {
    const forged = core();
    forged.verification.reviewers[0]!.verifierEngineId = "claimed-engine";
    expect(verifyExecutionReceiptAgainstRecords(buildExecutionReceipt(forged), records(), context()).defects).toContain(
      "reviewer_binding_mismatch"
    );
  });

  it("refuses to bind a reviewer whose stored engine is unknown", () => {
    const changed = records();
    changed.reviews = [{ ...changed.reviews[0]!, verifierEngineId: null }];
    expect(verifyExecutionReceiptAgainstRecords(buildExecutionReceipt(core()), changed, context()).defects).toContain(
      "review_engine_unknown"
    );
  });

  it("derives zero criteria for an accepted decision with zero required reviewers", () => {
    const changed = records();
    changed.requirement.reviewersRequired = 0;
    changed.requirement.requirement = { requireIndependentPrincipal: false, requireIndependentProvider: false };
    changed.decision.reviewFindingHashes = [];
    changed.reviews = [];
    const receipt = core();
    receipt.verification.reviewers = [];
    receipt.verification.criteriaPassed = 0;
    expect(receiptBindingFromCanonicalRecords(changed, context()).criteriaPassed).toBe(0);
    expect(verifyExecutionReceiptAgainstRecords(buildExecutionReceipt(receipt), changed, context())).toEqual({
      ok: true,
      defects: []
    });
  });

  it("refuses an approval set that differs from the lease's consumed approvals", () => {
    const changed = records();
    changed.lease.approvalId = "approval_1";
    expect(verifyExecutionReceiptAgainstRecords(buildExecutionReceipt(core()), changed, context()).defects).toContain(
      "approval_set"
    );
  });
});

describe("execution_receipts row format (PLAN P1-7, migration 071)", () => {
  it("projects a receipt into the P1-7 row and inserts it into the migrated append-only table", () => {
    const receipt = buildExecutionReceipt(core());
    const row = executionReceiptRow(receipt, { prevHash: null, auditEventHash: H("5") });
    expect(row.docHash).toBe(receipt.receiptHash);
    expect(JSON.parse(row.docJson)).toEqual(receipt);
    const dir = mkdtempSync(join(tmpdir(), "acs-receipt-row-"));
    try {
      new SqliteWorkItemStore(join(dir, "control.db")).close();
      const db = new DatabaseSync(join(dir, "control.db"));
      try {
        db.prepare(
          `INSERT INTO execution_receipts (receipt_id, subject, doc_json, doc_hash, prev_hash, audit_event_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(row.receiptId, row.subject, row.docJson, row.docHash, row.prevHash, row.auditEventHash, T);
        expect(() => db.exec("UPDATE execution_receipts SET subject = 'x'")).toThrow(/immutable/);
        expect(() => db.exec("DELETE FROM execution_receipts")).toThrow(/append-only/);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
