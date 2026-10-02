import { z } from "zod";
import type { AuthorizationResult } from "./schemas.js";
import { CAPABILITY_FOR_CLASS, classifySideEffect } from "./side-effect.js";

const DEFAULT_ACTION_LIMIT = 100;

export const authorizationFactsSchema = z
  .object({
    kind: z.string().min(1),
    capabilities: z.array(z.string()),
    actionsThisMission: z.number().int().nonnegative(),
    actionLimit: z.number().int().positive().optional(),
    requiresApproval: z.boolean(),
    approved: z.boolean(),
    permitId: z.string().min(1)
  })
  .strict();

export type AuthorizationFacts = z.infer<typeof authorizationFactsSchema>;

/**
 * Policy predicate over caller-supplied facts.
 * A true result echoes a permit id the caller already holds. It does not mint
 * a capability, an approval, or an admission permit, and it never reads a
 * model field named authorized.
 */
export function authorizeOperation(input: unknown): AuthorizationResult {
  const facts = authorizationFactsSchema.parse(input);
  const sideEffectClass = classifySideEffect(facts.kind);
  if (sideEffectClass === null) {
    return { authorized: false, reason: "unknown_side_effect" };
  }
  const required = CAPABILITY_FOR_CLASS[sideEffectClass];
  if (required !== null && !facts.capabilities.includes(required)) {
    return { authorized: false, reason: "capability_missing" };
  }
  if (facts.actionsThisMission >= (facts.actionLimit ?? DEFAULT_ACTION_LIMIT)) {
    return { authorized: false, reason: "execution_limit" };
  }
  if (facts.requiresApproval && !facts.approved) {
    return { authorized: false, reason: "approval_required" };
  }
  return { authorized: true, permitId: facts.permitId };
}
