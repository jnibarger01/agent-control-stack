import {
  DEFAULT_GATE_POLICY,
  evaluateGate,
  type GatePolicy,
  type PullRequestSnapshot
} from "@agent-control-stack/integration-manager";
import { outcomeHash } from "./canonical.js";
import type { Criterion, EvidenceGrade, EvidenceRef, ProbeResult } from "./domain.js";

export interface ProbeContext {
  grade: EvidenceGrade;
  evidence: EvidenceRef[];
}

/** Files the maker's own diff could alter to weaken its verifier. Touching any is a human decision. */
export const VERIFICATION_SURFACE_V1: readonly string[] = [
  ".github/workflows/**",
  ".github/instructions/**",
  ".github/CODEOWNERS",
  "vitest.config.ts",
  "eslint.config.js",
  ".gitleaks.toml",
  "scripts/check-*.mjs",
  "tsconfig.base.json"
];

const MAX_LISTED_PATHS = 50;

/** `**` crosses directories, `*` and `?` do not. Anything else is literal. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i] as string;
    if (char === "*") {
      let j = i;
      while (glob[j + 1] === "*") j += 1;
      if (j > i) {
        source += ".*";
        i = j;
        if (glob[i + 1] === "/") i += 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "u");
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/** The exact docs-only rule of `.github/workflows/check.yml`: every changed file ends in .md or starts with docs/. */
export function isDocsOnly(changedFiles: readonly string[]): boolean {
  return changedFiles.length > 0 && changedFiles.every((file) => file.endsWith(".md") || file.startsWith("docs/"));
}

const result = (
  criterion: Pick<Criterion, "id" | "kind">,
  ctx: ProbeContext,
  state: ProbeResult["state"],
  reasonCodes: string[],
  findings: string[] = []
): ProbeResult => ({
  criterionId: criterion.id,
  kind: criterion.kind,
  state,
  reasonCodes: [...new Set(reasonCodes)].sort(),
  findings,
  evidence: ctx.evidence
});

function listPaths(paths: readonly string[]): string[] {
  const shown = paths.slice(0, MAX_LISTED_PATHS);
  return paths.length > shown.length
    ? [...shown, `+${paths.length - shown.length} more (sha256 ${outcomeHash("paths", paths).slice(0, 16)})`]
    : shown;
}

function probePrOpen(criterion: Criterion, pr: PullRequestSnapshot, ctx: ProbeContext): ProbeResult {
  return pr.state === "OPEN"
    ? result(criterion, ctx, "satisfied", [])
    : result(criterion, ctx, "unsatisfied", ["pr_not_open"], [`pull request is ${pr.state}`]);
}

function probeMergeGate(
  criterion: Extract<Criterion, { kind: "merge_gate_eligible" }>,
  pr: PullRequestSnapshot,
  ctx: ProbeContext
): ProbeResult {
  const assessment = criterion.policy === "assessment";
  const policy: GatePolicy = assessment ? { ...DEFAULT_GATE_POLICY, allowedAuthors: undefined } : DEFAULT_GATE_POLICY;
  const gate = evaluateGate(pr, policy);
  const findings: string[] = [];
  let blockers = gate.blockers;
  if (assessment) {
    const ignored = blockers.filter((blocker) => blocker.code === "draft" || blocker.code === "author_not_allowed");
    blockers = blockers.filter((blocker) => blocker.code !== "draft" && blocker.code !== "author_not_allowed");
    if (ignored.some((blocker) => blocker.code === "draft")) findings.push("draft_ignored_in_assessment");
    findings.push("author_not_checked_in_assessment");
  }
  if (blockers.some((blocker) => blocker.code === "truncated_signals")) {
    return result(criterion, ctx, "undecided", ["evidence_unavailable", "truncated_signals"], findings);
  }
  if (blockers.length > 0) {
    return result(
      criterion,
      ctx,
      "unsatisfied",
      blockers.map((blocker) => blocker.code),
      [...findings, ...blockers.map((blocker) => `${blocker.code}: ${blocker.detail}`)]
    );
  }
  if (gate.pending.length > 0 || (assessment && gate.status === "pending")) {
    return result(
      criterion,
      ctx,
      "undecided",
      ["pending_external", ...gate.pending.map((entry) => entry.code)],
      findings
    );
  }
  const anySuccess = pr.checks.some((check) => check.status === "COMPLETED" && check.conclusion === "SUCCESS");
  if (!anySuccess) {
    return result(
      criterion,
      ctx,
      "undecided",
      ["evidence_unavailable", "no_successful_check"],
      [
        ...findings,
        "gate reports eligible but no check completed with SUCCESS; skipped or neutral checks prove nothing"
      ]
    );
  }
  return result(criterion, ctx, "satisfied", [], findings);
}

const FAILED_CONCLUSIONS = new Set([
  "FAILURE",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "ERROR"
]);

function probeRequiredChecks(
  criterion: Extract<Criterion, { kind: "required_checks_succeeded" }>,
  pr: PullRequestSnapshot,
  ctx: ProbeContext
): ProbeResult {
  const findings: string[] = [];
  const codes: string[] = [];
  let unsatisfied = false;
  let pendingExternal = false;
  let ambiguous = false;
  let missing = false;
  if (pr.checksCommitSha === undefined || pr.checksCommitSha !== pr.headSha) {
    return result(
      criterion,
      ctx,
      "undecided",
      ["evidence_unavailable", "checks_not_bound_to_head"],
      ["the check rollup is not known to belong to the head commit"]
    );
  }
  for (const pinned of criterion.checks) {
    const matches = pr.checks.filter((check) => check.name === pinned.name);
    if (matches.length === 0) {
      missing = true;
      findings.push(`check_missing: ${pinned.name}`);
      continue;
    }
    if (matches.some((check) => check.source !== "check_run" || check.appSlug !== pinned.appSlug)) {
      ambiguous = true;
      findings.push(`check_name_ambiguous: ${pinned.name} is also reported by another source`);
      continue;
    }
    for (const check of matches) {
      if (check.status !== "COMPLETED") {
        pendingExternal = true;
        findings.push(`pending: ${pinned.name} is ${check.status}`);
      } else if (check.conclusion === "SUCCESS") {
        continue;
      } else if (check.conclusion !== null && FAILED_CONCLUSIONS.has(check.conclusion)) {
        unsatisfied = true;
        findings.push(`failed: ${pinned.name} concluded ${check.conclusion}`);
      } else {
        pendingExternal = true;
        findings.push(`not_success: ${pinned.name} concluded ${check.conclusion ?? "nothing"}`);
      }
    }
  }
  // A trusted contradiction is never hidden by an undecided item.
  if (unsatisfied) return result(criterion, ctx, "unsatisfied", ["required_check_failed"], findings);
  if (ambiguous) codes.push("needs_human", "check_name_ambiguous");
  if (missing) codes.push("evidence_unavailable", "check_missing");
  if (pendingExternal) codes.push("pending_external");
  if (codes.length > 0) return result(criterion, ctx, "undecided", codes, findings);
  if (isDocsOnly(pr.changedFiles)) {
    if (!criterion.docsOnlyAcceptable) {
      return result(
        criterion,
        ctx,
        "undecided",
        ["needs_human", "fast_path_no_runtime_validation"],
        [
          "every changed file is documentation, so the repository check ran its docs-only fast path and no runtime validation"
        ]
      );
    }
    findings.push("docs_only_accepted");
  }
  return result(
    criterion,
    ctx,
    "satisfied",
    [],
    [...findings, "GitHub reports each pinned check run from its pinned app concluded SUCCESS on the head commit"]
  );
}

function probeFilesWithinScope(
  criterion: Extract<Criterion, { kind: "files_within_scope" }>,
  pr: PullRequestSnapshot,
  ctx: ProbeContext
): ProbeResult {
  const violating = pr.changedFiles.filter(
    (file) => matchesAny(file, criterion.forbidGlobs) || !matchesAny(file, criterion.allowGlobs)
  );
  return violating.length === 0
    ? result(criterion, ctx, "satisfied", [])
    : result(criterion, ctx, "unsatisfied", ["files_out_of_scope"], listPaths(violating));
}

function probeVerificationSurface(criterion: Criterion, pr: PullRequestSnapshot, ctx: ProbeContext): ProbeResult {
  const touched = pr.changedFiles.filter((file) => matchesAny(file, VERIFICATION_SURFACE_V1));
  return touched.length === 0
    ? result(criterion, ctx, "satisfied", [])
    : result(criterion, ctx, "undecided", ["needs_human", "verification_surface_modified"], listPaths(touched));
}

/** Pure. Any thrown error becomes undecided(probe_error): a probe can never satisfy by failing. */
export function runProbe(criterion: Criterion, pr: PullRequestSnapshot, ctx: ProbeContext): ProbeResult {
  try {
    switch (criterion.kind) {
      case "pr_open":
        return probePrOpen(criterion, pr, ctx);
      case "merge_gate_eligible":
        return probeMergeGate(criterion, pr, ctx);
      case "required_checks_succeeded":
        return probeRequiredChecks(criterion, pr, ctx);
      case "files_within_scope":
        return probeFilesWithinScope(criterion, pr, ctx);
      case "verification_surface_untouched":
        return probeVerificationSurface(criterion, pr, ctx);
    }
  } catch {
    return result(criterion, ctx, "undecided", ["probe_error"], ["probe raised an error"]);
  }
}

/** Hash over every field the probes and gates decide on, so two reads of an unchanged pull request hash identically. */
export function snapshotHash(pr: PullRequestSnapshot): string {
  return outcomeHash("snapshot", {
    number: pr.number,
    state: pr.state,
    isDraft: pr.isDraft,
    isCrossRepository: pr.isCrossRepository,
    author: pr.author,
    headRef: pr.headRef,
    headSha: pr.headSha,
    baseRef: pr.baseRef,
    baseRefOid: pr.baseRefOid ?? null,
    checksCommitSha: pr.checksCommitSha ?? null,
    mergeable: pr.mergeable,
    reviewDecision: pr.reviewDecision,
    unresolvedThreads: pr.unresolvedThreads,
    // GitHub returns checks in no guaranteed order and every probe treats them as a set, so order is not a change.
    checks: pr.checks
      .map((check) => ({
        name: check.name,
        status: check.status,
        conclusion: check.conclusion,
        appSlug: check.appSlug ?? null,
        source: check.source ?? null
      }))
      .map((check) => ({ check, key: JSON.stringify(check) }))
      .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
      .map(({ check }) => check),
    changedFiles: [...pr.changedFiles].sort(),
    truncated: pr.truncated
  });
}
