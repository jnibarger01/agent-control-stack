import { describe, expect, it } from "vitest";
import type { Criterion, EvidenceRef } from "./domain.js";
import { HEAD, makeSnapshot } from "./fixtures.test-support.js";
import { VERIFICATION_SURFACE_V1, globToRegExp, isDocsOnly, matchesAny, runProbe, snapshotHash } from "./probes.js";

const evidence: EvidenceRef[] = [{ grade: "forge_attested", source: "github:o/r#7@aaaaaaaaaaaa", digest: "d" }];
const ctx = { grade: "forge_attested" as const, evidence };
const run = (criterion: Criterion, overrides = {}) => runProbe(criterion, makeSnapshot(overrides), ctx);

const gate = (policy: "repo_default" | "assessment" = "assessment"): Criterion => ({
  id: "g",
  kind: "merge_gate_eligible",
  required: true,
  policy
});
const checks = (docsOnlyAcceptable = false, appSlug = "github-actions"): Criterion => ({
  id: "c",
  kind: "required_checks_succeeded",
  required: true,
  checks: [{ name: "check", appSlug }],
  docsOnlyAcceptable
});
const check = (over: Record<string, unknown>) => ({
  name: "check",
  status: "COMPLETED",
  conclusion: "SUCCESS",
  appSlug: "github-actions",
  source: "check_run",
  ...over
});

describe("glob matching", () => {
  it("** crosses directories, * and ? do not, everything else is literal", () => {
    expect(globToRegExp("src/**").test("src/a/b.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(globToRegExp("scripts/check-*.mjs").test("scripts/check-x.mjs")).toBe(true);
    expect(globToRegExp("a?c").test("a/c")).toBe(false);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
    expect(matchesAny(".github/CODEOWNERS", VERIFICATION_SURFACE_V1)).toBe(true);
  });
  it("detects the docs-only rule of check.yml exactly", () => {
    expect(isDocsOnly(["README.md", "docs/x.png"])).toBe(true);
    expect(isDocsOnly(["README.md", "src/a.ts"])).toBe(false);
    expect(isDocsOnly([])).toBe(false);
  });
});

describe("pr_open", () => {
  const open: Criterion = { id: "o", kind: "pr_open", required: true };
  it("is satisfied only while open", () => {
    expect(run(open).state).toBe("satisfied");
    expect(run(open, { state: "MERGED" })).toMatchObject({ state: "unsatisfied", reasonCodes: ["pr_not_open"] });
  });
});

describe("merge_gate_eligible", () => {
  it("is satisfied when eligible with a successful check", () => {
    expect(run(gate()).state).toBe("satisfied");
  });
  it("zero checks, or only skipped or neutral checks, prove nothing", () => {
    expect(run(gate(), { checks: [] })).toMatchObject({
      state: "undecided",
      reasonCodes: expect.arrayContaining(["evidence_unavailable"])
    });
    expect(
      run(gate(), { checks: [check({ conclusion: "SKIPPED" }), check({ name: "n", conclusion: "NEUTRAL" })] as never })
        .state
    ).toBe("undecided");
  });
  it("pending checks are undecided pending_external, failing checks unsatisfied", () => {
    expect(run(gate(), { checks: [check({ status: "IN_PROGRESS", conclusion: null })] as never })).toMatchObject({
      state: "undecided",
      reasonCodes: expect.arrayContaining(["pending_external"])
    });
    expect(run(gate(), { checks: [check({ conclusion: "FAILURE" })] as never })).toMatchObject({
      state: "unsatisfied",
      reasonCodes: ["failing_checks"]
    });
  });
  it("hard blockers stay hard under the assessment policy", () => {
    for (const [over, code] of [
      [{ mergeable: "CONFLICTING" }, "conflicting"],
      [{ reviewDecision: "CHANGES_REQUESTED" }, "changes_requested"],
      [{ reviewDecision: "REVIEW_REQUIRED" }, "review_required"],
      [{ unresolvedThreads: 2 }, "unresolved_threads"],
      [{ isCrossRepository: true }, "fork_pull_request"],
      [{ changedFiles: [".github/workflows/jnibarger01-pr-review-merge.yml"] }, "gate_policy_modified"]
    ] as const) {
      expect(run(gate(), over)).toMatchObject({ state: "unsatisfied", reasonCodes: [code] });
    }
  });
  it("assessment ignores draft and author, and says so; repo_default does not", () => {
    const draft = run(gate(), { isDraft: true });
    expect(draft.state).toBe("satisfied");
    expect(draft.findings).toEqual(
      expect.arrayContaining(["draft_ignored_in_assessment", "author_not_checked_in_assessment"])
    );
    expect(run(gate("repo_default"))).toMatchObject({ state: "unsatisfied" });
  });
  it("truncated signals are unavailable evidence, not a failure", () => {
    expect(run(gate(), { truncated: { threads: false, checks: true, files: false } })).toMatchObject({
      state: "undecided",
      reasonCodes: expect.arrayContaining(["truncated_signals"])
    });
  });
  it("unknown mergeability is pending", () => {
    expect(run(gate(), { mergeable: "UNKNOWN" }).state).toBe("undecided");
  });
});

describe("required_checks_succeeded", () => {
  it("is satisfied by the pinned check from the pinned app", () => {
    expect(run(checks()).state).toBe("satisfied");
  });
  it("a same-named check from another app, or a commit status, is ambiguous and needs a human", () => {
    expect(run(checks(), { checks: [check({}), check({ appSlug: "evil-app" })] as never })).toMatchObject({
      state: "undecided",
      reasonCodes: expect.arrayContaining(["check_name_ambiguous", "needs_human"])
    });
    expect(run(checks(), { checks: [check({ source: "status_context", appSlug: null })] as never }).state).toBe(
      "undecided"
    );
    expect(run(checks(false, "other-app")).state).toBe("undecided");
  });
  it("a missing check is unavailable evidence", () => {
    expect(run(checks(), { checks: [] })).toMatchObject({
      state: "undecided",
      reasonCodes: expect.arrayContaining(["check_missing"])
    });
  });
  it("a leftover failure beside a rerun success is unsatisfied", () => {
    expect(run(checks(), { checks: [check({ conclusion: "FAILURE" }), check({})] as never }).state).toBe("unsatisfied");
  });
  it("a failure is not hidden by a pending sibling check", () => {
    const two: Criterion = {
      ...(checks() as Extract<Criterion, { kind: "required_checks_succeeded" }>),
      checks: [
        { name: "check", appSlug: "github-actions" },
        { name: "b", appSlug: "github-actions" }
      ]
    };
    expect(
      run(two, {
        checks: [check({ conclusion: "TIMED_OUT" }), check({ name: "b", status: "QUEUED", conclusion: null })] as never
      }).state
    ).toBe("unsatisfied");
  });
  it("a rollup that does not belong to the head commit is not evidence", () => {
    expect(run(checks(), { checksCommitSha: "c".repeat(40) })).toMatchObject({
      state: "undecided",
      reasonCodes: expect.arrayContaining(["checks_not_bound_to_head"])
    });
    expect(run(checks(), { checksCommitSha: undefined })).toMatchObject({ state: "undecided" });
  });
  it("docs-only changes ran no runtime validation unless the criterion accepts that", () => {
    expect(run(checks(), { changedFiles: ["README.md"] })).toMatchObject({
      state: "undecided",
      reasonCodes: expect.arrayContaining(["fast_path_no_runtime_validation"])
    });
    expect(run(checks(true), { changedFiles: ["README.md"] })).toMatchObject({ state: "satisfied" });
  });
});

describe("files_within_scope and verification_surface_untouched", () => {
  const scope = (allowGlobs: string[], forbidGlobs: string[] = []): Criterion => ({
    id: "f",
    kind: "files_within_scope",
    required: true,
    allowGlobs,
    forbidGlobs
  });
  it("flags files outside allow or inside forbid, listing at most 50", () => {
    expect(run(scope(["packages/**"])).state).toBe("satisfied");
    expect(run(scope(["docs/**"]))).toMatchObject({ state: "unsatisfied", reasonCodes: ["files_out_of_scope"] });
    expect(run(scope(["**"], ["packages/x/**"])).state).toBe("unsatisfied");
    const many = Array.from({ length: 80 }, (_, i) => `z/${i}.ts`);
    const out = run(scope(["docs/**"]), { changedFiles: many });
    expect(out.findings).toHaveLength(51);
  });
  it("touching the verification surface needs a human", () => {
    const surface: Criterion = { id: "v", kind: "verification_surface_untouched", required: true };
    expect(run(surface).state).toBe("satisfied");
    expect(run(surface, { changedFiles: ["vitest.config.ts"] })).toMatchObject({
      state: "undecided",
      reasonCodes: expect.arrayContaining(["needs_human", "verification_surface_modified"])
    });
  });
});

describe("runProbe safety and snapshotHash", () => {
  it("a throwing probe is undecided probe_error, never satisfied", () => {
    const broken = { id: "g", kind: "merge_gate_eligible", required: true, policy: "assessment" } as Criterion;
    const pr = makeSnapshot();
    Object.defineProperty(pr, "checks", {
      get() {
        throw new Error("boom");
      }
    });
    expect(runProbe(broken, pr, ctx)).toMatchObject({ state: "undecided", reasonCodes: ["probe_error"] });
  });
  it("hashes identically for an unchanged pull request and differently when any decided field moves", () => {
    const base = snapshotHash(makeSnapshot());
    expect(snapshotHash(makeSnapshot())).toBe(base);
    expect(snapshotHash(makeSnapshot({ headSha: "c".repeat(40) }))).not.toBe(base);
    expect(snapshotHash(makeSnapshot({ unresolvedThreads: 1 }))).not.toBe(base);
    expect(snapshotHash(makeSnapshot({ changedFiles: ["b", "a"] }))).toBe(
      snapshotHash(makeSnapshot({ changedFiles: ["a", "b"] }))
    );
    expect(HEAD).toHaveLength(40);
  });
  it("ignores the order GitHub returns checks in", () => {
    const a = check({ name: "a" });
    const b = check({ name: "b", conclusion: "FAILURE" });
    expect(snapshotHash(makeSnapshot({ checks: [a, b] }))).toBe(snapshotHash(makeSnapshot({ checks: [b, a] })));
    expect(snapshotHash(makeSnapshot({ checks: [a, b] }))).not.toBe(
      snapshotHash(makeSnapshot({ checks: [a, check({ name: "b" })] }))
    );
  });
});
