import { existsSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkItem, type WorkItem } from "@agent-control-stack/work-items";
import { describe, expect, it, vi } from "vitest";
import { executeAgentSandboxed, runContainedReadonlyCommand } from "./agent-executor.js";

const runTests = process.platform !== "win32" && existsSync("/usr/bin/bwrap");

function agentWorkItem(cwd: string, overrides: Record<string, unknown> = {}): WorkItem {
  const workItem = createWorkItem({
    title: "Read-only agent",
    requester: "user",
    intent: "inspect the workspace",
    target: { cwd },
    requestedActions: [
      {
        kind: "agent.prompt",
        description: "inspect the workspace",
        params: {
          agent: "codex",
          provider: "codex-cli",
          prompt: "Inspect only and return a concise report.",
          cwd,
          permissionMode: "read-only",
          networkAccess: "none",
          ...overrides
        }
      }
    ],
    risk: "low"
  });
  return { ...workItem, status: "running" };
}

describe("contained agent execution", () => {
  it("is disabled by default and never calls the provider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-agent-disabled-"));
    const commandFactory = vi.fn(() => ({ executable: "/bin/sh", args: ["-c", "printf should-not-run"] }));
    try {
      const result = await executeAgentSandboxed(agentWorkItem(dir), { commandFactory });
      expect(result).toMatchObject({ executionMode: "not_started", ok: false });
      expect(result.error).toContain("disabled");
      expect(commandFactory).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["claude", "gemini", "opencode", "openclaw", "pi"])(
    "fails closed for the unproven %s provider",
    async (provider) => {
      const dir = mkdtempSync(join(tmpdir(), "acs-agent-provider-"));
      const commandFactory = vi.fn(() => ({ executable: "/bin/sh", args: ["-c", "printf should-not-run"] }));
      try {
        const result = await executeAgentSandboxed(
          agentWorkItem(dir, { agent: provider, provider }),
          { enabled: true, commandFactory }
        );
        expect(result).toMatchObject({ executionMode: "not_started", ok: false });
        expect(result.error).toContain("disabled");
        expect(commandFactory).not.toHaveBeenCalled();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(!runTests)("enforces a read-only workspace and clears inherited environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-agent-readonly-"));
    writeFileSync(join(dir, "before.txt"), "stable");
    try {
      const result = await executeAgentSandboxed(agentWorkItem(dir), {
        enabled: true,
        commandFactory: () => ({
          executable: "/bin/sh",
          args: [
            "-c",
            "test \"$ACS_TEST_SECRET\" = \"\" && test \"$HOME\" = /tmp/acs-agent-home && touch /var/tmp/blocked || true; printf agent-output"
          ]
        })
      });
      expect(result.ok).toBe(true);
      expect(result.executionMode).toBe("sandboxed_agent");
      expect(result.output).toContain("agent-output");
      expect(result.sandboxIdentity).toContain("bubblewrap");
      expect(result.workspaceBeforeHash).toBe(result.workspaceAfterHash);
      expect(existsSync(join(dir, "blocked"))).toBe(false);
      expect(lstatSync(join(dir, "before.txt")).isFile()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!runTests)("terminates the entire contained process group after timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-agent-timeout-"));
    try {
      const started = Date.now();
      const result = await runContainedReadonlyCommand({
        executable: "/bin/sh",
        args: ["-c", "trap '' TERM; (trap '' TERM; sleep 30) & wait"],
        cwd: dir,
        timeoutMs: 100,
        terminationGraceMs: 100,
        maxOutputBytes: 1_000
      });
      expect(result.timedOut).toBe(true);
      expect(result.processTreeTerminated).toBe(true);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!runTests)("rejects a workspace symlink that resolves outside the workspace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-agent-symlink-"));
    const outside = mkdtempSync(join(tmpdir(), "acs-agent-outside-"));
    const commandFactory = vi.fn(() => ({ executable: "/bin/sh", args: ["-c", "printf should-not-run"] }));
    try {
      writeFileSync(join(outside, "secret.txt"), "secret");
      symlinkSync(outside, join(dir, "escape"), "dir");
      const result = await executeAgentSandboxed(agentWorkItem(dir), { enabled: true, commandFactory });
      expect(result).toMatchObject({ executionMode: "not_started", ok: false });
      expect(result.error).toContain("symlink");
      expect(commandFactory).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
