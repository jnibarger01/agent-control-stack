import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { buildGateway } from "./server.js";

describe("ACS worker gateway API", () => {
  it("authenticates a dedicated worker, claims one lease, and keeps claim outside MCP", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-worker-api-"));
    const dbPath = join(dir, "control.db");
    const seed = new SqliteWorkItemStore(dbPath);
    const workItem = createWorkItemTools(seed, createPolicyEngine()).create_work_item({
      title: "Worker claim",
      requester: "agent",
      intent: "verify remote worker claim",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["package.json"] } }],
      risk: "low"
    });
    seed.close();
    const app = buildGateway({
      dbPath,
      logger: false,
      auth: { token: "user-token", actor: "user", actorId: "user" },
      workerAuth: { token: "worker-token", actor: "agent", actorId: "acs-worker" }
    });

    try {
      const unauthorized = await app.inject({ method: "POST", url: "/worker/claim", payload: {} });
      expect(unauthorized.statusCode).toBe(401);

      const claimed = await app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: "Bearer worker-token", "x-acs-worker-id": "acs-worker" },
        payload: {}
      });
      expect(claimed.statusCode).toBe(200);
      expect(claimed.json().workItem).toMatchObject({ id: workItem.id, workerId: "acs-worker", status: "running" });
      expect(claimed.json().workItem.leaseToken).toEqual(expect.any(String));
      expect(JSON.stringify(claimed.json())).not.toContain("ACS_GATEWAY_TOKEN");
      expect(claimed.json().workItem.leaseId).toMatch(/^lease_/);

      const mcp = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: "Bearer worker-token" },
        payload: { jsonrpc: "2.0", id: "claim", method: "tools/call", params: { name: "claim_next_approved_work_item", arguments: { workerId: "acs-worker" } } }
      });
      expect(mcp.statusCode).not.toBe(200);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
