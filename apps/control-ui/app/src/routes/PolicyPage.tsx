import { useMemo, useState, type FormEvent } from "react";
import { endpoints } from "../api/endpoints";
import type { PolicyExplainInput, PolicyExplainResult } from "../api/types";
import { describeError } from "../api/errors";
import { formatPercent } from "../domain/format";
import { eventTimeMs } from "../state/reconcile";
import { formatTime } from "../domain/format";
import { useEventBackfill } from "../state/data";
import { useAction } from "../components/Dialog";
import {
  Badge,
  Card,
  CopyButton,
  EmptyState,
  ErrorState,
  KV,
  LoadingState,
  MissingContract,
  Meter,
  PageHead,
  Stat
} from "../components/ui";
import { DataTable } from "../components/DataTable";
import { Link } from "../router";

const DECISION_TONE = { allow: "success", require_approval: "warning", deny: "danger" } as const;
const DECISION_LABEL = { allow: "Allow", require_approval: "Approval required", deny: "Blocked" } as const;

/** Explanation only. POST /policy/explain records nothing and executes nothing; this page says so. */
export function PolicyPage() {
  const events = useEventBackfill();
  const decisions = useMemo(() => (events.data ?? []).filter((e) => e.name === "policy.decided"), [events.data]);
  const summary = useMemo(() => {
    const total = decisions.length;
    const by = { allow: 0, require_approval: 0, deny: 0 };
    const rules = new Map<string, number>();
    for (const event of decisions) {
      const d = event.attributes?.["policy.decision"];
      if (d === "allow" || d === "require_approval" || d === "deny") by[d] += 1;
      const matched = (event.body as Record<string, unknown> | undefined)?.matchedRules;
      if (Array.isArray(matched))
        for (const rule of matched) if (typeof rule === "string") rules.set(rule, (rules.get(rule) ?? 0) + 1);
    }
    return { total, by, topRules: [...rules.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6) };
  }, [decisions]);

  return (
    <div className="page" data-testid="page-policy">
      <PageHead
        title="Policy"
        description="Observe and explain policy decisions. Nothing on this page executes an action."
      />
      <div className="stat-grid">
        <Stat label="Decisions in window" value={events.hasData ? summary.total : "—"} note="Latest 500 audit events" />
        <Stat
          label="Allow rate"
          value={summary.total ? formatPercent(summary.by.allow / summary.total) : "—"}
          tone="success"
        />
        <Stat
          label="Approval-required rate"
          value={summary.total ? formatPercent(summary.by.require_approval / summary.total) : "—"}
          tone="warning"
        />
        <Stat
          label="Blocked rate"
          value={summary.total ? formatPercent(summary.by.deny / summary.total) : "—"}
          tone="danger"
        />
      </div>
      <div className="layout-grid">
        <div className="span-5">
          <Card title="Policy Decision Explorer" labelledBy="h-explorer">
            <Explorer />
          </Card>
        </div>
        <div className="span-7 stack">
          <Card title="Decision mix" labelledBy="h-mix">
            {summary.total === 0 ? (
              <EmptyState title="No policy decisions in the loaded window" />
            ) : (
              <Meter
                label="Policy decisions"
                segments={[
                  { label: "Allow", value: summary.by.allow, tone: "success" },
                  { label: "Approval required", value: summary.by.require_approval, tone: "warning" },
                  { label: "Blocked", value: summary.by.deny, tone: "danger" }
                ]}
              />
            )}
          </Card>
          <Card title="Top matching rules" labelledBy="h-rules" flush>
            {summary.topRules.length === 0 ? (
              <EmptyState title="No rule matches recorded" />
            ) : (
              <DataTable
                caption="Top matching policy rules"
                rows={summary.topRules}
                rowKey={([rule]) => rule}
                columns={[
                  { id: "r", header: "Rule", cell: ([rule]) => <span className="mono">{rule}</span> },
                  { id: "c", header: "Decisions", cell: ([, n]) => n }
                ]}
              />
            )}
          </Card>
        </div>
      </div>
      <Card title="Recent evaluations" labelledBy="h-recent" flush>
        {events.error && !events.hasData ? (
          <ErrorState error={events.error} onRetry={events.refetch} />
        ) : !events.hasData ? (
          <LoadingState />
        ) : (
          <DataTable
            caption="Recent policy evaluations"
            rows={[...decisions].sort((a, b) => b.sequence - a.sequence).slice(0, 50)}
            rowKey={(e) => e.id}
            empty={<EmptyState title="No persisted policy evaluations" />}
            columns={[
              { id: "t", header: "Time", cell: (e) => formatTime(eventTimeMs(e), { seconds: true }) },
              {
                id: "w",
                header: "Work item",
                cell: (e) =>
                  e.attributes?.["work_item.id"] ? (
                    <Link to={`/work/${encodeURIComponent(String(e.attributes["work_item.id"]))}`}>
                      {String(e.attributes["work_item.id"])}
                    </Link>
                  ) : (
                    "—"
                  )
              },
              {
                id: "d",
                header: "Decision",
                cell: (e) => {
                  const d = String(e.attributes?.["policy.decision"] ?? "");
                  return d in DECISION_TONE ? (
                    <Badge
                      meta={{
                        label: DECISION_LABEL[d as keyof typeof DECISION_LABEL],
                        tone: DECISION_TONE[d as keyof typeof DECISION_TONE]
                      }}
                    />
                  ) : (
                    "—"
                  );
                }
              },
              {
                id: "r",
                header: "Rationale",
                cell: (e) => (
                  <span className="truncate" style={{ display: "block", maxWidth: 360 }}>
                    {String((e.body as Record<string, unknown>)?.reason ?? "—")}
                  </span>
                )
              },
              {
                id: "h",
                header: "Action hash",
                cell: (e) => <span className="hash">{String(e.attributes?.["action.hash"] ?? "—").slice(0, 16)}…</span>
              }
            ]}
          />
        )}
      </Card>
      <MissingContract
        what="Policy version & simulation history"
        detail="The gateway does not expose a policy-version endpoint or history of /policy/explain runs (explain intentionally records nothing). Evaluations above are the persisted policy.decided audit events."
      />
    </div>
  );
}

function Explorer() {
  const [form, setForm] = useState({
    requester: "agent",
    actor: "operator",
    operation: "create",
    risk: "low",
    kind: "",
    description: "",
    cwd: "",
    paths: "",
    command: "",
    network: false,
    write: false,
    destructive: false
  });
  const [result, setResult] = useState<PolicyExplainResult | undefined>(undefined);
  const explain = useAction((input: PolicyExplainInput) => endpoints.explainPolicy(input));
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.kind.trim() || !form.description.trim()) return;
    const input: PolicyExplainInput = {
      workItemId: "policy-explorer",
      actor: form.actor.trim() || "operator",
      operation: form.operation,
      requester: form.requester.trim() || "agent",
      risk: form.risk as PolicyExplainInput["risk"],
      action: { kind: form.kind.trim(), description: form.description.trim(), params: {} },
      ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}),
      ...(form.paths.trim()
        ? {
            paths: form.paths
              .split(/\n|,/u)
              .map((p) => p.trim())
              .filter(Boolean)
          }
        : {}),
      ...(form.command.trim() ? { command: form.command.trim().split(/\s+/u) } : {}),
      network: form.network,
      write: form.write,
      destructive: form.destructive
    };
    const outcome = await explain.run(input);
    if (outcome?.ok) setResult(outcome.value);
    else setResult(undefined);
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)} aria-label="Policy explain form">
      <div className="banner" data-tone="info" role="note">
        <p>
          Simulation only. Submitting asks the gateway to explain what policy would decide. It does not create a work
          item, request approval or run anything.
        </p>
      </div>
      <div className="layout-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <label className="field">
          <span>Requester</span>
          <input className="input" value={form.requester} onChange={(e) => set("requester", e.target.value)} />
        </label>
        <label className="field">
          <span>Actor</span>
          <input className="input" value={form.actor} onChange={(e) => set("actor", e.target.value)} />
        </label>
        <label className="field">
          <span>Operation</span>
          <select className="select" value={form.operation} onChange={(e) => set("operation", e.target.value)}>
            {["create", "approve", "unblock", "claim"].map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Risk</span>
          <select className="select" value={form.risk} onChange={(e) => set("risk", e.target.value)}>
            {["low", "medium", "high", "critical"].map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Action kind (required)</span>
        <input
          className="input"
          value={form.kind}
          onChange={(e) => set("kind", e.target.value)}
          placeholder="e.g. shell.exec, fs.write"
          required
          aria-required="true"
        />
      </label>
      <label className="field">
        <span>Description (required)</span>
        <input
          className="input"
          value={form.description}
          onChange={(e) => set("description", e.target.value)}
          required
          aria-required="true"
        />
      </label>
      <label className="field">
        <span>Working directory / target</span>
        <input className="input" value={form.cwd} onChange={(e) => set("cwd", e.target.value)} />
      </label>
      <label className="field">
        <span>Paths (comma or newline separated)</span>
        <textarea className="textarea" value={form.paths} onChange={(e) => set("paths", e.target.value)} />
      </label>
      <label className="field">
        <span>Command (space separated argv)</span>
        <input className="input" value={form.command} onChange={(e) => set("command", e.target.value)} />
      </label>
      <div className="row">
        {(["network", "write", "destructive"] as const).map((flag) => (
          <label key={flag} className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={form[flag]} onChange={(e) => set(flag, e.target.checked)} /> {flag}
          </label>
        ))}
      </div>
      <div className="row">
        <button
          type="submit"
          className="btn"
          data-variant="primary"
          disabled={explain.pending || !form.kind.trim() || !form.description.trim()}
        >
          {explain.pending ? "Explaining…" : "Explain decision"}
        </button>
      </div>
      {explain.error !== undefined && (
        <div className="banner" data-tone="danger" role="alert">
          <div>
            <strong>Could not explain</strong>
            <p>{describeError(explain.error)}</p>
          </div>
        </div>
      )}
      {result && (
        <div className="stack" data-testid="explain-result" aria-live="polite">
          <div className="row">
            <Badge meta={{ label: DECISION_LABEL[result.decision], tone: DECISION_TONE[result.decision] }} />
            <span className="chip">Explanation only — nothing was executed</span>
          </div>
          <KV
            items={[
              ["Rationale", result.reason],
              ["Matched rules", result.matchedRules.length ? result.matchedRules.join(", ") : "—"],
              [
                "Action hash",
                <span className="hash" key="h">
                  {result.actionHash} <CopyButton value={result.actionHash} label="action hash" />
                </span>
              ],
              ["Required approver", result.requiredApprover ?? "—"],
              ["Max runtime", result.maxRuntimeMs ? `${result.maxRuntimeMs} ms` : "—"],
              ["Allowed paths", result.allowedPaths?.join(", ") ?? "—"]
            ]}
          />
          <p className="hint">
            Policy version and decision hash are attached to admissions and leases (see Execution); /policy/explain does
            not return them.
          </p>
        </div>
      )}
    </form>
  );
}
