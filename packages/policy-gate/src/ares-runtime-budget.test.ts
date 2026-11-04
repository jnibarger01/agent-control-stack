import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPolicyEngine, createWorkItemTools } from "./index.js";
import { SqliteWorkItemStore, defaultExecutionPlanForWorkItem } from "@agent-control-stack/work-items";

// SQLite approval guards use wall time independently of Vitest's Date clock.
const T0 = Date.now() + 60_000;
const BUDGET = 2_000;
const resources: Array<{ store: SqliteWorkItemStore; directory: string }> = [];
afterEach(() => {
  for (const { store, directory } of resources.splice(0)) {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
  vi.useRealTimers();
});

function fixture(leaseMs: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  const directory = mkdtempSync(join(tmpdir(), "acs-ares-budget-"));
  const store = new SqliteWorkItemStore(join(directory, "control.db"));
  resources.push({ store, directory });
  const policy = createPolicyEngine();
  const tools = createWorkItemTools(store, policy);
  const item = tools.create_work_item({
    title: "synthetic runtime budget",
    requester: "user",
    requesterSubject: "alice",
    intent: "lease only; no executor",
    target: { services: ["ares"] },
    risk: "low",
    requestedActions: [{ kind: "ares.analyze.local", description: "synthetic", params: {} }]
  });
  const definition = defaultExecutionPlanForWorkItem(item);
  const plan = store.createExecutionPlan({
    workItemId: item.id,
    definition: {
      ...definition,
      constraints: { ...definition.constraints, maxRuntimeMs: BUDGET }
    },
    createdByActorId: "alice"
  });
  tools.approve_work_item({
    id: item.id,
    approvedBy: "bob",
    reason: "independent synthetic approval",
    actionHash: policy.evaluateWorkItem(item, "bob", "approve")[0]!.actionHash
  });
  const approval = store.getExecutionPlanApproval(
    item.id,
    plan.planHash,
    policy.evaluateWorkItem(item, "bob", "approve")[0]!.actionHash
  )!;
  const admission = store.admitExecutionPlan(
    {
      workItemId: item.id,
      planHash: plan.planHash,
      policyVersion: "acs.policy.v1",
      policyDecisionHash: "a".repeat(64),
      requiresApproval: true,
      admittedByActorId: "synthetic-policy"
    },
    { via: "policy_gate" }
  );
  const attempt = store.createAttempt(
    { workItemId: item.id, planHash: plan.planHash, inputHash: "b".repeat(64) },
    { via: "domain_service" }
  );
  const leaseToken = "synthetic-lease-token-0123456789abcdef";
  const lease = store.leaseAttempt(
    {
      workItemId: item.id,
      attemptId: attempt.attemptId,
      admissionId: admission.admissionId,
      approvalId: approval.approvalId,
      workerId: "ares",
      leaseToken,
      policyVersion: admission.policyVersion,
      policyDecisionHash: admission.policyDecisionHash,
      ttlMs: leaseMs
    },
    { via: "domain_service" }
  );
  const claimed = { attemptId: attempt.attemptId, leaseToken, leaseExpiresAt: lease.expiresAt };
  return { store, item, plan, claimed, lease, tools, policy };
}

describe("ARES approved runtime budget", () => {
  it("caps both the initial lease and renewal ceiling at the approved plan budget", () => {
    const { claimed, lease } = fixture(60_000);
    expect(Date.parse(claimed.leaseExpiresAt)).toBe(T0 + BUDGET);
    expect(Date.parse(lease.maxExpiresAt)).toBe(T0 + BUDGET);
  });

  it("does not let renewal extend an attempt beyond its original execution deadline", () => {
    const { store, item, claimed, lease } = fixture(800);
    vi.setSystemTime(T0 + 400);
    const renewed = store.renewAttemptLease({
      workItemId: item.id,
      attemptId: claimed.attemptId!,
      leaseId: lease.leaseId,
      workerId: "ares",
      leaseToken: claimed.leaseToken,
      fencingEpoch: lease.fencingEpoch,
      ttlMs: 60_000
    });
    expect(Date.parse(renewed.expiresAt)).toBe(T0 + BUDGET);
    vi.setSystemTime(T0 + BUDGET);
    expect(() =>
      store.renewAttemptLease({
        workItemId: item.id,
        attemptId: claimed.attemptId!,
        leaseId: lease.leaseId,
        workerId: "ares",
        leaseToken: claimed.leaseToken,
        fencingEpoch: lease.fencingEpoch,
        ttlMs: 60_000
      })
    ).toThrowError(expect.objectContaining({ code: "worker_lease_expired" }));
  });

  it("preserves the first-lease deadline across an independently reapproved interruption", () => {
    const { store, item, plan, claimed, lease, tools, policy } = fixture(800);
    vi.setSystemTime(T0 + 400);
    store.transitionAttempt(
      {
        workItemId: item.id,
        attemptId: claimed.attemptId,
        workerId: "ares",
        fencingEpoch: lease.fencingEpoch,
        status: "interrupted"
      },
      { via: "domain_service" }
    );
    tools.approve_work_item({
      id: item.id,
      approvedBy: "bob",
      reason: "fresh independent approval for resume",
      actionHash: policy.evaluateWorkItem(item, "bob", "approve")[0]!.actionHash
    });
    const approval = store.getExecutionPlanApproval(
      item.id,
      plan.planHash,
      policy.evaluateWorkItem(item, "bob", "approve")[0]!.actionHash
    )!;
    const eventCount = store.readEvents().length;
    expect(() =>
      store.leaseAttempt(
        {
          attemptId: claimed.attemptId,
          workItemId: item.id,
          admissionId: lease.admissionId,
          approvalId: approval.approvalId,
          workerId: "unnamed-worker",
          leaseToken: "synthetic-resume-token-0123456789abcdef",
          policyVersion: lease.policyVersion,
          policyDecisionHash: lease.policyDecisionHash,
          ttlMs: 60_000
        },
        { via: "domain_service" }
      )
    ).toThrowError(expect.objectContaining({ code: "worker_target_mismatch" }));
    expect(store.readEvents()).toHaveLength(eventCount);
    const resumed = store.leaseAttempt(
      {
        attemptId: claimed.attemptId,
        workItemId: item.id,
        admissionId: lease.admissionId,
        approvalId: approval.approvalId,
        workerId: "ares",
        leaseToken: "synthetic-resume-token-0123456789abcdef",
        policyVersion: lease.policyVersion,
        policyDecisionHash: lease.policyDecisionHash,
        ttlMs: 60_000
      },
      { via: "domain_service" }
    );
    expect(resumed.fencingEpoch).toBe(lease.fencingEpoch + 1);
    expect(Date.parse(resumed.expiresAt)).toBe(T0 + BUDGET);
    expect(Date.parse(resumed.maxExpiresAt)).toBe(T0 + BUDGET);
  });

  it("does not reset the runtime budget when an interrupted attempt is leased again", () => {
    const { store, item, claimed, lease } = fixture(60_000);
    vi.setSystemTime(T0 + 500);
    store.transitionAttempt(
      {
        workItemId: item.id,
        attemptId: claimed.attemptId!,
        workerId: "ares",
        fencingEpoch: lease.fencingEpoch,
        status: "interrupted"
      },
      { via: "domain_service" }
    );
    vi.setSystemTime(T0 + BUDGET);
    const eventCount = store.readEvents().length;
    expect(() =>
      store.leaseAttempt(
        {
          attemptId: claimed.attemptId!,
          workItemId: item.id,
          admissionId: lease.admissionId,
          approvalId: lease.approvalId,
          workerId: "ares",
          leaseToken: "synthetic-new-token-0123456789abcdef",
          policyVersion: lease.policyVersion,
          policyDecisionHash: lease.policyDecisionHash,
          ttlMs: 60_000
        },
        { via: "domain_service" }
      )
    ).toThrowError(expect.objectContaining({ code: "worker_lease_expired" }));
    expect(store.readEvents()).toHaveLength(eventCount);
    expect(store.getAttempt(claimed.attemptId!)?.currentFencingEpoch).toBe(lease.fencingEpoch);
  });
});
