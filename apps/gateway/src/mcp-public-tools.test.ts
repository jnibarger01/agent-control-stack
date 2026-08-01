import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGateway } from "./server.js";

describe("public MCP tool contract", () => {
  it("advertises the governed public tool names", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-mcp-public-"));
    const app = buildGateway({
      dbPath: join(directory, "control.db"),
      logger: false,
      auth: { token: "dashboard", actor: "user" },
      mcpAuth: { localBearerToken: "mcp-token" }
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: "Bearer mcp-token" },
        payload: { jsonrpc: "2.0", id: "tools", method: "tools/list" }
      });
      expect(response.statusCode).toBe(200);
      const names = response.json().result.tools.map((tool: { name: string }) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "work_item.create",
          "work_item.list",
          "work_item.get",
          "work_item.approve",
          "tool.execute_approved",
          "audit.query",
          "memory.search",
          "eval.run"
        ])
      );
      expect(names).not.toEqual(
        expect.arrayContaining(["shell.run", "fs.read", "fs.write", "process.kill", "service.restart", "plugin.execute"])
      );
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("serves audit and memory reads through the authenticated public adapters", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-mcp-public-read-"));
    const app = buildGateway({
      dbPath: join(directory, "control.db"),
      logger: false,
      auth: { token: "dashboard", actor: "user" },
      mcpAuth: { localBearerToken: "mcp-token" }
    });
    try {
      for (const [id, name, argumentsValue] of [
        ["audit", "audit.query", { limit: 10 }],
        ["memory", "memory.search", { query: "loopback", limit: 10 }],
        ["eval", "eval.run", {}]
      ] as const) {
        const response = await app.inject({
          method: "POST",
          url: "/mcp",
          headers: { authorization: "Bearer mcp-token" },
          payload: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: argumentsValue } }
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().result.structuredContent).toBeDefined();
      }
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
