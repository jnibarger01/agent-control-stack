import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advisorAuditView, SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it } from "vitest";
import { type AdvisorResponse } from "./contracts.js";
import { consultationDraftFromResponse, recordLocalAdvisorConsultation } from "./to-consultation.js";
import { projectReviewFindingFromConsultation } from "./to-review-finding.js";
import { advisorTraceEventFromConsultation } from "./trace-event.js";
import { isTrusted } from "@agent-control-stack/looptrace-query";

const HASH = `sha256:${"ab".repeat(32)}` as const;
const MANIFEST = "cd".repeat(32);
const transition = { via: "domain_service" as const };

function response(overrides: Partial<AdvisorResponse> = {}): AdvisorResponse {
  return {
    schemaVersion: "advisor.v1",
    requestId: "req-1",
    missionId: "mission-1",
    operation: "review_plan",
    status: "completed",
    verdict: "NEEDS_CHANGES",
    findings: [
      {
        category: "tests",
        severity: "medium",
        summary: "Missing failure-path test",
        evidenceRefs: ["diff-1"]
      }
    ],
    recommendedActions: ["Add a timeout regression"],
    model: { provider: "ollama", id: "ollama:qwen2.5-coder:7b", digest: HASH },
    inputHash: HASH,
    evidenceHashes: { "diff-1": HASH },
    usage: { latencyMs: 12, promptTokens: 3, completionTokens: 4 },
    ...overrides
  };
}

function claimedStore() {
  const directory = mkdtempSync(join(tmpdir(), "acs-local-adv-"));
  const store = new SqliteWorkItemStore(join(directory, "control.db"));
  const workItem = store.create({
    title: "Consult",
    requester: "agent",
    intent: "ask the advisor",
    target: { cwd: "/repo" },
    requestedActions: [{ kind: "manual", description: "simulate" }],
    risk: "low"
  });
  store.approveWorkItem(workItem.id, transition);
  const claimed = store.claimNextApprovedWorkItem("worker-a", { allowLegacyClaimForTests: true });
  if (!claimed) throw new Error("expected a claim");
  store.enableAdvisorBinding(
    {
      subjectId: claimed.id,
      missionId: claimed.id,
      subjectKind: "work_item",
      executorModelId: "claude-sonnet-5",
      advisorModelId: "claude-opus-5-5",
      advisorTransportModel: "ollama:advisor",
      requireBeforeCompletion: false
    },
    transition
  );
  return { directory, store, claimed };
}

describe("recordLocalAdvisorConsultation", () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("writes through #367 insertAdvisorConsultation and derives asserted views from the record", () => {
    const fixture = claimedStore();
    directory = fixture.directory;
    const { store, claimed } = fixture;
    const advisorResponse = response({ missionId: claimed.id });

    const record = recordLocalAdvisorConsultation({
      response: advisorResponse,
      subjectId: claimed.id,
      missionId: claimed.id,
      subjectKind: "work_item",
      executorModelId: "claude-sonnet-5",
      advisorModelId: "claude-opus-5-5",
      fence: {
        kind: "work_item",
        workItemId: claimed.id,
        leaseId: claimed.leaseId,
        workerId: claimed.workerId,
        fencingEpoch: 0
      },
      store
    });

    expect(record.disposition).toBe("reviewed");
    expect(record.guidanceText).toContain("Missing failure-path test");
    expect(record.inputSha256).toBe("ab".repeat(32));
    expect(advisorAuditView(record)).not.toHaveProperty("guidanceText");
    expect(advisorAuditView(record)).not.toHaveProperty("trust");

    const finding = projectReviewFindingFromConsultation(record, {
      missionId: claimed.id,
      workItemId: claimed.id,
      inputHash: HASH,
      attemptId: "attempt-1",
      evidenceManifestHash: MANIFEST,
      reviewerPrincipalId: "local-advisor"
    });
    expect(finding?.verdict).toBe("UNKNOWN");
    expect(finding?.findings[0]?.summary).toContain("Missing failure-path test");

    const event = advisorTraceEventFromConsultation(record, {
      observedAt: new Date().toISOString(),
      authorizationOutcome: "evidence_only"
    });
    expect(event.integrity.trust).toBe("asserted");
    expect(isTrusted(event)).toBe(false);
    expect(event.facts.consultation_id).toBe(record.consultationId);
    expect(event.schema_version).toBeDefined();
  });

  it("maps insufficient evidence to declined without treating it as completion evidence", () => {
    const fixture = claimedStore();
    directory = fixture.directory;
    const draft = consultationDraftFromResponse(
      response({ status: "insufficient_evidence", reason: "no_evidence", verdict: undefined, findings: [] })
    );
    expect(draft).toMatchObject({ disposition: "declined", declineReason: "no_evidence", errorCode: null });
    const record = recordLocalAdvisorConsultation({
      response: response({
        missionId: fixture.claimed.id,
        status: "insufficient_evidence",
        reason: "no_evidence",
        verdict: undefined,
        findings: [],
        recommendedActions: []
      }),
      subjectId: fixture.claimed.id,
      missionId: fixture.claimed.id,
      subjectKind: "work_item",
      executorModelId: "claude-sonnet-5",
      advisorModelId: "claude-opus-5-5",
      fence: {
        kind: "work_item",
        workItemId: fixture.claimed.id,
        leaseId: fixture.claimed.leaseId,
        workerId: fixture.claimed.workerId,
        fencingEpoch: 0
      },
      store: fixture.store
    });
    expect(record.disposition).toBe("declined");
    expect(
      projectReviewFindingFromConsultation(record, {
        missionId: fixture.claimed.id,
        workItemId: fixture.claimed.id,
        inputHash: HASH,
        attemptId: "attempt-1",
        evidenceManifestHash: MANIFEST,
        reviewerPrincipalId: "local-advisor"
      })
    ).toBeNull();
  });

  it("maps provider failures to unavailable with a reused error code", () => {
    const draft = consultationDraftFromResponse(
      response({ status: "timeout", reason: "provider_timeout", verdict: undefined, findings: [] })
    );
    expect(draft).toMatchObject({ disposition: "unavailable", errorCode: "advisor_timeout" });
    expect(
      consultationDraftFromResponse(
        response({ status: "invalid_output", reason: "model_output_invalid", verdict: undefined, findings: [] })
      ).errorCode
    ).toBe("advisor_output_invalid");
  });
});
