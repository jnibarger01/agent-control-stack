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

/**
 * This engine reports on the repository's own merge gate and must never be more permissive than it. These tests read the
 * workflow itself, so changing the workflow without changing the engine (or the other way round) fails here.
 */
describe("the default gate policy matches the workflow it mirrors", () => {
  it("allows only the author the workflow acts on", () => {
    const authors = [...workflow.matchAll(/author" != "([^"]+)"/gu)].map((m) => m[1]);
    expect(authors.length).toBeGreaterThan(0);
    expect([...new Set(authors)]).toEqual([...DEFAULT_GATE_POLICY.allowedAuthors!]);
    const inline = [...workflow.matchAll(/pull_request\.user\.login == '([^']+)'/gu)].map((m) => m[1]);
    expect([...new Set(inline)]).toEqual([...DEFAULT_GATE_POLICY.allowedAuthors!]);
  });

  it("protects exactly the files the workflow refuses to auto-merge a change to", () => {
    const block = workflow.match(/policy_changes="[\s\S]*?\)"/u)?.[0] ?? "";
    const files = [...block.matchAll(/\.filename == "([^"]+)"/gu)].map((m) => m[1]).sort();
    expect(files).toEqual([...DEFAULT_GATE_POLICY.protectedPaths].sort());
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

  it("selects the merge method in the workflow's order", () => {
    const order = [
      ...workflow.matchAll(/\.(allow_(?:merge_commit|squash_merge|rebase_merge))' <<<"\$repo_json"\)" == "true"/gu)
    ].map((m) => m[1]);
    expect(order).toEqual(["allow_merge_commit", "allow_squash_merge", "allow_rebase_merge"]);
    const methods = [...workflow.matchAll(/method="(merge|squash|rebase)"/gu)].map((m) => m[1]);
    expect(methods).toEqual(["merge", "squash", "rebase"]);
    expect(selectMergeMethod({ allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true })).toBe(
      "merge"
    );
  });

  it("applies the same blocking rules the workflow states", () => {
    for (const phrase of [
      "has merge conflicts",
      "requests changes",
      "review thread(s) remain unresolved",
      "status check(s) are failing/cancelled",
      "more than 100 review threads or status checks"
    ]) {
      expect(workflow, phrase).toContain(phrase);
    }
  });
});
