import type { DecisionState } from "@agent-control-stack/mission-state";
import type { z } from "zod";
import { doneQuestionSchema } from "../schemas.js";

export type DoneQuestion = z.infer<typeof doneQuestionSchema>;

export function doneQuestion(id: string): DoneQuestion {
  return doneQuestionSchema.parse({ id, type: "done" });
}

export function doneProjection(state: DecisionState) {
  return {
    type: "noul" as const,
    instructions: "Do the recorded operation facts already satisfy the goal? Answer yes or no.",
    state: {
      missionId: state.missionId,
      goal: state.goal,
      operations: state.operations.map((operation) => ({
        id: operation.id,
        status: operation.status,
        exitCode: operation.exitCode ?? null
      })),
      evidence: state.evidence
    }
  };
}
