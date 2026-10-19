import { Link } from "react-router";
import type { ApprovalItem, ApprovalsReadModel } from "@agent-control-stack/mission-control-contract";
import { relativeTime } from "../../design/format";
import { Card, EmptyState, IdChip, Stat, StatusPill } from "../../design/primitives";
import { useControlGate, useWorkItemActions, type ActionSpec } from "../actions/actions";

function ItemCard({ item, viewer, open }: { item: ApprovalItem; viewer: ApprovalsReadModel["viewer"]; open: (spec: ActionSpec) => void }) {
  // Approve is gated by acs:approve; deny and unblock hit /reject and /unblock, which require acs:write.
  const approve = useControlGate(viewer.canApprove, "approve");
  const write = useControlGate(viewer.canWrite, "write");
  const base = { workItemId: item.id, title: item.title, risk: item.risk, intent: item.intent, ...(item.requester ? { requester: item.requester } : {}) };
  const noApprovable = item.status === "needs_approval" && item.actions.length === 0;
  return (
    <li className={`rounded-card border bg-surface p-5 shadow-[var(--shadow)] ${item.overSla ? "border-warn/50" : "border-line"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={`/queue/${encodeURIComponent(item.id)}`} className="text-base font-semibold hover:text-accent hover:underline">{item.title}</Link>
          <p className="mt-1 max-w-2xl text-sm text-muted">{item.intent}</p>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
            <IdChip id={item.id} /> requested by {item.requester ?? "unknown"} · waiting <time dateTime={item.since}>{relativeTime(item.since).replace(" ago", "")}</time>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusPill tone={item.status === "blocked" ? "bad" : "warn"}>{item.status.replace(/_/g, " ")}</StatusPill>
          <StatusPill tone={item.risk === "high" || item.risk === "critical" ? "bad" : item.risk === "medium" ? "warn" : "neutral"} glyph="◆">{item.risk} risk</StatusPill>
          {item.overSla && <StatusPill tone="warn">over SLA</StatusPill>}
        </div>
      </div>

      {item.status === "needs_approval" && (
        <div className="mt-4 space-y-2">
          {item.actions.map((a) => (
            <div key={a.actionHash} className="flex flex-wrap items-center justify-between gap-3 rounded-ctl border border-line bg-surface-2 px-3 py-2">
              <p className="min-w-0 text-sm"><span className="font-mono font-medium">{a.kind}</span> <span className="text-muted">{a.description}</span> <IdChip id={a.actionHash} /></p>
              <button type="button" disabled={approve.disabled} onClick={() => open({ ...base, kind: "approve", actionHash: a.actionHash, actionKind: a.kind, actionDescription: a.description })} aria-label={`Approve ${a.kind} for ${item.title}`} className="rounded-ctl bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink disabled:cursor-not-allowed disabled:opacity-50">Approve</button>
            </div>
          ))}
          {noApprovable && (
            <p className="rounded-ctl border border-dashed border-line-strong px-3 py-2 text-sm text-muted">No approvable action is available to this credential. For example, policy denies approving your own high-risk request, in which case a different approver is needed.</p>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {item.status === "needs_approval" && (
          <button type="button" disabled={write.disabled} onClick={() => open({ ...base, kind: "deny" })} aria-label={`Deny ${item.title}`} className="rounded-ctl border border-bad/50 px-3 py-1.5 text-sm font-medium text-bad disabled:cursor-not-allowed disabled:opacity-50">Deny</button>
        )}
        {item.status === "blocked" && (
          <button type="button" disabled={write.disabled} onClick={() => open({ ...base, kind: "unblock" })} aria-label={`Unblock ${item.title}`} className="rounded-ctl border border-line px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50">Unblock</button>
        )}
        {(item.status === "blocked" ? write.why : approve.why) && <p className="text-xs text-muted">{item.status === "blocked" ? write.why : approve.why}</p>}
      </div>
    </li>
  );
}

export function ApprovalsPage({ data }: { data: ApprovalsReadModel }) {
  const { open, element } = useWorkItemActions();
  const waiting = data.items.filter((i) => i.status === "needs_approval");
  const blocked = data.items.filter((i) => i.status === "blocked");
  return (
    <div className="space-y-6">
      {element}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Awaiting approval" value={waiting.length} tone={waiting.length ? "warn" : "neutral"} />
        <Stat label="Over SLA" value={waiting.filter((i) => i.overSla).length} tone={waiting.some((i) => i.overSla) ? "bad" : "neutral"} note={`Older than ${Math.round(data.slaMs / 60000)} min`} />
        <Stat label="Blocked" value={blocked.length} tone={blocked.length ? "bad" : "neutral"} />
        <Stat label="Your permissions" value={data.viewer.canApprove ? "Can approve" : "Read only"} note={data.viewer.canApprove ? "The gateway still checks every action." : "Controls are disabled for this credential."} />
      </div>
      {data.items.length === 0 ? (
        <Card><EmptyState title="Nothing is waiting on a human">New approval requests appear here live.</EmptyState></Card>
      ) : (
        <ul className="space-y-4" aria-label="Work waiting on a human, oldest first">{data.items.map((i) => <ItemCard key={i.id} item={i} viewer={data.viewer} open={open} />)}</ul>
      )}
    </div>
  );
}
