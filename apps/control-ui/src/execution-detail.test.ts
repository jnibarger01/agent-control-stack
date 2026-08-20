import { describe, expect, it } from "vitest";
import { renderDashboard, toMissionControlAttemptLease, type MissionControlViewModel } from "./index.js";

const workItem = {
  id: "wrk_execution",
  title: "Execute governed work",
  requester: "user" as const,
  status: "running" as const,
  intent: "verify attempt and lease visibility",
  target: { cwd: "/repo" },
  requestedActions: [{ kind: "fs.read", description: "inspect source", params: {} }],
  risk: "low" as const,
  createdAt: "2026-08-20T10:00:00.000Z",
  updatedAt: "2026-08-20T10:00:10.000Z"
};

const attempt = {
  attemptId: "attempt_1",
  workItemId: workItem.id,
  planId: "plan_1",
  planHash: "b".repeat(64),
  attemptNumber: 1,
  protocolVersion: "acs.worker.v2" as const,
  inputHash: "a".repeat(64),
  status: "leased" as const,
  currentFencingEpoch: 1,
  claimedByWorkerId: "worker-1",
  createdAt: "2026-08-20T10:00:05.000Z",
  updatedAt: "2026-08-20T10:00:06.000Z"
};

const lease = {
  leaseId: "lease_1",
  attemptId: attempt.attemptId,
  workItemId: workItem.id,
  admissionId: "admission_1",
  workerId: "worker-1",
  tokenHash: "f".repeat(64),
  planHash: attempt.planHash,
  inputHash: attempt.inputHash,
  fencingEpoch: 1,
  protocolVersion: "acs.worker.v2" as const,
  policyVersion: "acs.policy.v1",
  policyDecisionHash: "c".repeat(64),
  issuedAt: "2026-08-20T10:00:06.000Z",
  expiresAt: "2026-08-20T10:01:06.000Z",
  maxExpiresAt: "2026-08-20T10:01:06.000Z",
  lastRenewedAt: "2026-08-20T10:00:06.000Z",
  status: "active" as const
};

describe("execution attempt and lease dashboard projection", () => {
  it("removes the persisted lease token hash before data crosses the dashboard boundary", () => {
    const projected = toMissionControlAttemptLease(lease);

    expect(projected).toMatchObject({
      leaseId: "lease_1",
      attemptId: "attempt_1",
      workerId: "worker-1",
      fencingEpoch: 1,
      status: "active"
    });
    expect(projected).not.toHaveProperty("tokenHash");
  });

  it("wires execution attempts and safe leases into the work-item detail client", () => {
    const safeLease = toMissionControlAttemptLease(lease);
    const model: MissionControlViewModel = {
      workItems: [workItem],
      events: [],
      executionAttemptsByWorkItem: { [workItem.id]: [attempt] },
      attemptLeasesByWorkItem: { [workItem.id]: [safeLease] }
    };

    const html = renderDashboard(model);

    expect(html).toContain("Attempt #1");
    expect(html).toContain("worker-1");
    expect(html).toContain("lease active");
    expect(html).toContain("body.executionAttempts || []");
    expect(html).toContain("body.attemptLeases || []");
    expect(html).toContain("Execution Authority");
    expect(html).toContain("Fencing epoch");
    expect(html).not.toContain(lease.tokenHash);
  });
});
