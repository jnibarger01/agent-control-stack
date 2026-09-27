import { describe, expect, it } from "vitest";
import { bootLive } from "./live-harness.test-support.js";
import type { MissionControlViewModel } from "./index.js";

const CLOCK_START_MS = 1_800_000_000_000; // fixed clock the live harness starts at

const item = {
  id: "wrk_lease_warn",
  title: "Lease expiry warning",
  requester: "user" as const,
  status: "running" as const,
  intent: "verify the expiring-soon lease warning",
  target: { cwd: "/repo" },
  requestedActions: [{ kind: "fs.read", description: "inspect source", params: {} }],
  risk: "low" as const,
  createdAt: new Date(CLOCK_START_MS - 60_000).toISOString(),
  updatedAt: new Date(CLOCK_START_MS - 30_000).toISOString()
};

const attempt = {
  attemptId: "attempt_1",
  workItemId: item.id,
  planId: "plan_1",
  planHash: "b".repeat(64),
  attemptNumber: 1,
  protocolVersion: "acs.worker.v2" as const,
  inputHash: "a".repeat(64),
  status: "leased" as const,
  currentFencingEpoch: 1,
  claimedByWorkerId: "worker-1",
  createdAt: new Date(CLOCK_START_MS - 30_000).toISOString(),
  updatedAt: new Date(CLOCK_START_MS - 30_000).toISOString()
};

function leaseWith(expiresInMs: number, ttlMs = 5 * 60_000, overrides: Record<string, unknown> = {}) {
  const expiresAt = new Date(CLOCK_START_MS + expiresInMs).toISOString();
  return {
    leaseId: "lease_1",
    attemptId: attempt.attemptId,
    workItemId: item.id,
    admissionId: "admission_1",
    workerId: "worker-1",
    planHash: attempt.planHash,
    inputHash: attempt.inputHash,
    fencingEpoch: 1,
    protocolVersion: "acs.worker.v2" as const,
    policyVersion: "acs.policy.v1",
    policyDecisionHash: "c".repeat(64),
    issuedAt: new Date(CLOCK_START_MS + expiresInMs - ttlMs).toISOString(),
    expiresAt,
    maxExpiresAt: expiresAt,
    lastRenewedAt: new Date(CLOCK_START_MS - 30_000).toISOString(),
    status: "active" as const,
    ...overrides
  };
}

function initial(): MissionControlViewModel {
  return { workItems: [item], events: [], executionAttemptsByWorkItem: { [item.id]: [attempt] } };
}

async function openDetail(lease: ReturnType<typeof leaseWith> | undefined) {
  const app = bootLive(initial(), {
    [`/work-items/${item.id}`]: () => ({
      status: 200,
      body: {
        workItem: item,
        events: [],
        executionAttempts: [attempt],
        attemptLeases: lease ? [lease] : []
      }
    })
  });
  app.open();
  await app.advance(2_000);
  (app.document.querySelector(`[data-work-item="${item.id}"]`) as HTMLElement).click();
  await app.flush();
  return app;
}

describe("lease expiring-soon warning (wave-2 item #5, presentation only)", () => {
  it("warns when less than 20% of the observed TTL remains", async () => {
    // TTL 5 min -> threshold max(60s, 60s) = 60s; 30s remaining warns.
    const app = await openDetail(leaseWith(30_000));
    expect(app.text(".lease-block .lease-head")).toContain("expiring soon — warning only");
  });

  it("does not warn while ample TTL remains", async () => {
    const app = await openDetail(leaseWith(4 * 60_000));
    expect(app.text(".lease-block .lease-head")).not.toContain("expiring soon");
  });

  it("does not warn for an already-expired or non-active lease", async () => {
    const app = await openDetail(leaseWith(-10_000));
    expect(app.text(".lease-block .lease-head")).not.toContain("expiring soon");

    const released = await openDetail(leaseWith(30_000, 5 * 60_000, { status: "released" }));
    expect(released.text(".lease-block .lease-head")).not.toContain("expiring soon");
  });

  it("uses the 60-second floor for short leases and renders nothing without lease data", async () => {
    // TTL 3 min -> threshold max(60s, 36s) = 60s; 50s remaining warns.
    const short = await openDetail(leaseWith(50_000, 3 * 60_000));
    expect(short.text(".lease-block .lease-head")).toContain("expiring soon — warning only");

    // TTL 3 min -> 90s remaining is above the 60s floor: no warning.
    const mid = await openDetail(leaseWith(90_000, 3 * 60_000));
    expect(mid.text(".lease-block .lease-head")).not.toContain("expiring soon");

    const none = await openDetail(undefined);
    expect(none.document.querySelector(".lease-block")).toBeNull();
  });
});
