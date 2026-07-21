import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { remoteMcpToolNames } from "./mcp.js";
import { buildGateway } from "./server.js";

const expectedRemoteMcpToolNames = [
  "create_work_item",
  "get_work_item",
  "list_work_items",
  "unblock_work_item",
  "reject_work_item",
  "cancel_work_item",
  "work_item.create",
  "work_item.get",
  "work_item.approve",
  "work_item.reject",
  "work_item.cancel",
  "work_item.unblock",
  "command.preview",
  "command.run",
  "filesystem.read_text",
  "filesystem.stat",
  "agent.preview",
  "agent.run",
  "result.get",
  "evidence.list",
  "evidence.get",
  "service.restart.preview",
  "service.restart",
  "config.change.preview",
  "config.change",
  "create_directory",
  "edit_block",
  "force_terminate",
  "get_config",
  "get_file_info",
  "get_more_search_results",
  "get_prompts",
  "get_recent_tool_calls",
  "get_usage_stats",
  "give_feedback_to_desktop_commander",
  "interact_with_process",
  "kill_process",
  "list_devices",
  "list_directory",
  "list_processes",
  "list_searches",
  "list_sessions",
  "move_file",
  "ping",
  "read_file",
  "read_multiple_files",
  "read_process_output",
  "set_config_value",
  "shutdown",
  "start_process",
  "start_search",
  "stop_search",
  "who_am_i",
  "write_file",
  "write_pdf"
] as const;

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
      const listed = await app.inject({
        method: "POST",
        url: "/mcp",
        headers,
        payload: { jsonrpc: "2.0", id: "list", method: "tools/list" }
      });
      const names = listed.json().result.tools.map((tool: { name: string }) => tool.name);
      expect(remoteMcpToolNames).toEqual(expectedRemoteMcpToolNames);
      expect(names).toEqual(expectedRemoteMcpToolNames);
      expect(names).toHaveLength(55);
      expect(new Set(names)).toHaveLength(55);
      expect(names).toEqual(
        expect.arrayContaining([
          "command.preview",
          "filesystem.read_text",
          "agent.run",
          "result.get",
          "service.restart",
          "config.change",
          "create_directory",
          "read_file",
          "write_file",
          "start_process",
          "get_config",
          "who_am_i"
        ])
      );

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
      expect(retrieved.json().result.structuredContent.workItem.id).toBe(
        called.json().result.structuredContent.workItem.id
      );
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publishes valid schemas for every remote tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-connector-mcp-schema-"));
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
      const listed = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: "Bearer mcp-token" },
        payload: { jsonrpc: "2.0", id: "list", method: "tools/list" }
      });
      const tools = listed.json().result.tools as Array<{
        name: string;
        description: string;
        inputSchema: { type: string; properties?: Record<string, unknown>; required?: string[] };
      }>;

      expect(tools).toHaveLength(55);
      for (const tool of tools) {
        expect(tool.name).toMatch(/^[A-Za-z0-9_./-]{1,64}$/u);
        expect(tool.description.length).toBeGreaterThan(0);
        expect(tool.description.length).toBeLessThanOrEqual(2_000);
        expect(tool.inputSchema.type).toBe("object");
        assertSchemaNode(tool.inputSchema, tool.name);
        for (const required of tool.inputSchema.required ?? []) {
          expect(tool.inputSchema.properties ?? {}).toHaveProperty(required);
        }
      }
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function assertSchemaNode(value: unknown, path: string): void {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  if (!value || typeof value !== "object" || Array.isArray(value)) return;

  const node = value as Record<string, unknown>;
  const hasSchemaKeyword =
    typeof node.type === "string" ||
    "$ref" in node ||
    "const" in node ||
    "enum" in node ||
    ["anyOf", "oneOf", "allOf"].some((key) => key in node);
  expect(hasSchemaKeyword, `${path} must declare a JSON Schema keyword`).toBe(true);

  if (node.type === "array") {
    expect(node.items, `${path} array schema must declare items`).toBeDefined();
    assertSchemaNode(node.items, `${path}.items`);
  }
  if (node.properties && typeof node.properties === "object" && !Array.isArray(node.properties)) {
    for (const [key, property] of Object.entries(node.properties as Record<string, unknown>)) {
      assertSchemaNode(property, `${path}.properties.${key}`);
    }
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const alternatives = node[key];
    if (Array.isArray(alternatives)) {
      alternatives.forEach((alternative, index) => assertSchemaNode(alternative, `${path}.${key}[${index}]`));
    }
  }
}
