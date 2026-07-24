import { describe, expect, it } from "vitest";
import type { PolicyDecision } from "@agent-control-stack/policy-gate";
import type { SandboxBackend, SandboxExecutionObservation } from "@agent-control-stack/sandbox";
import { CommandBroker, type CommandRequest } from "./command-broker.js";

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
    const broker = new CommandBroker({ sandbox, evaluate: () => denyDecision });

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
    const broker = new CommandBroker({ sandbox, evaluate: () => requireApproval });

    const result = await broker.run(baseRequest());

    expect(result).toEqual({ outcome: "policy_denied", decision: requireApproval });
    expect(executeCalls).toHaveLength(0);
  });

  it("executes through the sandbox only when policy allows, binding the exact policy-evaluated hash", async () => {
    const { sandbox, executeCalls } = spySandbox();
    const allow: PolicyDecision = { decision: "allow", reason: "test allow", matchedRules: [] };
    const broker = new CommandBroker({ sandbox, evaluate: () => allow });

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
    const broker = new CommandBroker({ sandbox });

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
      const broker = new CommandBroker({ sandbox });

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
    const broker = new CommandBroker({ sandbox, evaluate: () => allow });

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
