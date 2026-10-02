import { describe, expect, it } from "vitest";
import {
  buildDecisionState,
  DecisionStateError,
  dependencyReadyOperations,
  deterministicDone
} from "./build-decision-state.js";

const state = {
  missionId: "mis_123",
  goal: "Deploy gateway release and verify health",
  operations: [
    { id: "op_build", status: "completed", kind: "fs.read", resultId: "res_92", exitCode: 0 },
    { id: "op_deploy", status: "completed", kind: "deploy", resultId: "res_93", deploymentId: "dep_17", dependsOn: ["op_build"] },
    { id: "op_verify", status: "pending", kind: "health_check", dependsOn: ["op_deploy"] }
  ],
  constraints: { requireHealthCheck: true },
  evidence: ["build:sha256:abc", "deployment:dep_17"]
};

describe("decision state", () => {
  it("keeps facts and drops nothing the schema allows", () => {
    expect(buildDecisionState(state)).toMatchObject({
      missionId: "mis_123",
      evidence: ["build:sha256:abc", "deployment:dep_17"]
    });
  });

  it("rejects narrative fields", () => {
    expect(() => buildDecisionState({ ...state, summary: "it mostly worked" })).toThrow(DecisionStateError);
    expect(() => buildDecisionState({ ...state, summary: "it mostly worked" })).toThrow(/narrative field rejected: summary/);
    expect(() =>
      buildDecisionState({
        ...state,
        operations: [{ ...state.operations[0], reasoning: "probably fine" }]
      })
    ).toThrow(/reasoning/);
  });

  it("is done only when every operation succeeded and a required health fact exists", () => {
    expect(deterministicDone(buildDecisionState(state))).toBe(false);
    const verified = buildDecisionState({
      ...state,
      operations: [
        state.operations[0],
        state.operations[1],
        { id: "op_verify", status: "completed", kind: "health_check", exitCode: 0, dependsOn: ["op_deploy"] }
      ],
      evidence: [...state.evidence, "health:ok"]
    });
    expect(deterministicDone(verified)).toBe(true);
    expect(
      deterministicDone(
        buildDecisionState({
          ...state,
          constraints: { requireHealthCheck: true },
          operations: [state.operations[0], state.operations[1]],
          evidence: [...state.evidence, "health:ok"]
        })
      )
    ).toBe(true);
  });

  it("does not treat an empty mission or a failed exit as done", () => {
    expect(
      deterministicDone(buildDecisionState({ missionId: "mis_123", goal: "Deploy", operations: [], evidence: [] }))
    ).toBe(false);
    expect(
      deterministicDone(
        buildDecisionState({
          missionId: "mis_123",
          goal: "Deploy",
          operations: [{ id: "op_build", status: "completed", exitCode: 1 }],
          evidence: []
        })
      )
    ).toBe(false);
  });

  it("returns pending operations whose dependencies are complete", () => {
    const ready = dependencyReadyOperations(buildDecisionState(state));
    expect(ready.map((operation) => operation.id)).toEqual(["op_verify"]);
    const blocked = buildDecisionState({
      ...state,
      operations: [
        { id: "op_build", status: "pending", kind: "fs.read" },
        { id: "op_deploy", status: "pending", kind: "deploy", dependsOn: ["op_build"] }
      ]
    });
    expect(dependencyReadyOperations(blocked).map((operation) => operation.id)).toEqual(["op_build"]);
  });
});
