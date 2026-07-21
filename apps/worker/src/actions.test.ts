import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkItem } from "@agent-control-stack/work-items";
import { loadMachineControllerConfig } from "@agent-control-stack/machine-controller";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeWorkerAction } from "./actions.js";

describe("worker connector action dispatcher", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("executes registered file reads and returns bounded evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-worker-action-"));
    const allowed = join(dir, "allowed");
    mkdirSync(allowed);
    writeFileSync(join(allowed, "package.json"), '{"name":"fixture"}\n');
    const config = writeConfig(dir, allowed);
    const workItem = createWorkItem({
      title: "Read fixture",
      requester: "agent",
      intent: "read package metadata",
      target: { cwd: allowed },
      requestedActions: [
        {
          kind: "fs.read",
          description: "read package",
          params: { rootId: "acs-repo", relativePath: "package.json", paths: ["package.json"] }
        }
      ],
      risk: "low"
    });

    try {
      const result = await executeWorkerAction(workItem, config, "worker-test");
      expect(result.ok).toBe(true);
      expect(result.executionMode).toBe("controlled_action");
      expect(result.output).toContain('"name":"fixture"');
      expect(result.evidence?.[0]).toMatchObject({ evidence_type: "filesystem", executor_id: "worker-test", redacted: false });
      expect(result.evidence?.[0]?.content_hash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("previews registered commands and Codex without invoking either executor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-worker-preview-"));
    const allowed = join(dir, "allowed");
    mkdirSync(allowed);
    const config = writeConfig(dir, allowed);
    const command = createWorkItem({
      title: "Preview command",
      requester: "agent",
      intent: "preview diagnostic",
      target: { cwd: allowed },
      requestedActions: [{ kind: "cmd.preview", description: "preview", params: { commandId: "os.metadata" } }],
      risk: "low"
    });
    const agent = createWorkItem({
      title: "Preview Codex",
      requester: "agent",
      intent: "preview Codex",
      target: { cwd: allowed },
      requestedActions: [{ kind: "agent.preview", description: "preview", params: { agent: "codex", provider: "codex-cli", prompt: "inspect" } }],
      risk: "low"
    });

    try {
      const commandResult = await executeWorkerAction(command, config, "worker-test");
      const agentResult = await executeWorkerAction(agent, config, "worker-test");
      expect(commandResult.ok).toBe(true);
      expect(commandResult.output).toContain("os.metadata");
      expect(agentResult.ok).toBe(true);
      expect(agentResult.output).toContain("Codex");
      expect(agentResult.evidence?.[0]?.evidence_type).toBe("agent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("projects connector metadata out of the Codex executor request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-worker-agent-projection-"));
    const allowed = join(dir, "allowed");
    mkdirSync(allowed);
    const config = writeConfig(dir, allowed);
    const workItem = createWorkItem({
      title: "Run Codex with connector metadata",
      requester: "agent",
      intent: "inspect the repository without changing it",
      target: { cwd: allowed },
      requestedActions: [
        {
          kind: "agent.prompt",
          description: "inspect repository",
          params: {
            agent: "codex",
            provider: "codex-cli",
            prompt: "Inspect package.json and report its package name.",
            permissionMode: "read-only",
            networkAccess: "none",
            rootId: "acs-repo",
            registryActionId: "acs.agent.codex.run",
            registryVersion: 1
          }
        }
      ],
      risk: "medium"
    });

    vi.stubEnv("ACS_AGENT_EXECUTION_MODE", "disabled");
    try {
      const result = await executeWorkerAction({ ...workItem, status: "running" }, config, "worker-test");
      expect(result.error).toBe("real agent execution is disabled; enable the Bubblewrap Codex profile explicitly");
      expect(result.error).not.toContain("parameters do not satisfy the read-only execution contract");
      expect(result.agent).toBe("codex");
      expect(result.provider).toBe("codex-cli");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function writeConfig(dir: string, allowed: string) {
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      paths: { allow: [allowed], deny: [] },
      commands: { allow_readonly: ["uname"], deny: [] },
      audit: { log_path: join(dir, "audit.jsonl") }
    })
  );
  return loadMachineControllerConfig(configPath);
}
