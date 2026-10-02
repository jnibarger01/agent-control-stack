import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it } from "vitest";
import { buildGateway } from "../../apps/gateway/src/server.js";
import { createAuthenticatedWorkerClaim } from "../../apps/worker/src/claim-client.js";
import { runWorkerLoop } from "../../apps/worker/src/worker-loop.js";

const operatorToken = "nimble-e2e-operator-token-0001";
const workerToken = "nimble-e2e-worker-token-000001";
const otherWorkerToken = "nimble-e2e-worker-token-000002";
const appInstances: Array<ReturnType<typeof buildGateway>> = [];
const directories: string[] = [];

afterEach(async () => {
  for (const app of appInstances.splice(0)) {
    await app.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function gateway(dbPath: string, fetchImpl: typeof fetch): ReturnType<typeof buildGateway> {
  const app = buildGateway({
    dbPath,
    logger: false,
    auth: {
      token: "",
      actor: "",
      credentials: [
        {
          id: "operator",
          token: operatorToken,
          actor: "user",
          actorId: "operator-1",
          roles: ["operator"],
          scopes: ["acs:read", "acs:write"]
        },
        {
          id: "worker",
          token: workerToken,
          actor: "agent",
          actorId: "worker-1",
          roles: ["worker"],
          scopes: ["acs:worker"]
        },
        {
          id: "other-worker",
          token: otherWorkerToken,
          actor: "agent",
          actorId: "worker-2",
          roles: ["worker"],
          scopes: ["acs:worker"]
        }
      ]
    },
    nimbleRouting: {
      enabled: true,
      agentWorkerBindings: { "nimble-agent": "worker-1" },
      fetchImpl
    }
  });
  appInstances.push(app);
  return app;
}

describe("Nimble authenticated worker E2E", () => {
  it("persists the selection, survives gateway restart, rejects the wrong worker, then executes via authenticated claim", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-nimble-worker-e2e-"));
    directories.push(directory);
    const dbPath = join(directory, "control.db");
    const seed = new SqliteWorkItemStore(dbPath);
    seed.registerActor({ id: "operator-1", actorType: "HUMAN", displayName: "Operator" });
    seed.createRegistryAgent({
      id: "nimble-agent",
      name: "Nimble Agent",
      kind: "coding",
      acpRole: "IMPLEMENTATION_AGENT",
      status: "UNKNOWN",
      actorId: "operator-1"
    });
    seed.replaceAgentCapabilities("nimble-agent", [{ name: "fs.read", description: "Read files" }], "operator-1");
    seed.recordAgentHeartbeat("nimble-agent", { status: "AVAILABLE", actorId: "operator-1" });
    const created = seed.create({
      title: "Read the README",
      requester: "user",
      intent: "Read README.md and report a short summary",
      target: { cwd: "/repo", services: ["nimble-agent"] },
      requestedActions: [{ kind: "fs.read", description: "Read README.md", params: { paths: ["README.md"] } }],
      risk: "low"
    });
    const workItem = seed.approveWorkItem(created.id, { via: "domain_service", actorId: "operator-1" });
    seed.close();

    let inferenceCalls = 0;
    let app = gateway(dbPath, async () => {
      inferenceCalls += 1;
      return Response.json({ model: "nimble:latest", answers: { appropriate: { type: "noul", noul: 0.96 } } });
    });
    const dispatch = await app.inject({
      method: "POST",
      url: "/routing/dispatch",
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { workItemId: workItem.id }
    });
    expect(dispatch.statusCode).toBe(200);
    expect(dispatch.json()).toMatchObject({
      state: "SELECTED",
      selectedAgentId: "nimble-agent",
      selectedWorkerId: "worker-1"
    });
    await app.close();
    appInstances.splice(appInstances.indexOf(app), 1);

    app = gateway(dbPath, async () => {
      throw new Error("persisted selection must not trigger inference after restart");
    });
    const wrongWorker = await app.inject({
      method: "POST",
      url: "/worker/claim",
      headers: { authorization: `Bearer ${otherWorkerToken}` },
      payload: {}
    });
    expect(wrongWorker.statusCode).toBe(200);
    expect(wrongWorker.json()).toEqual({ claimed: false });

    const gatewayUrl = new URL(await app.listen({ port: 0, host: "127.0.0.1" }));
    const shutdown = new AbortController();
    let workerResult: { executed: boolean; workItemId?: string; executionMode?: string } | undefined;
    const safetyTimeout = setTimeout(() => shutdown.abort(), 15_000);
    await runWorkerLoop({
      workerOptions: {
        dbPath,
        workerId: "worker-1",
        executionBackend: "dry_run",
        authenticatedClaim: createAuthenticatedWorkerClaim({
          workerId: "worker-1",
          token: workerToken,
          gatewayUrl,
          timeoutMs: 5_000
        }),
        execute: async () => ({ ok: true, executionMode: "dry_run", output: "read-only acceptance result" })
      },
      pollIntervalMs: 100,
      signal: shutdown.signal,
      onResult: (result) => {
        workerResult = result;
        if (result.executed) shutdown.abort();
      }
    });
    clearTimeout(safetyTimeout);
    expect(workerResult).toMatchObject({ executed: true, workItemId: workItem.id, executionMode: "dry_run" });
    expect(inferenceCalls).toBe(1);

    const resultStore = new SqliteWorkItemStore(dbPath);
    try {
      expect(resultStore.get(workItem.id)?.status).toBe("succeeded");
      const assignment = resultStore.getWorkItemAssignment(workItem.id);
      const details = assignment && resultStore.getNimbleRoutingDecisionDetails(assignment.routingDecisionId);
      expect(assignment).toMatchObject({ selectedAgentId: "nimble-agent", selectedWorkerId: "worker-1" });
      expect(details).toMatchObject({ selectedAgentId: "nimble-agent", selectedScore: 0.96, threshold: 0.8 });
    } finally {
      resultStore.close();
    }

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(db.prepare("SELECT status FROM execution_attempts WHERE work_item_id = ?").get(workItem.id)).toEqual({
        status: "succeeded"
      });
    } finally {
      db.close();
    }
  });
});
