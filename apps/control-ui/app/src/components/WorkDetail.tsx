import { useState } from "react";
import { formatTime, relativeAge } from "../domain/format";
import { workItemTargetLabel } from "../domain/filters";
import { Link } from "../router";
import { useWorkItem } from "../state/data";
import { EventTimeline } from "./EventTimeline";
import { ExecutionDetailView } from "./ExecutionDetail";
import { useStreamTrust } from "./Shell";
import { Tabs } from "./Tabs";
import { WorkActions } from "./WorkActions";
import { CopyButton, ErrorState, JsonView, KV, LoadingState, RiskBadge, StatusBadge } from "./ui";
import { isAcsApiError } from "../api/errors";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "approval", label: "Approval & actions" },
  { id: "execution", label: "Execution" },
  { id: "timeline", label: "Timeline" },
  { id: "raw", label: "Raw JSON" }
] as const;

/** Work-item detail pane shared by the Work Queue and Approvals pages. */
export function WorkDetail({
  id,
  onClose,
  initialTab = "overview"
}: {
  id: string;
  onClose?: () => void;
  initialTab?: string;
}) {
  const query = useWorkItem(id);
  const { trustworthy } = useStreamTrust();
  const [tab, setTab] = useState(initialTab);
  const now = Date.now();

  if (query.error && !query.hasData) {
    if (isAcsApiError(query.error) && query.error.kind === "not_found") {
      return <ErrorState error={query.error} what={`work item ${id}`} />;
    }
    return <ErrorState error={query.error} onRetry={query.refetch} what={`work item ${id}`} />;
  }
  if (!query.hasData || !query.data) return <LoadingState label={`Loading ${id}…`} />;
  const { workItem, events, executionAttempts, attemptLeases } = query.data;
  // Guard against a stale response for a different selection ever rendering under this id.
  if (workItem.id !== id) return <LoadingState label={`Loading ${id}…`} />;

  return (
    <div className="stack" data-testid="work-detail" data-work-item={workItem.id}>
      <div className="detail-head">
        <div style={{ minWidth: 0 }}>
          <h2 style={{ overflowWrap: "anywhere" }}>{workItem.title}</h2>
          <div className="row muted">
            <span className="mono">{workItem.id}</span>
            <CopyButton value={workItem.id} label="work item id" />
          </div>
        </div>
        <div className="row">
          <StatusBadge status={workItem.status} />
          <RiskBadge risk={workItem.risk} />
          {onClose && (
            <button type="button" className="btn" data-size="sm" onClick={onClose} aria-label="Close detail">
              ✕
            </button>
          )}
        </div>
      </div>
      {query.isStale && (
        <div className="banner" data-tone="warning" role="status">
          <p>This record may be out of date; refreshing…</p>
        </div>
      )}
      <Tabs tabs={TABS} active={tab} onChange={setTab} label="Work item sections">
        {tab === "overview" && (
          <div className="stack">
            <div className="section">
              <h3 className="eyebrow">Intent</h3>
              <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{workItem.intent}</p>
            </div>
            <KV
              items={[
                [
                  "Requester",
                  `${workItem.requester}${workItem.requesterSubject ? ` · ${workItem.requesterSubject}` : ""}`
                ],
                ["Target", workItemTargetLabel(workItem)],
                ["Created", formatTime(workItem.createdAt, { seconds: true })],
                [
                  "Updated",
                  `${formatTime(workItem.updatedAt, { seconds: true })} (${relativeAge(workItem.updatedAt, now)} ago)`
                ],
                ["Origin", workItem.lineageType ?? "direct"],
                [
                  "Source work item",
                  workItem.sourceWorkItemId ? (
                    <Link key="s" to={`/work/${encodeURIComponent(workItem.sourceWorkItemId)}`}>
                      {workItem.sourceWorkItemId}
                    </Link>
                  ) : (
                    "—"
                  )
                ],
                [
                  "Root work item",
                  workItem.rootWorkItemId ? (
                    <Link key="r" to={`/work/${encodeURIComponent(workItem.rootWorkItemId)}`}>
                      {workItem.rootWorkItemId}
                    </Link>
                  ) : (
                    "—"
                  )
                ],
                [
                  "Retry",
                  workItem.retrySequence !== undefined
                    ? `#${workItem.retrySequence}${workItem.retryReason ? ` — ${workItem.retryReason}` : ""}`
                    : "—"
                ]
              ]}
            />
            <div className="section">
              <h3 className="eyebrow">Requested actions</h3>
              {workItem.requestedActions.length === 0 ? (
                <p className="muted">No requested actions.</p>
              ) : (
                <ul style={{ margin: 0, paddingLeft: "var(--space-4)" }}>
                  {workItem.requestedActions.map((action, index) => (
                    <li key={`${action.kind}-${index}`}>
                      <strong>{action.kind}</strong> <span className="muted">{action.description}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="section">
              <h3 className="eyebrow">Target</h3>
              <JsonView value={workItem.target} label="Target" />
            </div>
            <div className="section">
              <h3 className="eyebrow">Result</h3>
              {workItem.result ? (
                <JsonView value={workItem.result} label="Result" />
              ) : (
                <p className="muted">No result recorded.</p>
              )}
            </div>
          </div>
        )}
        {tab === "approval" && <WorkActions workItem={workItem} events={events} trustworthy={trustworthy} />}
        {tab === "execution" && (
          <ExecutionDetailView
            workItemId={workItem.id}
            attempts={executionAttempts}
            leases={attemptLeases}
            events={events}
            result={workItem.result}
            now={now}
          />
        )}
        {tab === "timeline" && <EventTimeline events={events} />}
        {tab === "raw" && (
          <JsonView value={{ workItem, executionAttempts, attemptLeases }} label="Raw work item JSON" />
        )}
      </Tabs>
    </div>
  );
}
