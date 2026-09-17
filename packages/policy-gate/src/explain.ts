import { redactValue, stableHash } from "@agent-control-stack/shared";
import { z } from "zod";
import { actionFingerprint } from "./fingerprint.js";
import { evaluatePolicy, policyContextSchema, type PolicyContext, type PolicyDecision } from "./policy.js";

/**
 * Read-only policy explain for a candidate action.
 * Computes the action hash and decision without recording audit events or
 * executing anything. Sensitive action payloads (params, command text,
 * descriptions) are omitted/redacted from the response.
 */
export const explainPolicyInputSchema = policyContextSchema;

export const policyExplainResultSchema = z.object({
  actionHash: z.string().min(1),
  decision: z.enum(["allow", "deny", "require_approval"]),
  reason: z.string(),
  matchedRules: z.array(z.string()),
  requiredApprover: z.literal("user").optional(),
  maxRuntimeMs: z.number().int().positive().optional(),
  allowedPaths: z.array(z.string()).optional(),
  context: z.record(z.string(), z.unknown())
});

export type PolicyExplainResult = z.infer<typeof policyExplainResultSchema>;

export function explainPolicy(input: unknown): PolicyExplainResult {
  const context = policyContextSchema.parse(input);
  const decision = evaluatePolicy(context);
  return policyExplainResultSchema.parse({
    actionHash: actionFingerprint(context),
    decision: decision.decision,
    reason: decision.reason,
    matchedRules: [...decision.matchedRules],
    ...optionalDecisionFields(decision),
    context: redactedExplainContext(context)
  });
}

function optionalDecisionFields(
  decision: PolicyDecision
): Pick<PolicyExplainResult, "requiredApprover" | "maxRuntimeMs" | "allowedPaths"> {
  return {
    ...(decision.requiredApprover ? { requiredApprover: decision.requiredApprover } : {}),
    ...(decision.maxRuntimeMs !== undefined ? { maxRuntimeMs: decision.maxRuntimeMs } : {}),
    ...(decision.allowedPaths ? { allowedPaths: decision.allowedPaths } : {})
  };
}

function redactedExplainContext(context: PolicyContext): Record<string, unknown> {
  // Same receipt shape as policyContextAuditReceipt: no description, params,
  // or plaintext command — only a hash — then run shared redaction.
  return redactValue({
    workItemId: context.workItemId,
    actor: context.actor,
    operation: context.operation,
    requester: context.requester,
    risk: context.risk,
    action: {
      kind: context.action.kind
    },
    cwd: context.cwd,
    paths: context.paths,
    commandHash: context.command ? stableHash(context.command) : undefined,
    network: context.network,
    write: context.write,
    destructive: context.destructive
  }) as Record<string, unknown>;
}
