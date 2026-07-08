import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import {
  type ApprovalGrant,
  approvalRequestHash,
  approvalRequestSchema,
  cancelRequestSchema,
  rejectRequestSchema,
  type ClaimedWorkItem,
  type PrivilegedTransitionOptions,
  type WorkItem,
  type WorkItemStore
} from "@agent-control-stack/work-items";
import { z } from "zod";
import type { PolicyContext, PolicyDecision, PolicyEngine, PolicyEvaluation, PolicyOperation } from "./policy.js";

export const workItemToolNames = [
  "create_work_item",
  "get_work_item",
  "list_work_items",
  "approve_work_item",
  "unblock_work_item",
  "reject_work_item",
  "cancel_work_item"
] as const;

const idInputSchema = z.object({ id: z.string().min(1) });
const unblockInputSchema = idInputSchema.extend({ actor: z.string().min(1).default("system") });
const claimInputSchema = z.object({
  workerId: z.string().min(1),
  leaseMs: z.number().int().positive().optional()
});
const approvalInputSchema = idInputSchema.merge(approvalRequestSchema);
const cancelInputSchema = idInputSchema.merge(cancelRequestSchema);
const rejectInputSchema = idInputSchema.merge(rejectRequestSchema);
const policyTransition = { via: "policy_gate" } satisfies PrivilegedTransitionOptions;
const domainTransition = { via: "domain_service" } satisfies PrivilegedTransitionOptions;

export function evaluateAndRecordPolicy(
  store: WorkItemStore,
  policy: PolicyEngine,
  workItem: WorkItem,
  actor: string,
  operation: PolicyOperation
): { decision: PolicyDecision; evaluations: PolicyEvaluation[] } {
  const evaluations = policy.evaluateWorkItem(workItem, actor, operation);
  const decision = policy.summarize(evaluations);
  if (evaluations.length === 0) {
    store.recordPolicyDecision({
      workItemId: workItem.id,
      actionHash: stableHash({ workItemId: workItem.id, operation, actions: [] }),
      context: { workItemId: workItem.id, actor, operation, actions: [] },
      ...decision
    });
    return { decision, evaluations };
  }

  for (const evaluation of evaluations) {
    store.recordPolicyDecision({
      workItemId: workItem.id,
      actionHash: evaluation.actionHash,
      context: policyContextAuditReceipt(evaluation.context),
      ...evaluation.decision
    });
  }
  return { decision, evaluations };
}

export function applyPolicyStatus(store: WorkItemStore, workItem: WorkItem, decision: PolicyDecision): WorkItem {
  if (decision.decision === "deny") {
    return workItem.status === "blocked" ? workItem : store.blockWorkItem(workItem.id);
  }

  const pending = workItem.status === "draft" ? store.transition(workItem.id, "pending_policy", policyTransition) : workItem;
  if (decision.decision === "require_approval") {
    return pending.status === "needs_approval" ? pending : store.transition(pending.id, "needs_approval", policyTransition);
  }
  return pending.status === "approved" ? pending : store.approveWorkItem(pending.id, policyTransition);
}

export function gateApproval(
  store: WorkItemStore,
  policy: PolicyEngine,
  input: unknown
): { decision: PolicyDecision; workItem: WorkItem; approvals: ApprovalGrant[] } {
  if (!hasActionHash(input)) {
    throw new ControlStackError("approval_action_hash_required", "approval_action_hash_required: actionHash is required");
  }
  const parsed = approvalInputSchema.parse(input);
  return store.withTransaction(() => gateApprovalInTransaction(store, policy, parsed));
}

function gateApprovalInTransaction(
  store: WorkItemStore,
  policy: PolicyEngine,
  parsed: z.infer<typeof approvalInputSchema>
): { decision: PolicyDecision; workItem: WorkItem; approvals: ApprovalGrant[] } {
  const workItem = store.get(parsed.id);
  if (!workItem) {
    throw new ControlStackError("work_item_not_found", `work item not found: ${parsed.id}`);
  }

  const { decision, evaluations } = evaluateAndRecordPolicy(store, policy, workItem, parsed.approvedBy, "approve");
  if (decision.decision === "deny") {
    return { decision, workItem, approvals: [] };
  }

  const required = approvalRequired(evaluations);
  const requiredHashes = new Set(required.map((evaluation) => evaluation.actionHash));
  const requestedHashes = new Set(evaluations.map((evaluation) => evaluation.actionHash));
  const hashes = [parsed.actionHash];

  const approvals: ApprovalGrant[] = [];
  for (const actionHash of hashes) {
    if (!requestedHashes.has(actionHash)) {
      throw new ControlStackError("approval_action_mismatch", `approval action hash does not match work item: ${actionHash}`);
    }
    if (!requiredHashes.has(actionHash)) {
      throw new ControlStackError("approval_not_required", `approval is not required for action hash: ${actionHash}`);
    }
    approvals.push(store.recordApproval({
      workItemId: workItem.id,
      actionHash,
      approvedBy: parsed.approvedBy,
      reason: parsed.reason
    }));
  }

  const missingApproval = required.find((evaluation) => !store.hasApproval(workItem.id, evaluation.actionHash));

  return {
    decision,
    workItem: missingApproval || workItem.status === "approved" ? workItem : store.approveWorkItem(workItem.id, policyTransition),
    approvals
  };
}

function hasActionHash(input: unknown): boolean {
  return (
    !!input &&
    typeof input === "object" &&
    typeof (input as { actionHash?: unknown }).actionHash === "string" &&
    (input as { actionHash: string }).actionHash.trim().length > 0
  );
}

export function gateUnblock(
  store: WorkItemStore,
  policy: PolicyEngine,
  input: unknown
): { decision: PolicyDecision; workItem: WorkItem } {
  const parsed = unblockInputSchema.parse(input);
  return store.withTransaction(() => gateUnblockInTransaction(store, policy, parsed));
}

function gateUnblockInTransaction(
  store: WorkItemStore,
  policy: PolicyEngine,
  parsed: z.infer<typeof unblockInputSchema>
): { decision: PolicyDecision; workItem: WorkItem } {
  const workItem = store.get(parsed.id);
  if (!workItem) {
    throw new ControlStackError("work_item_not_found", `work item not found: ${parsed.id}`);
  }

  const { decision } = evaluateAndRecordPolicy(store, policy, workItem, parsed.actor, "unblock");
  if (decision.decision === "deny") {
    return { decision, workItem: workItem.status === "blocked" ? workItem : store.blockWorkItem(workItem.id) };
  }

  const pending = workItem.status === "blocked" ? store.unblockWorkItem(workItem.id, policyTransition) : workItem;
  if (decision.decision === "require_approval") {
    return {
      decision,
      workItem: pending.status === "needs_approval" ? pending : store.transition(pending.id, "needs_approval", policyTransition)
    };
  }
  return {
    decision,
    workItem: pending.status === "pending_policy" ? pending : store.transition(pending.id, "pending_policy", policyTransition)
  };
}

export function gateWorkerClaim(store: WorkItemStore, policy: PolicyEngine, input: unknown): ClaimedWorkItem | undefined {
  const parsed = claimInputSchema.parse(input);
  return store.withTransaction(() => gateWorkerClaimInTransaction(store, policy, parsed));
}

function gateWorkerClaimInTransaction(
  store: WorkItemStore,
  policy: PolicyEngine,
  parsed: z.infer<typeof claimInputSchema>
): ClaimedWorkItem | undefined {
  const running = store.claimNextApprovedWorkItem(parsed.workerId, { leaseMs: parsed.leaseMs });
  if (!running) {
    return undefined;
  }

  const { decision, evaluations } = evaluateAndRecordPolicy(store, policy, running, parsed.workerId, "claim");
  const required = approvalRequired(evaluations);
  const missing = required.find((evaluation) => !store.hasApproval(running.id, evaluation.actionHash));
  let approvalFailure: unknown;
  if (decision.decision !== "deny" && !missing) {
    for (const evaluation of required) {
      try {
        store.consumeApproval(running.id, evaluation.actionHash, {
          requestHash: approvalRequestHash(running.id, evaluation.actionHash)
        });
      } catch (error) {
        approvalFailure = error;
        break;
      }
    }
  }
  if (decision.decision === "deny" || missing || approvalFailure) {
    const blocked = store.submitWorkResult({
      id: running.id,
      workerId: parsed.workerId,
      leaseToken: running.leaseToken,
      status: "blocked",
      result: { error: missing ? "approval missing for action hash" : approvalFailure ? errorMessage(approvalFailure) : decision.reason }
    });
    return {
      ...blocked,
      workerId: running.workerId,
      leaseToken: running.leaseToken,
      leaseExpiresAt: running.leaseExpiresAt
    };
  }

  return running;
}

export function createWorkItemTools(store: WorkItemStore, policy: PolicyEngine) {
  return {
    create_work_item(input: unknown): WorkItem {
      return store.withTransaction(() => {
        const workItem = store.create(input);
        const { decision } = evaluateAndRecordPolicy(store, policy, workItem, workItem.requester, "create");
        return applyPolicyStatus(store, workItem, decision);
      });
    },
    get_work_item(input: unknown): WorkItem | undefined {
      const parsed = idInputSchema.parse(input);
      return store.get(parsed.id);
    },
    list_work_items(input: unknown = {}): WorkItem[] {
      return store.list(input);
    },
    approve_work_item(input: unknown): { decision: PolicyDecision; workItem: WorkItem; approvals: ApprovalGrant[] } {
      return gateApproval(store, policy, input);
    },
    unblock_work_item(input: unknown): { decision: PolicyDecision; workItem: WorkItem } {
      return gateUnblock(store, policy, input);
    },
    reject_work_item(input: unknown): WorkItem {
      const parsed = rejectInputSchema.parse(input);
      return store.rejectWorkItem(parsed.id, parsed, domainTransition);
    },
    cancel_work_item(input: unknown): WorkItem {
      const parsed = cancelInputSchema.parse(input);
      return store.cancelWorkItem(parsed.id, parsed, domainTransition);
    },
    claim_next_approved_work_item(input: unknown): ClaimedWorkItem | undefined {
      return gateWorkerClaim(store, policy, input);
    },
    submit_work_result(input: unknown): WorkItem {
      return store.submitWorkResult(input);
    }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "approval validation failed";
}

function approvalRequired(evaluations: PolicyEvaluation[]): PolicyEvaluation[] {
  return evaluations.filter((evaluation) => evaluation.decision.decision === "require_approval");
}

function policyContextAuditReceipt(context: PolicyContext): Record<string, unknown> {
  return {
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
  };
}
