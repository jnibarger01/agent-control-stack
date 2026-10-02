import type { DecisionState } from "@agent-control-stack/mission-state";
import type { z } from "zod";
import { nextOperationQuestionSchema } from "../schemas.js";

export type NextOperationQuestion = z.infer<typeof nextOperationQuestionSchema>;

export function nextOperationQuestion(id: string, operationIds: readonly string[]): NextOperationQuestion {
  return nextOperationQuestionSchema.parse({ id, type: "next_operation", options: operationIds });
}

export function nextOperationProjection(state: DecisionState, operationIds: readonly string[]) {
  return {
    type: "choice" as const,
    instructions: "Select the next operation id from the ready set. Return one id.",
    criteria: Object.fromEntries(operationIds.map((operationId) => [operationId, operationId])),
    state: {
      missionId: state.missionId,
      goal: state.goal,
      operations: state.operations.map((operation) => ({
        id: operation.id,
        status: operation.status,
        kind: operation.kind ?? null,
        dependsOn: operation.dependsOn ?? []
      })),
      operationIds
    }
  };
}
