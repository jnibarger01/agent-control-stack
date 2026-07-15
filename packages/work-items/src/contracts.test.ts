import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  actionManifestHash,
  actionManifestSchema,
  approvalBindingHash,
  approvalBindingSchema,
  approvalGrantHash,
  approvalGrantSchema,
  classifierEvidenceHash,
  classifierEvidenceSchema,
  idempotencyRecordSchema,
  legacyProvenanceClaimSchema,
  legacyProvenanceRecordSchema,
  missionIntakeHash,
  missionIntakeSchema,
  traceCorrelationSchema,
} from "./contracts.js";

const now = "2026-07-11T22:00:00.000Z";
const later = "2026-07-11T22:10:00.000Z";
const shaA = "a".repeat(64);
const shaB = "b".repeat(64);
const nonce = "n".repeat(32);

const intake = {
  schemaVersion: "acs.mission-intake.v1",
  requestId: "request-001",
  title: "Inspect logs",
  goal: "Inspect the service logs and summarize the failure",
  origin: "cli",
  target: { cwd: "/home/jacen/project", files: ["src/index.ts"] },
  proposedActions: [{ clientActionId: "read-logs", kind: "read_file", description: "Read service logs", params: {} }],
  constraints: {
    network: "none",
    maxRuntimeMs: 60_000,
    successCriteria: ["Root cause identified"],
  },
  submittedClaims: { taskType: "research", risk: "read_only", approvalRequested: false },
};

const manifest = {
  schemaVersion: "acs.action-manifest.v1",
  workItemId: "wrk_123456",
  intakeHash: shaA,
  requesterActorId: "actor-123",
  policyVersion: "acs-policy@1",
  nonce,
  createdAt: now,
  actions: [
    {
      actionId: "action-1",
      kind: "read_file",
      description: "Read service logs",
      arguments: { path: "/var/log/service.log" },
      cwd: "/home/jacen/project",
      normalizedPaths: ["/var/log/service.log"],
      effects: { network: false, write: false, destructive: false },
      timeoutMs: 60_000,
    },
  ],
};

const binding = {
  schemaVersion: "acs.approval-binding.v1",
  approvalRequestId: "apr-request-1",
  workItemId: manifest.workItemId,
  manifestHash: shaA,
  actionId: "action-1",
  actionHash: shaB,
  policyVersion: manifest.policyVersion,
  policyDecisionHash: "c".repeat(64),
  requesterActorId: manifest.requesterActorId,
  nonce,
  createdAt: now,
  expiresAt: later,
};

describe("canonical control contracts", () => {
  it("requires an explicit supported intake version and rejects unknown keys", () => {
    expect(missionIntakeSchema.safeParse(intake).success).toBe(true);
    expect(missionIntakeSchema.safeParse({ ...intake, schemaVersion: undefined }).success).toBe(false);
    expect(missionIntakeSchema.safeParse({ ...intake, schemaVersion: "acs.mission-intake.v2" }).success).toBe(false);
    expect(missionIntakeSchema.safeParse({ ...intake, extra: true }).success).toBe(false);
    expect(missionIntakeSchema.safeParse({ ...intake, constraints: { ...intake.constraints, extra: true } }).success).toBe(false);
  });

  it("bounds arrays and text and rejects duplicate action IDs", () => {
    expect(missionIntakeSchema.safeParse({ ...intake, title: "x".repeat(201) }).success).toBe(false);
    expect(missionIntakeSchema.safeParse({ ...intake, target: { files: Array.from({ length: 65 }, (_, i) => `f-${i}`) } }).success).toBe(false);
    expect(
      missionIntakeSchema.safeParse({
        ...intake,
        proposedActions: [intake.proposedActions[0], intake.proposedActions[0]],
      }).success
    ).toBe(false);
  });

  it("separates caller provenance claims from ACS-stamped provenance records", () => {
    const claim = {
      schemaVersion: "acs.legacy-provenance-claim.v1",
      sourceSystem: "mission-router",
      sourceVersion: "0.1.0",
      sourceMissionId: "30dd6926-077d-40da-b975-088dbd8269b6",
      sourceEnvelopeVersion: 1,
      sourceEnvelopeHash: shaA,
      verification: "unverified",
    };
    expect(legacyProvenanceClaimSchema.safeParse(claim).success).toBe(true);
    expect(legacyProvenanceClaimSchema.safeParse({ ...claim, sourceEnvelopeHash: "abc" }).success).toBe(false);
    expect(legacyProvenanceClaimSchema.safeParse({ ...claim, approval: true }).success).toBe(false);
    expect(legacyProvenanceClaimSchema.safeParse({ ...claim, verification: "verified" }).success).toBe(false);

    expect(
      legacyProvenanceRecordSchema.safeParse({
        ...claim,
        schemaVersion: "acs.legacy-provenance.v1",
        verification: "verified",
        importedAt: now,
        importedByActorId: "actor-importer",
      }).success
    ).toBe(true);
  });

  it("validates bounded advisory classifier evidence", () => {
    const evidence = {
      schemaVersion: "acs.classifier-evidence.v1",
      evidenceId: "evidence-001",
      classifier: { id: "mission-router-compat", version: "1" },
      subjectIntakeHash: missionIntakeHash(intake),
      generatedAt: now,
      taskType: { recommendation: "research", signals: [{ ruleId: "task.research.summarize" }] },
      risk: { recommendation: "read_only", signals: [] },
      sensitivity: { categories: [], signals: [] },
      authoritative: false,
    };
    expect(classifierEvidenceSchema.safeParse(evidence).success).toBe(true);
    expect(classifierEvidenceSchema.safeParse({ ...evidence, authoritative: true }).success).toBe(false);
    expect(classifierEvidenceSchema.safeParse({ ...evidence, secret: "raw-match" }).success).toBe(false);
    expect(classifierEvidenceHash(evidence)).toBe("bd634c52f2a90baaf3b5e9d06188f33488903e4be51e9a04ed5d8a75a99a5ac2");
  });

  it("uses domain-separated fixed hashes and invalidates every approval-binding field", () => {
    expect(missionIntakeHash(intake)).toBe("41afa8337a44513a2839f8221f70c325fc1ba320cb2813e3fd2bcdaa4b78b2d8");
    expect(actionManifestSchema.safeParse(manifest).success).toBe(true);
    expect(actionManifestHash(manifest)).toBe("745287583a7ed1a6b2fa82c3a80217b2b266a3532275f5ee68677ec07264e3a5");
    expect(approvalBindingSchema.safeParse(binding).success).toBe(true);
    const original = approvalBindingHash(binding);
    expect(original).toBe("51f36931d986e02cc68863b1d3b4175b4b302712d2a2e7c64892cf5ff58fc405");

    const mutations = [
      { ...binding, approvalRequestId: "apr-request-2" },
      { ...binding, workItemId: "wrk_other" },
      { ...binding, manifestHash: shaB },
      { ...binding, actionId: "action-2" },
      { ...binding, actionHash: shaA },
      { ...binding, policyVersion: "acs-policy@2" },
      { ...binding, policyDecisionHash: shaA },
      { ...binding, requesterActorId: "actor-other" },
      { ...binding, nonce: "m".repeat(32) },
      { ...binding, createdAt: "2026-07-11T22:00:01.000Z" },
      { ...binding, expiresAt: "2026-07-11T22:11:00.000Z" },
    ];
    for (const changed of mutations) expect(approvalBindingHash(changed)).not.toBe(original);
  });

  it("binds approver, expiry, and status in a separate grant hash", () => {
    const grant = {
      schemaVersion: "acs.approval-grant.v1",
      requestHash: approvalBindingHash(binding),
      approverActorId: "actor-approver",
      decision: "approved",
      reason: "Reviewed",
      grantedAt: now,
      expiresAt: later,
      status: "granted",
    };
    expect(approvalGrantSchema.safeParse(grant).success).toBe(true);
    expect(approvalGrantHash(grant)).toBe("2a2987b0910d6cf62b79d0829fe2043064e4a7cb04c0dfa60836d0bb790f110a");
    expect(approvalGrantHash({ ...grant, approverActorId: "actor-other" })).not.toBe(approvalGrantHash(grant));
    expect(approvalGrantHash({ ...grant, expiresAt: "2026-07-11T22:12:00.000Z" })).not.toBe(approvalGrantHash(grant));
  });

  it("defines strict idempotency and trace-correlation records", () => {
    expect(
      idempotencyRecordSchema.safeParse({
        schemaVersion: "acs.idempotency.v1",
        actorId: "actor-123",
        operation: "mission_intake",
        key: "idem-123456",
        requestHash: shaA,
        state: "in_progress",
        createdAt: now,
      }).success
    ).toBe(true);
    expect(
      traceCorrelationSchema.safeParse({
        schemaVersion: "acs.trace-correlation.v1",
        traceId: "a".repeat(32),
        rootSpanId: "b".repeat(16),
        requestId: "request-001",
      }).success
    ).toBe(true);
  });

  it("ships JSON Schemas with the same literal versions", () => {
    const schemaDir = fileURLToPath(new URL("../schemas/", import.meta.url));
    const intakeJson = JSON.parse(readFileSync(`${schemaDir}/mission-intake.v1.schema.json`, "utf8"));
    const evidenceJson = JSON.parse(readFileSync(`${schemaDir}/classifier-evidence.v1.schema.json`, "utf8"));
    expect(intakeJson.properties.schemaVersion.const).toBe("acs.mission-intake.v1");
    expect(intakeJson.required).toContain("schemaVersion");
    expect(intakeJson.additionalProperties).toBe(false);
    expect(evidenceJson.properties.schemaVersion.const).toBe("acs.classifier-evidence.v1");
    expect(evidenceJson.required).toContain("authoritative");
    expect(evidenceJson.additionalProperties).toBe(false);
  });
});
