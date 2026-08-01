import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it, vi } from "vitest";
import { buildGateway } from "./server.js";

describe("MCP request and tool limits", () => {
  it("advertises the governed public MCP adapters", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-mcp-public-"));
    const app = buildGateway({
      dbPath: join(directory, "control.db"),
      logger: false,
      auth: { token: "t", actor: "user" },
      mcpAuth: { localBearerToken: "t" }
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: "Bearer t" },
        payload: { jsonrpc: "2.0", id: "tools", method: "tools/list" }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual(
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
      const memory = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: "Bearer t" },
        payload: {
          jsonrpc: "2.0",
          id: "memory",
          method: "tools/call",
          params: { name: "memory.search", arguments: { query: "nothing" } }
        }
      });
      expect(memory.statusCode).toBe(200);
      expect(memory.json().result.structuredContent.memories).toEqual([]);
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects oversized MCP requests at the HTTP boundary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-mcp-limits-"));
    const app = buildGateway({ dbPath: join(directory, "control.db"), logger: false, auth: { token: "t", actor: "user" } });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: "Bearer t" },
        payload: { jsonrpc: "2.0", id: "large", method: "ping", params: { padding: "x".repeat(300_000) } }
      });
      expect(response.statusCode).toBe(413);
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns a bounded failure when a tool exceeds the execution timeout", async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), "acs-mcp-timeout-"));
    const seed = new SqliteWorkItemStore(join(directory, "control.db"));
    seed.registerActor({ id: "user", actorType: "HUMAN", displayName: "user", externalRef: "local_bearer:local-dev" });
    seed.close();
    const app = buildGateway({
      dbPath: join(directory, "control.db"),
      logger: false,
      auth: { token: "t", actor: "user" },
      mcpAuth: { localBearerToken: "t" },
      directAgentController: { callTool: async () => new Promise(() => undefined) },
      enableTestAgentRunForLocalDevelopment: true
    });
    try {
      const responsePromise = app.inject({
        method: "POST",
        url: "/mcp",
        remoteAddress: "127.0.0.1",
        headers: { authorization: "Bearer t" },
        payload: {
          jsonrpc: "2.0",
          id: "timeout",
          method: "tools/call",
          params: { name: "test.agent.run", arguments: { agent: "codex", prompt: "test" } }
        }
      });
      await vi.advanceTimersByTimeAsync(30_000);
      const response = await responsePromise;
      expect(response.statusCode).toBe(409);
      expect(response.json().error.message).toContain("time limit");
    } finally {
      vi.useRealTimers();
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
