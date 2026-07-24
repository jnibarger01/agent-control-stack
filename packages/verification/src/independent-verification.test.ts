import { ControlStackError } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import { runIndependentVerification, workItemOutcomeForVerdict } from "./independent-verification.js";
import type { Verifier, VerificationCriterion, VerificationEvidence, VerificationResult } from "./types.js";

function criteria(): VerificationCriterion[] {
  return [{ id: "c1", description: "tests pass", expected: "exit code 0" }];
}

function evidence(): VerificationEvidence {
  return {
    workItemId: "wrk_test",
    implementerClaim: "I ran the tests and they passed",
    diffSummary: "no changes",
    commandResults: []
  };
}

function fakeVerifier(engineId: string, resultOverride: Partial<VerificationResult> = {}): Verifier {
  return {
    engineId,
    async verify(): Promise<VerificationResult> {
      return {
        verdict: "pass",
        summary: "looks good",
        criteriaResults: [{ criterionId: "c1", satisfied: true, observed: "exit 0" }],
        verifierEngineId: engineId,
        durationMs: 1,
        ...resultOverride
      };
    }
  };
}

describe("runIndependentVerification", () => {
  it("refuses to verify when the verifier's identity matches the implementer's", async () => {
    const verifier = fakeVerifier("codex");

    await expect(
      runIndependentVerification({
        implementerEngineId: "codex",
        verifier,
        criteria: criteria(),
        evidence: evidence()
      })
    ).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "verifier_identity_collision" })
    );
  });

  it("succeeds when the verifier's identity genuinely differs from the implementer's", async () => {
    const verifier = fakeVerifier("claude-cli-verifier");

    const result = await runIndependentVerification({
      implementerEngineId: "codex",
      verifier,
      criteria: criteria(),
      evidence: evidence()
    });

    expect(result.verdict).toBe("pass");
  });

  it("catches a verifier that lies about its own identity in the result", async () => {
    const verifier = fakeVerifier("claude-cli-verifier", { verifierEngineId: "codex" });

    await expect(
      runIndependentVerification({
        implementerEngineId: "codex",
        verifier,
        criteria: criteria(),
        evidence: evidence()
      })
    ).rejects.toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "verifier_identity_mismatch" }));
  });
});

describe("workItemOutcomeForVerdict", () => {
  it("never maps inconclusive to succeeded", () => {
    expect(workItemOutcomeForVerdict("inconclusive")).toBe("quarantined");
    expect(workItemOutcomeForVerdict("inconclusive")).not.toBe("succeeded");
  });

  it("maps pass to succeeded and fail to failed", () => {
    expect(workItemOutcomeForVerdict("pass")).toBe("succeeded");
    expect(workItemOutcomeForVerdict("fail")).toBe("failed");
  });
});
