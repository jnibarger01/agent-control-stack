export interface PromotionGateResult {
  promoted: boolean;
  failures: string[];
  remediation: string[];
  failureCode: string | null;
}

const requiredGates = [
  "head_sha_verified",
  "worktree_clean",
  "tests_passed",
  "typecheck_passed",
  "lint_passed",
  "secret_scan_passed",
  "unexpected_diff",
  "reviewer_approved",
  "approval_recorded",
  "trace_recorded"
] as const;

const remediation: Record<string, string> = {
  head_sha_verified: "Re-resolve and compare the tested SHA at merge time.",
  worktree_clean: "Verify the scoped worktree is clean before promotion.",
  tests_passed: "Run the repository test command and record its exit code.",
  typecheck_passed: "Run typecheck and record its exit code.",
  lint_passed: "Run lint and record its exit code.",
  secret_scan_passed: "Run a secret scan on the scoped diff.",
  unexpected_diff: "Quarantine unrelated changes before promotion.",
  reviewer_approved: "Obtain independent reviewer approval.",
  approval_recorded: "Record the required human approval.",
  trace_recorded: "Record the full audit trace.",
  gate_missing_evidence: "Supply every required gate as an explicit boolean."
};

/** Native, fail-closed evaluation gate; historical AgentOS contracts are not a runtime dependency. */
export function evaluatePromotionGate(evidence: unknown): PromotionGateResult {
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) {
    return fail(["gate_missing_evidence"]);
  }
  const values = { ...(evidence as Record<string, unknown>) };
  for (const gate of requiredGates) {
    if (typeof values[gate] !== "boolean") return fail(["gate_missing_evidence"]);
  }
  if (
    "head_sha_expected" in values ||
    "head_sha_actual" in values
  ) {
    const expected = values.head_sha_expected;
    const actual = values.head_sha_actual;
    if (typeof expected !== "string" || typeof actual !== "string" || !/^[0-9a-f]{7,40}$/u.test(expected) || expected !== actual) {
      values.head_sha_verified = false;
    }
  }
  for (const [gate, code] of [
    ["tests_passed", "tests_exit_code"],
    ["typecheck_passed", "typecheck_exit_code"],
    ["lint_passed", "lint_exit_code"]
  ] as const) {
    if (code in values && values[code] !== 0) values[gate] = false;
  }
  if ("trace_id" in values && !(typeof values.trace_id === "string" && values.trace_id.length >= 6)) {
    values.trace_recorded = false;
  }
  const failures = requiredGates.filter((gate) => (gate === "unexpected_diff" ? values[gate] !== false : values[gate] !== true));
  return failures.length === 0
    ? { promoted: true, failures: [], remediation: [], failureCode: null }
    : fail(failures);
}

function fail(failures: string[]): PromotionGateResult {
  const failureCode =
    failures.includes("gate_missing_evidence")
      ? "gate_missing_evidence"
      : failures.includes("trace_recorded")
        ? "trace_missing"
        : failures.includes("approval_recorded")
          ? "approval_required"
          : failures.includes("secret_scan_passed")
            ? "secret_detected"
            : failures.includes("unexpected_diff")
              ? "unexpected_diff"
              : failures.includes("worktree_clean")
                ? "dirty_worktree"
                : failures.includes("tests_passed")
                  ? "test_failed"
                  : failures.includes("typecheck_passed")
                    ? "typecheck_failed"
                    : failures.includes("lint_passed")
                      ? "lint_failed"
                      : "policy_blocked";
  return {
    promoted: false,
    failures,
    remediation: failures.map((failure) => `${failure}: ${remediation[failure] ?? remediation.gate_missing_evidence}`),
    failureCode
  };
}
