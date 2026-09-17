import { describe, expect, it } from "vitest";
import { createReviewFinding, type ReviewFinding } from "@agent-control-stack/advisory";
import {
  classifyReviewOutcome,
  evaluateVerificationRequirement,
  verificationPermitsSuccess
} from "./verification-policy.js";

const H = (c: string) => c.repeat(64);
const manifest = H("e");

function finding(principal: string, verdict: ReviewFinding["verdict"], provider = "anthropic"): ReviewFinding {
  return createReviewFinding({
    workItemId: "wrk_1",
    attemptId: "attempt_1",
    reviewerPrincipalId: principal,
    reviewerRole: "ADVISORY_REASONER",
    reviewerProvider: provider,
    evidenceManifestHash: manifest,
    verdict,
    findings:
      verdict === "BLOCK"
        ? [{ category: "correctness", severity: "high", summary: "auth race" }]
        : verdict === "NEEDS_CHANGES"
          ? [{ category: "style", severity: "low", summary: "rename" }]
          : []
  });
}

describe("evaluateVerificationRequirement", () => {
  it("read-only low risk needs no reviewer", () => {
    const req = evaluateVerificationRequirement({
      riskClass: "low",
      actionKinds: ["fs.read", "fs.list"],
      executorPrincipalId: "codex",
      executorProvider: "openai"
    });
    expect(req.reviewersRequired).toBe(0);
  });

  it("source-code mutation needs one independent reviewer", () => {
    const req = evaluateVerificationRequirement({
      riskClass: "medium",
      actionKinds: ["fs.write"],
      executorPrincipalId: "codex",
      executorProvider: "openai"
    });
    expect(req.reviewersRequired).toBe(1);
    expect(req.requireIndependentPrincipal).toBe(true);
  });

  it("destructive / high risk needs two reviewers and human escalation", () => {
    const req = evaluateVerificationRequirement({
      riskClass: "high",
      actionKinds: ["shell"],
      executorPrincipalId: "codex",
      executorProvider: "openai"
    });
    expect(req.reviewersRequired).toBe(2);
    expect(req.requireIndependentProvider).toBe(true);
    expect(req.conflictResolution).toBe("human_approval");
    expect(req.humanEscalationRiskClasses).toContain("high");
  });
});

describe("classifyReviewOutcome — disagreement is explicit, never silent", () => {
  const req1 = evaluateVerificationRequirement({
    riskClass: "medium",
    actionKinds: ["fs.write"],
    executorPrincipalId: "codex",
    executorProvider: "openai"
  });

  it("no reviewer required -> pass", () => {
    const req0 = evaluateVerificationRequirement({
      riskClass: "low",
      actionKinds: ["fs.read"],
      executorPrincipalId: "codex",
      executorProvider: "openai"
    });
    expect(classifyReviewOutcome([], req0).outcome).toBe("pass");
  });

  it("too few independent reviewers -> insufficient_reviews (not pass)", () => {
    const r = classifyReviewOutcome([], req1, { executorPrincipalId: "codex" });
    expect(r.outcome).toBe("insufficient_reviews");
    expect(verificationPermitsSuccess(r.outcome)).toBe(false);
  });

  it("the executor's own finding does not count toward an independent requirement", () => {
    const self = classifyReviewOutcome([finding("codex", "PASS")], req1, { executorPrincipalId: "codex" });
    expect(self.outcome).toBe("insufficient_reviews");
  });

  it("one independent PASS -> pass", () => {
    const r = classifyReviewOutcome([finding("claude", "PASS")], req1, { executorPrincipalId: "codex" });
    expect(r.outcome).toBe("pass");
    expect(verificationPermitsSuccess(r.outcome)).toBe(true);
  });

  it("conflicting findings (PASS vs NEEDS_CHANGES) -> disputed, never a silent pick", () => {
    const req2 = evaluateVerificationRequirement({
      riskClass: "high",
      actionKinds: ["shell"],
      executorPrincipalId: "codex",
      executorProvider: "openai"
    });
    const r = classifyReviewOutcome(
      [finding("claude", "PASS", "anthropic"), finding("gemini", "NEEDS_CHANGES", "google")],
      req2,
      { executorPrincipalId: "codex", executorProvider: "openai" }
    );
    expect(r.outcome).toBe("disputed");
    expect(r.nextStep).toBe("human_approval");
    expect(verificationPermitsSuccess(r.outcome)).toBe(false);
  });

  it("any BLOCK -> blocked, regardless of other PASS votes", () => {
    const req2 = evaluateVerificationRequirement({
      riskClass: "high",
      actionKinds: ["shell"],
      executorPrincipalId: "codex",
      executorProvider: "openai"
    });
    const r = classifyReviewOutcome(
      [finding("claude", "PASS", "anthropic"), finding("gemini", "BLOCK", "google")],
      req2,
      { executorPrincipalId: "codex", executorProvider: "openai" }
    );
    expect(r.outcome).toBe("blocked");
  });

  it("any UNKNOWN -> unknown (not pass)", () => {
    const r = classifyReviewOutcome([finding("claude", "UNKNOWN")], req1, { executorPrincipalId: "codex" });
    expect(r.outcome).toBe("unknown");
    expect(verificationPermitsSuccess(r.outcome)).toBe(false);
  });
});
