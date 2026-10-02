import { buildDecisionState } from "@agent-control-stack/mission-state";
import { describe, expect, it } from "vitest";
import { authorizeOperation } from "./authorize.js";
import { decide, parseDecisionBatch, type NimbleDecisionModel } from "./decide.js";
import { selectDecisionLevel } from "./hierarchy.js";
import { nextMissionAction, resolveNextOperationSelection } from "./loop.js";
import { riskProjection, riskQuestion } from "./questions/risk.js";
import { routeQuestion } from "./questions/route.js";
import { doneQuestion } from "./questions/done.js";
import { relevanceQuestion } from "./questions/relevance.js";
import { nextOperationQuestion } from "./questions/next-operation.js";
import { compareShadow } from "./shadow.js";
import { classifySideEffect } from "./side-effect.js";

const createdAt = "2026-10-02T00:00:00.000Z";

const state = buildDecisionState({
  missionId: "mis_123",
  goal: "Deploy gateway release and verify health",
  operations: [
    { id: "op_build", status: "completed", kind: "fs.read", resultId: "res_92", exitCode: 0 },
    {
      id: "op_deploy",
      status: "pending",
      kind: "git.push",
      dependsOn: ["op_build"]
    }
  ],
  constraints: { requireHealthCheck: true },
  evidence: ["build:sha256:abc"]
});

function model(answer: unknown): NimbleDecisionModel {
  return { id: "nimble", version: "2026-10-02", answer: () => answer };
}

const policy = {
  capabilities: ["git:write"],
  actionsThisMission: 1,
  requiresApproval: false,
  approved: false,
  permitId: "permit_921"
};

describe("typed decision batch", () => {
  const questions = [
    routeQuestion("q1", ["codex", "claude", "local"]),
    nextOperationQuestion("q2", ["op12", "op13", "op14"]),
    doneQuestion("q3")
  ];

  it("accepts one batch of closed answers", async () => {
    const decided = await decide({
      model: model({
        answers: [
          { id: "q1", choice: "codex", confidence: 0.93 },
          { id: "q2", choice: "op13", confidence: 0.91 },
          { id: "q3", value: false, confidence: 0.98 }
        ]
      }),
      questions,
      state,
      createdAt
    });
    expect(decided.answers.map((answer) => answer.status)).toEqual(["accepted", "accepted", "accepted"]);
    expect(decided.answers[0]?.receipt).toMatchObject({
      model: "nimble",
      modelVersion: "2026-10-02",
      missionId: "mis_123",
      question: "route",
      selectedId: "codex",
      confidence: 0.93,
      threshold: 0.8,
      fallbackUsed: false
    });
    expect(decided.answers[0]?.receipt.stateDigest.startsWith("sha256:")).toBe(true);
    expect(decided.answers[1]?.receipt.operationId).toBe("op13");
  });

  it("rejects prose and authority fields", () => {
    expect(() => parseDecisionBatch(questions, { answers: [{ id: "q1", choice: "codex", confidence: 0.9, reasoning: "because" }] })).toThrow(
      /reasoning/
    );
    expect(() =>
      parseDecisionBatch([questions[1]], {
        answers: [{ id: "q2", choice: "op13", confidence: 0.9, authorized: true, permitId: "permit_1" }]
      })
    ).toThrow(/authorized/);
    expect(() => parseDecisionBatch([questions[1]], "I think Claude should probably investigate the gateway")).toThrow(
      /choice outside options/
    );
  });

  it("rejects a choice outside the options", () => {
    expect(() => parseDecisionBatch([questions[1]], { answers: [{ id: "q2", choice: "op99", confidence: 0.99 }] })).toThrow(
      /choice outside options/
    );
  });

  it("accepts a bare operation id without treating it as measured confidence", () => {
    const parsed = parseDecisionBatch([nextOperationQuestion("next", ["op_17", "op_18"])], "op_17");
    expect(parsed[0]).toMatchObject({ choice: "op_17", confidence: null });
  });

  it("keeps the code-assigned side-effect class", () => {
    expect(classifySideEffect("git.push")).toBe("EXTERNAL_WRITE");
    expect(classifySideEffect("git.status")).toBe("READ");
    expect(classifySideEffect("not-a-tool")).toBeNull();
    const question = riskQuestion("risk", "PRODUCTION_CHANGE");
    expect(riskProjection("PRODUCTION_CHANGE", "deploy").state.sideEffectClass).toBe("PRODUCTION_CHANGE");
    expect(() =>
      parseDecisionBatch([question], {
        answers: [{ id: "risk", semanticRisk: 0.86, confidence: 0.93, sideEffectClass: "SEND" }]
      })
    ).toThrow(/side effect class is assigned by code/);
    const parsed = parseDecisionBatch([question], {
      answers: [{ id: "risk", semanticRisk: 0.86, confidence: 0.93 }]
    });
    expect(parsed[0]).toMatchObject({ sideEffectClass: "PRODUCTION_CHANGE", semanticRisk: 0.86 });
  });

  it("computes relevance keep in code", () => {
    const question = relevanceQuestion("rel", "build:sha256:abc");
    expect(parseDecisionBatch([question], { answers: [{ id: "rel", score: 0.91, confidence: 0.9 }] })[0]).toMatchObject({
      keep: true
    });
    expect(parseDecisionBatch([question], { answers: [{ id: "rel", score: 0.2, confidence: 0.95 }] })[0]).toMatchObject({
      keep: false
    });
  });
});

describe("authority stays outside the model", () => {
  it("does not authorize a below-threshold selection", async () => {
    const step = await nextMissionAction({
      state,
      createdAt,
      policy,
      model: model({ answers: [{ id: "next_operation", choice: "op_deploy", confidence: 0.5 }] })
    });
    expect(step.status).toBe("escalate");
    expect(step).not.toHaveProperty("authorization");
  });

  it("denies git.push without git:write even at high confidence", async () => {
    const step = await nextMissionAction({
      state,
      createdAt,
      policy: { ...policy, capabilities: ["fs:read"] },
      model: model({ answers: [{ id: "next_operation", choice: "op_deploy", confidence: 0.99 }] })
    });
    expect(step).toMatchObject({
      status: "denied",
      selectedOperationId: "op_deploy",
      authorization: { authorized: false, reason: "capability_missing" }
    });
  });

  it("denies an unapproved action and an exhausted action limit", () => {
    expect(
      authorizeOperation({
        kind: "fs.read",
        capabilities: [],
        actionsThisMission: 0,
        requiresApproval: true,
        approved: false,
        permitId: "permit_921"
      })
    ).toEqual({ authorized: false, reason: "approval_required" });
    expect(
      authorizeOperation({
        kind: "fs.read",
        capabilities: [],
        actionsThisMission: 100,
        requiresApproval: false,
        approved: true,
        permitId: "permit_921"
      })
    ).toEqual({ authorized: false, reason: "execution_limit" });
    expect(() =>
      authorizeOperation({
        kind: "git.push",
        capabilities: [],
        actionsThisMission: 0,
        requiresApproval: false,
        approved: true,
        permitId: "permit_921",
        authorized: true
      })
    ).toThrow();
  });

  it("echoes a caller permit only after the facts pass", async () => {
    const step = await nextMissionAction({
      state,
      createdAt,
      policy,
      model: model({ answers: [{ id: "next_operation", choice: "op_deploy", confidence: 0.96 }] })
    });
    expect(step).toMatchObject({
      status: "ready",
      decision: { selectedOperationId: "op_deploy", confidence: 0.96 },
      authorization: { authorized: true, permitId: "permit_921" }
    });
    expect(step).not.toHaveProperty("executed");
  });

  it("does not call the model when the mission is already done or has no ready operation", async () => {
    const calls: unknown[] = [];
    const watching = model({});
    const original = watching.answer;
    watching.answer = (input) => {
      calls.push(input);
      return original(input);
    };
    const done = buildDecisionState({
      missionId: "mis_123",
      goal: "Deploy",
      operations: [{ id: "op_build", status: "completed", kind: "fs.read", exitCode: 0 }],
      evidence: []
    });
    expect(await nextMissionAction({ state: done, createdAt, policy, model: watching })).toEqual({ status: "complete" });
    const blocked = buildDecisionState({
      missionId: "mis_123",
      goal: "Deploy",
      operations: [{ id: "op_deploy", status: "pending", kind: "git.push", dependsOn: ["missing"] }],
      evidence: []
    });
    expect(await nextMissionAction({ state: blocked, createdAt, policy, model: watching })).toEqual({
      status: "blocked",
      reason: "no_ready_candidates"
    });
    expect(calls).toEqual([]);
  });

  it("rejects an answer that is not a candidate", () => {
    expect(resolveNextOperationSelection("op_99", ["op_17"])).toBe("selection_not_candidate");
    expect(resolveNextOperationSelection("op_17", ["op_17"])).toBe("ok");
  });
});

describe("shadow and hierarchy", () => {
  it("keeps nimble when jev disagrees and does not invent a jev answer", () => {
    expect(compareShadow({ nimbleChoice: "op_deploy", nimbleAccepted: true, jevChoice: "op_build" })).toEqual({
      authority: "nimble",
      authoritativeModel: "nimble",
      shadowModel: "jev",
      authoritativeChoice: "op_deploy",
      disagreement: true,
      shadowDisagreement: true,
      nimbleChoice: "op_deploy",
      jevChoice: "op_build",
      shadowAnswered: true
    });
    expect(compareShadow({ nimbleChoice: "op_deploy", nimbleAccepted: false, jevChoice: "op_build" }).authoritativeChoice).toBeNull();
    expect(compareShadow({ nimbleChoice: "op_deploy", nimbleAccepted: true, jevChoice: null })).toMatchObject({
      disagreement: false,
      authoritativeChoice: "op_deploy"
    });
  });

  it("uses code, then nimble, then a generator", () => {
    expect(selectDecisionLevel({ objectiveFactAvailable: true, generationRequired: true })).toBe(0);
    expect(selectDecisionLevel({ objectiveFactAvailable: false })).toBe(1);
    expect(selectDecisionLevel({ objectiveFactAvailable: false, generationRequired: true })).toBe(2);
  });
});
