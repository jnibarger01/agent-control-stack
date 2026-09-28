import {
  DEFAULT_HEARTBEAT_ONLINE_WINDOW_MS,
  DEFAULT_HEARTBEAT_TTL_MS,
  type AttemptLease,
  type ExecutionAttempt,
  type ExecutionPlanAdmission,
  type ExecutionPlanRecord,
  type RegistryAgentDetail,
  type StoredAuditEvent,
  type WorkItem
} from "@agent-control-stack/work-items";
import { redactSecrets, redactedAttributesJson } from "./redaction.js";

import { clientScript } from "./client.js";
import { styles } from "./styles.js";
import { approvalActionHashPrefix } from "./client-shared.js";

export { approvalActionHashPrefix, isElevatedApprovalRisk, nextSseReconnectDelayMs } from "./client-shared.js";

export {
  isSecretAttributeKey,
  redactAttributes,
  redactedAttributesJson,
  redactSecrets,
  SECRET_KEY_PATTERN,
  SECRET_VALUE_PATTERNS
} from "./redaction.js";

export interface MissionControlAgent {
  id: string;
  displayName: string;
  kind: string;
  status: "online" | "observed" | "stale" | "offline";
  health: "healthy" | "warning" | "unhealthy" | "unknown";
  currentTask?: string;
  currentWorkItemId?: string;
  lastHeartbeatAt?: string;
  lastEventAt?: string;
  lastError?: string;
  capabilities: string[];
  metadata: Record<string, string>;
}

export type MissionControlAttemptLease = Omit<AttemptLease, "tokenHash">;

export function toMissionControlAttemptLease(lease: AttemptLease): MissionControlAttemptLease {
  return {
    leaseId: lease.leaseId,
    attemptId: lease.attemptId,
    workItemId: lease.workItemId,
    admissionId: lease.admissionId,
    ...(lease.approvalId ? { approvalId: lease.approvalId } : {}),
    workerId: lease.workerId,
    planHash: lease.planHash,
    inputHash: lease.inputHash,
    fencingEpoch: lease.fencingEpoch,
    protocolVersion: lease.protocolVersion,
    policyVersion: lease.policyVersion,
    policyDecisionHash: lease.policyDecisionHash,
    issuedAt: lease.issuedAt,
    expiresAt: lease.expiresAt,
    maxExpiresAt: lease.maxExpiresAt,
    lastRenewedAt: lease.lastRenewedAt,
    status: lease.status,
    ...(lease.closedAt ? { closedAt: lease.closedAt } : {})
  };
}

export interface MissionControlViewModel {
  workItems: WorkItem[];
  events: StoredAuditEvent[];
  registeredAgents?: RegistryAgentDetail[];
  agents?: MissionControlAgent[];
  /** Legacy hash-only approval options. Prefer `approvalActionsByWorkItem`, which labels each hash. */
  approvalActionHashesByWorkItem?: Record<string, string[]>;
  /** Approval options per work item: each policy-gated action hash with the action it approves. */
  approvalActionsByWorkItem?: Record<string, ApprovalActionOption[]>;
  /** Current execution plan per work item, when one has been drafted (packages/work-items getCurrentExecutionPlan). */
  executionPlansByWorkItem?: Record<string, ExecutionPlanRecord>;
  /** Current plan's admission outcome per work item, when it has been admitted (getExecutionPlanAdmission). */
  executionPlanAdmissionsByWorkItem?: Record<string, ExecutionPlanAdmission>;
  /** Persisted execution attempts for each work item. */
  executionAttemptsByWorkItem?: Record<string, ExecutionAttempt[]>;
  /** Dashboard-safe lease projections. Raw token hashes are never accepted by this view model. */
  attemptLeasesByWorkItem?: Record<string, MissionControlAttemptLease[]>;
  /** Explicit worker backend label, when the gateway knows it. Never a secret. */
  executionBackend?: string;
  /** Authenticated dashboard actor display value, when supplied by the gateway. */
  operatorDisplayName?: string;
  /** Canonical execution mode. Absent when the row is missing or corrupt. */
  executionMode?: "strict" | "admin";
  executionModeProblem?: "missing" | "corrupt";
  now?: Date;
}

/** One approvable action: the policy fingerprint plus the requested action it fingerprints. */
export interface ApprovalActionOption {
  actionHash: string;
  kind: string;
  description?: string;
}

/** Canonical work-item statuses used by the queue filter chips. Unknown values are ignored (no-op). */
export const WORK_ITEM_STATUS_VALUES = [
  "draft",
  "pending_policy",
  "needs_approval",
  "approved",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
  "rejected",
  "unknown",
  "quarantined"
] as const;

const KNOWN_WORK_ITEM_STATUSES: ReadonlySet<string> = new Set(WORK_ITEM_STATUS_VALUES);

export type QueueFilter = {
  /** Status chips selected by the operator. Unknown entries are ignored when matching. */
  statuses: string[];
  /** Optional agent / worker / target id (case-insensitive substring). */
  agentId: string;
  /** Free-text match against work-item title and id (case-insensitive substring). */
  text: string;
};

export function emptyQueueFilter(): QueueFilter {
  return { statuses: [], agentId: "", text: "" };
}

export function isQueueFilterEmpty(filter: QueueFilter): boolean {
  return filter.statuses.length === 0 && filter.agentId.trim() === "" && filter.text.trim() === "";
}

/** Derive the agent/target id shown for queue filtering (target first, else latest worker). */
export function workItemAgentId(
  item: Pick<WorkItem, "target">,
  attempts: ExecutionAttempt[] = [],
  leases: MissionControlAttemptLease[] = []
): string {
  const fromTarget = item.target.services?.[0] ?? item.target.repo ?? item.target.cwd;
  if (fromTarget) return fromTarget;
  const attempt = attempts.at(-1);
  const lease = [...leases].reverse().find((candidate) => attempt && candidate.attemptId === attempt.attemptId);
  return lease?.workerId ?? attempt?.claimedByWorkerId ?? "";
}

function collectStatusParams(params: URLSearchParams): string[] {
  const raw = [...params.getAll("status")];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    for (const part of entry.split(",")) {
      const status = part.trim();
      if (!status || seen.has(status)) continue;
      seen.add(status);
      out.push(status);
    }
  }
  return out;
}

function paramsFromLocationLike(
  source: string | URLSearchParams | { search?: string; hash?: string }
): URLSearchParams {
  if (typeof source === "string") {
    const trimmed = source.trim();
    if (!trimmed) return new URLSearchParams();
    if (trimmed.startsWith("?")) return new URLSearchParams(trimmed.slice(1));
    if (trimmed.startsWith("#")) {
      const hash = trimmed.slice(1);
      const query = hash.includes("?")
        ? hash.slice(hash.indexOf("?") + 1)
        : hash.includes("=")
          ? hash.replace(/^[A-Za-z0-9_-]+&/, "")
          : "";
      return new URLSearchParams(query);
    }
    return new URLSearchParams(trimmed.includes("=") ? trimmed : "");
  }
  if (source instanceof URLSearchParams) {
    return new URLSearchParams(source.toString());
  }
  const search = (source.search ?? "").replace(/^\?/, "");
  if (search) return new URLSearchParams(search);
  const hash = (source.hash ?? "").replace(/^#/, "");
  if (!hash) return new URLSearchParams();
  if (hash.includes("?")) return new URLSearchParams(hash.slice(hash.indexOf("?") + 1));
  if (hash.includes("=")) return new URLSearchParams(hash.replace(/^[A-Za-z0-9_-]+&/, ""));
  return new URLSearchParams();
}

/** Read queue filter from URL search params or hash (e.g. `?status=running&q=foo` or `#queue?status=running`). */
export function parseQueueFilter(
  source: string | URLSearchParams | { search?: string; hash?: string } = ""
): QueueFilter {
  const params = paramsFromLocationLike(source);
  return {
    statuses: collectStatusParams(params),
    agentId: (params.get("agent") ?? "").trim(),
    text: (params.get("q") ?? params.get("text") ?? "").trim()
  };
}

export function serializeQueueFilter(filter: QueueFilter): URLSearchParams {
  const params = new URLSearchParams();
  for (const status of filter.statuses.map((value) => value.trim()).filter(Boolean)) {
    params.append("status", status);
  }
  if (filter.agentId.trim()) params.set("agent", filter.agentId.trim());
  if (filter.text.trim()) params.set("q", filter.text.trim());
  return params;
}

export type QueueFilterableItem = {
  id: string;
  title: string;
  status: string;
  agentId?: string;
};

/** Client-side filter over the in-memory / already-rendered queue model. */
export function filterWorkItems<T extends QueueFilterableItem>(items: T[], filter: QueueFilter): T[] {
  const knownStatuses = filter.statuses.filter((status) => KNOWN_WORK_ITEM_STATUSES.has(status));
  // Unknown status chips are a no-op: they do not narrow (and do not error).
  const text = filter.text.trim().toLowerCase();
  const agent = filter.agentId.trim().toLowerCase();
  if (!knownStatuses.length && !text && !agent) return items;

  return items.filter((item) => {
    if (knownStatuses.length > 0 && !knownStatuses.includes(item.status)) return false;
    if (text) {
      const haystack = `${item.title} ${item.id}`.toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    if (agent) {
      const itemAgent = (item.agentId ?? "").toLowerCase();
      if (!itemAgent.includes(agent)) return false;
    }
    return true;
  });
}

export type QueueFilterDomRoot = {
  querySelector(selectors: string): QueueFilterDomElement | null;
  querySelectorAll(selectors: string): ArrayLike<QueueFilterDomElement>;
};

export type QueueFilterDomElement = {
  hidden?: boolean;
  textContent?: string | null;
  getAttribute(name: string): string | null;
  classList?: { toggle(token: string, force?: boolean): unknown };
};

/** Hide non-matching queue buttons and announce the visible count via aria-live. */
export function applyQueueFilterToDom(root: QueueFilterDomRoot, filter: QueueFilter): number {
  const nodeList = root.querySelectorAll("[data-work-item]");
  const queueButtons = Array.from({ length: nodeList.length }, (_, index) => nodeList[index]!);
  let visible = 0;
  for (const el of queueButtons) {
    const id = el.getAttribute("data-work-item") ?? "";
    const title = el.getAttribute("data-title") ?? "";
    const status = el.getAttribute("data-status") ?? "";
    const agentId = el.getAttribute("data-agent-id") ?? "";
    const show = filterWorkItems([{ id, title, status, agentId }], filter).length > 0;
    if ("hidden" in el) el.hidden = !show;
    el.classList?.toggle("queue-item-filtered-out", !show);
    if (show) visible += 1;
  }
  const total = queueButtons.length;
  // Treat "only unknown statuses" as empty for the count label.
  const effectivelyEmpty =
    isQueueFilterEmpty(filter) ||
    (filter.statuses.every((status) => !KNOWN_WORK_ITEM_STATUSES.has(status)) &&
      filter.agentId.trim() === "" &&
      filter.text.trim() === "");
  const count = root.querySelector("#queue-filter-count");
  if (count) {
    count.textContent = effectivelyEmpty ? `${total} items` : `${visible} of ${total} items`;
  }
  const live = root.querySelector("#queue-filter-live");
  if (live) {
    live.textContent = effectivelyEmpty
      ? `Showing all ${total} work items`
      : `Showing ${visible} of ${total} work items`;
  }
  return visible;
}

const OPERATOR_ATTENTION_STATUSES: ReadonlySet<WorkItem["status"]> = new Set([
  "blocked",
  "needs_approval",
  "quarantined"
]);

function needsOperatorAttention(status: WorkItem["status"]): boolean {
  return OPERATOR_ATTENTION_STATUSES.has(status);
}

export interface WorkItemDetailView {
  id: string;
  title: string;
  status: string;
  risk: string;
  requester?: string;
  intent?: string;
  target?: unknown;
  createdAt?: string;
  requestedActions?: Array<{ kind: string; description?: string }>;
}

/** Markup for the work-item detail panel (axe smoke + client parity). */
export function renderWorkItemDetailHtml(
  workItem: WorkItemDetailView,
  events: Array<{ name?: string; timeUnixNano?: string; attributes?: Record<string, string> }> = []
): string {
  const actions = Array.isArray(workItem.requestedActions) ? workItem.requestedActions : [];
  const actionList = actions.length
    ? `<ul class="action-list">${actions
        .map(
          (action) =>
            `<li><strong>${escapeHtml(action.kind)}</strong><small>${escapeHtml(redactSecrets(action.description ?? ""))}</small></li>`
        )
        .join("")}</ul>`
    : `<p class="muted">No requested actions.</p>`;
  const eventItems = events.length
    ? `<ol class="detail-events">${events
        .slice(0, 8)
        .map((event) => {
          const attrs = event.attributes ?? {};
          const ref = attrs["work_item.id"] || attrs["agent.id"] || attrs["connector.id"] || "";
          const when = event.timeUnixNano ? time(nanoToIso(event.timeUnixNano)) : "—";
          return `<li><time>${when}</time><strong>${escapeHtml(event.name || "event")}</strong><small>${escapeHtml(redactSecrets(ref))}</small></li>`;
        })
        .join("")}</ol>`
    : `<p class="muted">No matching events.</p>`;
  return `<div class="detail-head"><div><h3 id="work-detail-title">${escapeHtml(workItem.title)}</h3><small>${escapeHtml(workItem.id)}</small></div><div>${pill(workItem.status)} ${pill(workItem.risk, "Risk")}</div></div><dl class="detail-grid"><div><dt>Requester</dt><dd>${escapeHtml(workItem.requester || "—")}</dd></div><div><dt>Intent</dt><dd>${escapeHtml(redactSecrets(workItem.intent || "—"))}</dd></div><div><dt>Target</dt><dd>${escapeHtml(workItem.target ? redactedAttributesJson(workItem.target) : "—")}</dd></div><div><dt>Created</dt><dd>${workItem.createdAt ? time(workItem.createdAt) : "—"}</dd></div></dl><div class="detail-section"><h4>Requested Actions</h4>${actionList}</div><div class="detail-section"><h4>Timeline</h4>${eventItems}</div>`;
}

export function renderDashboard(input: WorkItem[] | MissionControlViewModel): string {
  const model = Array.isArray(input) ? { workItems: input, events: [] } : input;
  const events = model.events ?? [];
  const agents =
    model.agents ?? projectAgents(model.workItems, events, model.now ?? new Date(), model.registeredAgents ?? []);
  const stats = summarize(model.workItems, agents);
  const approvalItems = model.workItems.filter((item) => item.status === "needs_approval" || item.status === "blocked");
  const executionPlansByWorkItem = model.executionPlansByWorkItem ?? {};
  const executionPlanAdmissionsByWorkItem = model.executionPlanAdmissionsByWorkItem ?? {};
  const executionAttemptsByWorkItem = model.executionAttemptsByWorkItem ?? {};
  const attemptLeasesByWorkItem = model.attemptLeasesByWorkItem ?? {};
  const dashboardNow = model.now ?? new Date();
  const operatorDisplayName = model.operatorDisplayName?.trim() || "Operator";
  const operatorParts = operatorDisplayName.split(/[^A-Za-z0-9]+/u).filter(Boolean);
  const operatorInitials = (
    operatorParts.length > 1
      ? `${operatorParts[0]?.[0] ?? ""}${operatorParts[1]?.[0] ?? ""}`
      : (operatorParts[0]?.slice(0, 2) ?? "OP")
  ).toUpperCase();

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ACS Mission Control</title>
    <style>${styles()}</style>
  </head>
  <body data-active-view="overview" data-snapshot="mission-control" data-confirmed-mode="${model.executionMode ?? ""}">
    <a class="skip-link" href="#main-content">Skip to main content</a>
    <div class="mission-topbar">
      <div class="topbar-brand">
        <span class="acs-mark" aria-hidden="true"><i></i><b></b></span>
        <div><strong>ACS</strong><span>Mission Control<small>Secure Agents. Real Progress.</small></span></div>
      </div>
      <div class="mode-status-chip ${model.executionMode === "admin" ? "admin" : model.executionMode === "strict" ? "strict" : "unavailable"}">
        <span class="mode-shield" aria-hidden="true">◆</span>
        <div><strong id="mode-badge-label">${model.executionMode === "admin" ? "Admin Mode" : model.executionMode === "strict" ? "Strict Mode" : "Mode Unavailable"}</strong><small>${model.executionMode === "admin" ? "Eligible approvals automated" : model.executionMode === "strict" ? "Manual approval required" : "Fail closed"}</small></div>
      </div>
      <div class="topbar-statuses">
        <div class="status-cluster"><span class="top-status-dot stream-status-dot pending"></span><div><strong>Stream</strong><small class="live" role="status"><span aria-hidden="true"></span> Connecting</small></div></div>
        <div class="status-cluster"><span class="top-status-dot data-status-dot pending"></span><div><strong>Data</strong><small id="data-current-status">Awaiting refresh</small></div></div>
      </div>
      <label class="global-search" for="global-search"><span aria-hidden="true">⌕</span><input id="global-search" type="search" autocomplete="off" spellcheck="false" placeholder="Search work items…" /><kbd>⌘ K</kbd></label>
      <div class="operator-chip"><span class="operator-avatar">${escapeHtml(operatorInitials)}</span><div><strong>${escapeHtml(operatorDisplayName)}</strong><small>Operator</small></div></div>
    </div>

    <aside aria-label="Mission control navigation">
      <nav aria-label="Primary">
        <a href="#overview" class="active" data-nav="overview"><span aria-hidden="true">⌂</span>Overview</a>
        <a href="#queue" data-nav="queue"><span aria-hidden="true">▣</span>Work Queue</a>
        <a href="#execution" data-nav="execution"><span aria-hidden="true">▷</span>Execution</a>
        <a href="#visualizer" data-nav="visualizer"><span aria-hidden="true">◇</span>Visualizer<b class="nav-health-dot" id="visualizer-nav-health" aria-label="Visualizer status unknown"></b></a>
        <a href="#agents" data-nav="agents"><span aria-hidden="true">◉</span>Agents</a>
        <a href="#approvals" data-nav="approvals"><span aria-hidden="true">✓</span>Approvals${stats.approvals ? `<b class="nav-count">${stats.approvals}</b>` : ""}</a>
        <a href="#system" data-nav="system"><span aria-hidden="true">⚙</span>System</a>
        <a href="#events" data-nav="audit"><span aria-hidden="true">≣</span>Audit</a>
        <div class="nav-divider"></div>
        <a href="#connectors" data-nav="connectors"><span aria-hidden="true">↔</span>Connectors</a>
        <a href="#operator-metrics" data-nav="metrics"><span aria-hidden="true">∿</span>Metrics</a>
        <a href="#policy" data-nav="policy"><span aria-hidden="true">⌁</span>Policy</a>
      </nav>
      <a href="#dispatch" data-nav="dispatch" class="new-work-link"><span aria-hidden="true">＋</span>New Work Item</a>
      <div class="sidebar-footer"><div><span class="top-status-dot acs-status-dot pending"></span><strong id="acs-online-status">ACS Connecting</strong></div><small>Mission Control · local-first</small><a href="#system" data-nav="system">System status</a></div>
    </aside>

    <main id="main-content" tabindex="-1">
      <header class="page-header">
        <div><h1 id="view-heading" tabindex="-1">Overview</h1><p id="view-description">What needs your attention?</p></div>
        <div class="page-meta"><span>${time(dashboardNow.toISOString())}</span><button type="button" data-refresh>Refresh</button></div>
      </header>
      <div id="admin-mode-banner" class="admin-mode-banner" role="status"${model.executionMode === "admin" ? "" : " hidden"}>Admin active — ACS records eligible approvals automatically. Policy, managed authority, and capability checks remain enforced.</div>
      <div id="execution-mode-problem" class="admin-mode-banner" role="alert"${model.executionModeProblem ? "" : " hidden"}>${model.executionModeProblem ? `Execution mode ${model.executionModeProblem} — fail closed` : ""}</div>
      <div id="sse-stale-banner" class="stale-banner" role="status">Connecting. Displayed work items may be stale. Sensitive actions wait for authoritative reconciliation.</div>
      <p id="state-result" role="status"></p>

      <section id="overview" class="overview-shell" data-view-panel="overview">
        <div class="cards overview-cards">${overviewCards(stats)}</div>
        <div class="overview-grid overview-grid-top">
          <article class="panel overview-approvals">${overviewApprovals(approvalItems)}</article>
          <article class="panel overview-health">${overviewHealth(stats, model.executionMode, model.executionBackend)}</article>
          <article class="panel overview-agents">${overviewAgentSummary(agents)}</article>
        </div>
        <div class="overview-grid overview-grid-bottom">
          <article class="panel overview-queue">${overviewQueue(model.workItems, executionAttemptsByWorkItem, attemptLeasesByWorkItem, dashboardNow)}</article>
          <article class="panel overview-activity">${overviewAgentActivity(agents)}</article>
          <article class="panel overview-recent-events">${overviewEvents(events)}</article>
        </div>
        <article class="panel overview-mode-panel">
          <div class="mode-panel-icon" aria-hidden="true">⬡</div>
          <fieldset class="execution-mode" id="execution-mode-control" aria-describedby="execution-mode-help">
            <legend>Execution Mode</legend>
            <label><input type="radio" name="executionMode" value="strict" data-execution-mode="strict"${model.executionMode === "strict" ? " checked" : ""}> <span><strong>Strict</strong><small>Manual approval required</small></span></label>
            <label><input type="radio" name="executionMode" value="admin" data-execution-mode="admin"${model.executionMode === "admin" ? " checked" : ""}> <span><strong>Admin — automatic approval</strong><small>Automatically approve eligible actions</small></span></label>
            <button type="button" id="execution-mode-apply" disabled>Apply mode</button>
            <p id="execution-mode-result" role="status"></p>
          </fieldset>
          <div class="mode-current"><small>Current mode (server confirmed)</small><strong id="execution-mode-active">${model.executionMode ?? "Unavailable — fail closed"}</strong><p>All approvals remain audited.</p></div>
          <p id="execution-mode-help" class="mode-safety-note">Policy denials and managed-authority requirements remain enforced in every mode.</p>
        </article>
      </section>

      <section class="grid" data-view-section="agents queue execution">
        <article id="agents" class="panel wide roster-panel" data-view-panel="agents"><div class="panel-head"><div><h2>Agent Roster</h2><p>Backend registry + audit projection</p></div><span id="agent-count">${agents.length} observed</span></div>${freshness("agents")}<div class="agent-layout">${agentTable(agents)}${agentDetailPanel()}</div></article>
        <article id="queue" class="panel queue-panel" data-view-panel="queue execution"><div class="panel-head"><h2 id="queue-heading">Work Queue</h2><span id="queue-filter-count">${escapeHtml(String(model.workItems.length))} items</span></div>${freshness("work")}<p id="execution-help" hidden>Execution view emphasizes admitted plans, attempts, and lease authority. Select a work item for full execution details.</p>${queueFilterStrip()}${workQueue(model.workItems, executionPlansByWorkItem, executionPlanAdmissionsByWorkItem, executionAttemptsByWorkItem, attemptLeasesByWorkItem)}</article>
      </section>

      <section class="grid visualizer-grid" data-view-section="visualizer">
        <article id="visualizer" class="panel visualizer-panel" data-view-panel="visualizer">${visualizerPanel()}</article>
      </section>

      <section class="grid approvals-grid" data-view-section="approvals">
        <article id="approvals" class="panel wide" data-view-panel="approvals"><div class="panel-head"><h2>Approvals</h2><span>${approvalItems.length} waiting</span></div>${freshness("approvals")}<a class="view-all" href="#approvals" data-nav="approvals">View all ${approvalItems.length} items</a>${approvalsPanel(approvalItems, approvalOptionsByWorkItem(model))}</article>
      </section>
      <section class="grid lower" data-view-section="metrics audit system">
        <article id="operator-metrics" class="panel" data-view-panel="metrics"><div class="panel-head"><h2>Operator metrics</h2><span>leases · approvals · 429s</span></div>${operatorMetricsPanel(model.workItems, attemptLeasesByWorkItem, dashboardNow)}</article>
        <article id="events" class="panel" data-view-panel="audit"><div class="panel-head"><h2>Recent Events</h2><span>append-only</span></div><div class="audit-controls"><label><input type="checkbox" id="audit-follow" checked> Follow live</label><button id="audit-new" type="button" hidden>0 new events</button><span>Recent window: up to 100 events; not complete audit history.</span></div>${eventTimeline([...events].reverse().slice(0, 100))}</article>
        <article id="system" class="panel" data-view-panel="system"><div class="panel-head"><h2>System Health</h2><span>live</span></div>${freshness("system")}<button type="button" id="system-refresh">Refresh readiness</button>${systemPanel(stats, model.executionBackend)}<details class="safety-help"><summary>Authority and safety</summary><p>Approve and reject require a reason and authenticated backend checks. Approvals bind to the exact action hash. Unknown or stale state cannot authorize an action. Cancel, retry, and clone are not exposed here. Bulk approval is not exposed. Displayed values are redacted.</p></details></article>
      </section>
      <section class="grid lower" data-view-section="dispatch connectors policy">
        <article id="dispatch" class="panel composer" data-view-panel="dispatch"><div class="panel-head"><h2>New Task Composer</h2><span>authenticated session</span></div>${composer()}</article>
        <article id="connectors" class="panel" data-view-panel="connectors"><div class="panel-head"><h2>Connectors</h2><span>${agents.filter((agent) => /connector|tunnel/i.test(agent.kind)).length} observed</span></div>${connectorsPanel(agents, model.executionBackend)}</article>
        <article id="policy" class="panel" data-view-panel="policy"><div class="panel-head"><h2>Policy</h2><span>audit</span></div>${policyPanel(events)}</article>
      </section>
    </main>
    <script>${clientScript()}</script>
  </body>
</html>`;
}

export function projectAgents(
  workItems: WorkItem[],
  events: StoredAuditEvent[],
  now = new Date(),
  registeredAgents: RegistryAgentDetail[] = []
): MissionControlAgent[] {
  const agents = new Map<string, MissionControlAgent>();
  const touch = (id: string, patch: Partial<MissionControlAgent>) => {
    const current = agents.get(id) ?? {
      id,
      displayName: id,
      kind: "observed",
      status: "observed" as const,
      health: "unknown" as const,
      capabilities: [],
      metadata: {}
    };
    const capabilities = patch.capabilities
      ? [...new Set([...current.capabilities, ...patch.capabilities])]
      : current.capabilities;
    agents.set(id, {
      ...current,
      ...patch,
      capabilities,
      metadata: { ...current.metadata, ...(patch.metadata ?? {}) }
    });
  };

  for (const agent of registeredAgents) {
    const projected = registryStatus(agent.status);
    touch(agent.id, {
      displayName: agent.name,
      kind: agent.kind,
      status: projected.status,
      health: projected.health,
      capabilities: agent.capabilities.map((capability) => capability.name),
      lastHeartbeatAt: agent.lastHeartbeatAt,
      lastEventAt: agent.lastHeartbeatAt ?? agent.updatedAt,
      lastError: agent.lastError,
      metadata: { registryStatus: agent.status, registered: "true" }
    });
  }

  for (const item of workItems) {
    const target = item.target.services?.[0] ?? item.target.repo ?? item.target.cwd;
    if (target) touch(target, { kind: "target", currentTask: item.title, currentWorkItemId: item.id });
    if (item.requester === "agent") touch("agent", { kind: "requester" });
  }

  for (const event of events) {
    const body = asRecord(event.body);
    const attrs = event.attributes ?? {};
    const ids = [
      attrs["worker.id"],
      attrs["connector.id"],
      attrs["auth.connector_id"],
      body.connectorId,
      body.workerId
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    for (const id of ids) {
      touch(id, eventPatch(id, event, body));
    }
  }

  return [...agents.values()]
    .map((agent) => finalizeAgent(agent, now))
    .sort(
      (left, right) =>
        statusRank(left.status) - statusRank(right.status) || left.displayName.localeCompare(right.displayName)
    );
}
function eventPatch(id: string, event: StoredAuditEvent, body: Record<string, unknown>): Partial<MissionControlAgent> {
  const patch: Partial<MissionControlAgent> = { lastEventAt: nanoToIso(event.timeUnixNano) };
  if (typeof body.displayName === "string") patch.displayName = body.displayName;
  if (event.name.includes("heartbeat")) patch.lastHeartbeatAt = patch.lastEventAt;
  if (event.name.includes("revoked")) patch.status = "offline";
  if (event.name.includes("failed") || event.name.includes("error")) {
    patch.health = "unhealthy";
    patch.lastError = typeof body.error === "string" ? body.error : event.name;
  }
  if (event.name === "connector.registered") {
    patch.kind = "connector";
    patch.status = "observed";
    patch.capabilities = Array.isArray(body.allowedScopes) ? body.allowedScopes.filter(isString) : [];
    patch.metadata = { connectorId: id };
  }
  if (event.name === "tunnel_session.heartbeat") {
    patch.kind = "tunnel";
    patch.status = "online";
    patch.health = "healthy";
  }
  return patch;
}

function finalizeAgent(agent: MissionControlAgent, now: Date): MissionControlAgent {
  const heartbeatAgeMs = agent.lastHeartbeatAt
    ? now.getTime() - Date.parse(agent.lastHeartbeatAt)
    : Number.POSITIVE_INFINITY;
  const eventAgeMs = agent.lastEventAt ? now.getTime() - Date.parse(agent.lastEventAt) : Number.POSITIVE_INFINITY;
  let status = agent.status;
  let health = agent.health;
  if (agent.lastHeartbeatAt) {
    status =
      heartbeatAgeMs <= DEFAULT_HEARTBEAT_ONLINE_WINDOW_MS
        ? "online"
        : heartbeatAgeMs <= DEFAULT_HEARTBEAT_TTL_MS
          ? "stale"
          : "offline";
    health =
      status === "online"
        ? "healthy"
        : status === "stale"
          ? "warning"
          : health === "unhealthy"
            ? "unhealthy"
            : "unknown";
  } else if (status !== "offline" && eventAgeMs > DEFAULT_HEARTBEAT_TTL_MS) {
    status = "stale";
  }
  return { ...agent, status, health };
}

function freshness(section: string): string {
  return `<p class="freshness" data-freshness="${section}" data-state="stale">Stale — awaiting authoritative refresh</p>`;
}

function summarize(workItems: WorkItem[], agents: MissionControlAgent[]) {
  return {
    totalAgents: agents.length,
    onlineAgents: agents.filter((agent) => agent.status === "online").length,
    running: workItems.filter((item) => item.status === "running").length,
    approvals: workItems.filter((item) => item.status === "needs_approval").length,
    failed: workItems.filter((item) => item.status === "failed").length,
    blocked: workItems.filter((item) => item.status === "blocked").length,
    quarantined: workItems.filter((item) => item.status === "quarantined").length,
    unavailableAgents: agents.filter((agent) => agent.status !== "online" || agent.health !== "healthy").length
  };
}

function overviewCards(stats: ReturnType<typeof summarize>): string {
  const cards = [
    ["Pending Approvals", stats.approvals, "Human decision required", "approvals", "needs_approval", "danger"],
    [
      "Blocked Work",
      stats.blocked,
      stats.quarantined ? `${stats.quarantined} quarantined` : "Awaiting resolution",
      "queue",
      "blocked",
      "warning"
    ],
    ["Failed", stats.failed, "Current failure window", "queue", "failed", "danger"],
    ["Running", stats.running, "Lease-bound execution", "execution", "running", "info"],
    ["Agents Online", stats.onlineAgents, `${stats.totalAgents} observed`, "agents", "", "success"]
  ];
  return cards
    .map(
      ([label, value, help, view, status, tone]) =>
        `<a class="card overview-stat tone-${tone}" href="${status ? `?status=${status}` : ""}#${view}" data-count-nav="${view}" data-count-status="${status}"><span class="stat-icon" aria-hidden="true"></span><strong>${value}</strong><b>${label}</b><p>${help}</p><span class="stat-arrow" aria-hidden="true">→</span></a>`
    )
    .join("");
}

function overviewApprovals(items: WorkItem[]): string {
  const rows = [...items]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 3)
    .map((item) => {
      const action = item.requestedActions[0]?.kind ?? "—";
      return `<tr><td><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.id)}</small></td><td>${escapeHtml(action)}</td><td>${pill(item.risk, "Risk")}</td><td>${time(item.updatedAt)}</td><td>${pill(item.status)}</td></tr>`;
    })
    .join("");
  return `<div class="panel-head"><h2>Recent Approvals</h2><a href="#approvals" data-nav="approvals">View all →</a></div><div class="table-wrap compact-table"><table><thead><tr><th>Work item</th><th>Action</th><th>Risk</th><th>Requested</th><th>Status</th></tr></thead><tbody>${rows || `<tr><td colspan="5" class="muted">No approvals waiting.</td></tr>`}</tbody></table></div>`;
}

function overviewHealth(
  stats: ReturnType<typeof summarize>,
  executionMode: MissionControlViewModel["executionMode"],
  executionBackend?: string
): string {
  const mode = executionMode ?? "Unavailable";
  const backend = executionBackend ?? "Not reported";
  return `<div class="panel-head"><h2>System Health</h2><a href="#system" data-nav="system">View details →</a></div>
  <dl class="health-list">
    <div><dt>Control Plane</dt><dd><span class="health-dot ok"></span>Serving</dd></div>
    <div><dt>Event Stream</dt><dd><span class="health-dot live-dot"></span><span data-overview-stream>Connecting</span></dd></div>
    <div><dt>Policy Engine</dt><dd><span class="health-dot ok"></span>${escapeHtml(mode)}</dd></div>
    <div><dt>Execution Backend</dt><dd>${escapeHtml(backend)}</dd></div>
    <div><dt>Visualizer</dt><dd id="overview-visualizer-health"><span class="health-dot visualizer-health-dot"></span><span data-visualizer-health>Checking</span></dd></div>
    <div><dt>Agents Online</dt><dd>${stats.onlineAgents} / ${stats.totalAgents}</dd></div>
  </dl>`;
}

function overviewAgentSummary(agents: MissionControlAgent[]): string {
  const online = agents.filter((agent) => agent.status === "online").length;
  const stale = agents.filter((agent) => agent.status === "stale").length;
  const observed = agents.filter((agent) => agent.status === "observed").length;
  const offline = agents.filter((agent) => agent.status === "offline").length;
  const total = agents.length;
  const onlineEnd = total ? Math.round((online / total) * 100) : 0;
  const observedEnd = total ? Math.round(((online + observed) / total) * 100) : 0;
  const staleEnd = total ? Math.round(((online + observed + stale) / total) * 100) : 0;
  return `<div class="panel-head"><h2>Agents</h2><a href="#agents" data-nav="agents">View all →</a></div>
  <div class="agent-summary"><div class="agent-donut" style="--online-end:${onlineEnd}%;--observed-end:${observedEnd}%;--stale-end:${staleEnd}%"><span><strong>${total}</strong><small>Total</small></span></div>
  <dl><div><dt><span class="legend-dot online-dot"></span>Online</dt><dd>${online}</dd></div><div><dt><span class="legend-dot observed-dot"></span>Observed</dt><dd>${observed}</dd></div><div><dt><span class="legend-dot stale-dot"></span>Stale</dt><dd>${stale}</dd></div><div><dt><span class="legend-dot offline-dot"></span>Offline</dt><dd>${offline}</dd></div></dl></div>`;
}

function overviewQueue(
  items: WorkItem[],
  attemptsByWorkItem: Record<string, ExecutionAttempt[]>,
  leasesByWorkItem: Record<string, MissionControlAttemptLease[]>,
  now: Date
): string {
  const rows = [...items]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5)
    .map((item) => {
      const worker = workItemAgentId(item, attemptsByWorkItem[item.id] ?? [], leasesByWorkItem[item.id] ?? []);
      const age = formatDuration(Math.max(0, now.getTime() - Date.parse(item.updatedAt)));
      return `<tr><td><strong>${escapeHtml(item.id)}</strong></td><td>${escapeHtml(item.title)}</td><td>${pill(item.risk)}</td><td>${pill(item.status)}</td><td>${escapeHtml(worker || "—")}</td><td>${age}</td></tr>`;
    })
    .join("");
  return `<div class="panel-head"><h2>Work Queue</h2><a href="#queue" data-nav="queue">View all →</a></div><div class="table-wrap compact-table"><table><thead><tr><th>ID</th><th>Task</th><th>Risk</th><th>Status</th><th>Agent</th><th>Age</th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="muted">No work items.</td></tr>`}</tbody></table></div>`;
}

function overviewAgentActivity(agents: MissionControlAgent[]): string {
  const rows = agents
    .slice(0, 5)
    .map(
      (agent) =>
        `<tr><td><strong>${escapeHtml(agent.displayName)}</strong></td><td>${pill(agent.status)}</td><td>${escapeHtml(agent.currentTask ?? "—")}</td><td>${agent.lastHeartbeatAt ? time(agent.lastHeartbeatAt) : "—"}</td></tr>`
    )
    .join("");
  return `<div class="panel-head"><h2>Agent Activity</h2><a href="#agents" data-nav="agents">View all →</a></div><div class="table-wrap compact-table"><table><thead><tr><th>Agent</th><th>Status</th><th>Current Task</th><th>Heartbeat</th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="muted">No agent activity observed.</td></tr>`}</tbody></table></div>`;
}

function overviewEvents(events: StoredAuditEvent[]): string {
  const rows = [...events]
    .reverse()
    .slice(0, 5)
    .map((event) => {
      const attrs = event.attributes ?? {};
      const resource = attrs["work_item.id"] || attrs["agent.id"] || attrs["connector.id"] || "System";
      return `<li><span class="event-dot"></span><div><strong>${escapeHtml(event.name)}</strong><small>${escapeHtml(String(resource))}</small></div><time>${time(nanoToIso(event.timeUnixNano))}</time></li>`;
    })
    .join("");
  return `<div class="panel-head"><h2>Recent Events</h2><a href="#audit" data-nav="audit">View all →</a></div><ol class="overview-events">${rows || `<li class="muted">No recent events.</li>`}</ol>`;
}

function visualizerPanel(): string {
  const runtimeOptions = ["codex", "hermes", "openclaw", "opencode", "claude", "pi"]
    .map((runtime) => `<option value="${runtime}">${runtime}</option>`)
    .join("");
  return `<div class="visualizer-toolbar"><div><strong>Canonical Execution Graph</strong><p>Read-only projection from the Visualizer durable graph store. ACS remains authoritative.</p></div><div class="viz-source-controls"><span class="viz-source-status" id="visualizer-source-status" role="status">Not loaded</span><button type="button" id="visualizer-refresh">Refresh projection</button></div></div>
  <div class="viz-health-strip" id="visualizer-health-strip"><span class="health-dot visualizer-page-health-dot"></span><strong>Visualizer</strong><span id="visualizer-health-state">Checking status</span><span id="visualizer-health-detail"></span></div>
  <div class="viz-summary" id="visualizer-summary" hidden>
    <div><strong id="viz-summary-canonical">0</strong><span>Canonical</span></div>
    <div><strong id="viz-summary-active">0</strong><span>Active</span></div>
    <div><strong id="viz-summary-not-projected">0</strong><span>Not projected</span></div>
    <div><strong id="viz-summary-unavailable">0</strong><span>Unavailable</span></div>
  </div>
  <div class="viz-filter" role="search" aria-label="Filter Visualizer projection">
    <label for="visualizer-filter-text">Search<input id="visualizer-filter-text" type="search" autocomplete="off" spellcheck="false" placeholder="work item, execution, or node" /></label>
    <label for="visualizer-filter-runtime">Runtime<select id="visualizer-filter-runtime"><option value="">All runtimes</option>${runtimeOptions}</select></label>
    <label for="visualizer-filter-state">Projection<select id="visualizer-filter-state"><option value="">All states</option><option value="available">Canonical</option><option value="not_projected">Not projected</option><option value="unavailable">Unavailable</option></select></label>
    <span id="visualizer-filter-live" aria-live="polite">No projection loaded</span>
  </div>
  <div class="visualizer-canvas" id="visualizer-canvas" aria-live="polite"><p class="empty">Open this view to load the canonical Visualizer projection.</p></div>`;
}
function agentTable(agents: MissionControlAgent[]): string {
  if (!agents.length) return `<div class="table-wrap"><p class="empty">No agents or connectors observed.</p></div>`;
  return `<div class="table-wrap"><table class="agent-table"><thead><tr><th>Agent</th><th>Type</th><th>Status</th><th>Health</th><th>Current task</th><th>Heartbeat</th><th>Last error</th></tr></thead><tbody id="agent-roster-body">${agents
    .map(
      (agent) =>
        `<tr class="agent-row" data-agent="${escapeHtml(agent.id)}" data-agent-id="${escapeHtml(agent.id)}"><td><button type="button" class="agent-name" aria-pressed="false">${escapeHtml(agent.displayName)}</button><small>${escapeHtml(agent.id)}</small></td><td>${escapeHtml(agent.kind)}</td><td>${pill(agent.status)}</td><td>${pill(agent.health)}</td><td>${agent.currentTask ? escapeHtml(agent.currentTask) : "—"}</td><td>${agent.lastHeartbeatAt ? time(agent.lastHeartbeatAt) : "—"}</td><td>${agent.lastError ? escapeHtml(redactSecrets(agent.lastError)) : "—"}</td></tr>`
    )
    .join("")}</tbody></table></div>`;
}

function agentDetailPanel(): string {
  return `<section id="agent-detail" class="detail-panel agent-detail" tabindex="-1" aria-live="polite" aria-label="Agent detail">
    <div class="detail-empty"><h3>No agent selected</h3><p>Select a row to load the registry record.</p></div>
  </section>`;
}

function queueFilterStrip(): string {
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

function workQueue(
  workItems: WorkItem[],
  executionPlansByWorkItem: Record<string, ExecutionPlanRecord>,
  executionPlanAdmissionsByWorkItem: Record<string, ExecutionPlanAdmission>,
  executionAttemptsByWorkItem: Record<string, ExecutionAttempt[]>,
  attemptLeasesByWorkItem: Record<string, MissionControlAttemptLease[]>
): string {
  return `<p id="queue-empty" class="empty"${workItems.length ? " hidden" : ""}>No work items.</p><p id="queue-no-matches" class="empty" hidden>No matching work items — <button type="button" data-clear-filters>Clear filters</button></p><div class="queue">${workItems
    .map((item) => {
      const attention = needsOperatorAttention(item.status);
      const plan = executionPlansByWorkItem[item.id];
      const admission = executionPlanAdmissionsByWorkItem[item.id];
      const attempts = executionAttemptsByWorkItem[item.id] ?? [];
      const leases = attemptLeasesByWorkItem[item.id] ?? [];
      const agentId = workItemAgentId(item, attempts, leases);
      return `<button class="queue-item${attention ? " attention" : ""}" data-work-item="${escapeHtml(item.id)}" data-status="${escapeHtml(item.status)}" data-title="${escapeHtml(item.title)}" data-agent-id="${escapeHtml(agentId)}" data-has-execution="${Boolean(plan || attempts.length)}"><span>${pill(item.status)} ${pill(item.risk, "Risk")}${attention ? attentionBadge() : ""}</span><strong>${escapeHtml(item.title)}</strong><small class="queue-intent">${escapeHtml(redactSecrets(item.intent))}</small>${executionPlanBadge(plan, admission)}${executionSummary(attempts, leases)}${workItemError(item)}</button>`;
    })
    .join(
      ""
    )}</div><section id="work-detail" class="detail-panel work-detail" tabindex="-1" aria-live="polite" aria-labelledby="work-detail-heading"><div class="detail-empty"><h3 id="work-detail-heading">No work item selected</h3><p>Select a work item to inspect its timeline and execution authority.</p></div></section>`;
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

function approvalOptionsByWorkItem(model: MissionControlViewModel): Record<string, ApprovalActionOption[]> {
  const labelled = model.approvalActionsByWorkItem ?? {};
  const legacy = model.approvalActionHashesByWorkItem ?? {};
  const out: Record<string, ApprovalActionOption[]> = {};
  for (const id of new Set([...Object.keys(legacy), ...Object.keys(labelled)])) {
    out[id] = labelled[id] ?? (legacy[id] ?? []).map((actionHash) => ({ actionHash, kind: "" }));
  }
  return out;
}

function approvalsPanel(items: WorkItem[], approvalActionsByWorkItem: Record<string, ApprovalActionOption[]>): string {
  if (!items.length)
    return `<p class="empty">No pending approvals or blocked work.</p><div class="approvals-list" role="list"></div>`;
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
      const reason = `<label class="reason-field" for="${reasonId}"><span class="reason-label">Reason <span class="req">${item.status === "blocked" ? "(required for Reject only)" : "(required)"}</span></span><input id="${reasonId}" data-reason="${escapeHtml(item.id)}" aria-describedby="${resultId}" placeholder="Reason for approval or rejection" autocomplete="off" /></label>`;
      const outcome = `<output id="${resultId}" class="approval-result" aria-live="polite"></output>`;
      const approvalButtons = approvalButtonsFor(item, approvalActionsByWorkItem[item.id] ?? [], reasonId);
      if (item.status === "blocked") {
        return `<article class="approval-item" role="listitem" data-approval-item="${escapeHtml(item.id)}" data-actions="${escapeHtml(actions)}" data-updated-at="${escapeHtml(item.updatedAt)}" data-target="${escapeHtml(redactedAttributesJson(item.target))}" data-risk="${escapeHtml(item.risk)}"><span>${pill(item.status)} ${pill(item.risk, "Risk")}</span><strong id="approval-title-${escapeHtml(item.id)}">${escapeHtml(item.title)}</strong><small>Actions: ${escapeHtml(actions)}</small>${error ? `<small class="error-line">${escapeHtml(error)}</small>` : ""}${reason}<p id="unblock-help-${escapeHtml(item.id)}" class="muted">Unblock re-evaluates policy; no reason is recorded for Unblock.</p><div class="approval-actions" role="group" aria-label="Actions for ${escapeHtml(item.title)}"><button type="button" disabled data-unblock="${escapeHtml(item.id)}" data-risk="${escapeHtml(item.risk)}" aria-describedby="unblock-help-${escapeHtml(item.id)}">Unblock</button><button type="button" disabled data-reject="${escapeHtml(item.id)}" data-risk="${escapeHtml(item.risk)}" aria-describedby="${reasonId}">Reject</button></div>${outcome}</article>`;
      }
      return `<article class="approval-item" role="listitem" data-approval-item="${escapeHtml(item.id)}" data-actions="${escapeHtml(actions)}" data-updated-at="${escapeHtml(item.updatedAt)}" data-target="${escapeHtml(redactedAttributesJson(item.target))}" data-risk="${escapeHtml(item.risk)}"><span>${pill(item.status)} ${pill(item.risk, "Risk")}</span><strong id="approval-title-${escapeHtml(item.id)}">${escapeHtml(item.title)}</strong><small>Requester: ${escapeHtml(item.requesterSubject ?? item.requester)} · Actions: ${escapeHtml(actions)}</small>${approvalSummary ? `<small class="approval-summary">${escapeHtml(redactSecrets(approvalSummary))}</small>` : ""}${reason}<div class="approval-actions" role="group" aria-label="Actions for ${escapeHtml(item.title)}">${approvalButtons}<button type="button" disabled data-reject="${escapeHtml(item.id)}" data-risk="${escapeHtml(item.risk)}" aria-describedby="${reasonId}">Reject</button></div>${outcome}</article>`;
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
      return `<button type="button" disabled data-approve="${escapeHtml(item.id)}" data-action-hash="${escapeHtml(option.actionHash)}"${option.kind ? ` data-action-kind="${escapeHtml(option.kind)}"` : ""} data-risk="${escapeHtml(item.risk)}" aria-label="${escapeHtml(ariaLabel)}" aria-describedby="${reasonId}" title="${escapeHtml(option.actionHash)}">Approve${kind} <code class="hash-prefix">${escapeHtml(hashPrefix)}</code></button>`;
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

function operatorMetricsPanel(
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
  const oldestApprovalWait = maxAgeMs(
    pendingApprovals.map((item) => item.createdAt),
    now
  );
  return `<div class="operator-metrics"><dl>
    <div><dt>Active leases</dt><dd>${activeLeases.length}</dd></div>
    <div><dt>Oldest lease age</dt><dd>${formatDuration(oldestLeaseAge)}</dd></div>
    <div><dt>Pending approvals</dt><dd>${pendingApprovals.length}</dd></div>
    <div><dt>Oldest approval wait</dt><dd>${formatDuration(oldestApprovalWait)}</dd></div>
  </dl>
  <p class="metrics-scrape">429s / rate limits: scrape authenticated <a href="/metrics"><code>GET /metrics</code></a> for <code>acs_rate_limit_rejected_total</code> and <code>acs_http_requests_total{status="429"}</code>. Full names: <code>docs/runbooks/operator-metrics.md</code>.</p>
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

function systemPanel(stats: ReturnType<typeof summarize>, executionBackend?: string): string {
  const backend = executionBackend ? escapeHtml(executionBackend) : "unset";
  return `<div class="system-panel"><dl><div><dt>Agents online</dt><dd>${stats.onlineAgents} / ${stats.totalAgents}</dd></div><div><dt>Running tasks</dt><dd>${stats.running}</dd></div><div><dt>Pending approvals</dt><dd>${stats.approvals}</dd></div><div><dt>Failed / blocked / quarantined</dt><dd>${stats.failed} / ${stats.blocked} / ${stats.quarantined}</dd></div><div><dt>Execution backend</dt><dd>${backend}</dd></div></dl><div id="system-probes" class="system-probes" aria-live="polite">Readiness not checked yet.</div></div>`;
}

function connectorsPanel(agents: MissionControlAgent[], executionBackend?: string): string {
  const connectors = agents.filter((agent) => /connector|tunnel/i.test(agent.kind));
  const backend = executionBackend ? escapeHtml(executionBackend) : "unset";
  const rows = connectors.length
    ? `<div class="table-wrap"><table><thead><tr><th>Connector</th><th>Status</th><th>Last event</th></tr></thead><tbody>${connectors
        .map(
          (agent) =>
            `<tr><td><button type="button" class="agent-name" aria-pressed="false">${escapeHtml(agent.displayName)}</button><small>${escapeHtml(agent.id)}</small></td><td>${pill(agent.status)}</td><td>${agent.lastEventAt ? time(agent.lastEventAt) : "—"}</td></tr>`
        )
        .join("")}</tbody></table></div>`
    : `<p class="empty">No connectors observed.</p>`;
  return `${rows}<p class="empty">Execution backend: ${backend}</p>`;
}

function policyPanel(events: StoredAuditEvent[]): string {
  const policyEvents = events.filter((event) => /policy/i.test(event.name));
  if (!policyEvents.length) return `<p class="empty">No policy events in the current audit window.</p>`;
  return eventTimeline([...policyEvents].reverse());
}

function eventTimeline(events: StoredAuditEvent[]): string {
  return `${events.length ? "" : `<p class="empty">No audit events in the current window.</p>`}<ol class="timeline">${events
    .map((event) => {
      const attrs = event.attributes ?? {};
      const resource = attrs["work_item.id"] || attrs["agent.id"] || attrs["connector.id"] || "System";
      const outcome = attrs.status || attrs.outcome || attrs.decision || event.name.split(".").at(-1) || "Event";
      const iso = nanoToIso(event.timeUnixNano);
      return `<li data-event-key="${escapeHtml(event.id || `${event.timeUnixNano}:${event.name}`)}"><strong>${escapeHtml(event.name)}</strong><p>${escapeHtml(String(resource))} · ${escapeHtml(String(outcome))}</p><time datetime="${escapeHtml(iso)}">${time(iso)}</time><details><summary>Event attributes</summary><pre>${escapeHtml(redactedAttributesJson(attrs))}</pre></details></li>`;
    })
    .join("")}</ol>`;
}

function composer(): string {
  return `<form id="task-form">
    <label>Title<input name="title" required maxlength="120" placeholder="Investigate failing agent route" /></label>
    <label>Prompt / instructions<textarea name="intent" required rows="7" placeholder="State the objective, constraints, and expected output."></textarea></label>
    <div class="form-row"><label>Risk<select name="risk"><option>low</option><option selected>medium</option><option>high</option><option>critical</option></select></label><label>Target service<input name="service" aria-describedby="service-help" placeholder="Service identifier" /></label></div>
    <p id="service-help">Leave target service blank for no service constraint. This form creates a work item; it does not guarantee dispatch.</p><label>Requested action kind<input name="actionKind" aria-describedby="action-help" placeholder="agent.prompt" /></label><p id="action-help">Default action: agent.prompt. Every request is evaluated by ACS policy.</p>
    <label>Requested action description<input name="actionDescription" aria-describedby="description-help" /></label><p id="description-help">Default description: Dispatch prompt to selected agent. The description does not override routing or policy.</p>
    <button type="submit">Create Work Item</button><output id="task-result" role="status"></output>
  </form>`;
}

function pill(value: string, label?: string): string {
  return `<span class="pill ${escapeHtml(value)}">${label ? `${label}: ` : ""}${escapeHtml(value)}</span>`;
}

function time(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? escapeHtml(value) : date.toLocaleString(undefined, { timeZoneName: "short" });
}

function nanoToIso(value: string): string {
  const asNumber = Number(value);
  return Number.isFinite(asNumber) ? new Date(Math.floor(asNumber / 1_000_000)).toISOString() : value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function statusRank(status: MissionControlAgent["status"]): number {
  return { online: 0, observed: 1, stale: 2, offline: 3 }[status];
}

function registryStatus(status: RegistryAgentDetail["status"]): Pick<MissionControlAgent, "status" | "health"> {
  if (status === "ERROR") return { status: "offline", health: "unhealthy" };
  if (status === "OFFLINE") return { status: "offline", health: "unknown" };
  if (status === "DEGRADED") return { status: "observed", health: "warning" };
  return { status: "observed", health: "unknown" };
}

function escapeHtml(value: string): string {
  return redactSecrets(value).replace(/[&<>"']/g, (char) => {
    const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return escapes[char] ?? char;
  });
}
