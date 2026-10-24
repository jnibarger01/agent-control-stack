/**
 * Regression for the PR #400 review: an omitted optional path argument (context_pack with only
 * inline sources has no `files`) was wrapped as [undefined] and refused as path_not_allowed. An
 * absent path names nothing to contain, so it must pass; a present path outside the roots must still be refused.
 */
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { containJaceCommanderInvocation, validateJaceCommanderInvocation } from "./jace-commander.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "jc-contain-")));
const containment = { allowedRoots: [root], deniedRoots: [] };

describe("Jace Commander path containment for optional path arguments", () => {
  it("an inline-only context_pack (no files argument) is not refused as a path", () => {
    const invocation = validateJaceCommanderInvocation("context_pack", {
      inline: [{ id: "note", text: "hello", trust: "repo" }],
    });
    expect(() => containJaceCommanderInvocation(invocation, containment)).not.toThrow();
  });

  it("a file path inside the roots is accepted", () => {
    const invocation = validateJaceCommanderInvocation("context_pack", { files: [join(root, "notes.md")] });
    expect(() => containJaceCommanderInvocation(invocation, containment)).not.toThrow();
  });

  it("a file path outside the roots is still refused", () => {
    const invocation = validateJaceCommanderInvocation("context_pack", { files: ["/etc/hosts"] });
    expect(() => containJaceCommanderInvocation(invocation, containment)).toThrow(/outside every allow root/u);
  });
});

describe("context_pack total source invariant (ACS schema)", () => {
  it("rejects a request with no sources and one with more than 16 in total", () => {
    expect(() => validateJaceCommanderInvocation("context_pack", {})).toThrow();
    const many = Array.from({ length: 17 }, (_u, i) => ({ id: `s${i}`, text: "x", trust: "repo" }));
    expect(() => validateJaceCommanderInvocation("context_pack", { inline: many })).toThrow();
  });

  it("accepts exactly 16 sources in total, across files and inline", () => {
    const inline = Array.from({ length: 10 }, (_u, i) => ({ id: `s${i}`, text: "x", trust: "repo" }));
    const files = Array.from({ length: 6 }, (_u, i) => join(root, `f${i}.md`));
    expect(() => validateJaceCommanderInvocation("context_pack", { inline, files })).not.toThrow();
  });

  it("refuses a pin for a path that is not listed in files", () => {
    const digest = "a".repeat(64);
    expect(() => validateJaceCommanderInvocation("context_pack", {
      files: [join(root, "a.md")],
      pins: { [join(root, "b.md")]: digest }
    })).toThrow();
    expect(() => validateJaceCommanderInvocation("context_pack", {
      files: [join(root, "a.md")],
      pins: { [join(root, "a.md")]: digest }
    })).not.toThrow();
  });

  it("rejects a duplicate source id within inline items and a repeated file path", () => {
    const inline = [{ id: "dup", text: "x", trust: "repo" }, { id: "dup", text: "y", trust: "repo" }];
    expect(() => validateJaceCommanderInvocation("context_pack", { inline })).toThrow();
    const file = join(root, "dup.md");
    expect(() => validateJaceCommanderInvocation("context_pack", { files: [file, file] })).toThrow();
  });
});
