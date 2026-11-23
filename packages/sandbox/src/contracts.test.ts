import { describe, expect, it } from "vitest";
import {
  sandboxAuthorityReceiptSchema,
  sandboxExecutionObservationSchema,
  sandboxExecutionRequestSchema,
  type SandboxExecutionRequest,
  recordScopeBeforeLaunch
} from "./contracts.js";

export function validSandboxRequest(overrides: Partial<SandboxExecutionRequest> = {}): SandboxExecutionRequest {
  return {
    schemaVersion: "acs.sandbox-execution.v1",
    workItemId: "wrk_test",
    attemptId: "attempt_test",
    leaseId: "lease_test",
    workerId: "worker_test",
    fencingToken: 1,
    authorization: { kind: "action", hash: "a".repeat(64) },
    policyVersion: "policy-v1",
    auditCorrelationId: "evt_execution_started",
    idempotencyKey: "sandbox-attempt-1",
    workspace: { allocationId: "workspace_test", hostPath: "/tmp/acs-workspace" },
    commandProfile: "npm-test",
    cwd: ".",
    environment: { CI: "1", LANG: "C.UTF-8" },
    network: "none",
    limits: {
      wallClockMs: 30_000,
      terminationGraceMs: 1_000,
      cpuQuotaPercent: 100,
      memoryBytes: 256 * 1_024 * 1_024,
      pids: 64,
      outputBytes: 64 * 1_024,
      tmpfsBytes: 64 * 1_024 * 1_024
    },
    ...overrides
  };
}

describe("sandbox contracts", () => {
  it("accepts one strict, bounded, network-denied execution request", () => {
    expect(sandboxExecutionRequestSchema.parse(validSandboxRequest())).toMatchObject({
      commandProfile: "npm-test",
      network: "none",
      cwd: "."
    });
  });

  it("rejects arbitrary commands, path escape, environment secrets, and unknown keys", () => {
    expect(() => sandboxExecutionRequestSchema.parse({ ...validSandboxRequest(), commandProfile: "bash" })).toThrow();
    expect(() => sandboxExecutionRequestSchema.parse({ ...validSandboxRequest(), cwd: "../outside" })).toThrow();
    expect(() =>
      sandboxExecutionRequestSchema.parse({
        ...validSandboxRequest(),
        environment: { OPENAI_API_KEY: "canary" }
      })
    ).toThrow("environment variable is not allowlisted");
    expect(() => sandboxExecutionRequestSchema.parse({ ...validSandboxRequest(), unrestrictedShell: true })).toThrow();
  });

  it("requires authority receipts to identify a durable execution event", () => {
    expect(() =>
      sandboxAuthorityReceiptSchema.parse({
        schemaVersion: "acs.sandbox-authority-receipt.v1",
        workItemId: "wrk_test",
        attemptId: "attempt_test",
        leaseId: "lease_test",
        workerId: "worker_test",
        fencingToken: 1,
        authorizationHash: "a".repeat(64),
        policyVersion: "policy-v1",
        workspaceAllocationId: "workspace_test",
        canonicalWorkspacePath: "/tmp/acs-workspace",
        executionEvent: { id: "evt_test", sequence: 0, hash: "b".repeat(64) }
      })
    ).toThrow();
  });

  it("never accepts an unknown or unclean outcome as observed success", () => {
    expect(() =>
      sandboxExecutionObservationSchema.parse({
        schemaVersion: "acs.sandbox-observation.v1",
        executionMode: "live",
        backend: "bubblewrap-systemd-v1",
        backendVersion: "bubblewrap 0.9.0",
        unitName: "acs-sandbox-test.scope",
        outcome: "unknown",
        observedSuccess: true,
        cleanup: "unknown",
        exitCode: 0,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        outputBytes: 0,
        startedAt: "2026-07-23T00:00:00.000Z",
        finishedAt: "2026-07-23T00:00:01.000Z",
        durationMs: 1_000,
        enforcedLimits: validSandboxRequest().limits
      })
    ).toThrow("success requires a known zero exit");
  });
});

describe("recordScopeBeforeLaunch", () => {
  const binding = {
    workItemId: "wrk_1",
    attemptId: "attempt_1",
    leaseId: "lease_1",
    fencingToken: 3,
    unitName: "acs-sandbox-attempt_1-0a1b2c3d.scope"
  };

  it("does nothing without a recorder", async () => {
    await expect(recordScopeBeforeLaunch(undefined, binding, "sandbox_scope_unrecorded")).resolves.toBeUndefined();
  });

  it("passes the exact binding to the recorder and waits for it", async () => {
    const seen: unknown[] = [];
    await recordScopeBeforeLaunch(
      {
        async record(value) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          seen.push(value);
        }
      },
      binding,
      "sandbox_scope_unrecorded"
    );
    expect(seen).toEqual([binding]);
  });

  it("maps any recorder failure to the given code without echoing its detail", async () => {
    const attempt = recordScopeBeforeLaunch(
      {
        record() {
          throw new Error("SQLITE_BUSY at /home/operator/.acs/control.db");
        }
      },
      binding,
      "engine_isolation_scope_unrecorded"
    );
    await expect(attempt).rejects.toMatchObject({ code: "engine_isolation_scope_unrecorded" });
    await expect(attempt).rejects.not.toMatchObject({ message: expect.stringContaining("/home/operator") });
  });
});
