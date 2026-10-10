import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyReadOnlyArgv } from "./command-effects.js";
import { evaluatePolicy } from "./policy.js";

// PR #303 review findings: revision selectors, textconv helpers, and content search over directories.

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "acs-read-only-hardening-"));
  writeFileSync(join(root, "README.md"), "hello\n");
  writeFileSync(join(root, "credentials.json"), "{}\n");
  writeFileSync(join(root, ".env"), "SECRET=1\n");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "index.ts"), "export {};\n");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// Read-only auto-approval needs declared paths, so probes declare the operands a real request would name.
const policyFor = (command: string[], paths?: string[]) =>
  evaluatePolicy({
    workItemId: "wrk_hardening",
    actor: "agent",
    operation: "create",
    requester: "user",
    risk: "low",
    action: { kind: "shell", description: "run", params: {} },
    cwd: root,
    command,
    paths
  });

describe("git read-only argv", () => {
  it("requires --no-textconv and --no-ext-diff for diff, log and show, but not for status", () => {
    expect(classifyReadOnlyArgv(["git", "status"]).ok).toBe(true);
    expect(classifyReadOnlyArgv(["git", "diff", "--stat"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["git", "log", "--oneline"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["git", "diff", "--no-textconv", "--stat"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["git", "diff", "--no-ext-diff", "--stat"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["git", "diff", "--no-textconv", "--no-ext-diff", "--stat"]).ok).toBe(true);
    expect(classifyReadOnlyArgv(["git", "log", "--no-textconv", "--no-ext-diff", "--oneline"]).ok).toBe(true);
    expect(classifyReadOnlyArgv(["git", "show", "--no-textconv", "--no-ext-diff", "--name-only", "HEAD~1"]).ok).toBe(true);
  });

  it("refuses patch output, which prints file contents, even with the safety flags", () => {
    const flags = ["--no-textconv", "--no-ext-diff"];
    expect(classifyReadOnlyArgv(["git", "diff", ...flags]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["git", "show", ...flags, "HEAD"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["git", "log", ...flags, "-p"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["git", "diff", ...flags, "--stat", "--patch"]).ok).toBe(false);
  });

  it("refuses operands that escape the workspace, which git reads as filesystem files", () => {
    const flags = ["--no-textconv", "--no-ext-diff", "--stat"];
    expect(classifyReadOnlyArgv(["git", "diff", ...flags, "/tmp/secret", "README.md"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["git", "diff", ...flags, "--no-index", "/etc/passwd", "README.md"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["git", "diff", ...flags, "../outside.txt"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["git", "status", "~/secret"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["git", "diff", ...flags, "HEAD..HEAD~1"]).ok).toBe(true);
  });

  it("does not accept the safety flags after the -- separator as real options", () => {
    expect(classifyReadOnlyArgv(["git", "diff", "--stat", "--", "--no-textconv", "--no-ext-diff"]).ok).toBe(false);
  });

  it("refuses rev:path blob selectors, which can diff two blobs of a credential file", () => {
    const flags = ["--no-textconv", "--no-ext-diff", "--stat"];
    expect(classifyReadOnlyArgv(["git", "diff", "HEAD~:.env", "HEAD:.env", ...flags]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["git", "diff", ...flags, "HEAD:README.md"]).ok).toBe(false);
  });
});

describe("policy decisions for hardened read-only argv", () => {
  it("does not auto-allow bare git diff, which runs textconv helpers and prints patch content", () => {
    expect(policyFor(["git", "diff"]).decision).toBe("require_approval");
    expect(policyFor(["git", "diff", "--no-textconv", "--no-ext-diff"]).decision).toBe("require_approval");
  });

  it("does not auto-allow a diff that configured external drivers could run", () => {
    expect(policyFor(["git", "diff", "--no-textconv", "--stat"]).decision).not.toBe("allow");
  });

  it("does not auto-allow an outside-workspace file compared by git, even with a declared path", () => {
    const result = policyFor(["git", "diff", "--no-textconv", "--no-ext-diff", "--stat", "/tmp/secret", "README.md"], ["README.md"]);
    expect(result.decision).not.toBe("allow");
  });

  it("still auto-allows metadata git reads inside the workspace", () => {
    expect(policyFor(["git", "status"]).decision).toBe("allow");
    expect(policyFor(["git", "diff", "--no-textconv", "--no-ext-diff", "--name-only"]).decision).toBe("allow");
  });

  it("does not auto-allow a rev:path blob diff of a credential file", () => {
    const result = policyFor(["git", "diff", "HEAD~:.env", "HEAD:.env", "--no-textconv"]);
    expect(result.decision).not.toBe("allow");
  });

  it("does not auto-allow content search over a directory that may hold a credential file", () => {
    expect(policyFor(["rg", "AWS_SECRET_ACCESS_KEY", "."], ["."]).decision).not.toBe("allow");
  });

  it("does not auto-allow a content search over a directory operand", () => {
    expect(policyFor(["rg", "export", "src"], ["src"]).decision).not.toBe("allow");
  });

  it("still auto-allows a content search over a regular file inside the root", () => {
    expect(policyFor(["rg", "hello", "README.md"], ["README.md"]).decision).toBe("allow");
  });

  it("treats an rg search pattern as a pattern, not a credential path", () => {
    const result = policyFor(["rg", "credentials.json", "README.md"]);
    expect(result.matchedRules).not.toContain("deny:credential-path");
  });

  it("still denies a credential path named as a file operand", () => {
    const result = policyFor(["rg", "SECRET", ".env"]);
    expect(result.decision).toBe("deny");
    expect(result.matchedRules).toContain("deny:credential-path");
  });
});
