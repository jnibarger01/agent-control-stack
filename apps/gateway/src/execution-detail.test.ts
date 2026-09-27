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

  it("enriches each attempt with its own plan's execution mode, never the final result", async () => {
    directory = mkdtempSync(join(tmpdir(), "acs-gateway-attempt-plan-mode-"));
    const dbPath = join(directory, "control.db");
    const seed = new SqliteWorkItemStore(dbPath);
    const workItem = seed.create({
      title: "Attempt plan modes",
      requester: "user",
      intent: "each attempt keeps its own plan mode",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.read", description: "inspect", params: {} }],
      risk: "low"
    });
    const dryPlan = seed.createExecutionPlan({
      workItemId: workItem.id,
      definition: defaultExecutionPlanForWorkItem(workItem),
      createdByActorId: "operator"
    });
    const dryAdmission = seed.admitExecutionPlan(
      {
        workItemId: workItem.id,
        planHash: dryPlan.planHash,
        policyVersion: "acs.policy.v1",
        policyDecisionHash: hex("1"),
        requiresApproval: false,
        admittedByActorId: "policy-gate"
      },
      { via: "policy_gate" }
    );
    const dryAttempt = seed.createAttempt(
      { workItemId: workItem.id, planHash: dryPlan.planHash, inputHash: hex("a") },
      { via: "domain_service" }
    );
    seed.leaseAttempt(
      {
        attemptId: dryAttempt.attemptId,
        workItemId: workItem.id,
        admissionId: dryAdmission.admissionId,
        workerId: "worker-1",
        leaseToken: "lease-token-for-plan-mode-test",
        policyVersion: dryAdmission.policyVersion,
        policyDecisionHash: dryAdmission.policyDecisionHash,
        ttlMs: 60_000
      },
      { via: "domain_service" }
    );
    // Terminal state so the work item can be replanned; the attempt row keeps
    // its own planId binding.
    for (const status of ["running", "failed"] as const) {
      seed.transitionAttempt(
        {
          attemptId: dryAttempt.attemptId,
          workItemId: workItem.id,
          workerId: "worker-1",
          fencingEpoch: 1,
          status,
          outcomeCode: "simulated-dry-run-failure"
        },
        { via: "domain_service" }
      );
    }
    // Replan to live execution; the second attempt binds to the new plan.
    const livePlan = seed.createExecutionPlan({
      workItemId: workItem.id,
      definition: defaultExecutionPlanForWorkItem(workItem, { executionMode: "desktop_commander" }),
      createdByActorId: "operator",
      expectedCurrentPlanHash: dryPlan.planHash
    });
    const liveAttempt = seed.createAttempt(
      { workItemId: workItem.id, planHash: livePlan.planHash, inputHash: hex("b") },
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
      interface EnrichedAttempt {
        attemptId: string;
        plan: { planId: string; definition: { constraints: { executionMode: string } } };
      }
      const attempts = response.json().executionAttempts as EnrichedAttempt[];
      expect(attempts).toHaveLength(2);
      const byId = new Map(attempts.map((a) => [a.attemptId, a]));
      // Each attempt carries its own plan's mode — the first attempt still
      // reports dry_run even though the work item was later replanned live.
      const dryEnriched = byId.get(dryAttempt.attemptId);
      const liveEnriched = byId.get(liveAttempt.attemptId);
      expect(dryEnriched?.plan.planId).toBe(dryPlan.planId);
      expect(dryEnriched?.plan.definition.constraints.executionMode).toBe("dry_run");
      expect(liveEnriched?.plan.planId).toBe(livePlan.planId);
      expect(liveEnriched?.plan.definition.constraints.executionMode).toBe("desktop_commander");
    } finally {
      await app.close();
    }
  });
});
