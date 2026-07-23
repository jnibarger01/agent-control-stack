import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stableHash } from "@agent-control-stack/shared";
import { SqliteWorkItemStore, type ClaimedWorkItem } from "@agent-control-stack/work-items";
import { buildGateway, type GatewayAuthOptions } from "./server.js";

const transition = { via: "domain_service" as const };
const workerAuth: GatewayAuthOptions = { token: "worker-token", actor: "agent", actorId: "worker-a" };

function submission(claimed: ClaimedWorkItem, overrides: Record<string, unknown> = {}) {
  return {
    workItemId: claimed.id,
    leaseId: claimed.leaseId,
    workerId: claimed.workerId,
    actionHash: claimed.actionHash,
    idempotencyKey: stableHash({ workItemId: claimed.id, leaseId: claimed.leaseId, attempt: 1 }),
    outcome: "succeeded",
    startedAt: claimed.startedAt,
    finishedAt: new Date(Date.parse(claimed.startedAt) + 10).toISOString(),
    exitCode: 0,
    summary: "gateway dry-run result",
    stdout: "no real command ran",
    stderr: "",
    structuredOutput: { simulated: true },
    artifacts: [],
    simulationMetadata: { executionMode: "dry_run", simulated: true },
    ...overrides
  };
}

function seedClaim(dbPath: string, leaseMs?: number): ClaimedWorkItem {
  const store = new SqliteWorkItemStore(dbPath, { leaseMs });
  try {
    const item = store.create({
      title: "Gateway result",
      requester: "agent",
      intent: "submit a simulated result",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "manual", description: "simulate" }],
      risk: "low"
    });
    store.approveWorkItem(item.id, transition);
    const claimed = store.claimNextApprovedWorkItem("worker-a", { leaseMs });
    if (!claimed) throw new Error("expected a lease");
    return claimed;
  } finally {
    store.close();
  }
}

describe("authenticated result submission route", () => {
  it("fails closed for anonymous, invalid, and non-worker credentials", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-gateway-result-auth-"));
    const dbPath = join(directory, "control.db");
    const claimed = seedClaim(dbPath);
    const app = buildGateway({ dbPath, logger: false, auth: workerAuth });
    try {
      const anonymous = await app.inject({ method: "POST", url: `/work-items/${claimed.id}/results`, payload: {} });
      const invalid = await app.inject({
        method: "POST",
        url: `/work-items/${claimed.id}/results`,
        headers: { authorization: "Bearer wrong" },
        payload: {}
      });
      const userApp = buildGateway({
        dbPath,
        logger: false,
        auth: { token: "user-token", actor: "user", actorId: "user-a" }
      });
      const user = await userApp.inject({
        method: "POST",
        url: `/work-items/${claimed.id}/results`,
        headers: { authorization: "Bearer user-token" },
        payload: {}
      });
      const malformed = await app.inject({
        method: "POST",
        url: `/work-items/${claimed.id}/results`,
        headers: { authorization: "Basic worker-token" },
        payload: {}
      });
      const duplicated = await app.inject({
        method: "POST",
        url: `/work-items/${claimed.id}/results`,
        headers: { authorization: "Bearer worker-token, Bearer worker-token" },
        payload: {}
      });
      await userApp.close();

      expect(anonymous.statusCode).toBe(401);
      expect(invalid.statusCode).toBe(401);
      expect(user.statusCode).toBe(403);
      expect(malformed.statusCode).toBe(401);
      expect(duplicated.statusCode).toBe(401);
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("binds the body to the authenticated worker and supports 201/200 idempotency", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-gateway-result-"));
    const dbPath = join(directory, "control.db");
    const claimed = seedClaim(dbPath);
    const app = buildGateway({ dbPath, logger: false, auth: workerAuth });
    try {
      const wrongWorker = await app.inject({
        method: "POST",
        url: `/work-items/${claimed.id}/results`,
        headers: { authorization: "Bearer worker-token" },
        payload: submission(claimed, { workerId: "worker-b" })
      });
      const accepted = await app.inject({
        method: "POST",
        url: `/work-items/${claimed.id}/results`,
        headers: { authorization: "Bearer worker-token" },
        payload: submission(claimed)
      });
      const replay = await app.inject({
        method: "POST",
        url: `/work-items/${claimed.id}/results`,
        headers: { authorization: "Bearer worker-token" },
        payload: submission(claimed)
      });
      const conflict = await app.inject({
        method: "POST",
        url: `/work-items/${claimed.id}/results`,
        headers: { authorization: "Bearer worker-token" },
        payload: submission(claimed, { summary: "conflicting replay" })
      });

      expect(wrongWorker.statusCode).toBe(403);
      expect(accepted.statusCode).toBe(201);
      expect(accepted.headers["x-request-id"]).toBeTruthy();
      expect(accepted.json().result).toMatchObject({ outcome: "succeeded", simulationMetadata: { simulated: true } });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().result.resultId).toBe(accepted.json().result.resultId);
      expect(conflict.statusCode).toBe(409);
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an expired lease without creating a result", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-gateway-result-expired-"));
    const dbPath = join(directory, "control.db");
    const claimed = seedClaim(dbPath, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const app = buildGateway({ dbPath, logger: false, auth: workerAuth });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/work-items/${claimed.id}/results`,
        headers: { authorization: "Bearer worker-token" },
        payload: submission(claimed)
      });
      expect(response.statusCode).toBe(410);
      expect(response.json()).toMatchObject({ code: "worker_lease_expired" });
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects route and lease mismatches before accepting any result", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-gateway-result-boundary-"));
    const dbPath = join(directory, "control.db");
    const claimed = seedClaim(dbPath);
    const app = buildGateway({ dbPath, logger: false, auth: workerAuth });
    try {
      const routeMismatch = await app.inject({
        method: "POST",
        url: `/work-items/${claimed.id}/results`,
        headers: { authorization: "Bearer worker-token" },
        payload: submission(claimed, { workItemId: "wrk_other" })
      });
      const actionMismatch = await app.inject({
        method: "POST",
        url: `/work-items/${claimed.id}/results`,
        headers: { authorization: "Bearer worker-token" },
        payload: submission(claimed, { actionHash: "a".repeat(64) })
      });
      const missingLease = await app.inject({
        method: "POST",
        url: `/work-items/${claimed.id}/results`,
        headers: { authorization: "Bearer worker-token" },
        payload: submission(claimed, { leaseId: "lease_unknown" })
      });
      const derivedOutcome = await app.inject({
        method: "POST",
        url: `/work-items/${claimed.id}/results`,
        headers: { authorization: "Bearer worker-token" },
        payload: submission(claimed, { outcome: "blocked", error: "policy" })
      });

      expect(routeMismatch.statusCode).toBe(400);
      expect(actionMismatch.statusCode).toBe(403);
      expect(missingLease.statusCode).toBe(409);
      expect(derivedOutcome.statusCode).toBe(403);
      const check = new SqliteWorkItemStore(dbPath);
      try {
        expect(check.get(claimed.id)?.status).toBe("running");
      } finally {
        check.close();
      }
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("enforces the HTTP request body limit before persistence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-gateway-result-size-"));
    const dbPath = join(directory, "control.db");
    const claimed = seedClaim(dbPath);
    const app = buildGateway({ dbPath, logger: false, auth: workerAuth });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/work-items/${claimed.id}/results`,
        headers: { authorization: "Bearer worker-token" },
        payload: submission(claimed, { stdout: "x".repeat(256 * 1024) })
      });
      expect(response.statusCode).toBe(413);
      expect(response.body).not.toContain("/tmp/");
      expect(response.body).not.toContain("stack");
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
