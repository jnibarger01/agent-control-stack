import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ControlStackError } from "@agent-control-stack/shared";
import { SqliteWorkItemStore, type WorkspaceAllocation, type WorkItemStore } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceManager, type WorkspaceAllocationStore } from "./index.js";

const execFileAsync = promisify(execFile);

async function createRepoFixture(): Promise<{
  repoPath: string;
  rootDir: string;
  store: WorkItemStore;
  cleanup: () => void;
}> {
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

  const store = new SqliteWorkItemStore(join(base, "control.db"));
  return { repoPath, rootDir, store, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** workspace_allocations.work_item_id has a real FK to work_items(id); returns the store-assigned id. */
function seedWorkItemId(store: WorkItemStore, label: string): string {
  const workItem = store.create({
    title: `Fixture ${label}`,
    requester: "user",
    requesterSubject: "actor-user",
    intent: "workspace manager fixture",
    target: { cwd: "/repo", files: [] },
    requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: [], write: false } }],
    risk: "low"
  });
  return workItem.id;
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
    const manager = new WorkspaceManager({
      repoPath: fixture.repoPath,
      rootDir: fixture.rootDir,
      store: fixture.store
    });
    const workItemId = seedWorkItemId(fixture.store, "one");

    const workspace = await manager.provision(workItemId);

    expect(workspace.workItemId).toBe(workItemId);
    expect(workspace.branch).toBe(`acs/job/${workItemId}`);
    expect(existsSync(join(workspace.hostPath, "README.md"))).toBe(true);
    expect(readFileSync(join(workspace.hostPath, "README.md"), "utf8")).toBe("fixture repo\n");
    expect(workspace.hostPath.startsWith(fixture.rootDir)).toBe(true);
    expect(fixture.store.getActiveWorkspaceAllocationForWorkItem(workItemId)).toMatchObject({
      hostPath: workspace.hostPath,
      status: "active"
    });
  });

  it("is idempotent: re-provisioning the same job returns the existing workspace", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const manager = new WorkspaceManager({
      repoPath: fixture.repoPath,
      rootDir: fixture.rootDir,
      store: fixture.store
    });
    const workItemId = seedWorkItemId(fixture.store, "one");

    const first = await manager.provision(workItemId);
    const second = await manager.provision(workItemId);

    expect(second).toEqual(first);
  });

  it("never lets two concurrent jobs share a mutable directory", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const manager = new WorkspaceManager({
      repoPath: fixture.repoPath,
      rootDir: fixture.rootDir,
      store: fixture.store
    });
    const jobA = seedWorkItemId(fixture.store, "a");
    const jobB = seedWorkItemId(fixture.store, "b");

    const [a, b] = await Promise.all([manager.provision(jobA), manager.provision(jobB)]);

    expect(a.hostPath).not.toBe(b.hostPath);
    writeFileSync(join(a.hostPath, "only-in-a.txt"), "a\n", "utf8");
    expect(existsSync(join(b.hostPath, "only-in-a.txt"))).toBe(false);
  });

  it("refuses to provision over a path with no active allocation record", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const workItemId = seedWorkItemId(fixture.store, "squatted");
    mkdirSync(join(fixture.rootDir, workItemId), { recursive: true });
    writeFileSync(join(fixture.rootDir, workItemId, "pre-existing.txt"), "do not touch\n", "utf8");
    const manager = new WorkspaceManager({
      repoPath: fixture.repoPath,
      rootDir: fixture.rootDir,
      store: fixture.store
    });

    await expect(manager.provision(workItemId)).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "workspace_path_collision" })
    );
    expect(existsSync(join(fixture.rootDir, workItemId, "pre-existing.txt"))).toBe(true);
  });

  it("tears down idempotently, including for a job that was never provisioned", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const manager = new WorkspaceManager({
      repoPath: fixture.repoPath,
      rootDir: fixture.rootDir,
      store: fixture.store
    });
    const workItemId = seedWorkItemId(fixture.store, "one");
    const neverExisted = seedWorkItemId(fixture.store, "never");

    const workspace = await manager.provision(workItemId);
    expect(existsSync(workspace.hostPath)).toBe(true);

    await manager.teardown(workItemId);
    expect(existsSync(workspace.hostPath)).toBe(false);
    expect(manager.get(workItemId)).toBeUndefined();
    expect(fixture.store.getActiveWorkspaceAllocationForWorkItem(workItemId)).toBeUndefined();

    await expect(manager.teardown(workItemId)).resolves.toBeUndefined();
    await expect(manager.teardown(neverExisted)).resolves.toBeUndefined();
  });

  it("reconciles orphaned worktrees without deleting or resuming them", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const first = new WorkspaceManager({ repoPath: fixture.repoPath, rootDir: fixture.rootDir, store: fixture.store });
    const workItemId = seedWorkItemId(fixture.store, "orphan");
    const workspace = await first.provision(workItemId);
    writeFileSync(join(workspace.hostPath, "in-progress.txt"), "unfinished work\n", "utf8");

    // Simulate a crash: a fresh manager instance has no in-memory cache of
    // this job, but the *persisted store* (not just git's own registry)
    // still has the allocation record.
    const recovered = new WorkspaceManager({
      repoPath: fixture.repoPath,
      rootDir: fixture.rootDir,
      store: fixture.store
    });

    const { orphaned: withNoneActive } = await recovered.reconcile(new Set());
    expect(withNoneActive.map((w) => w.workItemId)).toContain(workItemId);
    // Never touched - the crash-recovered work must survive for operator review.
    expect(existsSync(join(workspace.hostPath, "in-progress.txt"))).toBe(true);

    const { orphaned: withJobActive } = await recovered.reconcile(new Set([workItemId]));
    expect(withJobActive.map((w) => w.workItemId)).not.toContain(workItemId);
  });

  it("rejects work item ids that cannot map to a single safe path segment", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const manager = new WorkspaceManager({
      repoPath: fixture.repoPath,
      rootDir: fixture.rootDir,
      store: fixture.store
    });

    await expect(manager.provision("../escape")).rejects.toThrow();
    await expect(manager.provision("has/slash")).rejects.toThrow();
  });

  it("throws on non-absolute repoPath or rootDir instead of resolving them ambiguously", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    expect(
      () => new WorkspaceManager({ repoPath: "relative/repo", rootDir: "/tmp/x", store: fixture.store })
    ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "workspace_manager_invalid_options" }));
  });

  it("adversarial: refuses to tear down a directory at the deterministic path with no allocation record", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const workItemId = seedWorkItemId(fixture.store, "untracked");
    const manager = new WorkspaceManager({
      repoPath: fixture.repoPath,
      rootDir: fixture.rootDir,
      store: fixture.store
    });
    // A directory shows up at exactly the path this work item would use,
    // but no allocation was ever recorded for it (e.g. planted by something
    // else, or a stale leftover from before this store existed).
    const plantedPath = join(fixture.rootDir, workItemId);
    mkdirSync(plantedPath, { recursive: true });
    writeFileSync(join(plantedPath, "not-ours.txt"), "should survive\n", "utf8");

    await expect(manager.teardown(workItemId)).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "workspace_untracked_teardown_refused" })
    );
    expect(existsSync(join(plantedPath, "not-ours.txt"))).toBe(true);
  });

  it("adversarial: refuses to tear down when the allocation path has been replaced with a symlink", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const manager = new WorkspaceManager({
      repoPath: fixture.repoPath,
      rootDir: fixture.rootDir,
      store: fixture.store
    });
    const workItemId = seedWorkItemId(fixture.store, "symlinked");
    const workspace = await manager.provision(workItemId);

    // Simulate a TOCTOU/substitution attempt: the real worktree directory is
    // replaced with a symlink pointing somewhere else entirely.
    const outsideSecret = mkdtempSync(join(tmpdir(), "acs-workspace-manager-outside-"));
    writeFileSync(join(outsideSecret, "secret.txt"), "should never be deleted by teardown\n", "utf8");
    rmSync(workspace.hostPath, { recursive: true, force: true });
    symlinkSync(outsideSecret, workspace.hostPath);

    try {
      await expect(manager.teardown(workItemId)).rejects.toThrowError(
        expect.objectContaining<Partial<ControlStackError>>({ code: "workspace_teardown_refused_symlink" })
      );
      expect(existsSync(join(outsideSecret, "secret.txt"))).toBe(true);
      // The store must still show the allocation as active - a refused
      // teardown must not be silently treated as done.
      expect(fixture.store.getActiveWorkspaceAllocationForWorkItem(workItemId)).toBeDefined();
    } finally {
      rmSync(outsideSecret, { recursive: true, force: true });
    }
  });

  it("adversarial: a second process (fresh manager, same store) sees and can tear down what the first provisioned", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const workItemId = seedWorkItemId(fixture.store, "cross-process");
    const first = new WorkspaceManager({ repoPath: fixture.repoPath, rootDir: fixture.rootDir, store: fixture.store });
    const workspace = await first.provision(workItemId);

    const second = new WorkspaceManager({ repoPath: fixture.repoPath, rootDir: fixture.rootDir, store: fixture.store });
    expect(second.get(workItemId)).toEqual(workspace);

    await second.teardown(workItemId);
    expect(existsSync(workspace.hostPath)).toBe(false);
    expect(first.get(workItemId)).toBeUndefined();
  });

  it("adversarial: the store's unique-active-allocation constraint rejects a duplicate concurrent recording", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const workItemId = seedWorkItemId(fixture.store, "race");
    const manager = new WorkspaceManager({
      repoPath: fixture.repoPath,
      rootDir: fixture.rootDir,
      store: fixture.store
    });
    const workspace = await manager.provision(workItemId);

    // A second, independent attempt to record an allocation for the same
    // work item (simulating a losing racer in a real concurrent provision)
    // must be rejected by the store itself, not merely by application logic.
    expect(() =>
      fixture.store.recordWorkspaceAllocation(
        {
          allocationId: "workspace_racer",
          workItemId,
          hostPath: "/tmp/attacker-would-be-path",
          branch: "acs/job/racer",
          baseRef: "main"
        },
        { via: "domain_service" }
      )
    ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "workspace_allocation_conflict" }));
    expect(fixture.store.getActiveWorkspaceAllocationForWorkItem(workItemId)?.hostPath).toBe(workspace.hostPath);
  });

  it("allocates by attempt and fences cleanup so retries never reuse an earlier workspace", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const workItemId = seedWorkItemId(fixture.store, "retry-isolation");
    const allocations = new Map<string, WorkspaceAllocation>();
    const attemptStore: WorkspaceAllocationStore = {
      recordWorkspaceAllocation(input) {
        const allocation: WorkspaceAllocation = {
          ...input,
          attemptId: input.attemptId ?? input.workItemId,
          leaseId: input.leaseId ?? input.workItemId,
          workerId: input.workerId ?? "legacy",
          fencingEpoch: input.fencingEpoch ?? 0,
          status: "active",
          createdAt: new Date().toISOString()
        };
        allocations.set(allocation.allocationId, allocation);
        return allocation;
      },
      getActiveWorkspaceAllocationForWorkItem(id) {
        return [...allocations.values()].find(
          (allocation) => allocation.workItemId === id && allocation.status === "active"
        );
      },
      getActiveWorkspaceAllocationForAttempt(id) {
        return [...allocations.values()].find(
          (allocation) => allocation.attemptId === id && allocation.status === "active"
        );
      },
      closeWorkspaceAllocation(id) {
        const current = allocations.get(id);
        if (!current) throw new Error("missing allocation " + id);
        const closed = { ...current, status: "torn_down" as const, tornDownAt: new Date().toISOString() };
        allocations.set(id, closed);
        return closed;
      },
      requestWorkspaceCleanup(input) {
        const current = allocations.get(input.allocationId);
        if (!current) throw new Error("missing allocation " + input.allocationId);
        return current;
      }
    };
    const manager = new WorkspaceManager({
      repoPath: fixture.repoPath,
      rootDir: fixture.rootDir,
      store: attemptStore
    });

    const first = await manager.provision(workItemId, {
      attemptId: "attempt-first",
      leaseId: "lease-first",
      workerId: "worker-a",
      fencingEpoch: 1
    });
    const second = await manager.provision(workItemId, {
      attemptId: "attempt-second",
      leaseId: "lease-second",
      workerId: "worker-a",
      fencingEpoch: 2
    });

    expect(second.hostPath).not.toBe(first.hostPath);
    expect(second.allocationId).not.toBe(first.allocationId);
    await expect(
      manager.teardown(workItemId, {
        attemptId: "attempt-second",
        leaseId: "lease-first",
        workerId: "worker-a",
        fencingEpoch: 1
      })
    ).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "workspace_cleanup_fence_stale" })
    );
    expect(existsSync(second.hostPath)).toBe(true);
    await manager.teardown(workItemId, {
      attemptId: "attempt-second",
      leaseId: "lease-second",
      workerId: "worker-a",
      fencingEpoch: 2
    });
    expect(attemptStore.getActiveWorkspaceAllocationForAttempt?.("attempt-second")).toBeUndefined();
  });
});
