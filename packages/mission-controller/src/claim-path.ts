import {
  CAPABILITY_FOR_CLASS,
  classifySideEffect,
  type DecisionReceipt,
  type NimbleDecisionModel
} from "@agent-control-stack/decision-engine";
import {
  ACS_ADMIN_APPROVER,
  summarizePolicy,
  type PolicyEngine
} from "@agent-control-stack/policy-gate";
import { stableHash } from "@agent-control-stack/shared";
import {
  defaultExecutionPlanForWorkItem,
  type ClaimedWorkItem,
  type ExecutionBackend,
  type WorkItem,
  type WorkItemStore
} from "@agent-control-stack/work-items";
import { reconcileStoredDecision, runDecisionOnlyStep, type IssuedPermit } from "./decision-only.js";

const HOLD_WORKER_ID = "nimble-hold";
const RECEIPT_EVENT = "nimble.decision_receipt";
const PERMIT_EVENT = "nimble.permit_issued";
const CLAIM_EVENT = "nimble.claim_bound";
const EXECUTION_EVENT = "nimble.execution_started";
const OUTCOME_EVENT = "nimble.outcome_attached";

const MUTATING_CAPABILITIES = [
  "fs:write",
  "git:write",
  "net:send",
  "publish",
  "payment",
  "fs:delete",
  "security:change",
  "production:change"
] as const;

export class AuthoritativeRouteCrash extends Error {
  constructor(readonly boundary: "before_permit" | "before_claim" | "before_outcome") {
    super(`authoritative route crash: ${boundary}`);
    this.name = "AuthoritativeRouteCrash";
  }
}

export type AuthoritativeStopAfter = "receipt" | "permit" | "execution_started";

export type AuthoritativeClaimResult = {
  readonly claimed: ClaimedWorkItem | undefined;
  readonly receiptId: string | null;
  readonly missionId: string | null;
  readonly selectedOperationId: string | null;
  readonly reason: string;
  /** This call may execute exactly once. A later call must not. */
  readonly beginExecution: boolean;
  /** A previous call already crossed into execution. */
  readonly executionStarted: boolean;
  readonly outcomeAttached: boolean;
};

type ClaimById = (workItemId: string, leaseMs?: number) => ClaimedWorkItem | undefined;

function capabilitiesFor(backend: ExecutionBackend): readonly string[] {
  return backend === "dry_run" ? [] : MUTATING_CAPABILITIES;
}

function isJaceContract(item: WorkItem): boolean {
  return item.requestedActions.some((action) => action.params.contract === "acs.jc.v1");
}

function missionIdFor(ids: readonly string[]): string {
  return `mis_${stableHash([...ids].sort()).slice(0, 24)}`;
}

function eventBody(store: WorkItemStore, name: string, missionId: string): Record<string, unknown> | undefined {
  const found = store.readEvents({ name, workItemId: missionId, limit: 5 }).find((event) => event.name === name);
  return found?.body;
}

function remember(
  store: WorkItemStore,
  name: string,
  missionId: string,
  workerId: string,
  body: Record<string, unknown>
): void {
  store.recordSystemEventOnceForWorkItem({
    name,
    workItemId: missionId,
    body,
    attributes: { "worker.id": workerId, "mission.id": missionId }
  });
}

function parseReceipt(body: Record<string, unknown> | undefined): DecisionReceipt | undefined {
  const raw = body?.receiptJson;
  if (typeof raw !== "string") return undefined;
  const parsed = JSON.parse(raw) as DecisionReceipt;
  if (parsed.authoritativeModel !== "nimble" || typeof parsed.receiptId !== "string") return undefined;
  return parsed;
}

/**
 * Approved work Nimble is allowed to see.
 * Policy denial, missing approval, missing capability, assignment to another
 * worker, and Jace Commander contracts never become candidates.
 */
export function eligibleApprovedOperations(input: {
  readonly store: WorkItemStore;
  readonly policy: PolicyEngine;
  readonly workerId: string;
  readonly executionBackend: ExecutionBackend;
}): WorkItem[] {
  const capabilities = capabilitiesFor(input.executionBackend);
  const adminMode = input.store.getExecutionMode().mode === "admin";
  const registered = new Set(input.store.listRegistryAgents().map((agent) => agent.id));
  return input.store
    .list({ status: "approved" })
    .filter((item) => {
      const assignment = input.store.getWorkItemAssignment(item.id);
      if (
        assignment &&
        assignment.selectedWorkerId !== input.workerId &&
        assignment.selectedWorkerId !== HOLD_WORKER_ID
      ) {
        return false;
      }
      const targeted = (item.target.services ?? []).filter((serviceId) => registered.has(serviceId));
      if (targeted.length > 0 && !targeted.includes(input.workerId)) return false;
      if (isJaceContract(item)) return false;
      if (
        !adminMode &&
        (input.store.hasGrantedApprovalBy(item.id, ACS_ADMIN_APPROVER) ||
          input.store.hasGrantedExecutionPlanApprovalBy(item.id, ACS_ADMIN_APPROVER))
      ) {
        return false;
      }
      if (item.requestedActions.length !== 1) return false;
      const kind = item.requestedActions[0]?.kind;
      if (!kind) return false;
      const sideEffect = classifySideEffect(kind);
      if (sideEffect === null) return false;
      const required = CAPABILITY_FOR_CLASS[sideEffect];
      if (required !== null && !capabilities.includes(required)) return false;
      const evaluations = input.policy.evaluateWorkItem(item, input.workerId, "claim");
      const decision = summarizePolicy(evaluations);
      if (decision.decision === "deny") return false;
      if (decision.decision === "require_approval") {
        const missing = evaluations.some(
          (evaluation) =>
            evaluation.decision.decision === "require_approval" &&
            !input.store.hasApproval(item.id, evaluation.actionHash)
        );
        if (missing) return false;
      }
      return true;
    })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

function holdCandidates(store: WorkItemStore, workerId: string, candidateIds: readonly string[]): void {
  for (const workItemId of candidateIds) {
    const item = store.get(workItemId);
    if (!item || item.status !== "approved") continue;
    store.assignWorkItem(
      { workItemId, selectedWorkerId: HOLD_WORKER_ID, assignedByActorId: workerId },
      { via: "domain_service", actorId: workerId }
    );
  }
}

function issuePolicyPermit(input: {
  readonly store: WorkItemStore;
  readonly policy: PolicyEngine;
  readonly workerId: string;
  readonly workItem: WorkItem;
  readonly executionBackend: ExecutionBackend;
}): IssuedPermit {
  const plan =
    input.store.getCurrentExecutionPlan(input.workItem.id) ??
    input.store.createExecutionPlan({
      workItemId: input.workItem.id,
      definition: defaultExecutionPlanForWorkItem(input.workItem, { executionMode: input.executionBackend }),
      createdByActorId: input.workerId
    });
  const evaluations = input.policy.evaluateWorkItem(input.workItem, input.workerId, "claim");
  const decision = summarizePolicy(evaluations);
  if (decision.decision === "deny") {
    throw new Error("hard policy denied the selected operation before permit issuance");
  }
  const policyDecisionHash = stableHash({
    schemaVersion: "acs.execution-plan-policy-decision.v1",
    planHash: plan.planHash,
    steps: evaluations.map((evaluation) => ({
      actionHash: evaluation.actionHash,
      decision: evaluation.decision.decision
    }))
  });
  const admission = input.store.admitExecutionPlan(
    {
      workItemId: input.workItem.id,
      planHash: plan.planHash,
      policyVersion: "acs.policy.v1",
      policyDecisionHash,
      requiresApproval: decision.decision === "require_approval",
      admittedByActorId: input.workerId
    },
    { via: "policy_gate" }
  );
  return { permitId: admission.admissionId, operationId: input.workItem.id, issuer: "policy-gate" };
}

function permitFromBody(body: Record<string, unknown> | undefined): IssuedPermit | undefined {
  if (!body) return undefined;
  if (typeof body.permitId !== "string" || typeof body.operationId !== "string") return undefined;
  if (body.issuer !== "policy-gate" && body.issuer !== "execution-admission") return undefined;
  return { permitId: body.permitId, operationId: body.operationId, issuer: body.issuer };
}

function claimedFromSnapshot(store: WorkItemStore, body: Record<string, unknown>): ClaimedWorkItem | undefined {
  if (typeof body.workItemId !== "string") return undefined;
  const item = store.get(body.workItemId);
  if (!item) return undefined;
  if (
    typeof body.workerId !== "string" ||
    typeof body.leaseId !== "string" ||
    typeof body.leaseToken !== "string" ||
    typeof body.actionHash !== "string" ||
    typeof body.attemptId !== "string" ||
    typeof body.planHash !== "string" ||
    typeof body.inputHash !== "string" ||
    typeof body.fencingEpoch !== "number" ||
    typeof body.startedAt !== "string" ||
    typeof body.leaseExpiresAt !== "string"
  ) {
    return undefined;
  }
  return {
    ...item,
    workerId: body.workerId,
    leaseToken: body.leaseToken,
    leaseId: body.leaseId,
    actionHash: body.actionHash,
    attemptId: body.attemptId,
    planHash: body.planHash,
    inputHash: body.inputHash,
    fencingEpoch: body.fencingEpoch,
    startedAt: body.startedAt,
    leaseExpiresAt: body.leaseExpiresAt
  };
}

function snapshotBody(claimed: ClaimedWorkItem): Record<string, unknown> {
  return {
    workItemId: claimed.id,
    workerId: claimed.workerId,
    leaseToken: claimed.leaseToken,
    leaseId: claimed.leaseId,
    actionHash: claimed.actionHash,
    attemptId: claimed.attemptId ?? "",
    planHash: claimed.planHash ?? "",
    inputHash: claimed.inputHash ?? "",
    fencingEpoch: claimed.fencingEpoch ?? 0,
    startedAt: claimed.startedAt,
    leaseExpiresAt: claimed.leaseExpiresAt
  };
}

function openReceipt(store: WorkItemStore, workerId: string): { missionId: string; receipt: DecisionReceipt } | undefined {
  const events = store.readEvents({ name: RECEIPT_EVENT, agentId: workerId, limit: 100 });
  for (const event of events) {
    const missionId = event.attributes["mission.id"];
    if (typeof missionId !== "string") continue;
    if (eventBody(store, OUTCOME_EVENT, missionId)) continue;
    const receipt = parseReceipt(event.body);
    if (!receipt) continue;
    return { missionId, receipt };
  }
  return undefined;
}

function observeTerminalOutcome(
  store: WorkItemStore,
  missionId: string,
  workerId: string,
  selectedOperationId: string
): boolean {
  const item = store.get(selectedOperationId);
  if (!item) return false;
  if (item.status !== "succeeded" && item.status !== "failed" && item.status !== "blocked") return false;
  remember(store, OUTCOME_EVENT, missionId, workerId, {
    status: item.status,
    exitCode: item.status === "succeeded" ? 0 : null
  });
  return true;
}

/**
 * Production claim entry.
 * Hard eligibility runs before Nimble. The receipt is durable before a permit.
 * Restart loads that receipt and does not ask Nimble again.
 * An existing permit is reused. An execution that already started is not repeated.
 * This function does not mint scheduler capacity and does not restore an in-flight permit.
 */
export async function claimApprovedWorkViaNimble(input: {
  readonly store: WorkItemStore;
  readonly policy: PolicyEngine;
  readonly workerId: string;
  readonly model: NimbleDecisionModel;
  readonly createdAt: string;
  readonly executionBackend: ExecutionBackend;
  readonly claimById: ClaimById;
  readonly leaseMs?: number;
  readonly shadow?: { readonly jevChoice: string | null };
  readonly stopAfter?: AuthoritativeStopAfter;
}): Promise<AuthoritativeClaimResult> {
  const eligible = eligibleApprovedOperations(input);
  const open = openReceipt(input.store, input.workerId);
  let missionId = open?.missionId;
  let receipt = open?.receipt;

  if (!receipt) {
    if (eligible.length === 0) {
      return {
        claimed: undefined,
        receiptId: null,
        missionId: null,
        selectedOperationId: null,
        reason: "no approved work item",
        beginExecution: false,
        executionStarted: false,
        outcomeAttached: false
      };
    }
    missionId = missionIdFor(eligible.map((item) => item.id));
    const capabilities = capabilitiesFor(input.executionBackend);
    const decidedMissionId = missionId;
    await runDecisionOnlyStep({
      state: {
        missionId: decidedMissionId,
        goal: "Select the next approved work item",
        operations: eligible.map((item) => ({
          id: item.id,
          status: "pending" as const,
          kind: item.requestedActions[0]?.kind
        })),
        evidence: eligible.map((item) => `work:${item.id}`)
      },
      model: input.model,
      policy: {
        capabilities: [...capabilities],
        actionsThisMission: 0,
        requiresApproval: false,
        approved: true,
        permitId: `pending:${decidedMissionId}`
      },
      createdAt: input.createdAt,
      ...(input.shadow ? { shadow: input.shadow } : {}),
      receipts: {
        append: (next) =>
          remember(input.store, RECEIPT_EVENT, decidedMissionId, input.workerId, {
            receiptJson: JSON.stringify(next),
            selectedId: next.selectedId ?? ""
          })
      },
      permits: { readIssuedPermit: () => null }
    });
    receipt = parseReceipt(eventBody(input.store, RECEIPT_EVENT, decidedMissionId));
  }

  if (!receipt || !missionId) {
    return {
      claimed: undefined,
      receiptId: null,
      missionId: missionId ?? null,
      selectedOperationId: null,
      reason: "decision_not_ready",
      beginExecution: false,
      executionStarted: false,
      outcomeAttached: false
    };
  }

  const selectedOperationId = receipt.selectedId;
  if (
    selectedOperationId === null ||
    receipt.fallbackUsed ||
    receipt.authoritativeModel !== "nimble" ||
    reconcileStoredDecision({ receipt, permit: null }).reason !== "receipt_is_not_authorization"
  ) {
    return {
      claimed: undefined,
      receiptId: receipt.receiptId,
      missionId,
      selectedOperationId,
      reason: "receipt_is_not_authorization",
      beginExecution: false,
      executionStarted: false,
      outcomeAttached: false
    };
  }

  holdCandidates(input.store, input.workerId, receipt.candidateIds);
  if (input.stopAfter === "receipt") throw new AuthoritativeRouteCrash("before_permit");

  let permit = permitFromBody(eventBody(input.store, PERMIT_EVENT, missionId));
  if (!permit) {
    const selected = input.store.get(selectedOperationId);
    if (!selected || selected.status !== "approved") {
      return {
        claimed: undefined,
        receiptId: receipt.receiptId,
        missionId,
        selectedOperationId,
        reason: "selected_operation_not_approved",
        beginExecution: false,
        executionStarted: false,
        outcomeAttached: false
      };
    }
    permit = issuePolicyPermit({
      store: input.store,
      policy: input.policy,
      workerId: input.workerId,
      workItem: selected,
      executionBackend: input.executionBackend
    });
    remember(input.store, PERMIT_EVENT, missionId, input.workerId, { ...permit });
  }
  if (input.stopAfter === "permit") throw new AuthoritativeRouteCrash("before_claim");

  const reconciled = reconcileStoredDecision({ receipt, permit });
  if (reconciled.handoff === null) {
    return {
      claimed: undefined,
      receiptId: receipt.receiptId,
      missionId,
      selectedOperationId,
      reason: reconciled.reason,
      beginExecution: false,
      executionStarted: false,
      outcomeAttached: false
    };
  }

  if (eventBody(input.store, OUTCOME_EVENT, missionId)) {
    return {
      claimed: undefined,
      receiptId: receipt.receiptId,
      missionId,
      selectedOperationId,
      reason: "outcome_already_attached",
      beginExecution: false,
      executionStarted: true,
      outcomeAttached: true
    };
  }

  if (eventBody(input.store, EXECUTION_EVENT, missionId)) {
    if (observeTerminalOutcome(input.store, missionId, input.workerId, selectedOperationId)) {
      return {
        claimed: undefined,
        receiptId: receipt.receiptId,
        missionId,
        selectedOperationId,
        reason: "outcome_reconciled",
        beginExecution: false,
        executionStarted: true,
        outcomeAttached: true
      };
    }
    return {
      claimed: undefined,
      receiptId: receipt.receiptId,
      missionId,
      selectedOperationId,
      reason: "execution_in_flight",
      beginExecution: false,
      executionStarted: true,
      outcomeAttached: false
    };
  }

  const existingClaim = eventBody(input.store, CLAIM_EVENT, missionId);
  let claimed = existingClaim ? claimedFromSnapshot(input.store, existingClaim) : undefined;
  if (!claimed) {
    const selected = input.store.get(selectedOperationId);
    if (selected?.status === "approved") {
      input.store.assignWorkItem(
        { workItemId: selectedOperationId, selectedWorkerId: input.workerId, assignedByActorId: input.workerId },
        { via: "domain_service", actorId: input.workerId }
      );
    }
    claimed = input.claimById(selectedOperationId, input.leaseMs);
    if (claimed?.attemptId && claimed.status !== "blocked") {
      remember(input.store, CLAIM_EVENT, missionId, input.workerId, snapshotBody(claimed));
    }
  }

  if (!claimed?.attemptId || claimed.status === "blocked") {
    return {
      claimed,
      receiptId: receipt.receiptId,
      missionId,
      selectedOperationId,
      reason: claimed?.status === "blocked" ? "blocked by policy" : "claim_not_bound",
      beginExecution: false,
      executionStarted: false,
      outcomeAttached: false
    };
  }

  remember(input.store, EXECUTION_EVENT, missionId, input.workerId, { attemptId: claimed.attemptId });
  if (input.stopAfter === "execution_started") throw new AuthoritativeRouteCrash("before_outcome");
  return {
    claimed,
    receiptId: receipt.receiptId,
    missionId,
    selectedOperationId,
    reason: "selected",
    beginExecution: true,
    executionStarted: false,
    outcomeAttached: false
  };
}

/** Attach the observed worker outcome to the same decision receipt. */
export function attachAuthoritativeOutcome(
  store: WorkItemStore,
  missionId: string,
  workerId: string,
  outcome: { readonly status: string; readonly exitCode: number | null }
): void {
  remember(store, OUTCOME_EVENT, missionId, workerId, {
    status: outcome.status,
    exitCode: outcome.exitCode
  });
}
