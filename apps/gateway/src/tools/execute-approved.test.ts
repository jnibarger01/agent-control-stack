import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { executeApprovedWorkItem } from "./execute-approved.js";

const transition = { via: "domain_service" as const };

function createApproved(dbPath: string): { store: SqliteWorkItemStore; id: string } {
  const store = new SqliteWorkItemStore(dbPath);
  const item = store.create({
    title: "Approved dispatcher item",
    requester: "agent",
    intent: "exercise the dry-run dispatcher",
    target: { cwd: "/repo" },
    requestedActions: [{ kind: "fs.read", description: "simulate", params: { paths: ["src/index.ts"] } }],
    risk: "low"
  });
  store.approveWorkItem(item.id, transition);
  return { store, id: item.id };
}

describe("approved execution dispatcher", () => {
  it("submits a canonical simulated result through the lease boundary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-approved-dispatch-"));
    const { store, id } = createApproved(join(directory, "control.db"));
    try {
      const result = await executeApprovedWorkItem({
        store,
        workerId: "dispatcher-worker",
        execute: async () => ({ ok: true, executionMode: "dry_run", output: "no real command ran" })
      });

      expect(result).toMatchObject({ executed: true, workItemId: id });
      expect(store.get(id)).toMatchObject({ status: "succeeded", result: { executionMode: "dry_run" } });
      expect(store.verifyAuditChain()).toMatchObject({ ok: true });
      expect(store.readEvents().map((event) => event.name)).toContain("execution_result.accepted");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records simulated worker infrastructure failures without reopening the item", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-approved-dispatch-failure-"));
    const { store, id } = createApproved(join(directory, "control.db"));
    try {
      await executeApprovedWorkItem({
        store,
        workerId: "dispatcher-worker",
        execute: async () => {
          throw new Error("simulated callback failure");
        }
      });

      expect(store.get(id)).toMatchObject({ status: "failed", result: { outcome: "worker_infrastructure_failure" } });
      expect(store.verifyAuditChain()).toMatchObject({ ok: true });
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("dispatches the Nimble-selected executor when routing is enabled", async () => {
    const prior = process.env.ACS_NIMBLE_ROUTING_ENABLED;
    process.env.ACS_NIMBLE_ROUTING_ENABLED = "1";
    const directory = mkdtempSync(join(tmpdir(), "acs-approved-dispatch-nimble-"));
    const store = new SqliteWorkItemStore(join(directory, "control.db"));
    const actorId = "actor_system_bootstrap";
    const observedAt = new Date();
    try {
      for (const id of ["alpha", "beta"]) {
        store.createRegistryAgent({
          id,
          name: id,
          kind: "repository_read",
          acpRole: "IMPLEMENTATION_AGENT",
          provider: "local",
          model: `${id}-model`,
          status: "AVAILABLE",
          actorId
        });
        store.replaceAgentCapabilities(id, [{ name: "fs.read" }], actorId);
        store.recordAgentHeartbeat(id, { status: "AVAILABLE", actorId, now: observedAt });
      }
      const item = store.create({
        title: "Nimble dispatcher item",
        requester: "agent",
        intent: "route the dry-run dispatcher",
        target: { cwd: "/repo", services: ["alpha", "beta"] },
        requestedActions: [{ kind: "fs.read", description: "simulate", params: { paths: ["src/index.ts"] } }],
        risk: "low"
      });
      store.approveWorkItem(item.id, transition);
      const result = await executeApprovedWorkItem({
        store,
        workerId: "beta",
        now: observedAt,
        routingFetch: async () =>
          new Response(
            JSON.stringify({
              model: "nimble:latest",
              answers: {
                executor: {
                  type: "choice",
                  choice: "beta",
                  confidence: 0.95,
                  probabilities: { alpha: 0.05, beta: 0.95 }
                }
              }
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          ),
        execute: async () => ({ ok: true, executionMode: "dry_run", output: "routed" })
      });
      expect(result).toMatchObject({ executed: true, workItemId: item.id });
      const evidence = store.getLatestAuthoritativeRoutingEvidence(item.id);
      expect(evidence).toMatchObject({ source: "nimble", selectedActorId: "beta", decision: "route" });
      expect(store.listRoutingExecutionOutcomes(evidence!.decisionId)).toEqual([
        expect.objectContaining({ executorId: "beta", success: true })
      ]);
    } finally {
      if (prior === undefined) delete process.env.ACS_NIMBLE_ROUTING_ENABLED;
      else process.env.ACS_NIMBLE_ROUTING_ENABLED = prior;
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not claim work when no approved item exists", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-approved-dispatch-empty-"));
    const store = new SqliteWorkItemStore(join(directory, "control.db"));
    try {
      const result = await executeApprovedWorkItem({
        store,
        workerId: "dispatcher-worker",
        execute: async () => ({ ok: true, executionMode: "dry_run", output: "unused" })
      });
      expect(result).toEqual({ executed: false, reason: "no approved work item" });
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
