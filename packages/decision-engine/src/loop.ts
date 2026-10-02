import {
  buildDecisionState,
  dependencyReadyOperations,
  deterministicDone,
  type DecisionState
} from "@agent-control-stack/mission-state";
import { ZodError } from "zod";
import { authorizeOperation, type AuthorizationFacts } from "./authorize.js";
import { decide, DecisionModelUnavailable, DecisionParseError, type NimbleDecisionModel } from "./decide.js";
import { nextOperationQuestion } from "./questions/next-operation.js";
import { buildDecisionReceipt, type DecisionReceipt } from "./receipts.js";
import type { AuthorizationResult, DecisionResult } from "./schemas.js";
import { applyShadow, compareShadow } from "./shadow.js";
import { confidenceThreshold, type ConfidenceThresholds } from "./thresholds.js";

export type MissionPolicyFacts = Omit<AuthorizationFacts, "kind">;

export type MissionStep =
  | { readonly status: "complete" }
  | { readonly status: "blocked"; readonly reason: "no_ready_candidates" }
  | {
      readonly status: "rejected";
      readonly reason: "invalid_answer" | "selection_not_candidate";
      readonly receipt: DecisionReceipt;
    }
  | {
      readonly status: "escalate";
      readonly reason: "below_threshold" | "model_unavailable";
      readonly selectedOperationId: string | null;
      readonly receipt: DecisionReceipt;
    }
  | {
      readonly status: "denied";
      readonly selectedOperationId: string;
      readonly authorization: Extract<AuthorizationResult, { authorized: false }>;
      readonly receipt: DecisionReceipt;
    }
  | {
      readonly status: "ready";
      readonly decision: DecisionResult;
      readonly authorization: Extract<AuthorizationResult, { authorized: true }>;
      readonly receipt: DecisionReceipt;
    };

export function resolveNextOperationSelection(
  selected: string,
  candidateIds: readonly string[]
): "ok" | "selection_not_candidate" {
  return candidateIds.includes(selected) ? "ok" : "selection_not_candidate";
}

/**
 * One orchestration step. This function does not invoke tools.
 * Below-threshold selections are escalated and are not passed to authorizeOperation.
 */
export async function nextMissionAction(input: {
  readonly state: DecisionState | unknown;
  readonly model: NimbleDecisionModel;
  readonly createdAt: string;
  readonly policy: MissionPolicyFacts;
  readonly thresholds?: Partial<ConfidenceThresholds>;
  readonly shadow?: { readonly jevChoice: string | null };
}): Promise<MissionStep> {
  const state = buildDecisionState(input.state);
  const decorate = (receipt: DecisionReceipt, nimbleChoice: string | null, accepted: boolean): DecisionReceipt => {
    if (input.shadow === undefined) return receipt;
    return applyShadow(
      receipt,
      compareShadow({
        nimbleChoice: nimbleChoice ?? "",
        nimbleAccepted: accepted && nimbleChoice !== null,
        jevChoice: input.shadow.jevChoice
      })
    );
  };
  if (deterministicDone(state)) return { status: "complete" };
  const candidates = dependencyReadyOperations(state);
  if (candidates.length === 0) return { status: "blocked", reason: "no_ready_candidates" };
  const candidateIds = candidates.map((operation) => operation.id);
  const question = nextOperationQuestion("next_operation", candidateIds);
  let decided;
  try {
    decided = await decide({
      model: input.model,
      questions: [question],
      state,
      createdAt: input.createdAt,
      thresholds: input.thresholds
    });
  } catch (error) {
    if (error instanceof DecisionModelUnavailable) {
      return {
        status: "escalate",
        reason: "model_unavailable",
        selectedOperationId: null,
        receipt: decorate(
          buildDecisionReceipt({
            missionId: state.missionId,
            question,
            selectedId: null,
            confidence: 0,
            threshold: confidenceThreshold("next_operation", input.thresholds),
            state,
            modelVersion: input.model.version,
            createdAt: input.createdAt,
            payload: { unavailable: true }
          }),
          null,
          false
        )
      };
    }
    if (!(error instanceof DecisionParseError) && !(error instanceof ZodError)) throw error;
    return {
      status: "rejected",
      reason: "invalid_answer",
      receipt: decorate(
        buildDecisionReceipt({
          missionId: state.missionId,
          question,
          selectedId: null,
          confidence: 0,
          threshold: confidenceThreshold("next_operation", input.thresholds),
          state,
          modelVersion: input.model.version,
          createdAt: input.createdAt,
          payload: { invalid: true }
        }),
        null,
        false
      )
    };
  }
  const answer = decided.answers[0];
  const parsed = answer?.parsed;
  if (answer === undefined || parsed === undefined || parsed.type !== "next_operation") {
    throw new DecisionParseError("missing answer");
  }
  if (resolveNextOperationSelection(parsed.choice, candidateIds) === "selection_not_candidate") {
    return {
      status: "rejected",
      reason: "selection_not_candidate",
      receipt: decorate(answer.receipt, parsed.choice, false)
    };
  }
  if (answer.status === "below_threshold") {
    return {
      status: "escalate",
      reason: "below_threshold",
      selectedOperationId: parsed.choice,
      receipt: decorate(answer.receipt, parsed.choice, false)
    };
  }
  const operation = candidates.find((candidate) => candidate.id === parsed.choice);
  const authorization = authorizeOperation({
    ...input.policy,
    kind: operation?.kind ?? "unknown"
  });
  if (!authorization.authorized) {
    return {
      status: "denied",
      selectedOperationId: parsed.choice,
      authorization,
      receipt: decorate(answer.receipt, parsed.choice, true)
    };
  }
  return {
    status: "ready",
    decision: { selectedOperationId: parsed.choice, confidence: parsed.confidence ?? answer.receipt.confidence },
    authorization,
    receipt: decorate(answer.receipt, parsed.choice, true)
  };
}
