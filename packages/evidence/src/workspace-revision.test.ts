import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeWorkspaceRevision, detectWorkspaceDrift } from "./workspace-revision.js";

let dir: string;
const git = (args: string[]) => execFileSync("git", args, { cwd: dir });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "acs-wsrev-"));
  git(["init", "-q"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("computeWorkspaceRevision / detectWorkspaceDrift (TOCTOU)", () => {
  it("is deterministic for an unchanged workspace", async () => {
    const a = await computeWorkspaceRevision(dir);
    const b = await computeWorkspaceRevision(dir);
    expect(a.revision).toBe(b.revision);
    expect(a.dirty).toBe(false);
  });

  it("an out-of-band edit changes the revision and is detected as drift", async () => {
    const base = await computeWorkspaceRevision(dir);

    // Simulate a change OUTSIDE the authorized attempt.
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");

    const after = await computeWorkspaceRevision(dir);
    expect(after.revision).not.toBe(base.revision);
    expect(after.dirty).toBe(true);

    const drift = await detectWorkspaceDrift(dir, base.revision, []);
    expect(drift.drifted).toBe(true);
    expect(drift.changedPaths).toContain("a.txt");
    expect(drift.unauthorizedPaths).toContain("a.txt");
  });

  it("a change that IS within the attempt's authorized set is not flagged unauthorized", async () => {
    const base = await computeWorkspaceRevision(dir);
    writeFileSync(join(dir, "b.txt"), "new file from the attempt\n");

    const drift = await detectWorkspaceDrift(dir, base.revision, ["b.txt"]);
    expect(drift.drifted).toBe(true);
    expect(drift.changedPaths).toContain("b.txt");
    expect(drift.unauthorizedPaths).toEqual([]);
  });

  it("a new untracked file changes the revision", async () => {
    const base = await computeWorkspaceRevision(dir);
    writeFileSync(join(dir, "sneaky.txt"), "x\n");
    const after = await computeWorkspaceRevision(dir);
    expect(after.revision).not.toBe(base.revision);
  });
});
