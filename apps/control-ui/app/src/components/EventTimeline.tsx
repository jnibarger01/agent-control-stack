import { useMemo } from "react";
import type { StoredAuditEvent } from "../api/types";
import { eventActor, eventSummary } from "../domain/audit";
import { formatTime } from "../domain/format";
import { eventTimeMs, severityFor } from "../state/reconcile";

export function EventTimeline({ events, limit = 60 }: { events: readonly StoredAuditEvent[]; limit?: number }) {
  const ordered = useMemo(() => [...events].sort((a, b) => b.sequence - a.sequence).slice(0, limit), [events, limit]);
  if (ordered.length === 0) return <p className="muted">No audit events.</p>;
  return (
    <ol className="timeline" aria-label="Audit timeline, newest first">
      {ordered.map((event) => (
        <li key={event.id} data-severity={severityFor(event)}>
          <div>
            <strong>{event.name}</strong> <span className="muted">· {eventActor(event)}</span>
            <div>
              <time dateTime={new Date(eventTimeMs(event)).toISOString()}>
                {formatTime(eventTimeMs(event), { seconds: true })}
              </time>
              {eventSummary(event) !== "—" && <span className="muted"> · {eventSummary(event)}</span>}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
