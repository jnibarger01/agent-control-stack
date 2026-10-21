import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MODELLED_MERGE_PATHS, externalMergeExposure } from "./exposure.js";
import { VERIFICATION_SURFACE_V1, isDocsOnly, matchesAny } from "./probes.js";
import { makeSnapshot } from "./fixtures.test-support.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const workflowsDir = join(repoRoot, ".github", "workflows");
const workflows = readdirSync(workflowsDir)
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({ name, text: readFileSync(join(workflowsDir, name), "utf8") }));

/** Pins the model of "what else can merge a pull request" to the workflows themselves, so drift fails loudly. */
describe("external merge exposure model", () => {
  it("every workflow that can merge is a modelled one", () => {
    const modelled = new Set(MODELLED_MERGE_PATHS.map((path) => path.workflow.split("/").pop()));
    const mergers = workflows
      .filter(({ text }) => /gh pr merge|--auto\b|pulls\/[^\s"]*\/merge|\/merge\b/u.test(text))
      .map(({ name }) => name);
    expect(mergers.length).toBeGreaterThan(0);
    for (const name of mergers)
      expect(modelled.has(name), `${name} can merge but is not in MODELLED_MERGE_PATHS`).toBe(true);
  });

  it("the modelled conditions still appear in the workflows", () => {
    const jn = workflows.find(({ name }) => name === "jnibarger01-pr-review-merge.yml")?.text ?? "";
    expect(jn).toContain("workflow_dispatch");
    expect(jn).toContain("jnibarger01");
    const dependabot = workflows.find(({ name }) => name === "dependabot-auto-merge.yml")?.text ?? "";
    expect(dependabot).toMatch(/dependabot\[bot\]/u);
    expect(dependabot).toMatch(/gh pr merge[^\n]*--auto[^\n]*--squash|--auto[^\n]*--squash/u);
  });

  it("never reports exposure as none", () => {
    const acs = "o/r";
    for (const pr of [
      makeSnapshot(),
      makeSnapshot({ author: "jnibarger01" }),
      makeSnapshot({ author: "dependabot" }),
      makeSnapshot({ isDraft: true, author: "jnibarger01" })
    ]) {
      expect(["likely", "possible"]).toContain(externalMergeExposure(pr, acs, acs).exposure);
    }
    expect(externalMergeExposure(makeSnapshot({ author: "jnibarger01" }), acs, acs)).toMatchObject({
      exposure: "likely",
      matchedPaths: ["jn_auto_on_pr_event"]
    });
    expect(externalMergeExposure(makeSnapshot({ author: "jnibarger01", isDraft: true }), acs, acs).exposure).toBe(
      "possible"
    );
    expect(externalMergeExposure(makeSnapshot(), "other/repo", acs).exposure).toBe("unknown");
    expect(externalMergeExposure(undefined, acs, acs).exposure).toBe("unknown");
  });
});

describe("docs-only rule", () => {
  it("matches the exact rule in check.yml", () => {
    const check = workflows.find(({ name }) => name === "check.yml")?.text ?? "";
    expect(check).toContain('endswith(".md")');
    expect(check).toContain('startswith("docs/")');
    expect(isDocsOnly(["a.md", "docs/b/c.txt"])).toBe(true);
    expect(isDocsOnly(["a.md", "docs-extra/c.txt"])).toBe(false);
  });
});

describe("verification surface", () => {
  it("every pattern matches at least one tracked file, so the list cannot silently rot", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split("\n")
      .filter(Boolean);
    for (const pattern of VERIFICATION_SURFACE_V1) {
      expect(
        tracked.some((file) => matchesAny(file, [pattern])),
        `no tracked file matches ${pattern}`
      ).toBe(true);
    }
  });
});
