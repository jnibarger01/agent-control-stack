import type {
  CheckSnapshot,
  FailureCategory,
  GateBlockerCode,
  GateFinding,
  GatePendingCode,
  GatePolicy,
  GateVerdict,
  PullRequestSnapshot
} from "./types.js";

const PASSING_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/**
 * Best-effort category from a check's name. It is a hint for triage, not a diagnosis: nothing here reads logs.
 */
export function classifyFailure(name: string): FailureCategory {
  const n = name.toLowerCase();
  if (/codeql|security|gitguardian|secret|audit|dependabot/.test(n)) return "security";
  if (/review|merge gate|gate/.test(n)) return "review-gate";
  if (/typecheck|tsc|type-check/.test(n)) return "typecheck";
  if (/lint|eslint/.test(n)) return "lint";
  if (/format|prettier/.test(n)) return "format";
  if (/deploy|vercel|release/.test(n)) return "deploy";
  if (/build|compile/.test(n)) return "build";
  if (/test|vitest|e2e|suite|check/.test(n)) return "test";
  return "unknown";
}

function checkIsPending(check: CheckSnapshot): boolean {
  return check.status !== "COMPLETED";
}

function checkIsFailing(check: CheckSnapshot): boolean {
  return check.status === "COMPLETED" && !PASSING_CONCLUSIONS.has(check.conclusion ?? "");
}

/**
 * Mirrors the repository's review-and-merge gate and adds the source-integrity rules from the mission: draft, forks,
 * author allowlist, changes to the gate policy itself, conflicts, requested changes, required review, unresolved
 * threads, and any check that is not SUCCESS, NEUTRAL or SKIPPED. Truncated signals are a blocker, never ignored.
 * Pure: no I/O. A verdict of `eligible` never means "merge it"; the repository gate still decides.
 */
export function evaluateGate(pr: PullRequestSnapshot, policy: GatePolicy): GateVerdict {
  const blockers: Array<GateFinding<GateBlockerCode>> = [];
  const pending: Array<GateFinding<GatePendingCode>> = [];
  const warnings: string[] = [];
  const block = (code: GateBlockerCode, detail: string) => blockers.push({ code, detail });

  if (pr.state !== "OPEN") block("not_open", `pull request is ${pr.state}`);
  if (pr.isDraft) block("draft", "pull request is a draft");
  if (pr.isCrossRepository && !policy.allowForkPullRequests) {
    block("fork_pull_request", "pull request head is in another repository");
  }
  if (policy.allowedAuthors && !policy.allowedAuthors.includes(pr.author)) {
    block("author_not_allowed", `author ${pr.author} is not on the allowlist`);
  }
  const touched = pr.changedFiles.filter((file) => policy.protectedPaths.includes(file));
  if (touched.length > 0) block("gate_policy_modified", `changes the merge policy itself: ${touched.join(", ")}`);
  const truncated = Object.entries(pr.truncated)
    .filter(([, cut]) => cut)
    .map(([what]) => what);
  if (truncated.length > 0) {
    block("truncated_signals", `source returned partial ${truncated.join(", ")}; a partial view is never treated as clean`);
  }
  if (pr.mergeable === "CONFLICTING") block("conflicting", "GitHub reports merge conflicts");
  if (pr.reviewDecision === "CHANGES_REQUESTED") block("changes_requested", "a review requests changes");
  if (pr.reviewDecision === "REVIEW_REQUIRED") block("review_required", "branch protection requires a review");
  if (pr.unresolvedThreads > 0) {
    block("unresolved_threads", `${pr.unresolvedThreads} review thread(s) remain unresolved`);
  }

  const failing = pr.checks.filter(checkIsFailing);
  if (failing.length > 0) {
    block("failing_checks", `${failing.length} check(s) are failing or cancelled: ${failing.map((c) => c.name).join(", ")}`);
  }
  const waiting = pr.checks.filter(checkIsPending);
  if (waiting.length > 0) {
    pending.push({ code: "checks_pending", detail: `${waiting.length} check(s) have not finished: ${waiting.map((c) => c.name).join(", ")}` });
  }
  if (pr.mergeable === "UNKNOWN") {
    pending.push({ code: "mergeable_unknown", detail: "GitHub has not computed mergeability yet" });
  }
  if (pr.checks.length === 0) warnings.push("no checks reported for this pull request");

  return {
    status: blockers.length > 0 ? "blocked" : pending.length > 0 ? "pending" : "eligible",
    blockers,
    pending,
    warnings,
    failedChecks: failing.map((check) => ({ name: check.name, category: classifyFailure(check.name) }))
  };
}
