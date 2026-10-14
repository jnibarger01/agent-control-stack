import { z } from "zod";
import { type AdvisorOperation, ADVISOR_OPERATIONS } from "./contracts.js";

/**
 * Deterministic model pick. This is not Nimble and not an executor route (ADR 0025).
 * The first installed route whose operations include the request wins. Callers must
 * instantiate a provider for that one model only, so several large models are not
 * kept resident for a single review.
 */
export const ADVISOR_MODEL_ROLES = ["architecture", "triage", "fallback"] as const;
export type AdvisorModelRole = (typeof ADVISOR_MODEL_ROLES)[number];

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const modelName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u);

export const modelRouteSchema = z
  .object({
    role: z.enum(ADVISOR_MODEL_ROLES),
    model: modelName,
    operations: z.array(z.enum(ADVISOR_OPERATIONS)).min(1).max(ADVISOR_OPERATIONS.length),
    expectedDigest: digest.optional()
  })
  .strict();
export type ModelRoute = z.infer<typeof modelRouteSchema>;

/**
 * Candidates only. A route is usable solely when `selectModelRoute` finds the model
 * installed. Nothing here pulls or downloads a model.
 */
export const DEFAULT_MODEL_ROUTES: readonly ModelRoute[] = [
  { role: "architecture", model: "qwen3-coder:30b", operations: ["review_plan", "review_completion"] },
  { role: "triage", model: "nimble", operations: ["diagnose_failure"] },
  {
    role: "fallback",
    model: "qwen2.5-coder:7b",
    operations: ["review_plan", "diagnose_failure", "review_completion"]
  }
];

export class ModelRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelRouteError";
  }
}

export function parseModelRoutes(input: unknown): ModelRoute[] {
  const routes = z.array(modelRouteSchema).min(1).max(16).parse(input);
  return routes;
}

export function selectModelRoute(
  routes: readonly ModelRoute[],
  operation: AdvisorOperation,
  installed: ReadonlySet<string>
): ModelRoute {
  const hit = routes.find((route) => route.operations.includes(operation) && installed.has(route.model));
  if (!hit) {
    throw new ModelRouteError(`no installed local model is configured for ${operation}`);
  }
  return hit;
}
