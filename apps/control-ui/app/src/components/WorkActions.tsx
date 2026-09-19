import { useMemo, useState } from "react";
import type { StoredAuditEvent, WorkItem } from "../api/types";
import {
  approvalGate,
  canCancel,
  canClone,
  canReject,
  canRetry,
  canUnblock,
  requiredApprovals,
  type RequiredApproval
} from "../domain/approvals";
import { navigate } from "../router";
import { workMutations } from "../state/mutations";
import { ConfirmDialog } from "./Dialog";
import { useToast } from "./Toasts";
import { CopyButton, KV, RiskBadge, StatusBadge } from "./ui";

type Pending =
  | { kind: "approve"; approval: RequiredApproval }
  | { kind: "reject" }
  | { kind: "unblock" }
  | { kind: "cancel" }
  | { kind: "retry" }
  | { kind: "clone" };

/**
 * The only place approve / reject / unblock / cancel / retry / clone are offered.
 * Every control is derived from the work item's state and the audit-recorded
 * approval hashes; when evidence is missing or the live stream is not trusted
 * the control is disabled WITH a visible reason, never silently hidden.
 * Authority is enforced by the gateway; this is a fail-closed convenience.
 */
export function WorkActions({
  workItem,
  events,
  trustworthy
}: {
  workItem: WorkItem;
  events: readonly StoredAuditEvent[];
  trustworthy: boolean;
}) {
  const toast = useToast();
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  const approvals = useMemo(() => requiredApprovals(events, workItem.id), [events, workItem.id]);
  const gate = approvalGate(workItem, approvals, trustworthy);
  const staleReason = "Live event stream is not connected — disabled until state can be trusted.";
  const close = () => setPending(undefined);

  const target = (extra?: Array<[string, React.ReactNode]>) => (
    <KV
      items={[
        [
          "Work item",
          <span className="mono" key="id">
            {workItem.id}
          </span>
        ],
        ["Title", workItem.title],
        ["Status", <StatusBadge status={workItem.status} key="s" />],
        ["Risk", <RiskBadge risk={workItem.risk} key="r" />],
        ...(extra ?? [])
      ]}
    />
  );

  return (
    <div className="stack" data-testid="work-actions">
      {workItem.status === "needs_approval" && (
        <div className="section">
          <h3 className="eyebrow">Approval required</h3>
          {gate.kind !== "approvable" && (
            <div className="banner" data-tone={gate.kind === "stream_stale" ? "warning" : "info"} role="status">
              <p>{gate.reason}</p>
            </div>
          )}
          {approvals.map((approval) => {
            const done = approval.granted || approval.consumed;
            const enabled = gate.kind === "approvable" && !done;
            return (
              <div
                key={approval.actionHash}
                className="card"
                style={{ padding: "var(--space-3)" }}
                data-testid="approval-row"
              >
                <div className="row-between">
                  <strong>{approval.actionKind ?? "Action"}</strong>
                  <span className="chip" data-tone={done ? "success" : "warning"}>
                    {approval.consumed ? "Approval consumed" : approval.granted ? "Approved" : "Awaiting approval"}
                  </span>
                </div>
                <KV
                  items={[
                    [
                      "Action hash",
                      <span className="hash" key="h" data-testid="action-hash">
                        {approval.actionHash} <CopyButton value={approval.actionHash} label="action hash" />
                      </span>
                    ],
                    ["Policy rationale", approval.reason ?? "—"],
                    ["Matched rules", approval.matchedRules.length ? approval.matchedRules.join(", ") : "—"]
                  ]}
                />
                <div className="row" style={{ marginTop: "var(--space-3)" }}>
                  <button
                    type="button"
                    className="btn"
                    data-variant="success"
                    disabled={!enabled}
                    title={
                      enabled
                        ? undefined
                        : done
                          ? "This action hash is already approved."
                          : gate.kind === "stream_stale"
                            ? staleReason
                            : "Not approvable"
                    }
                    onClick={() => setPending({ kind: "approve", approval })}
                  >
                    Approve this action…
                  </button>
                </div>
              </div>
            );
          })}
          {workItem.requestedActions.length > approvals.length && approvals.length > 0 && (
            <p className="hint">
              {workItem.requestedActions.length} requested actions, {approvals.length} require approval. Each required
              action hash is approved separately.
            </p>
          )}
        </div>
      )}

      <div className="row" role="group" aria-label="Work item actions">
        {canReject(workItem) && (
          <button
            type="button"
            className="btn"
            data-variant="danger"
            disabled={!trustworthy}
            title={trustworthy ? undefined : staleReason}
            onClick={() => setPending({ kind: "reject" })}
          >
            Reject…
          </button>
        )}
        {canUnblock(workItem) && (
          <button
            type="button"
            className="btn"
            disabled={!trustworthy}
            title={trustworthy ? undefined : staleReason}
            onClick={() => setPending({ kind: "unblock" })}
          >
            Unblock…
          </button>
        )}
        {canCancel(workItem) && (
          <button
            type="button"
            className="btn"
            data-variant="danger"
            disabled={!trustworthy}
            title={trustworthy ? undefined : staleReason}
            onClick={() => setPending({ kind: "cancel" })}
          >
            Cancel work item…
          </button>
        )}
        {canRetry(workItem) && (
          <button type="button" className="btn" onClick={() => setPending({ kind: "retry" })}>
            Retry…
          </button>
        )}
        {canClone(workItem) && (
          <button type="button" className="btn" onClick={() => setPending({ kind: "clone" })}>
            Clone…
          </button>
        )}
        {!canReject(workItem) &&
          !canUnblock(workItem) &&
          !canCancel(workItem) &&
          !canRetry(workItem) &&
          !canClone(workItem) && <span className="muted">No actions are valid in status “{workItem.status}”.</span>}
      </div>
      {!trustworthy && (canReject(workItem) || canUnblock(workItem) || canCancel(workItem)) && (
        <p className="hint" role="note">
          {staleReason}
        </p>
      )}

      <ConfirmDialog
        open={pending?.kind === "approve"}
        title="Approve this exact action?"
        variant="success"
        confirmLabel="Approve action"
        description="Approval is bound to the action hash below. If the work item or policy changed, ACS will reject a stale hash and nothing will run."
        target={
          pending?.kind === "approve"
            ? target([
                ["Action", pending.approval.actionKind ?? "—"],
                [
                  "Action hash",
                  <span className="hash" key="h">
                    {pending.approval.actionHash}
                  </span>
                ],
                ["Policy rationale", pending.approval.reason ?? "—"]
              ])
            : null
        }
        reason={{ label: "Approval reason", required: true, placeholder: "Why is this action acceptable?" }}
        onConfirm={async (reason) => {
          if (pending?.kind !== "approve") return;
          await workMutations.approve(workItem.id, pending.approval.actionHash, reason);
          toast("success", `Approved action for ${workItem.id}.`);
        }}
        onClose={close}
      />
      <ConfirmDialog
        open={pending?.kind === "reject"}
        title="Reject this work item?"
        variant="danger"
        confirmLabel="Reject work item"
        description="Rejection is terminal for this work item."
        target={target()}
        reason={{ label: "Reason", required: false }}
        onConfirm={async (reason) => {
          await workMutations.reject(workItem.id, reason);
          toast("success", `Rejected ${workItem.id}.`);
        }}
        onClose={close}
      />
      <ConfirmDialog
        open={pending?.kind === "unblock"}
        title="Unblock this work item?"
        confirmLabel="Unblock"
        description="Unblocking re-runs policy. It may block again or move to approval; ACS decides."
        target={target()}
        onConfirm={async () => {
          const result = await workMutations.unblock(workItem.id);
          toast("success", `Unblock evaluated: ${result.decision.decision} → ${result.workItem.status}.`);
        }}
        onClose={close}
      />
      <ConfirmDialog
        open={pending?.kind === "cancel"}
        title="Cancel this work item?"
        variant="danger"
        confirmLabel="Cancel work item"
        target={target()}
        reason={{ label: "Reason", required: false }}
        onConfirm={async (reason) => {
          await workMutations.cancel(workItem.id, reason);
          toast("success", `Cancelled ${workItem.id}.`);
        }}
        onClose={close}
      />
      <ConfirmDialog
        open={pending?.kind === "retry"}
        title="Retry as a new work item?"
        confirmLabel="Create retry"
        description="Creates a new governed work item linked to this one. It goes through policy and approval again."
        target={target()}
        reason={{ label: "Retry reason", required: true }}
        onConfirm={async (reason) => {
          const { workItem: next } = await workMutations.retry(workItem.id, reason);
          toast("success", `Created retry ${next.id}.`);
          navigate(`/work/${encodeURIComponent(next.id)}`);
        }}
        onClose={close}
      />
      <ConfirmDialog
        open={pending?.kind === "clone"}
        title="Clone as a new work item?"
        confirmLabel="Create clone"
        description="Creates a new governed work item with the same intent and actions. It goes through policy and approval again."
        target={target()}
        onConfirm={async () => {
          const { workItem: next } = await workMutations.clone(workItem.id);
          toast("success", `Created clone ${next.id}.`);
          navigate(`/work/${encodeURIComponent(next.id)}`);
        }}
        onClose={close}
      />
    </div>
  );
}
