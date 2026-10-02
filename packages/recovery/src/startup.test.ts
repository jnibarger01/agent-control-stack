import { describe, expect, it, vi } from "vitest";
import { reconcileStartup } from "./startup.js";

function makeStore(
  overrides: {
    lease?: { status: "active" | "expired" | "consumed" | "revoked"; expiresAt: string };
    validationRun?: { passed: boolean };
    allocation?: { status: string };
  } = {}
) {
  return {
    recordRecoveryDecision: vi.fn(),
    getActiveLeaseForAttempt: vi.fn(() => overrides.lease),
    getValidationRunForAttempt: vi.fn(() => overrides.validationRun),
    getActiveWorkspaceAllocationForAttempt: vi.fn(() => overrides.allocation)
  };
}

const orphan = { attemptId: "attempt-1", workItemId: "work-1", hostPath: "/workspace" };
const workspaceManager = { reconcile: vi.fn(async () => ({ orphaned: [orphan] })) };

describe("reconcileStartup", () => {
  it("requires independent reconciliation for an orphan with no non-execution evidence", async () => {
    const store = makeStore();
    const plans = await reconcileStartup({
      activeWorkItemIds: new Set(),
      maxAttempts: 3,
      attemptNumberById: { "attempt-1": 1 },
      store,
      workspaceManager
    });

    expect(plans[0]).toMatchObject({ decision: "validation_pending", retryAllowed: false });
    expect(store.recordRecoveryDecision).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: "attempt-1", decision: "validation_pending" }),
      { via: "domain_service" }
    );
  });

  it("does not mark a validated success as retryable - it inspects the real validation run instead of assuming failure", async () => {
    const store = makeStore({ validationRun: { passed: true }, allocation: { status: "active" } });

    const plans = await reconcileStartup({
      activeWorkItemIds: new Set(),
      maxAttempts: 3,
      attemptNumberById: { "attempt-1": 1 },
      store,
      workspaceManager
    });

    expect(store.getValidationRunForAttempt).toHaveBeenCalledWith("attempt-1");
    expect(plans[0]?.decision).not.toBe("retryable");
    expect(plans[0]).toMatchObject({ decision: "cleanup_pending", retryAllowed: false });
  });

  it("terminates a validated failure instead of retrying it", async () => {
    const store = makeStore({ validationRun: { passed: false } });

    const plans = await reconcileStartup({
      activeWorkItemIds: new Set(),
      maxAttempts: 3,
      attemptNumberById: { "attempt-1": 1 },
      store,
      workspaceManager
    });

    expect(plans[0]).toMatchObject({ decision: "terminal_failed", retryAllowed: false });
    expect(store.recordRecoveryDecision).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "terminal_failed" }),
      { via: "domain_service" }
    );
  });

  it("binds replay to the attempt and observed recovery decision", async () => {
    const store = makeStore();
    await reconcileStartup({
      activeWorkItemIds: new Set(),
      maxAttempts: 3,
      attemptNumberById: { "attempt-1": 1 },
      store,
      workspaceManager
    });
    await reconcileStartup({
      activeWorkItemIds: new Set(),
      maxAttempts: 3,
      attemptNumberById: { "attempt-1": 1 },
      store,
      workspaceManager
    });

    expect(store.recordRecoveryDecision).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = store.recordRecoveryDecision.mock.calls;
    expect(firstCall?.[0]?.idempotencyKey).toBe(secondCall?.[0]?.idempotencyKey);
    expect(firstCall?.[0]?.idempotencyKey).toMatch(/^startup-recovery:attempt-1:[a-f0-9]{32}$/u);
    store.getValidationRunForAttempt.mockReturnValue({ passed: true });
    await reconcileStartup({
      activeWorkItemIds: new Set(),
      maxAttempts: 3,
      attemptNumberById: { "attempt-1": 1 },
      store,
      workspaceManager
    });
    expect(store.recordRecoveryDecision.mock.calls[2]?.[0]?.idempotencyKey).not.toBe(firstCall?.[0]?.idempotencyKey);
  });
});
