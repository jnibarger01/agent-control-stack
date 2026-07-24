import { createHmac, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { auditEventHash } from "@agent-control-stack/shared";
import {
  DEFAULT_EVENT_LIMIT,
  MAX_EVENT_LIMIT,
  SqliteWorkItemStore,
  type WorkItem
} from "@agent-control-stack/work-items";
import { describe, expect, it, vi } from "vitest";
import { createTunnelSignaturePayload, resolveMcpAuthOptions } from "./auth.js";
import { buildGateway } from "./server.js";

const testAuth = { token: "t", actor: "user", actorId: "user" } as const;
const oauthIssuer = "https://auth.example.test";
const oauthResource = "https://acs.example.test/mcp";

function buildTestGateway(options: NonNullable<Parameters<typeof buildGateway>[0]>) {
  if (options.dbPath) {
    seedActor(options.dbPath, testAuth.actorId, `local_bearer:local-dev`);
  }
  const app = buildGateway({ ...options, auth: testAuth });
  app.addHook("onRequest", async (request) => {
    request.headers.authorization ??= `Bearer ${testAuth.token}`;
  });
  return app;
}

function seedActor(dbPath: string, id: string, externalRef?: string): void {
  const store = new SqliteWorkItemStore(dbPath);
  try {
    store.registerActor({ id, actorType: "HUMAN", displayName: id, externalRef });
  } finally {
    store.close();
  }
}

function approvalActionHash(workItem: WorkItem, actor: string = testAuth.actorId): string {
  const decision = createPolicyEngine().evaluateWorkItem(workItem, actor, "approve")[0];
  if (!decision?.actionHash) {
    throw new Error(`missing approval action hash for ${workItem.id}`);
  }
  return decision.actionHash;
}

describe("mission control gateway", () => {
  it("renders mission control from persisted work items and audit events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-mission-control-"));
    const app = buildTestGateway({ dbPath: join(dir, "control.db"), logger: false });
    const { publicKey } = generateKeyPairSync("ed25519");

    try {
      await app.inject({
        method: "POST",
        url: "/connectors",
        payload: {
          id: "chatgpt-prod",
          displayName: "ChatGPT Desktop",
          publicKeyPem: String(publicKey.export({ type: "spki", format: "pem" })),
          allowedScopes: ["acs:work:create", "acs:work:read"]
        }
      });
      const created = await app.inject({
        method: "POST",
        url: "/work-items",
        payload: {
          title: "Inspect route",
          intent: "verify mission control",
          target: { services: ["chatgpt-prod"] },
          risk: "high"
        }
      });
      const workItemId = created.json().id;

      const page = await app.inject({ method: "GET", url: "/" });
      const agents = await app.inject({ method: "GET", url: "/agents" });
      const detail = await app.inject({ method: "GET", url: `/work-items/${workItemId}` });

      expect(page.statusCode).toBe(200);
      expect(page.body).toContain("ACS Mission Control");
      expect(page.body).toContain("Inspect route");
      expect(agents.json().agents).toEqual(expect.arrayContaining([expect.objectContaining({ id: "chatgpt-prod" })]));
      expect(detail.json().events.map((event: { name: string }) => event.name)).toContain("work_item.created");
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bounds work-item and agent detail audit events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-detail-event-limit-"));
    const dbPath = join(dir, "control.db");
    const seed = new SqliteWorkItemStore(dbPath);
    seed.registerActor({ id: "user", actorType: "HUMAN", displayName: "Jace" });
    const workItem = seed.create({
      title: "Bounded detail",
      requester: "user",
      intent: "verify bounded detail events",
      requestedActions: [{ kind: "manual", description: "bound" }],
      risk: "low"
    });
    for (let index = 0; index < DEFAULT_EVENT_LIMIT + 10; index += 1) {
      seed.recordPolicyDecision({
        workItemId: workItem.id,
        actionHash: `hash-${index}`,
        decision: "allow",
        reason: "test",
        matchedRules: [],
        context: {}
      });
    }
    seed.createRegistryAgent({
      id: "api-agent",
      name: "API Agent",
      kind: "service",
      acpRole: "ORCHESTRATION_LAYER",
      actorId: "user"
    });
    for (let index = 0; index < 12; index += 1) {
      seed.recordAgentHeartbeat("api-agent", { status: "AVAILABLE", currentTask: `task-${index}`, actorId: "user" });
    }
    seed.close();
    seedAuditRows(dbPath, 10_000, { workItemId: workItem.id, agentId: "api-agent" });
    const app = buildTestGateway({ dbPath, logger: false });

    try {
      const dashboard = await app.inject({ method: "GET", url: "/" });
      const defaultWorkItem = await app.inject({ method: "GET", url: `/work-items/${workItem.id}` });
      const limitedWorkItem = await app.inject({ method: "GET", url: `/work-items/${workItem.id}?limit=5` });
      const limitedAgent = await app.inject({ method: "GET", url: "/api/agents/api-agent?limit=4" });

      expect(dashboard.statusCode).toBe(200);
      expect(dashboard.body).not.toContain("audit.seed.0");
      expect(defaultWorkItem.json().events).toHaveLength(DEFAULT_EVENT_LIMIT);
      expect(limitedWorkItem.json().events).toHaveLength(5);
      expect(
        limitedWorkItem
          .json()
          .events.every(
            (event: { attributes: Record<string, string> }) => event.attributes["work_item.id"] === workItem.id
          )
      ).toBe(true);
      expect(limitedAgent.json().events).toHaveLength(4);
      expect(
        limitedAgent
          .json()
          .events.every((event: { attributes: Record<string, string> }) => event.attributes["agent.id"] === "api-agent")
      ).toBe(true);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("reports unhealthy health when the audit chain is tampered without leaking internals", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-health-audit-tamper-"));
    const dbPath = join(dir, "control.db");
    const seed = new SqliteWorkItemStore(dbPath);
    seed.create({
      title: "Health tamper",
      requester: "user",
      intent: "verify health audit probe",
      requestedActions: [{ kind: "manual", description: "health" }],
      risk: "low"
    });
    seed.close();
    updateAuditBody(dbPath, 1, { tampered: true });
    const app = buildGateway({ dbPath, logger: false, auth: testAuth });

    try {
      const health = await app.inject({ method: "GET", url: "/health" });

      expect(health.statusCode).toBe(503);
      expect(health.json()).toMatchObject({
        ok: false,
        checks: {
          auditChain: { ok: false, code: "audit_chain_event_hash_mismatch" }
        }
      });
      expect(health.body).not.toContain("Error:");
      expect(health.body).not.toContain("stack");
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("separates process liveness from dependency readiness", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-health-separation-"));
    const dbPath = join(dir, "control.db");
    const app = buildGateway({ dbPath, logger: false, auth: testAuth });
    const lock = new DatabaseSync(dbPath);
    try {
      lock.exec("BEGIN IMMEDIATE");
      const live = await app.inject({ method: "GET", url: "/livez" });
      const ready = await app.inject({ method: "GET", url: "/readyz" });
      expect(live.statusCode).toBe(200);
      expect(live.json()).toEqual({ ok: true, status: "alive" });
      expect(ready.statusCode).toBe(503);
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses integrity and foreign-key verification in the readiness contract", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-health-foreign-key-"));
    const dbPath = join(dir, "control.db");
    const seed = new SqliteWorkItemStore(dbPath);
    seed.close();
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA foreign_keys = OFF");
      db.prepare(
        `INSERT INTO approval_records
         (work_item_id, action_hash, request_hash, approval_token_hash, approved_by, reason, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "missing-work-item",
        "action-hash",
        "request-hash",
        "",
        "user",
        "fixture",
        "granted",
        "2026-07-19T00:00:00.000Z",
        "2026-07-20T00:00:00.000Z"
      );
    } finally {
      db.close();
    }
    const app = buildGateway({ dbPath, logger: false, auth: testAuth });

    try {
      const ready = await app.inject({ method: "GET", url: "/readyz" });

      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toMatchObject({
        ok: false,
        checks: {
          integrity: { ok: true },
          foreignKeys: { ok: false, code: "foreign_key_violation" }
        }
      });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on writes after startup detects audit-chain tampering", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-write-audit-tamper-"));
    const dbPath = join(dir, "control.db");
    const seed = new SqliteWorkItemStore(dbPath);
    seed.create({
      title: "Tamper seed",
      requester: "user",
      intent: "seed audit row",
      requestedActions: [{ kind: "manual", description: "seed" }],
      risk: "low"
    });
    seed.close();
    updateAuditBody(dbPath, 1, { tampered: true });
    const auditRowsBefore = countAuditRows(dbPath);
    const app = buildGateway({ dbPath, logger: false, auth: testAuth });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/work-items",
        headers: { authorization: `Bearer ${testAuth.token}` },
        payload: {
          title: "Should fail",
          intent: "verify tamper fail closed",
          requestedActions: [{ kind: "manual", description: "blocked" }],
          risk: "low"
        }
      });

      expect(created.statusCode).toBe(409);
      expect(created.json()).toMatchObject({ code: "audit_chain_invalid" });
      expect(countAuditRows(dbPath)).toBe(auditRowsBefore);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports unhealthy health when the DB write path is locked without leaking SQLite details", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-health-write-lock-"));
    const dbPath = join(dir, "control.db");
    const app = buildTestGateway({ dbPath, logger: false });
    const lock = new DatabaseSync(dbPath);

    try {
      lock.exec("BEGIN IMMEDIATE");
      const health = await app.inject({ method: "GET", url: "/health" });

      expect(health.statusCode).toBe(503);
      expect(health.json()).toMatchObject({
        ok: false,
        checks: {
          write: { ok: false, code: "db_write_failed" }
        }
      });
      expect(health.body).not.toContain("SQLITE_BUSY");
      expect(health.body).not.toContain("database is locked");
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("projects stale AVAILABLE registry agents as effectively offline at the API boundary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-api-agent-freshness-"));
    const dbPath = join(dir, "control.db");
    const seed = new SqliteWorkItemStore(dbPath);
    seed.registerActor({ id: "user", actorType: "HUMAN", displayName: "Jace" });
    seed.createRegistryAgent({
      id: "stale-agent",
      name: "Stale Agent",
      kind: "cli",
      acpRole: "IMPLEMENTATION_AGENT",
      actorId: "user"
    });
    seed.recordAgentHeartbeat("stale-agent", {
      status: "AVAILABLE",
      actorId: "user",
      now: new Date(Date.now() - 901_000)
    });
    seed.close();
    const app = buildTestGateway({ dbPath, logger: false });

    try {
      const list = await app.inject({ method: "GET", url: "/api/agents" });
      const detail = await app.inject({ method: "GET", url: "/api/agents/stale-agent" });

      expect(list.json().agents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "stale-agent",
            status: "AVAILABLE",
            effectiveStatus: "OFFLINE",
            isStale: true,
            heartbeatAgeMs: expect.any(Number)
          })
        ])
      );
      expect(detail.json().agent).toMatchObject({
        id: "stale-agent",
        status: "AVAILABLE",
        effectiveStatus: "OFFLINE",
        isStale: true
      });
      expect(detail.json().agent.heartbeatAgeMs).toBeGreaterThan(900_000);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the configured heartbeat TTL when projecting registry freshness", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-api-agent-custom-ttl-"));
    const dbPath = join(dir, "control.db");
    const heartbeatTtlMs = 1_000;
    const seed = new SqliteWorkItemStore(dbPath, { heartbeatTtlMs });
    seed.registerActor({ id: "user", actorType: "HUMAN", displayName: "Jace" });
    seed.createRegistryAgent({
      id: "custom-ttl-agent",
      name: "Custom TTL Agent",
      kind: "cli",
      acpRole: "IMPLEMENTATION_AGENT",
      actorId: "user"
    });
    seed.recordAgentHeartbeat("custom-ttl-agent", {
      status: "AVAILABLE",
      actorId: "user",
      now: new Date(Date.now() - heartbeatTtlMs - 1)
    });
    seed.close();
    const app = buildGateway({ dbPath, logger: false, auth: testAuth, heartbeatTtlMs });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/agents",
        headers: { authorization: `Bearer ${testAuth.token}` }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().agents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "custom-ttl-agent",
            status: "AVAILABLE",
            effectiveStatus: "OFFLINE",
            isStale: true
          })
        ])
      );
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reconciles stale tunnel sessions and agents before reporting readiness", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-readiness-liveness-"));
    const dbPath = join(dir, "control.db");
    const staleAt = new Date(Date.now() - 901_000);
    const seed = new SqliteWorkItemStore(dbPath);
    seed.registerActor({ id: "user", actorType: "HUMAN", displayName: "Jace" });
    seed.registerConnector({
      id: "connector",
      publicKeyPem: "public-key",
      allowedScopes: ["acs:work:read"],
      actorId: "user",
      now: staleAt
    });
    seed.registerTunnelSession({
      connectorId: "connector",
      tunnelId: "tunnel",
      sessionId: "session",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      actorId: "user",
      now: staleAt
    });
    seed.createRegistryAgent({
      id: "stale-agent",
      name: "Stale Agent",
      kind: "cli",
      acpRole: "IMPLEMENTATION_AGENT",
      actorId: "user"
    });
    seed.recordAgentHeartbeat("stale-agent", { status: "AVAILABLE", actorId: "user", now: staleAt });
    seed.close();
    const app = buildTestGateway({ dbPath, logger: false });
    let appClosed = false;

    try {
      const ready = await app.inject({ method: "GET", url: "/readyz" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toMatchObject({ ok: true, checks: { liveness: { ok: true } } });
      await app.close();
      appClosed = true;

      const check = new SqliteWorkItemStore(dbPath);
      try {
        expect(check.getRegistryAgent("stale-agent")).toMatchObject({ status: "OFFLINE" });
        expect(
          check.getTunnelSession({ connectorId: "connector", tunnelId: "tunnel", sessionId: "session" })
        ).toMatchObject({
          status: "revoked"
        });
        expect(check.readEvents().filter((event) => event.name === "agent.reconciled")).toHaveLength(1);
        expect(check.readEvents().filter((event) => event.name === "tunnel_session.reconciled")).toHaveLength(1);
      } finally {
        check.close();
      }
    } finally {
      if (!appClosed) {
        await app.close();
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid event limits and caps overlarge limits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-event-limit-validation-"));
    const dbPath = join(dir, "control.db");
    const seed = new SqliteWorkItemStore(dbPath);
    const workItem = seed.create({
      title: "Limit validation",
      requester: "user",
      intent: "verify limit validation",
      requestedActions: [{ kind: "manual", description: "bound" }],
      risk: "low"
    });
    for (let index = 0; index < MAX_EVENT_LIMIT + 20; index += 1) {
      seed.recordPolicyDecision({
        workItemId: workItem.id,
        actionHash: `hash-${index}`,
        decision: "allow",
        reason: "test",
        matchedRules: [],
        context: {}
      });
    }
    seed.close();
    const app = buildTestGateway({ dbPath, logger: false });

    try {
      const invalid = await app.inject({ method: "GET", url: `/work-items/${workItem.id}?limit=abc` });
      const overlarge = await app.inject({ method: "GET", url: `/work-items/${workItem.id}?limit=999999` });

      expect(invalid.statusCode).toBe(400);
      expect(overlarge.statusCode).toBe(200);
      expect(overlarge.json().events).toHaveLength(MAX_EVENT_LIMIT);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("serves the attributed agent registry API", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-agent-registry-api-"));
    const dbPath = join(dir, "control.db");
    const seed = new SqliteWorkItemStore(dbPath);
    seed.registerActor({ id: "user", actorType: "HUMAN", displayName: "Jace" });
    seed.close();
    const app = buildTestGateway({ dbPath, logger: false });
    const actorHeaders = { "x-acs-actor-id": "user" };

    try {
      const missingActor = await app.inject({
        method: "POST",
        url: "/api/agents",
        payload: { id: "missing-actor", name: "Missing", kind: "cli" }
      });
      const unknownActor = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: { "x-acs-actor-id": "ghost" },
        payload: { id: "ghost-agent", name: "Ghost", kind: "cli", acpRole: "IMPLEMENTATION_AGENT" }
      });
      const invalidCreateStatus = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: actorHeaders,
        payload: { id: "bad-status", name: "Bad", kind: "cli", acpRole: "IMPLEMENTATION_AGENT", status: "GREAT" }
      });
      const created = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: actorHeaders,
        payload: {
          id: "api-agent",
          name: "API Agent",
          kind: "service",
          acpRole: "ORCHESTRATION_LAYER",
          provider: "openai",
          model: "gpt-5",
          endpoint: "http://127.0.0.1:9999/api"
        }
      });

      expect(missingActor.statusCode).toBe(400);
      expect(unknownActor.statusCode).toBe(403);
      expect(invalidCreateStatus.statusCode).toBe(400);
      expect(created.statusCode).toBe(201);
      expect(created.json().agent).toMatchObject({
        id: "api-agent",
        provider: "openai",
        model: "gpt-5",
        endpoint: "http://127.0.0.1:9999/api",
        createdByActorId: "user",
        updatedByActorId: "user"
      });

      const capabilities = await app.inject({
        method: "PUT",
        url: "/api/agents/api-agent/capabilities",
        headers: actorHeaders,
        payload: {
          capabilities: [{ name: "code:implement", inputSchema: { type: "object" } }, { name: "repo:inspect" }]
        }
      });
      const replacedCapabilities = await app.inject({
        method: "PUT",
        url: "/api/agents/api-agent/capabilities",
        headers: actorHeaders,
        payload: { capabilities: [{ name: "repo:inspect" }] }
      });
      const malformedCapabilities = await app.inject({
        method: "PUT",
        url: "/api/agents/api-agent/capabilities",
        headers: actorHeaders,
        payload: { capabilities: [{ name: "bad", inputSchema: [] }] }
      });
      const capabilityMissingActor = await app.inject({
        method: "PUT",
        url: "/api/agents/api-agent/capabilities",
        payload: { capabilities: [{ name: "repo:inspect" }] }
      });
      const capabilityUnknownActor = await app.inject({
        method: "PUT",
        url: "/api/agents/api-agent/capabilities",
        headers: { "x-acs-actor-id": "ghost" },
        payload: { capabilities: [{ name: "repo:inspect" }] }
      });
      const heartbeat = await app.inject({
        method: "POST",
        url: "/api/agents/api-agent/heartbeat",
        headers: actorHeaders,
        payload: { status: "AVAILABLE", currentTask: "idle" }
      });
      const heartbeatMissingActor = await app.inject({
        method: "POST",
        url: "/api/agents/api-agent/heartbeat",
        payload: { status: "AVAILABLE", currentTask: "idle" }
      });
      const heartbeatUnknownActor = await app.inject({
        method: "POST",
        url: "/api/agents/api-agent/heartbeat",
        headers: { "x-acs-actor-id": "ghost" },
        payload: { status: "AVAILABLE" }
      });
      const invalidStatus = await app.inject({
        method: "POST",
        url: "/api/agents/api-agent/heartbeat",
        headers: actorHeaders,
        payload: { status: "GREAT" }
      });
      const updated = await app.inject({
        method: "PATCH",
        url: "/api/agents/api-agent",
        headers: actorHeaders,
        payload: { model: "gpt-5-codex" }
      });
      const actors = await app.inject({ method: "GET", url: "/api/actors" });
      const list = await app.inject({ method: "GET", url: "/api/agents" });
      const detail = await app.inject({ method: "GET", url: "/api/agents/api-agent" });
      const missingDetail = await app.inject({ method: "GET", url: "/api/agents/missing" });
      const missingUpdate = await app.inject({
        method: "PATCH",
        url: "/api/agents/missing",
        headers: actorHeaders,
        payload: { status: "OFFLINE" }
      });
      const missingCapabilities = await app.inject({ method: "GET", url: "/api/agents/missing/capabilities" });
      const missingCapabilityPut = await app.inject({
        method: "PUT",
        url: "/api/agents/missing/capabilities",
        headers: actorHeaders,
        payload: { capabilities: [] }
      });
      const missingHeartbeat = await app.inject({
        method: "POST",
        url: "/api/agents/missing/heartbeat",
        headers: actorHeaders,
        payload: { status: "OFFLINE" }
      });

      expect(capabilities.statusCode).toBe(200);
      expect(replacedCapabilities.json().capabilities).toHaveLength(1);
      expect(malformedCapabilities.statusCode).toBe(400);
      expect(capabilityMissingActor.statusCode).toBe(200);
      expect(capabilityUnknownActor.statusCode).toBe(403);
      expect(heartbeat.statusCode).toBe(201);
      expect(heartbeatMissingActor.statusCode).toBe(201);
      expect(heartbeatUnknownActor.statusCode).toBe(403);
      expect(invalidStatus.statusCode).toBe(400);
      expect(updated.json().agent).toMatchObject({ id: "api-agent", model: "gpt-5-codex", updatedByActorId: "user" });
      expect(actors.json().actors).toEqual(expect.arrayContaining([expect.objectContaining({ id: "user" })]));
      expect(list.json().agents).toEqual(expect.arrayContaining([expect.objectContaining({ id: "api-agent" })]));
      expect(detail.json().agent).toMatchObject({
        id: "api-agent",
        status: "AVAILABLE",
        capabilities: [{ name: "repo:inspect" }],
        latestHeartbeat: { actorId: "user", status: "AVAILABLE", currentTask: "idle" }
      });
      expect(missingDetail.statusCode).toBe(404);
      expect(missingUpdate.statusCode).toBe(404);
      expect(missingCapabilities.statusCode).toBe(404);
      expect(missingCapabilityPut.statusCode).toBe(404);
      expect(missingHeartbeat.statusCode).toBe(404);

      const store = new SqliteWorkItemStore(dbPath);
      try {
        expect(store.readEvents().map((event) => event.name)).toEqual(
          expect.arrayContaining(["agent.created", "agent.updated", "agent.capabilities_replaced", "agent.heartbeat"])
        );
      } finally {
        store.close();
      }
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects registry mutations when x-acs-actor-id mismatches the credential-bound actor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-actor-binding-"));
    const dbPath = join(dir, "control.db");
    const seed = new SqliteWorkItemStore(dbPath);
    seed.registerActor({ id: "actor_jace", actorType: "HUMAN", displayName: "Jace" });
    seed.close();
    const app = buildGateway({ dbPath, logger: false, auth: { token: "t", actor: "user", actorId: "actor_jace" } });

    try {
      const spoofed = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: { authorization: "Bearer t", "x-acs-actor-id": "actor_system_bootstrap" },
        payload: { id: "spoofed-agent", name: "Spoofed", kind: "cli", acpRole: "IMPLEMENTATION_AGENT" }
      });
      const spoofedHeartbeat = await app.inject({
        method: "POST",
        url: "/api/agents/codex-cli/heartbeat",
        headers: { authorization: "Bearer t", "x-acs-actor-id": "actor_system_bootstrap" },
        payload: { status: "AVAILABLE" }
      });
      const bound = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: { authorization: "Bearer t" },
        payload: { id: "bound-agent", name: "Bound", kind: "cli", acpRole: "IMPLEMENTATION_AGENT" }
      });

      expect(spoofed.statusCode).toBe(403);
      expect(spoofedHeartbeat.statusCode).toBe(403);
      expect(bound.statusCode).toBe(201);
      expect(bound.json().agent).toMatchObject({ createdByActorId: "actor_jace", updatedByActorId: "actor_jace" });

      const store = new SqliteWorkItemStore(dbPath);
      try {
        expect(store.getRegistryAgent("spoofed-agent")).toBeUndefined();
        const heartbeat = store.getRegistryAgent("codex-cli")?.latestHeartbeat;
        expect(heartbeat).toBeUndefined();
      } finally {
        store.close();
      }
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed for registry mutations when no actor binding is configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-actor-binding-missing-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false, auth: { token: "t", actor: "user" } });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/agents/codex-cli/heartbeat",
        headers: { authorization: "Bearer t", "x-acs-actor-id": "actor_system_bootstrap" },
        payload: { status: "AVAILABLE" }
      });
      expect(response.statusCode).toBe(503);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers actors through an authenticated audited route", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-actor-register-"));
    const dbPath = join(dir, "control.db");
    const app = buildTestGateway({ dbPath, logger: false });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/actors",
        payload: { id: "actor_jace", actorType: "HUMAN", displayName: "Jace" }
      });
      const invalid = await app.inject({
        method: "POST",
        url: "/actors",
        payload: { id: "actor_bad", actorType: "ROBOT_OVERLORD", displayName: "Nope" }
      });

      expect(created.statusCode).toBe(201);
      expect(created.json().actor).toMatchObject({ id: "actor_jace", actorType: "HUMAN", displayName: "Jace" });
      expect(invalid.statusCode).toBe(400);

      const store = new SqliteWorkItemStore(dbPath);
      try {
        expect(store.readEvents()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "actor.registered",
              attributes: expect.objectContaining({ "actor.id": testAuth.actorId }),
              body: expect.objectContaining({ registeredByActorId: testAuth.actorId })
            })
          ])
        );
      } finally {
        store.close();
      }
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed for connector registration without a bound actor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-connector-no-bound-actor-"));
    const { publicKey } = generateKeyPairSync("ed25519");
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false, auth: { token: "t", actor: "user" } });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/connectors",
        headers: { authorization: "Bearer t" },
        payload: {
          id: "chatgpt-prod",
          publicKeyPem: String(publicKey.export({ type: "spki", format: "pem" })),
          allowedScopes: ["acs:work:create"]
        }
      });

      expect(response.statusCode).toBe(503);
      expect(response.json().error).toContain("registry actor binding is not configured");
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exposes configured read-only ACP adapter status in Mission Control", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-acp-gateway-"));
    const app = buildGateway({
      dbPath: join(dir, "control.db"),
      logger: false,
      acpAdapter: {
        agentId: "acp-ui-agent",
        actorId: "acp-ui-actor",
        command: process.execPath,
        args: ["-e", gatewayFixtureAcpAgentScript()],
        initializeTimeoutMs: 500
      }
    });

    try {
      const agents = await app.inject({ method: "GET", url: "/agents" });
      const detail = await app.inject({ method: "GET", url: "/agents/acp-ui-agent" });

      expect(agents.statusCode).toBe(200);
      expect(agents.json().agents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "acp-ui-agent",
            displayName: "Gateway Fixture ACP Agent",
            kind: "acp-adapter",
            status: "online",
            health: "healthy",
            capabilities: expect.arrayContaining(["acp.protocol.1.0", "acp.capability.plan"])
          })
        ])
      );
      expect(detail.statusCode).toBe(200);
      expect(detail.json().adapterStatus).toMatchObject({
        agentId: "acp-ui-agent",
        connected: true,
        processAlive: true,
        initialized: true,
        protocolVersion: "1.0",
        agentName: "Gateway Fixture ACP Agent",
        capabilities: ["plan"]
      });
      expect(detail.json().adapterStatus.lastMessageAt).toBeDefined();
      expect(detail.json().events.map((event: { name: string }) => event.name)).toEqual(
        expect.arrayContaining(["agent.created", "agent.heartbeat", "acp.initialized"])
      );
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gateway MCP transport", () => {
  it("protects the MCP tool inventory with the same auth and scope contract", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-mcp-tools-inventory-"));
    const oauth = createTestOAuth();
    const app = buildGateway({
      dbPath: join(dir, "control.db"),
      logger: false,
      mcpAuth: { localBearerToken: "mcp-token", oauth: oauth.options }
    });

    try {
      const anonymous = await app.inject({ method: "GET", url: "/mcp/tools" });
      const invalid = await app.inject({
        method: "GET",
        url: "/mcp/tools",
        headers: { authorization: "Bearer invalid" }
      });
      const valid = await app.inject({
        method: "GET",
        url: "/mcp/tools",
        headers: { authorization: "Bearer mcp-token" }
      });
      const insufficient = await app.inject({
        method: "GET",
        url: "/mcp/tools",
        headers: { authorization: `Bearer ${oauth.token({ scope: "acs:work:create" })}` }
      });

      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.json()).toEqual({ error: "unauthorized" });
      expect(invalid.statusCode).toBe(401);
      expect(invalid.json()).toEqual({ error: "unauthorized" });
      expect(valid.statusCode).toBe(200);
      expect(valid.json().tools).toEqual(expect.arrayContaining(["list_work_items"]));
      expect(insufficient.statusCode).toBe(403);
      expect(insufficient.json()).toEqual({ error: "insufficient_scope" });
      expect(insufficient.headers["www-authenticate"]).toContain('error="insufficient_scope"');
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an MCP initialization response", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-"));
    const app = buildGateway({
      dbPath: join(dir, "control.db"),
      logger: false,
      auth: testAuth,
      mcpAuth: { localBearerToken: testAuth.token }
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${testAuth.token}` },
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "0.0.0" }
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "agent-control-stack-gateway", version: "0.1.0" }
        }
      });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists gateway tools in MCP-compatible shape", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-"));
    const app = buildGateway({
      dbPath: join(dir, "control.db"),
      logger: false,
      auth: testAuth,
      mcpAuth: { localBearerToken: testAuth.token }
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${testAuth.token}` },
        payload: {
          jsonrpc: "2.0",
          id: "tools",
          method: "tools/list"
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().result.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "create_work_item",
            description: expect.any(String),
            inputSchema: expect.objectContaining({ type: "object" }),
            securitySchemes: [{ type: "noauth" }],
            _meta: {
              securitySchemes: [{ type: "noauth" }]
            }
          })
        ])
      );
      expect(response.json().result.tools.map((tool: { name: string }) => tool.name)).not.toEqual(
        expect.arrayContaining(["approve_work_item", "claim_next_approved_work_item", "submit_work_result"])
      );
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps direct agent MCP runs disabled by default even with an injected controller", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-direct-agent-"));
    const dbPath = join(dir, "control.db");
    const oauth = createTestOAuth();
    seedActor(dbPath, "oauth-user", "oauth_jwt:user_123");
    const directAgentController = {
      callTool: vi.fn(async () => ({
        ok: true,
        agent: "codex",
        stdout: "review ok",
        stderr: "",
        exitCode: 0,
        durationMs: 1,
        error: null
      }))
    };
    const app = buildGateway({
      dbPath,
      logger: false,
      mcpAuth: { oauth: oauth.options },
      directAgentController
    });
    const directRunPayload = mcpToolCall("direct-agent", "test.agent.run", {
      agent: "codex",
      prompt: "Inspect only",
      cwd: "/repo"
    });

    try {
      const listed = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${oauth.token({ scope: "acs:work:read" })}` },
        payload: { jsonrpc: "2.0", id: "tools", method: "tools/list" }
      });
      const directTool = listed.json().result.tools.find((tool: { name: string }) => tool.name === "test.agent.run");
      const readScoped = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${oauth.token({ scope: "acs:work:read" })}` },
        payload: directRunPayload
      });

      expect(directTool).toBeUndefined();
      expect(readScoped.statusCode).toBe(403);
      expect(readScoped.json().result.structuredContent).toMatchObject({
        authError: "insufficient_scope",
        requiredScopes: ["acs:work:approve"]
      });
      expect(directAgentController.callTool).not.toHaveBeenCalled();

      const approvalScoped = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${oauth.token({ scope: "acs:work:approve" })}` },
        payload: directRunPayload
      });

      expect(approvalScoped.statusCode).toBe(409);
      expect(approvalScoped.json().error.message).toContain("not configured");
      expect(directAgentController.callTool).not.toHaveBeenCalled();
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps direct agent MCP runs disabled by default when machine config and a fake runner exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-direct-agent-config-disabled-"));
    const allowed = join(dir, "allowed");
    const configPath = join(dir, "machine-controller.json");
    const dbPath = join(dir, "control.db");
    mkdirSync(allowed);
    writeFileSync(
      configPath,
      JSON.stringify({
        paths: { allow: [allowed], deny: [] },
        commands: { allow_readonly: ["node"], deny: [] },
        audit: { log_path: join(dir, "machine-audit.jsonl") }
      })
    );
    seedActor(dbPath, testAuth.actorId, "local_bearer:local-dev");
    const directAgentRunner = vi.fn(async () => ({
      stdout: "must not run",
      stderr: "",
      exitCode: 0,
      durationMs: 1
    }));
    const app = buildGateway({
      dbPath,
      logger: false,
      mcpAuth: { localBearerToken: testAuth.token },
      machineControllerConfigPath: configPath,
      directAgentRunner
    });

    try {
      const listed = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${testAuth.token}`, host: "127.0.0.1:3000" },
        payload: { jsonrpc: "2.0", id: "tools", method: "tools/list" },
        remoteAddress: "127.0.0.1"
      });
      const called = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${testAuth.token}`, host: "127.0.0.1:3000" },
        payload: mcpToolCall("direct-agent-config", "test.agent.run", {
          agent: "codex",
          prompt: "Inspect only",
          cwd: allowed
        }),
        remoteAddress: "127.0.0.1"
      });

      expect(listed.json().result.tools.map((tool: { name: string }) => tool.name)).not.toContain("test.agent.run");
      expect(called.statusCode).toBe(409);
      expect(directAgentRunner).not.toHaveBeenCalled();
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows the explicit direct agent opt-in only for loopback development requests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-direct-agent-local-dev-"));
    const dbPath = join(dir, "control.db");
    const oauth = createTestOAuth();
    seedActor(dbPath, "oauth-user", "oauth_jwt:user_123");
    const directAgentController = {
      callTool: vi.fn(async () => ({
        ok: true,
        agent: "codex",
        stdout: "review ok",
        stderr: "",
        exitCode: 0,
        durationMs: 1,
        error: null
      }))
    };
    const app = buildGateway({
      dbPath,
      logger: false,
      mcpAuth: { oauth: oauth.options },
      directAgentController,
      enableTestAgentRunForLocalDevelopment: true
    });
    const directRunPayload = mcpToolCall("direct-agent-local-dev", "test.agent.run", {
      agent: "codex",
      prompt: "Inspect only",
      cwd: "/repo"
    });

    try {
      const listed = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: `Bearer ${oauth.token({ scope: "acs:work:read" })}`,
          host: "127.0.0.1:3000"
        },
        payload: { jsonrpc: "2.0", id: "tools", method: "tools/list" },
        remoteAddress: "127.0.0.1"
      });
      const readScoped = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: `Bearer ${oauth.token({ scope: "acs:work:read" })}`,
          host: "127.0.0.1:3000"
        },
        payload: directRunPayload,
        remoteAddress: "127.0.0.1"
      });
      expect(readScoped.statusCode).toBe(403);
      expect(directAgentController.callTool).not.toHaveBeenCalled();

      const called = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: `Bearer ${oauth.token({ scope: "acs:work:approve" })}`,
          host: "127.0.0.1:3000"
        },
        payload: directRunPayload,
        remoteAddress: "127.0.0.1"
      });

      expect(listed.json().result.tools.map((tool: { name: string }) => tool.name)).toContain("test.agent.run");
      expect(called.statusCode).toBe(200);
      expect(called.json().result.structuredContent).toMatchObject({ ok: true, agent: "codex" });
      expect(directAgentController.callTool).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not expose or pass an opted-in direct agent controller to non-loopback requests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-direct-agent-remote-"));
    const dbPath = join(dir, "control.db");
    const oauth = createTestOAuth();
    seedActor(dbPath, "oauth-user", "oauth_jwt:user_123");
    const directAgentController = { callTool: vi.fn(async () => ({ ok: true })) };
    const app = buildGateway({
      dbPath,
      logger: false,
      mcpAuth: { oauth: oauth.options },
      directAgentController,
      enableTestAgentRunForLocalDevelopment: true
    });
    const headers = {
      authorization: `Bearer ${oauth.token({ scope: "acs:work:approve acs:work:read" })}`,
      host: "acs.example.test"
    };

    try {
      const listed = await app.inject({
        method: "POST",
        url: "/mcp",
        headers,
        payload: { jsonrpc: "2.0", id: "tools", method: "tools/list" },
        remoteAddress: "203.0.113.10"
      });
      const called = await app.inject({
        method: "POST",
        url: "/mcp",
        headers,
        payload: mcpToolCall("direct-agent-remote", "test.agent.run", {
          agent: "codex",
          prompt: "Inspect only",
          cwd: "/repo"
        }),
        remoteAddress: "203.0.113.10"
      });

      expect(listed.json().result.tools.map((tool: { name: string }) => tool.name)).not.toContain("test.agent.run");
      expect(called.statusCode).toBe(409);
      expect(directAgentController.callTool).not.toHaveBeenCalled();
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses the direct agent local-development opt-in in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-direct-agent-production-"));
    let app: ReturnType<typeof buildGateway> | undefined;
    let thrown: unknown;

    try {
      try {
        app = buildGateway({
          dbPath: join(dir, "control.db"),
          logger: false,
          directAgentController: { callTool: vi.fn(async () => ({ ok: true })) },
          enableTestAgentRunForLocalDevelopment: true
        });
      } catch (error) {
        thrown = error;
      }
      if (app) {
        await app.close();
      }
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }

    expect(thrown).toMatchObject({ code: "direct_agent_production_forbidden" });
  });

  it("rejects remote MCP worker claim tools and does not leak lease tokens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-worker-tool-lockdown-"));
    const dbPath = join(dir, "control.db");
    const oauth = createTestOAuth();
    const seed = new SqliteWorkItemStore(dbPath);
    const seedTools = createWorkItemTools(seed, createPolicyEngine());
    seed.registerActor({
      id: "oauth-user",
      actorType: "HUMAN",
      displayName: "OAuth User",
      externalRef: "oauth_jwt:user_123"
    });
    const workItem = seedTools.create_work_item({
      title: "Approved remote claim target",
      requester: "user",
      intent: "verify remote worker claim lockdown",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["src/index.ts"] } }],
      risk: "low"
    });
    seed.close();
    const app = buildGateway({ dbPath, logger: false, mcpAuth: { oauth: oauth.options } });

    try {
      expect(workItem.status).toBe("approved");
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${oauth.token({ scope: "acs:worker:claim" })}` },
        payload: mcpToolCall("remote-worker-claim", "claim_next_approved_work_item", { workerId: "remote-worker" })
      });

      expect(response.statusCode).not.toBe(200);
      expect(JSON.stringify(response.json())).not.toContain("leaseToken");

      const store = new SqliteWorkItemStore(dbPath);
      try {
        expect(store.get(workItem.id)?.status).toBe("approved");
        expect(JSON.stringify(store.readEvents())).not.toContain("leaseToken");
      } finally {
        store.close();
      }
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes tools/call through governed work-item creation", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-"));
    const dbPath = join(dir, "control.db");
    seedActor(dbPath, testAuth.actorId, "local_bearer:local-dev");
    const app = buildGateway({ dbPath, logger: false, auth: testAuth, mcpAuth: { localBearerToken: testAuth.token } });
    let appClosed = false;

    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${testAuth.token}` },
        payload: {
          jsonrpc: "2.0",
          id: "call-create",
          method: "tools/call",
          params: {
            name: "create_work_item",
            arguments: {
              title: "MCP write request",
              requester: "agent",
              intent: "verify MCP governed tool call",
              target: { cwd: "/repo" },
              requestedActions: [{ kind: "fs.write", description: "write file", params: { paths: ["src/index.ts"] } }],
              risk: "medium"
            }
          }
        }
      });

      expect(response.statusCode).toBe(200);
      const structured = response.json().result.structuredContent;
      expect(structured.status).toBe("needs_approval");
      expect(structured.requestedActions).toHaveLength(1);

      await app.close();
      appClosed = true;
      const store = new SqliteWorkItemStore(dbPath);
      try {
        const events = store.readEvents();
        expect(events.map((event) => event.name)).toEqual(
          expect.arrayContaining(["work_item.created", "policy.decided", "work_item.needs_approval"])
        );
        expect(store.list()).toHaveLength(1);
      } finally {
        store.close();
      }
    } finally {
      if (!appClosed) {
        await app.close();
      }
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed for unauthorized tools/call requests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-"));
    const dbPath = join(dir, "control.db");
    const app = buildGateway({ dbPath, logger: false, auth: testAuth });
    let appClosed = false;

    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        payload: {
          jsonrpc: "2.0",
          id: "unauthorized",
          method: "tools/call",
          params: {
            name: "create_work_item",
            arguments: {
              title: "Unauthorized MCP write request",
              requester: "agent",
              intent: "must not mutate",
              requestedActions: [{ kind: "fs.read", description: "read repo", params: { paths: ["src/index.ts"] } }],
              risk: "low"
            }
          }
        }
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        jsonrpc: "2.0",
        id: "unauthorized",
        result: {
          isError: true,
          structuredContent: {
            authError: "missing_token",
            requiredScopes: ["acs:work:create"]
          }
        }
      });

      await app.close();
      appClosed = true;
      const store = new SqliteWorkItemStore(dbPath);
      try {
        expect(store.list()).toEqual([]);
        expect(store.readEvents()).toEqual([]);
      } finally {
        store.close();
      }
    } finally {
      if (!appClosed) {
        await app.close();
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publishes OAuth protected resource metadata when configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-oauth-"));
    const oauth = createTestOAuth();
    const app = buildGateway({
      dbPath: join(dir, "control.db"),
      logger: false,
      mcpAuth: { oauth: oauth.options }
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/.well-known/oauth-protected-resource/mcp"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        resource: oauthResource,
        resource_name: "Agent Control Stack MCP Gateway",
        authorization_servers: [oauthIssuer],
        scopes_supported: ["acs:work:create", "acs:work:read", "acs:work:approve"],
        bearer_methods_supported: ["header"]
      });
      expect(response.json().scopes_supported).not.toContain("acs:worker:claim");
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a valid OAuth bearer JWT for tools/call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-oauth-"));
    const dbPath = join(dir, "control.db");
    const oauth = createTestOAuth();
    seedActor(dbPath, "oauth-user", "oauth_jwt:user_123");
    const app = buildGateway({ dbPath, logger: false, mcpAuth: { oauth: oauth.options } });
    let appClosed = false;

    try {
      const token = oauth.token({ scope: "acs:work:create" });
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${token}` },
        payload: createWorkItemToolCall("oauth-valid")
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().result.structuredContent.title).toBe("oauth-valid");

      await app.close();
      appClosed = true;
      const store = new SqliteWorkItemStore(dbPath);
      try {
        expect(store.list()).toHaveLength(1);
        const authEvent = store.readEvents().find((event) => event.name === "connector.requested");
        expect(authEvent?.attributes).toMatchObject({
          "connector.actor": "oauth-user",
          "auth.method": "oauth_jwt",
          "auth.subject": "user_123",
          "auth.issuer": oauthIssuer
        });
        expect(authEvent?.body.authScopes).toEqual(["acs:work:create"]);
        expect(JSON.stringify(authEvent)).not.toContain(token);
      } finally {
        store.close();
      }
    } finally {
      if (!appClosed) {
        await app.close();
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed for valid OAuth MCP auth when no registry actor resolves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-oauth-no-actor-"));
    const dbPath = join(dir, "control.db");
    const oauth = createTestOAuth();
    seedActor(dbPath, "somebody-else", "oauth_jwt:somebody_else");
    const app = buildGateway({ dbPath, logger: false, mcpAuth: { oauth: oauth.options } });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${oauth.token({ scope: "acs:work:create" })}` },
        payload: createWorkItemToolCall("oauth-no-actor")
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.message).toBe("MCP actor is not registered");
      const store = new SqliteWorkItemStore(dbPath);
      try {
        expect(store.list()).toEqual([]);
      } finally {
        store.close();
      }
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("binds MCP work item requester to the authenticated identity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-oauth-"));
    const dbPath = join(dir, "control.db");
    const oauth = createTestOAuth();
    seedActor(dbPath, "oauth-user", "oauth_jwt:user_123");
    const app = buildGateway({ dbPath, logger: false, mcpAuth: { oauth: oauth.options } });
    let appClosed = false;

    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${oauth.token({ scope: "acs:work:create" })}` },
        payload: mcpToolCall("spoofed-requester", "create_work_item", {
          title: "spoofed requester",
          requester: "user",
          requesterSubject: "oauth_jwt:fake-human",
          intent: "attempt to appear human-originated",
          target: { cwd: "/repo" },
          requestedActions: [{ kind: "fs.read", description: "read repo", params: { paths: ["src/index.ts"] } }],
          risk: "high"
        })
      });

      expect(response.statusCode).toBe(200);
      const structured = response.json().result.structuredContent;
      expect(structured.requester).toBe("agent");
      expect(structured.requesterSubject).toBe("oauth-user");

      await app.close();
      appClosed = true;
      const store = new SqliteWorkItemStore(dbPath);
      try {
        const [workItem] = store.list();
        expect(workItem.requester).toBe("agent");
        expect(workItem.requesterSubject).toBe("oauth-user");
        const created = store.readEvents().find((event) => event.name === "work_item.created");
        expect(created?.body).toMatchObject({ requester: "agent", requesterSubject: "oauth-user" });
        expect(created?.attributes["work_item.requester_subject"]).toBe("oauth-user");
      } finally {
        store.close();
      }
    } finally {
      if (!appClosed) {
        await app.close();
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores caller-supplied requesterSubject on HTTP work item creation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-http-subject-"));
    const app = buildTestGateway({ dbPath: join(dir, "control.db"), logger: false });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/work-items",
        payload: {
          title: "http spoof attempt",
          intent: "requesterSubject must not be caller-controlled",
          requesterSubject: "oauth_jwt:fake-human",
          requestedActions: [{ kind: "fs.read", description: "read repo", params: { paths: ["src/index.ts"] } }],
          target: { cwd: "/repo" },
          risk: "low"
        }
      });

      expect(created.statusCode).toBe(201);
      expect(created.json().requester).toBe("user");
      expect(created.json().requesterSubject).toBeUndefined();
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps local ACS_MCP_BEARER_TOKEN-style fallback for tools/call", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-local-mcp-"));
    const dbPath = join(dir, "control.db");
    seedActor(dbPath, testAuth.actorId, "local_bearer:local-dev");
    const app = buildGateway({
      dbPath,
      logger: false,
      auth: testAuth,
      mcpAuth: { localBearerToken: "local-dev-token" }
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: "Bearer local-dev-token" },
        payload: createWorkItemToolCall("local-fallback")
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().result.structuredContent.title).toBe("local-fallback");
    } finally {
      await app.close();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed for local MCP bearer auth when no registry actor resolves", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-local-mcp-no-actor-"));
    const dbPath = join(dir, "control.db");
    const app = buildGateway({
      dbPath,
      logger: false,
      auth: testAuth,
      mcpAuth: { localBearerToken: "local-dev-token" }
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: "Bearer local-dev-token" },
        payload: createWorkItemToolCall("local-no-actor")
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.message).toBe("MCP actor is not registered");
      const store = new SqliteWorkItemStore(dbPath);
      try {
        expect(store.list()).toEqual([]);
      } finally {
        store.close();
      }
    } finally {
      await app.close();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not publish OAuth protected resource metadata without OAuth configuration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-metadata-"));
    const app = buildGateway({
      dbPath: join(dir, "control.db"),
      logger: false
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/.well-known/oauth-protected-resource/mcp",
        headers: { host: "127.0.0.1:3000" }
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "MCP auth is not configured" });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a trusted tunnel proxy identity for scoped MCP tools/call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-tunnel-"));
    const dbPath = join(dir, "control.db");
    seedActor(dbPath, "chatgpt-prod", "tunnel_id:chatgpt-prod");
    const app = buildGateway({
      dbPath,
      logger: false,
      mcpAuth: {
        tunnel: {
          trustedProxies: ["127.0.0.1"],
          connectors: [{ id: "chatgpt-prod", tunnelId: "tunnel_abc123", scopes: ["acs:work:create", "acs:work:read"] }]
        }
      }
    });
    let appClosed = false;

    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        remoteAddress: "127.0.0.1",
        headers: {
          "x-acs-tunnel-id": "tunnel_abc123",
          "x-acs-connector-id": "chatgpt-prod"
        },
        payload: createWorkItemToolCall("tunnel-valid")
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().result.structuredContent.title).toBe("tunnel-valid");

      await app.close();
      appClosed = true;
      const store = new SqliteWorkItemStore(dbPath);
      try {
        const authEvent = store.readEvents().find((event) => event.name === "connector.requested");
        expect(authEvent?.attributes).toMatchObject({
          "connector.actor": "chatgpt-prod",
          "auth.method": "tunnel_id",
          "auth.subject": "tunnel:tunnel_abc123",
          "auth.issuer": "trusted_tunnel_proxy",
          "auth.connector_id": "chatgpt-prod"
        });
        expect(authEvent?.body.authScopes).toEqual(["acs:work:create", "acs:work:read"]);
      } finally {
        store.close();
      }
    } finally {
      if (!appClosed) {
        await app.close();
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses unsigned tunnel-id MCP auth in production even when env allowlists a tunnel", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ACS_AUTH_MODE", "tunnel_id");
    vi.stubEnv("ACS_TRUSTED_TUNNEL_PROXY", "127.0.0.1");
    vi.stubEnv("ACS_ALLOWED_TUNNEL_IDS", "chatgpt-prod=tunnel_abc123");
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-prod-unsigned-tunnel-"));
    const dbPath = join(dir, "control.db");
    seedActor(dbPath, "chatgpt-prod", "tunnel_id:chatgpt-prod");
    const precheck = new SqliteWorkItemStore(dbPath);
    const eventCountBefore = precheck.readEvents().length;
    precheck.close();
    const app = buildGateway({ dbPath, logger: false });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        remoteAddress: "127.0.0.1",
        headers: {
          "x-acs-tunnel-id": "tunnel_abc123",
          "x-acs-connector-id": "chatgpt-prod"
        },
        payload: createWorkItemToolCall("prod-unsigned-tunnel")
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().result.structuredContent.authError).toMatch(/missing_token|invalid_token/);
      const store = new SqliteWorkItemStore(dbPath);
      try {
        expect(store.list()).toEqual([]);
        expect(store.readEvents()).toHaveLength(eventCountBefore);
      } finally {
        store.close();
      }
    } finally {
      await app.close();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed for trusted tunnel MCP auth when no registry actor resolves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-tunnel-no-actor-"));
    const dbPath = join(dir, "control.db");
    const app = buildGateway({
      dbPath,
      logger: false,
      mcpAuth: {
        tunnel: {
          trustedProxies: ["127.0.0.1"],
          connectors: [{ id: "chatgpt-prod", tunnelId: "tunnel_abc123", scopes: ["acs:work:create", "acs:work:read"] }]
        }
      }
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        remoteAddress: "127.0.0.1",
        headers: {
          "x-acs-tunnel-id": "tunnel_abc123",
          "x-acs-connector-id": "chatgpt-prod"
        },
        payload: createWorkItemToolCall("tunnel-no-actor")
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.message).toBe("MCP actor is not registered");
      const store = new SqliteWorkItemStore(dbPath);
      try {
        expect(store.list()).toEqual([]);
      } finally {
        store.close();
      }
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects tunnel identity headers from untrusted remote addresses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-tunnel-"));
    const dbPath = join(dir, "control.db");
    const app = buildGateway({
      dbPath,
      logger: false,
      mcpAuth: {
        tunnel: {
          trustedProxies: ["127.0.0.1"],
          connectors: [{ id: "chatgpt-prod", tunnelId: "tunnel_abc123", scopes: ["acs:work:create", "acs:work:read"] }]
        }
      }
    });
    let appClosed = false;

    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        remoteAddress: "203.0.113.10",
        headers: {
          "x-acs-tunnel-id": "tunnel_abc123",
          "x-acs-connector-id": "chatgpt-prod"
        },
        payload: createWorkItemToolCall("tunnel-rejected")
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().result.structuredContent.authError).toBe("invalid_token");

      await app.close();
      appClosed = true;
      const store = new SqliteWorkItemStore(dbPath);
      try {
        expect(store.list()).toEqual([]);
        expect(store.readEvents()).toEqual([]);
      } finally {
        store.close();
      }
    } finally {
      if (!appClosed) {
        await app.close();
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not grant approval authority to tunnel identities without approval scope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-tunnel-"));
    const app = buildGateway({
      dbPath: join(dir, "control.db"),
      logger: false,
      mcpAuth: {
        tunnel: {
          trustedProxies: ["127.0.0.1"],
          connectors: [{ id: "chatgpt-prod", tunnelId: "tunnel_abc123", scopes: ["acs:work:create", "acs:work:read"] }]
        }
      }
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        remoteAddress: "127.0.0.1",
        headers: {
          "x-acs-tunnel-id": "tunnel_abc123",
          "x-acs-connector-id": "chatgpt-prod"
        },
        payload: {
          jsonrpc: "2.0",
          id: "approve-through-tunnel",
          method: "tools/call",
          params: {
            name: "approve_work_item",
            arguments: { id: "wi_missing", approvedBy: "chatgpt-prod", reason: "should not reach tool" }
          }
        }
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().result.structuredContent).toMatchObject({
        authError: "insufficient_scope",
        requiredScopes: ["acs:work:approve"]
      });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("denies MCP approval while binding cancel and unblock actors to the authenticated subject", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-mcp-actor-"));
    const dbPath = join(dir, "control.db");
    const setup = new SqliteWorkItemStore(dbPath);
    const setupTools = createWorkItemTools(setup, createPolicyEngine());
    const approvalItem = setupTools.create_work_item({
      title: "MCP approval actor",
      requester: "agent",
      intent: "verify approval actor binding",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.write", description: "write", params: { paths: ["src/index.ts"] } }],
      risk: "low"
    });
    const cancelItem = setup.create({
      title: "MCP cancel actor",
      requester: "agent",
      intent: "verify cancel actor binding",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.read", description: "read", params: { paths: ["src/index.ts"] } }],
      risk: "low"
    });
    const unblockItem = setup.create({
      title: "MCP unblock actor",
      requester: "agent",
      intent: "verify unblock actor binding",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.read", description: "read", params: { paths: ["src/index.ts"] } }],
      risk: "low"
    });
    setup.registerActor({
      id: "oauth-user",
      actorType: "HUMAN",
      displayName: "OAuth User",
      externalRef: "oauth_jwt:user_123"
    });
    setup.blockWorkItem(unblockItem.id);
    setup.close();

    const oauth = createTestOAuth();
    const app = buildGateway({ dbPath, logger: false, mcpAuth: { oauth: oauth.options } });
    let appClosed = false;

    try {
      const headers = { authorization: `Bearer ${oauth.token({ scope: "acs:work:approve" })}` };
      const approved = await app.inject({
        method: "POST",
        url: "/mcp",
        headers,
        payload: mcpToolCall("approve-spoof", "approve_work_item", {
          id: approvalItem.id,
          approvedBy: "attacker",
          reason: "caller supplied identity must be ignored",
          actionHash: approvalActionHash(approvalItem, "oauth-user")
        })
      });
      const cancelled = await app.inject({
        method: "POST",
        url: "/mcp",
        headers,
        payload: mcpToolCall("cancel-spoof", "cancel_work_item", {
          id: cancelItem.id,
          actor: "attacker",
          reason: "caller supplied identity must be ignored"
        })
      });
      const unblocked = await app.inject({
        method: "POST",
        url: "/mcp",
        headers,
        payload: mcpToolCall("unblock-spoof", "unblock_work_item", {
          id: unblockItem.id,
          actor: "attacker"
        })
      });

      expect(approved.statusCode).toBe(403);
      expect(approved.json().error.message).toBe("MCP identities cannot grant approval");
      expect(cancelled.statusCode).toBe(200);
      expect(unblocked.statusCode).toBe(200);

      await app.close();
      appClosed = true;
      const check = new SqliteWorkItemStore(dbPath);
      try {
        const events = check.readEvents();
        const approval = events.find(
          (event) => event.name === "approval.granted" && event.body.workItemId === approvalItem.id
        );
        const cancellation = events.find(
          (event) => event.name === "work_item.cancelled" && event.body.id === cancelItem.id
        );
        const unblockDecision = events.find(
          (event) =>
            event.name === "policy.decided" &&
            (event.body.context as { workItemId?: string; operation?: string } | undefined)?.workItemId ===
              unblockItem.id &&
            (event.body.context as { workItemId?: string; operation?: string } | undefined)?.operation === "unblock"
        );
        const connectorEvents = events.filter((event) => event.name === "connector.requested");

        expect(approval).toBeUndefined();
        expect(cancellation?.body).toMatchObject({ actor: "oauth-user" });
        expect(unblockDecision?.body.context).toMatchObject({ actor: "oauth-user" });
        expect(connectorEvents).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              attributes: expect.objectContaining({ "connector.actor": "oauth-user", "auth.subject": "user_123" })
            })
          ])
        );
        expect(JSON.stringify([approval, cancellation, unblockDecision, connectorEvents])).not.toContain("attacker");
      } finally {
        check.close();
      }
    } finally {
      if (!appClosed) {
        await app.close();
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers persistent connectors and tunnel sessions through authenticated routes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-tunnel-"));
    const dbPath = join(dir, "control.db");
    const { publicKey } = generateKeyPairSync("ed25519");
    const app = buildTestGateway({ dbPath, logger: false });
    let appClosed = false;

    try {
      const connector = await app.inject({
        method: "POST",
        url: "/connectors",
        payload: {
          id: "chatgpt-prod",
          displayName: "ChatGPT Desktop",
          publicKeyPem: String(publicKey.export({ type: "spki", format: "pem" })),
          allowedScopes: ["acs:work:create", "acs:work:read"]
        }
      });
      const session = await app.inject({
        method: "POST",
        url: "/connectors/chatgpt-prod/tunnel-sessions",
        payload: {
          tunnelId: "tunnel_abc123",
          sessionId: "session_1",
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        }
      });

      expect(connector.statusCode).toBe(201);
      expect(session.statusCode).toBe(201);

      await app.close();
      appClosed = true;
      const store = new SqliteWorkItemStore(dbPath);
      try {
        expect(
          store.getTunnelSession({
            connectorId: "chatgpt-prod",
            tunnelId: "tunnel_abc123",
            sessionId: "session_1"
          })
        ).toMatchObject({
          connectorId: "chatgpt-prod",
          tunnelId: "tunnel_abc123",
          sessionId: "session_1",
          status: "active",
          scopes: ["acs:work:create", "acs:work:read"]
        });
        expect(store.readEvents().map((event) => event.name)).toEqual(
          expect.arrayContaining(["connector.registered", "tunnel_session.registered"])
        );
        expect(store.readEvents()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "connector.registered",
              attributes: expect.objectContaining({ "actor.id": testAuth.actorId })
            }),
            expect.objectContaining({
              name: "tunnel_session.registered",
              attributes: expect.objectContaining({ "actor.id": testAuth.actorId })
            })
          ])
        );
      } finally {
        store.close();
      }
    } finally {
      if (!appClosed) {
        await app.close();
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires explicit audited connector key rotation instead of silent overwrite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-connector-rotate-"));
    const dbPath = join(dir, "control.db");
    const firstKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
    const secondKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
    const app = buildTestGateway({ dbPath, logger: false });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/connectors",
        payload: {
          id: "chatgpt-prod",
          publicKeyPem: String(firstKey),
          allowedScopes: ["acs:work:create"]
        }
      });
      const overwritten = await app.inject({
        method: "POST",
        url: "/connectors",
        payload: {
          id: "chatgpt-prod",
          publicKeyPem: String(secondKey),
          allowedScopes: ["acs:work:create"]
        }
      });
      const rotated = await app.inject({
        method: "POST",
        url: "/connectors/chatgpt-prod/rotate-key",
        payload: { publicKeyPem: String(secondKey), reason: "scheduled rotation" }
      });

      expect(created.statusCode).toBe(201);
      expect(overwritten.statusCode).toBe(409);
      expect(rotated.statusCode).toBe(200);
      expect(rotated.json().connector.publicKeyPem).toBe(String(secondKey));

      const store = new SqliteWorkItemStore(dbPath);
      try {
        expect(store.readEvents()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "connector.key_rotated",
              attributes: expect.objectContaining({ "actor.id": testAuth.actorId, "connector.id": "chatgpt-prod" }),
              body: expect.objectContaining({ actorId: testAuth.actorId, reason: "scheduled rotation" })
            })
          ])
        );
      } finally {
        store.close();
      }
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a signed persistent tunnel session and audits connector to tunnel to work item", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-tunnel-"));
    const dbPath = join(dir, "control.db");
    const tunnel = seedSignedTunnelSession(dbPath, {
      connectorId: "chatgpt-prod",
      tunnelId: "tunnel_abc123",
      sessionId: "session_1",
      scopes: ["acs:work:create", "acs:work:read"]
    });
    seedActor(dbPath, testAuth.actorId, "local_bearer:local-dev");
    const app = buildGateway({
      dbPath,
      logger: false,
      mcpAuth: { tunnel: { trustedProxies: ["127.0.0.1"] } }
    });
    let appClosed = false;

    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        remoteAddress: "127.0.0.1",
        headers: signedTunnelHeaders(tunnel),
        payload: createWorkItemToolCall("signed-tunnel-valid")
      });

      expect(response.statusCode).toBe(200);
      const workItem = response.json().result.structuredContent;
      expect(workItem.title).toBe("signed-tunnel-valid");

      await app.close();
      appClosed = true;
      const store = new SqliteWorkItemStore(dbPath);
      try {
        const authEvent = store.readEvents().find((event) => event.name === "connector.requested");
        expect(authEvent?.attributes).toMatchObject({
          "auth.method": "tunnel_id",
          "auth.connector_id": "chatgpt-prod",
          "auth.tunnel_id": "tunnel_abc123",
          "auth.session_id": "session_1",
          "work_item.id": workItem.id
        });
        expect(authEvent?.body).toMatchObject({
          authConnectorId: "chatgpt-prod",
          authTunnelId: "tunnel_abc123",
          authSessionId: "session_1",
          workItemId: workItem.id
        });
      } finally {
        store.close();
      }
    } finally {
      if (!appClosed) {
        await app.close();
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects signed tunnel sessions with invalid signatures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-tunnel-"));
    const dbPath = join(dir, "control.db");
    const tunnel = seedSignedTunnelSession(dbPath, {
      connectorId: "chatgpt-prod",
      tunnelId: "tunnel_abc123",
      sessionId: "session_1",
      scopes: ["acs:work:create", "acs:work:read"]
    });
    seedActor(dbPath, testAuth.actorId, "local_bearer:local-dev");
    const app = buildGateway({
      dbPath,
      logger: false,
      mcpAuth: { tunnel: { trustedProxies: ["127.0.0.1"] } }
    });

    try {
      const headers = signedTunnelHeaders(tunnel);
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        remoteAddress: "127.0.0.1",
        headers: { ...headers, "x-acs-signature": "ed25519=bad" },
        payload: createWorkItemToolCall("bad-signature")
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().result.structuredContent.authError).toBe("invalid_token");
      const store = new SqliteWorkItemStore(dbPath);
      try {
        expect(store.list()).toEqual([]);
        expect(store.readEvents().some((event) => event.name === "connector.requested")).toBe(false);
      } finally {
        store.close();
      }
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects expired signed tunnel sessions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-tunnel-"));
    const dbPath = join(dir, "control.db");
    const tunnel = seedSignedTunnelSession(dbPath, {
      connectorId: "chatgpt-prod",
      tunnelId: "tunnel_abc123",
      sessionId: "session_1",
      scopes: ["acs:work:create", "acs:work:read"],
      now: new Date(Date.now() - 120_000),
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    });
    const app = buildGateway({
      dbPath,
      logger: false,
      mcpAuth: { tunnel: { trustedProxies: ["127.0.0.1"] } }
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        remoteAddress: "127.0.0.1",
        headers: signedTunnelHeaders(tunnel),
        payload: createWorkItemToolCall("expired-session")
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().result.structuredContent.authError).toBe("invalid_token");
      const store = new SqliteWorkItemStore(dbPath);
      try {
        expect(store.list()).toEqual([]);
      } finally {
        store.close();
      }
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects revoked signed tunnel sessions after heartbeat and revocation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-tunnel-"));
    const dbPath = join(dir, "control.db");
    const tunnel = seedSignedTunnelSession(dbPath, {
      connectorId: "chatgpt-prod",
      tunnelId: "tunnel_abc123",
      sessionId: "session_1",
      scopes: ["acs:work:create", "acs:work:read"]
    });
    seedActor(dbPath, testAuth.actorId, "local_bearer:local-dev");
    const app = buildGateway({
      dbPath,
      logger: false,
      auth: testAuth,
      mcpAuth: { tunnel: { trustedProxies: ["127.0.0.1"] } }
    });
    app.addHook("onRequest", async (request) => {
      request.headers.authorization ??= `Bearer ${testAuth.token}`;
    });

    try {
      const heartbeat = await app.inject({
        method: "POST",
        url: "/connectors/chatgpt-prod/tunnels/tunnel_abc123/sessions/session_1/heartbeat"
      });
      const revoke = await app.inject({
        method: "POST",
        url: "/connectors/chatgpt-prod/tunnels/tunnel_abc123/sessions/session_1/revoke"
      });
      const rejected = await app.inject({
        method: "POST",
        url: "/mcp",
        remoteAddress: "127.0.0.1",
        headers: signedTunnelHeaders(tunnel),
        payload: createWorkItemToolCall("revoked-session")
      });

      expect(heartbeat.statusCode).toBe(200);
      expect(revoke.statusCode).toBe(200);
      expect(rejected.statusCode).toBe(401);
      expect(rejected.json().result.structuredContent.authError).toBe("invalid_token");
      const store = new SqliteWorkItemStore(dbPath);
      try {
        expect(store.readEvents().map((event) => event.name)).toEqual(
          expect.arrayContaining(["tunnel_session.heartbeat", "tunnel_session.revoked"])
        );
      } finally {
        store.close();
      }
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps multiple signed connectors scoped independently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-tunnel-"));
    const dbPath = join(dir, "control.db");
    const desktop = seedSignedTunnelSession(dbPath, {
      connectorId: "chatgpt-desktop",
      tunnelId: "tunnel_desktop",
      sessionId: "desktop_session",
      scopes: ["acs:work:create", "acs:work:read"]
    });
    const mobile = seedSignedTunnelSession(dbPath, {
      connectorId: "chatgpt-mobile",
      tunnelId: "tunnel_mobile",
      sessionId: "mobile_session",
      scopes: ["acs:work:read"]
    });
    const app = buildGateway({
      dbPath,
      logger: false,
      mcpAuth: { tunnel: { trustedProxies: ["127.0.0.1"] } }
    });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/mcp",
        remoteAddress: "127.0.0.1",
        headers: signedTunnelHeaders(desktop),
        payload: createWorkItemToolCall("desktop-create")
      });
      const rejected = await app.inject({
        method: "POST",
        url: "/mcp",
        remoteAddress: "127.0.0.1",
        headers: signedTunnelHeaders(mobile),
        payload: createWorkItemToolCall("mobile-create")
      });

      expect(created.statusCode).toBe(200);
      expect(rejected.statusCode).toBe(403);
      expect(rejected.json().result.structuredContent).toMatchObject({
        authError: "insufficient_scope",
        requiredScopes: ["acs:work:create"]
      });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unauthenticated initialize and tools/list when OAuth auth is configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-oauth-"));
    const oauth = createTestOAuth();
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false, mcpAuth: { oauth: oauth.options } });

    try {
      const initialized = await app.inject({
        method: "POST",
        url: "/mcp",
        payload: { jsonrpc: "2.0", id: "init", method: "initialize" }
      });
      const tools = await app.inject({
        method: "POST",
        url: "/mcp",
        payload: { jsonrpc: "2.0", id: "tools", method: "tools/list" }
      });
      const authenticatedTools = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${oauth.token({ scope: "acs:work:read" })}` },
        payload: { jsonrpc: "2.0", id: "tools-authenticated", method: "tools/list" }
      });

      expect(initialized.statusCode).toBe(401);
      expect(tools.statusCode).toBe(401);
      expect(authenticatedTools.statusCode).toBe(200);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unauthenticated ping and notifications when OAuth auth is configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-oauth-"));
    const oauth = createTestOAuth();
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false, mcpAuth: { oauth: oauth.options } });

    try {
      const ping = await app.inject({
        method: "POST",
        url: "/mcp",
        payload: { jsonrpc: "2.0", id: "ping", method: "ping" }
      });
      const notification = await app.inject({
        method: "POST",
        url: "/mcp",
        payload: { jsonrpc: "2.0", id: null, method: "notifications/initialized" }
      });

      expect(ping.statusCode).toBe(401);
      expect(notification.statusCode).toBe(401);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires auth before rejecting unknown MCP methods", async () => {
    const oauth = createTestOAuth();
    const result = await injectRejectedOAuthToolCall({
      oauth,
      payload: { jsonrpc: "2.0", id: "unknown", method: "dangerous/unknown" },
      headers: {}
    });

    expect(result.response.statusCode).toBe(401);
    expect(result.response.json().result.structuredContent.authError).toBe("missing_token");
    expect(result.workItems).toEqual([]);
    expect(result.events).toEqual([]);
  });

  it("audits authenticated unknown MCP methods before rejecting them", async () => {
    const oauth = createTestOAuth();
    const result = await injectRejectedOAuthToolCall({
      oauth,
      payload: { jsonrpc: "2.0", id: "unknown-authed", method: "dangerous/unknown" },
      headers: { authorization: `Bearer ${oauth.token({ scope: "acs:work:read" })}` }
    });

    expect(result.response.statusCode).toBe(404);
    expect(result.workItems).toEqual([]);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].attributes).toMatchObject({
      "connector.tool": "dangerous/unknown",
      "auth.method": "oauth_jwt",
      "auth.subject": "user_123"
    });
  });

  it("fails closed for missing OAuth bearer JWT on tools/call", async () => {
    const oauth = createTestOAuth();
    const result = await injectRejectedOAuthToolCall({
      oauth,
      headers: {}
    });

    expect(result.response.statusCode).toBe(401);
    expect(result.response.headers["www-authenticate"]).toBe(authChallenge(result.response.json()));
    expect(authChallenge(result.response.json())).toBe(
      'Bearer resource_metadata="http://localhost:80/.well-known/oauth-protected-resource/mcp", error="invalid_token", error_description="missing bearer token", scope="acs:work:create"'
    );
    expect(result.response.json().result.structuredContent).toMatchObject({
      authError: "missing_token",
      requiredScopes: ["acs:work:create"]
    });
    expect(result.workItems).toEqual([]);
  });

  it("fails closed for expired OAuth bearer JWT on tools/call", async () => {
    const oauth = createTestOAuth();
    const result = await injectRejectedOAuthToolCall({
      oauth,
      headers: { authorization: `Bearer ${oauth.token({ exp: 1 })}` }
    });

    expect(result.response.statusCode).toBe(401);
    expect(authChallenge(result.response.json())).toContain('error="invalid_token"');
    expect(result.response.json().result.structuredContent.authError).toBe("invalid_token");
    expect(result.workItems).toEqual([]);
  });

  it("fails closed for malformed OAuth bearer JWTs on tools/call", async () => {
    const oauth = createTestOAuth();
    const result = await injectRejectedOAuthToolCall({
      oauth,
      headers: { authorization: "Bearer not-a-jwt" }
    });

    expect(result.response.statusCode).toBe(401);
    expect(authChallenge(result.response.json())).toContain('error="invalid_token"');
    expect(result.response.json().result.structuredContent.authError).toBe("invalid_token");
    expect(result.workItems).toEqual([]);
  });

  it("fails closed for unsigned OAuth bearer JWTs on tools/call", async () => {
    const oauth = createTestOAuth();
    const unsigned = `${base64UrlJson({ alg: "none", typ: "JWT" })}.${base64UrlJson({
      iss: oauthIssuer,
      sub: "user_123",
      aud: oauthResource,
      exp: Math.floor(Date.now() / 1000) + 300,
      scope: "acs:work:create"
    })}.`;
    const result = await injectRejectedOAuthToolCall({
      oauth,
      headers: { authorization: `Bearer ${unsigned}` }
    });

    expect(result.response.statusCode).toBe(401);
    expect(result.response.json().result.structuredContent.authError).toBe("invalid_token");
    expect(result.workItems).toEqual([]);
  });

  it("fails closed for tampered OAuth bearer JWT signatures on tools/call", async () => {
    const oauth = createTestOAuth();
    const [header, _claims, signature] = oauth.token({ scope: "acs:work:create" }).split(".");
    const tampered = `${header}.${base64UrlJson({
      iss: oauthIssuer,
      sub: "user_123",
      aud: oauthResource,
      exp: Math.floor(Date.now() / 1000) + 300,
      scope: "acs:work:create",
      tampered: true
    })}.${signature}`;
    const result = await injectRejectedOAuthToolCall({
      oauth,
      headers: { authorization: `Bearer ${tampered}` }
    });

    expect(result.response.statusCode).toBe(401);
    expect(result.response.json().result.structuredContent.authError).toBe("invalid_token");
    expect(result.workItems).toEqual([]);
  });

  it("fails closed for wrong OAuth audience on tools/call", async () => {
    const oauth = createTestOAuth();
    const result = await injectRejectedOAuthToolCall({
      oauth,
      headers: { authorization: `Bearer ${oauth.token({ aud: "https://other.example.test" })}` }
    });

    expect(result.response.statusCode).toBe(401);
    expect(authChallenge(result.response.json())).toContain('error="invalid_token"');
    expect(result.response.json().result.structuredContent.authError).toBe("invalid_token");
    expect(result.workItems).toEqual([]);
  });

  it("fails closed when OAuth audience and resource are both wrong on tools/call", async () => {
    const oauth = createTestOAuth();
    const result = await injectRejectedOAuthToolCall({
      oauth,
      headers: {
        authorization: `Bearer ${oauth.token({
          aud: "https://other.example.test",
          resource: "https://other.example.test/mcp"
        })}`
      }
    });

    expect(result.response.statusCode).toBe(401);
    expect(authChallenge(result.response.json())).toContain('error="invalid_token"');
    expect(result.response.json().result.structuredContent.authError).toBe("invalid_token");
    expect(result.workItems).toEqual([]);
  });

  it("fails closed for wrong OAuth issuer on tools/call", async () => {
    const oauth = createTestOAuth();
    const result = await injectRejectedOAuthToolCall({
      oauth,
      headers: { authorization: `Bearer ${oauth.token({ iss: "https://issuer.example.invalid" })}` }
    });

    expect(result.response.statusCode).toBe(401);
    expect(authChallenge(result.response.json())).toContain('error="invalid_token"');
    expect(result.response.json().result.structuredContent.authError).toBe("invalid_token");
    expect(result.workItems).toEqual([]);
  });

  it("fails closed for insufficient OAuth scope on tools/call", async () => {
    const oauth = createTestOAuth();
    const result = await injectRejectedOAuthToolCall({
      oauth,
      headers: { authorization: `Bearer ${oauth.token({ scope: "acs:work:read" })}` }
    });

    expect(result.response.statusCode).toBe(403);
    expect(result.response.headers["www-authenticate"]).toBe(authChallenge(result.response.json()));
    expect(authChallenge(result.response.json())).toBe(
      'Bearer resource_metadata="http://localhost:80/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", error_description="insufficient scope", scope="acs:work:create"'
    );
    expect(result.response.json().result.structuredContent).toMatchObject({
      authError: "insufficient_scope",
      requiredScopes: ["acs:work:create"]
    });
    expect(result.workItems).toEqual([]);
  });

  it("resolves local and OAuth MCP auth from the requested environment variables", () => {
    expect(resolveMcpAuthOptions({ env: { ACS_MCP_BEARER_TOKEN: "local-dev" } })?.localBearerToken).toBe("local-dev");
    expect(
      resolveMcpAuthOptions({
        env: {
          ACS_OAUTH_ISSUER: oauthIssuer,
          ACS_OAUTH_AUDIENCE: oauthResource,
          ACS_OAUTH_JWKS_URI: "https://auth.example.test/.well-known/jwks.json"
        }
      })?.oauth
    ).toMatchObject({
      issuer: oauthIssuer,
      audience: oauthResource,
      resource: oauthResource,
      jwksUri: "https://auth.example.test/.well-known/jwks.json"
    });
    expect(
      resolveMcpAuthOptions({ env: { NODE_ENV: "production", ACS_MCP_BEARER_TOKEN: "local-dev" } })
    ).toBeUndefined();
    expect(
      resolveMcpAuthOptions({ localBearerToken: "explicit-local", env: { NODE_ENV: "production" } })
    ).toBeUndefined();
    expect(
      resolveMcpAuthOptions({
        env: {
          ACS_AUTH_MODE: "tunnel_id",
          ACS_TRUSTED_TUNNEL_PROXY: "127.0.0.1,::1",
          ACS_ALLOWED_TUNNEL_IDS: "chatgpt-prod=tunnel_abc123"
        }
      })?.tunnel
    ).toEqual({
      trustedProxies: ["127.0.0.1", "::1"],
      connectors: []
    });
    expect(
      resolveMcpAuthOptions({
        env: {
          NODE_ENV: "production",
          ACS_AUTH_MODE: "tunnel_id",
          ACS_TRUSTED_TUNNEL_PROXY: "127.0.0.1,::1",
          ACS_ALLOWED_TUNNEL_IDS: "chatgpt-prod=tunnel_abc123",
          ACS_ALLOW_UNSIGNED_TUNNEL_ID_DEV: "1"
        }
      })?.tunnel
    ).toEqual({
      trustedProxies: ["127.0.0.1", "::1"],
      connectors: []
    });
    expect(
      resolveMcpAuthOptions({
        env: {
          ACS_AUTH_MODE: "tunnel_id",
          ACS_TRUSTED_TUNNEL_PROXY: "127.0.0.1,::1",
          ACS_ALLOWED_TUNNEL_IDS: "chatgpt-prod=tunnel_abc123",
          ACS_ALLOW_UNSIGNED_TUNNEL_ID_DEV: "1"
        }
      })?.tunnel
    ).toEqual({
      trustedProxies: ["127.0.0.1", "::1"],
      connectors: [{ id: "chatgpt-prod", tunnelId: "tunnel_abc123", scopes: ["acs:work:create", "acs:work:read"] }]
    });
  });
});

describe("gateway dashboard sessions", () => {
  const dashboardAuth = { token: "super-secret-dashboard-token", actor: "user", actorId: "user" } as const;

  async function loginSession(app: ReturnType<typeof buildGateway>, token = dashboardAuth.token) {
    const login = await app.inject({ method: "POST", url: "/session/login", payload: { token } });
    const setCookie = String(login.headers["set-cookie"] ?? "");
    return { login, cookie: setCookie.split(";")[0] };
  }

  it("issues a hardened session cookie for a valid operator token and rejects bad tokens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-session-login-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false, auth: dashboardAuth });

    try {
      const { login } = await loginSession(app);
      const rejected = await app.inject({ method: "POST", url: "/session/login", payload: { token: "wrong" } });

      expect(login.statusCode).toBe(204);
      const cookie = String(login.headers["set-cookie"]);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
      expect(cookie).not.toContain(dashboardAuth.token);
      expect(rejected.statusCode).toBe(401);
      expect(rejected.headers["set-cookie"]).toBeUndefined();
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks dashboard session cookies secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const dir = mkdtempSync(join(tmpdir(), "acs-session-production-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false, auth: dashboardAuth });

    try {
      const { login } = await loginSession(app);
      expect(login.statusCode).toBe(204);
      expect(String(login.headers["set-cookie"])).toMatch(/Secure/i);
    } finally {
      await app.close();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves the dashboard and SSE stream to an authenticated session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-session-dashboard-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false, auth: dashboardAuth });

    try {
      const { cookie } = await loginSession(app);

      const page = await app.inject({ method: "GET", url: "/", headers: { cookie } });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain("ACS Mission Control");
      expect(page.body).not.toContain(dashboardAuth.token);

      const sse = await app.inject({ method: "GET", url: "/events", headers: { cookie }, payloadAsStream: true });
      expect(sse.statusCode).toBe(200);
      expect(String(sse.headers["content-type"])).toContain("text/event-stream");
      sse.stream().destroy();

      const denied = await app.inject({ method: "GET", url: "/events" });
      expect(denied.statusCode).toBe(401);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a login page instead of the dashboard when unauthenticated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-session-loginpage-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false, auth: dashboardAuth });

    try {
      const page = await app.inject({ method: "GET", url: "/" });
      expect(page.statusCode).toBe(401);
      expect(String(page.headers["content-type"])).toContain("text/html");
      expect(page.body).toContain("login-form");
      expect(page.body).not.toContain("Agent Roster");
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts session-authenticated operator mutations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-session-mutation-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false, auth: dashboardAuth });

    try {
      const { cookie } = await loginSession(app);
      const created = await app.inject({
        method: "POST",
        url: "/work-items",
        headers: { cookie },
        payload: {
          title: "Session created",
          intent: "session mutation",
          requestedActions: [{ kind: "fs.read", description: "read repo", params: { paths: ["src/index.ts"] } }],
          target: { cwd: "/repo" },
          risk: "low"
        }
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().requester).toBe("user");
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects expired dashboard session cookies on SSE, work creation, approval, and rejection routes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-session-expiry-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false, auth: dashboardAuth });

    try {
      const cookie = signedSessionCookie(dashboardAuth, {
        iat: Math.floor(Date.now() / 1000) - 10_000,
        exp: Math.floor(Date.now() / 1000) - 1
      });

      const events = await app.inject({ method: "GET", url: "/events", headers: { cookie }, payloadAsStream: true });
      if (events.statusCode === 200) events.stream().destroy();
      const created = await app.inject({
        method: "POST",
        url: "/work-items",
        headers: { cookie },
        payload: { title: "Expired", intent: "must reject", risk: "low" }
      });
      const approved = await app.inject({
        method: "POST",
        url: "/work-items/wrk_missing/approve",
        headers: { cookie },
        payload: { reason: "expired" }
      });
      const rejected = await app.inject({
        method: "POST",
        url: "/work-items/wrk_missing/reject",
        headers: { cookie },
        payload: { reason: "expired" }
      });

      expect(events.statusCode).toBe(401);
      expect(created.statusCode).toBe(401);
      expect(approved.statusCode).toBe(401);
      expect(rejected.statusCode).toBe(401);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects dashboard session cookies with tampered exp, actor, actorId, or signature", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-session-tamper-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false, auth: dashboardAuth });

    try {
      const { cookie } = await loginSession(app);
      const sessionValue = cookie.split("=")[1] ?? "";
      expect(sessionValue.split(".")).toHaveLength(2);
      const tamperedCookies = [
        tamperSessionCookie(cookie, (payload) => ({ ...payload, exp: payload.exp + 3600 })),
        tamperSessionCookie(cookie, (payload) => ({ ...payload, actor: "attacker" })),
        tamperSessionCookie(cookie, (payload) => ({ ...payload, actorId: "attacker" })),
        tamperSessionSignature(cookie)
      ];

      for (const tampered of tamperedCookies) {
        const response = await app.inject({
          method: "GET",
          url: "/events",
          headers: { cookie: tampered },
          payloadAsStream: true
        });
        if (response.statusCode === 200) response.stream().destroy();
        expect(response.statusCode).toBe(401);
      }
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gateway work-item routes", () => {
  it("rejects a needs-approval item through a distinct terminal route", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-work-item-reject-route-"));
    const dbPath = join(dir, "control.db");
    const seed = new SqliteWorkItemStore(dbPath);
    const workItem = seed.create({
      title: "Reject through route",
      requester: "agent",
      intent: "operator denies the request",
      requestedActions: [{ kind: "fs.write", description: "write file", params: { paths: ["src/index.ts"] } }],
      target: { cwd: "/repo" },
      risk: "high"
    });
    seed.close();
    const app = buildTestGateway({ dbPath, logger: false });

    try {
      const rejected = await app.inject({
        method: "POST",
        url: `/work-items/${workItem.id}/reject`,
        payload: { reason: "denied by operator" }
      });
      const approvedLater = await app.inject({
        method: "POST",
        url: `/work-items/${workItem.id}/approve`,
        payload: { reason: "too late", actionHash: approvalActionHash(workItem) }
      });

      expect(workItem.status).toBe("needs_approval");
      expect(rejected.statusCode).toBe(200);
      expect(rejected.json().workItem).toMatchObject({ id: workItem.id, status: "rejected" });
      expect(approvedLater.statusCode).toBe(409);

      await app.close();
      const store = new SqliteWorkItemStore(dbPath);
      try {
        expect(store.get(workItem.id)?.status).toBe("rejected");
        expect(() => store.claimNextApprovedWorkItem("worker-a")).toThrow("acs.worker.v2");
        expect(store.readEvents().map((event) => event.name)).toContain("work_item.rejected");
        expect(store.readEvents().map((event) => event.name)).not.toContain("work_item.cancelled");
      } finally {
        store.close();
      }
    } finally {
      try {
        await app.close();
      } catch {
        // already closed for direct store inspection
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unauthenticated read routes in production when read auth is not configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-read-auth-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false });
    const routes = [
      "/",
      "/work-items",
      "/work-items/wrk_missing",
      "/agents",
      "/agents/codex-cli",
      "/api/agents",
      "/api/agents/codex-cli",
      "/events"
    ];

    try {
      for (const url of routes) {
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode, url).toBe(503);
        expect(response.json()).toMatchObject({
          error: "read auth is not configured for production or exposed access"
        });
      }
    } finally {
      await app.close();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unauthenticated read routes from non-loopback development access", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-read-auth-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false });

    try {
      const response = await app.inject({ method: "GET", url: "/work-items", remoteAddress: "203.0.113.10" });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: "read auth is not configured for production or exposed access" });
    } finally {
      await app.close();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed for mutating routes when auth is not configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/work-items",
        payload: {
          title: "Unauthenticated work",
          requester: "user",
          intent: "verify mutation auth gate",
          target: { cwd: "/repo" },
          requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["src/index.ts"] } }],
          risk: "low"
        }
      });

      expect(response.statusCode).toBe(503);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 400 for malformed list filters", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-"));
    const app = buildTestGateway({ dbPath: join(dir, "control.db"), logger: false });

    try {
      const response = await app.inject({ method: "GET", url: "/work-items?status=bogus" });

      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires approval for writes and records exact action approval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-"));
    const dbPath = join(dir, "control.db");
    const app = buildTestGateway({ dbPath, logger: false });
    let appClosed = false;

    try {
      const created = await app.inject({
        method: "POST",
        url: "/work-items",
        payload: {
          title: "Write work",
          requester: "user",
          intent: "verify approval path",
          target: { cwd: "/repo" },
          requestedActions: [{ kind: "fs.write", description: "write file", params: { paths: ["src/index.ts"] } }],
          risk: "medium"
        }
      });
      const workItem = created.json();

      expect(workItem.status).toBe("needs_approval");

      const approved = await app.inject({
        method: "POST",
        url: `/work-items/${workItem.id}/approve`,
        payload: { reason: "approve exact write", actionHash: approvalActionHash(workItem) }
      });

      expect(approved.statusCode).toBe(200);
      expect(JSON.stringify(approved.json())).not.toContain("approvalToken");
      expect(approved.json().workItem.status).toBe("approved");
      expect(approved.json().decision.decision).toBe("require_approval");

      await app.close();
      appClosed = true;
      const store = new SqliteWorkItemStore(dbPath);
      try {
        const approvals = store.readEvents().filter((event) => event.name === "approval.granted");
        expect(approvals).toHaveLength(1);
        expect(approvals[0]?.body).toMatchObject({
          workItemId: workItem.id,
          approvedBy: "user",
          reason: "approve exact write"
        });
        expect(JSON.stringify(approvals)).not.toContain("approvalToken");
        expect(typeof approvals[0]?.body.actionHash).toBe("string");
      } finally {
        store.close();
      }
    } finally {
      if (!appClosed) {
        await app.close();
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-approves without dispatch after legacy claim denial", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-approve-running-"));
    const dbPath = join(dir, "control.db");
    const app = buildTestGateway({ dbPath, logger: false });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/work-items",
        payload: {
          title: "Write file",
          intent: "approval-gated write",
          target: { cwd: "/repo" },
          requestedActions: [{ kind: "fs.write", description: "write file", params: { paths: ["src/index.ts"] } }],
          risk: "medium"
        }
      });
      const id = created.json().id;
      const workItem = created.json();
      const approved = await app.inject({
        method: "POST",
        url: `/work-items/${id}/approve`,
        payload: { reason: "ok", actionHash: approvalActionHash(workItem) }
      });
      expect(approved.statusCode).toBe(200);
      const actionHash = approved.json().approvals[0].actionHash;

      const store = new SqliteWorkItemStore(dbPath);
      try {
        const tools = createWorkItemTools(store, createPolicyEngine());
        expect(() => tools.claim_next_approved_work_item({ workerId: "worker-1" })).toThrow("acs.worker.v2");
        expect(store.hasApproval(id, actionHash)).toBe(true);

        const eventCountBefore = store.readEvents().length;
        const replay = await app.inject({
          method: "POST",
          url: `/work-items/${id}/approve`,
          payload: { reason: "again", actionHash }
        });

        expect(replay.statusCode).toBe(200);
        expect(store.hasApproval(id, actionHash)).toBe(true);
        expect(store.get(id)?.status).toBe("approved");
        const events = store.readEvents();
        expect(events).toHaveLength(eventCountBefore + 2);
        expect(events.slice(-2).map((event) => event.name)).toEqual(["policy.decided", "approval.granted"]);
      } finally {
        store.close();
      }
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks denied work on create", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-"));
    const app = buildTestGateway({ dbPath: join(dir, "control.db"), logger: false });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/work-items",
        payload: {
          title: "Denied work",
          requester: "user",
          intent: "verify deny path",
          requestedActions: [{ kind: "shell", description: "sudo", params: { command: ["sudo", "whoami"] } }],
          risk: "low"
        }
      });

      expect(created.statusCode).toBe(201);
      expect(created.json().status).toBe("blocked");
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not mutate state when approval request shape is invalid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-"));
    const dbPath = join(dir, "control.db");
    const app = buildTestGateway({ dbPath, logger: false });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/work-items",
        payload: {
          title: "Write work",
          requester: "user",
          intent: "verify approval typo",
          target: { cwd: "/repo" },
          requestedActions: [{ kind: "fs.write", description: "write", params: { paths: ["src/index.ts"] } }],
          risk: "low"
        }
      });
      const workItem = created.json();

      const denied = await app.inject({
        method: "POST",
        url: `/work-items/${workItem.id}/approve`,
        payload: { approvedBy: "test" }
      });

      expect(denied.statusCode).toBe(400);
      expect(denied.json().error).toContain("approval_action_hash_required");
      const check = new SqliteWorkItemStore(dbPath);
      try {
        expect(check.get(workItem.id)?.status).toBe("needs_approval");
      } finally {
        check.close();
      }
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not document or emit approvalToken", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-no-approval-token-"));
    const dbPath = join(dir, "control.db");
    const app = buildTestGateway({ dbPath, logger: false });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/work-items",
        payload: {
          title: "No token work",
          requester: "user",
          intent: "verify token removal",
          target: { cwd: "/repo" },
          requestedActions: [{ kind: "fs.write", description: "write", params: { paths: ["src/index.ts"] } }],
          risk: "low"
        }
      });
      const workItem = created.json();
      const approved = await app.inject({
        method: "POST",
        url: `/work-items/${workItem.id}/approve`,
        payload: { reason: "approve without token", actionHash: approvalActionHash(workItem) }
      });

      const store = new SqliteWorkItemStore(dbPath);
      try {
        expect(approved.statusCode).toBe(200);
        expect(JSON.stringify(approved.json())).not.toContain("approvalToken");
        expect(JSON.stringify(store.readEvents())).not.toContain("approvalToken");
        expect(readFileSync(join(process.cwd(), "docs/threat-model.md"), "utf8")).not.toContain("approvalToken");
      } finally {
        store.close();
      }
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the path id over any body id on mutating routes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-"));
    const dbPath = join(dir, "control.db");
    const app = buildTestGateway({ dbPath, logger: false });

    try {
      const first = await app.inject({
        method: "POST",
        url: "/work-items",
        payload: {
          title: "Path-selected work",
          requester: "user",
          intent: "verify path id wins",
          target: { cwd: "/repo" },
          requestedActions: [{ kind: "fs.write", description: "write", params: { paths: ["src/index.ts"] } }],
          risk: "low"
        }
      });
      const second = await app.inject({
        method: "POST",
        url: "/work-items",
        payload: {
          title: "Body-selected work",
          requester: "user",
          intent: "verify body id loses",
          target: { cwd: "/repo" },
          requestedActions: [{ kind: "fs.write", description: "write", params: { paths: ["src/other.ts"] } }],
          risk: "low"
        }
      });

      const approved = await app.inject({
        method: "POST",
        url: `/work-items/${first.json().id}/approve`,
        payload: { id: second.json().id, reason: "path id must win", actionHash: approvalActionHash(first.json()) }
      });

      expect(approved.statusCode).toBe(200);
      const check = new SqliteWorkItemStore(dbPath);
      try {
        expect(check.get(first.json().id)?.status).toBe("approved");
        expect(check.get(second.json().id)?.status).toBe("needs_approval");
      } finally {
        check.close();
      }
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unblocks blocked work through policy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-"));
    const dbPath = join(dir, "control.db");
    const setup = new SqliteWorkItemStore(dbPath);
    const blocked = setup.create({
      title: "Blocked read work",
      requester: "user",
      intent: "verify unblock",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.read", description: "read", params: { paths: ["src/index.ts"] } }],
      risk: "low"
    });
    setup.blockWorkItem(blocked.id);
    setup.close();
    const app = buildTestGateway({ dbPath, logger: false });

    try {
      const unblocked = await app.inject({
        method: "POST",
        url: `/work-items/${blocked.id}/unblock`
      });

      expect(unblocked.statusCode).toBe(200);
      expect(unblocked.json().workItem.status).toBe("pending_policy");
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects approval without actionHash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-"));
    const app = buildTestGateway({ dbPath: join(dir, "control.db"), logger: false });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/work-items",
        payload: {
          title: "Missing hash work",
          requester: "user",
          intent: "verify missing hash rejection",
          target: { cwd: "/repo" },
          requestedActions: [{ kind: "fs.write", description: "write", params: { paths: ["src/index.ts"] } }],
          risk: "low"
        }
      });

      const rejected = await app.inject({
        method: "POST",
        url: `/work-items/${created.json().id}/approve`,
        payload: { reason: "no action hash" }
      });

      expect(rejected.statusCode).toBe(400);
      expect(rejected.json()).toMatchObject({ code: "approval_action_hash_required" });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects approval for a non-requested action hash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-"));
    const app = buildTestGateway({ dbPath: join(dir, "control.db"), logger: false });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/work-items",
        payload: {
          title: "Write work",
          requester: "user",
          intent: "verify hash binding",
          target: { cwd: "/repo" },
          requestedActions: [{ kind: "fs.write", description: "write", params: { paths: ["src/index.ts"] } }],
          risk: "low"
        }
      });

      const rejected = await app.inject({
        method: "POST",
        url: `/work-items/${created.json().id}/approve`,
        payload: { approvedBy: "test", reason: "wrong hash", actionHash: "missing" }
      });

      expect(rejected.statusCode).toBe(409);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects stale approval hashes after the work item action changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-stale-hash-"));
    const dbPath = join(dir, "control.db");
    const app = buildTestGateway({ dbPath, logger: false });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/work-items",
        payload: {
          title: "Stale hash work",
          requester: "user",
          intent: "verify stale hash rejection",
          target: { cwd: "/repo" },
          requestedActions: [{ kind: "fs.write", description: "write old", params: { paths: ["src/old.ts"] } }],
          risk: "low"
        }
      });
      const staleHash = approvalActionHash(created.json());
      replaceRequestedActions(dbPath, created.json().id, [
        { kind: "fs.write", description: "write new", params: { paths: ["src/new.ts"] } }
      ]);

      const rejected = await app.inject({
        method: "POST",
        url: `/work-items/${created.json().id}/approve`,
        payload: { reason: "stale hash", actionHash: staleHash }
      });

      expect(rejected.statusCode).toBe(409);
      expect(rejected.json().error).toContain("approval action hash does not match work item");
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not expose or persist a legacy worker result after schema v6", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-results-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    const tools = createWorkItemTools(store, createPolicyEngine());
    const secret = `sk-${"x".repeat(24)}`;

    try {
      const workItem = tools.create_work_item({
        title: "Readable result",
        requester: "agent",
        intent: "verify result exposure",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.read", description: "read repo", params: { paths: ["src/index.ts"] } }],
        risk: "low"
      });
      expect(() => tools.claim_next_approved_work_item({ workerId: "worker-a" })).toThrow("acs.worker.v2");
      expect(() =>
        tools.submit_work_result({
          workItemId: workItem.id,
          leaseId: "legacy-lease",
          workerId: "worker-a",
          actionHash: "a".repeat(64),
          idempotencyKey: "gateway-result-redaction-1",
          outcome: "succeeded",
          startedAt: "2026-07-23T20:00:00.000Z",
          finishedAt: "2026-07-23T20:00:01.000Z",
          summary: "done",
          stdout: secret,
          structuredOutput: { result: "done" },
          simulationMetadata: { executionMode: "dry_run", simulated: true, reason: "gateway_test" }
        })
      ).toThrow("acs.worker.v2");

      const app = buildTestGateway({ dbPath, logger: false });
      try {
        const detail = await app.inject({ method: "GET", url: `/work-items/${workItem.id}` });
        expect(detail.statusCode).toBe(200);
        expect(detail.json().workItem).toMatchObject({
          status: "approved"
        });
        expect(detail.json().workItem).not.toHaveProperty("result");
      } finally {
        await app.close();
      }

      expect(store.readEvents().find((event) => event.name === "work_item.succeeded")).toBeUndefined();
      const raw = readRawWorkItemResult(dbPath, workItem.id);
      expect(raw).toEqual({ result_json: null });
      expect(JSON.stringify(store.readEvents()) + JSON.stringify(raw)).not.toContain(secret);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows authenticated non-self high-risk approval through the policy engine", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-"));
    const dbPath = join(dir, "control.db");
    const setup = new SqliteWorkItemStore(dbPath);
    const tools = createWorkItemTools(setup, createPolicyEngine());
    const workItem = tools.create_work_item({
      title: "Critical read",
      requester: "agent",
      intent: "verify high-risk HTTP approval",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["src/index.ts"] } }],
      risk: "critical"
    });
    setup.close();
    const app = buildTestGateway({ dbPath, logger: false });

    try {
      const approved = await app.inject({
        method: "POST",
        url: `/work-items/${workItem.id}/approve`,
        payload: { reason: "body identity must not matter", actionHash: approvalActionHash(workItem) }
      });

      expect(approved.statusCode).toBe(200);
      expect(approved.json().workItem.status).toBe("approved");
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects high-risk self-approval at the authenticated HTTP boundary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-"));
    const token = "a";
    const dbPath = join(dir, "control.db");
    const app = buildGateway({ dbPath, logger: false, auth: { token, actor: "agent", actorId: "agent" } });
    seedActor(dbPath, "agent");
    app.addHook("onRequest", async (request) => {
      request.headers.authorization ??= `Bearer ${token}`;
    });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/work-items",
        payload: {
          title: "Critical self approval",
          requester: "agent",
          intent: "verify high-risk self approval block",
          target: { cwd: "/repo" },
          requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["src/index.ts"] } }],
          risk: "critical"
        }
      });

      const denied = await app.inject({
        method: "POST",
        url: `/work-items/${created.json().id}/approve`,
        payload: { reason: "self approval must not pass", actionHash: approvalActionHash(created.json(), "agent") }
      });

      expect(denied.statusCode).toBe(403);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("denies critical self-approval without HTTP", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-tools-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    const tools = createWorkItemTools(store, createPolicyEngine());

    try {
      const workItem = tools.create_work_item({
        title: "Critical read",
        requester: "agent",
        intent: "verify self approval denial",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["src/index.ts"] } }],
        risk: "critical"
      });

      const denied = tools.approve_work_item({
        id: workItem.id,
        approvedBy: "agent",
        reason: "self approve",
        actionHash: approvalActionHash(workItem, "agent")
      });

      expect(denied.decision.decision).toBe("deny");
      expect(store.get(workItem.id)?.status).toBe("needs_approval");
      expect(store.readEvents().filter((event) => event.name === "approval.granted")).toHaveLength(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function readRawWorkItemResult(dbPath: string, workItemId: string): unknown {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(`SELECT result_json FROM work_items WHERE id = ?`).get(workItemId);
  } finally {
    db.close();
  }
}

function updateAuditBody(dbPath: string, sequence: number, body: Record<string, unknown>): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`UPDATE audit_events SET body = ? WHERE sequence = ?`).run(JSON.stringify(body), sequence);
  } finally {
    db.close();
  }
}

function countAuditRows(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare(`SELECT COUNT(*) AS count FROM audit_events`).get() as { count: number }).count;
  } finally {
    db.close();
  }
}

function replaceRequestedActions(dbPath: string, workItemId: string, requestedActions: unknown[]): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`UPDATE work_items SET requested_actions_json = ?, updated_at = ? WHERE id = ?`).run(
      JSON.stringify(requestedActions),
      new Date().toISOString(),
      workItemId
    );
  } finally {
    db.close();
  }
}

function seedAuditRows(dbPath: string, count: number, input: { workItemId: string; agentId: string }): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("BEGIN IMMEDIATE");
    let previousHash =
      (
        db.prepare(`SELECT event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1`).get() as
          { event_hash: string } | undefined
      )?.event_hash ?? "";
    const insert = db.prepare(
      `INSERT INTO audit_events (id, name, time_unix_nano, attributes, body, previous_hash, event_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (let index = 0; index < count; index += 1) {
      const event = {
        sequence: (
          db.prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM audit_events`).get() as {
            sequence: number;
          }
        ).sequence,
        id: `evt_seed_${index}`,
        name: `audit.seed.${index}`,
        timeUnixNano: String((Date.now() + index) * 1_000_000),
        attributes: { "work_item.id": input.workItemId, "agent.id": input.agentId },
        body: { index },
        previousHash,
        eventHash: ""
      };
      const eventHash = auditEventHash(event);
      insert.run(
        event.id,
        event.name,
        event.timeUnixNano,
        JSON.stringify(event.attributes),
        JSON.stringify(event.body),
        event.previousHash,
        eventHash
      );
      previousHash = eventHash;
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // best effort; the transaction may already be closed.
    }
    throw error;
  } finally {
    db.close();
  }
}

interface SessionCookiePayload {
  v: number;
  actor: string;
  actorId?: string;
  iat: number;
  exp: number;
}

function tamperSessionCookie(cookie: string, mutate: (payload: SessionCookiePayload) => SessionCookiePayload): string {
  const [name, value] = cookie.split("=");
  const [payloadPart, signature] = (value ?? "").split(".");
  const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as SessionCookiePayload;
  const tamperedPayload = Buffer.from(JSON.stringify(mutate(payload))).toString("base64url");
  return `${name}=${tamperedPayload}.${signature}`;
}

function tamperSessionSignature(cookie: string): string {
  const [name, value] = cookie.split("=");
  const [payloadPart] = (value ?? "").split(".");
  return `${name}=${payloadPart}.tampered`;
}

function signedSessionCookie(
  auth: { token: string; actor: string; actorId?: string },
  input: { iat: number; exp: number }
): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      actor: auth.actor,
      ...(auth.actorId ? { actorId: auth.actorId } : {}),
      iat: input.iat,
      exp: input.exp
    })
  ).toString("base64url");
  const signature = createHmac("sha256", auth.token).update(`acs-session-v2:${payload}`).digest("base64url");
  return `acs_session=${payload}.${signature}`;
}

function createWorkItemToolCall(title: string) {
  return {
    jsonrpc: "2.0",
    id: `call-${title}`,
    method: "tools/call",
    params: {
      name: "create_work_item",
      arguments: {
        title,
        requester: "agent",
        intent: "verify authenticated MCP tool call",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.read", description: "read repo", params: { paths: ["src/index.ts"] } }],
        risk: "low"
      }
    }
  };
}

function mcpToolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args }
  };
}

function seedSignedTunnelSession(
  dbPath: string,
  input: {
    connectorId: string;
    tunnelId: string;
    sessionId: string;
    scopes: string[];
    now?: Date;
    expiresAt?: string;
  }
) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const store = new SqliteWorkItemStore(dbPath);
  try {
    store.registerActor({
      id: input.connectorId,
      actorType: "SERVICE",
      displayName: input.connectorId,
      externalRef: `tunnel_id:${input.connectorId}`
    });
    store.registerConnector({
      id: input.connectorId,
      publicKeyPem: String(publicKey.export({ type: "spki", format: "pem" })),
      allowedScopes: input.scopes,
      actorId: input.connectorId,
      now: input.now
    });
    store.registerTunnelSession({
      connectorId: input.connectorId,
      tunnelId: input.tunnelId,
      sessionId: input.sessionId,
      expiresAt: input.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
      actorId: input.connectorId,
      now: input.now
    });
  } finally {
    store.close();
  }
  return {
    privateKey,
    connectorId: input.connectorId,
    tunnelId: input.tunnelId,
    sessionId: input.sessionId
  };
}

function signedTunnelHeaders(input: {
  privateKey: KeyObject;
  connectorId: string;
  tunnelId: string;
  sessionId: string;
}) {
  const issuedAt = new Date().toISOString();
  const signature = sign(
    null,
    Buffer.from(createTunnelSignaturePayload({ ...input, issuedAt })),
    input.privateKey
  ).toString("base64url");
  return {
    "x-acs-connector-id": input.connectorId,
    "x-acs-tunnel-id": input.tunnelId,
    "x-acs-session-id": input.sessionId,
    "x-acs-issued-at": issuedAt,
    "x-acs-signature": `ed25519=${signature}`
  };
}

function createTestOAuth() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "test-key";
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" };
  const nowSeconds = Math.floor(Date.now() / 1000);
  const options = {
    issuer: oauthIssuer,
    audience: oauthResource,
    resource: oauthResource,
    jwks: { keys: [jwk] },
    authorizationServers: [oauthIssuer]
  };

  function token(overrides: Record<string, unknown> = {}): string {
    const header = { alg: "RS256", typ: "JWT", kid };
    const claims = {
      iss: oauthIssuer,
      sub: "user_123",
      aud: oauthResource,
      exp: nowSeconds + 300,
      iat: nowSeconds,
      scope: "acs:work:create",
      ...overrides
    };
    const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
    const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
    return `${signingInput}.${signature}`;
  }

  return { options, token };
}

async function injectRejectedOAuthToolCall(input: {
  oauth: ReturnType<typeof createTestOAuth>;
  headers: Record<string, string>;
  payload?: unknown;
}) {
  const dir = mkdtempSync(join(tmpdir(), "acs-gateway-oauth-reject-"));
  const dbPath = join(dir, "control.db");
  const app = buildGateway({
    dbPath,
    logger: false,
    mcpAuth: { oauth: input.oauth.options }
  });
  let appClosed = false;

  try {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: input.headers,
      payload: input.payload ?? createWorkItemToolCall("rejected")
    });

    await app.close();
    appClosed = true;
    const store = new SqliteWorkItemStore(dbPath);
    try {
      return { response, workItems: store.list(), events: store.readEvents() };
    } finally {
      store.close();
    }
  } finally {
    if (!appClosed) {
      await app.close();
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function gatewayFixtureAcpAgentScript(): string {
  return `
let buffer = Buffer.alloc(0);
let initialized = false;

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\\r\\n\\r\\n' + body);
}

function handle(message) {
  if (initialized) {
    return;
  }
  if (!message || message.method !== 'initialize') {
    process.exit(2);
  }
  initialized = true;
  send({
    jsonrpc: '2.0',
    id: message.id,
    result: {
      protocolVersion: '1.0',
      agent: { name: 'Gateway Fixture ACP Agent', version: '0.1.0' },
      capabilities: { plan: true, filesystem: false, terminal: false },
      authMethods: ['none'],
      sessionFeatures: ['updates']
    }
  });
}

function tryRead() {
  const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
  if (headerEnd === -1) return;
  const header = buffer.subarray(0, headerEnd).toString('ascii');
  const match = /content-length:\\s*(\\d+)/i.exec(header);
  if (!match) process.exit(3);
  const length = Number(match[1]);
  const bodyStart = headerEnd + 4;
  if (buffer.length < bodyStart + length) return;
  const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
  buffer = buffer.subarray(bodyStart + length);
  handle(JSON.parse(body));
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  tryRead();
});

setInterval(() => undefined, 1000);
`;
}

function authChallenge(body: { result: { _meta: { "mcp/www_authenticate": string[] } } }): string {
  return body.result._meta["mcp/www_authenticate"][0];
}
