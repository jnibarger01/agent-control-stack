import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
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
    const app = buildGateway({ dbPath, logger: false, auth: testAuth });
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
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${oauth.token({ scope: "acs:work:create" })}` },
        payload: createWorkItemToolCall("oauth-valid")
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().result.structuredContent.title).toBe("oauth-valid");

      await app.close();
      appClosed = true;
      const store = new SqliteWorkItemStore(dbPath);
      try {
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

  it("fails closed for missing OAuth bearer JWT on tools/call", async () => {
    const oauth = createTestOAuth();
    const result = await injectRejectedOAuthToolCall({
      oauth,
      headers: {}
    });

    expect(result.response.statusCode).toBe(401);
    expect(result.response.headers["www-authenticate"]).toContain("/.well-known/oauth-protected-resource/mcp");
    expect(authChallenge(result.response.json())).toContain("error=\"invalid_token\"");
    expect(authChallenge(result.response.json())).toContain("error_description=\"missing MCP bearer token\"");
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

  it("fails closed for tampered OAuth bearer JWT signatures on tools/call", async () => {
    const oauth = createTestOAuth();
    const [header, _claims, signature] = oauth.token({ scope: "acs:work:create" }).split(".");
    const tampered = `${header}.${base64UrlJson({
      iss: oauthIssuer,
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
    expect(result.response.headers["www-authenticate"]).toContain("error=\"insufficient_scope\"");
    expect(authChallenge(result.response.json())).toContain("error=\"insufficient_scope\"");
    expect(result.response.json().result.structuredContent).toMatchObject({
      authError: "insufficient_scope",
      requiredScopes: ["acs:work:create"]
    });
    expect(result.workItems).toEqual([]);
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

function createTestOAuth() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "test-key";
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" };
  const nowSeconds = Math.floor(Date.now() / 1000);
  const options = {
    issuer: oauthIssuer,
    resource: oauthResource,
    jwks: { keys: [jwk] },
    authorizationServers: [oauthIssuer]
  };

  function token(overrides: Record<string, unknown> = {}): string {
    const header = { alg: "RS256", typ: "JWT", kid };
    const claims = {
      iss: oauthIssuer,
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
      payload: createWorkItemToolCall("rejected")
    });

    await app.close();
    appClosed = true;
    const store = new SqliteWorkItemStore(dbPath);
    try {
      return { response, workItems: store.list() };
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
