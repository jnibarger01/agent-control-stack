import type { z } from "zod";
import { riskQuestionSchema } from "../schemas.js";
import type { SideEffectClass } from "../side-effect.js";

export type RiskQuestion = z.infer<typeof riskQuestionSchema>;

export function riskQuestion(id: string, sideEffectClass: SideEffectClass): RiskQuestion {
  return riskQuestionSchema.parse({ id, type: "risk", sideEffectClass });
}

/** The class is an input fact. The score judges uncertainty inside that class. */
export function riskProjection(sideEffectClass: SideEffectClass, actionKind: string) {
  return {
    type: "score" as const,
    instructions: "Rate semantic uncertainty for this action inside its assigned side-effect class. Do not change the class.",
    criteria: [
      "The effect inside this class is obvious from the action kind.",
      "The effect inside this class is partly ambiguous.",
      "The effect inside this class is likely different from what the kind usually means."
    ],
    state: { sideEffectClass, actionKind }
  };
}
