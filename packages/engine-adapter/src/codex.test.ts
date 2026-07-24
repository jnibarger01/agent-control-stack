import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  EngineIsolationAuthorityReceipt,
  EngineIsolationAuthorityVerifier,
  EngineIsolationRequest
} from "@agent-control-stack/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { CodexEngineAdapter, buildCodexArgs } from "./codex.js";
import type { EngineTask } from "./types.js";

describe("buildCodexArgs", () => {
  it("builds a non-interactive exec invocation with the requested sandbox mode", () => {
    const args = buildCodexArgs("do the thing", "workspace-write");
    expect(args).toEqual(["exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "do the thing"]);
  });

  it("never silently escalates to read-only when workspace-write was requested", () => {
    const args = buildCodexArgs("do the thing", "read-only");
    expect(args).toContain("read-only");
    expect(args).not.toContain("workspace-write");
  });
});

describe("CodexEngineAdapter", () => {
  let scriptDir: string | undefined;

  afterEach(() => {
    if (scriptDir) rmSync(scriptDir, { recursive: true, force: true });
    scriptDir = undefined;
  });

  function writeFixtureBinary(script: string): string {
    scriptDir = mkdtempSync(join(tmpdir(), "codex-adapter-test-"));
    const scriptPath = join(scriptDir, "fake-codex");
    writeFileSync(scriptPath, script, "utf8");
    chmodSync(scriptPath, 0o755);
    return scriptPath;
  }

  function task(binary: string, overrides: Partial<EngineTask> = {}): EngineTask {
    return {
      workItemId: "wrk_test",
      attemptId: "attempt_test",
      leaseId: "lease_test",
      workerId: "worker_test",
      fencingToken: 1,
      authorization: { kind: "action", hash: "a".repeat(64) },
      policyVersion: "policy-v1",
      auditCorrelationId: "evt_test_started",
      idempotencyKey: "engine-test-1",
      workspace: { allocationId: "workspace_test", hostPath: dirname(binary) },
      prompt: "do something",
      egressAllowlist: [{ host: "127.0.0.1", port: 1 }],
      limits: {
        wallClockMs: 5_000,
        terminationGraceMs: 500,
        cpuQuotaPercent: 100,
        memoryBytes: 512 * 1_024 * 1_024,
        pids: 64,
        outputBytes: 4_096,
        tmpfsBytes: 64 * 1_024 * 1_024
      },
      ...overrides
    };
  }

  function fakeAuthority(): EngineIsolationAuthorityVerifier {
    return {
      verify: async (request: EngineIsolationRequest): Promise<EngineIsolationAuthorityReceipt> => ({
        schemaVersion: "acs.engine-isolation-authority-receipt.v1",
        workItemId: request.workItemId,
        attemptId: request.attemptId,
        leaseId: request.leaseId,
        workerId: request.workerId,
        fencingToken: request.fencingToken,
        authorizationHash: request.authorization.hash,
        policyVersion: request.policyVersion,
        workspaceAllocationId: request.workspace.allocationId,
        canonicalWorkspacePath: request.workspace.hostPath,
        executionEvent: { id: request.auditCorrelationId, sequence: 1, hash: "b".repeat(64) }
      })
    };
  }

  it("builds a dry-run isolation request bound to the task's authority fields, not caller-chosen ones", async () => {
    const binary = writeFixtureBinary(["#!/bin/sh", "exit 0"].join("\n"));
    let captured: EngineIsolationRequest | undefined;
    const adapter = new CodexEngineAdapter({
      binaryPath: binary,
      authorityVerifier: fakeAuthority(),
      credentialSource: () => "fake-key",
      isolationFactory: () => ({
        execute: async (request: unknown) => {
          captured = request as EngineIsolationRequest;
          return {
            schemaVersion: "acs.engine-isolation-observation.v1",
            executionMode: "live",
            backend: "engine-isolation-v1",
            backendVersion: "test",
            unitName: "acs-engine-test.scope",
            outcome: "exited",
            observedSuccess: true,
            cleanup: "verified",
            exitCode: 0,
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            outputBytes: 0,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: 1,
            enforcedLimits: {
              wallClockMs: 5000,
              terminationGraceMs: 500,
              cpuQuotaPercent: 100,
              memoryBytes: 1,
              pids: 1,
              outputBytes: 1,
              tmpfsBytes: 1
            },
            egressAllowedCount: 0,
            egressDeniedCount: 0,
            egressDeniedSample: []
          };
        },
        preflight: async () => {}
      })
    });

    await adapter.invoke(task(binary, { workItemId: "wrk_bound_test" }));

    expect(captured?.workItemId).toBe("wrk_bound_test");
    expect(captured?.credential).toEqual({ envName: "OPENAI_API_KEY", envValue: "fake-key" });
    expect(captured?.executable).toBe(binary);
    expect(captured?.args).toEqual(["exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "do something"]);
  });

  it("refuses to invoke when no credential value is available", async () => {
    const binary = writeFixtureBinary(["#!/bin/sh", "exit 0"].join("\n"));
    const adapter = new CodexEngineAdapter({
      binaryPath: binary,
      authorityVerifier: fakeAuthority(),
      credentialSource: () => undefined
    });

    await expect(adapter.invoke(task(binary))).rejects.toThrowError(
      expect.objectContaining({ code: "engine_credential_unavailable" })
    );
  });

  it("maps a real isolation timeout outcome to the engine adapter's timeout status", async () => {
    const binary = writeFixtureBinary(["#!/bin/sh", "exit 0"].join("\n"));
    const adapter = new CodexEngineAdapter({
      binaryPath: binary,
      authorityVerifier: fakeAuthority(),
      credentialSource: () => "fake-key",
      isolationFactory: () => ({
        execute: async () => ({
          schemaVersion: "acs.engine-isolation-observation.v1",
          executionMode: "live",
          backend: "engine-isolation-v1",
          backendVersion: "test",
          unitName: "acs-engine-test.scope",
          outcome: "timed_out",
          observedSuccess: false,
          cleanup: "verified",
          exitCode: null,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          outputBytes: 0,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 5_000,
          enforcedLimits: {
            wallClockMs: 5000,
            terminationGraceMs: 500,
            cpuQuotaPercent: 100,
            memoryBytes: 1,
            pids: 1,
            outputBytes: 1,
            tmpfsBytes: 1
          },
          egressAllowedCount: 0,
          egressDeniedCount: 0,
          egressDeniedSample: []
        }),
        preflight: async () => {}
      })
    });

    const outcome = await adapter.invoke(task(binary));
    expect(outcome).toEqual({ status: "timeout", durationMs: 5_000 });
  });
});
