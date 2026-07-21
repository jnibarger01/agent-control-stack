import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      expect(result.evidence?.[0]).toMatchObject({
        evidence_type: "filesystem",
        executor_id: "worker-test",
        redacted: false
      });
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
      requestedActions: [
        {
          kind: "agent.preview",
          description: "preview",
          params: { agent: "codex", provider: "codex-cli", prompt: "inspect" }
        }
      ],
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

  it("executes an approved bounded file write and surgical edit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-worker-desktop-write-"));
    const allowed = join(dir, "allowed");
    mkdirSync(allowed);
    const config = writeConfig(dir, allowed);
    const write = createWorkItem({
      title: "Write fixture",
      requester: "agent",
      intent: "write a fixture",
      target: { cwd: allowed },
      requestedActions: [
        {
          kind: "fs.write",
          description: "write fixture",
          params: {
            rootId: "acs-repo",
            relativePath: "notes.txt",
            content: "hello",
            mode: "rewrite",
            registryActionId: "acs.filesystem.write_file",
            registryVersion: "1.0"
          }
        }
      ],
      risk: "high"
    });
    const edit = createWorkItem({
      title: "Edit fixture",
      requester: "agent",
      intent: "edit a fixture",
      target: { cwd: allowed },
      requestedActions: [
        {
          kind: "fs.patch",
          description: "edit fixture",
          params: {
            rootId: "acs-repo",
            relativePath: "notes.txt",
            oldString: "hello",
            newString: "world",
            expectedReplacements: 1,
            registryActionId: "acs.filesystem.edit_block",
            registryVersion: "1.0"
          }
        }
      ],
      risk: "high"
    });

    try {
      const written = await executeWorkerAction(write, config, "worker-test");
      const edited = await executeWorkerAction(edit, config, "worker-test");
      expect(written.ok).toBe(true);
      expect(edited.ok).toBe(true);
      expect(readFileSync(join(allowed, "notes.txt"), "utf8")).toBe("world");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("only exposes process output for a command that ACS started", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-worker-process-session-"));
    const allowed = join(dir, "allowed");
    mkdirSync(allowed);
    const config = writeConfig(dir, allowed);
    const start = createWorkItem({
      title: "Start registered process",
      requester: "agent",
      intent: "start a bounded diagnostic",
      target: { cwd: allowed },
      requestedActions: [
        {
          kind: "process.start",
          description: "start diagnostic",
          params: { commandId: "os.metadata" }
        }
      ],
      risk: "high"
    });

    try {
      const started = await executeWorkerAction(start, config, "worker-test");
      expect(started.ok).toBe(true);
      const session = JSON.parse(started.output) as { pid: number };
      const output = await executeWorkerAction(
        createWorkItem({
          title: "Read process output",
          requester: "agent",
          intent: "read diagnostic output",
          target: { cwd: allowed },
          requestedActions: [
            {
              kind: "process.output",
              description: "read diagnostic output",
              params: { pid: session.pid, offset: 0, length: 20 }
            }
          ],
          risk: "low"
        }),
        config,
        "worker-test"
      );
      expect(output.ok).toBe(true);
      expect(output.output).toContain(String(session.pid));
      const foreign = await executeWorkerAction(
        createWorkItem({
          title: "Read foreign process output",
          requester: "agent",
          intent: "read foreign output",
          target: { cwd: allowed },
          requestedActions: [
            {
              kind: "process.output",
              description: "read foreign output",
              params: { pid: 999999, offset: 0, length: 20 }
            }
          ],
          risk: "low"
        }),
        config,
        "worker-test"
      );
      expect(foreign.ok).toBe(false);
      expect(foreign.error).toContain("not started by ACS");
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
