import { describe, expect, it } from "vitest";
import { attempt, event, HASH_A, HASH_B, lease, workItem } from "../test-fixtures";
import {
  admissionFor,
  currentPlan,
  latestAttempt,
  leaseForAttempt,
  leaseRemainingMs,
  sanitizeLease,
  summarizeExecutions,
  type ExecutionRow
} from "./execution";

const row = (a: ReturnType<typeof attempt> | undefined, l?: ReturnType<typeof lease>, attempts = 1): ExecutionRow => ({
  key: a?.attemptId ?? "x",
  workItem: workItem(),
  attempt: a,
  lease: l,
  retryCount: attempts - 1,
  attemptCount: attempts
});

describe("plan and admission (audit-derived)", () => {
  const created = event(
    "execution_plan.created",
    { "work_item.id": "wrk_1", "plan.id": "plan_2" },
    { planId: "plan_2", planNumber: 2, planHash: HASH_A, createdByActorId: "op" }
  );
  const admitted = event(
    "execution_plan.admitted",
    { "work_item.id": "wrk_1" },
    {
      admissionId: "adm_1",
      planId: "plan_2",
      planHash: HASH_A,
      policyVersion: "v3",
      policyDecisionHash: HASH_B,
      requiresApproval: true,
      admittedByActorId: "gate",
      admittedAt: "2026-09-19T10:00:00.000Z"
    }
  );

  it("finds the latest plan and its admission", () => {
    const plan = currentPlan([created]);
    expect(plan).toMatchObject({ planId: "plan_2", planNumber: 2, planHash: HASH_A });
    expect(admissionFor([created, admitted], plan)).toMatchObject({
      admissionId: "adm_1",
      policyVersion: "v3",
      policyDecisionHash: HASH_B,
      requiresApproval: true
    });
  });
  it("a plan without an admission is reported as not admitted (never inferred)", () => {
    expect(admissionFor([created], currentPlan([created]))).toBeUndefined();
  });
  it("ignores an admission that belongs to a different plan hash", () => {
    const other = event("execution_plan.admitted", {}, { planHash: HASH_B, admissionId: "adm_x" });
    expect(admissionFor([created, other], currentPlan([created]))).toBeUndefined();
  });
});

describe("attempts and summaries", () => {
  it("latestAttempt is the highest attempt number", () => {
    expect(
      latestAttempt([
        attempt({ attemptNumber: 1, attemptId: "a1" }),
        attempt({ attemptNumber: 3, attemptId: "a3" }),
        attempt({ attemptNumber: 2, attemptId: "a2" })
      ])?.attemptId
    ).toBe("a3");
  });
  it("leaseForAttempt picks the highest fencing epoch for that attempt", () => {
    const leases = [
      lease({ leaseId: "l1", fencingEpoch: 1 }),
      lease({ leaseId: "l2", fencingEpoch: 2 }),
      lease({ leaseId: "l3", attemptId: "other", fencingEpoch: 9 })
    ];
    expect(leaseForAttempt(leases, "att_1")?.leaseId).toBe("l2");
    expect(leaseForAttempt(leases, undefined)).toBeUndefined();
  });
  it("summarizeExecutions buckets running/queued/completed/failed and counts retries and active leases", () => {
    const summary = summarizeExecutions([
      row(attempt({ status: "running" }), lease({ status: "active" })),
      row(attempt({ status: "leased" }), lease({ status: "active" })),
      row(attempt({ status: "pending" })),
      row(attempt({ status: "succeeded" }), lease({ status: "consumed" }), 3),
      row(attempt({ status: "failed" }), undefined, 2),
      row(attempt({ status: "quarantined" })),
      row(undefined)
    ]);
    expect(summary).toEqual({ running: 2, queued: 1, completed: 1, failed: 2, retries: 3, activeLeases: 2 });
  });
});

describe("lease sanitization", () => {
  it("strips token and hash-of-token keys defensively", () => {
    const dirty = {
      ...lease(),
      tokenHash: "deadbeef",
      token: "secret",
      leaseToken: "secret2",
      authorization: "Bearer x"
    } as Record<string, unknown>;
    const clean = sanitizeLease(dirty) as unknown as Record<string, unknown>;
    for (const key of ["tokenHash", "token", "leaseToken", "authorization"]) expect(clean).not.toHaveProperty(key);
    expect(clean.leaseId).toBe("lease_1");
    expect(JSON.stringify(clean)).not.toMatch(/secret|deadbeef|Bearer/);
  });
  it("remaining lease life is only defined for active leases and goes negative after expiry", () => {
    const now = Date.parse("2026-09-19T10:04:00.000Z");
    expect(leaseRemainingMs(lease(), now)).toBe(60_000);
    expect(leaseRemainingMs(lease({ expiresAt: "2026-09-19T10:00:00.000Z" }), now)).toBeLessThan(0);
    expect(leaseRemainingMs(lease({ status: "consumed" }), now)).toBeUndefined();
  });
});
