import type { DecisionState } from "@agent-control-stack/mission-state";
import { stableHash } from "@agent-control-stack/shared";
import type { DecisionQuestion, DecisionType } from "./schemas.js";

export type DecisionReceipt = {
  readonly receiptId: string;
  readonly missionId: string;
  readonly operationId: string | null;
  readonly question: DecisionType;
  readonly candidateIds: readonly string[];
  readonly selectedId: string | null;
  readonly model: "nimble";
  readonly modelVersion: string;
  readonly confidence: number;
  readonly threshold: number;
  readonly stateDigest: string;
  readonly decisionDigest: string;
  readonly fallbackUsed: boolean;
  readonly createdAt: string;
  /** Nimble made the selection. This field is not an authorization. */
  readonly authoritativeModel: "nimble";
  /** Set only when a shadow model was consulted. Null is not agreement. */
  readonly shadowModel: "jev" | null;
  readonly shadowDisagreement: boolean;
  readonly shadowAnswered: boolean;
};

export function candidateIdsFor(question: DecisionQuestion): string[] {
  if (question.type === "route" || question.type === "next_operation") return [...question.options];
  if (question.type === "relevance") return [question.evidenceId];
  if (question.type === "risk") return [question.sideEffectClass];
  return [];
}

export function buildDecisionReceipt(input: {
  readonly missionId: string;
  readonly question: DecisionQuestion;
  readonly selectedId: string | null;
  readonly confidence: number;
  readonly threshold: number;
  readonly state: DecisionState;
  readonly modelVersion: string;
  readonly createdAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}): DecisionReceipt {
  const candidateIds = candidateIdsFor(input.question);
  const stateDigest = `sha256:${stableHash(input.state)}`;
  const decisionDigest = `sha256:${stableHash({
    question: input.question.type,
    questionId: input.question.id,
    candidates: candidateIds,
    selected: input.selectedId,
    confidence: input.confidence,
    model: "nimble",
    payload: input.payload
  })}`;
  const receiptId = `dec_${stableHash({
    missionId: input.missionId,
    stateDigest,
    decisionDigest
  }).slice(0, 24)}`;
  return {
    receiptId,
    missionId: input.missionId,
    operationId: input.question.type === "next_operation" ? input.selectedId : null,
    question: input.question.type,
    candidateIds,
    selectedId: input.selectedId,
    model: "nimble",
    modelVersion: input.modelVersion,
    confidence: input.confidence,
    threshold: input.threshold,
    stateDigest,
    decisionDigest,
    fallbackUsed: input.confidence < input.threshold,
    createdAt: input.createdAt,
    authoritativeModel: "nimble",
    shadowModel: null,
    shadowDisagreement: false,
    shadowAnswered: false
  };
}
