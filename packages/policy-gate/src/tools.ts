import {
  collectSensitiveValues,
  ControlStackError,
  redactSensitiveText,
  stableHash
} from "@agent-control-stack/shared";
import {
  type ApprovalGrant,
  approvalRequestHash,
  approvalRequestSchema,
  cancelRequestSchema,
  DEFAULT_WORK_ITEM_LIST_LIMIT,
  defaultExecutionPlanForWorkItem,
  executionActionHash,
  listWorkItemsSchema,
  resolveExecutionBackend,
  rejectRequestSchema,
  type ClaimedWorkItem,
  type PrivilegedTransitionOptions,
  type WorkItem,
  type WorkItemStore
} from "@agent-control-stack/work-items";
import { z } from "zod";
import { evaluateContractAdmission } from "./contracts.js";
import { explainPolicy } from "./explain.js";
import { classifyMissionIntake } from "./mission-classifier.js";
import { requireRoutedMission, routeMission } from "./mission-route.js";
import type { PolicyContext, PolicyDecision, PolicyEngine, PolicyEvaluation, PolicyOperation } from "./policy.js";

export const workItemToolNames = [
  "create_work_item",
  "get_work_item",
  "list_work_items",
  "approve_work_item",
  "unblock_work_item",
  "reject_work_item",
  "cancel_work_item",
  "explain_policy"
] as const;

// Note: claim_next_approved_work_item and claim_approved_work_item_by_id are
// intentionally not listed in workItemToolNames (a pre-existing omission this
// slice preserves rather than changes) -- both are reached only via
// createWorkItemTools()/gateWorkerClaim(ById), never off this name list.

const idInputSchema = z.object({ id: z.string().min(1) });
const unblockInputSchema = idInputSchema.extend({ actor: z.string().min(1) });
const claimInputSchema = z.object({
  workerId: z.string().min(1),
  leaseMs: z.number().int().positive().optional()
});
const claimByIdInputSchema = idInputSchema.extend({
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
    return workItem.status === "blocked" ? workItem : store.blockWorkItem(workItem.id, policyTransition);
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
    return {
      decision,
      workItem: workItem.status === "blocked" ? workItem : store.blockWorkItem(workItem.id, policyTransition)
    };
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
  if (!hasCurrentNativeRoute(store, candidate)) {
    return blockedClaim(store, candidate, parsed.workerId);
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
    const blocked = store.blockWorkItem(candidate.id, policyTransition);
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

/**
 * Exact-id sibling of gateWorkerClaim, for resuming a specific work item
 * (e.g. resume_dc_call) rather than claiming whatever is oldest-approved.
 * Mirrors gateWorkerClaimInTransaction step for step -- same claim-time
 * policy re-evaluation, same execution-plan admission, same post-claim
 * approval consumption -- scoped to one work item id, and the execution
 * action hash passed to the store is always recomputed here from the
 * freshly loaded candidate, never accepted from a caller.
 */
export function gateWorkerClaimById(
  store: WorkItemStore,
  policy: PolicyEngine,
  input: unknown
): ClaimedWorkItem | undefined {
  const parsed = claimByIdInputSchema.parse(input);
  return store.withTransaction(() => gateWorkerClaimByIdInTransaction(store, policy, parsed));
}

function gateWorkerClaimByIdInTransaction(
  store: WorkItemStore,
  policy: PolicyEngine,
  parsed: z.infer<typeof claimByIdInputSchema>
): ClaimedWorkItem | undefined {
  const candidate = store.get(parsed.id);
  if (!candidate || candidate.status !== "approved") {
    return undefined;
  }
  if (!hasCurrentNativeRoute(store, candidate)) {
    return blockedClaim(store, candidate, parsed.workerId);
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
    const blocked = store.blockWorkItem(candidate.id, policyTransition);
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

  // Match the next-item claim path: the lease's primary approval column can
  // bind one required action, while every remaining required action must be
  // persisted in attempt_lease_approvals before any approval is consumed.
  // Omitting these bindings would let an exact-id/resume claim consume an
  // approval that its attempt authority does not carry.
  const [firstApproval, ...restApprovals] = planApprovals;
  const running = store.claimApprovedWorkItemById(candidate.id, executionActionHash(candidate), parsed.workerId, {
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
      // The execution backend is a process-wide deployment setting. Gateway
      // (approval) and worker (claim) must share ACS_EXECUTION_BACKEND so the
      // plan hash is consistent; the worker additionally fails closed if the
      // admitted plan's mode does not match its configured backend.
      definition: defaultExecutionPlanForWorkItem(workItem, { executionMode: resolveExecutionBackend() }),
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
        if (workItem.requestedActions.length > 0) {
          recordNativeMissionRouting(store, workItem);
        }
        const { decision } = evaluateAndRecordPolicy(store, policy, workItem, workItem.requester, "create");
        return applyPolicyStatus(store, workItem, decision);
      });
    },
    get_work_item(input: unknown): WorkItem | undefined {
      const parsed = idInputSchema.parse(input);
      return store.get(parsed.id);
    },
    list_work_items(input: unknown = {}): WorkItem[] {
      const parsed = listWorkItemsSchema.parse(input ?? {});
      // Public list surface always applies a page size (default or client-provided,
      // clamped to MAX_WORK_ITEM_LIST_LIMIT inside the schema).
      return store.list({
        ...parsed,
        limit: parsed.limit ?? DEFAULT_WORK_ITEM_LIST_LIMIT
      });
    },
    explain_policy(input: unknown) {
      return explainPolicy(input);
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
        recordNativeMissionRouting(store, workItem);
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
        recordNativeMissionRouting(store, workItem);
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
    claim_approved_work_item_by_id(input: unknown): ClaimedWorkItem | undefined {
      return gateWorkerClaimById(store, policy, input);
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
    // The action hash binds raw policy inputs. Durable audit evidence records
    // only their presence so unrestricted paths do not become a retention path.
    hasCwd: context.cwd !== undefined,
    pathCount: context.paths?.length ?? 0,
    commandHash: context.command ? stableHash(context.command) : undefined,
    network: context.network,
    write: context.write,
    destructive: context.destructive
  };
}

function nativeMissionIntakeForWorkItem(workItem: WorkItem) {
  const explicitSecrets = collectSensitiveValues({ target: workItem.target, actions: workItem.requestedActions });
  const hasFilesystemAction = workItem.requestedActions.some((action) => action.kind.startsWith("fs."));
  const network = workItem.requestedActions.some(
    (action) => action.params.network === true || action.params.allowNetwork === true
  )
    ? "declared"
    : "none";
  return {
    schemaVersion: "acs.mission-intake.v1" as const,
    requestId: `intake-${workItem.id}`,
    title: redactedNativeIntakeText(workItem.title, explicitSecrets),
    // The native classifier consumes the immutable intake goal. Include
    // normalized action intent so a caller cannot hide an otherwise explicit
    // filesystem task behind a generic natural-language goal.
    goal: [
      redactedNativeIntakeText(workItem.title, explicitSecrets),
      redactedNativeIntakeText(workItem.intent, explicitSecrets),
      ...workItem.requestedActions.map(
        (action) => `${action.kind}: ${redactedNativeIntakeText(action.description, explicitSecrets)}`
      ),
      ...(hasFilesystemAction ? ["coding"] : [])
    ].join("\n"),
    origin: workItem.requester === "user" ? "dashboard" : workItem.requester === "agent" ? "hermes" : "api",
    target: { files: [] },
    proposedActions: workItem.requestedActions.map((action, index) => ({
      clientActionId: `action-${String(index + 1).padStart(3, "0")}`,
      kind: action.kind,
      description: redactedNativeIntakeText(action.description, explicitSecrets),
      params: { declared: Object.keys(action.params).length > 0 }
    })),
    constraints: {
      network,
      maxRuntimeMs: maxRuntimeMs(workItem),
      successCriteria: [redactedNativeIntakeText(workItem.intent, explicitSecrets)]
    },
    submittedClaims: { risk: missionRiskForWorkItem(workItem.risk) }
  };
}

function recordNativeMissionRouting(store: WorkItemStore, workItem: WorkItem): void {
  const intake = nativeMissionIntakeForWorkItem(workItem);
  const classifier = classifyMissionIntake(intake, {
    evidenceId: `classifier-${workItem.id}`,
    generatedAt: workItem.createdAt
  });
  const route = routeMission({
    intake,
    classifierEvidence: classifier,
    routeId: `route-${workItem.id}`,
    decidedAt: workItem.createdAt
  });
  store.recordMissionRouting({ workItemId: workItem.id, intake, classifier, route, createdAt: workItem.createdAt });
}

function redactedNativeIntakeText(value: string, explicitSecrets: readonly string[]): string {
  const redacted = redactSensitiveText(value, explicitSecrets);
  if (typeof redacted !== "string" || redacted.length === 0) {
    throw new ControlStackError(
      "mission_intake_projection_invalid",
      "native mission intake could not be projected safely"
    );
  }
  return redacted;
}

/** Recompute the complete native evidence chain immediately before a lease is issued. */
function hasCurrentNativeRoute(store: WorkItemStore, workItem: WorkItem): boolean {
  try {
    const persisted = store.getVerifiedMissionRouting(workItem.id);
    // Direct store creation is a legacy compatibility path. It never creates
    // native evidence and remains governed by the existing claim checks. Once
    // a native binding exists, however, it is mandatory and fail-closed.
    if (!persisted) return true;
    const classifier = classifyMissionIntake(persisted.intake, {
      evidenceId: persisted.classifier.evidenceId,
      generatedAt: persisted.classifier.generatedAt
    });
    if (stableHash(classifier) !== stableHash(persisted.classifier)) return false;
    const route = routeMission({
      intake: persisted.intake,
      classifierEvidence: classifier,
      routeId: persisted.route.routeId,
      decidedAt: persisted.route.decidedAt
    });
    if (stableHash(route) !== stableHash(persisted.route)) return false;
    requireRoutedMission(route);
    return (
      missionRiskRank(route.effectiveRisk) >= missionRiskRank(persisted.intake.submittedClaims?.risk ?? "unknown") &&
      missionRiskRank(route.effectiveRisk) >= missionRiskRank(missionRiskForWorkItem(workItem.risk))
    );
  } catch {
    return false;
  }
}

function blockedClaim(store: WorkItemStore, workItem: WorkItem, workerId: string): ClaimedWorkItem {
  const blocked = store.blockWorkItem(workItem.id);
  return {
    ...blocked,
    workerId,
    leaseToken: "",
    leaseId: "",
    actionHash: "",
    startedAt: blocked.updatedAt,
    leaseExpiresAt: blocked.updatedAt
  };
}

function maxRuntimeMs(workItem: WorkItem): number {
  const timeouts = workItem.requestedActions
    .map((action) => action.params.timeoutMs)
    .filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value > 0);
  return Math.min(86_400_000, Math.max(1, ...(timeouts.length ? timeouts : [900_000])));
}

function missionRiskForWorkItem(risk: WorkItem["risk"]): "read_only" | "draft" | "write" | "destructive" {
  switch (risk) {
    case "low":
      return "read_only";
    case "medium":
      return "draft";
    case "high":
      return "write";
    case "critical":
      return "destructive";
  }
}

function missionRiskRank(risk: "read_only" | "draft" | "write" | "destructive" | "unknown"): number {
  return { read_only: 0, draft: 1, write: 2, destructive: 3, unknown: 4 }[risk];
}
