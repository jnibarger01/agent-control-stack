import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeInvocation } from "./arguments.js";
import { desktopCommanderRequiredScopes } from "./capability.js";
import type { ContainmentConfig } from "./containment.js";
import { classifyDesktopCommanderExecution } from "./concurrency-scheduler/classify.js";
import {
  allowlistedDesktopCommanderToolNames,
  desktopCommanderToolPolicy,
  isAllowlistedDesktopCommanderTool
} from "./tool-policy.js";

let root: string;
let config: ContainmentConfig;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "dc-rtid-")));
  config = { allowedRoots: [root], deniedRoots: [] };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("get_runtime_identity ACS policy", () => {
  it("is allowlisted as read-only, non-mutating, non-network, no approval", () => {
    expect(isAllowlistedDesktopCommanderTool("get_runtime_identity")).toBe(true);
    expect(allowlistedDesktopCommanderToolNames()).toContain("get_runtime_identity");
    const policy = desktopCommanderToolPolicy("get_runtime_identity")!;
    expect(policy.riskClass).toBe("read_only");
    expect(policy.mutating).toBe(false);
    expect(policy.destructive).toBe(false);
    expect(policy.network).toBe(false);
    expect(policy.requiresApproval).toBe(false);
    expect(policy.pathArgs).toEqual([]);
    expect(policy.commandArgs).toEqual([]);
    expect(policy.cwdArgs).toEqual([]);
  });

  it("accepts {} and strips transport metadata, and rejects unknown keys", () => {
    expect(normalizeInvocation("get_runtime_identity", {}, config).toolName).toBe("get_runtime_identity");
    for (const origin of ["llm", "ui"] as const) {
      const normalized = normalizeInvocation("get_runtime_identity", { origin }, config);
      expect(normalized.validatedArguments.origin).toBeUndefined();
    }
    for (const bad of [{ path: root }, { command: "id" }]) {
      expect(() => normalizeInvocation("get_runtime_identity", bad, config), JSON.stringify(bad)).toThrow(
        /invalid arguments for get_runtime_identity/
      );
    }
  });

  it("maps to the manifest scope, which is process authority rather than fs.read", () => {
    expect(desktopCommanderRequiredScopes("get_runtime_identity")).toEqual(["process.exec"]);
  });

  it("schedules on the shared read lane like get_config", () => {
    const classify = (toolName: string) =>
      classifyDesktopCommanderExecution({
        requestId: `req-${toolName}`,
        agentId: "chatgpt",
        sessionId: "s1",
        invocation: normalizeInvocation(toolName, {}, config)
      });
    const rt = classify("get_runtime_identity");
    expect(rt.lane).toBe("read");
    expect(rt.effects).toBe("read_only");
    expect(rt.resources).toEqual(classify("get_config").resources);
  });

  it("near-miss tool names stay denied", () => {
    for (const name of ["Get_Runtime_Identity", "get_runtime_identity ", "get_runtime_identity_v2", "runtime_identity"]) {
      expect(isAllowlistedDesktopCommanderTool(name), name).toBe(false);
    }
  });
});
