import { ControlStackError } from "@agent-control-stack/shared";
import {
  executionActionHash,
  type AttemptLease,
  type ClaimedWorkItem,
  type WorkItem
} from "@agent-control-stack/work-items";
import { reconstructDesktopCommanderInvocation, desktopCommanderInvocationFingerprint } from "./arguments.js";
import type { ContainmentConfig } from "./containment.js";
import type { DesktopCommanderRiskClass } from "./tool-policy.js";

/**
 * Phase 9 - the trusted Execution Authorization object.
 *
 * This object is the ONLY thing `DesktopCommanderMachineExecutor.execute`
 * accepts. It is a discriminated brand that cannot be produced except by
 * `authorizeDesktopCommanderExecution`, which re-runs every ACS check at
 * execution time (Phases 6-8). There is no `execute(toolName, args)` shortcut.
 */

const AUTHORIZATION_BRAND = Symbol("acs.desktop-commander.execution-authorization");

export interface ExecutionAuthorization {
  readonly [AUTHORIZATION_BRAND]: true;
  readonly requestId: string;
  readonly workItemId: string;
  readonly attemptId: string;
  readonly leaseId: string;
  readonly workerId: string;
  readonly planHash: string;
  readonly inputHash: string;
  readonly fencingEpoch: number;
  /** executionActionHash(workItem) - re-derived from trusted state and matched. */
  readonly actionHash: string;
  /** domainHash of the exact normalised Desktop Commander tool call. */
  readonly invocationFingerprint: string;
  readonly toolName: string;
  readonly normalizedArguments: Readonly<Record<string, unknown>>;
  readonly canonicalPaths: readonly string[];
  readonly risk: DesktopCommanderRiskClass;
  readonly requiresApproval: boolean;
  readonly approvalId?: string;
  readonly policyVersion: string;
  readonly policyDecisionHash: string;
  readonly authorizedAt: string;
}

export interface AuthorizeExecutionInput {
  /** The item as returned by `claim_next_approved_work_item`. */
  claimed: ClaimedWorkItem;
  /** The item re-read from the authoritative store immediately before execution. */
  trustedWorkItem: Pick<WorkItem, "id" | "status" | "requester" | "intent" | "target" | "requestedActions" | "risk">;
  /** The active attempt lease, fetched from the store by the worker. */
  lease: AttemptLease;
  workerId: string;
  containment: ContainmentConfig;
  requestId: string;
  now?: Date;
}

export function authorizeDesktopCommanderExecution(input: AuthorizeExecutionInput): ExecutionAuthorization {
  const now = input.now ?? new Date();
  const { claimed, trustedWorkItem, lease, workerId } = input;

  // --- Phase 7: work item must be executable --------------------------------
  if (trustedWorkItem.status !== "running") {
    throw new ControlStackError(
      "desktop_commander_work_item_not_executable",
      `work item ${trustedWorkItem.id} is ${trustedWorkItem.status}, not running`
    );
  }
  if (claimed.id !== trustedWorkItem.id) {
    throw new ControlStackError(
      "desktop_commander_work_item_mismatch",
      "claimed work item id does not match trusted state"
    );
  }

  // --- Phase 8: worker lease enforcement -----------------------------------
  if (claimed.workerId !== workerId || lease.workerId !== workerId) {
    throw new ControlStackError("desktop_commander_lease_worker_mismatch", "lease is not held by this worker");
  }
  if (lease.workItemId !== trustedWorkItem.id) {
    throw new ControlStackError(
      "desktop_commander_lease_work_item_mismatch",
      "lease does not belong to this work item"
    );
  }
  if (claimed.attemptId !== undefined && lease.attemptId !== claimed.attemptId) {
    throw new ControlStackError("desktop_commander_lease_attempt_mismatch", "lease does not belong to this attempt");
  }
  if (lease.status !== "active") {
    throw new ControlStackError("desktop_commander_lease_inactive", `attempt lease is ${lease.status}`);
  }
  const expiresAt = Date.parse(lease.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    throw new ControlStackError("desktop_commander_lease_expired", "attempt lease has expired");
  }
  if (claimed.fencingEpoch !== undefined && lease.fencingEpoch !== claimed.fencingEpoch) {
    throw new ControlStackError(
      "desktop_commander_lease_fencing_mismatch",
      "lease fencing epoch does not match the claim"
    );
  }

  // --- Phase 6: exact action-hash revalidation ---------------------------------
  const recomputedActionHash = executionActionHash(trustedWorkItem);
  if (recomputedActionHash !== claimed.actionHash) {
    throw new ControlStackError(
      "desktop_commander_action_hash_changed",
      "work item action hash changed since it was claimed"
    );
  }
  if (
    claimed.planHash === undefined ||
    claimed.inputHash === undefined ||
    claimed.fencingEpoch === undefined ||
    claimed.attemptId === undefined
  ) {
    throw new ControlStackError("desktop_commander_attempt_authority_missing", "claim did not carry attempt authority");
  }
  if (lease.planHash !== claimed.planHash) {
    throw new ControlStackError("desktop_commander_plan_hash_mismatch", "lease plan hash does not match the claim");
  }

  // --- Phases 3-5: reconstruct + validate the exact tool call ----------------
  const invocation = reconstructDesktopCommanderInvocation(trustedWorkItem, input.containment);
  const invocationFingerprint = desktopCommanderInvocationFingerprint(invocation);

  // --- Phase 7: approval must have been granted for a requires-approval tool --
  if (invocation.policy.requiresApproval && lease.approvalId === undefined) {
    throw new ControlStackError(
      "desktop_commander_approval_missing",
      `tool ${invocation.toolName} requires approval but the lease carries no approval reference`
    );
  }

  return Object.freeze({
    [AUTHORIZATION_BRAND]: true as const,
    requestId: input.requestId,
    workItemId: trustedWorkItem.id,
    attemptId: claimed.attemptId,
    leaseId: claimed.leaseId,
    workerId,
    planHash: claimed.planHash,
    inputHash: claimed.inputHash,
    fencingEpoch: claimed.fencingEpoch,
    actionHash: recomputedActionHash,
    invocationFingerprint,
    toolName: invocation.toolName,
    normalizedArguments: Object.freeze({ ...invocation.validatedArguments }),
    canonicalPaths: Object.freeze([...invocation.canonicalPaths]),
    risk: invocation.policy.riskClass,
    requiresApproval: invocation.policy.requiresApproval,
    approvalId: lease.approvalId,
    policyVersion: lease.policyVersion,
    policyDecisionHash: lease.policyDecisionHash,
    authorizedAt: now.toISOString()
  });
}

export function isExecutionAuthorization(value: unknown): value is ExecutionAuthorization {
  return (
    typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[AUTHORIZATION_BRAND] === true
  );
}
