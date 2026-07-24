import { ControlStackError } from "@agent-control-stack/shared";
import type {
  EngineIsolation,
  EngineIsolationAuthorityReceipt,
  EngineIsolationAuthorityVerifier,
  EngineIsolationObservation,
  EngineIsolationRequest
} from "@agent-control-stack/sandbox";
import { describe, expect, it } from "vitest";
import { ClaudeVerifier, buildClaudeVerifierArgs } from "./claude-verifier.js";
import type { VerificationCriterion, VerificationEvidence } from "./types.js";

describe("buildClaudeVerifierArgs", () => {
  it("always disables tool use and pins permission-mode to plan", () => {
    const args = buildClaudeVerifierArgs("claude-sonnet-5", 0.5);
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
    expect(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2)).toEqual([
      "--permission-mode",
      "plan"
    ]);
    expect(args).toContain("--json-schema");
    expect(args).toContain("--no-session-persistence");
  });
});

function criteria(): VerificationCriterion[] {
  return [{ id: "c1", description: "tests pass", expected: "exit code 0" }];
}

function evidence(): VerificationEvidence {
  return {
    workItemId: "wrk_test",
    implementerClaim: "tests passed",
    diffSummary: "added a function",
    commandResults: [{ commandProfile: "npm-test", exitCode: 0, observedSuccess: true, stdout: "ok", stderr: "" }]
  };
}

function claudeEnvelope(resultObject: unknown): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify(resultObject)
  });
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

function fakeObservation(overrides: Partial<EngineIsolationObservation> = {}): EngineIsolationObservation {
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
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1).toISOString(),
    durationMs: 1,
    enforcedLimits: {
      wallClockMs: 1_000,
      terminationGraceMs: 100,
      cpuQuotaPercent: 100,
      memoryBytes: 1,
      pids: 1,
      outputBytes: 1,
      tmpfsBytes: 1
    },
    egressAllowedCount: 0,
    egressDeniedCount: 0,
    egressDeniedSample: [],
    ...overrides
  };
}

function verifierWithFakeIsolation(
  respond: (request: EngineIsolationRequest) => EngineIsolationObservation | Promise<EngineIsolationObservation>
): ClaudeVerifier {
  const stub: EngineIsolation = {
    preflight: async () => {},
    execute: async (input: unknown) => respond(input as EngineIsolationRequest)
  };
  return new ClaudeVerifier({
    binaryPath: "/usr/bin/true",
    authorityVerifier: fakeAuthority(),
    scratchWorkspace: { allocationId: "scratch", hostPath: "/tmp" },
    credentialSource: () => "fake-anthropic-key",
    isolationFactory: () => stub
  });
}

describe("ClaudeVerifier", () => {
  it("parses a genuine pass verdict from the CLI envelope", async () => {
    const verifier = verifierWithFakeIsolation(() =>
      fakeObservation({
        stdout: claudeEnvelope({
          verdict: "pass",
          summary: "all criteria satisfied",
          criteriaResults: [{ criterionId: "c1", satisfied: true, observed: "exit code 0" }]
        })
      })
    );

    const result = await verifier.verify(criteria(), evidence());

    expect(result.verdict).toBe("pass");
    expect(result.verifierEngineId).toBe("claude-cli-verifier");
    expect(result.criteriaResults).toEqual([{ criterionId: "c1", satisfied: true, observed: "exit code 0" }]);
  });

  it("parses an inconclusive verdict without coercing it to pass or fail", async () => {
    const verifier = verifierWithFakeIsolation(() =>
      fakeObservation({
        stdout: claudeEnvelope({
          verdict: "inconclusive",
          summary: "evidence does not show whether the test suite actually ran",
          criteriaResults: [{ criterionId: "c1", satisfied: false, observed: "no test runner output present" }]
        })
      })
    );

    const result = await verifier.verify(criteria(), evidence());

    expect(result.verdict).toBe("inconclusive");
  });

  it("rejects a claimed pass verdict whose own criteria list contradicts it", async () => {
    const verifier = verifierWithFakeIsolation(() =>
      fakeObservation({
        stdout: claudeEnvelope({
          verdict: "pass",
          summary: "claims pass despite an unsatisfied criterion",
          criteriaResults: [{ criterionId: "c1", satisfied: false, observed: "tests actually failed" }]
        })
      })
    );

    await expect(verifier.verify(criteria(), evidence())).rejects.toThrow();
  });

  it("throws a typed error on a malformed (non-JSON) CLI response", async () => {
    const verifier = verifierWithFakeIsolation(() => fakeObservation({ stdout: "not json at all" }));

    await expect(verifier.verify(criteria(), evidence())).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "verifier_invalid_response" })
    );
  });

  it("throws a typed error when the CLI reports an error subtype", async () => {
    const verifier = verifierWithFakeIsolation(() =>
      fakeObservation({
        stdout: JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, result: "" })
      })
    );

    await expect(verifier.verify(criteria(), evidence())).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "verifier_invalid_response" })
    );
  });

  it("passes exactly one credential into the isolation request and never the wider environment", async () => {
    let capturedCredential: unknown;
    const verifier = verifierWithFakeIsolation((request) => {
      capturedCredential = request.credential;
      return fakeObservation({
        stdout: claudeEnvelope({
          verdict: "pass",
          summary: "s",
          criteriaResults: [{ criterionId: "c1", satisfied: true, observed: "ok" }]
        })
      });
    });

    await verifier.verify(criteria(), evidence());

    expect(capturedCredential).toEqual({ envName: "ANTHROPIC_API_KEY", envValue: "fake-anthropic-key" });
  });

  it("throws a typed error rather than invoking the isolation boundary when no credential is available", async () => {
    const verifier = new ClaudeVerifier({
      binaryPath: "/usr/bin/true",
      authorityVerifier: fakeAuthority(),
      scratchWorkspace: { allocationId: "scratch", hostPath: "/tmp" },
      credentialSource: () => undefined,
      isolationFactory: () => ({
        preflight: async () => {},
        execute: async () => {
          throw new Error("isolation should never be invoked without a credential");
        }
      })
    });

    await expect(verifier.verify(criteria(), evidence())).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "verifier_credential_unavailable" })
    );
  });

  it("maps an isolation timeout outcome to a typed verifier_timeout error", async () => {
    const verifier = verifierWithFakeIsolation(() => fakeObservation({ outcome: "timed_out", exitCode: null }));

    await expect(verifier.verify(criteria(), evidence())).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "verifier_timeout" })
    );
  });

  it("maps a non-zero exit outcome to a typed verifier_process_failed error", async () => {
    const verifier = verifierWithFakeIsolation(() => fakeObservation({ exitCode: 1, observedSuccess: false }));

    await expect(verifier.verify(criteria(), evidence())).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "verifier_process_failed" })
    );
  });
});
