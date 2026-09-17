import { describe, expect, it } from "vitest";
import {
  allowlistedDesktopCommanderToolNames,
  desktopCommanderToolPolicy,
  isAllowlistedDesktopCommanderTool
} from "./tool-policy.js";

describe("DesktopCommanderToolPolicy", () => {
  it("denies unknown tools by default", () => {
    expect(isAllowlistedDesktopCommanderTool("give_feedback_to_desktop_commander")).toBe(false);
    expect(isAllowlistedDesktopCommanderTool("set_config_value")).toBe(false);
    expect(isAllowlistedDesktopCommanderTool("kill_process")).toBe(false);
    expect(isAllowlistedDesktopCommanderTool("interact_with_process")).toBe(false);
    expect(isAllowlistedDesktopCommanderTool("write_pdf")).toBe(false);
    expect(isAllowlistedDesktopCommanderTool("track_ui_event")).toBe(false);
    expect(desktopCommanderToolPolicy("totally_new_tool")).toBeUndefined();
  });

  it("every allowlisted tool has an args schema and coherent metadata", () => {
    for (const name of allowlistedDesktopCommanderToolNames()) {
      const policy = desktopCommanderToolPolicy(name);
      expect(policy, name).toBeDefined();
      expect(policy!.argsSchema).toBeDefined();
      // destructive implies mutating implies requires approval
      if (policy!.destructive) expect(policy!.mutating).toBe(true);
      if (policy!.mutating) expect(policy!.requiresApproval).toBe(true);
      // no allowlisted tool is network-capable
      expect(policy!.network).toBe(false);
      expect(policy!.maxResultBytes).toBeGreaterThan(0);
      expect(policy!.timeoutMs).toBeGreaterThan(0);
    }
  });

  it("read-only tools never require approval", () => {
    for (const name of allowlistedDesktopCommanderToolNames()) {
      const policy = desktopCommanderToolPolicy(name)!;
      if (policy.riskClass === "read_only") {
        expect(policy.requiresApproval).toBe(false);
        expect(policy.mutating).toBe(false);
      }
    }
  });

  it("read_file forbids URL reads via the schema", () => {
    const policy = desktopCommanderToolPolicy("read_file")!;
    expect(policy.argsSchema.safeParse({ path: "/tmp/x", isUrl: true }).success).toBe(false);
    expect(policy.argsSchema.safeParse({ path: "/tmp/x", isUrl: false }).success).toBe(true);
    expect(policy.argsSchema.safeParse({ path: "/tmp/x" }).success).toBe(true);
  });

  it("rejects unexpected keys (strict schemas)", () => {
    const policy = desktopCommanderToolPolicy("list_directory")!;
    expect(policy.argsSchema.safeParse({ path: "/tmp", surprise: 1 }).success).toBe(false);
  });
});
