import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { buildGateway } from "./server.js";

const auth = { token: "test-token", actor: "user" };
const authHeaders = { authorization: `Bearer ${auth.token}` };

describe("gateway work-item routes", () => {
  it("returns 400 for malformed list filters", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false });

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
    const app = buildGateway({ dbPath, logger: false, auth });
    let appClosed = false;

    try {
      const created = await app.inject({
        method: "POST",
        url: "/work-items",
        headers: authHeaders,
        payload: {
          title: "Write work",
          requester: "user",
          intent: "verify approval path",
          target: { cwd: "/repo" },
          requestedActions: [
            { kind: "edit", description: "write file", params: { write: true, paths: ["src/index.ts"] } }
          ],
          risk: "medium"
        }
      });
      const workItem = created.json();

      expect(workItem.status).toBe("needs_approval");

      const approved = await app.inject({
        method: "POST",
        url: `/work-items/${workItem.id}/approve`,
        headers: authHeaders,
        payload: { reason: "approve exact write" }
      });

      expect(approved.statusCode).toBe(200);
      expect(approved.json().workItem.status).toBe("approved");
      expect(approved.json().decision.decision).toBe("require_approval");

      await app.close();
      appClosed = true;
      const store = new SqliteWorkItemStore(dbPath);
      try {
        const approvals = store.readEvents().filter((event) => event.name === "approval.recorded");
        expect(approvals).toHaveLength(1);
        expect(approvals[0]?.body).toMatchObject({ workItemId: workItem.id });
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
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false, auth });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/work-items",
        headers: authHeaders,
        payload: {
          title: "Denied work",
          requester: "user",
          intent: "verify deny path",
          requestedActions: [{ kind: "command", description: "sudo", params: { command: ["sudo", "whoami"] } }],
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

  it("does not mutate state when approval policy denies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-"));
    const dbPath = join(dir, "control.db");
    const setup = new SqliteWorkItemStore(dbPath);
    const workItem = setup.create({
      title: "Pending manual work",
      requester: "user",
      intent: "deny approval without blocking",
      requestedActions: [{ kind: "manual", description: "ambiguous" }],
      risk: "low"
    });
    setup.close();
    const app = buildGateway({ dbPath, logger: false, auth });

    try {
      const denied = await app.inject({
        method: "POST",
        url: `/work-items/${workItem.id}/approve`,
        headers: authHeaders,
        payload: {}
      });

      expect(denied.statusCode).toBe(403);
      expect(denied.json().workItem.status).toBe("pending_policy");
      const check = new SqliteWorkItemStore(dbPath);
      try {
        expect(check.get(workItem.id)?.status).toBe("pending_policy");
      } finally {
        check.close();
      }
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unblocks blocked work", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false, auth });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/work-items",
        headers: authHeaders,
        payload: {
          title: "Denied work",
          requester: "user",
          intent: "verify unblock",
          requestedActions: [{ kind: "command", description: "sudo", params: { command: ["sudo", "whoami"] } }],
          risk: "low"
        }
      });

      const unblocked = await app.inject({
        method: "POST",
        url: `/work-items/${created.json().id}/unblock`,
        headers: authHeaders
      });

      expect(unblocked.statusCode).toBe(200);
      expect(unblocked.json().workItem.status).toBe("pending_policy");
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("MCP transport", () => {
  it("initializes with tools capability", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-mcp-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: { capabilities: { tools: {} }, serverInfo: { name: "agent-control-stack-gateway" } }
      });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts initialized notification without a body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-mcp-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        payload: { jsonrpc: "2.0", method: "notifications/initialized" }
      });

      expect(response.statusCode).toBe(202);
      expect(response.body).toBe("");
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists tools with JSON schemas", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-mcp-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        payload: { jsonrpc: "2.0", id: "tools", method: "tools/list" }
      });
      const createTool = response.json().result.tools.find((tool: { name: string }) => tool.name === "create_work_item");

      expect(response.statusCode).toBe(200);
      expect(createTool).toMatchObject({
        name: "create_work_item",
        inputSchema: { type: "object", properties: { requestedActions: { type: "array" } } }
      });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("calls the existing policy-aware tool path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-mcp-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false, auth });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: authHeaders,
        payload: {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "create_work_item",
            arguments: {
              title: "Inspect source",
              intent: "verify MCP call path",
              target: { cwd: "/repo" },
              requestedActions: [{ kind: "read", description: "read source", params: { paths: ["src/index.ts"] } }],
              risk: "low"
            }
          }
        }
      });
      const text = response.json().result.content[0].text;

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(text)).toMatchObject({ requester: "user", status: "approved" });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on mutating tool calls without bearer auth", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-mcp-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false, auth });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        payload: {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "create_work_item", arguments: { title: "x", intent: "y" } }
        }
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: -32001, message: "unauthorized" } });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects bad Origin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-mcp-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { origin: "https://evil.example" },
        payload: { jsonrpc: "2.0", id: 4, method: "initialize" }
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "forbidden origin" });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns method-not-found for unsupported methods", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-mcp-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        payload: { jsonrpc: "2.0", id: 5, method: "missing/method" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ error: { code: -32601, message: "method not found" } });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns controlled errors for malformed requests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-mcp-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        payload: { jsonrpc: "2.0", id: 6 }
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: -32600, message: "invalid request" } });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 405 for GET /mcp", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-mcp-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false });

    try {
      const response = await app.inject({ method: "GET", url: "/mcp" });

      expect(response.statusCode).toBe(405);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
