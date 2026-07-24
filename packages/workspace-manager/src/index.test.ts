import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ControlStackError } from "@agent-control-stack/shared";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceManager } from "./index.js";

const execFileAsync = promisify(execFile);

async function createRepoFixture(): Promise<{ repoPath: string; rootDir: string; cleanup: () => void }> {
  const base = mkdtempSync(join(tmpdir(), "acs-workspace-manager-"));
  const repoPath = join(base, "repo");
  const rootDir = join(base, "workspaces");
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(rootDir, { recursive: true });

  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repoPath });
  writeFileSync(join(repoPath, "README.md"), "fixture repo\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoPath });
  await execFileAsync("git", ["commit", "-m", "initial commit"], { cwd: repoPath });

  return { repoPath, rootDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

describe("WorkspaceManager", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it("provisions a real, checked-out worktree scoped under rootDir", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const manager = new WorkspaceManager({ repoPath: fixture.repoPath, rootDir: fixture.rootDir });

    const workspace = await manager.provision("job_one");

    expect(workspace.workItemId).toBe("job_one");
    expect(workspace.branch).toBe("acs/job/job_one");
    expect(existsSync(join(workspace.hostPath, "README.md"))).toBe(true);
    expect(readFileSync(join(workspace.hostPath, "README.md"), "utf8")).toBe("fixture repo\n");
    expect(workspace.hostPath.startsWith(fixture.rootDir)).toBe(true);
  });

  it("is idempotent: re-provisioning the same job returns the existing workspace", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const manager = new WorkspaceManager({ repoPath: fixture.repoPath, rootDir: fixture.rootDir });

    const first = await manager.provision("job_one");
    const second = await manager.provision("job_one");

    expect(second).toEqual(first);
  });

  it("never lets two concurrent jobs share a mutable directory", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const manager = new WorkspaceManager({ repoPath: fixture.repoPath, rootDir: fixture.rootDir });

    const [a, b] = await Promise.all([manager.provision("job_a"), manager.provision("job_b")]);

    expect(a.hostPath).not.toBe(b.hostPath);
    writeFileSync(join(a.hostPath, "only-in-a.txt"), "a\n", "utf8");
    expect(existsSync(join(b.hostPath, "only-in-a.txt"))).toBe(false);
  });

  it("refuses to provision over a path it does not already own", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    mkdirSync(join(fixture.rootDir, "job_squatted"), { recursive: true });
    writeFileSync(join(fixture.rootDir, "job_squatted", "pre-existing.txt"), "do not touch\n", "utf8");
    const manager = new WorkspaceManager({ repoPath: fixture.repoPath, rootDir: fixture.rootDir });

    await expect(manager.provision("job_squatted")).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "workspace_path_collision" })
    );
    expect(existsSync(join(fixture.rootDir, "job_squatted", "pre-existing.txt"))).toBe(true);
  });

  it("tears down idempotently, including for a job that was never provisioned", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const manager = new WorkspaceManager({ repoPath: fixture.repoPath, rootDir: fixture.rootDir });

    const workspace = await manager.provision("job_one");
    expect(existsSync(workspace.hostPath)).toBe(true);

    await manager.teardown("job_one");
    expect(existsSync(workspace.hostPath)).toBe(false);
    expect(manager.get("job_one")).toBeUndefined();

    await expect(manager.teardown("job_one")).resolves.toBeUndefined();
    await expect(manager.teardown("job_never_existed")).resolves.toBeUndefined();
  });

  it("reconciles orphaned worktrees without deleting or resuming them", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const first = new WorkspaceManager({ repoPath: fixture.repoPath, rootDir: fixture.rootDir });
    const workspace = await first.provision("job_orphan");
    writeFileSync(join(workspace.hostPath, "in-progress.txt"), "unfinished work\n", "utf8");

    // Simulate a crash: a fresh manager instance has no in-memory record of
    // job_orphan, but the worktree is still on disk and in git's own registry.
    const recovered = new WorkspaceManager({ repoPath: fixture.repoPath, rootDir: fixture.rootDir });

    const { orphaned: withNoneActive } = await recovered.reconcile(new Set());
    expect(withNoneActive.map((w) => w.workItemId)).toContain("job_orphan");
    // Never touched - the crash-recovered work must survive for operator review.
    expect(existsSync(join(workspace.hostPath, "in-progress.txt"))).toBe(true);

    const { orphaned: withJobActive } = await recovered.reconcile(new Set(["job_orphan"]));
    expect(withJobActive.map((w) => w.workItemId)).not.toContain("job_orphan");
  });

  it("rejects work item ids that cannot map to a single safe path segment", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const manager = new WorkspaceManager({ repoPath: fixture.repoPath, rootDir: fixture.rootDir });

    await expect(manager.provision("../escape")).rejects.toThrow();
    await expect(manager.provision("has/slash")).rejects.toThrow();
  });

  it("throws on non-absolute repoPath or rootDir instead of resolving them ambiguously", () => {
    expect(() => new WorkspaceManager({ repoPath: "relative/repo", rootDir: "/tmp/x" })).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "workspace_manager_invalid_options" })
    );
  });
});
