import {
  type ExecutionAttempt,
  type ExecutionPlanAdmission,
  type ExecutionPlanRecord,
  type StoredAuditEvent,
  type WorkItem
} from "@agent-control-stack/work-items";
import { approvalActionHashPrefix } from "../approval-actions.js";
import { executionModeChip } from "../execution-mode.js";
import { nanoToIso, pill, time } from "../format.js";
import { escapeHtml } from "../html.js";
import { DEFAULT_APPROVAL_SLA_MS, approvalWaitMs, approvalWaitStart, formatWait } from "../operator-workflow.js";
import { WORK_ITEM_RISK_VALUES, WORK_ITEM_STATUS_VALUES, workItemAgentId } from "../queue-filter.js";
import { redactSecrets } from "../redaction.js";
import {
  type ApprovalActionOption,
  type MissionControlAgent,
  type MissionControlAttemptLease,
  type MissionControlInfrastructureSummary,
  type MissionControlViewModel
} from "../types.js";
import { auditAttributesHtml } from "../visibility.js";

const OPERATOR_ATTENTION_STATUSES: ReadonlySet<WorkItem["status"]> = new Set([
  "blocked",
  "needs_approval",
  "quarantined"
]);

function needsOperatorAttention(status: WorkItem["status"]): boolean {
  return OPERATOR_ATTENTION_STATUSES.has(status);
}

export function summarize(workItems: WorkItem[], agents: MissionControlAgent[], statusCounts?: Record<string, number>) {
  const count = (status: WorkItem["status"]) =>
    statusCounts ? toCount(statusCounts[status]) : workItems.filter((item) => item.status === status).length;
  // Exactly the statuses the queue rows mark with the attention badge, so the
  // overview card can never disagree with the queue about what needs an
  // operator. Quarantined work is attention-worthy but is neither a failure
  // nor blocked, so it has no other card to appear on.
  const attention = [...OPERATOR_ATTENTION_STATUSES].reduce((total, status) => total + count(status), 0);
  return {
    totalAgents: agents.length,
    onlineAgents: agents.filter((agent) => agent.status === "online").length,
    running: count("running"),
    approvals: count("needs_approval"),
    failed: count("failed") + count("blocked"),
    attention
  };
}

/**
 * View-model numbers are interpolated into HTML unescaped, so coerce them to
 * non-negative integers: a JS caller can hand the library anything.
 */
export function toCount(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

export function queueFooter(input: MissionControlViewModel["finishedWorkItems"]): string {
  if (!input) return "";
  const finished = { shown: toCount(input.shown), total: toCount(input.total) };
  if (finished.total === 0) return "";
  if (finished.shown >= finished.total) {
    return `<p class="queue-footer-note">All ${finished.total} finished items shown.</p>`;
  }
  const step = Math.min(FINISHED_PAGE_STEP, finished.total - finished.shown);
  return `<p class="queue-footer-note">Showing the ${finished.shown} most recent of ${finished.total} finished items. Active items are always shown.</p><button type="button" class="load-more" data-load-more-finished data-shown="${finished.shown}" data-step="${FINISHED_PAGE_STEP}">Show ${step} more finished</button>`;
}

const FINISHED_PAGE_STEP = 50;

export function overviewCards(
  stats: ReturnType<typeof summarize>,
  infrastructure?: MissionControlInfrastructureSummary
): string {
  const agents = infrastructure
    ? `${toCount(infrastructure.agents.online)} / ${toCount(infrastructure.agents.registered)}`
    : `${stats.onlineAgents} / ${stats.totalAgents}`;
  const executors = infrastructure
    ? `${toCount(infrastructure.executors.configured)} / ${toCount(infrastructure.executors.total)}`
    : "—";
  const connectors = infrastructure ? toCount(infrastructure.connectors.activeSessions) : "—";
  const connectorHelp = infrastructure
    ? `${toCount(infrastructure.connectors.enabled)} / ${toCount(infrastructure.connectors.registered)} registered connectors enabled`
    : "Connector state unavailable in this render";
  const cards = [
    { label: "Agents", value: agents, help: "online by heartbeat / registered", view: "agents" },
    { label: "Executors", value: executors, help: "configured / known execution bridges", view: "executors" },
    { label: "Connectors", value: connectors, help: `active tunnel sessions · ${connectorHelp}`, view: "connectors" },
    {
      label: "Running Tasks",
      value: stats.running,
      help: "Lease-bound work currently running",
      view: "execution",
      statuses: "running"
    },
    {
      label: "Needs Operator Attention",
      value: stats.attention,
      help: "Approvals, blocked, and quarantined work; the same set the queue marks for attention",
      view: "queue",
      statuses: "needs_approval,blocked,quarantined"
    },
    {
      label: "Pending Approvals",
      value: stats.approvals,
      help: "Policy-gated work waiting on a human",
      view: "approvals"
    },
    {
      label: "Failed / Blocked",
      value: stats.failed,
      help: "Failed items plus blocked work",
      view: "queue",
      statuses: "failed,blocked"
    }
  ];
  return cards
    .map(
      ({ label, value, help, view, statuses }) =>
        `<a class="card dashboard-card" href="#${view}" data-dashboard-view="${view}"${statuses ? ` data-dashboard-statuses="${statuses}"` : ""} aria-label="Open ${label}"><span>${label}</span><strong>${value}</strong><p>${help}</p><small class="card-action">Open →</small></a>`
    )
    .join("");
}

function agentRoleLabel(role: string | undefined): string {
  if (!role) return "Role not reported";
  return role
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function agentInitial(agent: MissionControlAgent): string {
  return (agent.displayName || agent.id).trim().charAt(0).toUpperCase() || "?";
}

function agentAttentionRank(agent: MissionControlAgent): number {
  if (agent.lastError) return 0;
  if (agent.status === "stale") return 1;
  if (agent.status === "online" && agent.currentTask) return 2;
  if (agent.status === "online") return 3;
  if (agent.status === "observed") return 4;
  if (agent.status === "offline") return 5;
  return 6;
}

function sortAgentsForDiscovery(agents: MissionControlAgent[]): MissionControlAgent[] {
  return [...agents].sort((left, right) => {
    const attention = agentAttentionRank(left) - agentAttentionRank(right);
    if (attention !== 0) return attention;
    return left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id);
  });
}

function agentDiscoveryControls(agents: MissionControlAgent[]): string {
  const roles = [
    ...new Set(agents.map((agent) => agent.metadata.acpRole).filter((role): role is string => Boolean(role)))
  ].sort((left, right) => agentRoleLabel(left).localeCompare(agentRoleLabel(right)));
  const roleOptions = roles
    .map((role) => `<option value="${escapeHtml(role)}">${escapeHtml(agentRoleLabel(role))}</option>`)
    .join("");
  return `<div class="agent-discovery" id="agent-discovery" role="search" aria-label="Find and filter agents">
    <label class="agent-discovery-search" for="agent-search">Search agents
      <input id="agent-search" type="search" autocomplete="off" spellcheck="false" placeholder="name, id, role, model, task" />
    </label>
    <label for="agent-role-filter">Role
      <select id="agent-role-filter"><option value="">All roles</option>${roleOptions}</select>
    </label>
    <label for="agent-status-filter">Status
      <select id="agent-status-filter">
        <option value="">All statuses</option>
        <option value="online">Online</option>
        <option value="stale">Stale</option>
        <option value="offline">Offline</option>
        <option value="observed">Observed</option>
      </select>
    </label>
    <label class="agent-attention-toggle" for="agent-attention-first">
      <input id="agent-attention-first" type="checkbox" checked />
      <span>Attention first</span>
    </label>
    <button type="button" id="agent-filter-clear" class="tool-button">Clear</button>
    <p id="agent-filter-live" class="agent-filter-live" aria-live="polite">Showing all ${agents.length} agents · attention first</p>
  </div>`;
}

function agentSummary(agents: MissionControlAgent[]): string {
  const online = agents.filter((agent) => agent.status === "online").length;
  const activeTasks = agents.filter((agent) => Boolean(agent.currentTask)).length;
  const unavailable = agents.filter((agent) => agent.status === "stale" || agent.status === "offline").length;
  return `<div class="agent-summary" id="agent-summary">
    <div><span>Registered</span><strong>${agents.length}</strong></div>
    <div><span>Online</span><strong>${online}</strong></div>
    <div><span>Active tasks</span><strong>${activeTasks}</strong></div>
    <div><span>Stale / offline</span><strong>${unavailable}</strong></div>
  </div>`;
}

function agentCard(agent: MissionControlAgent): string {
  const role = agentRoleLabel(agent.metadata.acpRole);
  const attentionClass = agent.lastError ? " has-error" : agent.status === "stale" ? " is-stale" : "";
  const providerModel = [agent.metadata.provider, agent.metadata.model].filter(Boolean).join(" · ");
  const runtime = providerModel ? `${agent.kind} · ${providerModel}` : agent.kind;
  const task = agent.currentTask ? escapeHtml(agent.currentTask) : "No active task reported";
  const heartbeat = agent.lastHeartbeatAt ? `Heartbeat ${time(agent.lastHeartbeatAt)}` : "No heartbeat observed";
  const capabilityCount = agent.capabilities.length;
  const error = agent.lastError
    ? `<span class="agent-card-error">${escapeHtml(redactSecrets(agent.lastError))}</span>`
    : "";
  return `<button type="button" class="agent-card${attentionClass}" data-agent="${escapeHtml(agent.id)}" data-agent-id="${escapeHtml(agent.id)}" data-agent-role="${escapeHtml(agent.metadata.acpRole ?? "")}" data-agent-status="${escapeHtml(agent.status)}" aria-label="Open ${escapeHtml(agent.displayName)}">
    <span class="agent-card-head">
      <span class="agent-avatar" aria-hidden="true">${escapeHtml(agentInitial(agent))}</span>
      <span class="agent-card-identity"><strong>${escapeHtml(agent.displayName)}</strong><small>${escapeHtml(agent.id)}</small></span>
      ${pill(agent.status)}
    </span>
    <span class="agent-card-meta"><span>${escapeHtml(role)}</span><span>${escapeHtml(runtime)}</span></span>
    <span class="agent-card-task"><small>Current task</small><span>${task}</span></span>
    ${error}<span class="agent-card-foot"><span>${heartbeat}</span><span>${capabilityCount} capabilit${capabilityCount === 1 ? "y" : "ies"}</span></span>
  </button>`;
}

export function agentTable(agents: MissionControlAgent[]): string {
  const ordered = sortAgentsForDiscovery(agents);
  const cards = ordered.length
    ? ordered.map(agentCard).join("")
    : `<p class="empty agent-empty">No registered agents.</p>`;
  return `<div class="agent-roster">${agentDiscoveryControls(agents)}${agentSummary(agents)}<div class="agent-card-grid" id="agent-roster-body">${cards}</div></div>`;
}

export function agentDetailPanel(): string {
  return `<section id="agent-detail" class="detail-panel agent-detail" tabindex="-1" aria-live="polite" aria-label="Agent detail">
    <div class="detail-empty"><h3>No agent selected</h3><p>Select an agent card to inspect identity, activity, sessions, and capabilities.</p></div>
  </section>`;
}

export function executorPanel(): string {
  return `<div class="agent-layout executor-layout">
    <div class="table-wrap"><p class="empty">Loading managed executors...</p></div>
    <section id="executor-detail" class="detail-panel executor-detail" tabindex="-1" aria-live="polite" aria-label="Executor detail">
      <div class="detail-empty"><h3>No executor selected</h3><p>Select a row to inspect runtime state and tool capabilities.</p></div>
    </section>
  </div>`;
}

export function queueFilterStrip(): string {
  const chips = WORK_ITEM_STATUS_VALUES.map((status) => {
    const id = `queue-status-${status}`;
    return `<label class="queue-filter-chip" for="${id}"><input type="checkbox" id="${id}" name="queue-status" value="${escapeHtml(status)}" data-queue-status="${escapeHtml(status)}" /> <span>${escapeHtml(status)}</span></label>`;
  }).join("");
  const riskChips = WORK_ITEM_RISK_VALUES.map((risk) => {
    const id = `queue-risk-${risk}`;
    return `<label class="queue-filter-chip" for="${id}"><input type="checkbox" id="${id}" name="queue-risk" value="${escapeHtml(risk)}" data-queue-risk="${escapeHtml(risk)}" /> <span>${escapeHtml(risk)}</span></label>`;
  }).join("");
  return `<div class="queue-filter" id="queue-filter" role="search" aria-label="Filter work queue">
  <div class="queue-filter-row">
    <fieldset class="queue-filter-statuses">
      <legend>Status</legend>
      <div class="queue-filter-chips">${chips}</div>
    </fieldset>
  </div>
  <div class="queue-filter-row">
    <fieldset class="queue-filter-risks">
      <legend>Risk</legend>
      <div class="queue-filter-chips">${riskChips}</div>
    </fieldset>
  </div>
  <div class="queue-filter-row queue-filter-fields">
    <label class="queue-filter-field" for="queue-filter-agent">Agent id
      <input id="queue-filter-agent" name="queue-agent" type="search" autocomplete="off" spellcheck="false" placeholder="agent / worker / target" />
    </label>
    <label class="queue-filter-field" for="queue-filter-text">Search title or id
      <input id="queue-filter-text" name="queue-text" type="search" autocomplete="off" spellcheck="false" placeholder="title or work item id" />
    </label>
  </div>
  <p id="queue-filter-live" class="queue-filter-live" aria-live="polite">Showing all work items</p>
</div>`;
}

export function workQueueItems(
  workItems: WorkItem[],
  executionPlansByWorkItem: Record<string, ExecutionPlanRecord>,
  executionPlanAdmissionsByWorkItem: Record<string, ExecutionPlanAdmission>,
  executionAttemptsByWorkItem: Record<string, ExecutionAttempt[]>,
  attemptLeasesByWorkItem: Record<string, MissionControlAttemptLease[]>
): string {
  if (!workItems.length) return `<p class="empty">No work items.</p>`;
  return workItems
    .map((item) => {
      const attention = needsOperatorAttention(item.status);
      const plan = executionPlansByWorkItem[item.id];
      const admission = executionPlanAdmissionsByWorkItem[item.id];
      const attempts = executionAttemptsByWorkItem[item.id] ?? [];
      const leases = attemptLeasesByWorkItem[item.id] ?? [];
      const agentId = workItemAgentId(item, attempts, leases);
      return `<button class="queue-item${attention ? " attention" : ""}" data-work-item="${escapeHtml(item.id)}" data-status="${escapeHtml(item.status)}" data-risk="${escapeHtml(item.risk)}" data-title="${escapeHtml(item.title)}" data-agent-id="${escapeHtml(agentId)}"><span>${pill(item.status)} ${pill(item.risk)} ${executionModeChip(item)}${attention ? attentionBadge() : ""}</span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(redactSecrets(item.intent))}</small>${executionPlanBadge(plan, admission)}${executionSummary(attempts, leases)}${workItemError(item)}</button>`;
    })
    .join("");
}

export function workDetailPanel(): string {
  return `<section id="work-detail" class="detail-panel work-detail" tabindex="-1" aria-live="polite" aria-labelledby="work-detail-heading"><div class="detail-empty"><h3 id="work-detail-heading">No work item selected</h3><p>Timeline pending.</p></div></section>`;
}

function attentionBadge(): string {
  return `<span class="attention-badge" title="Needs operator attention">&#9888; Needs attention</span>`;
}

function executionPlanBadge(plan?: ExecutionPlanRecord, admission?: ExecutionPlanAdmission): string {
  if (!plan) return "";
  if (!admission) {
    return `<small class="plan-status plan-pending">Execution plan drafted &middot; not yet admitted</small>`;
  }
  const approvalLabel = admission.requiresApproval ? "requires approval" : "auto-admitted";
  return `<small class="plan-status plan-admitted">Execution plan admitted &middot; ${escapeHtml(approvalLabel)}</small>`;
}

function executionSummary(attempts: ExecutionAttempt[], leases: MissionControlAttemptLease[]): string {
  const attempt = attempts.at(-1);
  if (!attempt) return "";
  const lease = [...leases].reverse().find((candidate) => candidate.attemptId === attempt.attemptId);
  const worker = lease?.workerId ?? attempt.claimedByWorkerId;
  return `<small class="execution-status">Attempt #${escapeHtml(String(attempt.attemptNumber))} &middot; ${escapeHtml(attempt.status)}${worker ? ` &middot; ${escapeHtml(worker)}` : ""}${lease ? ` &middot; lease ${escapeHtml(lease.status)}` : ""}</small>`;
}

export function approvalOptionsByWorkItem(model: MissionControlViewModel): Record<string, ApprovalActionOption[]> {
  const labelled = model.approvalActionsByWorkItem ?? {};
  const legacy = model.approvalActionHashesByWorkItem ?? {};
  const out: Record<string, ApprovalActionOption[]> = {};
  for (const id of new Set([...Object.keys(legacy), ...Object.keys(labelled)])) {
    out[id] = labelled[id] ?? (legacy[id] ?? []).map((actionHash) => ({ actionHash, kind: "" }));
  }
  return out;
}

function waitBadge(item: WorkItem, now: Date, slaMs: number): { html: string; overdue: boolean } {
  const wait = approvalWaitMs(item, now);
  if (wait === undefined) return { html: "", overdue: false };
  const overdue = slaMs > 0 && wait >= slaMs;
  return {
    overdue,
    html: `<small class="wait-badge" data-waiting-since="${escapeHtml(approvalWaitStart(item))}" data-sla-ms="${slaMs}">waiting ${formatWait(wait)}${overdue ? " · over SLA" : ""}</small>`
  };
}

export function approvalsPanel(
  items: WorkItem[],
  approvalActionsByWorkItem: Record<string, ApprovalActionOption[]>,
  now: Date,
  slaMs: number
): string {
  if (!items.length) return `<p class="empty">No approvals or blocked work.</p>`;
  return `<div class="approvals-list" role="list">${items
    .map((item) => {
      const actions = item.requestedActions.map((action) => action.kind).join(", ") || "none";
      const approvalSummary =
        typeof item.requestedActions[0]?.params?.approvalSummary === "string"
          ? item.requestedActions[0].params.approvalSummary
          : undefined;
      const error = workItemResultError(item);
      const reasonId = `reason-${escapeHtml(item.id)}`;
      const resultId = `approval-result-${escapeHtml(item.id)}`;
      const reason = `<label class="reason-field" for="${reasonId}"><span class="reason-label">Reason <span class="req">(required)</span></span><input id="${reasonId}" data-reason="${escapeHtml(item.id)}" required placeholder="Why approve, reject, or unblock" autocomplete="off" /></label>`;
      const outcome = `<output id="${resultId}" class="approval-result" aria-live="polite"></output>`;
      const approvalButtons = approvalButtonsFor(item, approvalActionsByWorkItem[item.id] ?? [], reasonId);
      const wait = waitBadge(item, now, slaMs);
      const cardAttrs = `class="approval-item${wait.overdue ? " overdue" : ""}" role="listitem" data-risk="${escapeHtml(item.risk)}" data-status="${escapeHtml(item.status)}" data-work-item-ref="${escapeHtml(item.id)}"`;
      if (item.status === "blocked") {
        return `<article ${cardAttrs}><span>${pill(item.status)} ${pill(item.risk)} ${executionModeChip(item)}${wait.html}</span><strong id="approval-title-${escapeHtml(item.id)}">${escapeHtml(item.title)}</strong><small>Actions: ${escapeHtml(actions)}</small>${error ? `<small class="error-line">${escapeHtml(error)}</small>` : ""}${reason}<div class="approval-actions" role="group" aria-label="Actions for ${escapeHtml(item.title)}"><button type="button" data-unblock="${escapeHtml(item.id)}" data-risk="${escapeHtml(item.risk)}" aria-describedby="${reasonId}">Unblock</button><button type="button" data-reject="${escapeHtml(item.id)}" data-risk="${escapeHtml(item.risk)}" aria-describedby="${reasonId}">Reject</button></div>${outcome}</article>`;
      }
      return `<article ${cardAttrs}><span>${pill(item.status)} ${pill(item.risk)} ${wait.html}</span><strong id="approval-title-${escapeHtml(item.id)}">${escapeHtml(item.title)}</strong><small>Requester: ${escapeHtml(item.requesterSubject ?? item.requester)} · Actions: ${escapeHtml(actions)}</small>${approvalSummary ? `<small class="approval-summary">${escapeHtml(redactSecrets(approvalSummary))}</small>` : ""}${reason}<div class="approval-actions" role="group" aria-label="Actions for ${escapeHtml(item.title)}">${approvalButtons}<button type="button" data-reject="${escapeHtml(item.id)}" data-risk="${escapeHtml(item.risk)}" aria-describedby="${reasonId}">Reject</button></div>${outcome}</article>`;
    })
    .join("")}</div>`;
}

function approvalButtonsFor(item: WorkItem, options: ApprovalActionOption[], reasonId: string): string {
  if (!options.length) {
    return `<button type="button" data-approve="${escapeHtml(item.id)}" data-risk="${escapeHtml(item.risk)}" disabled aria-describedby="${reasonId}">Approval hash unavailable</button>`;
  }
  return options
    .map((option, index) => {
      const hashPrefix = approvalActionHashPrefix(option.actionHash, 8);
      const kind = option.kind ? ` ${escapeHtml(option.kind)}` : ` ${index + 1}`;
      const described = option.description ? `: ${redactSecrets(option.description)}` : "";
      const ariaLabel = `Approve ${option.kind || `action ${index + 1}`}${described} (hash ${hashPrefix}) for ${item.title}`;
      return `<button type="button" data-approve="${escapeHtml(item.id)}" data-action-hash="${escapeHtml(option.actionHash)}"${option.kind ? ` data-action-kind="${escapeHtml(option.kind)}"` : ""} data-risk="${escapeHtml(item.risk)}" aria-label="${escapeHtml(ariaLabel)}" aria-describedby="${reasonId}" title="${escapeHtml(option.actionHash)}">Approve${kind} <code class="hash-prefix">${escapeHtml(hashPrefix)}</code></button>`;
    })
    .join("");
}

function workItemError(item: WorkItem): string {
  const error = workItemResultError(item);
  return error ? `<small class="error-line">${escapeHtml(error)}</small>` : "";
}

function workItemResultError(item: WorkItem): string | undefined {
  const result = item.result;
  return result && typeof result.error === "string" ? redactSecrets(result.error) : undefined;
}

export function operatorMetricsPanel(
  workItems: WorkItem[],
  attemptLeasesByWorkItem: Record<string, MissionControlAttemptLease[]>,
  now: Date,
  slaMs: number = DEFAULT_APPROVAL_SLA_MS
): string {
  const activeLeases = Object.values(attemptLeasesByWorkItem)
    .flat()
    .filter((lease) => lease.status === "active");
  const pendingApprovals = workItems.filter((item) => item.status === "needs_approval");
  // Every card that waits on a human, i.e. exactly the population the
  // approvals panel renders wait badges for. Kept in step with that panel so
  // the breach count can never disagree with the per-card "over SLA" badges.
  const awaitingOperator = workItems.filter((item) => item.status === "needs_approval" || item.status === "blocked");
  const oldestLeaseAge = maxAgeMs(
    activeLeases.map((lease) => lease.issuedAt),
    now
  );
  const oldestApprovalWait = maxAgeMs(pendingApprovals.map(approvalWaitStart), now);
  // A non-positive SLA disables the flag, matching waitBadge().
  const overSla = slaMs > 0 ? awaitingOperator.filter((item) => (approvalWaitMs(item, now) ?? 0) >= slaMs).length : 0;
  const slaWindow = formatWait(slaMs);
  return `<div class="operator-metrics"><dl>
    <div><dt>Active leases</dt><dd>${activeLeases.length}</dd></div>
    <div><dt>Oldest lease age</dt><dd>${formatDuration(oldestLeaseAge)}</dd></div>
    <div><dt>Pending approvals</dt><dd>${pendingApprovals.length}</dd></div>
    <div><dt>Oldest approval wait</dt><dd>${formatDuration(oldestApprovalWait)}</dd></div>
    <div${overSla > 0 ? ` class="overdue" title="Waiting longer than the ${escapeHtml(slaWindow)} approval SLA"` : ""}><dt>Approvals over SLA</dt><dd>${overSla} of ${awaitingOperator.length}</dd></div>
  </dl>
  </div>`;
}

function maxAgeMs(timestamps: string[], now: Date): number | undefined {
  let oldest: number | undefined;
  for (const value of timestamps) {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) continue;
    const age = Math.max(0, now.getTime() - parsed);
    if (oldest === undefined || age > oldest) oldest = age;
  }
  return oldest;
}

function formatDuration(ageMs: number | undefined): string {
  if (ageMs === undefined) return "—";
  const totalSeconds = Math.floor(ageMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function systemStats(
  stats: ReturnType<typeof summarize>,
  infrastructure?: MissionControlInfrastructureSummary,
  executionBackend?: string
): string {
  const backend = executionBackend ? escapeHtml(executionBackend) : "unset";
  if (!infrastructure) {
    return `<dl><div><dt>Agent heartbeats online</dt><dd>${stats.onlineAgents} / ${stats.totalAgents}</dd></div><div><dt>Execution backend</dt><dd>${backend}</dd></div></dl>`;
  }
  const agents = infrastructure.agents;
  const executors = infrastructure.executors;
  const connectors = infrastructure.connectors;
  const admission = infrastructure.admission;
  return `<dl>
    <div><dt>Agent heartbeats online</dt><dd>${toCount(agents.online)} / ${toCount(agents.registered)}</dd></div>
    <div><dt>Executors configured</dt><dd>${toCount(executors.configured)} / ${toCount(executors.total)}</dd></div>
    <div><dt>Attested executor runtimes</dt><dd>${toCount(executors.attestedRuntimes)}</dd></div>
    <div><dt>Connectors enabled</dt><dd>${toCount(connectors.enabled)} / ${toCount(connectors.registered)}</dd></div>
    <div><dt>Active tunnel sessions</dt><dd>${toCount(connectors.activeSessions)}</dd></div>
    <div><dt>Execution admission</dt><dd>${toCount(admission.active)} / ${toCount(admission.capacity)} active</dd></div>
    <div><dt>Admission queue</dt><dd>${toCount(admission.queued)}${admission.saturated ? " · saturated" : ""}</dd></div>
    <div><dt>Execution backend</dt><dd>${backend}</dd></div>
  </dl>`;
}

export function connectorsPanel(): string {
  return `<div class="agent-layout connector-layout">
    <div class="table-wrap"><p class="empty">Loading registered connectors...</p></div>
    <section id="connector-detail" class="detail-panel connector-detail" tabindex="-1" aria-live="polite" aria-label="Connector detail">
      <div class="detail-empty"><h3>No connector selected</h3><p>Select a connector to inspect tunnel sessions and granted scopes.</p></div>
    </section>
  </div>`;
}

export function eventTimeline(events: StoredAuditEvent[]): string {
  if (!events.length) return `<p class="empty">No audit events recorded.</p>`;
  return `<ol class="timeline">${events
    .map(
      (event) =>
        `<li${event.sequence === undefined ? "" : ` data-sequence="${escapeHtml(String(event.sequence))}"`}><time>${time(nanoToIso(event.timeUnixNano))}</time><strong>${escapeHtml(event.name)}</strong>${auditAttributesHtml(event.attributes)}</li>`
    )
    .join("")}</ol>`;
}
