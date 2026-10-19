import { Link } from "react-router";
import type { AuditEvent } from "@agent-control-stack/mission-control-contract";
import { clockTime } from "../../design/format";
import { Card, DataTable, EmptyState, IdChip, Stat, StatusPill, type Tone } from "../../design/primitives";

const TONE: Record<string, Tone> = { allow: "ok", deny: "bad", require_approval: "warn" };

export function PolicyPage({ events }: { events: AuditEvent[] }) {
  const decided = events.filter((e) => e.policy);
  const count = (d: string) => decided.filter((e) => e.policy?.decision === d).length;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Decisions loaded" value={decided.length} note="Latest policy.decided events" />
        <Stat label="Allowed" value={count("allow")} tone="ok" />
        <Stat label="Needed approval" value={count("require_approval")} tone={count("require_approval") ? "warn" : "neutral"} />
        <Stat label="Denied" value={count("deny")} tone={count("deny") ? "bad" : "neutral"} />
      </div>
      <Card title="Recent policy decisions" subtitle="Read-only. Policy is evaluated by the gateway; this page only shows what it recorded. Policy rules cannot be edited here.">
        {decided.length === 0 ? <EmptyState title="No policy decisions recorded yet" /> : (
          <DataTable
            caption="Recent policy decisions"
            rows={decided}
            rowKey={(e) => String(e.sequence)}
            columns={[
              { key: "at", header: "Time", render: (e) => <time dateTime={e.at} className="whitespace-nowrap text-xs">{clockTime(e.at)}</time> },
              { key: "d", header: "Decision", render: (e) => <StatusPill tone={TONE[e.policy!.decision] ?? "neutral"}>{e.policy!.decision.replace(/_/g, " ")}</StatusPill> },
              { key: "why", header: "Reason", render: (e) => <span className="text-xs">{e.policy!.reason ?? <span className="text-muted">none recorded</span>}{e.policy!.matchedRules.length ? <span className="block text-muted">{e.policy!.matchedRules.join(", ")}</span> : null}</span> },
              { key: "item", header: "Work item", render: (e) => { const id = e.attributes["work_item.id"]; return typeof id === "string" ? <Link className="text-xs text-accent hover:underline" to={`/queue/${encodeURIComponent(id)}`}>open trace</Link> : <span className="text-xs text-muted">unknown</span>; } },
              { key: "hash", header: "Action", render: (e) => { const h = e.attributes["action.hash"]; return typeof h === "string" ? <IdChip id={h} /> : <span className="text-xs text-muted">n/a</span>; } }
            ]}
          />
        )}
      </Card>
    </div>
  );
}
