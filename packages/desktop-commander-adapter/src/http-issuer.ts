import { ControlStackError, type AttributeValue } from "@agent-control-stack/shared";
import { executionActionHash, type ClaimedWorkItem, type WorkItemStore } from "@agent-control-stack/work-items";
import { issueAndSignDesktopCommanderCapability, type CapabilityIssuanceDeps, type ManagedCapabilityConfig } from "./capability-issuance.js";
import type { DesktopCommanderCapability } from "./capability.js";
import type { ContainmentConfig } from "./containment.js";
import { authorizeDesktopCommanderExecution } from "./execution-authorization.js";

/**
 * The ACS-owned HTTP capability issuer boundary.
 *
 * Unlike `DesktopCommanderMachineExecutor`, which holds the `ClaimedWorkItem`
 * it produced itself moments earlier (same process, same claim call), an HTTP
 * caller only ever supplies identifiers - it never held a claim. Every field
 * `authorizeDesktopCommanderExecution` needs is therefore re-derived here
 * directly from the authoritative store, keyed only by
 * `(workItemId, attemptId)` plus the ALREADY-AUTHENTICATED `workerId` the
 * gateway resolved from the caller's bearer credential. Nothing from the
 * request body ever reaches the authorization or signing path: not
 * `toolName`, not `arguments`, not `actionHash`/`planHash`/`fencingEpoch`,
 * not `runtimeId`. Those are either derived from trusted state
 * (`reconstructDesktopCommanderInvocation` inside
 * `authorizeDesktopCommanderExecution`, over the trusted work item) or fixed
 * by this issuer's own configuration (the runtime this issuer signs for).
 */

export interface IssueDesktopCommanderCapabilityForRequestInput {
  store: WorkItemStore;
  config: ManagedCapabilityConfig;
  containment: ContainmentConfig;
  capabilityRegistry: CapabilityIssuanceDeps["capabilityRegistry"];
  persistAuditEvent: CapabilityIssuanceDeps["persistAuditEvent"];
  /** Path/route-bound work item id - never taken from the request body. */
  workItemId: string;
  /** The one caller-supplied identifier: which of the worker's own attempts to issue for. */
  attemptId: string;
  /** Resolved by the gateway from the authenticated bearer credential, never from the request body. */
  workerId: string;
  requestId: string;
  now?: Date;
}

function auditAttributes(input: { workItemId: string; attemptId: string; workerId: string; requestId: string; code: string }): Record<string, AttributeValue> {
  return {
    "work_item.id": input.workItemId,
    "attempt.id": input.attemptId,
    "worker.id": input.workerId,
    "execution.request_id": input.requestId,
    "execution.deny_code": input.code,
    "execution.mode": "desktop_commander"
  };
}

/**
 * Resolve, authorize, and sign exactly one `acs.dc.v1` capability for one
 * already-claimed, already-leased attempt. Every check
 * `authorizeDesktopCommanderExecution` performs today for the in-process
 * worker path runs identically here; this function only adds the store reads
 * that reconstruct trusted equivalents of what an in-process caller would
 * already be holding.
 */
export async function issueDesktopCommanderCapabilityForRequest(
  input: IssueDesktopCommanderCapabilityForRequestInput
): Promise<DesktopCommanderCapability> {
  const now = input.now ?? new Date();

  const trustedWorkItem = input.store.get(input.workItemId);
  if (!trustedWorkItem) {
    throw new ControlStackError("desktop_commander_work_item_not_found", `work item not found: ${input.workItemId}`);
  }

  // Mirrors the identical gate in apps/worker's `runDesktopCommanderExecution`:
  // a plan admitted for dry-run simulation must never be executed for real
  // through Desktop Commander just because a caller reached this endpoint.
  const plan = input.store.getCurrentExecutionPlan(input.workItemId);
  if (!plan || plan.definition.constraints.executionMode !== "desktop_commander") {
    throw new ControlStackError(
      "desktop_commander_plan_execution_mode_mismatch",
      `admitted plan execution mode is ${plan?.definition.constraints.executionMode ?? "missing"}, not desktop_commander`
    );
  }

  const attempt = input.store.getAttempt(input.attemptId);
  if (!attempt || attempt.workItemId !== trustedWorkItem.id) {
    throw new ControlStackError("desktop_commander_attempt_not_found", "attempt not found for this work item");
  }
  if (!attempt.claimedByWorkerId || attempt.claimedByWorkerId !== input.workerId) {
    throw new ControlStackError("desktop_commander_lease_worker_mismatch", "attempt is not claimed by this worker");
  }

  const lease = input.store.getActiveLeaseForAttempt(input.attemptId);
  if (!lease) {
    throw new ControlStackError("desktop_commander_lease_missing", "no active attempt lease");
  }

  // A fully store-derived equivalent of what `claim_next_approved_work_item`
  // would have returned to an in-process caller. `actionHash` is recomputed
  // fresh from the SAME trusted read used for `authorizeDesktopCommanderExecution`'s
  // own recomputation below - there is no historical claim-time snapshot to
  // compare against at an HTTP boundary that never held one, so this binds
  // the capability to current trusted state rather than to anything supplied
  // by the caller. `leaseToken` is unused by `authorizeDesktopCommanderExecution`.
  const claimed: ClaimedWorkItem = {
    ...trustedWorkItem,
    workerId: input.workerId,
    leaseToken: "",
    leaseId: lease.leaseId,
    actionHash: executionActionHash(trustedWorkItem),
    attemptId: attempt.attemptId,
    planHash: attempt.planHash,
    inputHash: attempt.inputHash,
    fencingEpoch: attempt.currentFencingEpoch,
    startedAt: attempt.startedAt ?? now.toISOString(),
    leaseExpiresAt: lease.expiresAt
  };

  let authorization;
  try {
    authorization = authorizeDesktopCommanderExecution({
      claimed,
      trustedWorkItem,
      lease,
      workerId: input.workerId,
      containment: input.containment,
      requestId: input.requestId,
      now
    });
  } catch (error) {
    const code = error instanceof ControlStackError ? error.code : "desktop_commander_authorization_failed";
    try {
      await input.persistAuditEvent({
        name: "desktop_commander.capability_denied",
        body: {
          workItemId: input.workItemId,
          attemptId: input.attemptId,
          workerId: input.workerId,
          requestId: input.requestId,
          code
        },
        attributes: auditAttributes({ workItemId: input.workItemId, attemptId: input.attemptId, workerId: input.workerId, requestId: input.requestId, code })
      });
    } catch {
      // Authorization already failed; the capability was never signed.
    }
    throw error;
  }

  return issueAndSignDesktopCommanderCapability(
    authorization,
    input.config,
    { capabilityRegistry: input.capabilityRegistry, persistAuditEvent: input.persistAuditEvent },
    now
  );
}
