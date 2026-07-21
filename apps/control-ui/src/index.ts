import {
  DEFAULT_HEARTBEAT_ONLINE_WINDOW_MS,
  DEFAULT_HEARTBEAT_TTL_MS,
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

export interface MissionControlViewModel {
  workItems: WorkItem[];
  events: StoredAuditEvent[];
  registeredAgents?: RegistryAgentDetail[];
  agents?: MissionControlAgent[];
  approvalActionHashesByWorkItem?: Record<string, ApprovalAction[]>;
  workItemsNextCursor?: { createdAt: string; id: string };
  now?: Date;
}

export interface ApprovalAction {
  hash: string;
  kind: string;
  description: string;
}

export function renderDashboard(input: WorkItem[] | MissionControlViewModel): string {
  const model = Array.isArray(input) ? { workItems: input, events: [] } : input;
  const events = model.events ?? [];
  const agents = model.agents ?? projectAgents(model.workItems, events, model.now ?? new Date(), model.registeredAgents ?? []);
  const stats = summarize(model.workItems, agents);
  const approvalItems = model.workItems.filter((item) => item.status === "needs_approval" || item.status === "blocked");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ACS Mission Control</title>
    <style>${styles()}</style>
  </head>
  <body>
    <aside>
      <div class="brand">ACS<span>MISSION CONTROL</span></div>
      <nav>
        <a href="#overview" class="active">Overview</a>
        <a href="#agents">Agents</a>
        <a href="#queue">Work Queue</a>
        <a href="#approvals">Approvals</a>
        <a href="#dispatch">New Task</a>
        <a href="#events">Events</a>
      </nav>
      <p class="rail-note">Local-first control plane. Live state comes from the registry, work-item store, and audit stream.</p>
    </aside>
    <main>
      <header>
        <div><h1>Mission Control</h1><p>Agents, work items, approvals, and audit events.</p></div>
        <div id="sse-status" class="live" data-sse-state="connecting"><span></span><span id="sse-label">Connecting…</span></div>
      </header>
      <section id="overview" class="cards">${overviewCards(stats)}</section>
      <section class="grid">
        <article id="agents" class="panel wide roster-panel"><div class="panel-head"><div><h2>Agent Roster</h2><p>Persisted registry + audit projection</p></div><span id="agent-count">${agents.length} observed</span></div><div class="agent-layout">${agentTable(agents)}${agentDetailPanel()}</div></article>
        <article id="queue" class="panel queue-panel"><div class="panel-head"><h2>Work Queue</h2><span id="work-item-count">${model.workItems.length}${model.workItemsNextCursor ? "+" : ""} loaded</span></div>${workQueue(model.workItems, model.workItemsNextCursor)}</article>
      </section>
      <section class="grid approvals-grid">
        <article id="approvals" class="panel wide"><div class="panel-head"><h2>Approvals</h2><span>${approvalItems.length} waiting</span></div>${approvalsPanel(approvalItems, model.approvalActionHashesByWorkItem ?? {})}</article>
      </section>
      <section class="grid lower">
        <article id="events" class="panel"><div class="panel-head"><h2>Recent Events</h2><span>append-only</span></div>${eventTimeline(events)}</article>
        <article id="system" class="panel"><div class="panel-head"><h2>System Health</h2><span>projection</span></div>${systemPanel(stats, agents)}</article>
      </section>
      <section class="grid lower">
        <article id="dispatch" class="panel composer"><div class="panel-head"><h2>New Task Composer</h2><span>authenticated session</span></div>${composer()}</article>
        <article class="panel"><div class="panel-head"><h2>Safety Notes</h2><span>fail closed</span></div><p class="empty">Approval and cancellation actions use authenticated backend routes and append audit events. Bulk approval is not exposed.</p></article>
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
    agents.set(id, { ...current, ...patch, capabilities, metadata: { ...current.metadata, ...(patch.metadata ?? {}) } });
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
    const ids = [attrs["worker.id"], attrs["connector.id"], attrs["auth.connector_id"], body.connectorId, body.workerId]
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    for (const id of ids) {
      touch(id, eventPatch(id, event, body));
    }
  }

  return [...agents.values()]
    .map((agent) => finalizeAgent(agent, now))
    .sort((left, right) => statusRank(left.status) - statusRank(right.status) || left.displayName.localeCompare(right.displayName));
}function eventPatch(id: string, event: StoredAuditEvent, body: Record<string, unknown>): Partial<MissionControlAgent> {
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
  const heartbeatAgeMs = agent.lastHeartbeatAt ? now.getTime() - Date.parse(agent.lastHeartbeatAt) : Number.POSITIVE_INFINITY;
  const eventAgeMs = agent.lastEventAt ? now.getTime() - Date.parse(agent.lastEventAt) : Number.POSITIVE_INFINITY;
  let status = agent.status;
  let health = agent.health;
  if (agent.lastHeartbeatAt) {
    status = heartbeatAgeMs <= DEFAULT_HEARTBEAT_ONLINE_WINDOW_MS
      ? "online"
      : heartbeatAgeMs <= DEFAULT_HEARTBEAT_TTL_MS
        ? "stale"
        : "offline";
    health = status === "online" ? "healthy" : status === "stale" ? "warning" : health === "unhealthy" ? "unhealthy" : "unknown";
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
  return cards.map(([label, value, help]) => `<article class="card"><span>${label}</span><strong>${value}</strong><p>${help}</p></article>`).join("");
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
  return `<section id="agent-detail" class="detail-panel agent-detail" aria-live="polite">
    <div class="detail-empty"><h3>No agent selected</h3><p>Backend detail pending.</p></div>
  </section>`;
}

function workQueue(workItems: WorkItem[], nextCursor?: { createdAt: string; id: string }): string {
  if (!workItems.length) return `<p class="empty">No work items.</p>`;
  return `<div class="queue">${workItems
    .slice(0, 12)
    .map(queueItem)
    .join("")}</div>${nextCursor ? `<button id="load-more-work-items" type="button" data-after-created-at="${escapeHtml(nextCursor.createdAt)}" data-after-id="${escapeHtml(nextCursor.id)}">Load more work items</button>` : ""}<section id="work-detail" class="detail-panel work-detail" aria-live="polite"><div class="detail-empty"><h3>No work item selected</h3><p>Timeline pending.</p></div></section>`;
}

function queueItem(item: WorkItem): string {
  return `<button class="queue-item" data-work-item="${escapeHtml(item.id)}"><span>${pill(item.status)} ${pill(item.risk)}</span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.intent)}</small>${workItemError(item)}</button>`;
}

function approvalsPanel(items: WorkItem[], approvalActionHashesByWorkItem: Record<string, ApprovalAction[]>): string {
  if (!items.length) return `<p class="empty">No approvals or blocked work.</p>`;
  return `<div class="approvals-list">${items
    .map((item) => {
      const actions = item.requestedActions.map((action) => action.kind).join(", ") || "none";
      const error = workItemResultError(item);
      const reason = `<input data-reason="${escapeHtml(item.id)}" required placeholder="Reason required" />`;
      const outcome = `<output id="approval-result-${escapeHtml(item.id)}"></output>`;
      const approvalButtons = approvalButtonsFor(item, approvalActionHashesByWorkItem[item.id] ?? []);
      if (item.status === "blocked") {
        return `<article class="approval-item"><span>${pill(item.status)} ${pill(item.risk)}</span><strong>${escapeHtml(item.title)}</strong><small>Actions: ${escapeHtml(actions)}</small>${error ? `<small class="error-line">${escapeHtml(error)}</small>` : ""}${reason}<div class="approval-actions"><button type="button" data-unblock="${escapeHtml(item.id)}">Unblock</button><button type="button" data-reject="${escapeHtml(item.id)}">Reject</button></div>${outcome}</article>`;
      }
      return `<article class="approval-item"><span>${pill(item.status)} ${pill(item.risk)}</span><strong>${escapeHtml(item.title)}</strong><small>Requester: ${escapeHtml(item.requester)} · Actions: ${escapeHtml(actions)}</small>${reason}<div class="approval-actions">${approvalButtons}<button type="button" data-reject="${escapeHtml(item.id)}">Reject</button></div>${outcome}</article>`;
    })
    .join("")}</div>`;
}

function approvalButtonsFor(item: WorkItem, actions: ApprovalAction[]): string {
  if (!actions.length) {
    return `<button type="button" data-approve="${escapeHtml(item.id)}" disabled>Approval hash unavailable</button>`;
  }
  return actions
    .map(
      (action) => `<div class="approval-action"><small><strong>${escapeHtml(action.kind)}:</strong> ${escapeHtml(action.description)}</small><code>${escapeHtml(action.hash)}</code><button type="button" data-approve="${escapeHtml(item.id)}" data-action-hash="${escapeHtml(action.hash)}">Approve action</button></div>`
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

function systemPanel(stats: ReturnType<typeof summarize>, agents: MissionControlAgent[]): string {
  const unhealthy = agents.filter((agent) => agent.health === "unhealthy" || agent.status === "offline").length + stats.failed;
  const warning = agents.filter((agent) => agent.health === "warning" || agent.status === "stale").length + stats.approvals;
  const score = Math.max(0, 100 - unhealthy * 18 - warning * 6);
  const label = score >= 90 ? "Healthy" : score >= 70 ? "Degraded" : "Unhealthy";
  return `<div class="system-panel"><div id="readiness-status" data-readyz="unknown" role="status">Readiness: checking…</div><strong>${score}</strong><span>${escapeHtml(label)} projection</span><dl><div><dt>Agents online</dt><dd>${stats.onlineAgents} / ${stats.totalAgents}</dd></div><div><dt>Running tasks</dt><dd>${stats.running}</dd></div><div><dt>Pending approvals</dt><dd>${stats.approvals}</dd></div><div><dt>Failed or blocked</dt><dd>${stats.failed}</dd></div></dl></div>`;
}

function eventTimeline(events: StoredAuditEvent[]): string {
  if (!events.length) return `<p class="empty">No audit events recorded.</p>`;
  const visible = [...events].slice(-10).reverse();
  const beforeSequence = visible[visible.length - 1]?.sequence;
  return `<div id="event-history"><ol id="event-timeline" class="timeline">${visible
    .map((event) => `<li><time>${time(nanoToIso(event.timeUnixNano))}</time><strong>${escapeHtml(event.name)}</strong><small>${escapeHtml(JSON.stringify(event.attributes))}</small></li>`)
    .join("")}</ol>${events.length > visible.length && beforeSequence !== undefined ? `<button id="load-older-events" type="button" data-before-sequence="${beforeSequence}">Load older events</button>` : ""}</div>`;
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
const source = new EventSource('/events');
const sseStatus = document.querySelector('#sse-status');
const sseLabel = document.querySelector('#sse-label');

function setSseState(state, label) {
  if (sseStatus) sseStatus.dataset.sseState = state;
  if (sseLabel) sseLabel.textContent = label;
}

source.onopen = function () { setSseState('connected', 'SSE connected'); };
source.onerror = function () {
  setSseState(source.readyState === EventSource.CLOSED ? 'disconnected' : 'retrying', source.readyState === EventSource.CLOSED ? 'SSE disconnected' : 'SSE disconnected; retrying');
};
[
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
].forEach((name) => source.addEventListener(name, appendAuditEvent));

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
  attrs.textContent = redactClient(JSON.stringify(data.attributes || {}));
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

function requestJson(url, options) {
  const requestOptions = Object.assign({ headers: { accept: 'application/json' } }, options || {});
  requestOptions.headers = Object.assign({ accept: 'application/json' }, requestOptions.headers || {});
  return fetch(url, requestOptions).then(async function (res) {
    const text = await res.text();
    const contentType = res.headers.get('content-type') || '';
    const looksJson = /^[{[]/.test(text.trim());
    let body = {};
    if (text.trim() && (contentType.includes('json') || looksJson)) {
      try { body = JSON.parse(text); } catch { body = {}; }
    }
    if (!res.ok) {
      const error = new Error((body && (body.error || body.code)) || (text.trim() ? text.trim().slice(0, 200) : ('HTTP ' + res.status)));
      error.status = res.status;
      error.body = body;
      throw error;
    }
    if (text.trim() && !contentType.includes('json') && !looksJson) {
      throw new Error('Expected JSON response');
    }
    return body;
  });
}

function fetchJson(url) {
  return requestJson(url);
}

function setReadiness(state, label) {
  const target = document.querySelector('#readiness-status');
  if (!target) return;
  target.dataset.readyz = state;
  target.textContent = 'Readiness: ' + label;
}

async function refreshReadiness() {
  try {
    await fetchJson('/readyz');
    setReadiness('healthy', 'healthy');
  } catch (error) {
    setReadiness('unhealthy', 'unhealthy — ' + error.message);
  }
}

function bindWorkItems() {
  document.querySelectorAll('[data-work-item]').forEach(function (button) {
    if (button.dataset.bound === 'true') return;
    button.dataset.bound = 'true';
    button.addEventListener('click', async function () {
      const target = document.querySelector('#work-detail');
      if (!target) return;
      target.innerHTML = '<div class="detail-loading">Loading work item...</div>';
      try {
        const body = await fetchJson('/work-items/' + encodeURIComponent(button.dataset.workItem));
        renderWorkDetail(target, body.workItem, body.events || []);
      } catch (error) {
        target.innerHTML = '<div class="detail-error">' + escapeClient(error.message) + '</div>';
      }
    });
  });
}

function queueItemMarkup(item) {
  const resultError = item.result && typeof item.result.error === 'string' ? '<small class="error-line">' + escapeClient(redactClient(item.result.error)) + '</small>' : '';
  return '<button class="queue-item" data-work-item="' + escapeClient(item.id) + '"><span>' + pillMarkup(item.status) + ' ' + pillMarkup(item.risk) + '</span><strong>' + escapeClient(item.title) + '</strong><small>' + escapeClient(item.intent) + '</small>' + resultError + '</button>';
}

function loadMoreWorkButton(cursor) {
  if (!cursor) return null;
  const button = document.createElement('button');
  button.id = 'load-more-work-items';
  button.type = 'button';
  button.textContent = 'Load more work items';
  button.dataset.afterCreatedAt = cursor.createdAt;
  button.dataset.afterId = cursor.id;
  button.addEventListener('click', loadMoreWorkItems);
  return button;
}

async function loadMoreWorkItems() {
  const button = document.querySelector('#load-more-work-items');
  const queue = document.querySelector('#queue .queue');
  if (!button || !queue) return;
  button.disabled = true;
  try {
    const url = '/work-items?limit=50&afterCreatedAt=' + encodeURIComponent(button.dataset.afterCreatedAt || '') + '&afterId=' + encodeURIComponent(button.dataset.afterId || '');
    const body = await fetchJson(url);
    const items = Array.isArray(body.workItems) ? body.workItems : [];
    items.slice(0, 12).forEach(function (item) { queue.insertAdjacentHTML('beforeend', queueItemMarkup(item)); });
    button.remove();
    const next = loadMoreWorkButton(body.nextCursor);
    const detail = document.querySelector('#work-detail');
    if (next && detail) detail.parentElement.insertBefore(next, detail);
    const count = document.querySelector('#work-item-count');
    if (count) count.textContent = (document.querySelectorAll('#queue .queue-item').length) + (body.nextCursor ? '+' : '') + ' loaded';
    bindWorkItems();
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Load more failed: ' + error.message;
  }
}

function eventMarkup(event) {
  const item = document.createElement('li');
  const eventTime = document.createElement('time');
  const name = document.createElement('strong');
  const attrs = document.createElement('small');
  const nanos = Number(event && event.timeUnixNano);
  eventTime.textContent = Number.isFinite(nanos) ? new Date(Math.floor(nanos / 1000000)).toLocaleString() : '';
  name.textContent = event && event.name ? event.name : 'event';
  attrs.textContent = redactClient(JSON.stringify((event && event.attributes) || {}));
  item.append(eventTime, name, attrs);
  return item;
}

function bindOlderEvents() {
  const button = document.querySelector('#load-older-events');
  if (!button || button.dataset.bound === 'true') return;
  button.dataset.bound = 'true';
  button.addEventListener('click', async function () {
    button.disabled = true;
    try {
      const body = await fetchJson('/api/events?limit=50&beforeSequence=' + encodeURIComponent(button.dataset.beforeSequence || ''));
      const list = document.querySelector('#event-timeline');
      const events = Array.isArray(body.events) ? body.events : [];
      if (list) events.slice().reverse().forEach(function (event) { list.appendChild(eventMarkup(event)); });
      if (body.previousCursor !== undefined && body.previousCursor !== null) {
        button.disabled = false;
        button.dataset.beforeSequence = body.previousCursor;
      } else {
        button.remove();
      }
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Load older failed: ' + error.message;
    }
  });
}

async function refreshWorkQueue() {
  const body = await fetchJson('/work-items?limit=50');
  const queuePanel = document.querySelector('#queue');
  if (!queuePanel) return;
  let queue = queuePanel.querySelector('.queue');
  if (!queue) {
    queue = document.createElement('div');
    queue.className = 'queue';
    queuePanel.querySelector('.empty')?.replaceWith(queue);
    if (!queuePanel.querySelector('#work-detail')) {
      const detail = document.createElement('section');
      detail.id = 'work-detail';
      detail.className = 'detail-panel work-detail';
      detail.setAttribute('aria-live', 'polite');
      detail.innerHTML = '<div class="detail-empty"><h3>No work item selected</h3><p>Timeline pending.</p></div>';
      queuePanel.appendChild(detail);
    }
  }
  const items = Array.isArray(body.workItems) ? body.workItems : [];
  queue.innerHTML = items.slice(0, 12).map(queueItemMarkup).join('');
  document.querySelector('#load-more-work-items')?.remove();
  const next = loadMoreWorkButton(body.nextCursor);
  const detail = document.querySelector('#work-detail');
  if (next && detail) detail.parentElement.insertBefore(next, detail);
  const count = document.querySelector('#work-item-count');
  if (count) count.textContent = items.length + (body.nextCursor ? '+' : '') + ' loaded';
  bindWorkItems();
}

async function refreshEventHistory() {
  const body = await fetchJson('/api/events?limit=100');
  const eventPanel = document.querySelector('#events');
  if (!eventPanel) return;
  let history = eventPanel.querySelector('#event-history');
  if (!history) {
    history = document.createElement('div');
    history.id = 'event-history';
    eventPanel.querySelector('.empty')?.replaceWith(history);
  }
  const events = Array.isArray(body.events) ? body.events : [];
  const visible = events.slice(-10).reverse();
  const list = document.createElement('ol');
  list.id = 'event-timeline';
  list.className = 'timeline';
  visible.forEach(function (event) { list.appendChild(eventMarkup(event)); });
  history.replaceChildren(list);
  if (events.length > visible.length) {
    const older = document.createElement('button');
    older.id = 'load-older-events';
    older.type = 'button';
    older.dataset.beforeSequence = visible[visible.length - 1]?.sequence;
    older.textContent = 'Load older events';
    history.appendChild(older);
  }
  bindOlderEvents();
}

function removeApprovalCard(id) {
  document.querySelector('#approvals [data-approve="' + id + '"], #approvals [data-reject="' + id + '"], #approvals [data-unblock="' + id + '"]')?.closest('.approval-item')?.remove();
  const count = document.querySelector('#approvals .panel-head span');
  if (count) count.textContent = document.querySelectorAll('#approvals .approval-item').length + ' waiting';
}

async function refreshDashboardState() {
  await Promise.allSettled([refreshWorkQueue(), refreshEventHistory(), refreshAgentRoster(), refreshReadiness()]);
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

function renderWorkDetail(target, workItem, events) {
  if (!workItem) {
    target.innerHTML = '<div class="detail-error">Work item not found.</div>';
    return;
  }
  const actions = Array.isArray(workItem.requestedActions) ? workItem.requestedActions : [];
  target.innerHTML = '<div class="detail-head"><div><h3>' + escapeClient(workItem.title) + '</h3><small>' + escapeClient(workItem.id) + '</small></div><div>' + pillMarkup(workItem.status) + ' ' + pillMarkup(workItem.risk) + '</div></div>' +
    '<dl class="detail-grid">' +
      detailRow('Requester', workItem.requester) +
      detailRow('Intent', workItem.intent) +
      detailRow('Target', workItem.target ? JSON.stringify(workItem.target) : '—') +
      detailRow('Created', formatClientTime(workItem.createdAt)) +
    '</dl>' +
    '<div class="detail-section"><h4>Requested Actions</h4>' + (actions.length ? '<ul class="action-list">' + actions.map(function (action) { return '<li><strong>' + escapeClient(action.kind) + '</strong><small>' + escapeClient(action.description) + '</small></li>'; }).join('') + '</ul>' : '<p class="muted">No requested actions.</p>') + '</div>' +
    '<div class="detail-section"><h4>Timeline</h4>' + eventList(events || []) + '</div>';
}

bindWorkItems();
bindAgentRows();
document.querySelector('#load-more-work-items')?.addEventListener('click', loadMoreWorkItems);
bindOlderEvents();
refreshAgentRoster();
refreshReadiness();

document.querySelectorAll('[data-approve],[data-reject],[data-unblock]').forEach((button) => {
  button.addEventListener('click', async () => {
    const id = button.dataset.approve || button.dataset.reject || button.dataset.unblock;
    const action = button.dataset.approve ? 'approve' : button.dataset.reject ? 'reject' : 'unblock';
    const reasonInput = document.querySelector('[data-reason="' + id + '"]');
    const reason = reasonInput ? reasonInput.value.trim() : '';
    const output = document.querySelector('#approval-result-' + id);
    if (action !== 'unblock' && !reason) {
      output.textContent = 'Reason required';
      return;
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
    try {
      await requestJson('/work-items/' + id + '/' + action, { method: 'POST', headers, body: JSON.stringify(payload) });
      output.textContent = action + ' accepted';
      removeApprovalCard(id);
      await refreshDashboardState();
    } catch (error) {
      output.textContent = 'Rejected: ' + error.message;
    }
  });
});


document.querySelector('#task-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
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
  const result = document.querySelector('#task-result');
  try {
    const body = await requestJson('/work-items', { method: 'POST', headers, body: JSON.stringify(payload) });
    result.textContent = 'Created ' + body.id;
    formElement.reset();
    await refreshDashboardState();
  } catch (error) {
    result.textContent = 'Rejected: ' + error.message;
  }
});`;
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
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  background: #f4f6f8;
  color: #17202a;
  --bg: #f4f6f8;
  --surface: #ffffff;
  --surface-2: #f9fafb;
  --ink: #17202a;
  --muted: #657386;
  --line: #d8e0e8;
  --side: #111417;
  --side-muted: #9aa5b1;
  --accent: #2563eb;
  --green: #0f7a45;
  --amber: #9a6700;
  --red: #b42318;
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
.live[data-sse-state="retrying"] { color: var(--amber); }
.live[data-sse-state="disconnected"] { color: var(--red); }
.cards { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin-bottom: 14px; }
.card, .panel { border: 1px solid var(--line); background: var(--surface); border-radius: 8px; box-shadow: 0 10px 24px rgba(23, 32, 42, .06); }
.card { padding: 15px; min-height: 108px; }
.card span, .panel-head span { color: var(--muted); font-size: 12px; text-transform: uppercase; }
.card strong { display: block; font-size: 30px; margin-top: 10px; color: var(--ink); }
.card p { font-size: 12px; line-height: 1.35; }
.grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(320px, .85fr); gap: 14px; margin-bottom: 14px; }
.lower { grid-template-columns: minmax(380px, .9fr) minmax(0, 1.1fr); }
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
.stale, .warning, .needs_approval, .medium, .blocked { color: var(--amber); border-color: #f1d18a; background: #fff8e6; }
.offline, .unhealthy, .failed, .critical, .high, .cancelled, .rejected { color: var(--red); border-color: #f0b8b2; background: #fff1ef; }
.queue { display: grid; }
.queue-item { text-align: left; background: transparent; color: var(--ink); border: 0; border-bottom: 1px solid #edf1f5; padding: 12px 14px; cursor: pointer; }
.queue-item:hover { background: #f4f8ff; }
.approval-item > button { text-align: left; background: transparent; color: inherit; border: 0; cursor: pointer; }
.approval-actions { display: flex; gap: 8px; }
.approval-actions button { border: 1px solid #cbd5e1; background: #ffffff; color: var(--ink); border-radius: 8px; padding: 8px 10px; cursor: pointer; }
.approval-actions button:hover { background: #f4f8ff; border-color: #9db7d7; }
.approval-actions button:last-child { color: var(--red); border-color: #f0b8b2; }
.approval-action { border: 1px solid var(--line); border-radius: 7px; padding: 8px; display: grid; gap: 5px; }
.approval-action code { color: var(--muted); font-size: 10px; overflow-wrap: anywhere; }
.approval-action button { justify-self: start; }
.system-panel { padding: 18px; display: grid; grid-template-columns: 130px 1fr; gap: 16px; align-items: start; }
.system-panel #readiness-status { grid-column: 1 / -1; border: 1px solid var(--line); border-radius: 7px; padding: 8px 10px; color: var(--muted); font-size: 12px; }
.system-panel #readiness-status[data-readyz="healthy"] { color: var(--green); border-color: #a8dfc0; }
.system-panel #readiness-status[data-readyz="unhealthy"] { color: var(--red); border-color: #f0b8b2; }
.system-panel strong { font-size: 44px; color: var(--green); }
.system-panel span { color: var(--muted); margin-top: 52px; margin-left: -130px; }
.system-panel dl { margin: 0; display: grid; gap: 8px; }
.system-panel div { display: flex; justify-content: space-between; gap: 14px; border-bottom: 1px solid #edf1f5; padding-bottom: 7px; }
.system-panel dt { color: var(--muted); }
.system-panel dd { margin: 0; color: var(--ink); }
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
.detail-grid div { min-width: 0; }
.detail-grid dt { color: var(--muted); font-size: 11px; text-transform: uppercase; }
.detail-grid dd { margin: 2px 0 0; overflow-wrap: anywhere; }
.detail-section { margin-top: 14px; }
.detail-section h4 { margin: 0 0 8px; font-size: 13px; color: var(--ink); }
.chip-list { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { border: 1px solid #ccd6e2; background: #ffffff; border-radius: 999px; padding: 4px 8px; font-size: 12px; color: #344256; }
.detail-events { list-style: none; display: grid; gap: 8px; margin: 0; padding: 0; }
.detail-events li { border-left: 2px solid var(--accent); padding-left: 10px; }
.detail-events time, .detail-events small { display: block; color: var(--muted); font-size: 11px; }
#load-more-work-items, #load-older-events { margin: 0 14px 14px; border: 1px solid var(--line); background: var(--surface-2); color: var(--ink); border-radius: 7px; padding: 8px 10px; cursor: pointer; }
#load-more-work-items:hover, #load-older-events:hover { border-color: var(--accent); }
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
@media (min-width: 1520px) { .agent-layout { grid-template-columns: minmax(720px, 1fr) 380px; } .agent-detail { margin-left: 0; max-height: 430px; } }
@media (max-width: 1180px) { body { grid-template-columns: 1fr; } aside { position: static; height: auto; } .cards, .grid, .lower { grid-template-columns: 1fr; } .rail-note { position: static; } }
@media (max-width: 760px) { main { padding: 16px; } header { display: grid; } .cards { grid-template-columns: 1fr 1fr; } .detail-grid, .form-row { grid-template-columns: 1fr; } }
`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return escapes[char] ?? char;
  });
}
