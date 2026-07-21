import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { buildGateway } from "./server.js";

describe("ACS connector MCP exposure", () => {
  it("publishes and routes registered command preview through the live gateway MCP handler", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-connector-mcp-"));
    const dbPath = join(dir, "control.db");
    const seed = new SqliteWorkItemStore(dbPath);
    seed.registerActor({ id: "user", actorType: "HUMAN", displayName: "User", externalRef: "local_bearer:local-dev" });
    seed.close();
    const app = buildGateway({
      dbPath,
      logger: false,
      auth: { token: "gateway", actor: "user", actorId: "user" },
      mcpAuth: { localBearerToken: "mcp-token" }
    });

    try {
      const headers = { authorization: "Bearer mcp-token" };
      const listed = await app.inject({ method: "POST", url: "/mcp", headers, payload: { jsonrpc: "2.0", id: "list", method: "tools/list" } });
      const names = listed.json().result.tools.map((tool: { name: string }) => tool.name);
      expect(names).toEqual(expect.arrayContaining(["command.preview", "filesystem.read_text", "agent.run", "result.get", "service.restart", "config.change"]));

      const called = await app.inject({
        method: "POST",
        url: "/mcp",
        headers,
        payload: {
          jsonrpc: "2.0",
          id: "preview",
          method: "tools/call",
          params: { name: "command.preview", arguments: { commandId: "os.metadata" } }
        }
      });

      expect(called.statusCode).toBe(200);
      expect(called.json().result.structuredContent.workItem.requestedActions[0].params).toMatchObject({
        commandId: "os.metadata",
        registryActionId: "acs.command.preview",
        registryVersion: "1.0"
      });

      const retrieved = await app.inject({
        method: "POST",
        url: "/mcp",
        headers,
        payload: {
          jsonrpc: "2.0",
          id: "get",
          method: "tools/call",
          params: {
            name: "work_item.get",
            arguments: { id: called.json().result.structuredContent.workItem.id }
          }
        }
      });

      expect(retrieved.statusCode).toBe(200);
      expect(retrieved.json().result.structuredContent.workItem.id).toBe(called.json().result.structuredContent.workItem.id);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
