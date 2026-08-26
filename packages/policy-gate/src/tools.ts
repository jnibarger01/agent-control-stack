import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import {
  type ApprovalGrant,
  approvalRequestHash,
  approvalRequestSchema,
  cancelRequestSchema,
  defaultExecutionPlanForWorkItem,
  rejectRequestSchema,
  type ClaimedWorkItem,
  type PrivilegedTransitionOptions,
  type WorkItem,
  type WorkItemStore
} from "@agent-control-stack/work-items";
import { z } from "zod";
import { evaluateContractAdmission } from "./contracts.js";
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
const unblockInputSchema = idInputSchema.extend({ actor: z.string().min(1) });
const claimInputSchema = z.object({
  workerId: z.string().min(1),
  leaseMs: z.number().int().positive().optional()
});
const approvalInputSchema = idInputSchema.merge(approvalRequestSchema);
const cancelInputSchema = idInputSchema.merge(cancelRequestSchema);
const rejectInputSchema = idInputSchema.merge(rejectRequestSchema);
const retryInputSchema = idInputSchema.extend({ actor: z.string().min(1), reason: z.string().min(1).max(2_000) });
const cloneInputSchema = idInputSchema.extend({
  actor: z.string().min(1),
  title: z.string().min(1).max(512).optional(),
  intent: z.string().min(1).max(4_000).optional(),
  target: z.record(z.string(), z.unknown()).optional(),
  requestedActions: z
    .array(
      z.object({
        kind: z.string().min(1),
        description: z.string().min(1),
        params: z.record(z.string(), z.unknown()).default({})
      })
    )
    .max(32)
    .optional(),
  risk: z.enum(["low", "medium", "high", "critical"]).optional()
});
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

  const pending =
    workItem.status === "draft" ? store.transition(workItem.id, "pending_policy", policyTransition) : workItem;
  if (decision.decision === "require_approval") {
    return pending.status === "needs_approval"
      ? pending
      : store.transition(pending.id, "needs_approval", policyTransition);
  }
  return pending.status === "approved" ? pending : store.approveWorkItem(pending.id, policyTransition);
}

export function gateApproval(
  store: WorkItemStore,
  policy: PolicyEngine,
  input: unknown
): { decision: PolicyDecision; workItem: WorkItem; approvals: ApprovalGrant[] } {
  if (!hasActionHash(input)) {
    throw new ControlStackError(
      "approval_action_hash_required",
      "approval_action_hash_required: actionHash is required"
    );
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
      throw new ControlStackError(
        "approval_action_mismatch",
        `approval action hash does not match work item: ${actionHash}`
      );
    }
    if (!requiredHashes.has(actionHash)) {
      throw new ControlStackError("approval_not_required", `approval is not required for action hash: ${actionHash}`);
    }
    approvals.push(
      store.recordApproval({
        workItemId: workItem.id,
        actionHash,
        approvedBy: parsed.approvedBy,
        reason: parsed.reason
      })
    );
    const plan = ensureExecutionPlan(store, workItem, parsed.approvedBy);
    store.grantExecutionPlanApproval(
      {
        workItemId: workItem.id,
        planHash: plan.planHash,
        actionHash,
        approvedByActorId: parsed.approvedBy,
        reason: parsed.reason
      },
      policyTransition
    );
  }

  const missingApproval = required.find((evaluation) => !store.hasApproval(workItem.id, evaluation.actionHash));

  return {
    decision,
    workItem:
      missingApproval || workItem.status === "approved"
        ? workItem
        : store.approveWorkItem(workItem.id, policyTransition),
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
      workItem:
        pending.status === "needs_approval" ? pending : store.transition(pending.id, "needs_approval", policyTransition)
    };
  }
  return {
    decision,
    workItem:
      pending.status === "pending_policy" ? pending : store.transition(pending.id, "pending_policy", policyTransition)
  };
}

export function gateWorkerClaim(
  store: WorkItemStore,
  policy: PolicyEngine,
  input: unknown
): ClaimedWorkItem | undefined {
  const parsed = claimInputSchema.parse(input);
  return store.withTransaction(() => gateWorkerClaimInTransaction(store, policy, parsed));
}

function gateWorkerClaimInTransaction(
  store: WorkItemStore,
  policy: PolicyEngine,
  parsed: z.infer<typeof claimInputSchema>
): ClaimedWorkItem | undefined {
  const candidate = store
    .list({ status: "approved" })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
  if (!candidate) {
    return undefined;
  }

  const { decision, evaluations } = evaluateAndRecordPolicy(store, policy, candidate, parsed.workerId, "claim");
  const plan = ensureExecutionPlan(store, candidate, parsed.workerId);
  const policyDecisionHash = stableHash({
    schemaVersion: "acs.execution-plan-policy-decision.v1",
    planHash: plan.planHash,
    steps: evaluations.map((evaluation) => ({
      actionHash: evaluation.actionHash,
      decision: evaluation.decision.decision
    }))
  });
  const admission =
    decision.decision === "deny"
      ? undefined
      : store.admitExecutionPlan(
          {
            workItemId: candidate.id,
            planHash: plan.planHash,
            policyVersion: "acs.policy.v1",
            policyDecisionHash,
            requiresApproval: decision.decision === "require_approval",
            admittedByActorId: parsed.workerId
          },
          policyTransition
        );
  const required = approvalRequired(evaluations);
  const missing = required.find((evaluation) => !store.hasApproval(candidate.id, evaluation.actionHash));
  const planApprovals = required.map((evaluation) =>
    store.getExecutionPlanApproval(candidate.id, plan.planHash, evaluation.actionHash)
  );
  if (decision.decision === "deny" || !admission || missing || planApprovals.some((approval) => !approval)) {
    const blocked = store.blockWorkItem(candidate.id);
    return {
      ...blocked,
      workerId: parsed.workerId,
      leaseToken: "",
      leaseId: "",
      actionHash: "",
      startedAt: blocked.updatedAt,
      leaseExpiresAt: blocked.updatedAt
    };
  }

  // Every required plan approval - not just the first - must be represented
  // in and atomically consumed by the lease's authority, so a multi-action
  // approval-required plan can't dispatch with only one of its approvals
  // actually bound. planApprovals[0] (if any) rides the lease's single
  // `approvalId` column; the rest go through additionalApprovals, consumed
  // transactionally with lease issuance the same way.
  const [firstApproval, ...restApprovals] = planApprovals;
  const running = store.claimNextApprovedWorkItem(parsed.workerId, {
    leaseMs: parsed.leaseMs,
    attemptAuthority: {
      planHash: plan.planHash,
      admissionId: admission.admissionId,
      ...(firstApproval ? { approvalId: firstApproval.approvalId } : {}),
      additionalApprovals: restApprovals
        .filter((approval): approval is NonNullable<typeof approval> => approval !== undefined)
        .map((approval) => ({ approvalId: approval.approvalId, actionHash: approval.actionHash })),
      policyVersion: admission.policyVersion,
      policyDecisionHash: admission.policyDecisionHash
    }
  });
  if (!running) return undefined;
  for (const evaluation of required) {
    store.consumeApproval(running.id, evaluation.actionHash, {
      requestHash: approvalRequestHash(running.id, evaluation.actionHash)
    });
  }
  return running;
}

function ensureExecutionPlan(store: WorkItemStore, workItem: WorkItem, actor: string) {
  return (
    store.getCurrentExecutionPlan(workItem.id) ??
    store.createExecutionPlan({
      workItemId: workItem.id,
      definition: defaultExecutionPlanForWorkItem(workItem),
      createdByActorId: actor
    })
  );
}

export function createWorkItemTools(store: WorkItemStore, policy: PolicyEngine) {
  return {
    create_work_item(input: unknown): WorkItem {
      return store.withTransaction(() => {
        evaluateContractAdmission(input);
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
    retry_work_item(input: unknown): WorkItem {
      const parsed = retryInputSchema.parse(input);
      return store.withTransaction(() => {
        const workItem = store.retryWorkItem(parsed.id, { actor: parsed.actor, reason: parsed.reason });
        evaluateContractAdmission({
          title: workItem.title,
          requester: workItem.requester,
          ...(workItem.requesterSubject ? { requesterSubject: workItem.requesterSubject } : {}),
          status: workItem.status === "draft" ? "draft" : "pending_policy",
          intent: workItem.intent,
          target: workItem.target,
          requestedActions: workItem.requestedActions,
          risk: workItem.risk
        });
        const { decision } = evaluateAndRecordPolicy(store, policy, workItem, parsed.actor, "create");
        return applyPolicyStatus(store, workItem, decision);
      });
    },
    clone_work_item(input: unknown): WorkItem {
      const parsed = cloneInputSchema.parse(input);
      return store.withTransaction(() => {
        const workItem = store.cloneWorkItem(parsed.id, parsed);
        evaluateContractAdmission({
          title: workItem.title,
          requester: workItem.requester,
          ...(workItem.requesterSubject ? { requesterSubject: workItem.requesterSubject } : {}),
          status: workItem.status === "draft" ? "draft" : "pending_policy",
          intent: workItem.intent,
          target: workItem.target,
          requestedActions: workItem.requestedActions,
          risk: workItem.risk
        });
        const { decision } = evaluateAndRecordPolicy(store, policy, workItem, parsed.actor, "create");
        return applyPolicyStatus(store, workItem, decision);
      });
    },
    claim_next_approved_work_item(input: unknown): ClaimedWorkItem | undefined {
      return gateWorkerClaim(store, policy, input);
    },
    submit_work_result(input: unknown): WorkItem {
      return store.submitWorkResult(input);
    }
  };
}

export function approvalRequired(evaluations: PolicyEvaluation[]): PolicyEvaluation[] {
  return evaluations.filter((evaluation) => evaluation.decision.decision === "require_approval");
}

export function policyContextAuditReceipt(context: PolicyContext): Record<string, unknown> {
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
