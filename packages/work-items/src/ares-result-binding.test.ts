import { describe, expect, it } from "vitest";
import { defaultExecutionPlanForWorkItem } from "./execution-plan.js";
import { stableHash } from "@agent-control-stack/shared";
import { assertAresResultBinding, createWorkItem, type SubmitWorkResultInput } from "./work-item.js";

const argsHash = "a".repeat(64);
const item = createWorkItem({
  title: "synthetic",
  requester: "user",
  requesterSubject: "acs-alice",
  intent: "test",
  target: { services: ["ares"] },
  risk: "medium",
  requestedActions: [
    { kind: "ares.spec.seal", description: "seal", params: { aresArgsHash: argsHash, aresPrincipal: "local-alice" } }
  ]
});
const result: Pick<SubmitWorkResultInput, "simulationMetadata" | "attemptId" | "structuredOutput" | "workerId"> = {
  workerId: "ares",
  attemptId: "attempt_1",
  structuredOutput: { aresArgsHash: argsHash, resultDigest: null },
  simulationMetadata: {
    executionMode: "ares",
    simulated: false,
    backend: "ares-studio",
    toolName: "ares.spec.seal",
    requestId: "attempt_1",
    invocationFingerprint: stableHash({
      domain: "ares.invocation.v1",
      attemptId: "attempt_1",
      argsHash,
      resultDigest: null
    })
  }
};

describe("ARES result receipt binding", () => {
  it("creates an explicitly ARES plan independently of the process-wide local worker backend", () => {
    expect(defaultExecutionPlanForWorkItem(item).constraints.executionMode).toBe("ares");
    expect(
      defaultExecutionPlanForWorkItem(item, { executionMode: "desktop_commander" }).constraints.executionMode
    ).toBe("ares");
  });
  it("accepts an exact receipt with a local principal distinct from the ACS subject", () => {
    expect(() => assertAresResultBinding(item, result)).not.toThrow();
  });
  it.each([
    { workerId: "other" },
    { attemptId: "attempt_other" },
    { attemptId: undefined },
    { structuredOutput: { aresArgsHash: "b".repeat(64), resultDigest: null } },
    { structuredOutput: { aresArgsHash: argsHash, resultDigest: "malformed" } },
    { structuredOutput: { aresArgsHash: argsHash } }
  ])("refuses mismatched receipt %#", (changed) => {
    expect(() => assertAresResultBinding(item, { ...result, ...changed })).toThrow();
  });
  it("refuses ARES receipts for ordinary work and dry runs for ARES work", () => {
    expect(() =>
      assertAresResultBinding(
        { ...item, requestedActions: [{ kind: "system.status", description: "read", params: {} }] },
        result
      )
    ).toThrow();
    expect(() =>
      assertAresResultBinding(item, { ...result, simulationMetadata: { executionMode: "dry_run", simulated: true } })
    ).toThrow();
  });
});
