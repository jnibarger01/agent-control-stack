import { describe, expect, it, vi } from "vitest";
import { ControlStackError } from "@agent-control-stack/shared";
import {
  ClaudeEngineAdapter,
  EngineAdapterRegistry,
  GeminiEngineAdapter,
  GrokEngineAdapter,
  OpenCodeEngineAdapter,
  PiEngineAdapter,
  type EngineAdapter
} from "./index.js";
import type { EngineIsolation } from "@agent-control-stack/sandbox";
import type { EngineTask } from "./types.js";

const task: EngineTask = {
  workItemId: "work-1",
  attemptId: "attempt-1",
  leaseId: "lease-1",
  workerId: "worker-1",
  fencingToken: 1,
  authorization: { kind: "plan", hash: "a".repeat(64) },
  policyVersion: "policy-1",
  auditCorrelationId: "audit-1",
  idempotencyKey: "idempotency-1",
  workspace: { allocationId: "workspace-1", hostPath: "/tmp/workspace-1" },
  prompt: "do work",
  egressAllowlist: [{ host: "api.anthropic.com", port: 443 }],
  limits: { wallClockMs: 60_000, terminationGraceMs: 100, cpuQuotaPercent: 100, memoryBytes: 64 * 1024 * 1024, pids: 16, outputBytes: 100_000, tmpfsBytes: 16 * 1024 * 1024 }
};

function fakeIsolation() {
  const execute = vi.fn(async () => ({ outcome: "exited" as const, exitCode: 0, stdout: "ok", stderr: "", durationMs: 1, stdoutTruncated: false, stderrTruncated: false }));
  return { execute } as unknown as EngineIsolation;
}

describe("EngineAdapterRegistry", () => {
  it("registers adapters and rejects duplicate identifiers", () => {
    const adapter: EngineAdapter = { id: "codex", invoke: vi.fn() };
    const registry = new EngineAdapterRegistry([adapter]);
    expect(registry.require("codex")).toBe(adapter);
    expect(() => registry.register(adapter)).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "engine_adapter_duplicate" }));
  });
});

describe("CliEngineAdapter", () => {
  it("invokes Claude through EngineIsolation with the authority-bound workspace", async () => {
    const isolation = fakeIsolation();
    const adapter = new ClaudeEngineAdapter({
      binaryPath: "/usr/bin/claude",
      authorityVerifier: { verify: vi.fn(async () => { throw new Error("not used"); }) },
      credentialSource: () => "secret-not-logged",
      isolationFactory: () => isolation
    });

    const result = await adapter.invoke(task);

    expect(result).toMatchObject({ status: "completed", exitCode: 0 });
    expect(isolation.execute).toHaveBeenCalledWith(expect.objectContaining({ engineId: "claude", executable: "/usr/bin/claude", workspace: task.workspace }), expect.any(Object));
  });

  const taskWithDefaultEgress: EngineTask = { ...task, egressAllowlist: [] };

  it.each([
    { name: "Claude", Adapter: ClaudeEngineAdapter, binaryPath: "/usr/bin/claude", host: "api.anthropic.com" },
    { name: "Gemini", Adapter: GeminiEngineAdapter, binaryPath: "/usr/bin/gemini", host: "generativelanguage.googleapis.com" },
    { name: "Grok", Adapter: GrokEngineAdapter, binaryPath: "/usr/bin/grok", host: "api.x.ai" },
    { name: "OpenCode", Adapter: OpenCodeEngineAdapter, binaryPath: "/usr/bin/opencode", host: "api.openai.com" },
    { name: "Pi", Adapter: PiEngineAdapter, binaryPath: "/usr/bin/pi", host: "api.openai.com" }
  ])("$name defaults to its own provider's egress endpoint, not api.openai.com for a non-OpenAI provider", async ({ Adapter, binaryPath, host }) => {
    const isolation = fakeIsolation();
    const adapter = new Adapter({
      binaryPath,
      authorityVerifier: { verify: vi.fn(async () => { throw new Error("not used"); }) },
      credentialSource: () => "secret-not-logged",
      isolationFactory: () => isolation
    });

    await adapter.invoke(taskWithDefaultEgress);

    expect(isolation.execute).toHaveBeenCalledWith(
      expect.objectContaining({ egressAllowlist: [{ host, port: 443 }] }),
      expect.any(Object)
    );
  });

  it("lets an explicit task egressAllowlist override the provider default", async () => {
    const isolation = fakeIsolation();
    const adapter = new ClaudeEngineAdapter({
      binaryPath: "/usr/bin/claude",
      authorityVerifier: { verify: vi.fn(async () => { throw new Error("not used"); }) },
      credentialSource: () => "secret-not-logged",
      isolationFactory: () => isolation
    });

    await adapter.invoke(task);

    expect(isolation.execute).toHaveBeenCalledWith(
      expect.objectContaining({ egressAllowlist: task.egressAllowlist }),
      expect.any(Object)
    );
  });
});
