import { describe, expect, it, vi } from "vitest";
import { createCodingTask, transitionCodingTask, validateCodingTask } from "./coding-task.js";
import { OllamaCodingModel } from "./coding-model.js";
import { normalizeCodingTool } from "./coding-tools.js";
import { CodingHarness, JsonlAuditSink, type AcsToolGateway, type TaskStateStore } from "./coding-runtime.js";
import { DesktopCommanderAcsGateway } from "./coding-dc-gateway.js";
import { CodingWorktreeManager } from "./coding-worktree.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";

const base = {
  id: "task-1234",
  goal: "Fix the fixture",
  repository: { root: "/tmp/repo", baseCommit: "abcdef1" },
  agent: { provider: "test", model: "test", role: "worker" as const },
  constraints: {
    allowedPaths: ["src"],
    deniedPaths: [".git"],
    network: "none" as const,
    allowGitWrite: true,
    allowPush: false,
    allowServiceRestart: false
  },
  verification: [
    { id: "scope", type: "scope" as const, required: true as const, allowedPaths: ["src"], deniedPaths: [".git"] }
  ]
};

describe("coding task", () => {
  it("validates and transitions explicitly", () => {
    const task = createCodingTask(base);
    expect(task.state).toBe("inspect");
    expect(transitionCodingTask(task, "plan").state).toBe("plan");
    expect(() => transitionCodingTask(task, "complete")).toThrow();
    expect(() => validateCodingTask({ ...base, constraints: { ...base.constraints, allowPush: true } })).toThrow();
  });
});

describe("coding model contract", () => {
  it("parses Ollama JSON tool turns", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({ toolCalls: [{ id: "1", name: "file.read", arguments: { path: "README.md" } }] })
          }
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchImpl);
    const turn = await new OllamaCodingModel("qwen").generate({
      taskId: "task-1234",
      goal: "inspect",
      state: "inspect",
      observations: [],
      iteration: 0
    });
    expect(turn.toolCalls[0]?.name).toBe("file.read");
    vi.unstubAllGlobals();
  });
});

describe("normalized coding tools", () => {
  it("rejects traversal and sends exact contained arguments", () => {
    expect(() => normalizeCodingTool("file.read", { path: "../secret" }, "/tmp/repo")).toThrow();
    const request = normalizeCodingTool("file.read", { path: "src/index.ts" }, "/tmp/repo");
    expect(request).toMatchObject({ tool: "file.read", dcTool: "read_file", args: { path: "/tmp/repo/src/index.ts" } });
    expect(() => normalizeCodingTool("process.run", {}, "/tmp/repo")).toThrow();
  });

  it("fails closed on unknown fields passed to the raw tool layer", () => {
    const request = normalizeCodingTool("file.create", { path: "new.txt", content: "x" }, "/tmp/repo");
    expect(request.dcTool).toBe("write_file");
  });

  it("passes only the branded authorization and exact normalized request to the DC executor", async () => {
    const execute = vi.fn(async () => ({ ok: true, output: "ok", resultHash: "hash", toolName: "read_file" }));
    const authorization = { requestId: "r" } as never;
    const gateway = new DesktopCommanderAcsGateway({ execute } as never, {
      authorize: vi.fn(async () => authorization)
    });
    const request = normalizeCodingTool("file.read", { path: "README.md" }, "/tmp/repo");
    const result = await gateway.execute(request);
    expect(result.evidenceHash).toBe("hash");
    expect(execute).toHaveBeenCalledWith({ authorization, signal: undefined });
  });
});

describe("coding harness", () => {
  it("terminates on model final turn and computes verification", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coding-harness-"));
    const state: TaskStateStore = { load: vi.fn(), save: vi.fn(async () => undefined) };
    const gateway: AcsToolGateway = { execute: vi.fn(async () => ({ ok: true, output: "ok", evidenceHash: "h" })) };
    const model = {
      provider: "test",
      model: "test",
      generate: vi.fn(async () => ({ message: "done", toolCalls: [] }))
    };
    const harness = new CodingHarness({
      model,
      gateway,
      store: state,
      audit: new JsonlAuditSink(join(dir, "audit.jsonl")),
      verification: { run: async () => ({ verdict: "PASS", evidence: ["scope:ok"], reason: "verified" }) },
      workspace: "/tmp/repo"
    });
    const result = await harness.run(createCodingTask(base), base.goal, { maxIterations: 3, now: () => Date.now() });
    expect(result.verdict.verdict).toBe("PASS");
    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(state.save).toHaveBeenCalled();
  });

  it("blocks on denied authorization and terminates on iteration limit", async () => {
    const task = createCodingTask(base);
    const state: TaskStateStore = { load: vi.fn(), save: vi.fn(async () => undefined) };
    const gateway: AcsToolGateway = {
      execute: vi.fn(async () => ({
        ok: false,
        output: "denied",
        errorCode: "ACS_CAPABILITY_MISSING",
        evidenceHash: "h"
      }))
    };
    const model = {
      provider: "test",
      model: "test",
      generate: vi.fn(async () => ({ toolCalls: [{ id: "1", name: "file.read", arguments: { path: "README.md" } }] }))
    };
    const harness = new CodingHarness({
      model,
      gateway,
      store: state,
      audit: { append: vi.fn(async () => undefined) },
      verification: { run: async () => ({ verdict: "PASS", evidence: [], reason: "" }) },
      workspace: "/tmp/repo"
    });
    const result = await harness.run(task, base.goal, { maxIterations: 2, now: () => Date.now() });
    expect(result.verdict.verdict).toBe("BLOCK");
    expect(model.generate).toHaveBeenCalledTimes(1);
  });

  it("rejects model-requested verification.run", async () => {
    const save = vi.fn(async () => undefined);
    const gateway: AcsToolGateway = { execute: vi.fn() };
    const model = { provider: "test", model: "test", generate: vi.fn(async () => ({ toolCalls: [{ id: "1", name: "verification.run", arguments: { command: "rm -rf /" } }] })) };
    const harness = new CodingHarness({ model, gateway, store: { load: vi.fn(), save }, audit: { append: vi.fn(async () => undefined) }, verification: { run: vi.fn() }, workspace: "/tmp/repo" });
    const result = await harness.run(createCodingTask(base), base.goal, { now: () => Date.now() });
    expect(result.verdict.verdict).toBe("BLOCK");
    expect(gateway.execute).not.toHaveBeenCalled();
  });

  it("blocks and persists state when the coding loop exceeds its timeout", async () => {
    const save = vi.fn(async () => undefined);
    const harness = new CodingHarness({
      model: { provider: "test", model: "test", generate: vi.fn(async () => ({ toolCalls: [] })) },
      gateway: { execute: vi.fn() },
      store: { load: vi.fn(), save },
      audit: { append: vi.fn(async () => undefined) },
      verification: { run: vi.fn() },
      workspace: "/tmp/repo"
    });
    const result = await harness.run(createCodingTask(base), base.goal, {
      timeoutMs: 1,
      now: (() => {
        let now = 0;
        return () => {
          now += 2;
          return now;
        };
      })()
    });
    expect(result.verdict.verdict).toBe("BLOCK");
    expect(save).toHaveBeenCalled();
  });

  it("requires the workspace authority to return a contained worktree", async () => {
    const manager = new CodingWorktreeManager({
      provision: vi.fn(async () => ({
        taskId: "task-1234",
        root: "/tmp/repo",
        worktree: "/tmp/other",
        baseCommit: "abcdef1",
        branch: "acs/task-1234"
      }))
    });
    await expect(manager.provision("task-1234", "/tmp/repo", "abcdef1")).rejects.toThrow("escapes repository root");
  });
});
