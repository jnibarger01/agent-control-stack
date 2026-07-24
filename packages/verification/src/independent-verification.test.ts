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

  it("refuses a request with a duplicate criterion id before ever calling the verifier", async () => {
    const verifier = fakeVerifier("claude-cli-verifier");
    const duplicated = [...criteria(), { id: "c1", description: "again", expected: "exit code 0" }];

    await expect(
      runIndependentVerification({
        implementerEngineId: "codex",
        verifier,
        criteria: duplicated,
        evidence: evidence()
      })
    ).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "verifier_criteria_duplicate_request" })
    );
  });

  it("refuses a result that silently drops a requested criterion", async () => {
    const verifier = fakeVerifier("claude-cli-verifier", { criteriaResults: [] });

    await expect(
      runIndependentVerification({
        implementerEngineId: "codex",
        verifier,
        criteria: criteria(),
        evidence: evidence()
      })
    ).rejects.toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "verifier_criteria_missing" }));
  });

  it("refuses a result that judges an unrequested criterion", async () => {
    const verifier = fakeVerifier("claude-cli-verifier", {
      criteriaResults: [
        { criterionId: "c1", satisfied: true, observed: "exit 0" },
        { criterionId: "c-never-asked-about", satisfied: true, observed: "made up" }
      ]
    });

    await expect(
      runIndependentVerification({
        implementerEngineId: "codex",
        verifier,
        criteria: criteria(),
        evidence: evidence()
      })
    ).rejects.toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "verifier_criteria_unknown" }));
  });

  it("refuses a result that judges the same criterion twice", async () => {
    const verifier = fakeVerifier("claude-cli-verifier", {
      criteriaResults: [
        { criterionId: "c1", satisfied: true, observed: "exit 0" },
        { criterionId: "c1", satisfied: false, observed: "actually no" }
      ]
    });

    await expect(
      runIndependentVerification({
        implementerEngineId: "codex",
        verifier,
        criteria: criteria(),
        evidence: evidence()
      })
    ).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "verifier_criteria_duplicate_result" })
    );
  });

  it("accepts a result that judges exactly the requested criteria, in any order", async () => {
    const twoCriteria: VerificationCriterion[] = [
      { id: "c1", description: "tests pass", expected: "exit code 0" },
      { id: "c2", description: "lint passes", expected: "exit code 0" }
    ];
    const verifier = fakeVerifier("claude-cli-verifier", {
      criteriaResults: [
        { criterionId: "c2", satisfied: true, observed: "exit 0" },
        { criterionId: "c1", satisfied: true, observed: "exit 0" }
      ]
    });

    const result = await runIndependentVerification({
      implementerEngineId: "codex",
      verifier,
      criteria: twoCriteria,
      evidence: evidence()
    });

    expect(result.criteriaResults).toHaveLength(2);
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
