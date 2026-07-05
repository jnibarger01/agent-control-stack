import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGateway } from "./server.js";

const allowedOrigin = "http://127.0.0.1:3000";
const token = "m";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

describe("gateway MCP transport", () => {
  it("returns an MCP InitializeResult with tools capability", async () => {
    await withGateway(async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: jsonHeaders(),
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "vitest", version: "0.0.0" }
          }
        }
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<JsonRpcResponse>();
      expect(body).toMatchObject({ jsonrpc: "2.0", id: 1 });
      expect(body.error).toBeUndefined();
      expect(body.result).toMatchObject({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "agent-control-stack-gateway" }
      });
    });
  });

  it("accepts initialized notifications without a response body", async () => {
    await withGateway(async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: jsonHeaders(),
        payload: { jsonrpc: "2.0", method: "notifications/initialized" }
      });

      expect(response.statusCode).toBe(202);
      expect(response.body).toBe("");
    });
  });

  it("returns full tool schemas from tools/list", async () => {
    await withGateway(async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: jsonHeaders(),
        payload: { jsonrpc: "2.0", id: "tools", method: "tools/list" }
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<JsonRpcResponse>();
      const result = body.result as { tools: Array<{ name: string; description: string; inputSchema: unknown }> };
      expect(result.tools.map((tool) => tool.name)).toEqual([
        "create_work_item",
        "get_work_item",
        "list_work_items",
        "approve_work_item",
        "unblock_work_item",
        "cancel_work_item",
        "submit_work_result"
      ]);
      const createTool = result.tools.find((tool) => tool.name === "create_work_item");
      expect(createTool?.description).toContain("Create");
      expect(createTool?.inputSchema).toMatchObject({
        type: "object",
        required: ["title", "requester", "intent"],
        properties: {
          title: { type: "string" },
          requestedActions: { type: "array" },
          risk: { enum: ["low", "medium", "high", "critical"] }
        }
      });
    });
  });

  it("invokes the existing policy-aware tool path through tools/call", async () => {
    await withGateway(async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: jsonHeaders({ authorization: `Bearer ${token}` }),
        payload: {
          jsonrpc: "2.0",
          id: "call",
          method: "tools/call",
          params: {
            name: "create_work_item",
            arguments: {
              title: "MCP write approval",
              requester: "agent",
              intent: "verify MCP policy-aware path",
              target: { cwd: "/repo" },
              requestedActions: [
                { kind: "edit", description: "write source", params: { write: true, paths: ["src/index.ts"] } }
              ],
              risk: "medium"
            }
          }
        }
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<JsonRpcResponse>();
      expect(body.error).toBeUndefined();
      const result = body.result as { content: Array<{ type: "text"; text: string }>; isError?: boolean };
      expect(result.isError).toBe(false);
      const workItem = JSON.parse(result.content[0]?.text ?? "{}");
      expect(workItem.status).toBe("needs_approval");
    });
  });

  it("allows read-only tools/call without bearer token", async () => {
    await withGateway(async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: jsonHeaders(),
        payload: {
          jsonrpc: "2.0",
          id: "readonly",
          method: "tools/call",
          params: { name: "list_work_items", arguments: {} }
        }
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<JsonRpcResponse>();
      expect(body.error).toBeUndefined();
    });
  });

  it("fails closed when a mutating tools/call has no bearer token", async () => {
    await withGateway(async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: jsonHeaders(),
        payload: {
          jsonrpc: "2.0",
          id: "unauth",
          method: "tools/call",
          params: { name: "create_work_item", arguments: { title: "x", requester: "agent", intent: "x" } }
        }
      });

      expect(response.statusCode).toBe(401);
      expect(response.json<JsonRpcResponse>()).toMatchObject({
        jsonrpc: "2.0",
        id: "unauth",
        error: { code: -32001, message: "mutation requires bearer token" }
      });
    });
  });

  it("fails closed on a bad Origin", async () => {
    await withGateway(async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: jsonHeaders({ origin: "https://evil.example" }),
        payload: { jsonrpc: "2.0", id: "origin", method: "tools/list" }
      });

      expect(response.statusCode).toBe(403);
      expect(response.json<JsonRpcResponse>()).toMatchObject({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32002, message: "origin not allowed" }
      });
    });
  });

  it("returns method-not-found for unsupported JSON-RPC methods", async () => {
    await withGateway(async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: jsonHeaders(),
        payload: { jsonrpc: "2.0", id: "missing", method: "resources/list" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<JsonRpcResponse>()).toMatchObject({
        jsonrpc: "2.0",
        id: "missing",
        error: { code: -32601, message: "method not found" }
      });
    });
  });

  it("fails closed on invalid tool names", async () => {
    await withGateway(async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: jsonHeaders({ authorization: `Bearer ${token}` }),
        payload: {
          jsonrpc: "2.0",
          id: "bad-tool",
          method: "tools/call",
          params: { name: "not_a_tool", arguments: {} }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<JsonRpcResponse>()).toMatchObject({
        jsonrpc: "2.0",
        id: "bad-tool",
        error: { code: -32602, message: "invalid tool name" }
      });
    });
  });

  it("returns a controlled JSON-RPC parse error for malformed JSON", async () => {
    await withGateway(async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: jsonHeaders(),
        payload: "{"
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<JsonRpcResponse>()).toMatchObject({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "parse error" }
      });
    });
  });

  it("returns 405 for GET /mcp until SSE streaming is implemented", async () => {
    await withGateway(async ({ app }) => {
      const response = await app.inject({ method: "GET", url: "/mcp", headers: { origin: allowedOrigin } });

      expect(response.statusCode).toBe(405);
      expect(response.headers.allow).toBe("POST");
    });
  });
});

async function withGateway(run: (context: { app: ReturnType<typeof buildGateway>; dbPath: string }) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "acs-mcp-"));
  const dbPath = join(dir, "control.db");
  const previousToken = process.env.ACS_GATEWAY_TOKEN;
  const previousOrigins = process.env.ACS_MCP_ALLOWED_ORIGINS;
  process.env.ACS_GATEWAY_TOKEN = token;
  process.env.ACS_MCP_ALLOWED_ORIGINS = allowedOrigin;
  const app = buildGateway({ dbPath, logger: false });

  try {
    await run({ app, dbPath });
  } finally {
    await app.close();
    restoreEnv("ACS_GATEWAY_TOKEN", previousToken);
    restoreEnv("ACS_MCP_ALLOWED_ORIGINS", previousOrigins);
    rmSync(dir, { recursive: true, force: true });
  }
}

function jsonHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "application/json", origin: allowedOrigin, ...headers };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
