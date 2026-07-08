import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStackError } from "@agent-control-stack/shared";
import { SqliteWorkItemStore, type StoredAuditEvent } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { ReadonlyAcpAdapter } from "./index.js";

describe("read-only ACP adapter", () => {
  it("initializes a stdio ACP agent and persists registry metadata", async () => {
    await withAdapter("success", async ({ adapter, store }) => {
      const status = await adapter.start();
      const agent = store.getRegistryAgent("acp-test-agent");
      const events = store.readEvents();

      expect(status).toMatchObject({
        initialized: true,
        connected: true,
        processAlive: true,
        protocolVersion: "1.0",
        agentName: "Fixture ACP Agent",
        agentVersion: "0.2.0"
      });
      expect(status.lastMessageAt).toBeDefined();
      expect(status.capabilities).toEqual(["plan", "sessionUpdate"]);
      expect(status.authMethods).toEqual(["none"]);
      expect(agent).toMatchObject({
        id: "acp-test-agent",
        name: "Fixture ACP Agent",
        kind: "acp-adapter",
        provider: "acp",
        model: "0.2.0",
        endpoint: "stdio:node",
        status: "AVAILABLE",
        createdByActorId: "acp-test-actor",
        updatedByActorId: "acp-test-actor",
        latestHeartbeat: { actorId: "acp-test-actor", status: "AVAILABLE" }
      });
      expect(agent?.capabilities.map((capability) => capability.name)).toEqual(
        expect.arrayContaining(["acp.protocol.1.0", "acp.capability.plan", "acp.auth.none", "acp.session.updates"])
      );
      expect(eventNames(events)).toEqual(
        expect.arrayContaining(["actor.registered", "agent.created", "agent.capabilities_replaced", "agent.heartbeat", "acp.initialized"])
      );
    });
  });

  it("fails closed on malformed JSON-RPC", async () => {
    await withAdapter("malformed", async ({ adapter, store }) => {
      await expect(adapter.start()).rejects.toMatchObject({ code: "acp_malformed_json_rpc" });
      expect(eventNames(store.readEvents())).toContain("acp.error");
      expect(adapter.getStatus()).toMatchObject({
        initialized: false
      });
    });
  });

  it("marks the registered agent offline when the ACP process exits", async () => {
    await withAdapter("exit", async ({ adapter, store }) => {
      await adapter.start();
      await waitFor(() => store.getRegistryAgent("acp-test-agent")?.status === "OFFLINE");
      const agent = store.getRegistryAgent("acp-test-agent");

      expect(agent).toMatchObject({
        status: "OFFLINE",
        latestHeartbeat: { status: "OFFLINE", actorId: "acp-test-actor" }
      });
      expect(eventNames(store.readEvents())).toEqual(expect.arrayContaining(["acp.initialized", "acp.disconnected"]));
    });
  });

  it("rejects unsupported ACP filesystem capabilities during initialize", async () => {
    await withAdapter("unsupported-capability", async ({ adapter, store }) => {
      await expect(adapter.start()).rejects.toMatchObject({ code: "acp_unsupported_capability" });
      expect(store.getRegistryAgent("acp-test-agent")).toBeUndefined();
      expect(store.readEvents().find((event) => event.name === "acp.error")?.body).toMatchObject({
        code: "acp_unsupported_capability",
        error: "unsupported ACP capability: client.fileSystem"
      });
    });
  });

  it("rejects ACP filesystem client methods", async () => {
    await withAdapter("filesystem-request", async ({ adapter, store }) => {
      await adapter.start();
      const event = await waitForEvent(store, "acp.client_method_rejected");

      expect(adapter.getStatus().lastError).toBe("ACP filesystem methods are disabled");
      expect(event.body).toMatchObject({ reason: "ACP filesystem methods are disabled" });
      expect(event.attributes).toMatchObject({
        "agent.id": "acp-test-agent",
        "actor.id": "acp-test-actor",
        "acp.method": "fs/readTextFile"
      });
    });
  });

  it("rejects ACP terminal client methods", async () => {
    await withAdapter("terminal-request", async ({ adapter, store }) => {
      await adapter.start();
      const event = await waitForEvent(store, "acp.client_method_rejected");

      expect(adapter.getStatus().lastError).toBe("ACP terminal methods are disabled");
      expect(event.body).toMatchObject({ reason: "ACP terminal methods are disabled" });
      expect(event.attributes).toMatchObject({ "acp.method": "terminal/create" });
    });
  });

  it("rejects unknown and duplicate ACP permission requests", async () => {
    await withAdapter("permission-request", async ({ adapter, store }) => {
      await adapter.start();
      await waitFor(() => store.readEvents().filter((event) => event.name === "acp.client_method_rejected").length === 2);
      const rejectionBodies = store
        .readEvents()
        .filter((event) => event.name === "acp.client_method_rejected")
        .map((event) => event.body as Record<string, unknown>);

      expect(rejectionBodies).toEqual([
        expect.objectContaining({ reason: "unknown permission request rejected" }),
        expect.objectContaining({ reason: "duplicate permission request rejected" })
      ]);
      expect(adapter.getStatus().lastError).toBe("duplicate permission request rejected");
    });
  });

  it("translates ACP session updates into normalized timeline events and status", async () => {
    await withAdapter("session-update", async ({ adapter, store }) => {
      await adapter.start();
      await waitForEvent(store, "acp.plan");
      const agent = store.getRegistryAgent("acp-test-agent");
      const status = adapter.getStatus();

      expect(status.lastSessionUpdateAt).toBeDefined();
      expect(status.activeSessionId).toBe("sess-1");
      expect(status.activeWorkItemId).toBe("wrk_1");
      expect(agent).toMatchObject({
        status: "BUSY",
        latestHeartbeat: { status: "BUSY", currentTask: "session:sess-1" }
      });
      expect(eventNames(store.readEvents())).toContain("acp.plan");
    });
  });
});

async function withAdapter(
  scenario: string,
  fn: (context: { adapter: ReadonlyAcpAdapter; store: SqliteWorkItemStore; dbPath: string }) => Promise<void>
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "acs-acp-adapter-"));
  const dbPath = join(dir, "control.db");
  const store = new SqliteWorkItemStore(dbPath);
  const adapter = new ReadonlyAcpAdapter({
    store,
    agentId: "acp-test-agent",
    actorId: "acp-test-actor",
    command: process.execPath,
    args: ["-e", fixtureAgentScript(scenario)],
    initializeTimeoutMs: 500
  });
  try {
    await fn({ adapter, store, dbPath });
  } finally {
    await adapter.stop().catch(() => undefined);
    await adapter.waitForExit(500).catch(() => undefined);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function fixtureAgentScript(scenario: string): string {
  return `
const scenario = ${JSON.stringify(scenario)};
let buffer = Buffer.alloc(0);
let initialized = false;

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\\r\\n\\r\\n' + body);
}

function initializeResult() {
  return {
    protocolVersion: '1.0',
    agent: { name: 'Fixture ACP Agent', version: '0.2.0' },
    capabilities: scenario === 'unsupported-capability'
      ? { client: { fileSystem: { read: true } } }
      : { plan: true, sessionUpdate: true, filesystem: false, terminal: false },
    authMethods: ['none'],
    sessionFeatures: ['updates']
  };
}

function handle(message) {
  if (scenario === 'malformed') {
    process.stdout.write('{not json\\n');
    return;
  }
  if (initialized) {
    return;
  }
  if (!message || message.method !== 'initialize') {
    process.exit(2);
  }
  initialized = true;
  send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
  if (scenario === 'exit') {
    setTimeout(() => process.exit(5), 20);
  }
  if (scenario === 'filesystem-request') {
    setTimeout(() => send({ jsonrpc: '2.0', id: 42, method: 'fs/readTextFile', params: { path: '/etc/passwd' } }), 20);
  }
  if (scenario === 'terminal-request') {
    setTimeout(() => send({ jsonrpc: '2.0', id: 43, method: 'terminal/create', params: { command: 'pwd' } }), 20);
  }
  if (scenario === 'permission-request') {
    setTimeout(() => {
      send({ jsonrpc: '2.0', id: 44, method: 'permission/request', params: { permissionId: 'perm-1', action: 'fs.write' } });
      send({ jsonrpc: '2.0', id: 45, method: 'permission/request', params: { permissionId: 'perm-1', action: 'fs.write' } });
    }, 20);
  }
  if (scenario === 'session-update') {
    setTimeout(() => send({
      jsonrpc: '2.0',
      method: 'session/planUpdate',
      params: { sessionId: 'sess-1', workItemId: 'wrk_1', plan: ['inspect only'] }
    }), 20);
  }
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

async function waitForEvent(store: SqliteWorkItemStore, name: string): Promise<StoredAuditEvent> {
  return await waitFor(() => store.readEvents().find((event) => event.name === name));
}

async function waitFor<T>(predicate: () => T | undefined | false, timeoutMs = 1_000): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new ControlStackError("test_timeout", "timed out waiting for ACP adapter test condition");
}

function eventNames(events: StoredAuditEvent[]): string[] {
  return events.map((event) => event.name);
}
