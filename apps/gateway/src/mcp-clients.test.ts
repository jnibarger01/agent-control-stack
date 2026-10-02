import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionAdmissionScheduler } from "@agent-control-stack/execution-admission";
import { SqliteWorkItemStore, type StoredAuditEvent } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_TRACKED_CLIENTS,
  McpClientService,
  parseMcpClientPolicy,
  sanitizeClaim,
  suggestKind,
  type McpClientPolicy
} from "./mcp-clients.js";
import { buildGateway, type GatewayCredential } from "./server.js";

const t = (name: string) => ["tok", name, "0123456789abcdef0123456789abcdef"].join("-");
const JC = t("jc");
const DC = t("dc");
const OP = t("op");
const READER = t("reader");
const AGENT = t("agent");
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const credentials: GatewayCredential[] = [
  {
    id: "jc-bridge",
    token: JC,
    actor: "agent",
    actorId: "acs-jc-bridge",
    roles: ["service", "worker"],
    scopes: ["acs:read", "acs:write", "acs:worker"]
  },
  {
    id: "dc-bridge",
    token: DC,
    actor: "agent",
    actorId: "acs-dc-bridge",
    roles: ["service", "worker"],
    scopes: ["acs:read", "acs:write", "acs:worker"]
  },
  {
    id: "op",
    token: OP,
    actor: "user",
    actorId: "user",
    roles: ["operator"],
    scopes: ["acs:read", "acs:write", "acs:approve"]
  },
  { id: "reader", token: READER, actor: "user", actorId: "reader", roles: ["operator"], scopes: ["acs:read"] },
  {
    id: "agent",
    token: AGENT,
    actor: "agent",
    actorId: "agent-1",
    roles: ["operator"],
    scopes: ["acs:read", "acs:write", "acs:approve"]
  }
];

let root: string;
const open: Array<{ close: () => Promise<unknown> }> = [];

function gateway(policy: McpClientPolicy = "observe", dbPath = join(root, "control.db")) {
  const pair = generateKeyPairSync("ed25519");
  const app = buildGateway({
    dbPath,
    logger: false,
    mcpClientPolicy: policy,
    // A successful issuance holds its admission permit until the result callback; tests issue repeatedly.
    executionAdmission: new ExecutionAdmissionScheduler({
      config: {
        executionMaxInflight: 1_000,
        executorMaxInflight: 1_000,
        queueMax: 1_000,
        queueTimeoutMs: 30_000,
        waitMaxInflight: 1_000
      }
    }),
    auth: { token: "", actor: "user", actorId: "user", credentials },
    jaceCommanderCapability: {
      runtimeId: "jc-test-runtime",
      keyId: "jc-test-key",
      privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
      ttlMs: 29_000
    },
    readManagedAuthority: () => ({
      authorityOwner: "managed:pid:1",
      authoritative: true,
      leaseActive: true,
      leaseAmbiguous: false,
      breakGlassActive: false,
      breakGlassAmbiguous: false,
      multipleAuthoritativeExecutors: false,
      managedRuntime: true,
      detail: "ok"
    })
  });
  open.push(app);
  return app;
}
type App = ReturnType<typeof gateway>;

afterEach(async () => {
  while (open.length) await open.pop()!.close();
  if (root) rmSync(root, { recursive: true, force: true });
});
const setup = () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "acs-mcp-clients-")));
};

const issue = (app: App, clientId: string, headers: Record<string, string> = {}, actor = "chatgpt:jacen") =>
  app.inject({
    method: "POST",
    url: "/jc/capability/issue",
    headers: { ...bearer(JC), "x-jc-actor": actor, ...headers },
    payload: { client_id: clientId, tool: "acs_read", argsSummary: JSON.stringify({ view: "health" }) }
  });
const observe = (app: App, body: Record<string, unknown>, token = JC) =>
  app.inject({ method: "POST", url: "/mcp-clients/observe", headers: bearer(token), payload: body });
const clients = async (app: App) =>
  (await app.inject({ method: "GET", url: "/api/mcp-clients", headers: bearer(READER) })).json() as {
    summary: Record<string, unknown>;
    clients: Array<Record<string, any>>;
    legacy: Array<Record<string, any>>;
  };

describe("MCP client visibility", () => {
  it("attributes every issuance to the verified client and keeps self-declared claims separate", async () => {
    setup();
    const app = gateway();
    const res = await issue(app, "client-chatgpt-1", {
      "x-mcp-client-name": "openai-mcp",
      "x-mcp-client-version": "1.2",
      "x-mcp-user-agent": "ChatGPT-User/1.0"
    });
    expect(res.statusCode).toBe(200);
    const view = await clients(app);
    expect(view.summary).toMatchObject({ total: 1, unrecognized: 1, liveUnrecognized: 1, policy: "observe" });
    expect(view.clients[0]).toMatchObject({
      clientId: "client-chatgpt-1",
      status: "unrecognized",
      suggestedKind: "chatgpt",
      lanes: ["jc"],
      subjects: ["chatgpt:jacen"],
      issued: 1,
      denied: 0,
      lastTool: "acs_read",
      live: true
    });
    expect(view.clients[0]!.claims[0]).toMatchObject({
      name: "openai-mcp",
      version: "1.2",
      userAgent: "ChatGPT-User/1.0"
    });
  });

  it("strips control characters and bounds hostile claim headers", async () => {
    setup();
    const app = gateway();
    await issue(app, "client-x", { "x-mcp-client-name": `Muse${"A".repeat(500)}` });
    const claim = (await clients(app)).clients[0]!.claims[0];
    expect(claim.name.length).toBeLessThanOrEqual(128);
    expect(sanitizeClaim("a\u0000b\u001b[31mc")).toBe("ab[31mc");
    expect(sanitizeClaim(42)).toBeUndefined();
  });

  it("records connects from the edge, throttles repeats, and enforces lane and identity", async () => {
    setup();
    const app = gateway();
    const body = {
      lane: "jc",
      clientId: "client-muse",
      subject: "chatgpt:jacen",
      method: "initialize",
      claims: { name: "Muse", version: "0.9" }
    };
    const first = await observe(app, body);
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ recorded: true });
    expect((await observe(app, body)).json()).toEqual({ recorded: false });
    expect((await observe(app, { ...body, method: "tools/list" })).json()).toEqual({ recorded: true });
    const row = (await clients(app)).clients[0]!;
    expect(row).toMatchObject({
      clientId: "client-muse",
      connects: 2,
      suggestedKind: "muse",
      lastMethod: "tools/list"
    });

    expect((await observe(app, { ...body, lane: "dc" })).statusCode).toBe(403);
    expect((await observe(app, body, DC)).statusCode).toBe(403);
    expect((await observe(app, { ...body, lane: "dc" }, DC)).statusCode).toBe(202);
    for (const token of [OP, AGENT, READER]) expect((await observe(app, body, token)).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/mcp-clients/observe", payload: body })).statusCode).toBe(401);
    expect((await observe(app, { ...body, method: "tools/call" })).statusCode).toBe(400);
    expect((await observe(app, { ...body, extra: true })).statusCode).toBe(400);
  });

  it("lets only a human operator label or clear a client the gateway has actually seen", async () => {
    setup();
    const app = gateway();
    await issue(app, "client-grok");
    const label = (token: string, payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/api/mcp-clients/label", headers: bearer(token), payload });

    expect((await label(AGENT, { clientId: "client-grok", kind: "grok", label: "Grok" })).statusCode).toBe(403);
    expect((await label(READER, { clientId: "client-grok", kind: "grok", label: "Grok" })).statusCode).toBe(403);
    expect((await label(OP, { clientId: "never-seen", kind: "grok", label: "Grok" })).statusCode).toBe(404);
    expect((await label(OP, { clientId: "client-grok", kind: "skynet", label: "Grok" })).statusCode).toBe(400);
    expect((await label(OP, { clientId: "client-grok", kind: "grok", label: "" })).statusCode).toBe(400);

    const ok = await label(OP, { clientId: "client-grok", kind: "grok", label: "Grok (xAI)", note: "jacen's account" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().client).toMatchObject({
      status: "labelled",
      label: "Grok (xAI)",
      kind: "grok",
      labelledBy: "user",
      note: "jacen's account"
    });
    expect((await clients(app)).summary).toMatchObject({ labelled: 1, unrecognized: 0 });

    const clear = (token: string) =>
      app.inject({
        method: "POST",
        url: "/api/mcp-clients/label/clear",
        headers: bearer(token),
        payload: { clientId: "client-grok" }
      });
    expect((await clear(AGENT)).statusCode).toBe(403);
    expect((await clear(OP)).statusCode).toBe(200);
    expect((await clear(OP)).statusCode).toBe(404);
    expect((await clients(app)).summary).toMatchObject({ labelled: 0, unrecognized: 1 });
  });

  it("require_label denies unlabelled clients, never grants anything, and recovers once labelled", async () => {
    setup();
    const app = gateway("require_label");
    const denied = await issue(app, "client-new");
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      decision: "deny",
      code: "mcp_client_unlabelled",
      reason: "mcp_client_unlabelled"
    });
    expect(denied.json().capability).toBeUndefined();
    expect((await clients(app)).clients[0]).toMatchObject({
      clientId: "client-new",
      denied: 1,
      issued: 0,
      status: "unrecognized"
    });
    // Connect observations are still recorded so the operator can see who to label.
    expect(
      (await observe(app, { lane: "jc", clientId: "client-new", subject: "chatgpt:jacen", method: "initialize" }))
        .statusCode
    ).toBe(202);

    await app.inject({
      method: "POST",
      url: "/api/mcp-clients/label",
      headers: bearer(OP),
      payload: { clientId: "client-new", kind: "other", label: "Test client" }
    });
    expect((await issue(app, "client-new")).statusCode).toBe(200);
    await app.inject({
      method: "POST",
      url: "/api/mcp-clients/label/clear",
      headers: bearer(OP),
      payload: { clientId: "client-new" }
    });
    expect((await issue(app, "client-new")).statusCode).toBe(403);
  });

  it("observe mode never blocks an unlabelled client", async () => {
    setup();
    const app = gateway("observe");
    expect((await issue(app, "client-unlabelled")).statusCode).toBe(200);
  });

  it("rebuilds clients, labels and counts from the audit log after a restart, and the chain stays valid", async () => {
    setup();
    const dbPath = join(root, "control.db");
    const first = gateway("observe", dbPath);
    await issue(first, "client-a");
    await issue(first, "client-a");
    await observe(first, {
      lane: "jc",
      clientId: "client-a",
      subject: "chatgpt:jacen",
      method: "initialize",
      claims: { name: "Muse" }
    });
    await first.inject({
      method: "POST",
      url: "/api/mcp-clients/label",
      headers: bearer(OP),
      payload: { clientId: "client-a", kind: "muse", label: "Muse" }
    });
    await first.close();
    open.pop();

    const second = gateway("observe", dbPath);
    const row = (await clients(second)).clients[0]!;
    expect(row).toMatchObject({ clientId: "client-a", status: "labelled", label: "Muse", issued: 2, connects: 1 });
    await second.close();
    open.pop();

    const store = new SqliteWorkItemStore(dbPath);
    try {
      expect(store.verifyAuditChain().ok).toBe(true);
      const names = store.readEvents({ limit: 500 }).map((e) => e.name);
      expect(names).toEqual(expect.arrayContaining(["mcp_client.seen", "mcp_client.labelled", "connector.requested"]));
    } finally {
      store.close();
    }
  });

  it("requires authentication to read the client list", async () => {
    setup();
    const app = gateway();
    expect((await app.inject({ method: "GET", url: "/api/mcp-clients" })).statusCode).toBe(401);
  });
});

describe("McpClientService", () => {
  const event = (
    sequence: number,
    name: string,
    body: Record<string, unknown>,
    timeMs = 1_000_000 + sequence * 1_000
  ): StoredAuditEvent =>
    ({
      sequence,
      name,
      body,
      attributes: {},
      timeUnixNano: String(timeMs * 1_000_000),
      id: `e${sequence}`
    }) as unknown as StoredAuditEvent;
  const fakeStore = { recordSystemEvent: () => undefined as never, readEvents: () => [] };

  it("groups calls recorded before client ids existed by subject, and cannot label them", () => {
    const svc = new McpClientService(fakeStore, "observe", () => 1_100_000);
    svc.ingest(
      event(1, "connector.requested", {
        source: "jc-capability-issued",
        authSubject: "chatgpt:old",
        toolName: "acs_read"
      })
    );
    svc.ingest(
      event(2, "connector.requested", { source: "jc-capability-denied", authSubject: "chatgpt:old", toolName: "x" })
    );
    expect(svc.list()).toEqual([]);
    expect(svc.legacyCallers()).toMatchObject([{ subject: "chatgpt:old", lane: "jc", issued: 1, denied: 1 }]);
  });

  it("ignores unrelated connector events and malformed identifiers", () => {
    const svc = new McpClientService(fakeStore);
    svc.ingest(event(1, "connector.requested", { source: "chatgpt-mcp", mcpClientId: "x", authSubject: "s" }));
    svc.ingest(
      event(2, "connector.requested", { source: "jc-capability-issued", mcpClientId: "has space", authSubject: "s" })
    );
    svc.ingest(event(3, "mcp_client.labelled", { clientId: "ok", kind: "nope", label: "x" }));
    expect(svc.list()).toEqual([]);
  });

  it("bounds memory by evicting the least recently seen unlabelled clients and keeping labelled ones", () => {
    const svc = new McpClientService(fakeStore);
    svc.ingest(
      event(1, "connector.requested", { source: "jc-capability-issued", mcpClientId: "keep-me", authSubject: "s" }, 1)
    );
    svc.ingest(event(2, "mcp_client.labelled", { clientId: "keep-me", kind: "other", label: "Keep", actorId: "u" }, 2));
    for (let i = 0; i < MAX_TRACKED_CLIENTS + 50; i += 1) {
      svc.ingest(
        event(
          10 + i,
          "connector.requested",
          { source: "jc-capability-issued", mcpClientId: `c${i}`, authSubject: "s" },
          100 + i
        )
      );
    }
    const list = svc.list();
    expect(list.length).toBeLessThanOrEqual(MAX_TRACKED_CLIENTS);
    expect(list.some((c) => c.clientId === "keep-me")).toBe(true);
    expect(list.some((c) => c.clientId === "c0")).toBe(false);
    expect(list.some((c) => c.clientId === `c${MAX_TRACKED_CLIENTS + 49}`)).toBe(true);
  });

  it("suggests a kind from claims only, and parses the policy fail-closed", () => {
    expect(suggestKind([{ name: "openai-mcp" }])).toBe("chatgpt");
    expect(suggestKind([{ userAgent: "Mozilla Muse/2" }])).toBe("muse");
    expect(suggestKind([{ name: "xAI Grok" }])).toBe("grok");
    expect(suggestKind([{ name: "curl" }])).toBeUndefined();
    expect(parseMcpClientPolicy({})).toBe("observe");
    expect(parseMcpClientPolicy({ ACS_MCP_CLIENT_POLICY: "require_label" })).toBe("require_label");
    expect(() => parseMcpClientPolicy({ ACS_MCP_CLIENT_POLICY: "block" })).toThrow(/observe or require_label/);
  });

  it("marks a client live only inside the window", () => {
    let now = 1_001_000;
    const svc = new McpClientService(fakeStore, "observe", () => now);
    svc.ingest(
      event(1, "connector.requested", { source: "jc-capability-issued", mcpClientId: "c", authSubject: "s" }, 1_000_000)
    );
    expect(svc.list()[0]!.live).toBe(true);
    now = 1_000_000 + 6 * 60_000;
    expect(svc.list()[0]!.live).toBe(false);
  });
});
