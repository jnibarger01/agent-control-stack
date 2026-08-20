import { describe, expect, it, vi } from "vitest";
import { executeStartupReconciliation } from "./service.js";

describe("executeStartupReconciliation", () => {
  it("uses persisted attempt identity for retry and fences cleanup by the active allocation", async () => {
    const attempt = { attemptId: "attempt-1", workItemId: "work-1", planHash: "a".repeat(64), inputHash: "b".repeat(64) };
    const retryWorkItem = { id: "work-2" };
    const store = {
      getAttempt: vi.fn(() => attempt),
      get: vi.fn(() => ({ id: "work-1" })),
      list: vi.fn(() => []),
      retryWorkItem: vi.fn(() => retryWorkItem),
      createAttempt: vi.fn(() => ({ attemptId: "attempt-2" })),
      getActiveWorkspaceAllocationForWorkItem: vi.fn(() => undefined),
      recordRecoveryDecision: vi.fn()
    };
    const workspaceManager = {
      reconcile: vi.fn(async () => ({ orphaned: [{ attemptId: "attempt-1", workItemId: "work-1", hostPath: "/tmp/workspace" }] })),
      teardown: vi.fn()
    };

    const result = await executeStartupReconciliation(
      {
        activeWorkItemIds: new Set(),
        maxAttempts: 3,
        attemptNumberById: { "attempt-1": 1 },
        store: {
          recordRecoveryDecision: store.recordRecoveryDecision,
          getActiveLeaseForAttempt: vi.fn(),
          getValidationRunForAttempt: vi.fn(),
          getActiveWorkspaceAllocationForAttempt: vi.fn()
        },
        workspaceManager
      },
      { store: store as never, workspaceManager: workspaceManager as never, maxAttempts: 3 }
    );

    expect(result.retryAttemptsCreated).toBe(1);
    expect(store.getAttempt).toHaveBeenCalledWith("attempt-1");
    expect(store.get).toHaveBeenCalledWith("work-1");
    expect(store.retryWorkItem).toHaveBeenCalledWith("work-1", expect.any(Object));
    expect(store.createAttempt).toHaveBeenCalledWith(expect.objectContaining({ workItemId: "work-2" }), { via: "domain_service" });
    expect(workspaceManager.teardown).not.toHaveBeenCalled();
  });
});
