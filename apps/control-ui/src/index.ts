import type { RegistryAgentDetail, StoredAuditEvent, WorkItem } from "@agent-control-stack/work-items";

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
  now?: Date;
}

export function renderDashboard(input: WorkItem[] | MissionControlViewModel): string {
  const model = Array.isArray(input) ? { workItems: input, events: [] } : input;
  const events = model.events ?? [];
  const agents = model.agents ?? projectAgents(model.workItems, events, model.now ?? new Date(), model.registeredAgents ?? []);
  const stats = summarize(model.workItems, agents);
  const approvalItems = model.workItems.filter((item) => item.status === "needs_approval" || item.status === "blocked");
  const recentEvents = [...events].slice(-10).reverse();

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AgentOS Mission Control</title>
    <style>${styles()}</style>
  </head>
  <body>
    <aside>
      <div class="brand">AgentOS<span>MISSION CONTROL</span></div>
      <nav>
        <a href="#overview" class="active">Overview</a>
        <a href="#agents">Agents</a>
        <a href="#queue">Work Queue</a>
        <a href="#approvals">Approvals</a>
        <a href="#dispatch">New Task</a>
        <a href="#events">Events</a>
      </nav>
      <p class="rail-note">Local-first control plane. No fake green lights, because apparently standards are still allowed.</p>
    </aside>
    <main>
      <header>
        <div><h1>Mission Control</h1><p>Unified operator cockpit for agents, work items, approvals, and audit events.</p></div>
        <div class="live"><span></span> SSE ready</div>
      </header>
      <section id="overview" class="cards">${overviewCards(stats)}</section>
      <section class="grid">
        <article id="agents" class="panel wide"><div class="panel-head"><h2>Agent Roster</h2><span>${agents.length} observed</span></div>${agentTable(agents)}<pre id="agent-detail" class="detail">Select an agent for capabilities, endpoint metadata, recent events, and whatever else reality left behind.</pre></article>
        <article id="queue" class="panel"><div class="panel-head"><h2>Work Queue</h2><span>${model.workItems.length} items</span></div>${workQueue(model.workItems)}</article>
      </section>
      <section class="grid approvals-grid">
        <article id="approvals" class="panel wide"><div class="panel-head"><h2>Approvals</h2><span>${approvalItems.length} waiting</span></div>${approvalsPanel(approvalItems)}</article>
      </section>
      <section class="grid lower">
        <article id="events" class="panel"><div class="panel-head"><h2>Recent Events</h2><span>append-only</span></div>${eventTimeline(recentEvents)}</article>
        <article id="system" class="panel"><div class="panel-head"><h2>System Health</h2><span>derived</span></div>${systemPanel(stats, agents)}</article>
      </section>
      <section class="grid lower">
        <article id="dispatch" class="panel composer"><div class="panel-head"><h2>New Task Composer</h2><span>authenticated session</span></div>${composer()}</article>
        <article class="panel"><div class="panel-head"><h2>Safety Notes</h2><span>fail closed</span></div><p class="empty">Approval and cancellation actions call authenticated backend routes and append audit events. No approve-all button, because one intact guardrail will not end civilization.</p></article>
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
    status = heartbeatAgeMs <= 120_000 ? "online" : heartbeatAgeMs <= 900_000 ? "stale" : "offline";
    health = status === "online" ? "healthy" : status === "stale" ? "warning" : health === "unhealthy" ? "unhealthy" : "unknown";
  } else if (status !== "offline" && eventAgeMs > 900_000) {
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
    ["Failed / Blocked", stats.failed, "Things that need attention, humanity's favorite subscription"]
  ];
  return cards.map(([label, value, help]) => `<article class="card"><span>${label}</span><strong>${value}</strong><p>${help}</p></article>`).join("");
}

function agentTable(agents: MissionControlAgent[]): string {
  if (!agents.length) return `<p class="empty">No agents or connectors observed yet. This panel stays empty instead of lying to you.</p>`;
  return `<table><thead><tr><th>Agent</th><th>Type</th><th>Status</th><th>Health</th><th>Current task</th><th>Heartbeat</th><th>Last error</th></tr></thead><tbody>${agents
    .map(
      (agent) => `<tr data-agent="${escapeHtml(agent.id)}"><td><strong>${escapeHtml(agent.displayName)}</strong><small>${escapeHtml(agent.id)}</small></td><td>${escapeHtml(agent.kind)}</td><td>${pill(agent.status)}</td><td>${pill(agent.health)}</td><td>${agent.currentTask ? escapeHtml(agent.currentTask) : "—"}</td><td>${agent.lastHeartbeatAt ? time(agent.lastHeartbeatAt) : "—"}</td><td>${agent.lastError ? escapeHtml(agent.lastError) : "—"}</td></tr>`
    )
    .join("")}</tbody></table>`;
}

function workQueue(workItems: WorkItem[]): string {
  if (!workItems.length) return `<p class="empty">No work items. Peace, briefly.</p>`;
  return `<div class="queue">${workItems
    .slice(0, 12)
    .map(
      (item) => `<button class="queue-item" data-work-item="${escapeHtml(item.id)}"><span>${pill(item.status)} ${pill(item.risk)}</span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.intent)}</small>${workItemError(item)}</button>`
    )
    .join("")}</div><pre id="work-detail" class="detail">Select a work item for its persisted timeline.</pre>`;
}

function approvalsPanel(items: WorkItem[]): string {
  if (!items.length) return `<p class="empty">No approvals or blocked work. Suspiciously civilized.</p>`;
  return `<div class="approvals-list">${items
    .map((item) => {
      const actions = item.requestedActions.map((action) => action.kind).join(", ") || "none";
      const error = workItemResultError(item);
      const reason = `<input data-reason="${escapeHtml(item.id)}" required placeholder="Reason required" />`;
      const outcome = `<output id="approval-result-${escapeHtml(item.id)}"></output>`;
      if (item.status === "blocked") {
        return `<article class="approval-item"><span>${pill(item.status)} ${pill(item.risk)}</span><strong>${escapeHtml(item.title)}</strong><small>Actions: ${escapeHtml(actions)}</small>${error ? `<small class="error-line">${escapeHtml(error)}</small>` : ""}${reason}<div class="approval-actions"><button type="button" data-unblock="${escapeHtml(item.id)}">Unblock</button><button type="button" data-reject="${escapeHtml(item.id)}">Reject</button></div>${outcome}</article>`;
      }
      return `<article class="approval-item"><span>${pill(item.status)} ${pill(item.risk)}</span><strong>${escapeHtml(item.title)}</strong><small>Requester: ${escapeHtml(item.requester)} · Actions: ${escapeHtml(actions)}</small>${reason}<div class="approval-actions"><button type="button" data-approve="${escapeHtml(item.id)}">Approve</button><button type="button" data-reject="${escapeHtml(item.id)}">Reject</button></div>${outcome}</article>`;
    })
    .join("")}</div>`;
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
  return `<div class="system-panel"><strong>${score}</strong><span>${escapeHtml(label)}</span><dl><div><dt>Agents online</dt><dd>${stats.onlineAgents} / ${stats.totalAgents}</dd></div><div><dt>Running tasks</dt><dd>${stats.running}</dd></div><div><dt>Pending approvals</dt><dd>${stats.approvals}</dd></div><div><dt>Failed or blocked</dt><dd>${stats.failed}</dd></div></dl></div>`;
}

function eventTimeline(events: StoredAuditEvent[]): string {
  if (!events.length) return `<p class="empty">No audit events recorded.</p>`;
  return `<ol class="timeline">${events
    .map((event) => `<li><time>${time(nanoToIso(event.timeUnixNano))}</time><strong>${escapeHtml(event.name)}</strong><small>${escapeHtml(JSON.stringify(event.attributes))}</small></li>`)
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
const source = new EventSource('/events');
source.addEventListener('work_item.created', () => location.reload());
source.addEventListener('work_item.needs_approval', () => location.reload());
source.addEventListener('work_item.approved', () => location.reload());
source.addEventListener('work_item.running', () => location.reload());
source.addEventListener('work_item.blocked', () => location.reload());
source.addEventListener('work_item.failed', () => location.reload());
source.addEventListener('work_item.succeeded', () => location.reload());
source.addEventListener('work_item.cancelled', () => location.reload());
source.addEventListener('agent.created', () => location.reload());
source.addEventListener('agent.updated', () => location.reload());
source.addEventListener('agent.heartbeat', () => location.reload());
source.addEventListener('agent.capabilities_replaced', () => location.reload());
source.addEventListener('acp.initialized', () => location.reload());
source.addEventListener('acp.disconnected', () => location.reload());
source.addEventListener('acp.error', () => location.reload());
source.addEventListener('tunnel_session.heartbeat', () => location.reload());

document.querySelectorAll('[data-work-item]').forEach((button) => {
  button.addEventListener('click', async () => {
    const target = document.querySelector('#work-detail');
    target.textContent = 'Loading persisted timeline...';
    const res = await fetch('/work-items/' + button.dataset.workItem);
    target.textContent = JSON.stringify(await res.json(), null, 2);
  });
});

document.querySelectorAll('[data-agent]').forEach((row) => {
  row.addEventListener('click', async () => {
    const target = document.querySelector('#agent-detail');
    target.textContent = 'Loading persisted agent detail...';
    const res = await fetch('/agents/' + encodeURIComponent(row.dataset.agent));
    target.textContent = JSON.stringify(await res.json(), null, 2);
  });
});

document.querySelectorAll('[data-approve],[data-reject],[data-unblock]').forEach((button) => {
  button.addEventListener('click', async () => {
    const id = button.dataset.approve || button.dataset.reject || button.dataset.unblock;
    const action = button.dataset.approve ? 'approve' : button.dataset.reject ? 'cancel' : 'unblock';
    const reasonInput = document.querySelector('[data-reason="' + id + '"]');
    const reason = reasonInput ? reasonInput.value.trim() : '';
    const output = document.querySelector('#approval-result-' + id);
    if (action !== 'unblock' && !reason) {
      output.textContent = 'Reason required';
      return;
    }
    const headers = { 'content-type': 'application/json' };
    const payload = action === 'unblock' ? {} : { reason };
    const res = await fetch('/work-items/' + id + '/' + action, { method: 'POST', headers, body: JSON.stringify(payload) });
    const body = await res.json();
    output.textContent = res.ok ? action + ' accepted' : 'Rejected: ' + JSON.stringify(body);
    if (res.ok) setTimeout(() => location.reload(), 500);
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
  if (res.ok) setTimeout(() => location.reload(), 500);
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
:root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #071019; color: #d7e0ea; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 20% 0%, #12243a 0, #071019 35%, #05090f 100%); display: grid; grid-template-columns: 230px 1fr; }
aside { border-right: 1px solid #1b2a3b; padding: 22px 16px; background: rgba(5, 10, 17, 0.82); position: sticky; top: 0; height: 100vh; }
.brand { color: #67e8f9; font-size: 22px; font-weight: 800; letter-spacing: .02em; }
.brand span { display: block; color: #8ea3b8; font-size: 11px; margin-top: 4px; }
nav { display: grid; gap: 6px; margin-top: 30px; }
nav a { color: #a8b3c2; text-decoration: none; padding: 10px 12px; border-radius: 9px; }
nav a.active, nav a:hover { background: #0f2945; color: #dbeafe; }
.rail-note { color: #6b7f94; font-size: 12px; position: absolute; bottom: 24px; left: 16px; right: 16px; }
main { padding: 22px 24px 40px; min-width: 0; }
header { display: flex; justify-content: space-between; align-items: start; margin-bottom: 18px; }
h1 { margin: 0; font-size: 26px; }
p { color: #8ea3b8; margin: 6px 0 0; }
.live { border: 1px solid #18324d; border-radius: 999px; padding: 8px 12px; color: #9fb4c9; background: #0a1522; }
.live span { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #34d399; margin-right: 8px; }
.cards { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin-bottom: 14px; }
.card, .panel { border: 1px solid #17283a; background: rgba(10, 21, 34, 0.88); border-radius: 12px; box-shadow: 0 14px 40px rgba(0,0,0,.24); }
.card { padding: 16px; min-height: 112px; }
.card span, .panel-head span { color: #8aa0b8; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
.card strong { display: block; font-size: 32px; margin-top: 10px; color: #f8fafc; }
.card p { font-size: 12px; line-height: 1.35; }
.grid { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(360px, .8fr); gap: 14px; margin-bottom: 14px; }
.lower { grid-template-columns: minmax(440px, .9fr) minmax(0, 1.1fr); }
.panel { min-width: 0; overflow: hidden; }
.panel-head { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; border-bottom: 1px solid #17283a; }
h2 { margin: 0; font-size: 16px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 11px 12px; border-bottom: 1px solid #122234; vertical-align: top; font-size: 13px; }
th { color: #7f94aa; font-size: 11px; text-transform: uppercase; }
td small { display: block; color: #70859c; margin-top: 2px; }
.empty { padding: 18px; color: #8aa0b8; }
.pill { display: inline-flex; align-items: center; border-radius: 999px; padding: 2px 8px; font-size: 11px; background: #152235; color: #cbd5e1; border: 1px solid #20344d; }
.online, .healthy, .succeeded, .approved, .low { color: #86efac; border-color: #14532d; background: #062315; }
.stale, .warning, .needs_approval, .medium, .blocked { color: #facc15; border-color: #713f12; background: #281b06; }
.offline, .unhealthy, .failed, .critical, .high, .cancelled { color: #fca5a5; border-color: #7f1d1d; background: #2b0b0b; }
.queue { display: grid; }
.queue-item { text-align: left; background: transparent; color: #d7e0ea; border: 0; border-bottom: 1px solid #122234; padding: 12px 14px; cursor: pointer; }
.queue-item:hover { background: #0d1c2c; }
.approval-item { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: center; }
.approval-item > button { text-align: left; background: transparent; color: inherit; border: 0; cursor: pointer; }
.approval-actions { display: flex; gap: 8px; }
.approval-actions button { border: 1px solid #1c3148; background: #07111d; color: #dbeafe; border-radius: 8px; padding: 8px 10px; cursor: pointer; }
.approval-actions button:last-child { color: #fca5a5; border-color: #7f1d1d; }
.system-panel { padding: 18px; display: grid; grid-template-columns: 130px 1fr; gap: 16px; align-items: start; }
.system-panel strong { font-size: 44px; color: #86efac; }
.system-panel span { color: #8ea3b8; margin-top: 52px; margin-left: -130px; }
.system-panel dl { margin: 0; display: grid; gap: 8px; }
.system-panel div { display: flex; justify-content: space-between; gap: 14px; border-bottom: 1px solid #122234; padding-bottom: 7px; }
.system-panel dt { color: #8ea3b8; }
.system-panel dd { margin: 0; color: #d7e0ea; }
.queue-item strong, .queue-item small { display: block; margin-top: 6px; }
.queue-item small { color: #8398ae; }
.error-line { color: #fca5a5 !important; }
.approvals-grid { grid-template-columns: 1fr; }
.approval-controls { padding: 14px; border-bottom: 1px solid #122234; }
.approvals-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; padding: 14px; }
.approval-item { border: 1px solid #1b3148; border-radius: 10px; background: #07111d; padding: 12px; display: grid; gap: 9px; }
.approval-item strong, .approval-item small { display: block; }
.approval-actions { display: flex; gap: 8px; }
.approval-actions button { background: #10233a; color: #dbeafe; border: 1px solid #264463; border-radius: 8px; padding: 8px 10px; cursor: pointer; }
.detail { margin: 12px; padding: 12px; max-height: 260px; overflow: auto; background: #050b12; border: 1px solid #122234; border-radius: 10px; color: #a7f3d0; }
form { display: grid; gap: 11px; padding: 14px; }
label { display: grid; gap: 5px; color: #91a6bd; font-size: 12px; }
input, textarea, select { width: 100%; background: #07111d; color: #dbeafe; border: 1px solid #1c3148; border-radius: 8px; padding: 10px; }
.form-row { display: grid; grid-template-columns: 160px 1fr; gap: 10px; }
button[type=submit] { background: #2563eb; color: white; border: 0; border-radius: 9px; padding: 11px 14px; font-weight: 700; cursor: pointer; }
output { color: #93c5fd; min-height: 20px; }
.timeline { list-style: none; margin: 0; padding: 10px 14px 14px; display: grid; gap: 10px; }
.timeline li { border-left: 2px solid #2563eb; padding-left: 10px; }
.timeline time, .timeline small { display: block; color: #7890a8; font-size: 11px; word-break: break-word; }
@media (max-width: 1180px) { body { grid-template-columns: 1fr; } aside { position: static; height: auto; } .cards, .grid, .lower { grid-template-columns: 1fr; } .rail-note { position: static; } }
`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return escapes[char] ?? char;
  });
}
