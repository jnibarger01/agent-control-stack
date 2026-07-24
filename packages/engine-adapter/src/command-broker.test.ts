import { describe, expect, it } from "vitest";
import type { PolicyDecision } from "@agent-control-stack/policy-gate";
import type { SandboxBackend, SandboxExecutionObservation } from "@agent-control-stack/sandbox";
import type { CommandAuthority } from "@agent-control-stack/work-items";
import {
  CommandBroker,
  storeBackedVerifier,
  type CommandAuthorityStore,
  type CommandRequest
} from "./command-broker.js";

/** These tests inject their own fake `sandbox`, so the store-backed
 * authority verifier CommandBroker would otherwise build is never reached -
 * this stands in for that unused dependency and fails loudly if it ever is. */
function unreachableStore(): CommandAuthorityStore {
  return {
    getCommandAuthority(): CommandAuthority | undefined {
      throw new Error("store.getCommandAuthority should not be called when a fake sandbox bypasses it");
    }
  };
}

function baseRequest(overrides: Partial<CommandRequest> = {}): CommandRequest {
  return {
    workItemId: "wrk_test",
    attemptId: "attempt_test",
    leaseId: "lease_test",
    workerId: "worker_test",
    fencingToken: 1,
    requester: "user",
    actor: "actor-user",
    risk: "low",
    policyVersion: "acs.policy.v1",
    workspace: { allocationId: "workspace_test", hostPath: "/tmp/workspace_test" },
    commandProfile: "git-status",
    ...overrides
  };
}

function spySandbox(): { sandbox: SandboxBackend; executeCalls: unknown[] } {
  const executeCalls: unknown[] = [];
  const sandbox: SandboxBackend = {
    name: "bubblewrap-systemd-v1",
    async preflight() {
      return undefined;
    },
    async execute(input: unknown): Promise<SandboxExecutionObservation> {
      executeCalls.push(input);
      return {
        schemaVersion: "acs.sandbox-observation.v1",
        executionMode: "live",
        backend: "bubblewrap-systemd-v1",
        backendVersion: "0.9.0",
        unitName: "acs-test.scope",
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
          wallClockMs: 1_000,
          terminationGraceMs: 10,
          cpuQuotaPercent: 100,
          memoryBytes: 64 * 1_024 * 1_024,
          pids: 8,
          outputBytes: 1_024,
          tmpfsBytes: 1_024 * 1_024
        }
      };
    }
  };
  return { sandbox, executeCalls };
}

describe("CommandBroker", () => {
  it("never reaches the sandbox when policy denies the command", async () => {
    const { sandbox, executeCalls } = spySandbox();
    const denyDecision: PolicyDecision = { decision: "deny", reason: "test denial", matchedRules: ["deny:test"] };
    const broker = new CommandBroker({ sandbox, store: unreachableStore(), evaluate: () => denyDecision });

    const result = await broker.run(baseRequest());

    expect(result).toEqual({ outcome: "policy_denied", decision: denyDecision });
    expect(executeCalls).toHaveLength(0);
  });

  it("never reaches the sandbox when policy requires approval", async () => {
    const { sandbox, executeCalls } = spySandbox();
    const requireApproval: PolicyDecision = {
      decision: "require_approval",
      reason: "test approval required",
      matchedRules: ["require_approval:test"]
    };
    const broker = new CommandBroker({ sandbox, store: unreachableStore(), evaluate: () => requireApproval });

    const result = await broker.run(baseRequest());

    expect(result).toEqual({ outcome: "policy_denied", decision: requireApproval });
    expect(executeCalls).toHaveLength(0);
  });

  it("executes through the sandbox only when policy allows, binding the exact policy-evaluated hash", async () => {
    const { sandbox, executeCalls } = spySandbox();
    const allow: PolicyDecision = { decision: "allow", reason: "test allow", matchedRules: [] };
    const broker = new CommandBroker({ sandbox, store: unreachableStore(), evaluate: () => allow });

    const result = await broker.run(baseRequest());

    expect(result.outcome).toBe("executed");
    expect(executeCalls).toHaveLength(1);
    const sentRequest = executeCalls[0] as { authorization: { kind: string; hash: string }; commandProfile: string };
    expect(sentRequest.authorization.kind).toBe("action");
    expect(sentRequest.authorization.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(sentRequest.commandProfile).toBe("git-status");
  });

  it("uses the real policy-gate evaluator by default and allows a genuinely read-only command", async () => {
    const { sandbox, executeCalls } = spySandbox();
    const broker = new CommandBroker({ sandbox, store: unreachableStore() });

    const result = await broker.run(baseRequest({ commandProfile: "git-status", risk: "low" }));

    expect(result.outcome).toBe("executed");
    expect(executeCalls).toHaveLength(1);
  });

  it("uses the real policy-gate evaluator by default and refuses npm scripts without approval", async () => {
    // npm run <script> can execute arbitrary code (postinstall hooks, a
    // custom test runner shelling out to anything) - packages/policy-gate's
    // real rules.ts correctly classifies it as require_approval, not allow.
    // CommandBroker has no approval-consumption wiring yet (that's Phase 4),
    // so today it can only ever execute genuinely read-only profiles
    // (git-status, git-diff-check) - this is the correct, conservative
    // behavior, not a limitation to work around silently.
    for (const commandProfile of ["npm-test", "npm-lint", "npm-build", "npm-typecheck"] as const) {
      const { sandbox, executeCalls } = spySandbox();
      const broker = new CommandBroker({ sandbox, store: unreachableStore() });

      const result = await broker.run(baseRequest({ commandProfile, risk: "low" }));

      expect(result.outcome).toBe("policy_denied");
      if (result.outcome === "policy_denied") {
        expect(result.decision.decision).toBe("require_approval");
      }
      expect(executeCalls).toHaveLength(0);
    }
  });

  it("produces a different action hash for a different command profile on the same work item", async () => {
    const { sandbox, executeCalls } = spySandbox();
    const allow: PolicyDecision = { decision: "allow", reason: "", matchedRules: [] };
    const broker = new CommandBroker({ sandbox, store: unreachableStore(), evaluate: () => allow });

    await broker.run(baseRequest({ commandProfile: "git-status" }));
    await broker.run(baseRequest({ commandProfile: "npm-test" }));

    expect(executeCalls).toHaveLength(2);
    const [first, second] = executeCalls as Array<{ authorization: { hash: string } }>;
    expect(first.authorization.hash).not.toBe(second.authorization.hash);
  });

  it("rejects a malformed command request before ever evaluating policy or touching the sandbox", async () => {
    const { sandbox, executeCalls } = spySandbox();
    let evaluateCalled = false;
    const broker = new CommandBroker({
      sandbox,
      store: unreachableStore(),
      evaluate: () => {
        evaluateCalled = true;
        return { decision: "allow", reason: "", matchedRules: [] } satisfies PolicyDecision;
      }
    });

    await expect(broker.run(baseRequest({ workItemId: "" }))).rejects.toThrow();
    expect(evaluateCalled).toBe(false);
    expect(executeCalls).toHaveLength(0);
  });
});

// Exercises storeBackedVerifier directly (not through a real
// createLinuxSandbox), so these tests don't depend on bwrap/cgroup v2/
// systemd-run actually being available on whatever host runs them - only
// packages/sandbox's own integration suite needs that. verifyAuthorityReceipt
// and verifyWorkspace (used below) are the same functions the real sandbox
// backend calls; only the process-launch step itself is skipped.
describe("CommandBroker store-backed authority", () => {
  function sandboxRequest(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      schemaVersion: "acs.sandbox-execution.v1" as const,
      workItemId: "wrk_test",
      attemptId: "attempt_test",
      leaseId: "lease_test",
      workerId: "worker_test",
      fencingToken: 1,
      authorization: { kind: "action" as const, hash: "a".repeat(64) },
      policyVersion: "acs.policy.v1",
      auditCorrelationId: "evt_test",
      idempotencyKey: "idem_test",
      workspace: { allocationId: "workspace_test", hostPath: "/tmp/workspace_test" },
      commandProfile: "git-status" as const,
      cwd: ".",
      environment: {},
      network: "none" as const,
      limits: {
        wallClockMs: 1_000,
        terminationGraceMs: 10,
        cpuQuotaPercent: 100,
        memoryBytes: 64 * 1_024 * 1_024,
        pids: 8,
        outputBytes: 1_024,
        tmpfsBytes: 1_024 * 1_024
      },
      ...overrides
    };
  }

  function fakeAuthority(
    overrides: {
      policyVersion?: string;
      workspaceHostPath?: string;
    } = {}
  ): CommandAuthority {
    return {
      attempt: {
        attemptId: "attempt_test",
        workItemId: "wrk_test",
        planId: "plan_test",
        planHash: "a".repeat(64),
        attemptNumber: 1,
        protocolVersion: "acs.worker.v2",
        inputHash: "a".repeat(64),
        status: "running",
        currentFencingEpoch: 1,
        claimedByWorkerId: "worker_test",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      lease: {
        leaseId: "lease_test",
        attemptId: "attempt_test",
        workItemId: "wrk_test",
        admissionId: "admission_test",
        workerId: "worker_test",
        tokenHash: "a".repeat(64),
        planHash: "a".repeat(64),
        inputHash: "a".repeat(64),
        fencingEpoch: 1,
        protocolVersion: "acs.worker.v2",
        policyVersion: overrides.policyVersion ?? "acs.policy.v1",
        policyDecisionHash: "a".repeat(64),
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        maxExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        lastRenewedAt: new Date().toISOString(),
        status: "active"
      },
      workspaceAllocation: {
        allocationId: "workspace_test",
        workItemId: "wrk_test",
        hostPath: overrides.workspaceHostPath ?? "/tmp/workspace_test",
        branch: "acs/job/wrk_test",
        baseRef: "main",
        status: "active",
        createdAt: new Date().toISOString()
      }
    };
  }

  it("refuses execution when the store has no matching command authority record", async () => {
    const store: CommandAuthorityStore = { getCommandAuthority: () => undefined };

    await expect(storeBackedVerifier(store).verify(sandboxRequest() as never)).rejects.toThrowError(
      expect.objectContaining({ code: "command_authority_not_found" })
    );
  });

  it("refuses execution when the persisted lease's policy version does not match the request", async () => {
    const store: CommandAuthorityStore = {
      getCommandAuthority: () => fakeAuthority({ policyVersion: "acs.policy.v2-different-from-request" })
    };

    await expect(
      storeBackedVerifier(store).verify(sandboxRequest({ policyVersion: "acs.policy.v1" }) as never)
    ).rejects.toThrowError(expect.objectContaining({ code: "command_authority_mismatch" }));
  });

  it("returns a receipt rooted in the persisted allocation's canonical workspace path, not the request's", async () => {
    const store: CommandAuthorityStore = {
      getCommandAuthority: () => fakeAuthority({ workspaceHostPath: "/real/allocation/path" })
    };

    const receipt = await storeBackedVerifier(store).verify(
      sandboxRequest({ workspace: { allocationId: "workspace_test", hostPath: "/attacker/claimed/path" } }) as never
    );

    expect(receipt.canonicalWorkspacePath).toBe("/real/allocation/path");
    expect(receipt.canonicalWorkspacePath).not.toBe("/attacker/claimed/path");
  });

  it("proves the substitution defense end to end through verifyWorkspace with real directories", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { verifyWorkspace } = await import("@agent-control-stack/sandbox");
    const realAllocation = mkdtempSync(join(tmpdir(), "acs-command-broker-real-"));
    const attackerPath = mkdtempSync(join(tmpdir(), "acs-command-broker-attacker-"));
    try {
      const store: CommandAuthorityStore = {
        getCommandAuthority: () => fakeAuthority({ workspaceHostPath: realAllocation })
      };
      const request = sandboxRequest({ workspace: { allocationId: "workspace_test", hostPath: attackerPath } });

      const receipt = await storeBackedVerifier(store).verify(request as never);

      expect(() => verifyWorkspace(request as never, receipt)).toThrowError(
        expect.objectContaining({ code: "sandbox_workspace_mismatch" })
      );
    } finally {
      rmSync(realAllocation, { recursive: true, force: true });
      rmSync(attackerPath, { recursive: true, force: true });
    }
  });
});
