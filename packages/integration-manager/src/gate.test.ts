import { describe, expect, it } from "vitest";
import { classifyFailure, evaluateGate } from "./gate.js";
import { pr } from "./fixtures.test-support.js";
import { DEFAULT_GATE_POLICY } from "./types.js";

const codes = (v: ReturnType<typeof evaluateGate>) => v.blockers.map((b) => b.code);

describe("evaluateGate", () => {
  it("passes a clean pull request", () => {
    expect(evaluateGate(pr({ number: 1 }), DEFAULT_GATE_POLICY)).toMatchObject({
      status: "eligible",
      blockers: [],
      pending: []
    });
  });

  it.each([
    ["draft", { isDraft: true }, "draft"],
    ["closed", { state: "CLOSED" as const }, "not_open"],
    ["merged", { state: "MERGED" as const }, "not_open"],
    ["fork", { isCrossRepository: true }, "fork_pull_request"],
    ["conflicting", { mergeable: "CONFLICTING" as const }, "conflicting"],
    ["changes requested", { reviewDecision: "CHANGES_REQUESTED" as const }, "changes_requested"],
    ["review required", { reviewDecision: "REVIEW_REQUIRED" as const }, "review_required"],
    ["unresolved threads", { unresolvedThreads: 2 }, "unresolved_threads"],
    [
      "failing check",
      { checks: [{ name: "test", status: "COMPLETED" as const, conclusion: "FAILURE" }] },
      "failing_checks"
    ],
    [
      "cancelled check",
      { checks: [{ name: "test", status: "COMPLETED" as const, conclusion: "CANCELLED" }] },
      "failing_checks"
    ],
    [
      "completed check with no conclusion",
      { checks: [{ name: "test", status: "COMPLETED" as const, conclusion: null }] },
      "failing_checks"
    ],
    [
      "gate policy modified",
      { changedFiles: [".github/workflows/jnibarger01-pr-review-merge.yml"] },
      "gate_policy_modified"
    ],
    ["truncated threads", { truncated: { threads: true, checks: false, files: false } }, "truncated_signals"],
    ["truncated checks", { truncated: { threads: false, checks: true, files: false } }, "truncated_signals"],
    ["truncated files", { truncated: { threads: false, checks: false, files: true } }, "truncated_signals"]
  ])("blocks: %s", (_name, overrides, code) => {
    const verdict = evaluateGate(pr({ number: 1, ...overrides }), DEFAULT_GATE_POLICY);
    expect(verdict.status).toBe("blocked");
    expect(codes(verdict)).toContain(code);
  });

  it("treats NEUTRAL and SKIPPED checks as passing", () => {
    const checks = [
      { name: "a", status: "COMPLETED" as const, conclusion: "NEUTRAL" },
      { name: "b", status: "COMPLETED" as const, conclusion: "SKIPPED" },
      { name: "c", status: "COMPLETED" as const, conclusion: "SUCCESS" }
    ];
    expect(evaluateGate(pr({ number: 1, checks }), DEFAULT_GATE_POLICY).status).toBe("eligible");
  });

  it("is pending, not eligible, while checks run or mergeability is unknown", () => {
    const running = evaluateGate(
      pr({ number: 1, checks: [{ name: "check", status: "IN_PROGRESS", conclusion: null }] }),
      DEFAULT_GATE_POLICY
    );
    expect(running).toMatchObject({ status: "pending", blockers: [] });
    expect(running.pending.map((p) => p.code)).toEqual(["checks_pending"]);
    expect(
      evaluateGate(pr({ number: 1, mergeable: "UNKNOWN" }), DEFAULT_GATE_POLICY).pending.map((p) => p.code)
    ).toEqual(["mergeable_unknown"]);
  });

  it("a hard blocker wins over pending", () => {
    const verdict = evaluateGate(
      pr({
        number: 1,
        isDraft: true,
        mergeable: "UNKNOWN",
        checks: [{ name: "t", status: "QUEUED", conclusion: null }]
      }),
      DEFAULT_GATE_POLICY
    );
    expect(verdict.status).toBe("blocked");
    expect(verdict.pending.length).toBe(2);
  });

  it("enforces an author allowlist and the fork option", () => {
    const policy = { ...DEFAULT_GATE_POLICY, allowedAuthors: ["jnibarger01"] };
    expect(evaluateGate(pr({ number: 1, author: "mallory" }), policy).blockers.map((b) => b.code)).toContain(
      "author_not_allowed"
    );
    expect(evaluateGate(pr({ number: 1 }), policy).status).toBe("eligible");
    expect(
      evaluateGate(pr({ number: 1, isCrossRepository: true }), { ...policy, allowForkPullRequests: true }).status
    ).toBe("eligible");
  });

  it("collects every blocker rather than stopping at the first", () => {
    const verdict = evaluateGate(
      pr({
        number: 1,
        isDraft: true,
        unresolvedThreads: 1,
        mergeable: "CONFLICTING",
        reviewDecision: "CHANGES_REQUESTED"
      }),
      DEFAULT_GATE_POLICY
    );
    expect(codes(verdict).sort()).toEqual(["changes_requested", "conflicting", "draft", "unresolved_threads"]);
  });

  it("warns, without blocking, when no checks are reported", () => {
    const verdict = evaluateGate(pr({ number: 1, checks: [] }), DEFAULT_GATE_POLICY);
    expect(verdict.status).toBe("eligible");
    expect(verdict.warnings).toEqual(["no checks reported for this pull request"]);
  });

  it("classifies failed checks by name as a triage hint", () => {
    const verdict = evaluateGate(
      pr({
        number: 1,
        checks: [
          { name: "CodeQL", status: "COMPLETED", conclusion: "FAILURE" },
          { name: "PR review and merge gate", status: "COMPLETED", conclusion: "FAILURE" },
          { name: "Vitest Tests", status: "COMPLETED", conclusion: "FAILURE" },
          { name: "mystery", status: "COMPLETED", conclusion: "TIMED_OUT" }
        ]
      }),
      DEFAULT_GATE_POLICY
    );
    expect(verdict.failedChecks).toEqual([
      { name: "CodeQL", category: "security" },
      { name: "PR review and merge gate", category: "review-gate" },
      { name: "Vitest Tests", category: "test" },
      { name: "mystery", category: "unknown" }
    ]);
    expect(classifyFailure("eslint")).toBe("lint");
    expect(classifyFailure("tsc -b")).toBe("typecheck");
    expect(classifyFailure("prettier --check")).toBe("format");
    expect(classifyFailure("Vercel")).toBe("deploy");
  });
});
