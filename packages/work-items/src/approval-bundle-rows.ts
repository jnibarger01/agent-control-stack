import { ControlStackError } from "@agent-control-stack/shared";
import { z } from "zod";
import {
  approvalBundleStatusSchema,
  type ApprovalBundle,
  type ApprovalBundleBaseState,
  type ApprovalBundleRevision,
  type ApprovalBundleStatus,
  type ApprovalDecision,
  type ApprovalDecisionKind
} from "@agent-control-stack/approval-bundles";
import type { ApprovalGrantRecord } from "@agent-control-stack/approval-bundles";

/**
 * Approval-bundle persistence types and row mappers.
 *
 * Kept beside the store rather than inside it so the SQL row shapes are auditable in
 * one place, and so nothing here can be mistaken for a source of authority: every
 * mapper reconstructs a plain record, and the `approval_id` on a grant always points
 * at the `execution_plan_approvals` row that actually holds the authority.
 */

export const approvalStrategySchema = z.enum(["PER_ACTION", "BUNDLE", "POLICY_AUTONOMOUS"]);
export type ApprovalStrategy = z.infer<typeof approvalStrategySchema>;

/** The admin auto-approver may never grant a bundle. Mirrors `ACS_ADMIN_APPROVER`. */
export const ACS_ADMIN_APPROVER = "acs:admin";

/**
 * Fail-closed read of the strategy column.
 *
 * Anything unrecognised resolves to PER_ACTION rather than to a more permissive mode.
 */
export function readApprovalStrategy(
  raw: string | null | undefined
): { ok: true; strategy: ApprovalStrategy } | { ok: false } {
  const parsed = approvalStrategySchema.safeParse(raw);
  return parsed.success ? { ok: true, strategy: parsed.data } : { ok: false };
}

export interface ApprovalBundleRow {
  bundle_id: string;
  mission_id: string;
  execution_id: string;
  agent_id: string;
  status: string;
  current_revision: number;
  current_manifest_hash: string;
  created_at: string;
  updated_at: string;
}

export interface ApprovalBundleRevisionRow {
  bundle_id: string;
  revision: number;
  manifest_hash: string;
  parent_manifest_hash: string | null;
  manifest_json: string;
  title: string;
  rationale: string;
  status: string;
  base_state_json: string;
  scope_json: string;
  created_at: string;
  created_by_actor_id: string;
  expires_at: string | null;
}

export interface ApprovalBundleDecisionRow {
  decision_id: string;
  bundle_id: string;
  revision: number;
  kind: string;
  approved_by_actor_id: string;
  reason: string;
  change_ids_json: string;
  manifest_hash: string;
  decided_at: string;
}

export interface ApprovalBundleGrantRow {
  grant_id: string;
  bundle_id: string;
  revision: number;
  change_id: string;
  manifest_hash: string;
  action_hash: string;
  mission_id: string;
  execution_id: string;
  work_item_id: string;
  plan_hash: string;
  approval_id: string;
  approved_by_actor_id: string;
  status: string;
  base_state_json: string;
  granted_at: string;
  expires_at: string;
  invalidated_at: string | null;
  invalidation_reason: string | null;
}

export function rowToApprovalBundleDecision(row: ApprovalBundleDecisionRow): ApprovalDecision {
  return {
    id: row.decision_id,
    revision: row.revision,
    kind: row.kind as ApprovalDecisionKind,
    approvedByActorId: row.approved_by_actor_id,
    reason: row.reason,
    changeIds: JSON.parse(row.change_ids_json) as string[],
    manifestHash: row.manifest_hash,
    decidedAt: row.decided_at
  };
}

export function rowToApprovalBundleGrant(row: ApprovalBundleGrantRow): ApprovalGrantRecord {
  const status = row.status as ApprovalGrantRecord["status"];
  return {
    approvalId: row.approval_id,
    bundleId: row.bundle_id,
    revision: row.revision,
    manifestHash: row.manifest_hash,
    changeId: row.change_id,
    actionHash: row.action_hash,
    missionId: row.mission_id,
    executionId: row.execution_id,
    workItemId: row.work_item_id,
    planHash: row.plan_hash,
    approvedByActorId: row.approved_by_actor_id,
    status,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    baseState: JSON.parse(row.base_state_json) as ApprovalBundleBaseState
  };
}

/** Map a bundle status onto the audit event suffix the observability contract requires. */
export function bundleStatusEventSuffix(status: ApprovalBundleStatus): string {
  const suffix: Record<ApprovalBundleStatus, string> = {
    draft: "created",
    pending: "submitted",
    approved: "approved",
    partially_approved: "partially_approved",
    rejected: "rejected",
    modified: "revised",
    invalidated: "invalidated",
    executing: "execution_started",
    completed: "execution_completed",
    failed: "execution_failed"
  };
  const mapped = suffix[status];
  if (!mapped) {
    throw new ControlStackError("approval_bundle_status_unknown", `unknown approval bundle status: ${status}`);
  }
  return mapped;
}

export { approvalBundleStatusSchema };
export type { ApprovalBundle, ApprovalBundleRevision, ApprovalDecision };
