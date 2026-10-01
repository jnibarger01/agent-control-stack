import { icon } from "../icons.js";
import { type WorkItem, type ExecutionAttempt, type ExecutionTelemetry } from "@agent-control-stack/work-items";
import { nanoToIso, pill, time } from "../format.js";
import { escapeHtml } from "../html.js";
import { approvalWaitMs, DEFAULT_APPROVAL_SLA_MS, formatWait } from "../operator-workflow.js";
import { redactSecrets, redactedAttributesJson } from "../redaction.js";
import { type MissionControlAgent, type MissionControlViewModel } from "../types.js";
import { executionModeChip } from "../execution-mode.js";
import { eventTimeline, toCount } from "./panels.js";

const safe = (value: unknown) => escapeHtml(redactSecrets(String(value ?? "—")));
export const PAGE_META: Record<string, { title: string; description: string; icon: string }> = {
  overview: {
    title: "Mission Control",
    description: "Coordinate work, agents, and outcomes across the control plane.",
    icon: "⌂"
  },
  queue: {
    title: "Work Queue",
    description: "Inspect work, admission, policy, and the next action that needs your attention.",
    icon: "▤"
  },
  execution: {
    title: "Execution",
    description: "Monitor live attempts, queues, failures, and throughput across the control plane.",
    icon: "▷"
  },
  approvals: {
    title: "Approvals",
    description: "Review policy-bound requests and record an explicit operator decision.",
    icon: "◇"
  },
  agents: {
    title: "Agents",
    description: "Registry identities, capability coverage, assignments, and observed health.",
    icon: "♧"
  },
  executors: {
    title: "Executors",
    description: "Inspect managed bridges, attested runtimes, and execution capabilities.",
    icon: "⬡"
  },
  connectors: {
    title: "Connectors",
    description: "Registered integrations, granted scopes, and authenticated tunnel sessions.",
    icon: "⌘"
  },
  metrics: {
    title: "Metrics",
    description: "Persisted execution telemetry and observed control-plane counters.",
    icon: "▥"
  },
  audit: {
    title: "Audit",
    description: "Investigate immutable events, actors, resources, and correlated decisions.",
    icon: "▦"
  },
  policy: {
    title: "Policy",
    description: "Understand evaluations, matched rules, and fail-closed decisions.",
    icon: "⛨"
  },
  system: {
    title: "System",
    description: "Readiness checks, execution admission, and connected infrastructure.",
    icon: "⚙"
  }
};

export function metricCard(label: string, value: string | number, note: string, tone = "blue"): string {
  return `<div class="metric-card ${safe(tone)}"><span class="metric-icon" aria-hidden="true">${icon(tone === "green" ? "check" : tone === "red" ? "alert" : tone === "amber" ? "clock" : "trend")}</span><div><strong>${safe(value)}</strong><span>${safe(label)}</span><small>${safe(note)}</small></div></div>`;
}
export function sectionCard(title: string, content: string, view?: string): string {
  return `<section class="section-card"><div class="panel-head"><h2>${safe(title)}</h2>${view ? `<a href="#${safe(view)}" data-dashboard-view="${safe(view)}">View all →</a>` : ""}</div>${content}</section>`;
}
export function duration(ms: number | null | undefined): string {
  return ms === null || ms === undefined || !Number.isFinite(ms) ? "—" : formatWait(Math.max(0, ms));
}
const FINAL_ATTEMPTS = new Set<ExecutionAttempt["status"]>([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "quarantined"
]);

/** Explicit presentation mapping. Unknown/cancelling/quarantined stay visible;
 * ACS has no durable waiting-on-tool state, so none is synthesized.
 */
export function executionStage(item: WorkItem, attempt?: ExecutionAttempt): string {
  if (
    attempt &&
    (attempt.status === "unknown" ||
      attempt.status === "quarantined" ||
      attempt.status === "interrupted" ||
      attempt.status === "cancellation_requested")
  )
    return attempt.status;
  const names: Record<WorkItem["status"], string> = {
    draft: "Pending",
    pending_policy: "Policy Check",
    needs_approval: "Waiting Approval",
    approved: "Approved",
    running: "Running",
    succeeded: "Completed",
    failed: "Failed",
    blocked: "Blocked",
    cancelled: "Cancelled",
    rejected: "Rejected",
    cancelling: "Cancelling",
    unknown: "Unknown",
    quarantined: "Quarantined"
  };
  return names[item.status];
}

function summaryCards(model: MissionControlViewModel): string {
  const telemetry = model.executionTelemetry;
  const count = (status: string) =>
    model.statusCounts
      ? toCount(model.statusCounts[status])
      : model.workItems.filter((i) => i.status === status).length;
  const settled = telemetry ? telemetry.succeeded + telemetry.failed : 0;
  return `<div class="metric-grid">${[
    metricCard("Active Runs", count("running"), "Current running work items"),
    metricCard(
      "Queued Runs",
      model.infrastructure ? model.infrastructure.admission.queued : "—",
      "Admission scheduler queue",
      "amber"
    ),
    metricCard("Avg Run Time", duration(telemetry?.averageRunMs), "Terminal attempts · last 24h"),
    metricCard(
      "Success Rate",
      settled ? `${Math.round((100 * telemetry!.succeeded) / settled)}%` : "—",
      "Succeeded / succeeded + failed · 24h",
      "green"
    ),
    metricCard("Failed · 24h", telemetry?.failed ?? "—", "Persisted failed attempts", "red")
  ].join("")}</div>`;
}

/** Directory/project context is never presented as an agent identity. */
function assignedAgent(model: MissionControlViewModel, item: WorkItem): string {
  const agent = model.agents?.find((a) => a.currentWorkItemId === item.id || item.target.services?.includes(a.id));
  return agent?.displayName ?? "Unassigned";
}
function activityTimeline(model: MissionControlViewModel, prefix?: RegExp): string {
  const events = [...model.events]
    .reverse()
    .filter((e) => !prefix || prefix.test(e.name))
    .slice(0, 8);
  if (!events.length) return '<p class="empty">No recorded activity in this window.</p>';
  return `<ol class="activity-timeline">${events
    .map((e) => {
      const id = e.attributes["work_item.id"];
      const item = model.workItems.find((i) => i.id === id);
      const subject =
        item?.title ?? e.attributes["agent.id"] ?? e.attributes["connector.id"] ?? e.attributes["actor.id"];
      return `<li><span class="activity-marker" aria-hidden="true"></span><div><strong>${safe(e.name.replaceAll("_", " ").replaceAll(".", " · "))}</strong><small>${safe(subject)}</small><time>${safe(time(nanoToIso(e.timeUnixNano)))}</time></div>${item ? `<button data-inspect-work="${safe(item.id)}">Inspect</button>` : ""}</li>`;
    })
    .join("")}</ol>`;
}

function missionCard(item: WorkItem, model: MissionControlViewModel): string {
  const agent = assignedAgent(model, item);
  return `<button class="mission-card" data-inspect-work="${safe(item.id)}"><strong>${safe(item.title)}</strong><small>${safe(item.id)}</small><p>${safe(item.target.cwd ?? "No project reported")} · ${item.requestedActions.length} actions</p><span>${pill(item.risk)} ${executionModeChip(item)}</span><footer><span>${safe(agent || "Unassigned")}</span><span>${safe(item.status)}</span></footer></button>`;
}
function missionBoard(model: MissionControlViewModel): string {
  const columns: Array<{ label: string; statuses: WorkItem["status"][]; tone: string }> = [
    { label: "Ready", statuses: ["draft", "pending_policy", "approved"], tone: "green" },
    { label: "Running", statuses: ["running", "cancelling"], tone: "blue" },
    { label: "Waiting Approval", statuses: ["needs_approval"], tone: "amber" },
    { label: "Blocked", statuses: ["blocked", "unknown", "quarantined"], tone: "red" }
  ];
  return `<div class="mission-board">${columns
    .map((c) => {
      const items = model.workItems.filter((i) => c.statuses.includes(i.status));
      return `<section class="board-column ${c.tone}"><h3><i aria-hidden="true"></i>${c.label}<span>${items.length}</span></h3>${
        items
          .slice(0, 6)
          .map((item) => missionCard(item, model))
          .join("") || '<p class="empty">No work in this stage.</p>'
      }${items.length > 6 ? `<a href="#queue" data-dashboard-view="queue" data-dashboard-statuses="${c.statuses.join(",")}">Inspect all ${items.length} items →</a>` : ""}</section>`;
    })
    .join("")}</div>`;
}
function healthRail(agents: MissionControlAgent[]): string {
  return `<div class="rail-list">${
    agents
      .slice(0, 8)
      .map(
        (a) =>
          `<a class="health-row" href="#agents" data-inspect-agent="${safe(a.id)}"><span class="agent-avatar" aria-hidden="true">${safe(a.displayName.charAt(0))}</span><span><strong>${safe(a.displayName)}</strong><small>${safe(a.lastHeartbeatAt ? `Heartbeat ${time(a.lastHeartbeatAt)}` : "No heartbeat observed")}</small></span>${pill(a.health)}</a>`
      )
      .join("") || '<p class="empty">No agents registered.</p>'
  }</div>`;
}
function failures(model: MissionControlViewModel): string {
  const items = model.workItems.filter((i) => ["failed", "blocked", "quarantined", "unknown"].includes(i.status));
  return `<div class="rail-list">${
    items
      .slice(0, 8)
      .map(
        (i) =>
          `<div class="failure-row"><span class="failure-icon" aria-hidden="true">!</span><div><strong>${safe(i.title)}</strong><small>${safe(i.result?.error ?? i.status)}</small>${executionModeChip(i)}</div><button data-inspect-work="${safe(i.id)}">${i.status === "failed" ? "Review / retry" : "Inspect"}</button></div>`
      )
      .join("") || '<p class="empty">No failures or blocked work in the displayed window.</p>'
  }</div>`;
}
function systems(model: MissionControlViewModel): string {
  const checks = model.readiness?.checks;
  return `<div class="system-check-grid">${
    checks
      ? Object.entries(checks)
          .map(
            ([name, check]) =>
              `<div><span class="health-dot ${check.ok ? "green" : "red"}"></span><strong>${safe(name)}</strong><small>${check.ok ? "Passing" : safe(check.code ?? "Failing")}</small></div>`
          )
          .join("")
      : '<p class="empty">Readiness checks unavailable.</p>'
  }</div>`;
}
export function throughputChart(telemetry: ExecutionTelemetry | undefined): string {
  if (!telemetry) return '<p class="empty">Persisted execution telemetry unavailable.</p>';
  const rows = telemetry.throughput;
  if (!rows.some((r) => r.started || r.completed || r.failed))
    return '<p class="empty">No execution attempt activity in the last 24 hours.</p>';
  const max = Math.max(1, ...rows.flatMap((r) => [r.started, r.completed, r.failed]));
  const bars = rows
    .map((row, index) => {
      const x = 30 + index * 30;
      return `<g><title>${safe(row.at)}: ${row.started} started, ${row.completed} completed, ${row.failed} failed</title>${[row.started, row.completed, row.failed].map((n, j) => `<rect x="${x + j * 7}" y="${130 - (n / max) * 100}" width="5" height="${(n / max) * 100}" class="chart-${j}"/>`).join("")}</g>`;
    })
    .join("");
  return `<div class="chart-wrap"><p class="chart-legend"><span>● Started</span><span>● Completed</span><span>● Failed</span></p><svg viewBox="0 0 770 162" role="img" aria-label="Persisted execution attempts over the last 24 hours"><title>Hourly attempt throughput. Maximum ${max} attempts per series.</title><path d="M25 30H760M25 80H760M25 130H760" class="chart-grid"/><text x="2" y="32">${max}</text><text x="6" y="134">0</text>${bars}<text x="30" y="155">24h ago</text><text x="380" y="155">12h ago</text><text x="730" y="155">Now</text></svg><details><summary>Inspect hourly values</summary><div class="table-wrap"><table><thead><tr><th>Hour starting</th><th>Started</th><th>Completed</th><th>Failed</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${safe(time(r.at))}</td><td>${r.started}</td><td>${r.completed}</td><td>${r.failed}</td></tr>`).join("")}</tbody></table></div></details></div>`;
}
function executionTable(model: MissionControlViewModel): string {
  return `<div class="execution-filter"><label>Search runs <input type="search" id="execution-search" placeholder="Title, ID, agent, or executor"></label><label>Stage <select id="execution-stage"><option value="">All stages</option>${[...new Set(model.workItems.map((i) => executionStage(i, model.executionAttemptsByWorkItem?.[i.id]?.at(-1))))].map((stage) => `<option>${safe(stage)}</option>`).join("")}</select></label><span id="execution-filter-count" role="status"></span></div><div class="table-wrap"><table class="runs-table"><thead><tr><th>Run / Work Item</th><th>Agent</th><th>Executor / Worker</th><th>Stage</th><th>Elapsed</th><th>Queue Age</th><th>Risk</th><th>Detail</th></tr></thead><tbody>${
    model.workItems
      .map((item) => {
        const attempts = model.executionAttemptsByWorkItem?.[item.id] ?? [];
        const attempt = attempts.at(-1);
        const agent = assignedAgent(model, item);
        const stage = executionStage(item, attempt);
        const now = (model.now ?? new Date()).getTime();
        const elapsed = attempt?.startedAt
          ? duration(
              (FINAL_ATTEMPTS.has(attempt.status) ? Date.parse(attempt.updatedAt) : now) - Date.parse(attempt.startedAt)
            )
          : "—";
        const queueAge = attempt
          ? duration((attempt.startedAt ? Date.parse(attempt.startedAt) : now) - Date.parse(attempt.createdAt))
          : ["draft", "pending_policy", "approved", "needs_approval"].includes(item.status)
            ? duration(now - Date.parse(item.createdAt))
            : "—";
        return `<tr data-run-stage="${safe(stage)}"><td><strong>${safe(attempt?.attemptId ?? item.id)}</strong><small>${safe(item.title)}</small>${executionModeChip(item)}</td><td>${safe(agent || "Unassigned")}</td><td>${safe(attempt?.claimedByWorkerId ?? "Unclaimed")}</td><td>${pill(item.status)}<small>${safe(stage)}</small></td><td>${safe(elapsed)}</td><td>${safe(queueAge)}</td><td>${pill(item.risk)}</td><td><button data-inspect-work="${safe(item.id)}" aria-label="Inspect ${safe(item.title)}">Inspect</button></td></tr>`;
      })
      .join("") || '<tr><td colspan="8" class="empty">No execution work recorded.</td></tr>'
  }</tbody></table></div>`;
}
function pipeline(model: MissionControlViewModel): string {
  const stages: Array<[string, WorkItem["status"][], string]> = [
    ["Pending", ["draft"], "blue"],
    ["Policy Check", ["pending_policy"], "violet"],
    ["Waiting Approval", ["needs_approval"], "amber"],
    ["Approved", ["approved"], "green"],
    ["Running", ["running", "cancelling"], "blue"],
    ["Completed", ["succeeded"], "green"],
    ["Failed / Blocked", ["failed", "blocked", "unknown", "quarantined"], "red"]
  ];
  return `<div class="execution-pipeline">${stages.map(([name, statuses, tone]) => `<a class="pipeline-stage ${tone}" href="#queue" data-dashboard-view="queue" data-dashboard-statuses="${statuses.join(",")}"><span class="stage-icon" aria-hidden="true">${tone === "green" ? "✓" : tone === "red" ? "!" : "◇"}</span><strong>${name}</strong><b>${statuses.reduce((sum, status) => sum + (model.statusCounts ? toCount(model.statusCounts[status]) : model.workItems.filter((i) => i.status === status).length), 0)}</b></a>`).join("")}</div><p class="panel-note">Current work-item states · completed and failed counts include retained store history. Tool wait is not a persisted ACS stage.</p>`;
}
function admission(model: MissionControlViewModel): string {
  const a = model.infrastructure?.admission;
  if (!a) return '<p class="empty">Execution capacity unavailable.</p>';
  return `<div class="admission-meter"><div><strong>${a.active} / ${a.capacity}</strong><span>Global execution slots</span></div><progress max="${Math.max(1, a.capacity)}" value="${a.active}" aria-label="Execution admission utilization"></progress><p>${a.queued} queued · ${a.saturated ? "Saturated" : "Capacity available"}</p><a href="#executors" data-dashboard-view="executors">Inspect executor runtimes →</a><small>Per-executor capacity is not published by ACS.</small></div>`;
}
export function overviewOperations(model: MissionControlViewModel, agents: MissionControlAgent[]): string {
  const active = model.workItems.filter(
    (i) => !["succeeded", "failed", "cancelled", "rejected"].includes(i.status)
  ).length;
  const ready = model.readiness;
  const pending = model.workItems.filter((i) => i.status === "needs_approval");
  return `<section class="command-summary"><div class="panel-head"><div><h2>Command Summary</h2><p>Live view of your agent operations</p></div><span class="eyebrow">ACS · governed execution</span></div><div class="metric-grid command-metrics">${metricCard("Active Work Items", active, "Current control-plane work")}${metricCard("System Readiness", ready ? (ready.ok ? "Passing" : "Degraded") : "Unknown", "Persisted dependency checks", ready?.ok ? "green" : "amber")}${metricCard("Agents Online", agents.filter((a) => a.status === "online").length, `${agents.length} registered / observed`)}${metricCard("Avg Run Time", duration(model.executionTelemetry?.averageRunMs), "Terminal attempts · last 24h")}</div></section><div class="operations-layout"><div class="operations-main">${sectionCard("Missions · Work Items", missionBoard(model), "queue")}<div class="overview-bottom">${sectionCard("Recent Activity", activityTimeline(model), "audit")}${sectionCard("Systems Overview", systems(model), "system")}</div></div><div class="operations-rail">${sectionCard("Agent Health", healthRail(agents), "agents")}${sectionCard("Critical Alerts", failures(model), "execution")}${sectionCard(
    "Approval Requests",
    `<div class="rail-list">${
      pending
        .slice(0, 4)
        .map(
          (i) =>
            `<button class="approval-preview" data-inspect-work="${safe(i.id)}"><strong>${safe(i.title)}</strong><small>${safe(i.requester)} · ${safe(i.risk)} risk · ${duration(approvalWaitMs(i, model.now ?? new Date()))}</small><span>Review request →</span></button>`
        )
        .join("") || '<p class="empty">No approvals waiting.</p>'
    }</div>`,
    "approvals"
  )}</div></div>`;
}
export function executionOperations(model: MissionControlViewModel): string {
  return `${summaryCards(model)}<div class="operations-layout"><div class="operations-main">${sectionCard("Execution Pipeline", pipeline(model))}${sectionCard("Live Runs", executionTable(model))}${sectionCard("Execution Throughput · Last 24 hours", throughputChart(model.executionTelemetry))}</div><div class="operations-rail">${sectionCard("Failures & Retries", failures(model))}${sectionCard("Execution Admission", admission(model))}${sectionCard(
    "Recent Execution Events",
    activityTimeline(model, /^(work_item\.|execution_attempt\.|attempt_lease\.)/),
    "audit"
  )}</div></div>`;
}
export function approvalSummary(model: MissionControlViewModel): string {
  const pending = model.workItems.filter((i) => i.status === "needs_approval");
  const now = model.now ?? new Date();
  const sla = model.approvalSlaMs ?? DEFAULT_APPROVAL_SLA_MS;
  return `<div class="metric-grid approval-metrics">${metricCard("Pending", pending.length, model.executionMode === "admin" ? "Admin auto-approval still requires valid authority" : "Human decisions required", "amber")}${metricCard("Over SLA", sla > 0 ? pending.filter((i) => (approvalWaitMs(i, now) ?? 0) >= sla).length : 0, sla > 0 ? `SLA ${duration(sla)}` : "SLA disabled", "red")}${metricCard("High Risk", pending.filter((i) => ["high", "critical"].includes(i.risk)).length, "Pending high / critical requests", "violet")}${metricCard("Oldest Wait", pending.length ? duration(Math.max(...pending.map((i) => approvalWaitMs(i, now) ?? 0))) : "—", "Current approval inbox", "amber")}${metricCard("Approval Grants · 24h", model.executionTelemetry?.approvalsGranted ?? "—", "Recorded action grants", "green")}${metricCard("Avg Grant Latency", duration(model.executionTelemetry?.averageApprovalMs), "Matched requirement → grant · 24h")}</div>`;
}
export function metricsOperations(model: MissionControlViewModel): string {
  return `${summaryCards(model)}${sectionCard("Execution Throughput · Last 24 hours", throughputChart(model.executionTelemetry))}<div class="metric-grid">${metricCard("Avg Queue Latency", duration(model.executionTelemetry?.averageQueueMs), "Started attempts updated in last 24h")}${metricCard("Execution Admission", model.infrastructure ? `${model.infrastructure.admission.active} / ${model.infrastructure.admission.capacity}` : "—", "Global execution slots")}</div>`;
}
export function agentOperations(agents: MissionControlAgent[], model: MissionControlViewModel): string {
  const capabilities = new Map<string, number>();
  for (const agent of agents)
    for (const capability of new Set(agent.capabilities))
      capabilities.set(capability, (capabilities.get(capability) ?? 0) + 1);
  return `<div class="overview-bottom">${sectionCard("Capability Coverage", `<div class="capability-coverage">${[...capabilities].map(([c, n]) => `<div><code>${safe(c)}</code><strong>${n} agents</strong></div>`).join("") || '<p class="empty">No capabilities registered.</p>'}</div>`)}${sectionCard(
    "Recent Agent Activity",
    eventTimeline(
      [...model.events]
        .reverse()
        .filter((e) => /^(agent\.|acp\.)/.test(e.name))
        .slice(0, 8)
    )
  )}</div>`;
}
export function auditSearch(): string {
  return `<div class="audit-filters"><label>Search audit events <input id="audit-search" type="search" placeholder="Actor, action, resource, correlation ID"></label><label>Event type <input id="audit-type" type="search" placeholder="e.g. policy.decided"></label><span id="audit-filter-count" role="status"></span></div>`;
}
export function auditOperations(model: MissionControlViewModel): string {
  return `<div class="table-wrap"><table class="audit-table"><thead><tr><th>Timestamp</th><th>Actor</th><th>Action</th><th>Resource</th><th>Result</th><th>Correlation</th><th>Details</th></tr></thead><tbody>${
    [...model.events]
      .reverse()
      .map((e) => {
        const a = e.attributes;
        return `<tr data-audit-name="${safe(e.name)}"><td>${safe(time(nanoToIso(e.timeUnixNano)))}</td><td>${safe(a["actor.id"] ?? a["agent.id"] ?? a["worker.id"])}</td><td>${safe(e.name)}</td><td>${safe(a["work_item.id"] ?? a["connector.id"] ?? a["agent.id"])}</td><td>${safe(a["policy.decision"] ?? a["work_item.status"] ?? e.name.split(".").at(-1))}</td><td>${safe(a["trace.id"] ?? a["correlation.id"])}</td><td><button type="button" data-inspect-audit="${safe(e.id)}">Inspect</button><template data-audit-detail="${safe(e.id)}"><h3>${safe(e.name)}</h3><p>${safe(time(nanoToIso(e.timeUnixNano)))}</p><dl>${Object.entries(
          a
        )
          .map(
            ([k, v]) =>
              `<div><dt>${safe(k)}</dt><dd>${/secret|token|credential|password|cookie|authorization|api.?key/i.test(k) ? "[REDACTED]" : safe(v)}</dd></div>`
          )
          .join(
            ""
          )}</dl><small>Sequence ${safe(e.sequence)} · immutable event ${safe(e.id)}</small><details><summary>Event payload</summary><pre>${safe(redactedAttributesJson(e.body))}</pre></details></template></td></tr>`;
      })
      .join("") || '<tr><td colspan="7" class="empty">No audit events recorded.</td></tr>'
  }</tbody></table></div>`;
}
export function systemOperations(model: MissionControlViewModel): string {
  return systems(model);
}
