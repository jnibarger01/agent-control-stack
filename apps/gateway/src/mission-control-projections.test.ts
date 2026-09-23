import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore, defaultExecutionPlanForWorkItem } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { buildGateway } from "./server.js";
import { executionPlanProjectionSchema, sessionInfoSchema, connectorListSchema } from "./public-contracts.js";

const auth = { token: "mission-control-projection-test", actor: "user", actorId: "operator" };

describe("Mission Control projection boundaries", () => {
  it("reads the authoritative current plan, redacts secrets, and never mutates state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-plan-projection-"));
    const dbPath = join(dir, "test.db");
    const store = new SqliteWorkItemStore(dbPath);
    const item = store.create({
      title: "Plan projection",
      intent: "Inspect configuration",
      requester: "user",
      risk: "low",
      requestedActions: [{ kind: "fs.read", description: "Read config", params: { password: "fixture-secret-value" } }]
    });
    const app = buildGateway({ dbPath, auth, logger: false });
    const url = `/work-items/${item.id}/execution-plan`;
    const headers = { authorization: `Bearer ${auth.token}` };
    try {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url, headers: { cookie: "acs_session=forged" } })).statusCode).toBe(
        401
      );
      const noPlan = await app.inject({ method: "GET", url, headers });
      expect(noPlan.json()).toEqual({ plan: null });
      const plan = store.createExecutionPlan({
        workItemId: item.id,
        definition: defaultExecutionPlanForWorkItem(item),
        createdByActorId: "operator"
      });
      const before = store.readEvents().length;
      const response = await app.inject({ method: "GET", url, headers });
      expect(response.statusCode).toBe(200);
      const body = executionPlanProjectionSchema.parse(response.json());
      expect(body.plan?.planHash).toBe(plan.planHash);
      expect(body.plan?.definition.steps[0]?.action.params.password).toBe("[redacted]");
      expect(response.body).not.toContain("fixture-secret-value");
      expect(store.readEvents()).toHaveLength(before);
      expect(store.get(item.id)?.status).toBe(item.status);
      expect((await app.inject({ method: "GET", url: "/work-items/missing/execution-plan", headers })).statusCode).toBe(
        404
      );
      expect((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode).toBe(404);
    } finally {
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses plan reads when authentication is not configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-plan-no-auth-"));
    const app = buildGateway({ dbPath: join(dir, "test.db"), logger: false });
    try {
      expect((await app.inject({ method: "GET", url: "/work-items/any/execution-plan" })).statusCode).toBe(503);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unexpected authority and credential fields in projection schemas", () => {
    expect(
      sessionInfoSchema.safeParse({ actor: "user", actorId: null, roles: [], token: "never-return" }).success
    ).toBe(false);
    expect(connectorListSchema.safeParse({ connectors: [], authority: "operator" }).success).toBe(false);
    expect(executionPlanProjectionSchema.safeParse({ plan: null, approval: true }).success).toBe(false);
  });
});
