import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteWorkItemStore, defaultExecutionPlanForWorkItem } from "./index.js";

function hex(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function createFixture(options: { leaseMs?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "acs-lease-renewal-"));
  const dbPath = join(directory, "control.db");
  const store = new SqliteWorkItemStore(dbPath, { leaseMs: options.leaseMs });
  const workItem = store.create({
    title: "Lease renewal fixture",
    requester: "user",
    requesterSubject: "actor-user",
    intent: "prove renew/expiry/steal safety",
    target: { cwd: "/repo" },
    requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["README.md"], write: false } }],
    risk: "low"
  });
  const plan = store.createExecutionPlan({
    workItemId: workItem.id,
    definition: defaultExecutionPlanForWorkItem(workItem),
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
  return { directory, store, workItem, plan, admission };
}

function claimAuthoritative(fixture: ReturnType<typeof createFixture>, workerId: string, leaseMs?: number) {
  fixture.store.approveWorkItem(fixture.workItem.id, { via: "domain_service" });
  const claimed = fixture.store.claimNextApprovedWorkItem(workerId, {
    ...(leaseMs === undefined ? {} : { leaseMs }),
    attemptAuthority: {
      planHash: fixture.plan.planHash,
      admissionId: fixture.admission.admissionId,
      policyVersion: fixture.admission.policyVersion,
      policyDecisionHash: fixture.admission.policyDecisionHash
    }
  });
  if (!claimed?.attemptId || claimed.fencingEpoch === undefined) {
    throw new Error("expected authoritative claim");
  }
  return claimed;
}

function resultInput(claimed: NonNullable<ReturnType<typeof claimAuthoritative>>, workerId = claimed.workerId) {
  return {
    workItemId: claimed.id,
    attemptId: claimed.attemptId!,
    leaseId: claimed.leaseId,
    workerId,
    actionHash: claimed.actionHash,
    planHash: claimed.planHash!,
    inputHash: claimed.inputHash!,
    fencingEpoch: claimed.fencingEpoch!,
    idempotencyKey: stableHash({ domain: "acs.attempt-result.v1", attemptId: claimed.attemptId }),
    outcome: "succeeded" as const,
    startedAt: claimed.startedAt,
    finishedAt: new Date(Date.parse(claimed.startedAt) + 10).toISOString(),
    exitCode: 0,
    summary: "ok",
    structuredOutput: {},
    artifacts: [],
    simulationMetadata: { executionMode: "dry_run", simulated: true }
  };
}

describe("attempt lease renewal, expiry, and steal", () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("renews an active lease within maxExpiresAt and emits attempt_lease.renewed", () => {
    const fixture = createFixture({ leaseMs: 60_000 });
    directory = fixture.directory;
    const issuedAt = new Date("2026-03-01T00:00:00.000Z");
    const attempt = fixture.store.createAttempt(
      { workItemId: fixture.workItem.id, planHash: fixture.plan.planHash, inputHash: hex("a") },
      { via: "domain_service" }
    );
    const lease = fixture.store.leaseAttempt(
      {
        attemptId: attempt.attemptId,
        workItemId: fixture.workItem.id,
        admissionId: fixture.admission.admissionId,
        workerId: "worker-1",
        leaseToken: "a".repeat(32),
        policyVersion: "acs.policy.v1",
        policyDecisionHash: hex("1"),
        ttlMs: 60_000,
        maxTtlMs: 10 * 60_000,
        now: issuedAt
      },
      { via: "domain_service" }
    );

    const renewed = fixture.store.renewAttemptLease({
      leaseId: lease.leaseId,
      attemptId: attempt.attemptId,
      workItemId: fixture.workItem.id,
      workerId: "worker-1",
      leaseToken: "a".repeat(32),
      fencingEpoch: lease.fencingEpoch,
      ttlMs: 60_000,
      now: new Date(issuedAt.getTime() + 30_000)
    });

    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(lease.expiresAt));
    expect(Date.parse(renewed.expiresAt)).toBeLessThanOrEqual(Date.parse(lease.maxExpiresAt));
    expect(renewed.lastRenewedAt).not.toBe(lease.lastRenewedAt);
    expect(fixture.store.readEvents().map((event) => event.name)).toContain("attempt_lease.renewed");
  });

  it("rejects renewals with the wrong token, fence, or past max duration", () => {
    const fixture = createFixture();
    directory = fixture.directory;
    const issuedAt = new Date("2026-03-01T00:00:00.000Z");
    const attempt = fixture.store.createAttempt(
      { workItemId: fixture.workItem.id, planHash: fixture.plan.planHash, inputHash: hex("a") },
      { via: "domain_service" }
    );
    const lease = fixture.store.leaseAttempt(
      {
        attemptId: attempt.attemptId,
        workItemId: fixture.workItem.id,
        admissionId: fixture.admission.admissionId,
        workerId: "worker-1",
        leaseToken: "a".repeat(32),
        policyVersion: "acs.policy.v1",
        policyDecisionHash: hex("1"),
        ttlMs: 60_000,
        maxTtlMs: 60_000,
        now: issuedAt
      },
      { via: "domain_service" }
    );

    expect(() =>
      fixture.store.renewAttemptLease({
        leaseId: lease.leaseId,
        attemptId: attempt.attemptId,
        workItemId: fixture.workItem.id,
        workerId: "worker-1",
        leaseToken: "b".repeat(32),
        fencingEpoch: lease.fencingEpoch,
        ttlMs: 30_000,
        now: new Date(issuedAt.getTime() + 1_000)
      })
    ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "worker_lease_mismatch" }));

    expect(() =>
      fixture.store.renewAttemptLease({
        leaseId: lease.leaseId,
        attemptId: attempt.attemptId,
        workItemId: fixture.workItem.id,
        workerId: "worker-2",
        leaseToken: "a".repeat(32),
        fencingEpoch: lease.fencingEpoch,
        ttlMs: 30_000,
        now: new Date(issuedAt.getTime() + 1_000)
      })
    ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "attempt_fence_mismatch" }));

    expect(() =>
      fixture.store.renewAttemptLease({
        leaseId: lease.leaseId,
        attemptId: attempt.attemptId,
        workItemId: fixture.workItem.id,
        workerId: "worker-1",
        leaseToken: "a".repeat(32),
        fencingEpoch: lease.fencingEpoch,
        ttlMs: 60_000,
        now: new Date(issuedAt.getTime() + 30_000)
      })
    ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "lease_renewal_exhausted" }));
  });

  it("expires via failExpiredLeases after the renewed clock and emits attempt_lease.expired", () => {
    const fixture = createFixture({ leaseMs: 60_000 });
    directory = fixture.directory;
    const claimed = claimAuthoritative(fixture, "worker-1", 60_000);
    const renewed = fixture.store.renewAttemptLease({
      leaseId: claimed.leaseId,
      attemptId: claimed.attemptId!,
      workItemId: claimed.id,
      workerId: claimed.workerId,
      leaseToken: claimed.leaseToken,
      fencingEpoch: claimed.fencingEpoch!,
      ttlMs: 120_000,
      now: new Date(Date.parse(claimed.startedAt) + 1_000)
    });

    expect(fixture.store.failExpiredLeases(new Date(Date.parse(claimed.leaseExpiresAt) + 1))).toHaveLength(0);
    const failed = fixture.store.failExpiredLeases(new Date(Date.parse(renewed.expiresAt) + 1));
    expect(failed).toHaveLength(1);
    expect(failed[0]?.status).toBe("failed");
    expect(fixture.store.getAttempt(claimed.attemptId!)?.status).toBe("unknown");
    expect(fixture.store.readEvents().filter((event) => event.name === "attempt_lease.expired")).toHaveLength(1);
  });

  it("steals an interrupted attempt lease so the prior worker cannot complete", () => {
    const fixture = createFixture();
    directory = fixture.directory;
    const attempt = fixture.store.createAttempt(
      { workItemId: fixture.workItem.id, planHash: fixture.plan.planHash, inputHash: hex("a") },
      { via: "domain_service" }
    );
    const first = fixture.store.leaseAttempt(
      {
        attemptId: attempt.attemptId,
        workItemId: fixture.workItem.id,
        admissionId: fixture.admission.admissionId,
        workerId: "worker-a",
        leaseToken: "a".repeat(32),
        policyVersion: "acs.policy.v1",
        policyDecisionHash: hex("1"),
        ttlMs: 60_000
      },
      { via: "domain_service" }
    );
    fixture.store.transitionAttempt(
      {
        attemptId: attempt.attemptId,
        workItemId: fixture.workItem.id,
        workerId: "worker-a",
        fencingEpoch: first.fencingEpoch,
        status: "interrupted"
      },
      { via: "domain_service" }
    );

    const second = fixture.store.leaseAttempt(
      {
        attemptId: attempt.attemptId,
        workItemId: fixture.workItem.id,
        admissionId: fixture.admission.admissionId,
        workerId: "worker-b",
        leaseToken: "b".repeat(32),
        policyVersion: "acs.policy.v1",
        policyDecisionHash: hex("1"),
        ttlMs: 60_000
      },
      { via: "domain_service" }
    );

    expect(second.fencingEpoch).toBe(first.fencingEpoch + 1);
    expect(fixture.store.getActiveLeaseForAttempt(attempt.attemptId)?.leaseId).toBe(second.leaseId);
    expect(fixture.store.readEvents().filter((event) => event.name === "attempt_lease.stolen")).toHaveLength(1);
    expect(() =>
      fixture.store.transitionAttempt(
        {
          attemptId: attempt.attemptId,
          workItemId: fixture.workItem.id,
          workerId: "worker-a",
          fencingEpoch: first.fencingEpoch,
          status: "running"
        },
        { via: "domain_service" }
      )
    ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "attempt_transition_fence_stale" }));
  });

  it("lets only one of two concurrent completes win for the same claimed item", () => {
    const fixture = createFixture();
    directory = fixture.directory;
    const claimed = claimAuthoritative(fixture, "worker-a");
    const winner = resultInput(claimed);
    const loser = {
      ...winner,
      workerId: "worker-b",
      fencingEpoch: claimed.fencingEpoch! + 1
    };

    expect(() => fixture.store.submitWorkResult(loser)).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "attempt_fence_mismatch" })
    );
    const accepted = fixture.store.submitWorkResult(winner);
    expect(accepted.status).toBe("succeeded");
    expect(fixture.store.submitWorkResult(winner).status).toBe("succeeded");
  });
});
