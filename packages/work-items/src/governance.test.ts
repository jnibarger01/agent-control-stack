import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultExecutionPlanForWorkItem } from "./execution-plan.js";
import { SqliteWorkItemStore } from "./store.js";

const H = (c: string) => c.repeat(64);
const via = { via: "domain_service" as const };

let dir: string;
let dbPath: string;
let store: SqliteWorkItemStore;
let workItemId: string;
let attemptId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "acs-gov-"));
  dbPath = join(dir, "control.db");
  store = new SqliteWorkItemStore(dbPath);
  const workItem = store.create({
    title: "governance fixture",
    requester: "user",
    intent: "exercise advisory/evidence/verification projections",
    requestedActions: [{ kind: "fs.write", description: "edit" }],
    risk: "medium"
  });
  workItemId = workItem.id;
  // A minimal attempt row so evidence manifests / phases can reference it.
  const plan = store.createExecutionPlan({
    workItemId,
    definition: defaultExecutionPlanForWorkItem(workItem),
    createdByActorId: "actor_system_bootstrap"
  });
  const attempt = store.createAttempt({ workItemId, planHash: plan.planHash, inputHash: H("b") }, via);
  attemptId = attempt.attemptId;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function manifest(hash = H("e")) {
  return {
    schemaVersion: "acs.evidence-manifest.v1",
    attemptId,
    workItemId,
    admittedPlanHash: H("d"),
    planHash: H("5"),
    actionHash: H("c"),
    baseWorkspaceRevision: H("1"),
    resultWorkspaceRevision: H("2"),
    changedPaths: ["src/x.ts"],
    diffHash: H("3"),
    commands: [],
    testEvidence: null,
    sandboxProfile: "desktop_commander",
    networkProfile: "none",
    networkDecisions: { allowed: 0, denied: 0 },
    observations: [],
    workerId: "worker_1",
    startedAt: "2026-08-30T00:00:00.000Z",
    finishedAt: "2026-08-30T00:00:01.000Z",
    manifestHash: hash
  };
}

function recordManifest(hash = H("e")) {
  return store.recordEvidenceManifest(
    {
      manifestHash: hash,
      attemptId,
      workItemId,
      admittedPlanHash: H("d"),
      planHash: H("5"),
      actionHash: H("c"),
      baseWorkspaceRevision: H("1"),
      resultWorkspaceRevision: H("2"),
      manifest: manifest(hash)
    },
    via
  );
}

describe("advisory principals cannot mutate the work-item lifecycle (proof 1)", () => {
  it("recording a plan proposal / review finding never transitions the work item", () => {
    const before = store.get(workItemId)!.status;
    store.recordPlanProposal(
      { proposalHash: H("9"), proposalId: "plan_proposal_1", workItemId, principalId: "chatgpt", proposal: { goal: "x" } },
      via
    );
    recordManifest();
    store.recordReviewFinding(
      {
        findingHash: H("7"),
        findingId: "review_finding_1",
        workItemId,
        attemptId,
        reviewerPrincipalId: "claude",
        reviewerProvider: "anthropic",
        evidenceManifestHash: H("e"),
        verdict: "PASS",
        finding: { verdict: "PASS" }
      },
      via
    );
    expect(store.get(workItemId)!.status).toBe(before);
    // The store exposes no method that lets these artifacts set a terminal state.
    const method = (store as unknown as Record<string, unknown>)["acceptReviewFinding"];
    expect(method).toBeUndefined();
  });

  it("governance record methods require a privileged transition context", () => {
    // @ts-expect-error - options omitted on purpose
    expect(() => store.recordAttemptPhase({ attemptId, workItemId, phase: "reviewing" })).toThrow(
      /policy or domain service path/i
    );
  });
});

describe("evidence manifest — content-addressed, immutable, machine-only (proofs 7 & 8)", () => {
  it("is append-only: a conflicting body for the same hash is rejected; identical is idempotent", () => {
    recordManifest(H("e"));
    // Same hash, same body -> idempotent no-op.
    expect(() => recordManifest(H("e"))).not.toThrow();
    // Same hash, different body -> rejected.
    expect(() =>
      store.recordEvidenceManifest(
        {
          manifestHash: H("e"),
          attemptId,
          workItemId,
          admittedPlanHash: H("d"),
          planHash: H("5"),
          actionHash: H("c"),
          baseWorkspaceRevision: H("1"),
          resultWorkspaceRevision: H("9"),
          manifest: { ...manifest(H("e")), resultWorkspaceRevision: H("9") }
        },
        via
      )
    ).toThrow(/conflict/);
  });

  it("the DB rejects a raw UPDATE / DELETE on a stored manifest", () => {
    recordManifest(H("e"));
    store.close();
    const raw = new DatabaseSync(dbPath);
    try {
      expect(() =>
        raw
          .prepare(`UPDATE evidence_manifests SET result_workspace_revision = 'x' WHERE manifest_hash = ?`)
          .run(H("e"))
      ).toThrow(/immutable/);
      expect(() => raw.prepare(`DELETE FROM evidence_manifests WHERE manifest_hash = ?`).run(H("e"))).toThrow(
        /append-only/
      );
    } finally {
      raw.close();
      store = new SqliteWorkItemStore(dbPath);
    }
  });

  it("there is no store method that records a model summary as evidence", () => {
    const names = Object.getOwnPropertyNames(Object.getPrototypeOf(store));
    expect(names.filter((n) => /summary|claim|note/i.test(n) && /record/i.test(n))).toEqual([]);
  });
});

describe("review findings reference the exact evidence manifest (proof 9)", () => {
  it("a finding whose evidenceManifestHash has no manifest row is rejected", () => {
    expect(() =>
      store.recordReviewFinding(
        {
          findingHash: H("7"),
          findingId: "review_finding_1",
          workItemId,
          attemptId,
          reviewerPrincipalId: "claude",
          reviewerProvider: "anthropic",
          evidenceManifestHash: H("f"),
          verdict: "PASS",
          finding: { verdict: "PASS" }
        },
        via
      )
    ).toThrow(/evidence manifest|evidence_missing/i);
  });

  it("a finding stores and echoes the exact manifest hash", () => {
    recordManifest(H("e"));
    const finding = store.recordReviewFinding(
      {
        findingHash: H("7"),
        findingId: "review_finding_1",
        workItemId,
        attemptId,
        reviewerPrincipalId: "claude",
        reviewerProvider: "anthropic",
        evidenceManifestHash: H("e"),
        verdict: "NEEDS_CHANGES",
        finding: { verdict: "NEEDS_CHANGES" }
      },
      via
    );
    expect(finding.evidenceManifestHash).toBe(H("e"));
    expect(store.listReviewFindings(attemptId).map((f) => f.findingHash)).toEqual([H("7")]);
  });
});

describe("result acceptance stays in packages/work-items, gated by verification (proofs 10 & 11)", () => {
  it("the fail-closed verification gate blocks a governed attempt until an attempt_accepted decision exists", () => {
    // No requirement -> gate is open (existing dry-run path unaffected).
    expect(store.isVerificationSatisfiedForAttempt(attemptId).satisfied).toBe(true);

    store.recordVerificationRequirement(
      {
        attemptId,
        workItemId,
        policyVersion: "acs.verification-policy.v1",
        reviewersRequired: 1,
        requirement: { reviewersRequired: 1 }
      },
      via
    );
    // Requirement present, no decision -> gate is CLOSED. `succeeded` cannot pass.
    expect(store.isVerificationSatisfiedForAttempt(attemptId)).toEqual({
      satisfied: false,
      reason: "verification requirement without an attempt_accepted decision"
    });

    recordManifest(H("e"));
    // A disputed decision does NOT open the gate.
    store.recordVerificationDecision(
      {
        attemptId,
        workItemId,
        outcome: "verification_disputed",
        evidenceManifestHash: H("e"),
        reviewFindingHashes: [],
        verificationPolicyVersion: "acs.verification-policy.v1"
      },
      via
    );
    expect(store.isVerificationSatisfiedForAttempt(attemptId).satisfied).toBe(false);

    // Only an explicit attempt_accepted decision opens it.
    store.recordVerificationDecision(
      {
        attemptId,
        workItemId,
        outcome: "attempt_accepted",
        evidenceManifestHash: H("e"),
        reviewFindingHashes: [],
        verificationPolicyVersion: "acs.verification-policy.v1"
      },
      via
    );
    expect(store.isVerificationSatisfiedForAttempt(attemptId).satisfied).toBe(true);
  });

  it("a zero-reviewer requirement still needs an ACS decision and cannot be deleted", () => {
    store.recordVerificationRequirement(
      {
        attemptId,
        workItemId,
        policyVersion: "acs.verification-policy.v1",
        reviewersRequired: 0,
        requirement: { reviewersRequired: 0 }
      },
      via
    );
    expect(store.isVerificationSatisfiedForAttempt(attemptId)).toEqual({
      satisfied: false,
      reason: "verification requirement without an attempt_accepted decision"
    });

    store.close();
    const raw = new DatabaseSync(dbPath);
    try {
      expect(() =>
        raw.prepare(`UPDATE verification_requirements SET reviewers_required = 0 WHERE attempt_id = ?`).run(attemptId)
      ).toThrow(/append-only|fixed at admission/i);
      expect(() =>
        raw.prepare(`DELETE FROM verification_requirements WHERE attempt_id = ?`).run(attemptId)
      ).toThrow(/append-only/i);
    } finally {
      raw.close();
      store = new SqliteWorkItemStore(dbPath);
    }

    recordManifest(H("e"));
    store.recordVerificationDecision(
      {
        attemptId,
        workItemId,
        outcome: "attempt_accepted",
        evidenceManifestHash: H("e"),
        reviewFindingHashes: [],
        verificationPolicyVersion: "acs.verification-policy.v1"
      },
      via
    );
    expect(store.isVerificationSatisfiedForAttempt(attemptId).satisfied).toBe(true);
  });

  it("classification is recorded as an explicit decision, never inferred", () => {
    recordManifest(H("e"));
    const decision = store.recordVerificationDecision(
      {
        attemptId,
        workItemId,
        outcome: "verification_disputed",
        evidenceManifestHash: H("e"),
        reviewFindingHashes: [H("7"), H("8")],
        verificationPolicyVersion: "acs.verification-policy.v1"
      },
      via
    );
    expect(decision.outcome).toBe("verification_disputed");
    expect(store.getVerificationDecision(attemptId)?.outcome).toBe("verification_disputed");
  });
});

describe("attempt phase is additive, canonical audit chain stays intact (proofs 12)", () => {
  it("records phases as audit events without touching work-item status, and the chain verifies", () => {
    const status0 = store.get(workItemId)!.status;
    for (const phase of ["planning", "admitted", "executing", "collecting_evidence", "reviewing"] as const) {
      store.recordAttemptPhase({ attemptId, workItemId, phase }, via);
    }
    recordManifest(H("e"));
    store.recordReviewFinding(
      {
        findingHash: H("7"),
        findingId: "review_finding_1",
        workItemId,
        attemptId,
        reviewerPrincipalId: "claude",
        reviewerProvider: "anthropic",
        evidenceManifestHash: H("e"),
        verdict: "PASS",
        finding: { verdict: "PASS" }
      },
      via
    );
    store.recordVerificationDecision(
      {
        attemptId,
        workItemId,
        outcome: "attempt_accepted",
        evidenceManifestHash: H("e"),
        reviewFindingHashes: [H("7")],
        verificationPolicyVersion: "acs.verification-policy.v1"
      },
      via
    );

    expect(store.get(workItemId)!.status).toBe(status0);
    expect(store.getAttemptPhase(attemptId)).toBe("reviewing");
    const names = store.readEvents({ limit: 500 }).map((e) => e.name);
    for (const n of [
      "attempt.phase.planning",
      "attempt.phase.reviewing",
      "evidence.manifest_recorded",
      "review.finding_recorded",
      "verification.decision"
    ]) {
      expect(names).toContain(n);
    }
    expect(store.verifyAuditChain().ok).toBe(true);
    expect(store.health().checks.auditChain.ok).toBe(true);
  });
});

describe("reviewer grants — single-consume, append-only (proof 4 storage side)", () => {
  it("a grant consumes exactly once and cannot be un-consumed or deleted", () => {
    store.issueReviewerGrant(
      {
        grantHash: H("a"),
        grantId: "reviewer_grant_1",
        principalId: "claude",
        workItemId,
        planId: "plan_1",
        admittedPlanHash: H("d"),
        attemptId,
        workspaceId: "workspace_1",
        workspaceRevision: H("1"),
        issuedAt: "2026-08-30T00:00:00.000Z",
        expiresAt: "2999-01-01T00:00:00.000Z",
        grant: { attemptId }
      },
      via
    );
    expect(store.consumeReviewerGrant(H("a"), via).status).toBe("consumed");
    // idempotent
    expect(store.consumeReviewerGrant(H("a"), via).status).toBe("consumed");
    store.close();
    const raw = new DatabaseSync(dbPath);
    try {
      expect(() =>
        raw.prepare(`UPDATE reviewer_grants SET status = 'issued' WHERE grant_hash = ?`).run(H("a"))
      ).toThrow(/single issued -> terminal|append-only/i);
      expect(() => raw.prepare(`DELETE FROM reviewer_grants WHERE grant_hash = ?`).run(H("a"))).toThrow(
        /append-only/
      );
    } finally {
      raw.close();
      store = new SqliteWorkItemStore(dbPath);
    }
  });
});
