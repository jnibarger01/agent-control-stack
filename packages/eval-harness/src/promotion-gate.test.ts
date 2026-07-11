import { describe, expect, it } from "vitest";
import { evaluatePromotionGate } from "./promotion-gate.js";

function passingEvidence() {
  return {
    head_sha_verified: true,
    worktree_clean: true,
    tests_passed: true,
    typecheck_passed: true,
    lint_passed: true,
    secret_scan_passed: true,
    unexpected_diff: false,
    reviewer_approved: true,
    approval_recorded: true,
    trace_recorded: true,
    head_sha_expected: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    head_sha_actual: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    tests_exit_code: 0,
    typecheck_exit_code: 0,
    lint_exit_code: 0,
    trace_id: "trace-abc-000001"
  };
}

describe("agentos promotion gate", () => {
  it("promotes only when the shared gate passes", () => {
    expect(evaluatePromotionGate(passingEvidence()).promoted).toBe(true);
  });

  it("blocks when merge-time SHA differs from tested SHA", () => {
    const result = evaluatePromotionGate({
      ...passingEvidence(),
      head_sha_actual: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    });

    expect(result.promoted).toBe(false);
    expect(result.failures).toContain("head_sha_verified");
  });

  it("fails closed when required gate evidence is missing", () => {
    const evidence = passingEvidence() as Record<string, unknown>;
    delete evidence.trace_recorded;

    const result = evaluatePromotionGate(evidence);

    expect(result.promoted).toBe(false);
    expect(result.failure_code).toBe("gate_missing_evidence");
  });
});
