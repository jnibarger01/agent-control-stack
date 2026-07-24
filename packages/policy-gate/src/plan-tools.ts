import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import type {
  ExecutionPlanAdmission,
  ExecutionPlanApproval,
  ExecutionPlanRecord,
  PrivilegedTransitionOptions,
  WorkItem,
  WorkItemStore
} from "@agent-control-stack/work-items";
import { actionFingerprint } from "./fingerprint.js";
import { evaluatePolicy, policyContextFromAction, summarizePolicy } from "./policy.js";
import type { PolicyDecision, PolicyEvaluation } from "./policy.js";
import { policyContextAuditReceipt } from "./tools.js";

const planPolicyTransition = { via: "policy_gate" } satisfies PrivilegedTransitionOptions;

export interface AdmitExecutionPlanResult {
  decision: PolicyDecision;
  admission?: ExecutionPlanAdmission;
  evaluations: PolicyEvaluation[];
}

/**
 * The sole sanctioned way to admit a plan.
 *
 * Calling store.admitExecutionPlan() directly only proves the caller passed
 * {via: "policy_gate"} - it does not prove policy was genuinely evaluated,
 * and its requiresApproval field is caller-supplied. This function is what
 * makes that true in practice: requiresApproval is derived here from real
 * evaluation of every step's action, using the exact same PolicyEvaluator
 * every other privileged mutation in this codebase uses. A caller cannot
 * claim a plan doesn't need approval when policy says it does. Every
 * evaluated step is also recorded via store.recordPolicyDecision, exactly
 * like the existing action-level admission path (evaluateAndRecordPolicy
 * in tools.ts) - plan admission is auditable the same way action admission
 * already is.
 *
 * Route every execution-plan admission through here. Nothing else should
 * call store.admitExecutionPlan() directly.
 */
export function gateAdmitExecutionPlan(
  store: WorkItemStore,
  workItem: WorkItem,
  plan: ExecutionPlanRecord,
  actor: string
): AdmitExecutionPlanResult {
  if (plan.workItemId !== workItem.id) {
    throw new ControlStackError("execution_plan_work_item_mismatch", "plan does not belong to this work item");
  }

  const evaluations: PolicyEvaluation[] = plan.definition.steps.map((step) => {
    const context = policyContextFromAction(workItem, step.action, actor, "claim");
    return {
      action: step.action,
      actionHash: actionFingerprint(context),
      context,
      decision: evaluatePolicy(context)
    };
  });
  const decision = summarizePolicy(evaluations);

  for (const evaluation of evaluations) {
    store.recordPolicyDecision({
      workItemId: workItem.id,
      actionHash: evaluation.actionHash,
      context: policyContextAuditReceipt(evaluation.context),
      ...evaluation.decision
    });
  }

  if (decision.decision === "deny") {
    return { decision, evaluations };
  }

  const requiresApproval = decision.decision === "require_approval";
  const policyDecisionHash = stableHash({
    schemaVersion: "acs.execution-plan-policy-decision.v1",
    planHash: plan.planHash,
    steps: evaluations.map((evaluation) => ({
      actionHash: evaluation.actionHash,
      decision: evaluation.decision.decision
    }))
  });

  const admission = store.admitExecutionPlan(
    {
      workItemId: workItem.id,
      planHash: plan.planHash,
      policyVersion: "acs.policy.v1",
      policyDecisionHash,
      requiresApproval,
      admittedByActorId: actor
    },
    planPolicyTransition
  );

  return { decision, admission, evaluations };
}

/**
 * Grants approval for one step of the current plan, bound to its exact
 * action hash. Denies self-approval using the same isSelfApproval check
 * (packages/policy-gate/src/rules.ts) every other approval path already
 * uses - re-evaluating the step's PolicyContext with operation "approve"
 * before granting, not a separate ad-hoc check.
 */
export function gateApproveExecutionPlan(
  store: WorkItemStore,
  workItem: WorkItem,
  plan: ExecutionPlanRecord,
  actionHash: string,
  approvedBy: string,
  reason?: string
): ExecutionPlanApproval {
  if (plan.workItemId !== workItem.id) {
    throw new ControlStackError("execution_plan_work_item_mismatch", "plan does not belong to this work item");
  }

  const step = plan.definition.steps.find((candidate) => {
    const context = policyContextFromAction(workItem, candidate.action, approvedBy, "claim");
    return actionFingerprint(context) === actionHash;
  });
  if (!step) {
    throw new ControlStackError(
      "execution_plan_action_mismatch",
      "actionHash does not match a step in the current plan"
    );
  }

  const approvalContext = policyContextFromAction(workItem, step.action, approvedBy, "approve");
  const approvalDecision = evaluatePolicy(approvalContext);
  store.recordPolicyDecision({
    workItemId: workItem.id,
    actionHash,
    context: policyContextAuditReceipt(approvalContext),
    ...approvalDecision
  });
  if (approvalDecision.decision === "deny") {
    throw new ControlStackError("approval_denied", approvalDecision.reason);
  }

  return store.grantExecutionPlanApproval(
    {
      workItemId: workItem.id,
      planHash: plan.planHash,
      actionHash,
      approvedByActorId: approvedBy,
      reason
    },
    planPolicyTransition
  );
}
