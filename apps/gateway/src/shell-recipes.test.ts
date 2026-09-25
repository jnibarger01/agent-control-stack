import { describe, expect, it } from "vitest";
import { createPolicyEngine, previewWorkItemPolicy } from "@agent-control-stack/policy-gate";
import {
  listShellRecipes,
  parseShellRecipesJson,
  shellRecipePreviewInputSchema,
  shellRecipeRequestInputSchema,
  shellRecipeWorkItemInput
} from "./shell-recipes.js";

const recipeJson = JSON.stringify([
  {
    id: "restart-worker",
    description: "Restart the ACS worker",
    command: "systemctl",
    args: ["restart", "acs-worker.service"],
    cwd: "/workspace/agent-control-stack",
    timeout_ms: 30000
  }
]);

describe("shell recipe configuration", () => {
  it("defaults to an empty registry", () => {
    expect(parseShellRecipesJson(undefined).size).toBe(0);
    expect(parseShellRecipesJson("").size).toBe(0);
  });

  it("rejects malformed config, duplicate ids, command paths, wrappers, and non-literal argv", () => {
    expect(() => parseShellRecipesJson("{")).toThrow("ACS_SHELL_RECIPES_JSON must be valid JSON");
    expect(() => parseShellRecipesJson(JSON.stringify({ id: "x" }))).toThrow("must be a JSON array");
    expect(() => parseShellRecipesJson(JSON.stringify([
      { id: "dup", description: "one", command: "git", args: ["status"], cwd: "/repo" },
      { id: "dup", description: "two", command: "git", args: ["log"], cwd: "/repo" }
    ]))).toThrow("duplicate shell recipe id");
    expect(() => parseShellRecipesJson(JSON.stringify([
      { id: "path", description: "bad", command: "/usr/bin/git", args: ["status"], cwd: "/repo" }
    ]))).toThrow("command");
    expect(() => parseShellRecipesJson(JSON.stringify([
      { id: "shell", description: "bad", command: "bash", args: ["-c"], cwd: "/repo" }
    ]))).toThrow("command is not allowed");
    expect(() => parseShellRecipesJson(JSON.stringify([
      { id: "meta", description: "bad", command: "git", args: ["status;id"], cwd: "/repo" }
    ]))).toThrow("single literal tokens");
  });

  it("lists metadata only and binds the exact configured invocation into one governed action", () => {
    const registry = parseShellRecipesJson(recipeJson);
    expect(listShellRecipes(registry)).toEqual({
      recipes: [{ id: "restart-worker", description: "Restart the ACS worker" }]
    });

    const recipe = registry.get("restart-worker");
    if (!recipe) throw new Error("missing recipe");
    const workItem = shellRecipeWorkItemInput(recipe, "actor_jace", "recover relay");
    expect(workItem).toMatchObject({
      requester: "agent",
      requesterSubject: "actor_jace",
      target: { cwd: "/workspace/agent-control-stack" },
      risk: "high",
      requestedActions: [
        {
          kind: "shell",
          params: {
            recipeId: "restart-worker",
            command: ["systemctl", "restart", "acs-worker.service"],
            write: true,
            tool: "start_process",
            arguments: {
              command: "systemctl restart acs-worker.service",
              cwd: "/workspace/agent-control-stack",
              timeout_ms: 30000
            }
          }
        }
      ]
    });
    expect(workItem.requestedActions).toHaveLength(1);
    expect(previewWorkItemPolicy(createPolicyEngine(), workItem).outcome).toBe("needs_approval");
  });

  it("does not accept caller supplied command, cwd, requester, or argv", () => {
    for (const extra of [
      { command: "rm" },
      { cwd: "/tmp" },
      { requester: "user" },
      { args: ["--force"] }
    ]) {
      expect(shellRecipeRequestInputSchema.safeParse({ id: "restart-worker", ...extra }).success).toBe(false);
      expect(shellRecipePreviewInputSchema.safeParse({ id: "restart-worker", ...extra }).success).toBe(false);
    }
  });
});