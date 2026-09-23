import type { StoredAuditEvent, WorkItem } from "../api/types";

export interface RequiredApproval {
  actionHash: string;
  actionKind: string | undefined;
  reason: string | undefined;
  matchedRules: string[];
  policyDecision: "require_approval";
  decidedAt: string | undefined;
  granted: boolean;
  consumed: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Approval hashes are read from the gateway's own `policy.decided` audit
 * events (attribute `action.hash`). The UI never computes a fingerprint: the
 * hash it submits is the one ACS recorded, and ACS re-derives and compares it
 * again on submit, so a stale or wrong hash fails closed on the server.
 *
 * Each distinct hash becomes its own approval row, because one approve call
 * binds exactly one action hash.
 */
export function requiredApprovals(events: readonly StoredAuditEvent[], workItemId: string): RequiredApproval[] {
  const byHash = new Map<string, RequiredApproval>();
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  for (const event of ordered) {
    if (event.attributes?.["work_item.id"] !== workItemId) continue;
    const hash = text(event.attributes?.["action.hash"]) ?? text(asRecord(event.body).actionHash);
    if (!hash) continue;
    if (event.name === "policy.decided") {
      const decision = text(event.attributes?.["policy.decision"]) ?? text(asRecord(event.body).decision);
      if (decision !== "require_approval") {
        // The latest evaluation of this hash no longer requires approval.
        byHash.delete(hash);
        continue;
      }
      const body = asRecord(event.body);
      const context = asRecord(body.context);
      const previous = byHash.get(hash);
      byHash.set(hash, {
        actionHash: hash,
        actionKind: text(asRecord(context.action).kind) ?? previous?.actionKind,
        reason: text(body.reason) ?? previous?.reason,
        matchedRules: Array.isArray(body.matchedRules)
          ? body.matchedRules.filter((r): r is string => typeof r === "string")
          : (previous?.matchedRules ?? []),
        policyDecision: "require_approval",
        decidedAt: undefined,
        granted: previous?.granted ?? false,
        consumed: previous?.consumed ?? false
      });
    } else if (event.name === "approval.granted") {
      const existing = byHash.get(hash);
      if (existing) byHash.set(hash, { ...existing, granted: true, consumed: false });
    } else if (event.name === "approval.consumed") {
      const existing = byHash.get(hash);
      if (existing) byHash.set(hash, { ...existing, consumed: true });
    }
  }
  return [...byHash.values()];
}

export type ApprovalGate =
  | { kind: "approvable"; approvals: RequiredApproval[] }
  | { kind: "not_pending"; reason: string }
  | { kind: "no_hash"; reason: string }
  | { kind: "stream_stale"; reason: string };

/**
 * Whether the operator is even offered Approve. This is a UX gate only —
 * authority stays server-side — but it fails closed: no evidence, no button.
 */
export function approvalGate(
  workItem: Pick<WorkItem, "status">,
  approvals: readonly RequiredApproval[],
  streamTrustworthy: boolean
): ApprovalGate {
  if (workItem.status !== "needs_approval") {
    return {
      kind: "not_pending",
      reason: `Work item is ${workItem.status.replaceAll("_", " ")}; approval is only valid while it needs approval.`
    };
  }
  if (!streamTrustworthy) {
    return {
      kind: "stream_stale",
      reason: "Live event stream is not connected. Approvals are disabled until state can be trusted."
    };
  }
  const pending = approvals.filter((approval) => !approval.granted && !approval.consumed);
  if (pending.length === 0) {
    return {
      kind: "no_hash",
      reason: "No policy decision requiring approval was found in the audit log for this work item."
    };
  }
  return { kind: "approvable", approvals: pending };
}

export function canUnblock(workItem: Pick<WorkItem, "status">): boolean {
  return workItem.status === "blocked";
}

/** state-machine.ts: needs_approval and blocked can both move to rejected. */
export function canReject(workItem: Pick<WorkItem, "status">): boolean {
  return workItem.status === "needs_approval" || workItem.status === "blocked";
}

const CANCELLABLE: ReadonlySet<string> = new Set([
  "draft",
  "pending_policy",
  "needs_approval",
  "approved",
  "running",
  "blocked"
]);
export function canCancel(workItem: Pick<WorkItem, "status">): boolean {
  return CANCELLABLE.has(workItem.status);
}

export function canRetry(workItem: Pick<WorkItem, "status">): boolean {
  return workItem.status === "failed";
}

/** store.ts createLinkedWorkItem: retry and clone both require a terminal source (succeeded/failed/cancelled/rejected). */
const LINEAGE_SOURCE: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled", "rejected"]);
export function canClone(workItem: Pick<WorkItem, "status">): boolean {
  return LINEAGE_SOURCE.has(workItem.status);
}
