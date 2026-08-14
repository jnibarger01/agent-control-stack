import { readFileSync, writeFileSync } from "node:fs";

function replaceExact(path, before, after) {
  const source = readFileSync(path, "utf8");
  if (!source.includes(before)) throw new Error(`pattern not found in ${path}: ${before.slice(0, 120)}`);
  if (source.indexOf(before) !== source.lastIndexOf(before)) throw new Error(`pattern is not unique in ${path}`);
  writeFileSync(path, source.replace(before, after));
}

replaceExact(
  "packages/work-items/src/store.ts",
  `      const hasAttemptAuthority =
        parsed.attemptId !== undefined || parsed.leaseId !== undefined || parsed.workerId !== undefined || parsed.fencingEpoch !== undefined;
      if (hasAttemptAuthority) {`,
  `      const hasAttemptAuthority =
        parsed.attemptId !== undefined || parsed.leaseId !== undefined || parsed.workerId !== undefined || parsed.fencingEpoch !== undefined;
      const isLegacyAuthority =
        attemptId === parsed.workItemId && leaseId === parsed.workItemId && workerId === "legacy" && fencingEpoch === 0;
      if (hasAttemptAuthority && !isLegacyAuthority) {`
);

replaceExact(
  "packages/work-items/src/attempt.test.ts",
  `import { afterEach, describe, expect, it } from "vitest";`,
  `import { afterEach, describe, expect, it, vi } from "vitest";`
);
replaceExact(
  "packages/work-items/src/attempt.test.ts",
  `    const allocation = fixture.store.recordWorkspaceAllocation(
      {
        allocationId: "workspace_1",
        workItemId: fixture.workItem.id,
        hostPath: "/repo/wrk_1",
        branch: "acs/job/wrk_1",
        baseRef: "main"
      },
      { via: "domain_service" }
    );`,
  `    const allocation = fixture.store.recordWorkspaceAllocation(
      {
        allocationId: "workspace_1",
        workItemId: fixture.workItem.id,
        attemptId: attempt.attemptId,
        leaseId: lease.leaseId,
        workerId: lease.workerId,
        fencingEpoch: lease.fencingEpoch,
        hostPath: "/repo/wrk_1",
        branch: "acs/job/wrk_1",
        baseRef: "main"
      },
      { via: "domain_service" }
    );`
);

replaceExact(
  "packages/work-items/src/attempt.test.ts",
  `  it("rejects an expired lease even though every identifier otherwise matches", () => {
    const past = new Date(Date.now() - 60 * 60 * 1_000);
    const fixture = leasedFixture({ ttlMs: 1_000, now: past });
    directory = fixture.directory;

    const authority = fixture.store.getCommandAuthority({
      workItemId: fixture.workItem.id,
      attemptId: fixture.attempt.attemptId,
      leaseId: fixture.lease.leaseId,
      workerId: "worker-1",
      fencingToken: 1,
      workspaceAllocationId: "workspace_1"
    });
    expect(authority).toBeUndefined();
  });`,
  `  it("rejects an expired lease even though every identifier otherwise matches", () => {
    const fixture = leasedFixture();
    directory = fixture.directory;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(fixture.lease.expiresAt) + 1));
    const authority = fixture.store.getCommandAuthority({
      workItemId: fixture.workItem.id,
      attemptId: fixture.attempt.attemptId,
      leaseId: fixture.lease.leaseId,
      workerId: "worker-1",
      fencingToken: 1,
      workspaceAllocationId: "workspace_1"
    });
    vi.useRealTimers();
    expect(authority).toBeUndefined();
  });`
);

replaceExact(
  "packages/workspace-manager/src/index.test.ts",
  `import { SqliteWorkItemStore, type WorkItemStore } from "@agent-control-stack/work-items";`,
  `import { SqliteWorkItemStore, type WorkspaceAllocation, type WorkItemStore } from "@agent-control-stack/work-items";`
);
replaceExact(
  "packages/workspace-manager/src/index.test.ts",
  `import { WorkspaceManager } from "./index.js";`,
  `import { WorkspaceManager, type WorkspaceAllocationStore } from "./index.js";`
);
replaceExact(
  "packages/workspace-manager/src/index.test.ts",
  `    const manager = new WorkspaceManager({
      repoPath: fixture.repoPath,
      rootDir: fixture.rootDir,
      store: fixture.store
    });

    const first = await manager.provision(workItemId, {`,
  `    const allocations = new Map<string, WorkspaceAllocation>();
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
        return [...allocations.values()].find((allocation) => allocation.workItemId === id && allocation.status === "active");
      },
      getActiveWorkspaceAllocationForAttempt(id) {
        return [...allocations.values()].find((allocation) => allocation.attemptId === id && allocation.status === "active");
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

    const first = await manager.provision(workItemId, {`
);
replaceExact(
  "packages/workspace-manager/src/index.test.ts",
  `    expect(fixture.store.getActiveWorkspaceAllocationForAttempt?.("attempt-second")).toBeUndefined();`,
  `    expect(attemptStore.getActiveWorkspaceAllocationForAttempt?.("attempt-second")).toBeUndefined();`
);
