import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import {
  SqliteWorkItemStore,
  type ClaimedWorkItem,
  type StoredAuditEvent,
  type WorkItem
} from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it } from "vitest";
import { buildGateway, type GatewayAuthOptions } from "./server.js";

const operatorAuth = { token: "operator-token", actor: "user", actorId: "operator" } as const;
const workerAuth: GatewayAuthOptions = { token: "worker-token", actor: "agent", actorId: "worker-a" };
const mcpHeaders = { authorization: `Bearer ${operatorAuth.token}` };
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("security-contract protocol conformance", () => {
  it("denies an unknown MCP tool with a structured error and no durable side effects", async () => {
    const fixture = createGatewayFixture();
    try {
      const eventsBefore = readStoreSnapshot(fixture.dbPath).events;
      const response = await fixture.app.inject({
        method: "POST",
        url: "/mcp",
        headers: mcpHeaders,
        payload: mcpToolCall("unknown-tool", "unbounded_shell", { command: ["sh", "-c", "id"] })
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        jsonrpc: "2.0",
        id: "unknown-tool",
        error: { code: -32602, message: "invalid tools/call params" }
      });
      expect(readStoreSnapshot(fixture.dbPath)).toEqual({ workItems: [], events: eventsBefore });
    } finally {
      await fixture.app.close();
    }
  });

  it("returns the approval-required state for an unapproved mutation and audits the policy decision", async () => {
    const fixture = createGatewayFixture();
    try {
      const response = await fixture.app.inject({
        method: "POST",
        url: "/mcp",
        headers: mcpHeaders,
        payload: mcpToolCall("approval-required", "create_work_item", writeWorkItem("Unapproved mutation"))
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        jsonrpc: "2.0",
        id: "approval-required",
        result: {
          structuredContent: {
            status: "needs_approval"
          }
        }
      });

      const snapshot = readStoreSnapshot(fixture.dbPath);
      expect(snapshot.workItems).toHaveLength(1);
      expect(snapshot.events.map((event) => event.name)).toEqual(
        expect.arrayContaining([
          "work_item.created",
          "policy.decided",
          "work_item.needs_approval",
          "connector.requested"
        ])
      );
      expect(snapshot.events.find((event) => event.name === "policy.decided")?.body).toMatchObject({
        decision: "require_approval"
      });
      expect(snapshot.events.some((event) => event.name === "approval.granted")).toBe(false);
    } finally {
      await fixture.app.close();
    }
  });

  it("forbids MCP approval and audits the authenticated denial without granting authority", async () => {
    const fixture = createGatewayFixture();
    try {
      const created = await createMcpWorkItem(fixture.app, "MCP approval denied");
      const actionHash = approvalActionHash(created);
      const eventsBefore = readStoreSnapshot(fixture.dbPath).events.length;
      const response = await fixture.app.inject({
        method: "POST",
        url: "/mcp",
        headers: mcpHeaders,
        payload: mcpToolCall("mcp-self-approval", "approve_work_item", {
          id: created.id,
          reason: "MCP must not approve",
          actionHash
        })
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        jsonrpc: "2.0",
        id: "mcp-self-approval",
        error: { code: -32002, message: "MCP identities cannot grant approval" }
      });

      const snapshot = readStoreSnapshot(fixture.dbPath);
      expect(snapshot.workItems[0]?.status).toBe("needs_approval");
      expect(snapshot.events.filter((event) => event.name === "approval.granted")).toHaveLength(0);
      expect(snapshot.events).toHaveLength(eventsBefore + 1);
      expect(snapshot.events.at(-1)).toMatchObject({
        name: "connector.requested",
        attributes: {
          "connector.tool": "approve_work_item",
          "connector.actor": "local-dev",
          "auth.subject": "local-dev"
        }
      });
    } finally {
      await fixture.app.close();
    }
  });

  it("invalidates an approval when the approved action arguments are swapped", async () => {
    const fixture = createGatewayFixture();
    try {
      const created = await createMcpWorkItem(fixture.app, "Argument binding");
      const staleActionHash = approvalActionHash(created);
      replaceRequestedActions(fixture.dbPath, created.id, [
        { kind: "fs.write", description: "write changed target", params: { paths: ["src/changed.ts"] } }
      ]);
      const eventsBefore = readStoreSnapshot(fixture.dbPath).events.length;

      const response = await fixture.app.inject({
        method: "POST",
        url: `/work-items/${created.id}/approve`,
        headers: mcpHeaders,
        payload: { reason: "stale approval", actionHash: staleActionHash }
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: "approval_action_mismatch",
        error: expect.stringContaining("approval action hash does not match work item")
      });
      const snapshot = readStoreSnapshot(fixture.dbPath);
      expect(snapshot.workItems[0]?.status).toBe("needs_approval");
      expect(snapshot.events).toHaveLength(eventsBefore);
      expect(snapshot.events.filter((event) => event.name === "approval.granted")).toHaveLength(0);
    } finally {
      await fixture.app.close();
    }
  });

  it("rejects replay of a consumed approval without adding grant or policy audit events", async () => {
    const fixture = createGatewayFixture();
    try {
      const created = await createMcpWorkItem(fixture.app, "Consumed approval");
      const actionHash = approvalActionHash(created);
      const approved = await fixture.app.inject({
        method: "POST",
        url: `/work-items/${created.id}/approve`,
        headers: mcpHeaders,
        payload: { reason: "one execution only", actionHash }
      });
      expect(approved.statusCode).toBe(200);

      const store = new SqliteWorkItemStore(fixture.dbPath);
      try {
        const tools = createWorkItemTools(store, createPolicyEngine());
        expect(tools.claim_next_approved_work_item({ workerId: workerAuth.actorId })?.status).toBe("running");
      } finally {
        store.close();
      }
      const eventsBeforeReplay = readStoreSnapshot(fixture.dbPath).events;

      const replay = await fixture.app.inject({
        method: "POST",
        url: `/work-items/${created.id}/approve`,
        headers: mcpHeaders,
        payload: { reason: "try to reuse", actionHash }
      });

      expect(replay.statusCode).toBe(409);
      expect(replay.json()).toMatchObject({
        code: "approval_already_consumed",
        error: expect.stringContaining("approval was already consumed")
      });
      const snapshot = readStoreSnapshot(fixture.dbPath);
      expect(snapshot.workItems[0]?.status).toBe("running");
      expect(snapshot.events).toEqual(eventsBeforeReplay);
      expect(snapshot.events.filter((event) => event.name === "approval.granted")).toHaveLength(1);
      expect(snapshot.events.filter((event) => event.name === "approval.consumed")).toHaveLength(1);
    } finally {
      await fixture.app.close();
    }
  });

  it("rejects result submission without worker and lease identifiers before writing audit or result state", async () => {
    const fixture = createGatewayFixture(workerAuth);
    try {
      const claimed = seedClaim(fixture.dbPath);
      const eventsBefore = readStoreSnapshot(fixture.dbPath).events;
      const response = await fixture.app.inject({
        method: "POST",
        url: `/work-items/${claimed.id}/results`,
        headers: { authorization: `Bearer ${workerAuth.token}` },
        payload: {
          workItemId: claimed.id,
          actionHash: claimed.actionHash,
          idempotencyKey: "missing-worker-and-lease",
          outcome: "succeeded",
          startedAt: claimed.startedAt,
          finishedAt: claimed.startedAt,
          summary: "must not persist",
          structuredOutput: { simulated: true },
          artifacts: [],
          simulationMetadata: { executionMode: "dry_run", simulated: true }
        }
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid request" });
      const snapshot = readStoreSnapshot(fixture.dbPath);
      expect(snapshot.workItems[0]?.status).toBe("running");
      expect(snapshot.workItems[0]?.result).toBeUndefined();
      expect(snapshot.events).toEqual(eventsBefore);
    } finally {
      await fixture.app.close();
    }
  });

  it("detects audit-chain tampering and fails subsequent mutations closed", async () => {
    const directory = temporaryDirectory();
    const dbPath = join(directory, "control.db");
    seedOperator(dbPath);
    const seedApp = buildGateway({
      dbPath,
      logger: false,
      auth: operatorAuth,
      mcpAuth: { localBearerToken: operatorAuth.token }
    });
    await createMcpWorkItem(seedApp, "Audit tampering");
    await seedApp.close();
    tamperAuditBody(dbPath);
    const auditRowsBefore = readStoreSnapshotUnsafe(dbPath).events.length;
    const app = buildGateway({ dbPath, logger: false, auth: operatorAuth });

    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      const mutation = await app.inject({
        method: "POST",
        url: "/work-items",
        headers: mcpHeaders,
        payload: writeWorkItem("Mutation after tampering")
      });

      expect(health.statusCode).toBe(503);
      expect(health.json()).toMatchObject({
        ok: false,
        checks: { auditChain: { ok: false, code: "audit_chain_event_hash_mismatch" } }
      });
      expect(mutation.statusCode).toBe(409);
      expect(mutation.json()).toMatchObject({ code: "audit_chain_invalid" });
      expect(readStoreSnapshotUnsafe(dbPath).events).toHaveLength(auditRowsBefore);
    } finally {
      await app.close();
    }
  });

  it("rejects an unauthenticated HTTP mutation before persistence", async () => {
    const fixture = createGatewayFixture();
    try {
      const eventsBefore = readStoreSnapshot(fixture.dbPath).events;
      const response = await fixture.app.inject({
        method: "POST",
        url: "/work-items",
        payload: writeWorkItem("Unauthenticated mutation")
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "unauthorized" });
      expect(readStoreSnapshot(fixture.dbPath)).toEqual({ workItems: [], events: eventsBefore });
    } finally {
      await fixture.app.close();
    }
  });
});

function createGatewayFixture(auth: GatewayAuthOptions = operatorAuth) {
  const directory = temporaryDirectory();
  const dbPath = join(directory, "control.db");
  if (auth === operatorAuth) {
    seedOperator(dbPath);
  }
  return {
    app: buildGateway({
      dbPath,
      logger: false,
      auth,
      ...(auth === operatorAuth ? { mcpAuth: { localBearerToken: operatorAuth.token } } : {})
    }),
    dbPath
  };
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "acs-security-conformance-"));
  temporaryDirectories.push(directory);
  return directory;
}

function seedOperator(dbPath: string): void {
  const store = new SqliteWorkItemStore(dbPath);
  try {
    store.registerActor({
      id: operatorAuth.actorId,
      actorType: "HUMAN",
      displayName: "Conformance Operator",
      externalRef: "local_bearer:local-dev"
    });
  } finally {
    store.close();
  }
}

async function createMcpWorkItem(app: ReturnType<typeof buildGateway>, title: string): Promise<WorkItem> {
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: mcpHeaders,
    payload: mcpToolCall(`create-${title}`, "create_work_item", writeWorkItem(title))
  });
  expect(response.statusCode).toBe(200);
  return response.json().result.structuredContent as WorkItem;
}

function writeWorkItem(title: string) {
  return {
    title,
    requester: "agent",
    intent: "verify the security-contract conformance boundary",
    target: { cwd: "/repo" },
    requestedActions: [{ kind: "fs.write", description: "write file", params: { paths: ["src/index.ts"] } }],
    risk: "medium"
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

function approvalActionHash(workItem: WorkItem): string {
  const evaluation = createPolicyEngine().evaluateWorkItem(workItem, operatorAuth.actorId, "approve")[0];
  if (!evaluation) {
    throw new Error(`missing approval evaluation for ${workItem.id}`);
  }
  return evaluation.actionHash;
}

function seedClaim(dbPath: string): ClaimedWorkItem {
  const store = new SqliteWorkItemStore(dbPath);
  try {
    const item = store.create({
      title: "Result submission binding",
      requester: "agent",
      intent: "verify worker and lease identity requirements",
      requestedActions: [{ kind: "manual", description: "simulate" }],
      risk: "low"
    });
    store.approveWorkItem(item.id, { via: "domain_service" });
    const claimed = store.claimNextApprovedWorkItem(workerAuth.actorId!, { allowLegacyClaimForTests: true });
    if (!claimed) {
      throw new Error("expected a claimed work item");
    }
    return claimed;
  } finally {
    store.close();
  }
}

function readStoreSnapshot(dbPath: string): { workItems: WorkItem[]; events: StoredAuditEvent[] } {
  const store = new SqliteWorkItemStore(dbPath);
  try {
    return { workItems: store.list(), events: store.readEvents() };
  } finally {
    store.close();
  }
}

function readStoreSnapshotUnsafe(dbPath: string): { events: unknown[] } {
  const db = new DatabaseSync(dbPath);
  try {
    return {
      events: db.prepare("SELECT sequence FROM audit_events ORDER BY sequence").all()
    };
  } finally {
    db.close();
  }
}

function replaceRequestedActions(dbPath: string, workItemId: string, requestedActions: unknown[]): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("UPDATE work_items SET requested_actions_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(requestedActions),
      "2026-07-26T12:00:00.000Z",
      workItemId
    );
  } finally {
    db.close();
  }
}

function tamperAuditBody(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("UPDATE audit_events SET body = ? WHERE sequence = 1").run(JSON.stringify({ tampered: true }));
  } finally {
    db.close();
  }
}
