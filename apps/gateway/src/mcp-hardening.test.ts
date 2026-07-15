import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGateway } from "./server.js";

const auth = { token: "t", actor: "user" };

describe("gateway MCP edge hardening", () => {
  it("returns 405 with Allow POST for GET /mcp", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-mcp-"));
    const app = buildGateway({
      dbPath: join(dir, "control.db"),
      logger: false,
      auth,
      mcpAuth: { localBearerToken: "mcp-token" }
    });

    try {
      const response = await app.inject({ method: "GET", url: "/mcp" });

      expect(response.statusCode).toBe(405);
      expect(response.headers.allow).toBe("POST");
      expect(response.json()).toMatchObject({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: "method not allowed" }
      });
    } finally {
      await app.close();
    }
  });

  it("returns JSON-RPC parse errors for malformed JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-mcp-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false, auth });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { "content-type": "application/json" },
        payload: '{"jsonrpc":"2.0",'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "parse error" }
      });
    } finally {
      await app.close();
    }
  });

  it("preserves default malformed JSON handling on non-MCP routes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-mcp-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false, auth });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/session/login",
        headers: { "content-type": "application/json" },
        payload: '{"token":'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).not.toHaveProperty("jsonrpc");
      expect(response.json()).toMatchObject({ code: "FST_ERR_CTP_INVALID_JSON_BODY" });
    } finally {
      await app.close();
    }
  });

  it("returns 202 with no body for accepted MCP notifications", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-mcp-"));
    const app = buildGateway({
      dbPath: join(dir, "control.db"),
      logger: false,
      auth,
      mcpAuth: { localBearerToken: "mcp-token" }
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: "Bearer mcp-token" },
        payload: { jsonrpc: "2.0", method: "notifications/initialized" }
      });

      expect(response.statusCode).toBe(202);
      expect(response.body).toBe("");
      expect(response.headers["content-type"]).toBeUndefined();
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wraps array tool results in object-shaped structured content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-mcp-"));
    const app = buildGateway({
      dbPath: join(dir, "control.db"),
      logger: false,
      auth,
      mcpAuth: { localBearerToken: "mcp-token" }
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: "Bearer mcp-token" },
        payload: {
          jsonrpc: "2.0",
          id: "list",
          method: "tools/call",
          params: { name: "list_work_items", arguments: {} }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().result.structuredContent).toEqual({ result: [] });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects browser origins by default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-mcp-"));
    const app = buildGateway({
      dbPath: join(dir, "control.db"),
      logger: false,
      auth,
      mcpAuth: { localBearerToken: "mcp-token" }
    });

    try {
      const blocked = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { origin: "https://blocked.example" },
        payload: { jsonrpc: "2.0", id: "origin", method: "initialize" }
      });
      const nonBrowser = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: "Bearer mcp-token" },
        payload: { jsonrpc: "2.0", id: "no-origin", method: "initialize" }
      });

      expect(blocked.statusCode).toBe(403);
      expect(blocked.json()).toMatchObject({ error: { code: -32002, message: "forbidden origin" } });
      expect(nonBrowser.statusCode).toBe(200);
      expect(nonBrowser.json().id).toBe("no-origin");
    } finally {
      await app.close();
    }
  });

  it("rejects disallowed MCP origins when an origin allowlist is configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-mcp-"));
    const app = buildGateway({
      dbPath: join(dir, "control.db"),
      logger: false,
      auth,
      mcpAuth: { localBearerToken: "mcp-token" },
      mcpAllowedOrigins: ["https://allowed.example"]
    });

    try {
      const blocked = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { origin: "https://blocked.example" },
        payload: { jsonrpc: "2.0", id: "origin", method: "initialize" }
      });

      expect(blocked.statusCode).toBe(403);
      expect(blocked.json()).toMatchObject({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32002, message: "forbidden origin" }
      });

      const allowed = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { origin: "https://allowed.example", authorization: "Bearer mcp-token" },
        payload: { jsonrpc: "2.0", id: "origin", method: "initialize" }
      });

      expect(allowed.statusCode).toBe(200);
      expect(allowed.json().id).toBe("origin");
    } finally {
      await app.close();
    }
  });
});
