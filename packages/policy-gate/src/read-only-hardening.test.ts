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
  it("requires --no-textconv for diff, log and show, but not for status", () => {
    expect(classifyReadOnlyArgv(["git", "status"]).ok).toBe(true);
    expect(classifyReadOnlyArgv(["git", "diff"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["git", "log", "-n", "3"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["git", "diff", "--no-textconv"]).ok).toBe(true);
    expect(classifyReadOnlyArgv(["git", "log", "--no-textconv", "-n", "3"]).ok).toBe(true);
    expect(classifyReadOnlyArgv(["git", "show", "--no-textconv", "HEAD~1"]).ok).toBe(true);
  });

  it("does not accept --no-textconv after the -- separator as a real option", () => {
    expect(classifyReadOnlyArgv(["git", "diff", "--", "--no-textconv"]).ok).toBe(false);
  });

  it("refuses rev:path blob selectors, which can diff two blobs of a credential file", () => {
    expect(classifyReadOnlyArgv(["git", "diff", "HEAD~:.env", "HEAD:.env", "--no-textconv"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["git", "show", "--no-textconv", "HEAD:README.md"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["git", "diff", "--no-textconv", "HEAD~1..HEAD"]).ok).toBe(true);
  });
});

describe("policy decisions for hardened read-only argv", () => {
  it("does not auto-allow bare git diff, which runs textconv helpers", () => {
    expect(policyFor(["git", "diff"]).decision).toBe("require_approval");
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
