import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { createTunnelSignaturePayload, resolveMcpAuthOptions } from "./auth.js";
import { buildGateway } from "./server.js";

const testAuth = { token: "t", actor: "user" };
const oauthIssuer = "https://auth.example.test";
const oauthResource = "https://acs.example.test/mcp";

function buildTestGateway(options: Parameters<typeof buildGateway>[0]) {
  const app = buildGateway({ ...options, auth: testAuth });
  app.addHook("onRequest", async (request) => {
    request.headers.authorization ??= `Bearer ${testAuth.token}`;
  });
  return app;
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
        payload: { title: "Inspect route", intent: "verify mission control", target: { services: ["chatgpt-prod"] }, risk: "high" }
      });
      const workItemId = created.json().id;

      const page = await app.inject({ method: "GET", url: "/" });
      const agents = await app.inject({ method: "GET", url: "/agents" });
      const detail = await app.inject({ method: "GET", url: `/work-items/${workItemId}` });

      expect(page.statusCode).toBe(200);
      expect(page.body).toContain("AgentOS Mission Control");
      expect(page.body).toContain("Inspect route");
      expect(agents.json().agents).toEqual(expect.arrayContaining([expect.objectContaining({ id: "chatgpt-prod" })]));
      expect(detail.json().events.map((event: { name: string }) => event.name)).toContain("work_item.created");
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gateway MCP transport", () => {
  it("returns an MCP initialization response", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false, auth: testAuth });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
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
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false, auth: testAuth });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
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
            securitySchemes: [{ type: "oauth2", scopes: ["acs:work:create"] }],
            _meta: {
              securitySchemes: [{ type: "oauth2", scopes: ["acs:work:create"] }]
            }
          }),
          expect.objectContaining({
            name: "approve_work_item",
            description: expect.any(String),
            inputSchema: expect.objectContaining({ type: "object" }),
            securitySchemes: [{ type: "oauth2", scopes: ["acs:work:approve"] }]
          })
        ])
      );
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes tools/call through governed work-item creation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-"));
    const dbPath = join(dir, "control.db");
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
              requestedActions: [
                { kind: "fs.write", description: "write file", params: { paths: ["src/index.ts"] } }
              ],
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
        scopes_supported: ["acs:work:create", "acs:work:read", "acs:work:approve", "acs:worker:claim"],
        bearer_methods_supported: ["header"]
      });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a valid OAuth bearer JWT for tools/call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-oauth-"));
    const dbPath = join(dir, "control.db");
    const oauth = createTestOAuth();
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

  it("keeps local ACS_MCP_BEARER_TOKEN-style fallback for tools/call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-local-mcp-"));
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
        payload: createWorkItemToolCall("local-fallback")
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().result.structuredContent.title).toBe("local-fallback");
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publishes OAuth protected resource metadata without OAuth configuration", async () => {
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

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        resource: "http://127.0.0.1:3000/mcp",
        resource_name: "Agent Control Stack MCP Gateway",
        authorization_servers: [],
        scopes_supported: ["acs:work:create", "acs:work:read", "acs:work:approve", "acs:worker:claim"],
        bearer_methods_supported: ["header"]
      });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a trusted tunnel proxy identity for scoped MCP tools/call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-tunnel-"));
    const dbPath = join(dir, "control.db");
    const app = buildGateway({
      dbPath,
      logger: false,
      mcpAuth: {
        tunnel: {
          trustedProxies: ["127.0.0.1"],
          connectors: [
            { id: "chatgpt-prod", tunnelId: "tunnel_abc123", scopes: ["acs:work:create", "acs:work:read"] }
          ]
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

  it("rejects tunnel identity headers from untrusted remote addresses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-tunnel-"));
    const dbPath = join(dir, "control.db");
    const app = buildGateway({
      dbPath,
      logger: false,
      mcpAuth: {
        tunnel: {
          trustedProxies: ["127.0.0.1"],
          connectors: [
            { id: "chatgpt-prod", tunnelId: "tunnel_abc123", scopes: ["acs:work:create", "acs:work:read"] }
          ]
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
          connectors: [
            { id: "chatgpt-prod", tunnelId: "tunnel_abc123", scopes: ["acs:work:create", "acs:work:read"] }
          ]
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

  it("accepts a signed persistent tunnel session and audits connector to tunnel to work item", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-tunnel-"));
    const dbPath = join(dir, "control.db");
    const tunnel = seedSignedTunnelSession(dbPath, {
      connectorId: "chatgpt-prod",
      tunnelId: "tunnel_abc123",
      sessionId: "session_1",
      scopes: ["acs:work:create", "acs:work:read"]
    });
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

  it("keeps initialize and tools/list available without OAuth bearer auth", async () => {
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

      expect(initialized.statusCode).toBe(200);
      expect(tools.statusCode).toBe(200);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps ping and notifications public without OAuth bearer auth", async () => {
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

      expect(ping.statusCode).toBe(200);
      expect(notification.statusCode).toBe(200);
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
      "Bearer resource_metadata=\"http://localhost:80/.well-known/oauth-protected-resource/mcp\", error=\"invalid_token\", error_description=\"missing bearer token\", scope=\"acs:work:create\""
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
    expect(authChallenge(result.response.json())).toContain("error=\"invalid_token\"");
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
    expect(authChallenge(result.response.json())).toContain("error=\"invalid_token\"");
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
    expect(authChallenge(result.response.json())).toContain("error=\"invalid_token\"");
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
    expect(authChallenge(result.response.json())).toContain("error=\"invalid_token\"");
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
    expect(authChallenge(result.response.json())).toContain("error=\"invalid_token\"");
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
      "Bearer resource_metadata=\"http://localhost:80/.well-known/oauth-protected-resource/mcp\", error=\"insufficient_scope\", error_description=\"insufficient scope\", scope=\"acs:work:create\""
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
      connectors: [
        { id: "chatgpt-prod", tunnelId: "tunnel_abc123", scopes: ["acs:work:create", "acs:work:read"] }
      ]
    });
  });
});

describe("gateway work-item routes", () => {
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
          requestedActions: [
            { kind: "fs.write", description: "write file", params: { paths: ["src/index.ts"] } }
          ],
          risk: "medium"
        }
      });
      const workItem = created.json();

      expect(workItem.status).toBe("needs_approval");

      const approved = await app.inject({
        method: "POST",
        url: `/work-items/${workItem.id}/approve`,
        payload: { approvedBy: "test", reason: "approve exact write" }
      });

      expect(approved.statusCode).toBe(200);
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
        payload: { id: second.json().id, approvedBy: "test", reason: "path id must win" }
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
        payload: { approvedBy: "not-the-agent", reason: "body identity must not matter" }
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
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false, auth: { token, actor: "agent" } });
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
        payload: { approvedBy: "ignored", reason: "self approval must not pass" }
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
        reason: "self approve"
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
    store.registerConnector({
      id: input.connectorId,
      publicKeyPem: String(publicKey.export({ type: "spki", format: "pem" })),
      allowedScopes: input.scopes,
      now: input.now
    });
    store.registerTunnelSession({
      connectorId: input.connectorId,
      tunnelId: input.tunnelId,
      sessionId: input.sessionId,
      expiresAt: input.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
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

function authChallenge(body: { result: { _meta: { "mcp/www_authenticate": string[] } } }): string {
  return body.result._meta["mcp/www_authenticate"][0];
}
