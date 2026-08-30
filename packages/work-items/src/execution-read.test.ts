import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteExecutionReadStore, SqliteWorkItemStore, defaultExecutionPlanForWorkItem } from "./index.js";

function hex(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

describe("SqliteExecutionReadStore", () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("lists canonical execution attempts and attempt leases for one work item", () => {
    directory = mkdtempSync(join(tmpdir(), "acs-execution-read-"));
    const dbPath = join(directory, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    const workItem = store.create({
      title: "Dashboard execution read model",
      requester: "user",
      intent: "surface persisted execution authority",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.read", description: "inspect", params: {} }],
      risk: "low"
    });
    const plan = store.createExecutionPlan({
      workItemId: workItem.id,
      definition: defaultExecutionPlanForWorkItem(workItem),
      createdByActorId: "operator"
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
    const attempt = store.createAttempt(
      { workItemId: workItem.id, planHash: plan.planHash, inputHash: hex("a") },
      { via: "domain_service" }
    );
    const lease = store.leaseAttempt(
      {
        attemptId: attempt.attemptId,
        workItemId: workItem.id,
        admissionId: admission.admissionId,
        workerId: "worker-1",
        leaseToken: "lease-token-for-dashboard-test",
        policyVersion: admission.policyVersion,
        policyDecisionHash: admission.policyDecisionHash,
        ttlMs: 60_000
      },
      { via: "domain_service" }
    );
    store.close();

    const reads = new SqliteExecutionReadStore(dbPath);
    try {
      expect(reads.listExecutionAttempts(workItem.id)).toEqual([
        expect.objectContaining({
          attemptId: attempt.attemptId,
          workItemId: workItem.id,
          status: "leased",
          currentFencingEpoch: 1,
          claimedByWorkerId: "worker-1"
        })
      ]);
      expect(reads.listAttemptLeases(workItem.id)).toEqual([
        expect.objectContaining({
          leaseId: lease.leaseId,
          attemptId: attempt.attemptId,
          workItemId: workItem.id,
          workerId: "worker-1",
          fencingEpoch: 1,
          status: "active"
        })
      ]);
      expect(reads.listExecutionAttempts("wrk_missing")).toEqual([]);
      expect(reads.listAttemptLeases("wrk_missing")).toEqual([]);
    } finally {
      reads.close();
    }
  });
});
