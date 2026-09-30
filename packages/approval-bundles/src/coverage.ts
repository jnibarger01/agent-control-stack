import { ControlStackError } from "@agent-control-stack/shared";
import type { ApprovalBundleBaseState } from "./contracts.js";

/**
 * Runtime authorization: does an approved grant cover this exact operation?
 *
 * This module is deliberately free of any Policy Gate dependency. It reasons only
 * over already-derived action hashes, so it cannot be tempted to decide for itself
 * what an operation *is*. Deriving the action hash is Policy Gate's job and happens in
 * `packages/policy-gate/src/approval-bundle-tools.ts`.
 *
 * The matching rule is exact hash equality. There is no prefix matching, no substring
 * matching, no path-prefix expansion and no "same target means related" heuristic.
 * A wildcard would be a wildcard, and this is the boundary that decides whether a
 * privileged operation may run.
 */

/** One granted change, as persisted by the bundle decision. */
export interface ApprovalGrantRecord {
  approvalId: string;
  bundleId: string;
  /** Revision that was approved. */
  revision: number;
  /** Manifest that was reviewed. The grant is bound to exactly this hash. */
  manifestHash: string;
  changeId: string;
  /** The Policy Gate action hash this change was approved as. */
  actionHash: string;
  missionId: string;
  executionId: string;
  workItemId: string;
  planHash: string;
  approvedByActorId: string;
  status: "granted" | "consumed" | "invalidated" | "expired";
  grantedAt: string;
  expiresAt: string;
  baseState: ApprovalBundleBaseState;
}

/** The operation about to run, already reduced to its authorization identity. */
export interface CoveredOperation {
  workItemId: string;
  /** Derived by Policy Gate with `actionFingerprint`, the same function policy uses. */
  actionHash: string;
  /** The base state observed *now*, for TOCTOU comparison. */
  observedBaseState?: ApprovalBundleBaseState;
}

export type AuthorizationMissReason =
  | "no_active_grant"
  | "grant_invalidated"
  | "grant_expired"
  | "grant_already_consumed"
  | "mission_mismatch"
  | "execution_mismatch"
  | "work_item_mismatch"
  | "plan_mismatch"
  | "manifest_mismatch"
  | "base_state_changed"
  | "action_not_approved";

export type AuthorizationCoverage =
  | { covered: true; grant: ApprovalGrantRecord }
  | { covered: false; reason: AuthorizationMissReason; grant?: ApprovalGrantRecord };

function baseStateMatches(approved: ApprovalBundleBaseState, observed: ApprovalBundleBaseState | undefined): boolean {
  // With nothing observed there is nothing to contradict, so an approval that did not
  // pin a base state stays valid. When the reviewer *did* pin one, the caller must
  // supply the observed value, and it must agree.
  if (approved.gitSha === undefined && approved.configHash === undefined) {
    return true;
  }
  if (observed === undefined) {
    return false;
  }
  if (approved.gitSha !== undefined && approved.gitSha !== observed.gitSha) {
    return false;
  }
  if (approved.configHash !== undefined && approved.configHash !== observed.configHash) {
    return false;
  }
  return true;
}

/**
 * Decide whether any active grant covers this operation.
 *
 * Ambiguity is never resolved in favour of the operation. A grant that exists but is
 * invalidated, expired, consumed, bound to another mission/execution/plan, or whose
 * base state has moved all fail closed with a specific reason.
 */
export function activeGrantCovers(
  grants: readonly ApprovalGrantRecord[],
  operation: CoveredOperation,
  now: Date = new Date()
): AuthorizationCoverage {
  const byActionHash = grants.filter((grant) => grant.actionHash === operation.actionHash);
  if (byActionHash.length === 0) {
    return { covered: false, reason: "no_active_grant" };
  }

  // Several grants may exist for one action hash (e.g. across plan revisions). Only
  // one of them may satisfy the binding; if none does, the reason reported is the most
  // specific failure observed so an operator can see what actually went wrong.
  let best: { covered: false; reason: AuthorizationMissReason; grant?: ApprovalGrantRecord } = {
    covered: false,
    reason: "action_not_approved"
  };

  for (const grant of byActionHash) {
    if (grant.status === "invalidated") {
      best = prefer(best, { covered: false, reason: "grant_invalidated", grant });
      continue;
    }
    if (grant.status === "consumed") {
      best = prefer(best, { covered: false, reason: "grant_already_consumed", grant });
      continue;
    }
    if (grant.status === "expired" || Date.parse(grant.expiresAt) <= now.getTime()) {
      best = prefer(best, { covered: false, reason: "grant_expired", grant });
      continue;
    }
    if (grant.workItemId !== operation.workItemId) {
      best = prefer(best, { covered: false, reason: "work_item_mismatch", grant });
      continue;
    }
    if (!baseStateMatches(grant.baseState, operation.observedBaseState)) {
      best = prefer(best, { covered: false, reason: "base_state_changed", grant });
      continue;
    }
    return { covered: true, grant };
  }
  return best;
}

const REASON_PRIORITY: Record<AuthorizationMissReason, number> = {
  no_active_grant: 0,
  action_not_approved: 1,
  grant_already_consumed: 2,
  grant_expired: 3,
  grant_invalidated: 4,
  work_item_mismatch: 5,
  mission_mismatch: 6,
  execution_mismatch: 7,
  plan_mismatch: 8,
  manifest_mismatch: 9,
  base_state_changed: 10
};

function prefer(
  current: { covered: false; reason: AuthorizationMissReason },
  candidate: { covered: false; reason: AuthorizationMissReason; grant?: ApprovalGrantRecord }
): { covered: false; reason: AuthorizationMissReason; grant?: ApprovalGrantRecord } {
  return REASON_PRIORITY[candidate.reason] > REASON_PRIORITY[current.reason] ? candidate : current;
}

/** Grants that are still usable for a mission, i.e. the queryable "active grant" set. */
export function activeGrantsForMission(
  grants: readonly ApprovalGrantRecord[],
  missionId: string,
  now: Date = new Date()
): ApprovalGrantRecord[] {
  return grants.filter(
    (grant) =>
      grant.missionId === missionId && grant.status === "granted" && Date.parse(grant.expiresAt) > now.getTime()
  );
}

/**
 * Guard a partial approval selection against its own dependency graph.
 *
 * Approving a change whose dependency is not approved would leave the bundle claiming
 * authority over an operation that cannot legally run. The bundle therefore refuses the
 * selection outright instead of granting the dependant and hoping the executor notices.
 */
export function assertSelectionDependenciesSatisfied(
  changes: readonly { id: string; dependsOn: string[] }[],
  selectedChangeIds: readonly string[]
): void {
  const selected = new Set(selectedChangeIds);
  const byId = new Map(changes.map((change) => [change.id, change]));
  for (const changeId of selected) {
    const change = byId.get(changeId);
    if (!change) {
      throw new ControlStackError(
        "approval_bundle_unknown_change",
        `change ${changeId} is not part of this bundle revision`
      );
    }
    for (const dependency of change.dependsOn) {
      if (!selected.has(dependency)) {
        throw new ControlStackError(
          "approval_bundle_dependency_violation",
          `change ${changeId} depends on ${dependency}, which is not part of this approval`
        );
      }
    }
  }
}
