import { describe, expect, it } from "vitest";
import { createReviewFinding, reviewVerdictSchema, verifyReviewFindingHash } from "./review-finding.js";

const H = (c: string) => c.repeat(64);

const base = {
  workItemId: "wrk_1",
  attemptId: "attempt_1",
  reviewerPrincipalId: "claude-reviewer",
  reviewerRole: "ADVISORY_REASONER" as const,
  reviewerProvider: "anthropic",
  evidenceManifestHash: H("e"),
  now: new Date("2026-08-30T00:00:00.000Z")
};

describe("ReviewFinding", () => {
  it("supports exactly PASS / NEEDS_CHANGES / BLOCK / UNKNOWN", () => {
    for (const verdict of ["PASS", "NEEDS_CHANGES", "BLOCK", "UNKNOWN"] as const) {
      const finding = createReviewFinding({
        ...base,
        verdict,
        findings: verdict === "BLOCK" ? [{ category: "correctness", severity: "high", summary: "race" }] : []
      });
      expect(finding.verdict).toBe(verdict);
      expect(verifyReviewFindingHash(finding)).toBe(true);
    }
    expect(reviewVerdictSchema.options).toEqual(["PASS", "NEEDS_CHANGES", "BLOCK", "UNKNOWN"]);
  });

  it("cannot mark execution successful — it has no such field or method", () => {
    const finding = createReviewFinding({ ...base, verdict: "PASS" });
    for (const forbidden of ["succeeded", "accept", "approve", "authorize", "transition", "execute"]) {
      expect(forbidden in finding).toBe(false);
    }
  });

  it("PASS is incoherent with reported high/critical findings", () => {
    expect(() =>
      createReviewFinding({
        ...base,
        verdict: "PASS",
        findings: [{ category: "security", severity: "critical", summary: "auth bypass" }]
      })
    ).toThrow(/PASS/);
  });

  it("BLOCK requires at least one finding", () => {
    expect(() => createReviewFinding({ ...base, verdict: "BLOCK", findings: [] })).toThrow(/BLOCK/);
  });

  it("only an ADVISORY_REASONER may author a finding", () => {
    expect(() => createReviewFinding({ ...base, reviewerRole: "CONTROL_AUTHORITY" as never, verdict: "PASS" })).toThrow(
      /ADVISORY_REASONER/
    );
  });

  it("is tamper-evident and references an exact evidence manifest", () => {
    const finding = createReviewFinding({ ...base, verdict: "NEEDS_CHANGES" });
    expect(finding.evidenceManifestHash).toBe(H("e"));
    expect(verifyReviewFindingHash({ ...finding, verdict: "PASS" })).toBe(false);
  });
});
