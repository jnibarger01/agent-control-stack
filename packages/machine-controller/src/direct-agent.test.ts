import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStackError } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import { runDirectAgent, type DirectAgentRunner } from "./direct-agent.js";
import { MachineController } from "./controller.js";
import type { MachineControllerConfig } from "./config.js";

const examplePayload = {
  agent: "codex",
  prompt: "Review apps/gateway/src/server.ts for auth bugs. Do not modify files.",
  timeoutSeconds: 120,
  permissionMode: "read-only"
} as const;

describe("test.agent.run direct agent runner", () => {
  it("accepts the clean JSON direct-run payload and returns structured JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-agent-run-"));
    const allowed = join(dir, "allowed");
    mkdirSync(allowed);
    const calls: Array<{ command: string; args: string[]; cwd: string; timeoutMs: number; permissionMode: string }> = [];
    const runner: DirectAgentRunner = async (request) => {
      calls.push({
        command: request.command,
        args: request.args,
        cwd: request.cwd,
        timeoutMs: request.timeoutMs,
        permissionMode: request.permissionMode
      });
      return { stdout: "review done", stderr: "", exitCode: 0, durationMs: 12 };
    };

    try {
      const result = await runDirectAgent(
        config(dir, allowed),
        { ...examplePayload, cwd: allowed },
        runner
      );

      expect(result).toMatchObject({
        ok: true,
        agent: "codex",
        stdout: "review done",
        stderr: "",
        exitCode: 0
      });
      expect(typeof result.durationMs).toBe("number");
      expect(result.error).toBeNull();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ cwd: allowed, timeoutMs: 120_000, permissionMode: "read-only" });
      expect(calls[0]?.args.at(-1)).toBe(examplePayload.prompt);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults to read-only permission mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-agent-default-"));
    const allowed = join(dir, "allowed");
    mkdirSync(allowed);
    let observedPermissionMode = "";
    const runner: DirectAgentRunner = async (request) => {
      observedPermissionMode = request.permissionMode;
      return { stdout: "ok", stderr: "", exitCode: 0, durationMs: 1 };
    };

    try {
      await runDirectAgent(config(dir, allowed), { agent: "codex", prompt: "Inspect only", cwd: allowed }, runner);
      expect(observedPermissionMode).toBe("read-only");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-agent-unknown-"));
    const allowed = join(dir, "allowed");
    mkdirSync(allowed);

    try {
      await expect(runDirectAgent(config(dir, allowed), { agent: "ghost", prompt: "hi", cwd: allowed })).rejects.toThrow(
        ControlStackError
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects missing or empty prompts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-agent-prompt-"));
    const allowed = join(dir, "allowed");
    mkdirSync(allowed);

    try {
      await expect(runDirectAgent(config(dir, allowed), { agent: "codex", cwd: allowed })).rejects.toThrow(
        ControlStackError
      );
      await expect(runDirectAgent(config(dir, allowed), { agent: "codex", prompt: "   ", cwd: allowed })).rejects.toThrow(
        ControlStackError
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects write-capable permission modes in the direct path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-agent-permission-"));
    const allowed = join(dir, "allowed");
    mkdirSync(allowed);

    try {
      await expect(
        runDirectAgent(config(dir, allowed), {
          agent: "codex",
          prompt: "Modify files",
          cwd: allowed,
          permissionMode: "write"
        })
      ).rejects.toThrow(ControlStackError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs through MachineController test.agent.run with the exact direct JSON shape", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-agent-controller-"));
    const allowed = join(dir, "allowed");
    mkdirSync(allowed);
    const calls: Array<{ cwd: string; timeoutMs: number; permissionMode: string; args: string[] }> = [];
    const runner: DirectAgentRunner = async (request) => {
      calls.push({
        cwd: request.cwd,
        timeoutMs: request.timeoutMs,
        permissionMode: request.permissionMode,
        args: request.args
      });
      return { stdout: "controller ok", stderr: "", exitCode: 0, durationMs: 5 };
    };

    try {
      const controller = new MachineController(config(dir, allowed), {
        directAgentRunner: runner,
        enableTestAgentRunForLocalDevelopment: true
      });
      const result = await controller.callTool("test.agent.run", {
        ...examplePayload,
        cwd: allowed
      });

      expect(result).toMatchObject({
        ok: true,
        agent: "codex",
        stdout: "controller ok",
        stderr: "",
        exitCode: 0
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ cwd: allowed, timeoutMs: 120_000, permissionMode: "read-only" });
      expect(calls[0]?.args.at(-1)).toBe(examplePayload.prompt);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects MachineController test.agent.run by default before invoking the runner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-agent-controller-disabled-"));
    const allowed = join(dir, "allowed");
    mkdirSync(allowed);
    let runnerCalls = 0;
    const runner: DirectAgentRunner = async () => {
      runnerCalls += 1;
      return { stdout: "must not run", stderr: "", exitCode: 0, durationMs: 1 };
    };

    try {
      const controller = new MachineController(config(dir, allowed), { directAgentRunner: runner });

      await expect(
        controller.callTool("test.agent.run", { ...examplePayload, cwd: allowed })
      ).rejects.toMatchObject({ code: "direct_agent_disabled" });
      expect(runnerCalls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown agent through MachineController test.agent.run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-agent-controller-unknown-"));
    const allowed = join(dir, "allowed");
    mkdirSync(allowed);

    try {
      let runnerCalls = 0;
      const runner: DirectAgentRunner = async () => {
        runnerCalls += 1;
        return { stdout: "must not run", stderr: "", exitCode: 0, durationMs: 1 };
      };
      const controller = new MachineController(config(dir, allowed), {
        directAgentRunner: runner,
        enableTestAgentRunForLocalDevelopment: true
      });
      await expect(
        controller.callTool("test.agent.run", { agent: "ghost", prompt: "Inspect only", cwd: allowed })
      ).rejects.toThrow(ControlStackError);
      expect(runnerCalls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function config(dir: string, allowed: string): MachineControllerConfig {
  return {
    server: { name: "test", transport: "stdio", version: "0.1.0" },
    security: {
      defaultPolicy: "deny",
      requireApprovalForMutations: true,
      redactSecrets: true,
      maxOutputBytes: 200_000,
      commandTimeoutMs: 120_000,
      commandTerminationGraceMs: 1_000
    },
    paths: { allow: [allowed], deny: [] },
    commands: { allowReadonly: ["node"], deny: [] },
    audit: { logPath: join(dir, "audit.jsonl") }
  };
}
