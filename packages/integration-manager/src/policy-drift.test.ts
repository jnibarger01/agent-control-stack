import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_GATE_POLICY } from "./types.js";
import { selectMergeMethod } from "./github-source.js";
import { evaluateGate } from "./gate.js";
import { pr } from "./fixtures.test-support.js";

const workflow = readFileSync(
  new URL("../../../.github/workflows/jnibarger01-pr-review-merge.yml", import.meta.url),
  "utf8"
);

/** Reads a single-quoted shell assignment such as SENSITIVE_RE='...' from the classifier. */
const shellPattern = (name: string): string => workflow.match(new RegExp(`^\\s*${name}='([^']*)'`, "mu"))?.[1] ?? "";

const policyPaths = DEFAULT_GATE_POLICY.autoMergePaths!;

/**
 * This engine reports on the repository's own merge classifier and must never be more permissive than it. These tests read
 * the classifier itself, so changing the rules in the workflow without changing the engine (or the other way round) fails.
 */
describe("the default gate policy matches the classifier it mirrors", () => {
  it("allows only the author the classifier acts on", () => {
    const authors = [...workflow.matchAll(/author" != "([^"]+)"/gu)].map((m) => m[1]);
    expect(authors.length).toBeGreaterThan(0);
    expect([...new Set(authors)]).toEqual([...DEFAULT_GATE_POLICY.allowedAuthors!]);
  });

  it("uses the classifier's path rules verbatim", () => {
    expect(shellPattern("ALLOW_RE")).not.toBe("");
    expect(shellPattern("SENSITIVE_RE")).not.toBe("");
    expect(policyPaths.allowPattern).toBe(shellPattern("ALLOW_RE"));
    expect(policyPaths.sensitivePattern).toBe(shellPattern("SENSITIVE_RE"));
  });

  it("is never more permissive than the classifier for any path", () => {
    const classifierAdmits = (file: string) =>
      new RegExp(shellPattern("ALLOW_RE"), "i").test(file) && !new RegExp(shellPattern("SENSITIVE_RE"), "i").test(file);
    const samples = [
      "docs/guide.md",
      "README.md",
      "CHANGELOG.md",
      "docs/keys.md",
      "packages/a/README.md",
      "apps/gateway/src/x.ts",
      ".github/workflows/check.yml",
      "vendor/x.js",
      "CODEOWNERS"
    ];
    for (const file of samples) {
      const engineAdmits = evaluateGate(pr({ number: 1, changedFiles: [file] }), DEFAULT_GATE_POLICY).blockers.every(
        (b) => b.code !== "not_auto_mergeable_path"
      );
      expect(engineAdmits && !classifierAdmits(file), file).toBe(false);
    }
    expect(classifierAdmits("docs/guide.md")).toBe(true);
  });

  it("blocks a change to either policy file and any other author", () => {
    for (const file of DEFAULT_GATE_POLICY.protectedPaths) {
      expect(
        evaluateGate(pr({ number: 1, changedFiles: [file] }), DEFAULT_GATE_POLICY).blockers.map((b) => b.code)
      ).toContain("gate_policy_modified");
    }
    expect(
      evaluateGate(pr({ number: 1, author: "someone-else" }), DEFAULT_GATE_POLICY).blockers.map((b) => b.code)
    ).toContain("author_not_allowed");
    expect(evaluateGate(pr({ number: 1 }), DEFAULT_GATE_POLICY).status).toBe("eligible");
  });

  it("enables native auto-merge squash bound to the head it classified", () => {
    expect(workflow).toContain('gh pr merge --auto --squash --match-head-commit "$EXPECTED_HEAD" "$PR"');
    expect(selectMergeMethod({ allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true })).toBe(
      "merge"
    );
  });

  it("verifies every protection it relies on before trusting a classification", () => {
    for (const ctx of ["check", "test"]) {
      expect(workflow, ctx).toContain(`for ctx in check test; do`);
      expect(workflow, ctx).toContain("integration_id != null");
    }
    expect(workflow).toContain("require_last_push_approval==true and .dismiss_stale_reviews_on_push==true");
    expect(workflow).toContain('index(".github/**")');
    expect(workflow).toContain("ACS_ATTESTED_ACTIONS_CANNOT_APPROVE_PRS");
  });
});
