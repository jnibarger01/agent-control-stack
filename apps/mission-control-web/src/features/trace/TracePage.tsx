import { Link } from "react-router";
import type { TraceAttempt, TraceReadModel, TraceStage } from "@agent-control-stack/mission-control-contract";
import { Card, EmptyState, IdChip, StatusPill, type Tone } from "../../design/primitives";
import { clockTime, formatDuration, relativeTime } from "../../design/format";

const GLYPH: Record<TraceStage["state"], { glyph: string; tone: Tone; text: string }> = {
  done: { glyph: "✓", tone: "ok", text: "Done" },
  current: { glyph: "●", tone: "info", text: "In progress" },
  pending: { glyph: "○", tone: "neutral", text: "Pending" },
  not_applicable: { glyph: "–", tone: "neutral", text: "Not required" },
  unavailable: { glyph: "?", tone: "unknown", text: "Unavailable" }
};

function Stage({ stage, last }: { stage: TraceStage; last: boolean }) {
  const g = GLYPH[stage.state];
  const ring = { ok: "border-ok text-ok", info: "border-info text-info", neutral: "border-line-strong text-muted", unknown: "border-dashed border-faint text-faint", warn: "border-warn text-warn", bad: "border-bad text-bad", accent: "border-accent text-accent" }[g.tone];
  return (
    <li className="relative flex gap-4 pb-6 last:pb-0">
      {!last && <span aria-hidden="true" className="absolute left-[15px] top-8 h-[calc(100%-2rem)] w-px bg-line-strong" />}
      <span aria-hidden="true" className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 bg-surface text-sm font-semibold ${ring}`}>
        {g.glyph}
        {stage.state === "current" && <span className="acs-pulse absolute inset-0 rounded-full border-2 border-info" />}
      </span>
      <div className="min-w-0 pt-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">{stage.label}</h3>
          <StatusPill tone={g.tone} glyph={g.glyph}>{g.text}</StatusPill>
          {stage.derived && <span className="text-[11px] text-faint" title="Projected from audit events, not a persisted record">derived from audit</span>}
        </div>
        <p className="mt-0.5 text-sm text-muted">{stage.summary}</p>
      </div>
    </li>
  );
}

function leaseTone(status: string): Tone {
  return status === "active" ? "info" : status === "consumed" ? "ok" : status === "expired" || status === "revoked" ? "warn" : "neutral";
}

function Attempt({ attempt, latestEpoch }: { attempt: TraceAttempt; latestEpoch: number }) {
  const tone: Tone = attempt.status === "succeeded" ? "ok" : ["failed", "quarantined", "unknown", "interrupted"].includes(attempt.status) ? "bad" : "info";
  return (
    <li className="rounded-ctl border border-line bg-surface-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">Attempt #{attempt.attemptNumber}</p>
        <StatusPill tone={tone}>{attempt.status.replace(/_/g, " ")}</StatusPill>
      </div>
      <p className="mt-1 text-xs text-muted">
        {attempt.claimedByWorkerId ? <>Worker <span className="text-ink">{attempt.claimedByWorkerId}</span> · </> : null}
        fencing epoch {attempt.currentFencingEpoch} · started {attempt.startedAt ? relativeTime(attempt.startedAt) : "not started"}
      </p>
      {attempt.leases.length > 0 && (
        <ul className="mt-2 space-y-1.5" aria-label={`Leases for attempt ${attempt.attemptNumber}`}>
          {attempt.leases.map((l) => {
            const stale = l.status === "active" && l.fencingEpoch < latestEpoch;
            return (
              <li key={l.leaseId} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface px-2.5 py-1.5 text-xs">
                <span>Epoch {l.fencingEpoch} · {l.workerId}</span>
                <span className="flex items-center gap-2">
                  {stale && <StatusPill tone="warn">superseded</StatusPill>}
                  <StatusPill tone={leaseTone(l.status)}>{l.status}</StatusPill>
                  <span className="text-muted">expires {relativeTime(l.expiresAt)}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

export function TracePage({ data }: { data: TraceReadModel }) {
  const w = data.workItem;
  const latestEpoch = Math.max(0, ...data.attempts.flatMap((a) => [a.currentFencingEpoch, ...a.leases.map((l) => l.fencingEpoch)]));
  return (
    <div className="space-y-6">
      <p><Link to="/queue" className="text-sm text-accent hover:underline">← Back to work queue</Link></p>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-tight">{w.title}</h2>
            <p className="mt-1 max-w-3xl text-sm text-muted">{w.intent}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
              <IdChip id={w.id} /> requested by {w.requester ?? "unknown"} · created {relativeTime(w.createdAt)} · updated {relativeTime(w.updatedAt)}
              {w.lineage?.sourceWorkItemId && <span>· retry #{w.lineage.retrySequence ?? "?"} of <Link className="text-accent hover:underline" to={`/queue/${encodeURIComponent(w.lineage.sourceWorkItemId)}`}>previous attempt</Link></span>}
            </div>
          </div>
          <div className="flex gap-2"><StatusPill tone="info">{w.status.replace(/_/g, " ")}</StatusPill><StatusPill tone={w.risk === "high" || w.risk === "critical" ? "bad" : w.risk === "medium" ? "warn" : "neutral"} glyph="◆">{w.risk} risk</StatusPill></div>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card title="Execution trace" subtitle="Request to result. Stages marked derived are projected from audit events.">
          <ol aria-label="Execution trace stages">{data.stages.map((s, i) => <Stage key={s.key} stage={s} last={i === data.stages.length - 1} />)}</ol>
        </Card>

        <div className="space-y-6">
          <Card title="Plan and admission" subtitle="Admission is shown only when persisted; a plan without it is not admitted.">
            {data.plan ? (
              <div className="space-y-3 text-sm">
                <p>{data.plan.objective}</p>
                <ol className="space-y-1.5" aria-label="Plan steps">
                  {data.plan.steps.map((s) => <li key={s.sequence} className="rounded-md bg-surface-2 px-3 py-1.5"><span className="font-medium">{s.sequence}. {s.kind}</span> <span className="text-muted">{s.description}</span></li>)}
                </ol>
                <dl className="grid grid-cols-2 gap-3 text-xs">
                  <div><dt className="text-muted">Plan</dt><dd>#{data.plan.planNumber} <IdChip id={data.plan.planHash} /></dd></div>
                  <div><dt className="text-muted">Execution mode</dt><dd>{data.plan.constraints.executionMode.replace(/_/g, " ")}</dd></div>
                  <div><dt className="text-muted">Max runtime</dt><dd>{formatDuration(data.plan.constraints.maxRuntimeMs)}</dd></div>
                  <div><dt className="text-muted">Allowed commands</dt><dd>{data.plan.constraints.allowedCommandCount} (not shown)</dd></div>
                </dl>
                {data.admission ? (
                  <dl className="grid grid-cols-2 gap-3 border-t border-line pt-3 text-xs">
                    <div><dt className="text-muted">Admission</dt><dd><IdChip id={data.admission.admissionId} /></dd></div>
                    <div><dt className="text-muted">Policy version</dt><dd>{data.admission.policyVersion}</dd></div>
                    <div><dt className="text-muted">Decision hash</dt><dd><IdChip id={data.admission.policyDecisionHash} /></dd></div>
                    <div><dt className="text-muted">Requires approval</dt><dd>{data.admission.requiresApproval ? "yes" : "no"}</dd></div>
                  </dl>
                ) : <div className="border-t border-line pt-3"><StatusPill tone="warn">Plan not admitted</StatusPill></div>}
              </div>
            ) : <EmptyState title="No plan persisted for this work item" />}
          </Card>

          <Card title="Attempts and leases" subtitle="Retries are new attempts. A lower fencing epoch is never current ownership.">
            {data.attempts.length === 0 ? <EmptyState title="No attempt has started" /> : <ul className="space-y-3">{data.attempts.map((a) => <Attempt key={a.attemptId} attempt={a} latestEpoch={latestEpoch} />)}</ul>}
          </Card>

          <Card title="Result">
            {data.result ? (
              <div className="space-y-1 text-sm">
                {data.result.outcome && <StatusPill tone={data.result.outcome === "succeeded" ? "ok" : "neutral"}>{data.result.outcome}</StatusPill>}
                <p className="text-muted">{data.result.summary ?? "A result was recorded without a summary."}</p>
              </div>
            ) : <EmptyState title="No result recorded" />}
          </Card>
        </div>
      </div>

      <Card title="Audit timeline" subtitle="Events for this work item, redacted and bounded.">
        {data.events.length === 0 ? <EmptyState title="No events retrieved" /> : (
          <ol tabIndex={0} aria-label="Audit events, oldest first" className="max-h-96 divide-y divide-line/60 overflow-y-auto">
            {data.events.map((e) => (
              <li key={e.sequence} className="py-2">
                <div className="flex items-center justify-between gap-2 text-xs"><span className="font-mono font-medium">{e.name}</span><time dateTime={e.at} className="text-muted">{clockTime(e.at)}</time></div>
                {e.summary && e.summary !== "{}" && <p className="mt-0.5 truncate font-mono text-[11px] text-muted" title={e.summary}>{e.summary}</p>}
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
