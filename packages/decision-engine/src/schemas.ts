import { z } from "zod";
import { SIDE_EFFECT_CLASSES } from "./side-effect.js";

const idSchema = z.string().min(1);
const optionsSchema = z.array(idSchema).min(1);
const confidenceSchema = z.number().min(0).max(1);

export const routeQuestionSchema = z
  .object({
    id: idSchema,
    type: z.literal("route"),
    options: optionsSchema
  })
  .strict();

export const nextOperationQuestionSchema = z
  .object({
    id: idSchema,
    type: z.literal("next_operation"),
    options: optionsSchema
  })
  .strict();

export const relevanceQuestionSchema = z
  .object({
    id: idSchema,
    type: z.literal("relevance"),
    evidenceId: idSchema
  })
  .strict();

export const doneQuestionSchema = z
  .object({
    id: idSchema,
    type: z.literal("done")
  })
  .strict();

export const riskQuestionSchema = z
  .object({
    id: idSchema,
    type: z.literal("risk"),
    sideEffectClass: z.enum(SIDE_EFFECT_CLASSES)
  })
  .strict();

export const decisionQuestionSchema = z.discriminatedUnion("type", [
  routeQuestionSchema,
  nextOperationQuestionSchema,
  relevanceQuestionSchema,
  doneQuestionSchema,
  riskQuestionSchema
]);

export const decisionAnswerSchema = z
  .object({
    id: idSchema,
    choice: idSchema.optional(),
    value: z.boolean().optional(),
    score: confidenceSchema.optional(),
    semanticRisk: confidenceSchema.optional(),
    confidence: confidenceSchema.optional(),
    sideEffectClass: z.enum(SIDE_EFFECT_CLASSES).optional()
  })
  .strict();

export type DecisionQuestion = z.infer<typeof decisionQuestionSchema>;
export type DecisionType = DecisionQuestion["type"];
export type DecisionAnswer = z.infer<typeof decisionAnswerSchema>;

export type DecisionResult = {
  readonly selectedOperationId: string;
  readonly confidence: number;
};

export type AuthorizationResult =
  | { readonly authorized: true; readonly permitId: string }
  | { readonly authorized: false; readonly reason: string };
