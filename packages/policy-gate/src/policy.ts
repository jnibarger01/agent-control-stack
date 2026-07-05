import type { ActionRequest, WorkItem } from "@agent-control-stack/work-items";
import { z } from "zod";
import { actionFingerprint } from "./fingerprint.js";
import { evaluateRules } from "./rules.js";

export const policyDecisionSchema = z.object({
  decision: z.enum(["allow", "deny", "require_approval"]),
  reason: z.string(),
  matchedRules: z.array(z.string()),
  requiredApprover: z.literal("user").optional(),
  maxRuntimeMs: z.number().int().positive().optional(),
  allowedPaths: z.array(z.string()).optional()
});

export const policyContextSchema = z.object({
  workItemId: z.string().min(1),
  actor: z.string().min(1),
  action: z.object({
    kind: z.string().min(1),
    description: z.string().min(1),
    params: z.record(z.string(), z.unknown()).default({})
  }),
  cwd: z.string().min(1).optional(),
  command: z.array(z.string().min(1)).optional(),
  paths: z.array(z.string().min(1)).optional(),
  network: z.boolean().optional(),
  write: z.boolean().optional(),
  destructive: z.boolean().optional()
});

export type PolicyDecision = z.infer<typeof policyDecisionSchema>;
export type PolicyContext = z.infer<typeof policyContextSchema>;

export interface PolicyEvaluation {
  action: ActionRequest;
  actionHash: string;
  context: PolicyContext;
  decision: PolicyDecision;
}

export function evaluatePolicy(input: unknown): PolicyDecision {
  const context = policyContextSchema.parse(input);
  return policyDecisionSchema.parse(evaluateRules(context));
}

export function evaluateWorkItemPolicy(workItem: WorkItem, actor: string): PolicyEvaluation[] {
  return workItem.requestedActions.map((action) => {
    const context = policyContextFromAction(workItem, action, actor);
    return {
      action,
      actionHash: actionFingerprint(context),
      context,
      decision: evaluatePolicy(context)
    };
  });
}

export function policyContextFromAction(workItem: WorkItem, action: ActionRequest, actor: string): PolicyContext {
  const params = action.params;
  const command = stringArray(params.command);
  const paths = stringArray(params.paths) ?? workItem.target.files;
  return policyContextSchema.parse({
    workItemId: workItem.id,
    actor,
    action,
    cwd: stringValue(params.cwd) ?? workItem.target.cwd,
    command,
    paths,
    network: booleanValue(params.network),
    write: booleanValue(params.write),
    destructive: booleanValue(params.destructive)
  });
}

export function summarizePolicy(evaluations: PolicyEvaluation[]): PolicyDecision {
  if (evaluations.length === 0) {
    return { decision: "deny", reason: "work item has no requested actions", matchedRules: ["deny:fail-closed"] };
  }
  const denial = evaluations.find((evaluation) => evaluation.decision.decision === "deny");
  if (denial) {
    return denial.decision;
  }
  const approval = evaluations.find((evaluation) => evaluation.decision.decision === "require_approval");
  if (approval) {
    return approval.decision;
  }
  return {
    decision: "allow",
    reason: "all actions allowed",
    matchedRules: [...new Set(evaluations.flatMap((evaluation) => evaluation.decision.matchedRules))]
  };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.every((entry) => typeof entry === "string" && entry.length > 0) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
