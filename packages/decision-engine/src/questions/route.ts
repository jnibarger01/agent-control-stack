import type { DecisionState } from "@agent-control-stack/mission-state";
import type { z } from "zod";
import { routeQuestionSchema } from "../schemas.js";

export type RouteQuestion = z.infer<typeof routeQuestionSchema>;

export function routeQuestion(id: string, workerIds: readonly string[]): RouteQuestion {
  return routeQuestionSchema.parse({ id, type: "route", options: workerIds });
}

export function routeProjection(state: DecisionState, workerIds: readonly string[]) {
  return {
    type: "choice" as const,
    instructions: "Select the worker that should do the next generated work. Return one worker id.",
    criteria: Object.fromEntries(workerIds.map((workerId) => [workerId, workerId])),
    state: { missionId: state.missionId, goal: state.goal, workerIds }
  };
}
