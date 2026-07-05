import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGateway } from "./server.js";

const auth = { token: "t", actor: "user" };

describe("gateway MCP edge hardening", () => {
  it("returns 405 with Allow POST for GET /mcp", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-mcp-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false, auth });

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

  it("rejects disallowed MCP origins when an origin allowlist is configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-mcp-"));
    const app = buildGateway({
      dbPath: join(dir, "control.db"),
      logger: false,
      auth,
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
        headers: { origin: "https://allowed.example" },
        payload: { jsonrpc: "2.0", id: "origin", method: "initialize" }
      });

      expect(allowed.statusCode).toBe(200);
      expect(allowed.json().id).toBe("origin");
    } finally {
      await app.close();
    }
  });
});
