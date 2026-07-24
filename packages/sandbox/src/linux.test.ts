import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SandboxAuthorityVerifier, SandboxExecutionRequest } from "./contracts.js";
import {
  buildBubblewrapInvocation,
  buildSystemdScopeInvocation,
  createLinuxSandbox,
  launcherEnvironment,
  verifyAuthorityReceipt
} from "./linux.js";

function validSandboxRequest(overrides: Partial<SandboxExecutionRequest> = {}): SandboxExecutionRequest {
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

describe("Bubblewrap sandbox construction", () => {
  it("builds a network-denied, clear-environment, workspace-only mount command", () => {
    const request = validSandboxRequest();
    const invocation = buildBubblewrapInvocation(request, request.workspace.hostPath, {
      bwrapPath: "/usr/bin/bwrap",
      nodePath: process.execPath,
      gitPath: "/usr/bin/git"
    });

    expect(invocation.command).toBe("/usr/bin/bwrap");
    expect(invocation.args).toContain("--unshare-net");
    expect(invocation.args).toContain("--unshare-pid");
    expect(invocation.args).toContain("--unshare-cgroup");
    expect(invocation.args).toContain("--clearenv");
    expect(invocation.args).not.toContain(process.env.HOME);
    expect(invocation.args).toEqual(
      expect.arrayContaining(["--bind", request.workspace.hostPath, "/workspace", "--chdir", "/workspace"])
    );
  });

  it("wraps Bubblewrap in an enforced systemd cgroup scope", () => {
    const request = validSandboxRequest();
    const bubblewrap = { command: "/usr/bin/bwrap", args: ["--version"] };
    const invocation = buildSystemdScopeInvocation(request, bubblewrap, "acs-sandbox-test.scope", {
      systemdRunPath: "/usr/bin/systemd-run"
    });

    expect(invocation.args).toEqual(
      expect.arrayContaining([
        "--scope",
        "--collect",
        "--property=CPUQuota=100%",
        `--property=MemoryMax=${request.limits.memoryBytes}`,
        "--property=MemorySwapMax=0",
        `--property=TasksMax=${request.limits.pids}`,
        "/usr/bin/bwrap",
        "--version"
      ])
    );
  });

  it("strips secrets from the host launcher environment", () => {
    expect(
      launcherEnvironment({
        PATH: "/custom/bin",
        XDG_RUNTIME_DIR: "/run/user/1000",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        ACS_GATEWAY_TOKEN: "canary",
        OPENAI_API_KEY: "canary"
      })
    ).toEqual({
      PATH: "/usr/bin:/bin",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus"
    });
  });

  it("rejects a stale fence or mismatched workspace authority receipt", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "acs-sandbox-authority-")));
    const request = validSandboxRequest({ workspace: { allocationId: "workspace_test", hostPath: directory } });
    try {
      expect(() =>
        verifyAuthorityReceipt(request, {
          schemaVersion: "acs.sandbox-authority-receipt.v1",
          workItemId: request.workItemId,
          attemptId: request.attemptId,
          leaseId: request.leaseId,
          workerId: request.workerId,
          fencingToken: request.fencingToken + 1,
          authorizationHash: request.authorization.hash,
          policyVersion: request.policyVersion,
          workspaceAllocationId: request.workspace.allocationId,
          canonicalWorkspacePath: directory,
          executionEvent: { id: "evt_started", sequence: 1, hash: "b".repeat(64) }
        })
      ).toThrow("fencingToken");
      expect(() =>
        verifyAuthorityReceipt(request, {
          schemaVersion: "acs.sandbox-authority-receipt.v1",
          workItemId: request.workItemId,
          attemptId: request.attemptId,
          leaseId: request.leaseId,
          workerId: request.workerId,
          fencingToken: request.fencingToken,
          authorizationHash: request.authorization.hash,
          policyVersion: request.policyVersion,
          workspaceAllocationId: request.workspace.allocationId,
          canonicalWorkspacePath: directory,
          executionEvent: { id: "evt_wrong", sequence: 1, hash: "b".repeat(64) }
        })
      ).toThrow("executionEvent.id");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed before launch when Bubblewrap is missing", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "acs-sandbox-missing-")));
    const request = validSandboxRequest({ workspace: { allocationId: "workspace_test", hostPath: directory } });
    try {
      await expect(
        createLinuxSandbox({
          authorityVerifier: matchingAuthority(request),
          bwrapPath: "/definitely/missing/bwrap"
        }).preflight(request)
      ).rejects.toThrow("required executable is unavailable");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preflights host capabilities without consuming or creating execution authority", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "acs-sandbox-preflight-")));
    const request = validSandboxRequest({ workspace: { allocationId: "workspace_test", hostPath: directory } });
    let authorityChecks = 0;
    try {
      // requireExecutable() does a real lstatSync/accessSync on these paths before
      // hostCommandRunner ever runs, so faking the runner alone isn't enough to make
      // this test independent of whether bwrap/systemd-run/systemctl/git are actually
      // installed on the host running the suite. Point every required path at the
      // current Node binary, which is guaranteed to exist and be executable wherever
      // this test runs - only hostCommandRunner's fake output is exercised below.
      await createLinuxSandbox({
        authorityVerifier: {
          verify: async () => {
            authorityChecks += 1;
            throw new Error("preflight must not request execution authority");
          }
        },
        bwrapPath: process.execPath,
        systemdRunPath: process.execPath,
        systemctlPath: process.execPath,
        nodePath: process.execPath,
        gitPath: process.execPath,
        hostCommandRunner: async (command) => ({
          code: 0,
          signal: null,
          stdout: command === process.execPath ? "bubblewrap 0.9.0\n" : "",
          stderr: ""
        })
      }).preflight(request);
      expect(authorityChecks).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked working directory that resolves outside the workspace", async () => {
    const parent = mkdtempSync(join(tmpdir(), "acs-sandbox-cwd-"));
    const workspacePath = join(parent, "workspace");
    const outsidePath = join(parent, "outside");
    mkdirSync(workspacePath);
    mkdirSync(outsidePath);
    const workspace = realpathSync(workspacePath);
    const outside = realpathSync(outsidePath);
    symlinkSync(outside, join(workspace, "linked"));
    const request = validSandboxRequest({
      workspace: { allocationId: "workspace_test", hostPath: workspace },
      cwd: "linked"
    });
    try {
      await expect(
        createLinuxSandbox({
          authorityVerifier: matchingAuthority(request),
          hostCommandRunner: async () => {
            throw new Error("host probe must not run after a workspace escape");
          }
        }).preflight(request)
      ).rejects.toThrow("resolves outside the workspace");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

function matchingAuthority(request: SandboxExecutionRequest): SandboxAuthorityVerifier {
  return {
    verify: async () => ({
      schemaVersion: "acs.sandbox-authority-receipt.v1",
      workItemId: request.workItemId,
      attemptId: request.attemptId,
      leaseId: request.leaseId,
      workerId: request.workerId,
      fencingToken: request.fencingToken,
      authorizationHash: request.authorization.hash,
      policyVersion: request.policyVersion,
      workspaceAllocationId: request.workspace.allocationId,
      canonicalWorkspacePath: request.workspace.hostPath,
      executionEvent: { id: "evt_started", sequence: 1, hash: "b".repeat(64) }
    })
  };
}
