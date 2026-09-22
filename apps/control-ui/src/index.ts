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
  approvalActionHashesByWorkItem?: Record<string, string[]>;
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
  now?: Date;
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

export type SseConnectionRoot = {
  querySelector(selectors: string): SseConnectionElement | null;
  querySelectorAll(selectors: string): ArrayLike<SseConnectionButton>;
};

export type SseConnectionElement = {
  hidden: boolean;
  classList: { toggle(token: string, force?: boolean): unknown };
  innerHTML: string;
};

export type SseConnectionButton = {
  disabled: boolean;
  getAttribute(name: string): string | null;
};

/** Exponential backoff for EventSource reconnect: 1s, 2s, 4s, 8s, 16s, then 30s cap. */
export function nextSseReconnectDelayMs(attempt: number): number {
  const n = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  return Math.min(30_000, 1_000 * 2 ** Math.min(n, 5));
}

/** Show/hide the stale-stream banner and disable approve/deny/unblock while disconnected. */
export function applySseConnectionState(root: SseConnectionRoot, connected: boolean): void {
  const banner = root.querySelector("#sse-stale-banner");
  if (banner) banner.hidden = connected;
  const live = root.querySelector(".live");
  if (live) {
    live.classList.toggle("disconnected", !connected);
    live.innerHTML = connected
      ? `<span aria-hidden="true"></span> Live`
      : `<span aria-hidden="true"></span> Disconnected`;
  }
  for (const button of Array.from(root.querySelectorAll("[data-approve],[data-reject],[data-unblock]"))) {
    const approveWithoutHash = button.getAttribute("data-approve") !== null && !button.getAttribute("data-action-hash");
    button.disabled = !connected || approveWithoutHash;
  }
}

/** High/critical risk (elevated require_approval) needs a second confirm before POST. */
export function isElevatedApprovalRisk(risk: string): boolean {
  const normalized = String(risk ?? "")
    .trim()
    .toLowerCase();
  return normalized === "high" || normalized === "critical";
}

/** Short prefix of an action hash for confirm dialog copy (full hash stays on the button). */
export function approvalActionHashPrefix(hash: string, maxLen = 12): string {
  const text = String(hash ?? "");
  if (!text) return "";
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

export type ApprovalConfirmRequest = {
  workItemId: string;
  action: "approve" | "reject";
  actionHash?: string;
  risk: string;
};

export type ApprovalConfirmDocument = {
  body: { appendChild(node: HTMLElement): unknown };
  createElement(tagName: string): HTMLElement;
  addEventListener(type: string, listener: (event: KeyboardEvent) => void): void;
  removeEventListener(type: string, listener: (event: KeyboardEvent) => void): void;
  getElementById(id: string): HTMLElement | null;
  activeElement?: { focus?(): void } | null;
};

/**
 * Modal confirm for elevated-risk approve/deny.
 * Esc or Cancel resolves false without side effects; Confirm resolves true.
 * Initial focus is on Cancel (confirm is never the default focused control).
 */
export function requestApprovalConfirm(
  doc: ApprovalConfirmDocument,
  request: ApprovalConfirmRequest
): Promise<boolean> {
  return new Promise((resolve) => {
    const existing = doc.getElementById("approval-confirm-dialog");
    if (existing) existing.remove();

    const overlay = doc.createElement("div");
    overlay.id = "approval-confirm-dialog";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "approval-confirm-title");
    overlay.className = "approval-confirm-overlay";

    const actionLabel = request.action === "approve" ? "Approve" : "Deny";
    const hashPrefix = approvalActionHashPrefix(request.actionHash ?? "");
    const hashLine = hashPrefix
      ? `<p class="approval-confirm-hash">Action hash: <code>${escapeHtml(hashPrefix)}</code></p>`
      : "";

    overlay.innerHTML = `<div class="approval-confirm-card">
  <h3 id="approval-confirm-title">${escapeHtml(actionLabel)} high-risk work item?</h3>
  <p class="approval-confirm-id">Work item: <code>${escapeHtml(request.workItemId)}</code></p>
  <p class="approval-confirm-risk">Risk: <strong>${escapeHtml(request.risk)}</strong></p>
  ${hashLine}
  <div class="approval-confirm-actions">
    <button type="button" id="approval-confirm-cancel" data-approval-confirm-cancel>Cancel</button>
    <button type="button" id="approval-confirm-ok" data-approval-confirm-ok>${escapeHtml(actionLabel)}</button>
  </div>
</div>`;

    const finish = (confirmed: boolean) => {
      doc.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      resolve(confirmed);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    };

    doc.body.appendChild(overlay);
    doc.addEventListener("keydown", onKeyDown);

    const cancelBtn = overlay.querySelector("#approval-confirm-cancel") as HTMLElement | null;
    const okBtn = overlay.querySelector("#approval-confirm-ok") as HTMLElement | null;
    cancelBtn?.addEventListener("click", () => finish(false));
    okBtn?.addEventListener("click", () => finish(true));
    // Confirm must not be the initially focused control.
    cancelBtn?.focus?.();
  });
}

export type ApprovalPostResult = {
  posted: boolean;
  confirmed?: boolean;
  cancelled?: boolean;
  status?: number;
  error?: string;
};

export type ApprovalActionClickOptions = {
  document: ApprovalConfirmDocument & {
    querySelector(selectors: string): { value?: string; focus?(): void; textContent?: string | null } | null;
  };
  button: {
    dataset: {
      approve?: string;
      reject?: string;
      unblock?: string;
      actionHash?: string;
      risk?: string;
    };
    getAttribute?(name: string): string | null;
  };
  connected: boolean;
  fetchImpl: (
    input: string,
    init: { method: string; headers: Record<string, string>; body: string }
  ) => Promise<{
    ok: boolean;
    status: number;
    json(): Promise<{ error?: string; code?: string }>;
  }>;
  /** Optional override for tests; defaults to requestApprovalConfirm. */
  requestConfirm?: (doc: ApprovalConfirmDocument, request: ApprovalConfirmRequest) => Promise<boolean>;
};

/**
 * Shared approve/deny/unblock click path used by Mission Control (and component tests).
 * Elevated risk requires a confirm step before POST; Cancel/Esc leaves state unchanged.
 */
export async function handleApprovalActionClick(options: ApprovalActionClickOptions): Promise<ApprovalPostResult> {
  const { button, connected, fetchImpl } = options;
  const doc = options.document;
  const id = button.dataset.approve || button.dataset.reject || button.dataset.unblock;
  if (!id) return { posted: false, error: "missing work item id" };
  const action = button.dataset.approve ? "approve" : button.dataset.reject ? "reject" : "unblock";
  const risk =
    button.dataset.risk || (typeof button.getAttribute === "function" ? button.getAttribute("data-risk") : null) || "";
  const output = doc.querySelector("#approval-result-" + id);
  if (!connected) {
    if (output) output.textContent = "Disconnected: actions disabled until reconnect";
    return { posted: false, error: "disconnected" };
  }
  const reasonInput = doc.querySelector('[data-reason="' + id + '"]');
  const reason = reasonInput && typeof reasonInput.value === "string" ? reasonInput.value.trim() : "";
  if (action !== "unblock" && !reason) {
    if (output) output.textContent = "Reason required";
    reasonInput?.focus?.();
    return { posted: false, error: "reason required" };
  }

  if ((action === "approve" || action === "reject") && isElevatedApprovalRisk(risk)) {
    if (doc.getElementById("approval-confirm-dialog")) {
      // Another confirm is already open — do not POST.
      return { posted: false, cancelled: true };
    }
    const confirmFn = options.requestConfirm ?? requestApprovalConfirm;
    const confirmed = await confirmFn(doc, {
      workItemId: id,
      action,
      actionHash: button.dataset.actionHash,
      risk
    });
    if (!confirmed) {
      return { posted: false, cancelled: true, confirmed: false };
    }
  }

  const headers = { "content-type": "application/json" };
  const payload: Record<string, string> = action === "unblock" ? {} : { reason };
  if (action === "approve") {
    const actionHash = button.dataset.actionHash;
    if (!actionHash) {
      if (output) output.textContent = "Approval action hash unavailable";
      return { posted: false, error: "action hash unavailable" };
    }
    payload.actionHash = actionHash;
  }
  const res = await fetchImpl("/work-items/" + id + "/" + action, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });
  const body = await res.json();
  if (output) {
    output.textContent = res.ok ? action + " accepted" : "Rejected: " + (body.error || body.code || res.status);
  }
  return {
    posted: true,
    confirmed: true,
    status: res.status,
    error: res.ok ? undefined : body.error || body.code || String(res.status)
  };
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
            `<li><strong>${escapeHtml(action.kind)}</strong><small>${escapeHtml(action.description ?? "")}</small></li>`
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
          return `<li><time>${when}</time><strong>${escapeHtml(event.name || "event")}</strong><small>${escapeHtml(ref)}</small></li>`;
        })
        .join("")}</ol>`
    : `<p class="muted">No matching events.</p>`;
  return `<div class="detail-head"><div><h3 id="work-detail-title">${escapeHtml(workItem.title)}</h3><small>${escapeHtml(workItem.id)}</small></div><div>${pill(workItem.status)} ${pill(workItem.risk)}</div></div><dl class="detail-grid"><div><dt>Requester</dt><dd>${escapeHtml(workItem.requester || "—")}</dd></div><div><dt>Intent</dt><dd>${escapeHtml(workItem.intent || "—")}</dd></div><div><dt>Target</dt><dd>${escapeHtml(workItem.target ? JSON.stringify(workItem.target) : "—")}</dd></div><div><dt>Created</dt><dd>${workItem.createdAt ? time(workItem.createdAt) : "—"}</dd></div></dl><div class="detail-section"><h4>Requested Actions</h4>${actionList}</div><div class="detail-section"><h4>Timeline</h4>${eventItems}</div>`;
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

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ACS Mission Control</title>
    <style>${styles()}</style>
  </head>
  <body data-active-view="overview">
    <a class="skip-link" href="#main-content">Skip to main content</a>
    <aside aria-label="Mission control navigation">
      <div class="brand">ACS<span>MISSION CONTROL</span></div>
      <nav aria-label="Primary">
        <a href="#overview" class="active" data-nav="overview">Overview</a>
        <a href="#queue" data-nav="queue">Work Queue</a>
        <a href="#queue" data-nav="execution">Execution</a>
        <a href="#approvals" data-nav="approvals">Approvals</a>
        <a href="#agents" data-nav="agents">Agents</a>
        <a href="#connectors" data-nav="connectors">Connectors</a>
        <a href="#operator-metrics" data-nav="metrics">Metrics</a>
        <a href="#events" data-nav="audit">Audit</a>
        <a href="#policy" data-nav="policy">Policy</a>
        <a href="#system" data-nav="system">System</a>
      </nav>
      <p class="rail-note">Local-first control plane. Live state comes from the registry, work-item store, and audit stream.</p>
    </aside>
    <main id="main-content" tabindex="-1">
      <header>
        <div><h1>Mission Control</h1><p>Agents, work items, approvals, and audit events.</p></div>
        <div class="live" aria-live="polite"><span aria-hidden="true"></span> SSE ready</div>
      </header>
      <div id="sse-stale-banner" class="stale-banner" hidden role="status" aria-live="assertive">Connection lost. Displayed work items may be stale. Approve and deny are disabled until the live stream reconnects.</div>
      <section id="overview" class="cards" data-view-panel="overview">${overviewCards(stats)}</section>
      <section class="grid">
        <article id="agents" class="panel wide roster-panel" data-view-panel="agents"><div class="panel-head"><div><h2>Agent Roster</h2><p>Backend registry + audit projection</p></div><span id="agent-count">${agents.length} observed</span></div><div class="agent-layout">${agentTable(agents)}${agentDetailPanel()}</div></article>
        <article id="queue" class="panel queue-panel" data-view-panel="queue execution"><div class="panel-head"><h2>Work Queue</h2><span id="queue-filter-count">${escapeHtml(String(model.workItems.length))} items</span></div>${queueFilterStrip()}${workQueue(model.workItems, executionPlansByWorkItem, executionPlanAdmissionsByWorkItem, executionAttemptsByWorkItem, attemptLeasesByWorkItem)}</article>
      </section>
      <section class="grid approvals-grid">
        <article id="approvals" class="panel wide" data-view-panel="overview approvals"><div class="panel-head"><h2>Approvals</h2><span>${approvalItems.length} waiting</span></div>${approvalsPanel(approvalItems, model.approvalActionHashesByWorkItem ?? {})}</article>
      </section>
      <section class="grid lower">
        <article id="operator-metrics" class="panel" data-view-panel="metrics"><div class="panel-head"><h2>Operator metrics</h2><span>leases · approvals · 429s</span></div>${operatorMetricsPanel(model.workItems, attemptLeasesByWorkItem, model.now ?? new Date())}</article>
        <article id="events" class="panel" data-view-panel="audit"><div class="panel-head"><h2>Recent Events</h2><span>append-only</span></div>${eventTimeline([...events].reverse())}</article>
        <article id="system" class="panel" data-view-panel="system"><div class="panel-head"><h2>System Health</h2><span>live</span></div>${systemPanel(stats, model.executionBackend)}</article>
      </section>
      <section class="grid lower">
        <article id="dispatch" class="panel composer" data-view-panel="overview"><div class="panel-head"><h2>New Task Composer</h2><span>authenticated session</span></div>${composer()}</article>
        <article id="connectors" class="panel" data-view-panel="connectors"><div class="panel-head"><h2>Connectors</h2><span>${agents.filter((agent) => /connector|tunnel/i.test(agent.kind)).length} observed</span></div>${connectorsPanel(agents, model.executionBackend)}</article>
        <article id="policy" class="panel" data-view-panel="policy"><div class="panel-head"><h2>Policy</h2><span>audit</span></div>${policyPanel(events)}</article>
        <article class="panel" data-view-panel="overview"><div class="panel-head"><h2>Safety Notes</h2><span>fail closed</span></div><p class="empty">Approval and cancellation actions use authenticated backend routes and append audit events. Bulk approval is not exposed.</p></article>
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

function summarize(workItems: WorkItem[], agents: MissionControlAgent[]) {
  return {
    totalAgents: agents.length,
    onlineAgents: agents.filter((agent) => agent.status === "online").length,
    running: workItems.filter((item) => item.status === "running").length,
    approvals: workItems.filter((item) => item.status === "needs_approval").length,
    failed: workItems.filter((item) => item.status === "failed" || item.status === "blocked").length
  };
}

function overviewCards(stats: ReturnType<typeof summarize>): string {
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

function agentTable(agents: MissionControlAgent[]): string {
  if (!agents.length) return `<div class="table-wrap"><p class="empty">No agents or connectors observed.</p></div>`;
  return `<div class="table-wrap"><table class="agent-table"><thead><tr><th>Agent</th><th>Type</th><th>Status</th><th>Health</th><th>Current task</th><th>Heartbeat</th><th>Last error</th></tr></thead><tbody id="agent-roster-body">${agents
    .map(
      (agent) =>
        `<tr class="agent-row" tabindex="0" data-agent="${escapeHtml(agent.id)}" data-agent-id="${escapeHtml(agent.id)}"><td><strong>${escapeHtml(agent.displayName)}</strong><small>${escapeHtml(agent.id)}</small></td><td>${escapeHtml(agent.kind)}</td><td>${pill(agent.status)}</td><td>${pill(agent.health)}</td><td>${agent.currentTask ? escapeHtml(agent.currentTask) : "—"}</td><td>${agent.lastHeartbeatAt ? time(agent.lastHeartbeatAt) : "—"}</td><td>${agent.lastError ? escapeHtml(agent.lastError) : "—"}</td></tr>`
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
  if (!workItems.length) return `<p class="empty">No work items.</p>`;
  return `<div class="queue">${workItems
    .map((item) => {
      const attention = needsOperatorAttention(item.status);
      const plan = executionPlansByWorkItem[item.id];
      const admission = executionPlanAdmissionsByWorkItem[item.id];
      const attempts = executionAttemptsByWorkItem[item.id] ?? [];
      const leases = attemptLeasesByWorkItem[item.id] ?? [];
      const agentId = workItemAgentId(item, attempts, leases);
      return `<button class="queue-item${attention ? " attention" : ""}" data-work-item="${escapeHtml(item.id)}" data-status="${escapeHtml(item.status)}" data-title="${escapeHtml(item.title)}" data-agent-id="${escapeHtml(agentId)}"><span>${pill(item.status)} ${pill(item.risk)}${attention ? attentionBadge() : ""}</span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.intent)}</small>${executionPlanBadge(plan, admission)}${executionSummary(attempts, leases)}${workItemError(item)}</button>`;
    })
    .join(
      ""
    )}</div><section id="work-detail" class="detail-panel work-detail" tabindex="-1" aria-live="polite" aria-labelledby="work-detail-heading"><div class="detail-empty"><h3 id="work-detail-heading">No work item selected</h3><p>Timeline pending.</p></div></section>`;
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

function approvalsPanel(items: WorkItem[], approvalActionHashesByWorkItem: Record<string, string[]>): string {
  if (!items.length) return `<p class="empty">No approvals or blocked work.</p>`;
  return `<div class="approvals-list" role="list">${items
    .map((item) => {
      const actions = item.requestedActions.map((action) => action.kind).join(", ") || "none";
      const error = workItemResultError(item);
      const reasonId = `reason-${escapeHtml(item.id)}`;
      const resultId = `approval-result-${escapeHtml(item.id)}`;
      const reason = `<label class="reason-field" for="${reasonId}"><span class="reason-label">Reason <span class="req">(required)</span></span><input id="${reasonId}" data-reason="${escapeHtml(item.id)}" required placeholder="Why approve, reject, or unblock" autocomplete="off" /></label>`;
      const outcome = `<output id="${resultId}" class="approval-result" aria-live="polite"></output>`;
      const approvalButtons = approvalButtonsFor(item, approvalActionHashesByWorkItem[item.id] ?? [], reasonId);
      if (item.status === "blocked") {
        return `<article class="approval-item" role="listitem" data-risk="${escapeHtml(item.risk)}"><span>${pill(item.status)} ${pill(item.risk)}</span><strong id="approval-title-${escapeHtml(item.id)}">${escapeHtml(item.title)}</strong><small>Actions: ${escapeHtml(actions)}</small>${error ? `<small class="error-line">${escapeHtml(error)}</small>` : ""}${reason}<div class="approval-actions" role="group" aria-label="Actions for ${escapeHtml(item.title)}"><button type="button" data-unblock="${escapeHtml(item.id)}" data-risk="${escapeHtml(item.risk)}" aria-describedby="${reasonId}">Unblock</button><button type="button" data-reject="${escapeHtml(item.id)}" data-risk="${escapeHtml(item.risk)}" aria-describedby="${reasonId}">Reject</button></div>${outcome}</article>`;
      }
      return `<article class="approval-item" role="listitem" data-risk="${escapeHtml(item.risk)}"><span>${pill(item.status)} ${pill(item.risk)}</span><strong id="approval-title-${escapeHtml(item.id)}">${escapeHtml(item.title)}</strong><small>Requester: ${escapeHtml(item.requester)} · Actions: ${escapeHtml(actions)}</small>${reason}<div class="approval-actions" role="group" aria-label="Actions for ${escapeHtml(item.title)}">${approvalButtons}<button type="button" data-reject="${escapeHtml(item.id)}" data-risk="${escapeHtml(item.risk)}" aria-describedby="${reasonId}">Reject</button></div>${outcome}</article>`;
    })
    .join("")}</div>`;
}

function approvalButtonsFor(item: WorkItem, hashes: string[], reasonId: string): string {
  if (!hashes.length) {
    return `<button type="button" data-approve="${escapeHtml(item.id)}" data-risk="${escapeHtml(item.risk)}" disabled aria-describedby="${reasonId}">Approval hash unavailable</button>`;
  }
  return hashes
    .map(
      (hash, index) =>
        `<button type="button" data-approve="${escapeHtml(item.id)}" data-action-hash="${escapeHtml(hash)}" data-risk="${escapeHtml(item.risk)}" aria-describedby="${reasonId}">Approve ${index + 1}</button>`
    )
    .join("");
}

function workItemError(item: WorkItem): string {
  const error = workItemResultError(item);
  return error ? `<small class="error-line">${escapeHtml(error)}</small>` : "";
}

function workItemResultError(item: WorkItem): string | undefined {
  const result = item.result;
  return result && typeof result.error === "string" ? result.error : undefined;
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
  return `<div class="system-panel"><dl><div><dt>Agents online</dt><dd>${stats.onlineAgents} / ${stats.totalAgents}</dd></div><div><dt>Running tasks</dt><dd>${stats.running}</dd></div><div><dt>Pending approvals</dt><dd>${stats.approvals}</dd></div><div><dt>Failed or blocked</dt><dd>${stats.failed}</dd></div><div><dt>Execution backend</dt><dd>${backend}</dd></div></dl><div id="system-probes" class="system-probes"></div></div>`;
}

function connectorsPanel(agents: MissionControlAgent[], executionBackend?: string): string {
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

function policyPanel(events: StoredAuditEvent[]): string {
  const policyEvents = events.filter((event) => /policy/i.test(event.name));
  if (!policyEvents.length) return `<p class="empty">No policy events in the current audit window.</p>`;
  return eventTimeline([...policyEvents].reverse());
}

function eventTimeline(events: StoredAuditEvent[]): string {
  if (!events.length) return `<p class="empty">No audit events recorded.</p>`;
  return `<ol class="timeline">${events
    .map(
      (event) =>
        `<li><time>${time(nanoToIso(event.timeUnixNano))}</time><strong>${escapeHtml(event.name)}</strong><small>${escapeHtml(JSON.stringify(event.attributes))}</small></li>`
    )
    .join("")}</ol>`;
}

function composer(): string {
  return `<form id="task-form">
    <label>Title<input name="title" required maxlength="120" placeholder="Investigate failing agent route" /></label>
    <label>Prompt / instructions<textarea name="intent" required rows="7" placeholder="State the objective, constraints, and expected output."></textarea></label>
    <div class="form-row"><label>Risk<select name="risk"><option>low</option><option selected>medium</option><option>high</option><option>critical</option></select></label><label>Target service<input name="service" placeholder="codex-agent, hermes, worker" /></label></div>
    <label>Requested action kind<input name="actionKind" placeholder="agent.prompt, fs.read, fs.write, shell" /></label>
    <label>Requested action description<input name="actionDescription" placeholder="Defaults to prompt dispatch when blank" /></label>
    <button type="submit">Create Work Item</button><output id="task-result"></output>
  </form>`;
}

function clientScript(): string {
  return `
let sseSource = null;
let sseReconnectAttempt = 0;
let sseReconnectTimer = null;
let sseEverOpened = false;
let sseConnected = false;
const sseEventNames = [
  'work_item.created',
  'work_item.needs_approval',
  'work_item.approved',
  'work_item.running',
  'work_item.blocked',
  'work_item.failed',
  'work_item.succeeded',
  'work_item.cancelled',
  'work_item.rejected',
  'agent.created',
  'agent.updated',
  'agent.heartbeat',
  'agent.capabilities_replaced',
  'acp.initialized',
  'acp.disconnected',
  'acp.error',
  'tunnel_session.heartbeat'
];

function nextSseReconnectDelayMs(attempt) {
  const n = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  return Math.min(30000, 1000 * Math.pow(2, Math.min(n, 5)));
}

function applySseConnectionState(root, connected) {
  sseConnected = connected;
  const banner = root.querySelector('#sse-stale-banner');
  if (banner) banner.hidden = connected;
  const live = root.querySelector('.live');
  if (live) {
    live.classList.toggle('disconnected', !connected);
    live.innerHTML = connected
      ? '<span aria-hidden="true"></span> Live'
      : '<span aria-hidden="true"></span> Disconnected';
  }
  root.querySelectorAll('[data-approve],[data-reject],[data-unblock]').forEach(function (button) {
    const approveWithoutHash = Boolean(button.dataset.approve) && !button.dataset.actionHash;
    button.disabled = !connected || approveWithoutHash;
  });
}

function connectSse() {
  if (sseReconnectTimer) {
    clearTimeout(sseReconnectTimer);
    sseReconnectTimer = null;
  }
  if (sseSource) {
    sseSource.close();
    sseSource = null;
  }
  sseSource = new EventSource('/events');
  sseSource.addEventListener('open', function () {
    const shouldRefresh = sseEverOpened && !sseConnected;
    sseReconnectAttempt = 0;
    applySseConnectionState(document, true);
    sseEverOpened = true;
    if (shouldRefresh) location.assign(location.href);
  });
  sseSource.addEventListener('error', function () {
    applySseConnectionState(document, false);
    if (sseSource) {
      sseSource.close();
      sseSource = null;
    }
    if (sseReconnectTimer) return;
    const delay = nextSseReconnectDelayMs(sseReconnectAttempt);
    sseReconnectAttempt += 1;
    sseReconnectTimer = setTimeout(function () {
      sseReconnectTimer = null;
      connectSse();
    }, delay);
  });
  sseEventNames.forEach(function (name) {
    sseSource.addEventListener(name, appendAuditEvent);
  });
}

function appendAuditEvent(event) {
  let data;
  try {
    data = JSON.parse(event.data);
  } catch {
    return;
  }
  const panel = document.querySelector('#events');
  if (!panel) return;
  panel.querySelector('.empty')?.remove();
  let list = panel.querySelector('.timeline');
  if (!list) {
    list = document.createElement('ol');
    list.className = 'timeline';
    panel.appendChild(list);
  }
  const item = document.createElement('li');
  const time = document.createElement('time');
  const name = document.createElement('strong');
  const attrs = document.createElement('small');
  const nanos = Number(data.timeUnixNano);
  time.textContent = Number.isFinite(nanos) ? new Date(Math.floor(nanos / 1000000)).toLocaleString() : '';
  name.textContent = data.name || event.type;
  attrs.textContent = JSON.stringify(data.attributes || {});
  item.append(time, name, attrs);
  list.prepend(item);
  while (list.children.length > 10) list.lastElementChild?.remove();
  const eventName = String(data.name || event.type || '');
  if (eventName.startsWith('agent.') || eventName.startsWith('acp.') || eventName === 'tunnel_session.heartbeat') {
    refreshAgentRoster();
    if (selectedAgentId) loadAgentDetail(selectedAgentId);
  }
}

let selectedAgentId = null;

function escapeClient(value) {
  return String(value ?? '').replace(/[&<>"']/g, function (char) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] || char;
  });
}

function redactClient(value) {
  return String(value ?? '')
    .replace(/Bearer\\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\\bsk-[A-Za-z0-9_-]{12,}\\b/g, '[redacted]')
    .replace(/([?&](?:token|key|secret|password)=)[^&\\s]+/gi, '$1[redacted]');
}

function formatClientTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? redactClient(value) : date.toLocaleString();
}

function pillMarkup(value) {
  const safe = escapeClient(value || 'unknown');
  return '<span class="pill ' + safe + '">' + safe + '</span>';
}

function fetchJson(url) {
  return fetch(url, { headers: { accept: 'application/json' } }).then(async function (res) {
    const body = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      throw new Error(body.error || body.code || ('HTTP ' + res.status));
    }
    return body;
  });
}

function bindWorkItems() {
  document.querySelectorAll('[data-work-item]').forEach(function (button) {
    button.addEventListener('click', async function () {
      const target = document.querySelector('#work-detail');
      if (!target) return;
      document.querySelectorAll('[data-work-item]').forEach(function (candidate) { candidate.classList.remove('selected'); candidate.removeAttribute('aria-current'); });
      button.classList.add('selected');
      button.setAttribute('aria-current', 'true');
      target.innerHTML = '<div class="detail-loading">Loading work item...</div>';
      try {
        const body = await fetchJson('/work-items/' + encodeURIComponent(button.dataset.workItem));
        renderWorkDetail(target, body.workItem, body.events || [], body.executionAttempts || [], body.attemptLeases || []);
        target.focus({ preventScroll: false });
      } catch (error) {
        target.innerHTML = '<div class="detail-error" role="alert">' + escapeClient(error.message) + '</div>';
        target.focus({ preventScroll: false });
      }
    });
  });
}

function agentRowsMarkup(agents) {
  return agents.map(function (agent) {
    const id = escapeClient(agent.id);
    const name = escapeClient(agent.displayName || agent.name || agent.id);
    return '<tr class="agent-row" tabindex="0" data-agent="' + id + '" data-agent-id="' + id + '">' +
      '<td><strong>' + name + '</strong><small>' + id + '</small></td>' +
      '<td>' + escapeClient(agent.kind || 'observed') + '</td>' +
      '<td>' + pillMarkup(agent.status || agent.effectiveStatus || 'observed') + '</td>' +
      '<td>' + pillMarkup(agent.health || 'unknown') + '</td>' +
      '<td>' + escapeClient(agent.currentTask || '—') + '</td>' +
      '<td>' + escapeClient(formatClientTime(agent.lastHeartbeatAt)) + '</td>' +
      '<td>' + escapeClient(redactClient(agent.lastError || '—')) + '</td>' +
    '</tr>';
  }).join('');
}

function renderAgentTable(agents) {
  const wrap = document.querySelector('#agents .table-wrap');
  if (!wrap) return;
  if (!agents.length) {
    wrap.innerHTML = '<p class="empty">No agents or connectors observed.</p>';
    return;
  }
  wrap.innerHTML = '<table class="agent-table"><thead><tr><th>Agent</th><th>Type</th><th>Status</th><th>Health</th><th>Current task</th><th>Heartbeat</th><th>Last error</th></tr></thead><tbody id="agent-roster-body">' + agentRowsMarkup(agents) + '</tbody></table>';
  bindAgentRows();
}

function bindAgentRows() {
  document.querySelectorAll('[data-agent]').forEach(function (row) {
    const activate = function () {
      selectedAgentId = row.dataset.agent;
      document.querySelectorAll('[data-agent]').forEach(function (candidate) { candidate.classList.remove('selected'); });
      row.classList.add('selected');
      loadAgentDetail(selectedAgentId);
    };
    row.addEventListener('click', activate);
    row.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
      }
    });
  });
}

async function refreshAgentRoster() {
  try {
    const body = await fetchJson('/agents');
    const agents = Array.isArray(body.agents) ? body.agents : [];
    const count = document.querySelector('#agent-count');
    if (count) count.textContent = agents.length + ' observed';
    renderAgentTable(agents);
    if (selectedAgentId && agents.some(function (agent) { return agent.id === selectedAgentId; })) {
      document.querySelectorAll('[data-agent]').forEach(function (row) {
        if (row.dataset.agent === selectedAgentId) row.classList.add('selected');
      });
    }
  } catch (error) {
    const detail = document.querySelector('#agent-detail');
    if (detail && !selectedAgentId) {
      detail.innerHTML = '<div class="detail-error">Agent backend unavailable: ' + escapeClient(error.message) + '</div>';
    }
  }
}

async function loadAgentDetail(id) {
  const target = document.querySelector('#agent-detail');
  if (!target || !id) return;
  target.innerHTML = '<div class="detail-loading">Loading agent detail...</div>';
  try {
    const projected = await fetchJson('/agents/' + encodeURIComponent(id) + '?limit=8');
    const registry = await fetchJson('/api/agents/' + encodeURIComponent(id) + '?limit=8').catch(function () { return null; });
    const capabilities = await fetchJson('/api/agents/' + encodeURIComponent(id) + '/capabilities').catch(function () { return null; });
    renderAgentDetail(target, {
      projected: projected.agent,
      registry: registry && registry.agent,
      adapterStatus: (registry && registry.adapterStatus) || projected.adapterStatus,
      events: (registry && registry.events && registry.events.length ? registry.events : projected.events) || [],
      capabilities: (capabilities && capabilities.capabilities) || (registry && registry.agent && registry.agent.capabilities) || []
    });
  } catch (error) {
    target.innerHTML = '<div class="detail-error">' + escapeClient(error.message) + '</div>';
  }
}

function capabilityNames(input) {
  return (Array.isArray(input) ? input : [])
    .map(function (capability) { return typeof capability === 'string' ? capability : capability && capability.name; })
    .filter(Boolean);
}

function renderAgentDetail(target, detail) {
  const agent = detail.projected || detail.registry || {};
  const registry = detail.registry || {};
  const capabilities = capabilityNames(detail.capabilities).concat(capabilityNames(agent.capabilities || []));
  const uniqueCapabilities = Array.from(new Set(capabilities)).sort();
  const adapter = detail.adapterStatus ? (detail.adapterStatus.state || detail.adapterStatus.status || 'connected') : 'not configured';
  target.innerHTML = '<div class="detail-head"><div><h3>' + escapeClient(agent.displayName || registry.name || agent.id) + '</h3><small>' + escapeClient(agent.id || registry.id || '') + '</small></div><div>' + pillMarkup(agent.status || registry.effectiveStatus || registry.status || 'observed') + ' ' + pillMarkup(agent.health || 'unknown') + '</div></div>' +
    '<dl class="detail-grid">' +
      detailRow('Type', agent.kind || registry.kind) +
      detailRow('Provider', registry.provider) +
      detailRow('Model', registry.model) +
      detailRow('Endpoint', registry.endpoint ? redactClient(registry.endpoint) : undefined) +
      detailRow('Current task', agent.currentTask) +
      detailRow('Current work item', agent.currentWorkItemId) +
      detailRow('Heartbeat', formatClientTime(agent.lastHeartbeatAt || registry.lastHeartbeatAt)) +
      detailRow('Adapter', adapter) +
    '</dl>' +
    '<div class="detail-section"><h4>Capabilities</h4>' + capabilityList(uniqueCapabilities) + '</div>' +
    '<div class="detail-section"><h4>Recent Events</h4>' + eventList(detail.events || []) + '</div>';
}

function detailRow(label, value) {
  return '<div><dt>' + escapeClient(label) + '</dt><dd>' + escapeClient(redactClient(value || '—')) + '</dd></div>';
}

function capabilityList(capabilities) {
  if (!capabilities.length) return '<p class="muted">No capabilities recorded.</p>';
  return '<div class="chip-list">' + capabilities.map(function (name) {
    return '<span class="chip">' + escapeClient(name) + '</span>';
  }).join('') + '</div>';
}

function eventList(events) {
  if (!events.length) return '<p class="muted">No matching events.</p>';
  return '<ol class="detail-events">' + events.slice(0, 8).map(function (event) {
    const attrs = event.attributes || {};
    const ref = attrs['work_item.id'] || attrs['agent.id'] || attrs['connector.id'] || '';
    return '<li><time>' + escapeClient(eventClientTime(event)) + '</time><strong>' + escapeClient(event.name || 'event') + '</strong><small>' + escapeClient(ref) + '</small></li>';
  }).join('') + '</ol>';
}

function eventClientTime(event) {
  const nanos = Number(event && event.timeUnixNano);
  return Number.isFinite(nanos) ? formatClientTime(new Date(Math.floor(nanos / 1000000)).toISOString()) : '—';
}

function shortHash(value) {
  const text = String(value || '');
  return text.length > 16 ? text.slice(0, 12) + '…' : text;
}

function renderExecutionAuthority(executionAttempts, attemptLeases) {
  const attempts = Array.isArray(executionAttempts) ? executionAttempts.slice() : [];
  const leases = Array.isArray(attemptLeases) ? attemptLeases : [];
  if (!attempts.length) {
    return '<div class="detail-section"><h4>Execution Authority</h4><p class="muted">No execution attempts recorded.</p></div>';
  }
  attempts.sort(function (left, right) { return Number(right.attemptNumber || 0) - Number(left.attemptNumber || 0); });
  return '<div class="detail-section"><h4>Execution Authority</h4><div class="execution-stack">' + attempts.map(function (attempt) {
    const matching = leases.filter(function (lease) { return lease.attemptId === attempt.attemptId; }).sort(function (left, right) { return Number(right.fencingEpoch || 0) - Number(left.fencingEpoch || 0); });
    const lease = matching[0];
    const worker = (lease && lease.workerId) || attempt.claimedByWorkerId || '—';
    const leaseMarkup = lease
      ? '<div class="lease-block"><div class="lease-head"><strong>Lease ' + escapeClient(lease.leaseId) + '</strong>' + pillMarkup(lease.status || 'unknown') + '</div><dl class="detail-grid compact">' +
          detailRow('Worker', worker) +
          detailRow('Fencing epoch', String(lease.fencingEpoch ?? attempt.currentFencingEpoch ?? 0)) +
          detailRow('Admission', lease.admissionId) +
          detailRow('Approval', lease.approvalId || 'not required / not bound') +
          detailRow('Policy', lease.policyVersion) +
          detailRow('Policy decision', shortHash(lease.policyDecisionHash)) +
          detailRow('Issued', formatClientTime(lease.issuedAt)) +
          detailRow('Expires', formatClientTime(lease.expiresAt)) +
          detailRow('Last renewed', formatClientTime(lease.lastRenewedAt)) +
          detailRow('Max expiry', formatClientTime(lease.maxExpiresAt)) +
        '</dl></div>'
      : '<p class="muted">No lease recorded for this attempt.</p>';
    return '<article class="execution-card"><div class="execution-head"><div><strong>Attempt #' + escapeClient(attempt.attemptNumber) + '</strong><small>' + escapeClient(attempt.attemptId) + '</small></div>' + pillMarkup(attempt.status || 'unknown') + '</div><dl class="detail-grid compact">' +
      detailRow('Worker', worker) +
      detailRow('Fencing epoch', String(attempt.currentFencingEpoch ?? 0)) +
      detailRow('Plan', attempt.planId) +
      detailRow('Plan hash', shortHash(attempt.planHash)) +
      detailRow('Input hash', shortHash(attempt.inputHash)) +
      detailRow('Protocol', attempt.protocolVersion) +
      detailRow('Started', formatClientTime(attempt.startedAt)) +
      detailRow('Updated', formatClientTime(attempt.updatedAt)) +
    '</dl>' + leaseMarkup + '</article>';
  }).join('') + '</div></div>';
}

function renderWorkDetail(target, workItem, events, executionAttempts, attemptLeases) {
  if (!workItem) {
    target.innerHTML = '<div class="detail-error">Work item not found.</div>';
    return;
  }
  const actions = Array.isArray(workItem.requestedActions) ? workItem.requestedActions : [];
  target.setAttribute('aria-labelledby', 'work-detail-title');
  target.innerHTML = '<div class="detail-head"><div><h3 id="work-detail-title">' + escapeClient(workItem.title) + '</h3><small>' + escapeClient(workItem.id) + '</small></div><div>' + pillMarkup(workItem.status) + ' ' + pillMarkup(workItem.risk) + '</div></div>' +
    '<dl class="detail-grid">' +
      detailRow('Requester', workItem.requester) +
      detailRow('Intent', workItem.intent) +
      detailRow('Target', workItem.target ? JSON.stringify(workItem.target) : '—') +
      detailRow('Created', formatClientTime(workItem.createdAt)) +
    '</dl>' +
    '<div class="detail-section"><h4>Requested Actions</h4>' + (actions.length ? '<ul class="action-list">' + actions.map(function (action) { return '<li><strong>' + escapeClient(action.kind) + '</strong><small>' + escapeClient(action.description) + '</small></li>'; }).join('') + '</ul>' : '<p class="muted">No requested actions.</p>') + '</div>' +
    renderExecutionAuthority(executionAttempts, attemptLeases) +
    '<div class="detail-section"><h4>Timeline</h4>' + eventList(events || []) + '</div>';
}

function knownQueueStatuses() {
  return new Set(['draft', 'pending_policy', 'needs_approval', 'approved', 'running', 'cancelling', 'succeeded', 'failed', 'blocked', 'cancelled', 'rejected', 'unknown', 'quarantined']);
}

function readQueueFilterFromDom() {
  const statuses = [];
  document.querySelectorAll('[data-queue-status]').forEach(function (input) {
    if (input.checked) statuses.push(input.getAttribute('data-queue-status') || input.value || '');
  });
  const agentInput = document.querySelector('#queue-filter-agent');
  const textInput = document.querySelector('#queue-filter-text');
  return {
    statuses: statuses.filter(Boolean),
    agentId: agentInput ? String(agentInput.value || '').trim() : '',
    text: textInput ? String(textInput.value || '').trim() : ''
  };
}

function parseQueueFilterFromLocation() {
  const params = new URLSearchParams(location.search || '');
  if (![...params.keys()].some(function (key) { return key === 'status' || key === 'q' || key === 'text' || key === 'agent'; })) {
    const hash = String(location.hash || '').replace(/^#/, '');
    const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1)
      : hash.includes('=') ? hash.replace(/^[A-Za-z0-9_-]+&/, '')
      : '';
    if (query) {
      const hashParams = new URLSearchParams(query);
      hashParams.forEach(function (value, key) { params.append(key, value); });
    }
  }
  const statuses = [];
  params.getAll('status').forEach(function (entry) {
    String(entry).split(',').forEach(function (part) {
      const status = part.trim();
      if (status) statuses.push(status);
    });
  });
  return {
    statuses: statuses,
    agentId: String(params.get('agent') || '').trim(),
    text: String(params.get('q') || params.get('text') || '').trim()
  };
}

function writeQueueFilterToLocation(filter) {
  const url = new URL(location.href);
  url.searchParams.delete('status');
  url.searchParams.delete('q');
  url.searchParams.delete('text');
  url.searchParams.delete('agent');
  filter.statuses.forEach(function (status) {
    if (status) url.searchParams.append('status', status);
  });
  if (filter.agentId) url.searchParams.set('agent', filter.agentId);
  if (filter.text) url.searchParams.set('q', filter.text);
  history.replaceState(null, '', url.pathname + url.search + url.hash);
}

function syncQueueFilterControls(filter) {
  const selected = new Set(filter.statuses);
  document.querySelectorAll('[data-queue-status]').forEach(function (input) {
    const status = input.getAttribute('data-queue-status') || input.value || '';
    input.checked = selected.has(status);
  });
  const agentInput = document.querySelector('#queue-filter-agent');
  const textInput = document.querySelector('#queue-filter-text');
  if (agentInput) agentInput.value = filter.agentId || '';
  if (textInput) textInput.value = filter.text || '';
}

function applyQueueFilterClient(filter) {
  const known = knownQueueStatuses();
  const knownStatuses = filter.statuses.filter(function (status) { return known.has(status); });
  const text = String(filter.text || '').trim().toLowerCase();
  const agent = String(filter.agentId || '').trim().toLowerCase();
  const buttons = Array.from(document.querySelectorAll('[data-work-item]'));
  let visible = 0;
  buttons.forEach(function (el) {
    const id = el.getAttribute('data-work-item') || '';
    const title = el.getAttribute('data-title') || '';
    const status = el.getAttribute('data-status') || '';
    const agentId = (el.getAttribute('data-agent-id') || '').toLowerCase();
    let show = true;
    if (knownStatuses.length && knownStatuses.indexOf(status) === -1) show = false;
    if (show && text) {
      const hay = (title + ' ' + id).toLowerCase();
      if (hay.indexOf(text) === -1) show = false;
    }
    if (show && agent && agentId.indexOf(agent) === -1) show = false;
    el.hidden = !show;
    el.classList.toggle('queue-item-filtered-out', !show);
    if (show) visible += 1;
  });
  const effectivelyEmpty = !knownStatuses.length && !text && !agent;
  const count = document.querySelector('#queue-filter-count');
  if (count) count.textContent = effectivelyEmpty ? (buttons.length + ' items') : (visible + ' of ' + buttons.length + ' items');
  const live = document.querySelector('#queue-filter-live');
  if (live) {
    live.textContent = effectivelyEmpty
      ? ('Showing all ' + buttons.length + ' work items')
      : ('Showing ' + visible + ' of ' + buttons.length + ' work items');
  }
  return visible;
}

function bindQueueFilter() {
  if (!document.querySelector('#queue-filter')) return;
  const initial = parseQueueFilterFromLocation();
  syncQueueFilterControls(initial);
  applyQueueFilterClient(initial);
  const applyFromDom = function () {
    const filter = readQueueFilterFromDom();
    writeQueueFilterToLocation(filter);
    applyQueueFilterClient(filter);
  };
  document.querySelectorAll('[data-queue-status]').forEach(function (input) {
    input.addEventListener('change', applyFromDom);
  });
  const agentInput = document.querySelector('#queue-filter-agent');
  const textInput = document.querySelector('#queue-filter-text');
  if (agentInput) agentInput.addEventListener('input', applyFromDom);
  if (textInput) textInput.addEventListener('input', applyFromDom);
  window.addEventListener('popstate', function () {
    const filter = parseQueueFilterFromLocation();
    syncQueueFilterControls(filter);
    applyQueueFilterClient(filter);
  });
}

bindQueueFilter();
bindWorkItems();
bindAgentRows();
refreshAgentRoster();
connectSse();

function isElevatedApprovalRisk(risk) {
  const normalized = String(risk || '').trim().toLowerCase();
  return normalized === 'high' || normalized === 'critical';
}

function approvalActionHashPrefix(hash, maxLen) {
  const text = String(hash || '');
  const limit = typeof maxLen === 'number' ? maxLen : 12;
  if (!text) return '';
  return text.length > limit ? text.slice(0, limit) + '\u2026' : text;
}

function escapeClientHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, function (char) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] || char;
  });
}

function requestApprovalConfirm(request) {
  return new Promise(function (resolve) {
    const existing = document.getElementById('approval-confirm-dialog');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'approval-confirm-dialog';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'approval-confirm-title');
    overlay.className = 'approval-confirm-overlay';
    const actionLabel = request.action === 'approve' ? 'Approve' : 'Deny';
    const hashPrefix = approvalActionHashPrefix(request.actionHash || '');
    const hashLine = hashPrefix
      ? '<p class="approval-confirm-hash">Action hash: <code>' + escapeClientHtml(hashPrefix) + '</code></p>'
      : '';
    overlay.innerHTML = '<div class="approval-confirm-card">' +
      '<h3 id="approval-confirm-title">' + escapeClientHtml(actionLabel) + ' high-risk work item?</h3>' +
      '<p class="approval-confirm-id">Work item: <code>' + escapeClientHtml(request.workItemId) + '</code></p>' +
      '<p class="approval-confirm-risk">Risk: <strong>' + escapeClientHtml(request.risk) + '</strong></p>' +
      hashLine +
      '<div class="approval-confirm-actions">' +
        '<button type="button" id="approval-confirm-cancel" data-approval-confirm-cancel>Cancel</button>' +
        '<button type="button" id="approval-confirm-ok" data-approval-confirm-ok>' + escapeClientHtml(actionLabel) + '</button>' +
      '</div></div>';
    function finish(confirmed) {
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
      resolve(confirmed);
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    }
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKeyDown);
    const cancelBtn = overlay.querySelector('#approval-confirm-cancel');
    const okBtn = overlay.querySelector('#approval-confirm-ok');
    cancelBtn?.addEventListener('click', function () { finish(false); });
    okBtn?.addEventListener('click', function () { finish(true); });
    cancelBtn?.focus();
  });
}

document.querySelectorAll('[data-approve],[data-reject],[data-unblock]').forEach((button) => {
  button.addEventListener('click', async () => {
    const id = button.dataset.approve || button.dataset.reject || button.dataset.unblock;
    const action = button.dataset.approve ? 'approve' : button.dataset.reject ? 'reject' : 'unblock';
    const risk = button.dataset.risk || '';
    if (!sseConnected) {
      const output = document.querySelector('#approval-result-' + id);
      if (output) output.textContent = 'Disconnected: actions disabled until reconnect';
      return;
    }
    const reasonInput = document.querySelector('[data-reason="' + id + '"]');
    const reason = reasonInput ? reasonInput.value.trim() : '';
    const output = document.querySelector('#approval-result-' + id);
    if (action !== 'unblock' && !reason) {
      output.textContent = 'Reason required';
      if (reasonInput) reasonInput.focus();
      return;
    }
    if ((action === 'approve' || action === 'reject') && isElevatedApprovalRisk(risk)) {
      if (document.getElementById('approval-confirm-dialog')) {
        return;
      }
      const confirmed = await requestApprovalConfirm({
        workItemId: id,
        action: action,
        actionHash: button.dataset.actionHash,
        risk: risk
      });
      if (!confirmed) return;
    }
    const headers = { 'content-type': 'application/json' };
    const payload = action === 'unblock' ? {} : { reason };
    if (action === 'approve') {
      if (!button.dataset.actionHash) {
        output.textContent = 'Approval action hash unavailable';
        return;
      }
      payload.actionHash = button.dataset.actionHash;
    }
    const res = await fetch('/work-items/' + id + '/' + action, { method: 'POST', headers, body: JSON.stringify(payload) });
    const body = await res.json();
    output.textContent = res.ok ? action + ' accepted' : 'Rejected: ' + (body.error || body.code || res.status);
    if (res.ok) setTimeout(() => location.assign(location.href), 500);
  });
});


document.querySelector('#task-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const actionKind = String(form.get('actionKind') || '').trim();
  const actionDescription = String(form.get('actionDescription') || '').trim();
  const service = String(form.get('service') || '').trim();
  const payload = {
    title: String(form.get('title') || ''),
    intent: String(form.get('intent') || ''),
    risk: String(form.get('risk') || 'medium'),
    target: service ? { services: [service] } : {},
    requestedActions: [{
      kind: actionKind || 'agent.prompt',
      description: actionDescription || 'Dispatch prompt to selected agent',
      params: {}
    }]
  };
  const headers = { 'content-type': 'application/json' };
  const res = await fetch('/work-items', { method: 'POST', headers, body: JSON.stringify(payload) });
  const body = await res.json();
  document.querySelector('#task-result').textContent = res.ok ? 'Created ' + body.id : 'Rejected: ' + (body.error || res.status);
  if (res.ok) setTimeout(() => location.assign(location.href), 500);
});

const viewAliases = {
  overview: 'overview',
  queue: 'queue',
  execution: 'execution',
  approvals: 'approvals',
  agents: 'agents',
  connectors: 'connectors',
  'operator-metrics': 'metrics',
  metrics: 'metrics',
  events: 'audit',
  audit: 'audit',
  policy: 'policy',
  system: 'system',
  dispatch: 'overview'
};
function showView(name) {
  const view = viewAliases[name] || 'overview';
  document.body.dataset.activeView = view;
  document.querySelectorAll('nav a[data-nav]').forEach((link) => {
    link.classList.toggle('active', link.dataset.nav === view);
  });
}
document.querySelector('aside nav')?.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-nav]');
  if (!link) return;
  event.preventDefault();
  showView(link.dataset.nav);
  const href = link.getAttribute('href') || '#overview';
  history.replaceState(null, '', href);
});
showView((location.hash || '#overview').replace('#', ''));
async function probePath(path) {
  const started = performance.now();
  try {
    const res = await fetch(path, { headers: { accept: 'application/json' } });
    return { path, status: res.status, ms: Math.round(performance.now() - started) };
  } catch {
    return { path, status: 0, ms: Math.round(performance.now() - started) };
  }
}
const probeRoot = document.querySelector('#system-probes');
if (probeRoot) {
  Promise.all(['/livez', '/readyz', '/health'].map(probePath)).then((rows) => {
    probeRoot.replaceChildren();
    const list = document.createElement('dl');
    for (const row of rows) {
      const item = document.createElement('div');
      const term = document.createElement('dt');
      const value = document.createElement('dd');
      term.textContent = row.path;
      value.textContent = (row.status || 'down') + ' · ' + row.ms + 'ms';
      item.append(term, value);
      list.append(item);
    }
    probeRoot.append(list);
  });
}`;
}

function pill(value: string): string {
  return `<span class="pill ${escapeHtml(value)}">${escapeHtml(value)}</span>`;
}

function time(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? escapeHtml(value) : date.toLocaleString();
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

function styles(): string {
  return `
:root {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  background: #0e1116;
  color: #e8edf4;
  --bg: #0e1116;
  --surface: #171b22;
  --surface-2: #1e242e;
  --ink: #e8edf4;
  --muted: #8b97a8;
  --line: #2a3342;
  --side: #10141a;
  --side-muted: #8b97a8;
  --accent: #3b82f6;
  --green: #3ddc97;
  --amber: #f5b942;
  --red: #ff6b6b;
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: var(--bg); display: grid; grid-template-columns: 216px minmax(0, 1fr); }
aside { border-right: 1px solid #252a30; padding: 22px 16px; background: var(--side); position: sticky; top: 0; height: 100vh; }
.brand { color: #f8fafc; font-size: 20px; font-weight: 800; }
.brand span { display: block; color: var(--side-muted); font-size: 11px; margin-top: 4px; font-weight: 700; }
nav { display: grid; gap: 4px; margin-top: 30px; }
nav a { color: #c1c8d0; text-decoration: none; padding: 10px 12px; border-radius: 8px; }
nav a.active, nav a:hover { background: #27313b; color: #ffffff; }
.rail-note { color: var(--side-muted); font-size: 12px; line-height: 1.45; position: absolute; bottom: 24px; left: 16px; right: 16px; }
main { padding: 22px 24px 40px; min-width: 0; }
header { display: flex; justify-content: space-between; align-items: start; gap: 16px; margin-bottom: 18px; }
h1 { margin: 0; font-size: 26px; color: var(--ink); }
p { color: var(--muted); margin: 6px 0 0; }
.live { border: 1px solid var(--line); border-radius: 999px; padding: 8px 12px; color: var(--muted); background: var(--surface); white-space: nowrap; }
.live span { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--green); margin-right: 8px; }
.live.disconnected span { background: var(--red); }
.stale-banner { margin-bottom: 14px; padding: 10px 14px; border: 1px solid #f1d18a; background: #fff8e6; color: var(--amber); border-radius: 8px; font-weight: 600; }
.stale-banner[hidden] { display: none; }
.cards { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin-bottom: 14px; }
.card, .panel { border: 1px solid var(--line); background: var(--surface); border-radius: 8px; box-shadow: 0 10px 24px rgba(23, 32, 42, .06); }
.card { padding: 15px; min-height: 108px; }
.card span, .panel-head span { color: var(--muted); font-size: 12px; text-transform: uppercase; }
.card strong { display: block; font-size: 30px; margin-top: 10px; color: var(--ink); }
.card p { font-size: 12px; line-height: 1.35; }
.grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(320px, .85fr); gap: 14px; margin-bottom: 14px; }
.lower { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.panel { min-width: 0; overflow: hidden; }
.panel-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--line); background: #fbfcfd; }
.panel-head p { font-size: 12px; margin-top: 3px; }
h2 { margin: 0; font-size: 16px; color: var(--ink); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 11px 12px; border-bottom: 1px solid #edf1f5; vertical-align: top; font-size: 13px; }
th { color: var(--muted); font-size: 11px; text-transform: uppercase; background: #fbfcfd; position: sticky; top: 0; z-index: 1; }
td small { display: block; color: var(--muted); margin-top: 2px; }
.table-wrap { overflow: auto; max-height: 430px; }
.agent-row { cursor: pointer; }
.agent-row:hover, .agent-row.selected { background: #eef4ff; }
.empty { padding: 18px; color: var(--muted); }
.pill { display: inline-flex; align-items: center; border-radius: 999px; padding: 2px 8px; font-size: 11px; background: #eef2f6; color: #45515f; border: 1px solid #d7dfe8; white-space: nowrap; }
.online, .healthy, .succeeded, .approved, .low { color: var(--green); border-color: #a8d8bd; background: #eef9f2; }
.stale, .warning, .needs_approval, .medium, .blocked, .quarantined { color: var(--amber); border-color: #f1d18a; background: #fff8e6; }
.offline, .unhealthy, .failed, .critical, .high, .cancelled, .rejected { color: var(--red); border-color: #f0b8b2; background: #fff1ef; }
.queue-item.attention { border-left: 3px solid var(--red); background: #fff8f7; }
.attention-badge { color: var(--red); font-weight: 700; margin-left: 6px; font-size: 11px; }
.plan-status, .execution-status { display: block; margin-top: 4px; }
.plan-pending { color: var(--amber); }
.plan-admitted { color: var(--green); }
.execution-status { color: #43536a !important; }
.queue-filter { padding: 12px 14px; border-bottom: 1px solid var(--line); background: #fbfcfd; display: grid; gap: 10px; }
.queue-filter-row { display: grid; gap: 8px; }
.queue-filter-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.queue-filter-statuses { margin: 0; padding: 0; border: 0; }
.queue-filter-statuses legend { color: var(--muted); font-size: 11px; text-transform: uppercase; margin-bottom: 6px; }
.queue-filter-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.queue-filter-chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid #ccd6e2; background: #ffffff; border-radius: 999px; padding: 4px 10px; font-size: 12px; color: #344256; cursor: pointer; }
.queue-filter-chip:has(input:checked) { border-color: #9db7d7; background: #eef4ff; color: var(--accent); }
.queue-filter-chip input { width: auto; margin: 0; accent-color: var(--accent); }
.queue-filter-field { display: grid; gap: 5px; color: var(--muted); font-size: 12px; }
.queue-filter-live { margin: 0; color: var(--muted); font-size: 12px; }
.queue-item-filtered-out, .queue-item[hidden] { display: none !important; }
.queue { display: grid; }
.queue-item { text-align: left; background: transparent; color: var(--ink); border: 0; border-bottom: 1px solid #edf1f5; padding: 12px 14px; cursor: pointer; }
.queue-item:hover, .queue-item.selected { background: #f4f8ff; }
.queue-item.selected { box-shadow: inset 3px 0 0 var(--accent); }
.approval-item > button { text-align: left; background: transparent; color: inherit; border: 0; cursor: pointer; }
.approval-actions { display: flex; gap: 8px; }
.approval-actions button { border: 1px solid #cbd5e1; background: #ffffff; color: var(--ink); border-radius: 8px; padding: 8px 10px; cursor: pointer; }
.approval-actions button:hover { background: #f4f8ff; border-color: #9db7d7; }
.approval-actions button:last-child { color: var(--red); border-color: #f0b8b2; }
.system-panel { padding: 18px; display: grid; grid-template-columns: 130px 1fr; gap: 16px; align-items: start; }
.system-panel strong { font-size: 44px; color: var(--green); }
.system-panel span { color: var(--muted); margin-top: 52px; margin-left: -130px; }
.system-panel dl { margin: 0; display: grid; gap: 8px; }
.system-panel div { display: flex; justify-content: space-between; gap: 14px; border-bottom: 1px solid #edf1f5; padding-bottom: 7px; }
.system-panel dt { color: var(--muted); }
.system-panel dd { margin: 0; color: var(--ink); }
.operator-metrics { padding: 18px; display: grid; gap: 14px; }
.operator-metrics dl { margin: 0; display: grid; gap: 8px; }
.operator-metrics div { display: flex; justify-content: space-between; gap: 14px; border-bottom: 1px solid #edf1f5; padding-bottom: 7px; }
.operator-metrics dt { color: var(--muted); }
.operator-metrics dd { margin: 0; color: var(--ink); font-variant-numeric: tabular-nums; }
.metrics-scrape { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.45; }
.metrics-scrape code { font-size: 12px; }
.queue-item strong, .queue-item small { display: block; margin-top: 6px; }
.queue-item small { color: var(--muted); }
.error-line { color: var(--red) !important; }
.approvals-grid { grid-template-columns: 1fr; }
.approval-controls { padding: 14px; border-bottom: 1px solid var(--line); }
.approvals-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; padding: 14px; }
.approval-item { border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2); padding: 12px; display: grid; gap: 9px; }
.approval-item strong, .approval-item small { display: block; }
.agent-layout { display: grid; }
.detail-panel { margin: 12px; padding: 14px; max-height: 360px; overflow: auto; background: #fbfcfd; border: 1px solid var(--line); border-radius: 8px; color: var(--ink); }
.detail-empty, .detail-loading, .detail-error { color: var(--muted); }
.detail-error { color: var(--red); }
.detail-head { display: flex; justify-content: space-between; gap: 12px; align-items: start; border-bottom: 1px solid #e6ecf2; padding-bottom: 12px; margin-bottom: 12px; }
.detail-head h3 { margin: 0; font-size: 16px; }
.detail-head small { color: var(--muted); }
.detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px 14px; margin: 0; }
.detail-grid.compact { margin-top: 10px; }
.detail-grid div { min-width: 0; }
.detail-grid dt { color: var(--muted); font-size: 11px; text-transform: uppercase; }
.detail-grid dd { margin: 2px 0 0; overflow-wrap: anywhere; }
.detail-section { margin-top: 14px; }
.detail-section h4 { margin: 0 0 8px; font-size: 13px; color: var(--ink); }
.execution-stack { display: grid; gap: 10px; }
.execution-card { border: 1px solid #dbe4ee; background: #ffffff; border-radius: 8px; padding: 10px; }
.execution-head, .lease-head { display: flex; justify-content: space-between; align-items: start; gap: 10px; }
.execution-head small { display: block; color: var(--muted); margin-top: 2px; }
.lease-block { border-top: 1px solid #e6ecf2; margin-top: 10px; padding-top: 10px; }
.lease-head strong { font-size: 12px; }
.chip-list { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { border: 1px solid #ccd6e2; background: #ffffff; border-radius: 999px; padding: 4px 8px; font-size: 12px; color: #344256; }
.detail-events { list-style: none; display: grid; gap: 8px; margin: 0; padding: 0; }
.detail-events li { border-left: 2px solid var(--accent); padding-left: 10px; }
.detail-events time, .detail-events small { display: block; color: var(--muted); font-size: 11px; }
.action-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.action-list li { border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px; background: #ffffff; }
.action-list small { display: block; color: var(--muted); margin-top: 2px; }
.muted { color: var(--muted); font-size: 13px; }
form { display: grid; gap: 11px; padding: 14px; }
label { display: grid; gap: 5px; color: var(--muted); font-size: 12px; }
input, textarea, select { width: 100%; background: #ffffff; color: var(--ink); border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px; }
.form-row { display: grid; grid-template-columns: 160px 1fr; gap: 10px; }
button[type=submit] { background: #2563eb; color: white; border: 0; border-radius: 9px; padding: 11px 14px; font-weight: 700; cursor: pointer; }
output { color: var(--accent); min-height: 20px; }
.timeline { list-style: none; margin: 0; padding: 10px 14px 14px; display: grid; gap: 10px; }
.timeline li { border-left: 2px solid #2563eb; padding-left: 10px; }
.timeline time, .timeline small { display: block; color: var(--muted); font-size: 11px; word-break: break-word; }
.skip-link { position: absolute; left: -9999px; top: 0; z-index: 1000; background: #2563eb; color: #fff; padding: 10px 14px; border-radius: 8px; font-weight: 700; }
.skip-link:focus { left: 12px; top: 12px; }
:focus { outline: none; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.approval-actions button:focus-visible, .queue-item:focus-visible, nav a:focus-visible, button[type=submit]:focus-visible, .agent-row:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.reason-field { display: grid; gap: 5px; }
.reason-label { color: var(--muted); font-size: 12px; }
.reason-label .req { color: var(--red); font-weight: 600; }
.approval-result { display: block; min-height: 1.25em; }
.approval-actions button:disabled { opacity: .55; cursor: not-allowed; }
.approval-confirm-overlay { position: fixed; inset: 0; z-index: 2000; background: rgba(17, 20, 23, .45); display: grid; place-items: center; padding: 16px; }
.approval-confirm-card { width: min(420px, 100%); background: #ffffff; border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 18px 40px rgba(23, 32, 42, .22); padding: 18px; display: grid; gap: 10px; color: var(--ink); }
.approval-confirm-card h3 { margin: 0; font-size: 16px; }
.approval-confirm-card p { margin: 0; color: var(--muted); font-size: 13px; }
.approval-confirm-card code { color: var(--ink); font-size: 12px; }
.approval-confirm-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 6px; }
.approval-confirm-actions button { border: 1px solid #cbd5e1; background: #ffffff; color: var(--ink); border-radius: 8px; padding: 8px 12px; cursor: pointer; min-height: 40px; }
.approval-confirm-actions button:hover { background: #f4f8ff; border-color: #9db7d7; }
#approval-confirm-ok { background: #fff1ef; color: var(--red); border-color: #f0b8b2; font-weight: 700; }
#approval-confirm-cancel:focus-visible, #approval-confirm-ok:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (min-width: 1520px) { .agent-layout { grid-template-columns: minmax(720px, 1fr) 380px; } .agent-detail { margin-left: 0; max-height: 430px; } }
@media (max-width: 1180px) { body { grid-template-columns: 1fr; } aside { position: static; height: auto; } .cards, .grid, .lower { grid-template-columns: 1fr; } .rail-note { position: static; } }
@media (max-width: 767px) {
  body { grid-template-columns: 1fr; }
  aside { position: static; height: auto; padding: 12px 14px; }
  nav { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 14px; }
  nav a { padding: 8px 10px; font-size: 13px; }
  .rail-note { display: none; }
  main { padding: 14px 12px 28px; }
  header { display: grid; gap: 10px; }
  .cards { grid-template-columns: 1fr; }
  .grid, .lower, .detail-grid, .form-row, .system-panel { grid-template-columns: 1fr; }
  .system-panel span { margin: 0; }
  .approvals-list { grid-template-columns: 1fr; padding: 12px; }
  .approval-actions { flex-direction: column; }
  .approval-actions button { width: 100%; min-height: 44px; font-size: 15px; }
  .table-wrap { max-height: none; }
  .agent-table th:nth-child(n+5), .agent-table td:nth-child(n+5) { display: none; }
  .queue-filter-fields { grid-template-columns: 1fr; }
  .queue-filter-chip { min-height: 44px; }
  .queue-item { padding: 14px 12px; min-height: 44px; }
  .detail-panel { margin: 8px; max-height: none; }
  .live { justify-self: start; }
}
body[data-active-view] [data-view-panel] { display: none; }
body[data-active-view="overview"] [data-view-panel~="overview"],
body[data-active-view="queue"] [data-view-panel~="queue"],
body[data-active-view="execution"] [data-view-panel~="execution"],
body[data-active-view="approvals"] [data-view-panel~="approvals"],
body[data-active-view="agents"] [data-view-panel~="agents"],
body[data-active-view="connectors"] [data-view-panel~="connectors"],
body[data-active-view="metrics"] [data-view-panel~="metrics"],
body[data-active-view="audit"] [data-view-panel~="audit"],
body[data-active-view="policy"] [data-view-panel~="policy"],
body[data-active-view="system"] [data-view-panel~="system"] { display: block; }
.panel-head, th, .queue-filter, .detail-panel, .execution-card, .approval-item, .approval-actions button, .queue-filter-chip, input, textarea, select, .approval-confirm-card, .chip, .action-list li { background: var(--surface); color: var(--ink); border-color: var(--line); }
.stale-banner { background: #2a2416; color: var(--amber); border-color: #6b5420; }
.agent-row:hover, .agent-row.selected, .queue-item:hover, .queue-item.selected { background: #243044; }
.queue-item.attention { background: #2a1c1c; }
nav a.active, nav a:hover { background: #243044; color: #ffffff; }
.system-probes { padding: 0 18px 16px; }
.system-probes dl { margin: 0; display: grid; gap: 8px; }
.system-probes div { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
.system-probes dt { color: var(--muted); }
.system-probes dd { margin: 0; }
`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return escapes[char] ?? char;
  });
}
