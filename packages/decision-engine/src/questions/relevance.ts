import type { z } from "zod";
import { relevanceQuestionSchema } from "../schemas.js";

export type RelevanceQuestion = z.infer<typeof relevanceQuestionSchema>;

export function relevanceQuestion(id: string, evidenceId: string): RelevanceQuestion {
  return relevanceQuestionSchema.parse({ id, type: "relevance", evidenceId });
}

export function relevanceProjection(goal: string, evidenceId: string) {
  return {
    type: "score" as const,
    instructions: "Score how useful this evidence ref is for the goal. Do not summarize it.",
    criteria: [
      "The ref is unrelated to the goal.",
      "The ref might matter, but the recorded facts do not show that it does.",
      "The ref is needed to judge the goal."
    ],
    state: { goal, evidenceId }
  };
}
