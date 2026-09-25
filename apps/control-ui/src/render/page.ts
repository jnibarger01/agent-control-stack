import { type WorkItem } from "@agent-control-stack/work-items";
import { clientScript } from "../client-script.js";
import { composerHtml } from "../composer.js";
import { escapeHtml } from "../html.js";
import { styles } from "../styles.js";
import { ADMIN_MODE_BANNER_TEXT, type MissionControlViewModel } from "../types.js";
import { themeBootScript } from "../visibility.js";
import { dashboardAgents, dashboardModel, renderDashboardFragments } from "./fragments.js";
import { agentDetailPanel, agentTable, queueFilterStrip, workDetailPanel } from "./panels.js";

export function renderDashboard(input: WorkItem[] | MissionControlViewModel): string {
  const model = dashboardModel(input);
  const events = model.events ?? [];
  const agents = dashboardAgents(model);
  const fragments = renderDashboardFragments(model, agents);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ACS Mission Control</title>
    <script>${themeBootScript()}</script>
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
      <p class="rail-note">Local-first control plane. Live state comes from the registry, work-item store, and audit stream. Press <kbd>?</kbd> for keyboard shortcuts.</p>
    </aside>
    <main id="main-content" tabindex="-1">
      <header>
        <div><h1>Mission Control</h1><p>Agents, work items, approvals, and audit events.</p></div>
        <div class="header-controls">
          <fieldset class="execution-mode" id="execution-mode-control">
            <legend>Execution Mode</legend>
            <label><input type="radio" name="executionMode" value="strict" data-execution-mode="strict"${model.executionMode === "strict" ? " checked" : ""}> Strict</label>
            <label><input type="radio" name="executionMode" value="admin" data-execution-mode="admin"${model.executionMode === "admin" ? " checked" : ""}> Admin / YOLO</label>
            <p id="execution-mode-result" role="status"></p>
          </fieldset>
        <div class="header-status"><div class="live connecting" data-state="connecting"><span aria-hidden="true"></span> <span data-live-label>Connecting…</span></div><small id="dashboard-updated" class="dashboard-updated"></small><div class="header-tools"><button type="button" id="notifications-toggle" class="tool-button" aria-pressed="false">Notify me</button><button type="button" id="theme-toggle" class="tool-button">Theme: auto</button></div></div>
        </div>
      </header>
      <p id="action-status" class="action-status" role="status" aria-live="polite"></p>
      <div id="admin-mode-banner" class="admin-mode-banner" role="alert"${model.executionMode === "admin" ? "" : " hidden"}>${model.executionMode === "admin" ? ADMIN_MODE_BANNER_TEXT : ""}</div>
      <div id="execution-mode-problem" class="admin-mode-banner" role="alert"${model.executionModeProblem ? "" : " hidden"}>${model.executionModeProblem ? `ACS execution mode ${escapeHtml(model.executionModeProblem)} -- fail closed` : ""}</div>
      <div id="sse-stale-banner" class="stale-banner" hidden role="status" aria-live="assertive">Connection lost. Displayed work items may be stale. Approve, deny, and work-item controls are disabled until the live stream reconnects.</div>
      <section id="overview" class="cards" data-view-panel="overview">${fragments.cards}</section>
      <section class="grid">
        <article id="agents" class="panel wide roster-panel" data-view-panel="agents"><div class="panel-head"><div><h2>Agent Roster</h2><p>Backend registry + audit projection</p></div><span id="agent-count">${agents.length} observed</span></div><div class="agent-layout">${agentTable(agents)}${agentDetailPanel()}</div></article>
        <article id="queue" class="panel queue-panel" data-view-panel="queue execution"><div class="panel-head"><h2>Work Queue</h2><span id="queue-filter-count">${escapeHtml(String(model.workItems.length))} items</span></div>${queueFilterStrip()}<div class="queue" id="queue-list">${fragments.queueList}</div><div id="queue-footer" class="queue-footer">${fragments.queueFooter}</div>${workDetailPanel()}</article>
      </section>
      <section class="grid approvals-grid">
        <article id="approvals" class="panel wide" data-view-panel="overview approvals"><div class="panel-head"><h2>Approvals</h2><span id="approvals-count">${fragments.approvalsCount}</span></div><div id="approvals-list">${fragments.approvalsList}</div></article>
      </section>
      <section class="grid lower">
        <article id="operator-metrics" class="panel" data-view-panel="metrics"><div class="panel-head"><h2>Operator metrics</h2><span>leases · approvals · counters</span></div><div id="operator-metrics-body">${fragments.metrics}</div><div id="live-metrics" class="live-metrics" aria-live="off"><p class="muted">Live counters load while this view is open.</p></div><p class="metrics-scrape">Full Prometheus text: authenticated <a href="/metrics"><code>GET /metrics</code></a> (<code>acs_rate_limit_rejected_total</code>, <code>acs_http_requests_total{status="429"}</code>, …). Names: <code>docs/runbooks/operator-metrics.md</code>.</p></article>
        <article id="events" class="panel" data-view-panel="audit"><div class="panel-head"><h2>Recent Events</h2><span class="panel-tools"><span>append-only</span><button type="button" id="events-pause" class="tool-button" aria-pressed="false">Pause</button></span></div><div id="events-timeline">${fragments.eventsTimeline}</div><button type="button" id="events-load-older" class="load-more"${events.length ? "" : " disabled"}>Load older</button></article>
        <article id="system" class="panel" data-view-panel="system"><div class="panel-head"><h2>System Health</h2><span>live</span></div><div class="system-panel"><div id="system-stats">${fragments.systemStats}</div><div id="system-probes" class="system-probes"></div></div></article>
      </section>
      <section class="grid lower">
        <article id="dispatch" class="panel composer" data-view-panel="overview"><div class="panel-head"><h2>New Task Composer</h2><span>authenticated session</span></div>${composerHtml(model.composerActionKinds ?? [])}</article>
        <article id="connectors" class="panel" data-view-panel="connectors"><div class="panel-head"><h2>Connectors</h2><span>${agents.filter((agent) => /connector|tunnel/i.test(agent.kind)).length} observed</span></div><div id="connectors-body">${fragments.connectors}</div></article>
        <article id="policy" class="panel" data-view-panel="policy"><div class="panel-head"><h2>Policy</h2><span>recent decisions</span></div><div id="policy-body" class="policy-body">${fragments.policy}</div></article>
        <article class="panel" data-view-panel="overview"><div class="panel-head"><h2>Safety Notes</h2><span>fail closed</span></div><p class="empty">Approve, reject, and unblock use authenticated backend routes and append audit events; each approval names the action hash it approves. Cancel, retry, and clone live in work-item detail: cancel and retry require a reason, cancel always asks for confirmation, and retry/clone create a new item that goes back through policy. Bulk approval and bulk cancel are not exposed. Displayed audit attributes and errors are redacted for secret-looking values.</p></article>
      </section>
    </main>
    <script>${clientScript()}</script>
  </body>
</html>`;
}
