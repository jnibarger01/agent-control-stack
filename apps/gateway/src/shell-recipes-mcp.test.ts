import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMcpHttpRequest } from "./mcp.js";

const directories: string[] = [];
const token = "recipe-test-token";
const recipe = {
  id: "restart-worker",
  description: "Restart the ACS worker",
  command: "systemctl",
  args: ["restart", "acs-worker.service"],
  cwd: "/workspace/agent-control-stack",
  timeout_ms: 30000
};

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "acs-shell-recipe-mcp-"));
  directories.push(directory);
  const store = new SqliteWorkItemStore(join(directory, "control.db"));
  return { store, tools: createWorkItemTools(store, createPolicyEngine()) };
}

async function call(
  fx: ReturnType<typeof fixture>,
  name: string,
  args: unknown,
  extra: Partial<Parameters<typeof handleMcpHttpRequest>[0]> = {}
) {
  return handleMcpHttpRequest({
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    headers: { authorization: `Bearer ${token}` },
    tools: fx.tools,
    store: fx.store,
    auth: { localBearerToken: token },
    resolveActorId: () => "actor_recipe",
    ...extra
  });
}

describe("shell recipe MCP tools", () => {
  it("previews without persistence, then requests exactly one approval-gated work item", async () => {
    vi.stubEnv("ACS_SHELL_RECIPES_JSON", JSON.stringify([recipe]));
    const fx = fixture();
    try {
      const preview = await call(fx, "shell.recipe_preview", { id: recipe.id });
      expect(preview.statusCode).toBe(200);
      expect(fx.store.list()).toEqual([]);
      const previewBody = preview.body as {
        result: { structuredContent: { workItem: Record<string, unknown>; policy: { outcome: string } } };
      };
      expect(previewBody.result.structuredContent.policy.outcome).toBe("needs_approval");
      expect(previewBody.result.structuredContent.workItem).toMatchObject({
        requester: "agent",
        requesterSubject: "local-dev"
      });

      const requested = await call(fx, "shell.recipe_request", { id: recipe.id, reason: "restore service" });
      expect(requested.statusCode).toBe(200);
      const rows = fx.store.list();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        requester: "agent",
        requesterSubject: "actor_recipe",
        status: "needs_approval",
        requestedActions: [
          {
            kind: "shell",
            params: {
              recipeId: recipe.id,
              command: ["systemctl", "restart", "acs-worker.service"],
              tool: "start_process",
              arguments: {
                command: "systemctl restart acs-worker.service",
                cwd: recipe.cwd,
                timeout_ms: 30000
              }
            }
          }
        ]
      });
    } finally {
      fx.store.close();
    }
  });

  it("rejects command/cwd/requester smuggling and preserves the MCP self-approval ban", async () => {
    vi.stubEnv("ACS_SHELL_RECIPES_JSON", JSON.stringify([recipe]));
    const fx = fixture();
    try {
      const smuggled = await call(fx, "shell.recipe_request", {
        id: recipe.id,
        command: "rm",
        cwd: "/tmp",
        requester: "user"
      });
      expect(smuggled.statusCode).toBe(400);
      expect(fx.store.list()).toEqual([]);

      const approval = await call(fx, "approve_work_item", {
        id: "wrk_any",
        actionHash: "a".repeat(64),
        reason: "self approve"
      });
      expect(approval.statusCode).toBe(403);
      expect(approval.body).toMatchObject({ error: { code: -32002 } });
    } finally {
      fx.store.close();
    }
  });

  it("applies the existing per-identity allowlist and shutdown gate to recipe_request", async () => {
    vi.stubEnv("ACS_SHELL_RECIPES_JSON", JSON.stringify([recipe]));
    const fx = fixture();
    try {
      const denied = await call(fx, "shell.recipe_request", { id: recipe.id }, {
        toolAllowlist: {
          entries: new Map([["local-dev", new Set(["shell.recipe_list"])]]),
          defaultDenyUnknown: true,
          mode: "production"
        }
      });
      expect(denied.statusCode).toBe(403);
      expect(fx.store.list()).toEqual([]);

      const shutdown = await call(fx, "shell.recipe_request", { id: recipe.id }, {
        shutdownController: {
          isShuttingDown: () => true,
          assertAcceptingMutatingIntake: () => {
            throw new Error("gateway is shutting down");
          }
        } as never
      });
      expect(shutdown.statusCode).toBe(503);
      expect(fx.store.list()).toEqual([]);
    } finally {
      fx.store.close();
    }
  });
});