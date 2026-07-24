import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { buildGateway, type GatewayAuthOptions } from "./server.js";

const workerAuth: GatewayAuthOptions = { token: "worker-token", actor: "agent", actorId: "worker-a" };

function legacySubmission(workItemId: string, overrides: Record<string, unknown> = {}) {
  return {
    workItemId,
    leaseId: "legacy_lease",
    workerId: "worker-a",
    actionHash: "a".repeat(64),
    idempotencyKey: "legacy_result",
    outcome: "succeeded",
    startedAt: "2026-07-23T20:00:00.000Z",
    finishedAt: "2026-07-23T20:00:01.000Z",
    exitCode: 0,
    summary: "legacy dry-run result",
    stdout: "no real command ran",
    structuredOutput: { simulated: true },
    artifacts: [],
    simulationMetadata: { executionMode: "dry_run", simulated: true },
    ...overrides
  };
}

function createApprovedWorkItem(dbPath: string): string {
  const store = new SqliteWorkItemStore(dbPath);
  try {
    const item = store.create({
      title: "Gateway legacy result boundary",
      requester: "agent",
      intent: "prove schema v6 rejects legacy worker results",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "manual", description: "simulate" }],
      risk: "low"
    });
    store.approveWorkItem(item.id, { via: "domain_service" });
    return item.id;
  } finally {
    store.close();
  }
}

describe("authenticated result submission route", () => {
  it("fails closed for anonymous, invalid, and non-worker credentials", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-gateway-result-auth-"));
    const dbPath = join(directory, "control.db");
    const app = buildGateway({ dbPath, logger: false, auth: workerAuth });
    try {
      const url = "/work-items/wrk_legacy/results";
      const anonymous = await app.inject({ method: "POST", url, payload: {} });
      const invalid = await app.inject({
        method: "POST",
        url,
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
        url,
        headers: { authorization: "Bearer user-token" },
        payload: {}
      });
      const malformed = await app.inject({
        method: "POST",
        url,
        headers: { authorization: "Basic worker-token" },
        payload: {}
      });
      const duplicated = await app.inject({
        method: "POST",
        url,
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

  it("rejects every authenticated legacy result after schema v6", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-gateway-result-v2-boundary-"));
    const dbPath = join(directory, "control.db");
    const workItemId = createApprovedWorkItem(dbPath);
    const app = buildGateway({ dbPath, logger: false, auth: workerAuth });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/work-items/${workItemId}/results`,
        headers: { authorization: "Bearer worker-token" },
        payload: legacySubmission(workItemId)
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "worker_protocol_unsupported" });
      const check = new SqliteWorkItemStore(dbPath);
      try {
        expect(check.get(workItemId)?.status).toBe("approved");
        expect(check.getExecutionResultForIdempotency("worker-a", "legacy_result")).toBeUndefined();
      } finally {
        check.close();
      }
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retains route, identity, and derived-outcome checks ahead of protocol rejection", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-gateway-result-boundary-"));
    const dbPath = join(directory, "control.db");
    const workItemId = createApprovedWorkItem(dbPath);
    const app = buildGateway({ dbPath, logger: false, auth: workerAuth });
    try {
      const routeMismatch = await app.inject({
        method: "POST",
        url: `/work-items/${workItemId}/results`,
        headers: { authorization: "Bearer worker-token" },
        payload: legacySubmission("wrk_other")
      });
      const workerMismatch = await app.inject({
        method: "POST",
        url: `/work-items/${workItemId}/results`,
        headers: { authorization: "Bearer worker-token" },
        payload: legacySubmission(workItemId, { workerId: "worker-b" })
      });
      const derivedOutcome = await app.inject({
        method: "POST",
        url: `/work-items/${workItemId}/results`,
        headers: { authorization: "Bearer worker-token" },
        payload: legacySubmission(workItemId, { outcome: "blocked", error: "policy" })
      });

      expect(routeMismatch.statusCode).toBe(400);
      expect(workerMismatch.statusCode).toBe(403);
      expect(derivedOutcome.statusCode).toBe(403);
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("enforces the HTTP request body limit before protocol handling", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-gateway-result-size-"));
    const dbPath = join(directory, "control.db");
    const workItemId = createApprovedWorkItem(dbPath);
    const app = buildGateway({ dbPath, logger: false, auth: workerAuth });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/work-items/${workItemId}/results`,
        headers: { authorization: "Bearer worker-token" },
        payload: legacySubmission(workItemId, { stdout: "x".repeat(256 * 1024) })
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
