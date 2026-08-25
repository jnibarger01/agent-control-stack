import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteWorkItemStore, defaultExecutionPlanForWorkItem } from "@agent-control-stack/work-items";
import { buildGateway } from "./server.js";

function hex(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

describe("GET /work-items/:id execution authority detail", () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("returns persisted attempts and safe leases without exposing the lease token hash", async () => {
    directory = mkdtempSync(join(tmpdir(), "acs-gateway-execution-detail-"));
    const dbPath = join(directory, "control.db");
    const seed = new SqliteWorkItemStore(dbPath);
    const workItem = seed.create({
      title: "Execution detail",
      requester: "user",
      intent: "show current execution authority",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.read", description: "inspect", params: {} }],
      risk: "low"
    });
    const plan = seed.createExecutionPlan({
      workItemId: workItem.id,
      definition: defaultExecutionPlanForWorkItem(workItem),
      createdByActorId: "operator"
    });
    const admission = seed.admitExecutionPlan(
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
    const attempt = seed.createAttempt(
      { workItemId: workItem.id, planHash: plan.planHash, inputHash: hex("a") },
      { via: "domain_service" }
    );
    const lease = seed.leaseAttempt(
      {
        attemptId: attempt.attemptId,
        workItemId: workItem.id,
        admissionId: admission.admissionId,
        workerId: "worker-1",
        leaseToken: "lease-token-for-gateway-test",
        policyVersion: admission.policyVersion,
        policyDecisionHash: admission.policyDecisionHash,
        ttlMs: 60_000
      },
      { via: "domain_service" }
    );
    seed.close();

    const app = buildGateway({
      dbPath,
      logger: false,
      auth: { token: "dashboard-secret", actor: "user" }
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/work-items/${workItem.id}`,
        headers: { authorization: "Bearer dashboard-secret" }
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.executionAttempts).toEqual([
        expect.objectContaining({
          attemptId: attempt.attemptId,
          status: "leased",
          currentFencingEpoch: 1,
          claimedByWorkerId: "worker-1"
        })
      ]);
      expect(body.attemptLeases).toEqual([
        expect.objectContaining({
          leaseId: lease.leaseId,
          attemptId: attempt.attemptId,
          workerId: "worker-1",
          fencingEpoch: 1,
          status: "active"
        })
      ]);
      expect(body.attemptLeases[0]).not.toHaveProperty("tokenHash");
      expect(response.body).not.toContain(lease.tokenHash);
    } finally {
      await app.close();
    }
  });
});
