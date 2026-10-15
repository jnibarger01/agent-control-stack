import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore, defaultExecutionPlanForWorkItem } from "@agent-control-stack/work-items";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGateway } from "./server.js";
import { DEFAULT_LEASE_REAPER_INTERVAL_MS, resolveLeaseReaperIntervalMs, startLeaseReaper } from "./lease-reaper.js";

function hex(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

describe("resolveLeaseReaperIntervalMs", () => {
  it("defaults to 60s when unset", () => {
    expect(resolveLeaseReaperIntervalMs({})).toBe(DEFAULT_LEASE_REAPER_INTERVAL_MS);
    expect(resolveLeaseReaperIntervalMs({} as NodeJS.ProcessEnv)).toBe(60_000);
  });

  it("reads ACS_LEASE_REAPER_INTERVAL_MS", () => {
    expect(resolveLeaseReaperIntervalMs({ ACS_LEASE_REAPER_INTERVAL_MS: "5000" })).toBe(5000);
  });

  it("accepts 0 to disable the loop", () => {
    expect(resolveLeaseReaperIntervalMs({ ACS_LEASE_REAPER_INTERVAL_MS: "0" })).toBe(0);
  });

  it.each(["-1", "1.5", "abc"])("rejects %p", (raw) => {
    expect(() => resolveLeaseReaperIntervalMs({ ACS_LEASE_REAPER_INTERVAL_MS: raw })).toThrow(
      "ACS_LEASE_REAPER_INTERVAL_MS must be a non-negative integer (0 disables)"
    );
  });
});

describe("startLeaseReaper", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sweeps on each tick", () => {
    const failExpiredLeases = vi.fn();
    const handle = startLeaseReaper({ failExpiredLeases, intervalMs: 1000 });
    try {
      expect(failExpiredLeases).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(failExpiredLeases).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2000);
      expect(failExpiredLeases).toHaveBeenCalledTimes(3);
    } finally {
      handle.stop();
    }
  });

  it("reports sweep failures and keeps sweeping", () => {
    const onError = vi.fn();
    const failExpiredLeases = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("sweep blew up");
      })
      .mockImplementation(() => {});
    const handle = startLeaseReaper({ failExpiredLeases, intervalMs: 1000, onError });
    try {
      vi.advanceTimersByTime(1000);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
      vi.advanceTimersByTime(1000);
      expect(failExpiredLeases).toHaveBeenCalledTimes(2);
      expect(onError).toHaveBeenCalledTimes(1);
    } finally {
      handle.stop();
    }
  });

  it("stops sweeping after stop()", () => {
    const failExpiredLeases = vi.fn();
    const clearIntervalFn = vi.fn();
    const fakeTimer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const handle = startLeaseReaper({
      failExpiredLeases,
      intervalMs: 1000,
      setIntervalFn: () => fakeTimer,
      clearIntervalFn
    });
    handle.stop();
    expect(clearIntervalFn).toHaveBeenCalledWith(fakeTimer);
  });
});

describe("gateway lease reaper", () => {
  let root: string;
  let dbPath: string;
  const open: Array<{ close: () => Promise<unknown> }> = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "acs-lease-reaper-"));
    dbPath = join(root, "control.db");
  });

  afterEach(async () => {
    while (open.length) await open.pop()?.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function until(check: () => boolean, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("condition not met in time");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Seeds one work item whose attempt lease expires ~immediately. */
  function seedExpiredLease(): { attemptId: string } {
    const store = new SqliteWorkItemStore(dbPath);
    try {
      const workItem = store.create({
        title: "Lease reaper fixture",
        requester: "user",
        requesterSubject: "actor-user",
        intent: "prove the fixed-cadence reaper expires leases without traffic",
        target: { cwd: "/repo", files: ["src/index.ts"] },
        requestedActions: [
          { kind: "fs.read", description: "inspect", params: { paths: ["src/index.ts"], write: false } }
        ],
        risk: "low"
      });
      const definition = defaultExecutionPlanForWorkItem(workItem);
      const plan = store.createExecutionPlan({
        workItemId: workItem.id,
        definition,
        createdByActorId: "actor-user"
      });
      const admission = store.admitExecutionPlan(
        {
          workItemId: workItem.id,
          planHash: plan.planHash,
          policyVersion: "acs.policy.v1",
          policyDecisionHash: hex("1"),
          requiresApproval: false,
          admittedByActorId: "policy-gate"
        },
        { via: "policy_gate" }
      );
      store.approveWorkItem(workItem.id, { via: "domain_service" });
      const claimed = store.claimNextApprovedWorkItem("worker-1", {
        leaseMs: 1,
        attemptAuthority: {
          planHash: plan.planHash,
          admissionId: admission.admissionId,
          policyVersion: admission.policyVersion,
          policyDecisionHash: admission.policyDecisionHash
        }
      });
      if (!claimed?.attemptId) throw new Error("expected authoritative claim");
      return { attemptId: claimed.attemptId };
    } finally {
      store.close();
    }
  }

  function attemptStatus(attemptId: string): string | undefined {
    const store = new SqliteWorkItemStore(dbPath);
    try {
      return store.getAttempt(attemptId)?.status;
    } finally {
      store.close();
    }
  }

  function activeLease(attemptId: string): boolean {
    const store = new SqliteWorkItemStore(dbPath);
    try {
      // getActiveLeaseForAttempt returns the latest lease row regardless of
      // status; the reaper flips it to 'expired'.
      return store.getActiveLeaseForAttempt(attemptId)?.status === "active";
    } finally {
      store.close();
    }
  }

  it("reaps an expired lease on its own cadence, with no traffic", async () => {
    const { attemptId } = seedExpiredLease();
    expect(activeLease(attemptId)).toBe(true);
    const app = buildGateway({ dbPath, logger: false, leaseReaper: { intervalMs: 20 } });
    open.push(app);
    await app.ready();

    await until(() => !activeLease(attemptId));
    expect(attemptStatus(attemptId)).toBe("unknown");

    const store = new SqliteWorkItemStore(dbPath);
    try {
      expect(store.readEvents().map((event) => event.name)).toContain("attempt_lease.expired");
    } finally {
      store.close();
    }
  });

  it("does not reap when the loop is not configured", async () => {
    const { attemptId } = seedExpiredLease();
    const app = buildGateway({ dbPath, logger: false });
    open.push(app);
    await app.ready();

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(activeLease(attemptId)).toBe(true);
    expect(attemptStatus(attemptId)).toBe("running");
  });
});
