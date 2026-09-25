import {
  type ExecutionAttempt,
  type ExecutionPlanAdmission,
  type ExecutionPlanRecord,
  type StoredAuditEvent,
  type WorkItem
} from "@agent-control-stack/work-items";
import { approvalActionHashPrefix } from "../approval-actions.js";
import { nanoToIso, pill, time } from "../format.js";
import { escapeHtml } from "../html.js";
import { approvalWaitMs, approvalWaitStart, formatWait } from "../operator-workflow.js";
import { WORK_ITEM_STATUS_VALUES, workItemAgentId } from "../queue-filter.js";
import { redactSecrets } from "../redaction.js";
import {
  type ApprovalActionOption,
  type MissionControlAgent,
  type MissionControlAttemptLease,
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
  return {
    totalAgents: agents.length,
    onlineAgents: agents.filter((agent) => agent.status === "online").length,
    running: count("running"),
    approvals: count("needs_approval"),
    failed: count("failed") + count("blocked")
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

export function overviewCards(stats: ReturnType<typeof summarize>): string {
  const cards = [
    ["Total Agents", stats.totalAgents, "Observed from persisted connector, tunnel, worker, and target events"],
    ["Online Agents", stats.onlineAgents, "Only recent heartbeats count as online"],
    ["Running Tasks", stats.running, "Lease-bound work currently running"],
    ["Pending Approvals", stats.approvals, "Policy-gated work waiting on a human"],
    ["Failed / Blocked", stats.failed, "Items that need operator attention"]
  ];
  return cards
    .map(
      ([label, value, help]) =>
        `<article class="card"><span>${label}</span><strong>${value}</strong><p>${help}</p></article>`
    )
    .join("");
}

export function agentTable(agents: MissionControlAgent[]): string {
  if (!agents.length) return `<div class="table-wrap"><p class="empty">No agents or connectors observed.</p></div>`;
  return `<div class="table-wrap"><table class="agent-table"><thead><tr><th>Agent</th><th>Type</th><th>Status</th><th>Health</th><th>Current task</th><th>Heartbeat</th><th>Last error</th></tr></thead><tbody id="agent-roster-body">${agents
    .map(
      (agent) =>
        `<tr class="agent-row" tabindex="0" data-agent="${escapeHtml(agent.id)}" data-agent-id="${escapeHtml(agent.id)}"><td><strong>${escapeHtml(agent.displayName)}</strong><small>${escapeHtml(agent.id)}</small></td><td>${escapeHtml(agent.kind)}</td><td>${pill(agent.status)}</td><td>${pill(agent.health)}</td><td>${agent.currentTask ? escapeHtml(agent.currentTask) : "—"}</td><td>${agent.lastHeartbeatAt ? time(agent.lastHeartbeatAt) : "—"}</td><td>${agent.lastError ? escapeHtml(redactSecrets(agent.lastError)) : "—"}</td></tr>`
    )
    .join("")}</tbody></table></div>`;
}

export function agentDetailPanel(): string {
  return `<section id="agent-detail" class="detail-panel agent-detail" tabindex="-1" aria-live="polite" aria-label="Agent detail">
    <div class="detail-empty"><h3>No agent selected</h3><p>Select a row to load the registry record.</p></div>
  </section>`;
}

export function queueFilterStrip(): string {
  const chips = WORK_ITEM_STATUS_VALUES.map((status) => {
    const id = `queue-status-${status}`;
    return `<label class="queue-filter-chip" for="${id}"><input type="checkbox" id="${id}" name="queue-status" value="${escapeHtml(status)}" data-queue-status="${escapeHtml(status)}" /> <span>${escapeHtml(status)}</span></label>`;
  }).join("");
  return `<div class="queue-filter" id="queue-filter" role="search" aria-label="Filter work queue">
  <div class="queue-filter-row">
    <fieldset class="queue-filter-statuses">
      <legend>Status</legend>
      <div class="queue-filter-chips">${chips}</div>
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
      return `<button class="queue-item${attention ? " attention" : ""}" data-work-item="${escapeHtml(item.id)}" data-status="${escapeHtml(item.status)}" data-title="${escapeHtml(item.title)}" data-agent-id="${escapeHtml(agentId)}"><span>${pill(item.status)} ${pill(item.risk)}${attention ? attentionBadge() : ""}</span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(redactSecrets(item.intent))}</small>${executionPlanBadge(plan, admission)}${executionSummary(attempts, leases)}${workItemError(item)}</button>`;
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
        return `<article ${cardAttrs}><span>${pill(item.status)} ${pill(item.risk)} ${wait.html}</span><strong id="approval-title-${escapeHtml(item.id)}">${escapeHtml(item.title)}</strong><small>Actions: ${escapeHtml(actions)}</small>${error ? `<small class="error-line">${escapeHtml(error)}</small>` : ""}${reason}<div class="approval-actions" role="group" aria-label="Actions for ${escapeHtml(item.title)}"><button type="button" data-unblock="${escapeHtml(item.id)}" data-risk="${escapeHtml(item.risk)}" aria-describedby="${reasonId}">Unblock</button><button type="button" data-reject="${escapeHtml(item.id)}" data-risk="${escapeHtml(item.risk)}" aria-describedby="${reasonId}">Reject</button></div>${outcome}</article>`;
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
  now: Date
): string {
  const activeLeases = Object.values(attemptLeasesByWorkItem)
    .flat()
    .filter((lease) => lease.status === "active");
  const pendingApprovals = workItems.filter((item) => item.status === "needs_approval");
  const oldestLeaseAge = maxAgeMs(
    activeLeases.map((lease) => lease.issuedAt),
    now
  );
  const oldestApprovalWait = maxAgeMs(pendingApprovals.map(approvalWaitStart), now);
  return `<div class="operator-metrics"><dl>
    <div><dt>Active leases</dt><dd>${activeLeases.length}</dd></div>
    <div><dt>Oldest lease age</dt><dd>${formatDuration(oldestLeaseAge)}</dd></div>
    <div><dt>Pending approvals</dt><dd>${pendingApprovals.length}</dd></div>
    <div><dt>Oldest approval wait</dt><dd>${formatDuration(oldestApprovalWait)}</dd></div>
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

export function systemStats(stats: ReturnType<typeof summarize>, executionBackend?: string): string {
  const backend = executionBackend ? escapeHtml(executionBackend) : "unset";
  return `<dl><div><dt>Agents online</dt><dd>${stats.onlineAgents} / ${stats.totalAgents}</dd></div><div><dt>Running tasks</dt><dd>${stats.running}</dd></div><div><dt>Pending approvals</dt><dd>${stats.approvals}</dd></div><div><dt>Failed or blocked</dt><dd>${stats.failed}</dd></div><div><dt>Execution backend</dt><dd>${backend}</dd></div></dl>`;
}

export function connectorsPanel(agents: MissionControlAgent[], executionBackend?: string): string {
  const connectors = agents.filter((agent) => /connector|tunnel/i.test(agent.kind));
  const backend = executionBackend ? escapeHtml(executionBackend) : "unset";
  const rows = connectors.length
    ? `<div class="table-wrap"><table><thead><tr><th>Connector</th><th>Status</th><th>Last event</th></tr></thead><tbody>${connectors
        .map(
          (agent) =>
            `<tr><td><strong>${escapeHtml(agent.displayName)}</strong><small>${escapeHtml(agent.id)}</small></td><td>${pill(agent.status)}</td><td>${agent.lastEventAt ? time(agent.lastEventAt) : "—"}</td></tr>`
        )
        .join("")}</tbody></table></div>`
    : `<p class="empty">No connectors observed.</p>`;
  return `${rows}<p class="empty">Execution backend: ${backend}</p>`;
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
