import { redactionClientSource } from "./redaction.js";

export function clientScript(): string {
  return `
let sseSource = null;
let sseReconnectAttempt = 0;
let sseReconnectTimer = null;
let sseConnected = false;
let sseEverOpened = false;
let snapshotCurrent = false;
let snapshotVersion = 0;
let reconcileFlight = null;
let refreshTimer = null;
let selectedAgentId = null;
let selectedWorkId = null;
let agentRequest = 0;
let workRequest = 0;
let visualizerProjectionFlight = null;
let visualizerProjectionLoadedAt = 0;
let visualizerStatusFlight = null;
let visualizerStatusLoadedAt = 0;
let visualizerStatusBody = null;
let confirmedMode = document.body.dataset.confirmedMode || '';
const pendingActions = new Set();
const uncertainActions = new Set();
const approvalDrafts = new Map();
const mutationMessages = new Map();
const sseEventNames = [
  'work_item.created', 'work_item.needs_approval', 'work_item.approved', 'work_item.running',
  'work_item.blocked', 'work_item.failed', 'work_item.succeeded', 'work_item.cancelled',
  'work_item.rejected', 'work_item.quarantined', 'work_item.updated', 'work_item.unblocked',
  'agent.created', 'agent.updated', 'agent.heartbeat', 'agent.capabilities_replaced',
  'acp.initialized', 'acp.disconnected', 'acp.error', 'tunnel_session.heartbeat',
  'execution_mode.changed'
];

function nextSseReconnectDelayMs(attempt) {
  const n = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  return Math.min(30000, 1000 * Math.pow(2, Math.min(n, 5)));
}
function freshness(section, state, message) {
  document.querySelectorAll('[data-freshness="' + section + '"]').forEach(function (node) {
    node.dataset.state = state;
    if (state === 'current') node.dataset.updated = String(Date.now());
    node.textContent = message || (state === 'current' ? 'Current — updated just now' : state === 'stale' ? 'Stale — refreshing authoritative state' : 'Unavailable — retry refresh');
  });
}
function setStatusDot(selector, state) {
  const dot = document.querySelector(selector);
  if (!dot) return;
  dot.classList.remove('pending', 'degraded', 'ok');
  dot.classList.add(state);
}
function updateActionAvailability() {
  document.querySelectorAll('[data-approve],[data-reject],[data-unblock]').forEach(function (button) {
    const id = button.dataset.approve || button.dataset.reject || button.dataset.unblock;
    button.disabled = !sseConnected || !snapshotCurrent || !confirmedMode || pendingActions.has(id) || uncertainActions.has(id) || (Boolean(button.dataset.approve) && !button.dataset.actionHash);
  });
  const apply = document.querySelector('#execution-mode-apply');
  const proposed = document.querySelector('[data-execution-mode]:checked');
  if (apply) apply.disabled = !sseConnected || !snapshotCurrent || !confirmedMode || !proposed || proposed.value === confirmedMode || pendingActions.has('mode') || uncertainActions.has('mode');
  document.querySelectorAll('[data-execution-mode]').forEach(function (radio) { radio.disabled = pendingActions.has('mode') || uncertainActions.has('mode'); });
  const submit = document.querySelector('#task-form button[type=submit]');
  if (submit) submit.disabled = pendingActions.has('create') || uncertainActions.has('create');
}
function applySseConnectionState(root, connected) {
  sseConnected = connected;
  snapshotCurrent = false;
  snapshotVersion += 1;
  const banner = root.querySelector('#sse-stale-banner');
  if (banner) {
    banner.hidden = false;
    banner.textContent = connected ? 'Connection restored — reconciling authoritative state. Sensitive actions remain disabled.' : 'Reconnecting. Displayed work items may be stale. Sensitive actions remain disabled.';
  }
  const live = root.querySelector('.live');
  if (live) {
    live.classList.toggle('disconnected', !connected);
    live.innerHTML = '<span aria-hidden="true"></span>' + (connected ? ' Connected · reconciling' : sseEverOpened ? ' Reconnecting' : ' Connecting');
  }
  const overviewStream = root.querySelector('[data-overview-stream]');
  if (overviewStream) overviewStream.textContent = connected ? 'Connected' : 'Disconnected';
  const dataStatus = root.querySelector('#data-current-status');
  if (dataStatus) dataStatus.textContent = connected ? 'Reconciling' : 'Stale';
  const liveDot = root.querySelector('.health-dot.live-dot');
  if (liveDot) liveDot.classList.toggle('ok', connected);
  setStatusDot('.stream-status-dot', connected ? 'ok' : 'degraded');
  setStatusDot('.data-status-dot', connected ? 'pending' : 'degraded');
  setStatusDot('.acs-status-dot', connected ? 'pending' : 'degraded');
  const acsStatus = root.querySelector('#acs-online-status');
  if (acsStatus) acsStatus.textContent = connected ? 'ACS Reconciling' : 'ACS Disconnected';
  ['work', 'approvals', 'agents'].forEach(function (section) { freshness(section, 'stale'); });
  updateActionAvailability();
}
function connectSse() {
  if (sseReconnectTimer) clearTimeout(sseReconnectTimer);
  sseReconnectTimer = null;
  if (sseSource) sseSource.close();
  sseSource = new EventSource('/events');
  sseSource.addEventListener('open', function () {
    sseReconnectAttempt = 0;
    applySseConnectionState(document, true);
    sseEverOpened = true;
    void reconcileSnapshot();
  });
  sseSource.addEventListener('error', function () {
    applySseConnectionState(document, false);
    sseSource.close();
    if (sseReconnectTimer) return;
    const delay = nextSseReconnectDelayMs(sseReconnectAttempt);
    sseReconnectAttempt += 1;
    sseReconnectTimer = setTimeout(connectSse, delay);
  });
  sseEventNames.forEach(function (name) { sseSource.addEventListener(name, appendAuditEvent); });
  sseSource.addEventListener('message', appendAuditEvent);
}
function scheduleRefresh() {
  snapshotCurrent = false;
  snapshotVersion += 1;
  ['work', 'approvals', 'agents'].forEach(function (section) { freshness(section, 'stale'); });
  updateActionAvailability();
  if (refreshTimer) return;
  refreshTimer = setTimeout(function () { refreshTimer = null; void reconcileSnapshot(); }, 200);
}
function nodeKey(node) {
  return node.nodeType === 1 ? node.id || node.getAttribute('data-work-item') || node.getAttribute('data-approval-item') || node.getAttribute('data-agent') : null;
}
// Reconcile keyed elements in place so focus, expanded details, and input drafts survive refresh.
function patchElement(live, incoming) {
  if (live.nodeType !== incoming.nodeType || live.nodeName !== incoming.nodeName) { const replacement = incoming.cloneNode(true); live.replaceWith(replacement); return replacement; }
  if (live.nodeType === 3) { if (live.data !== incoming.data) live.data = incoming.data; return live; }
  if (live.nodeType !== 1) return live;
  if (live.id && live.id.startsWith('approval-result-')) return live;
  Array.from(live.attributes).forEach(function (attr) { if (!incoming.hasAttribute(attr.name) && attr.name !== 'open') live.removeAttribute(attr.name); });
  Array.from(incoming.attributes).forEach(function (attr) { if (live.getAttribute(attr.name) !== attr.value) live.setAttribute(attr.name, attr.value); });
  if (live.matches('input,textarea')) return live;
  const oldChildren = Array.from(live.childNodes);
  const keyed = new Map(oldChildren.filter(nodeKey).map(function (node) { return [nodeKey(node), node]; }));
  const used = new Set();
  Array.from(incoming.childNodes).forEach(function (next, index) {
    const key = nodeKey(next);
    let current = key ? keyed.get(key) : oldChildren[index];
    if (current && (used.has(current) || (!key && nodeKey(current)))) current = null;
    if (!current) current = next.cloneNode(true);
    else current = patchElement(current, next);
    used.add(current);
    if (live.childNodes[index] !== current) live.insertBefore(current, live.childNodes[index] || null);
  });
  oldChildren.forEach(function (node) { if (!used.has(node) && node.parentNode === live) node.remove(); });
  return live;
}
function patchDetail(target, html) { const next = target.cloneNode(false); next.innerHTML = html; patchElement(target, next); }

function restoreSelection() {
  document.querySelectorAll('[data-agent]').forEach(function (row) {
    const selected = row.dataset.agent === selectedAgentId;
    row.classList.toggle('selected', selected);
    row.querySelector('button')?.setAttribute('aria-pressed', String(selected));
  });
  document.querySelectorAll('[data-work-item]').forEach(function (row) {
    const selected = row.dataset.workItem === selectedWorkId;
    row.classList.toggle('selected', selected);
    if (selected) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
  });
}
function rememberDrafts() {
  document.querySelectorAll('[data-reason]').forEach(function (input) { approvalDrafts.set(input.dataset.reason, input.value); });
}
async function reconcileSnapshot() {
  if (reconcileFlight) return reconcileFlight;
  const version = snapshotVersion;
  reconcileFlight = (async function () {
    try {
      const response = await fetchWithTimeout('/', { headers: { accept: 'text/html' }, cache: 'no-store' });
      if (!response.ok) throw new Error('State refresh failed (HTTP ' + response.status + '). Check your session and retry.');
      const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
      if (parsed.body.dataset.snapshot !== 'mission-control' || !parsed.querySelector('#approvals .approvals-list') || !parsed.querySelector('#queue .queue')) throw new Error('Invalid dashboard response. Check your session.');
      if (version !== snapshotVersion) return false;
      rememberDrafts();
      const focusBefore = document.activeElement;
      const approvalsNav = document.querySelector('a[data-nav="approvals"]');
      const nextApprovalsNav = parsed.querySelector('a[data-nav="approvals"]');
      const approvalsBadge = approvalsNav?.querySelector('.nav-count');
      const nextApprovalsBadge = nextApprovalsNav?.querySelector('.nav-count');
      if (approvalsBadge && nextApprovalsBadge) patchElement(approvalsBadge, nextApprovalsBadge);
      else if (approvalsBadge) approvalsBadge.remove();
      else if (approvalsNav && nextApprovalsBadge) approvalsNav.appendChild(nextApprovalsBadge.cloneNode(true));
      ['#overview', '#queue .queue', '#queue-empty', '#approvals .approvals-list', '#approvals .panel-head', '#approvals .view-all', '#agents .table-wrap', '#agent-count', '#operator-metrics .operator-metrics', '#connectors', '#policy', '#system .system-panel > dl'].forEach(function (selector) {
        const live = document.querySelector(selector), next = parsed.querySelector(selector);
        if (live && next) patchElement(live, next);
      });
      const approvals = document.querySelector('#approvals');
      const nextEmpty = parsed.querySelector('#approvals > .empty');
      approvals.querySelector(':scope > .empty')?.remove();
      if (nextEmpty) approvals.appendChild(nextEmpty.cloneNode(true));
      document.querySelectorAll('[data-reason]').forEach(function (input) { if (approvalDrafts.has(input.dataset.reason)) input.value = approvalDrafts.get(input.dataset.reason); });
      mutationMessages.forEach(function (message, id) { const output = document.getElementById('approval-result-' + id); if (output) output.textContent = message; });
      const previousMode = confirmedMode;
      confirmedMode = parsed.body.dataset.confirmedMode || '';
      document.querySelector('#execution-mode-active').textContent = confirmedMode || 'Unavailable — fail closed';
      const modeBadge = document.querySelector('#mode-badge-label');
      if (modeBadge) modeBadge.textContent = confirmedMode === 'admin' ? 'Admin Mode' : confirmedMode === 'strict' ? 'Strict Mode' : 'Mode Unavailable';
      const modeHint = document.querySelector('.mode-status-chip small');
      if (modeHint) modeHint.textContent = confirmedMode === 'admin' ? 'Eligible approvals automated' : confirmedMode === 'strict' ? 'Manual approval required' : 'Fail closed';
      const modeChip = document.querySelector('.mode-status-chip');
      if (modeChip) {
        modeChip.classList.toggle('admin', confirmedMode === 'admin');
        modeChip.classList.toggle('strict', confirmedMode === 'strict');
        modeChip.classList.toggle('unavailable', !confirmedMode);
      }
      if (previousMode !== confirmedMode || pendingActions.has('mode') || uncertainActions.has('mode')) restoreModeSelection();
      document.querySelector('#admin-mode-banner').hidden = confirmedMode !== 'admin';
      patchElement(document.querySelector('#execution-mode-problem'), parsed.querySelector('#execution-mode-problem'));
      restoreSelection();
      applyQueueFilterClient(readQueueFilterFromDom());
      showView(currentView(), false);
      if (focusBefore && !focusBefore.isConnected) document.querySelector('#view-heading').focus({ preventScroll: true });
      snapshotCurrent = sseConnected;
      ['work', 'approvals', 'agents'].forEach(function (section) { freshness(section, snapshotCurrent ? 'current' : 'stale'); });
      document.querySelector('#sse-stale-banner').hidden = snapshotCurrent;
      if (snapshotCurrent) document.querySelector('.live').innerHTML = '<span aria-hidden="true"></span> Connected';
      const overviewStream = document.querySelector('[data-overview-stream]');
      if (overviewStream) overviewStream.textContent = snapshotCurrent ? 'Connected' : 'Stale';
      const dataStatus = document.querySelector('#data-current-status');
      if (dataStatus) {
        dataStatus.textContent = snapshotCurrent ? 'Current · just now' : 'Stale';
        if (snapshotCurrent) dataStatus.dataset.updated = String(Date.now()); else delete dataStatus.dataset.updated;
      }
      const liveDot = document.querySelector('.health-dot.live-dot');
      if (liveDot) liveDot.classList.toggle('ok', snapshotCurrent);
      setStatusDot('.stream-status-dot', sseConnected ? 'ok' : 'degraded');
      setStatusDot('.data-status-dot', snapshotCurrent ? 'ok' : 'degraded');
      setStatusDot('.acs-status-dot', snapshotCurrent ? 'ok' : 'degraded');
      const acsStatus = document.querySelector('#acs-online-status');
      if (acsStatus) acsStatus.textContent = snapshotCurrent ? 'ACS Online' : 'ACS Degraded';
      document.querySelector('#state-result').textContent = '';
      uncertainActions.forEach(function (id) { if (id !== 'create') uncertainActions.delete(id); });
      if (selectedAgentId) void loadAgentDetail(selectedAgentId, true);
      if (selectedWorkId) void loadWorkDetail(selectedWorkId, true);
      mergeSnapshotEvents(parsed);
      updateActionAvailability();
      return true;
    } catch (error) {
      snapshotCurrent = false;
      ['work', 'approvals', 'agents'].forEach(function (section) { freshness(section, 'unavailable'); });
      document.querySelector('#state-result').textContent = redactClient(error.message);
      document.querySelector('#sse-stale-banner').hidden = false;
      document.querySelector('#sse-stale-banner').textContent = 'Unavailable — authoritative refresh failed. Sensitive actions remain disabled. Use Refresh state to retry.';
      const dataStatus = document.querySelector('#data-current-status');
      if (dataStatus) dataStatus.textContent = 'Unavailable';
      const overviewStream = document.querySelector('[data-overview-stream]');
      if (overviewStream) overviewStream.textContent = sseConnected ? 'Connected' : 'Disconnected';
      setStatusDot('.stream-status-dot', sseConnected ? 'ok' : 'degraded');
      setStatusDot('.data-status-dot', 'degraded');
      setStatusDot('.acs-status-dot', 'degraded');
      const acsStatus = document.querySelector('#acs-online-status');
      if (acsStatus) acsStatus.textContent = 'ACS Degraded';
      updateActionAvailability();
      return false;
    } finally {
      reconcileFlight = null;
      if (version !== snapshotVersion && sseConnected) { if (refreshTimer) clearTimeout(refreshTimer); refreshTimer = setTimeout(function () { refreshTimer = null; void reconcileSnapshot(); }, 200); }
    }
  })();
  return reconcileFlight;
}
function refreshAgentRoster() { return reconcileSnapshot(); }
let auditFollowing = true;
let auditPending = [];
const auditSeen = new Set(Array.from(document.querySelectorAll('#events [data-event-key]')).map(function (node) { return node.dataset.eventKey; }));
function auditRow(event) {
  const row = document.createElement('li');
  row.dataset.eventKey = event.id || String(event.timeUnixNano) + ':' + String(event.name);
  const attrs = event.attributes || {};
  const resource = attrs['work_item.id'] || attrs['agent.id'] || attrs['connector.id'] || 'System';
  const outcome = attrs.status || attrs.outcome || attrs.decision || String(event.name || '').split('.').at(-1);
  const when = new Date(Math.floor(Number(event.timeUnixNano) / 1000000));
  const valid = Number.isFinite(when.getTime());
  row.innerHTML = '<strong>' + escapeClient(event.name || 'Event') + '</strong><p>' + escapeClient(resource) + ' · ' + escapeClient(outcome) + '</p><time' + (valid ? ' datetime="' + when.toISOString() + '"' : '') + '>' + (valid ? escapeClient(relativeTime(when.getTime()) + ' · ' + when.toLocaleString(undefined, { timeZoneName: 'short' })) : 'Unknown time') + '</time><details><summary>Event attributes</summary><pre>' + escapeClient(redactedAttributesJsonClient(attrs)) + '</pre></details>';
  return row;
}
function queueAuditRow(row) {
  if (auditSeen.has(row.dataset.eventKey)) return;
  auditSeen.add(row.dataset.eventKey);
  auditPending.push(row);
  if (auditSeen.size > 300) { const oldest = auditSeen.values().next().value; auditSeen.delete(oldest); }
  if (auditPending.length > 100) auditPending.shift();
  if (auditFollowing) flushAudit();
  else { const button = document.querySelector('#audit-new'); button.hidden = false; button.textContent = auditPending.length + ' new events'; }
}
function flushAudit() {
  const list = document.querySelector('#events .timeline');
  if (!auditPending.length) return;
  document.querySelector('#events .empty')?.remove();
  auditPending.forEach(function (row) { list.prepend(row); });
  auditPending = [];
  while (list.children.length > 100) list.lastElementChild.remove();
  // Bound deduplication state independently of whether the operator follows the feed.
  if (auditSeen.size > 300) { auditSeen.clear(); Array.from(list.children).forEach(function (row) { auditSeen.add(row.dataset.eventKey); }); }
  document.querySelector('#audit-new').hidden = true;
}
function mergeSnapshotEvents(parsed) {
  Array.from(parsed.querySelectorAll('#events .timeline > li')).reverse().forEach(function (row) { queueAuditRow(row.cloneNode(true)); });
}
function appendAuditEvent(event) {
  let data;
  try { data = JSON.parse(event.data); } catch { return; }
  if (!data || typeof data !== 'object') return;
  data.name = data.name || event.type;
  queueAuditRow(auditRow(data));
  visualizerProjectionLoadedAt = 0;
  scheduleRefresh();
}
function relativeTime(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  return seconds < 60 ? seconds + 's ago' : seconds < 3600 ? Math.floor(seconds / 60) + 'm ago' : Math.floor(seconds / 3600) + 'h ago';
}

function escapeClient(value) {
  return redactClient(value).replace(/[&<>"']/g, function (char) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] || char;
  });
}

${redactionClientSource()}
function formatClientTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? redactClient(value) : date.toLocaleString(undefined, { timeZoneName: 'short' });
}

function pillMarkup(value, label) {
  const safe = escapeClient(value || 'unknown');
  return '<span class="pill ' + safe + '">' + (label ? escapeClient(label) + ': ' : '') + safe + '</span>';
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, 15000);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
async function fetchJson(url) {
  const res = await fetchWithTimeout(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
  const body = await res.json();
  if (!res.ok) throw new Error(redactClient(body.error || body.code || ('HTTP ' + res.status)));
  return body;
}
function setVisualizerHealthDot(selector, state) {
  const dot = document.querySelector(selector);
  if (!dot) return;
  dot.classList.remove('ok', 'degraded', 'unavailable');
  if (state === 'healthy') dot.classList.add('ok');
  else if (state === 'degraded' || state === 'not_configured') dot.classList.add('degraded');
  else dot.classList.add('unavailable');
}
function renderVisualizerStatus(body) {
  const overview = document.querySelector('[data-visualizer-health]');
  const pageState = document.querySelector('#visualizer-health-state');
  const detail = document.querySelector('#visualizer-health-detail');
  const configured = body && body.configured === true;
  const state = configured ? String(body.state || 'unavailable') : 'not_configured';
  const label = state === 'not_configured' ? 'Not configured' : state === 'healthy' ? 'Healthy' : state === 'degraded' ? 'Degraded' : state === 'unhealthy' ? 'Unhealthy' : 'Unavailable';
  if (overview) overview.textContent = label;
  if (pageState) pageState.textContent = label;
  setVisualizerHealthDot('.visualizer-health-dot', state);
  setVisualizerHealthDot('.visualizer-page-health-dot', state);
  setVisualizerHealthDot('#visualizer-nav-health', state);
  const navHealth = document.querySelector('#visualizer-nav-health');
  if (navHealth) navHealth.setAttribute('aria-label', 'Visualizer status ' + label.toLowerCase());
  if (detail) {
    if (!configured) detail.textContent = 'Set ACS_VISUALIZER_URL to 127.0.0.1:4317';
    else if (!body.reachable) detail.textContent = 'Loopback listener unreachable';
    else {
      const parts = [];
      if (body.database) parts.push('DB ' + body.database);
      if (body.activeExecutions != null) parts.push(body.activeExecutions + ' active');
      if (body.queueDepth != null) parts.push(body.queueDepth + ' queued');
      if (body.pendingApprovals != null) parts.push(body.pendingApprovals + ' approvals');
      const runtimes = Array.isArray(body.runtimes) ? body.runtimes : [];
      const runtimeAttention = runtimes.filter(function (runtime) { return runtime.status !== 'healthy'; }).length;
      if (runtimeAttention) parts.push(runtimeAttention + (runtimeAttention === 1 ? ' runtime needs attention' : ' runtimes need attention'));
      detail.textContent = parts.join(' · ');
    }
  }
}
async function loadVisualizerStatus(force) {
  if (visualizerStatusFlight) return visualizerStatusFlight;
  if (!force && visualizerStatusLoadedAt && Date.now() - visualizerStatusLoadedAt < 10000 && visualizerStatusBody) {
    renderVisualizerStatus(visualizerStatusBody);
    return true;
  }
  visualizerStatusFlight = (async function () {
    try {
      const body = await fetchJson('/api/visualizer/status');
      visualizerStatusBody = body;
      renderVisualizerStatus(body);
      visualizerStatusLoadedAt = Date.now();
      return true;
    } catch {
      visualizerStatusBody = { configured: true, reachable: false, state: 'unavailable' };
      renderVisualizerStatus(visualizerStatusBody);
      return false;
    } finally {
      visualizerStatusFlight = null;
    }
  })();
  return visualizerStatusFlight;
}
function applyVisualizerFilter() {
  const text = String(document.querySelector('#visualizer-filter-text')?.value || '').trim().toLowerCase();
  const runtime = String(document.querySelector('#visualizer-filter-runtime')?.value || '');
  const state = String(document.querySelector('#visualizer-filter-state')?.value || '');
  const rows = Array.from(document.querySelectorAll('#visualizer-canvas .viz-execution'));
  let visible = 0;
  rows.forEach(function (row) {
    const matchesText = !text || String(row.textContent || '').toLowerCase().includes(text);
    const matchesRuntime = !runtime || row.dataset.vizRuntime === runtime;
    const matchesState = !state || row.dataset.vizState === state;
    const show = matchesText && matchesRuntime && matchesState;
    row.hidden = !show;
    if (show) visible += 1;
  });
  const live = document.querySelector('#visualizer-filter-live');
  if (live) live.textContent = rows.length ? ('Showing ' + visible + ' of ' + rows.length) : 'No projection rows';
}
function visualizerStatusClass(status) {
  if (status === 'completed') return 'complete';
  if (status === 'failed' || status === 'cancelled' || status === 'blocked') return 'failed';
  if (status === 'running' || status === 'starting' || status === 'waiting_approval' || status === 'retrying') return 'active';
  return 'queued';
}
function visualizerNodeDepth(node, byId, seen) {
  if (!node || !node.parentNodeId || seen.has(node.id)) return 0;
  const parent = byId.get(node.parentNodeId);
  if (!parent) return 1;
  const next = new Set(seen); next.add(node.id);
  return 1 + visualizerNodeDepth(parent, byId, next);
}
function sortedVisualizerNodes(projection) {
  const nodes = Array.isArray(projection && projection.nodes) ? projection.nodes.slice() : [];
  const byId = new Map(nodes.map(function (node) { return [node.id, node]; }));
  return nodes.sort(function (left, right) {
    if (left.id === projection.rootNodeId) return -1;
    if (right.id === projection.rootNodeId) return 1;
    const depth = visualizerNodeDepth(left, byId, new Set()) - visualizerNodeDepth(right, byId, new Set());
    return depth || String(left.id).localeCompare(String(right.id));
  });
}
function appendVisualizerText(parent, tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = redactClient(String(value == null ? '' : value));
  parent.appendChild(node);
  return node;
}
function renderVisualizerProjection(body) {
  const canvas = document.querySelector('#visualizer-canvas');
  const status = document.querySelector('#visualizer-source-status');
  if (!canvas || !status) return;
  canvas.replaceChildren();
  if (!body || body.schemaVersion !== 1 || !Array.isArray(body.items)) {
    throw new Error('Invalid Visualizer projection response.');
  }
  if (body.configured !== true) {
    status.textContent = 'Not configured';
    const summary = document.querySelector('#visualizer-summary');
    if (summary) summary.hidden = true;
    const live = document.querySelector('#visualizer-filter-live');
    if (live) live.textContent = 'Visualizer not configured';
    appendVisualizerText(canvas, 'p', 'empty', 'Visualizer is not configured for ACS. Set ACS_VISUALIZER_URL to its 127.0.0.1 listener.');
    return;
  }
  let projected = 0, pending = 0, unavailable = 0, active = 0;
  body.items.forEach(function (item) {
    const article = document.createElement('article');
    article.className = 'viz-execution';
    article.dataset.vizWorkItem = String(item.workItemId || '');
    article.dataset.vizState = String(item.state || 'unavailable');
    article.dataset.vizRuntime = '';
    const head = document.createElement('div'); head.className = 'viz-execution-head';
    const identity = document.createElement('div');
    appendVisualizerText(identity, 'strong', '', item.title || item.workItemId || 'Work item');
    appendVisualizerText(identity, 'small', '', item.workItemId || 'Unknown work item');
    head.appendChild(identity);
    const badges = document.createElement('div'); badges.className = 'viz-execution-badges';
    appendVisualizerText(badges, 'span', 'pill ' + String(item.acsStatus || 'unknown'), 'ACS ' + String(item.acsStatus || 'unknown'));
    head.appendChild(badges); article.appendChild(head);
    if (item.state !== 'available' || !item.projection) {
      if (item.state === 'not_projected') pending += 1; else unavailable += 1;
      appendVisualizerText(
        article,
        'p',
        'viz-projection-state ' + (item.state === 'not_projected' ? 'pending' : 'unavailable'),
        item.state === 'not_projected'
          ? 'No canonical Visualizer projection exists yet. The bridge may still be syncing, or runtime attribution may be unsupported.'
          : 'Canonical Visualizer projection unavailable.'
      );
      canvas.appendChild(article);
      return;
    }
    projected += 1;
    const projection = item.projection;
    article.dataset.vizRuntime = String(projection.sourceRuntime || '');
    if (['starting', 'running', 'waiting_approval', 'blocked', 'retrying'].includes(projection.status)) active += 1;
    appendVisualizerText(badges, 'span', 'pill', projection.sourceRuntime || 'runtime');
    appendVisualizerText(badges, 'span', 'pill ' + visualizerStatusClass(projection.status), projection.status || 'unknown');
    appendVisualizerText(badges, 'span', 'pill', 'r' + String(projection.revision));
    const graph = document.createElement('div'); graph.className = 'viz-canonical-graph';
    const nodes = sortedVisualizerNodes(projection);
    const edges = Array.isArray(projection.edges) ? projection.edges : [];
    const nodeById = new Map(nodes.map(function (node) { return [node.id, node]; }));
    nodes.forEach(function (node) {
      const row = document.createElement('div'); row.className = 'viz-canonical-row';
      const incoming = document.createElement('div'); incoming.className = 'viz-incoming';
      const incomingEdges = edges.filter(function (edge) { return edge.toNodeId === node.id; });
      if (node.id === projection.rootNodeId) {
        appendVisualizerText(incoming, 'span', 'viz-root-label', 'ROOT');
      } else if (!incomingEdges.length) {
        appendVisualizerText(incoming, 'span', 'viz-edge-missing', 'No incoming edge in snapshot');
      } else {
        incomingEdges.forEach(function (edge) {
          const parent = nodeById.get(edge.fromNodeId);
          const relation = document.createElement('div'); relation.className = 'viz-incoming-edge';
          appendVisualizerText(relation, 'span', 'viz-edge-parent', parent ? parent.label : edge.fromNodeId);
          appendVisualizerText(relation, 'b', 'viz-edge-type', edge.edgeType);
          relation.appendChild(document.createTextNode(' →'));
          incoming.appendChild(relation);
        });
      }
      row.appendChild(incoming);
      const card = document.createElement('div');
      card.className = 'viz-canonical-node ' + visualizerStatusClass(node.status);
      card.dataset.nodeId = String(node.id || '');
      appendVisualizerText(card, 'strong', '', node.label || node.nodeType || 'node');
      appendVisualizerText(card, 'small', '', String(node.nodeType || 'node').replaceAll('_', ' ') + ' · ' + String(node.status || 'unknown'));
      row.appendChild(card);
      graph.appendChild(row);
    });
    if (!nodes.length) appendVisualizerText(graph, 'p', 'empty', 'No canonical graph nodes are available yet.');
    article.appendChild(graph);
    appendVisualizerText(
      article,
      'small',
      'viz-execution-meta',
      'Visualizer revision ' + String(projection.revision) + ' · event position ' + String(projection.eventPosition) + ' · ' + String(item.executionId || '')
    );
    canvas.appendChild(article);
  });
  if (!body.items.length) appendVisualizerText(canvas, 'p', 'empty', 'No ACS work items are available to project.');
  status.textContent = projected + ' canonical · ' + pending + ' not projected · ' + unavailable + ' unavailable';
  const summary = document.querySelector('#visualizer-summary');
  if (summary) summary.hidden = false;
  const values = {
    '#viz-summary-canonical': projected,
    '#viz-summary-active': active,
    '#viz-summary-not-projected': pending,
    '#viz-summary-unavailable': unavailable
  };
  Object.entries(values).forEach(function (entry) {
    const node = document.querySelector(entry[0]);
    if (node) node.textContent = String(entry[1]);
  });
  applyVisualizerFilter();
}
async function loadVisualizerProjection(force) {
  const canvas = document.querySelector('#visualizer-canvas');
  const status = document.querySelector('#visualizer-source-status');
  if (!canvas || !status) return false;
  if (visualizerProjectionFlight) return visualizerProjectionFlight;
  if (!force && visualizerProjectionLoadedAt && Date.now() - visualizerProjectionLoadedAt < 5000) return true;
  status.textContent = 'Loading canonical projection…';
  canvas.setAttribute('aria-busy', 'true');
  visualizerProjectionFlight = (async function () {
    try {
      const body = await fetchJson('/api/visualizer/projection?limit=20');
      renderVisualizerProjection(body);
      visualizerProjectionLoadedAt = Date.now();
      return true;
    } catch (error) {
      status.textContent = 'Unavailable';
      const summary = document.querySelector('#visualizer-summary');
      if (summary) summary.hidden = true;
      const live = document.querySelector('#visualizer-filter-live');
      if (live) live.textContent = 'Projection unavailable';
      canvas.replaceChildren();
      appendVisualizerText(canvas, 'p', 'detail-error', 'Visualizer projection unavailable: ' + redactClient(error.message));
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry projection';
      retry.addEventListener('click', function () { void loadVisualizerProjection(true); });
      canvas.appendChild(retry);
      return false;
    } finally {
      canvas.setAttribute('aria-busy', 'false');
      visualizerProjectionFlight = null;
    }
  })();
  return visualizerProjectionFlight;
}
function bindWorkItems() {
  document.querySelector('#queue').addEventListener('click', function (event) {
    const button = event.target.closest('[data-work-item]');
    if (!button) return;
    selectedWorkId = button.dataset.workItem;
    restoreSelection();
    void loadWorkDetail(selectedWorkId, false, event.detail === 0);
  });
}
async function loadWorkDetail(id, refreshing, keyboard) {
  const generation = ++workRequest;
  const target = document.querySelector('#work-detail');
  target.setAttribute('aria-busy', 'true');
  if (!refreshing) target.innerHTML = '<div class="detail-loading">Loading selected work item…</div>';
  try {
    const body = await fetchJson('/work-items/' + encodeURIComponent(id));
    if (generation !== workRequest || id !== selectedWorkId) return;
    renderWorkDetail(target, body.workItem, body.events || [], body.executionAttempts || [], body.attemptLeases || []);
    if (keyboard) target.focus({ preventScroll: false });
  } catch (error) {
    if (generation !== workRequest || id !== selectedWorkId) return;
    if (!refreshing) target.innerHTML = '';
    target.querySelector('.detail-error')?.remove();
    const message = document.createElement('p'); message.className = 'detail-error'; message.setAttribute('role', 'status');
    message.textContent = 'Work detail unavailable: ' + redactClient(error.message);
    target.appendChild(message);
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry work detail'; retry.onclick = function () { void loadWorkDetail(id, true); }; message.appendChild(retry);
  } finally { if (generation === workRequest) target.setAttribute('aria-busy', 'false'); }
}
function bindAgentRows() {
  document.querySelector('#agents').addEventListener('click', function (event) {
    if (event.target.closest('[data-agent-retry]')) { void loadAgentDetail(selectedAgentId, true); return; }
    const row = event.target.closest('[data-agent]');
    if (!row) return;
    selectedAgentId = row.dataset.agent;
    restoreSelection();
    void loadAgentDetail(selectedAgentId, false, event.detail === 0);
  });
}
async function loadAgentDetail(id, refreshing, keyboard) {
  const target = document.querySelector('#agent-detail');
  if (!target || !id) return;
  const generation = ++agentRequest;
  target.setAttribute('aria-busy', 'true');
  if (!refreshing) target.innerHTML = '<div class="detail-loading">Loading selected agent…</div>';
  const results = await Promise.allSettled([
    fetchJson('/agents/' + encodeURIComponent(id) + '?limit=8'),
    fetchJson('/api/agents/' + encodeURIComponent(id) + '?limit=8'),
    fetchJson('/api/agents/' + encodeURIComponent(id) + '/capabilities')
  ]);
  if (generation !== agentRequest || id !== selectedAgentId) return;
  const projected = results[0].status === 'fulfilled' ? results[0].value : null;
  const registry = results[1].status === 'fulfilled' ? results[1].value : null;
  const capabilities = results[2].status === 'fulfilled' ? results[2].value : null;
  if (projected && projected.agent) {
    renderAgentDetail(target, {
      projected: projected.agent,
      registry: registry && registry.agent,
      adapterStatus: registry && registry.adapterStatus || projected.adapterStatus,
      events: registry && registry.events || projected.events || [],
      capabilities: capabilities && capabilities.capabilities || [],
      registryUnavailable: !registry,
      capabilitiesUnavailable: !capabilities
    });
  } else {
    if (!refreshing) target.innerHTML = '';
    target.querySelector('.detail-error')?.remove();
    const error = document.createElement('p'); error.className = 'detail-error'; error.textContent = 'Selected agent ' + redactClient(id) + ' unavailable — previous data may be stale.'; target.appendChild(error);
  }
  if (!target.querySelector('[data-agent-retry]')) {
    const retry = document.createElement('button'); retry.type = 'button'; retry.dataset.agentRetry = ''; retry.textContent = 'Refresh agent details'; target.appendChild(retry);
  }
  target.setAttribute('aria-busy', 'false');
  if (keyboard) target.focus({ preventScroll: false });
}

function capabilityNames(input) {
  return (Array.isArray(input) ? input : [])
    .map(function (capability) { return typeof capability === 'string' ? capability : capability && capability.name; })
    .filter(Boolean);
}

function renderAgentDetail(target, detail) {
  const agent = detail.projected || detail.registry || {};
  const registry = detail.registry || {};
  const capabilities = capabilityNames(detail.capabilities);
  const uniqueCapabilities = Array.from(new Set(capabilities)).sort();
  const adapter = detail.adapterStatus ? (detail.adapterStatus.state || detail.adapterStatus.status || 'unknown') : detail.registryUnavailable ? 'unavailable' : 'not configured';
  patchDetail(target, '<div class="detail-head"><div><h3>' + escapeClient(agent.displayName || registry.name || agent.id) + '</h3><small>' + escapeClient(agent.id || registry.id || '') + '</small></div><div>' + pillMarkup(agent.status || registry.effectiveStatus || registry.status || 'observed') + ' ' + pillMarkup(agent.health || 'unknown') + '</div></div>' +
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
    (detail.registryUnavailable ? '<p class="detail-error">Registry data unavailable — refresh to retry.</p>' : '') + '<div class="detail-section"><h4>Capabilities</h4>' + (detail.capabilitiesUnavailable ? '<p class="detail-error">Capability data unavailable — refresh to retry.</p>' : capabilityList(uniqueCapabilities)) + '</div>' +
    '<div class="detail-section"><h4>Recent Events</h4>' + eventList(detail.events || []) + '</div><button type="button" data-agent-retry>Refresh agent details</button>');
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
    return '<li><time>' + escapeClient(eventClientTime(event)) + '</time><strong>' + escapeClient(event.name || 'event') + '</strong><small>' + escapeClient(redactClient(ref)) + '</small></li>';
  }).join('') + '</ol>';
}

function eventClientTime(event) {
  const nanos = Number(event && event.timeUnixNano);
  return Number.isFinite(nanos) ? formatClientTime(new Date(Math.floor(nanos / 1000000)).toISOString()) : '—';
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
          detailRow('Policy decision', lease.policyDecisionHash) +
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
      detailRow('Plan hash', attempt.planHash) +
      detailRow('Input hash', attempt.inputHash) +
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
  patchDetail(target, '<div class="detail-head"><div><h3 id="work-detail-title">' + escapeClient(workItem.title) + '</h3><small>' + escapeClient(workItem.id) + '</small></div><div>' + pillMarkup(workItem.status) + ' ' + pillMarkup(workItem.risk, 'Risk') + '</div></div>' +
    '<dl class="detail-grid">' +
      detailRow('Requester', workItem.requester) +
      detailRow('Intent', workItem.intent) +
      detailRow('Target', workItem.target ? redactedAttributesJsonClient(workItem.target) : '—') +
      detailRow('Created', formatClientTime(workItem.createdAt)) +
    '</dl>' +
    '<div class="detail-section"><h4>Requested Actions</h4>' + (actions.length ? '<ul class="action-list">' + actions.map(function (action) { return '<li><strong>' + escapeClient(action.kind) + '</strong><small>' + escapeClient(redactClient(action.description)) + '</small></li>'; }).join('') + '</ul>' : '<p class="muted">No requested actions.</p>') + '</div>' +
    (workItem.result && typeof workItem.result.error === 'string' ? '<details class="detail-section"><summary>Failure details</summary><p class="error-line">' + escapeClient(workItem.result.error) + '</p></details>' : '') +
    renderExecutionAuthority(executionAttempts, attemptLeases) +
    '<div class="detail-section"><h4>Timeline</h4>' + eventList(events || []) + '</div>');
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
    if (currentView() === 'execution' && el.dataset.hasExecution !== 'true' && !['approved', 'running', 'cancelling', 'quarantined'].includes(status)) show = false;
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
  const noMatches = document.querySelector('#queue-no-matches');
  if (noMatches) noMatches.hidden = visible !== 0 || buttons.length === 0;
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
  return redactClient(value).replace(/[&<>"']/g, function (char) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] || char;
  });
}

function requestApprovalConfirm(request) {
  if (document.getElementById('approval-confirm-dialog')) return Promise.resolve(false);
  return new Promise(function (resolve) {
    const trigger = document.activeElement;
    const overlay = document.createElement('div');
    overlay.id = 'approval-confirm-dialog';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'approval-confirm-title');
    overlay.setAttribute('aria-describedby', 'approval-confirm-description');
    overlay.className = 'approval-confirm-overlay';
    const actionLabel = request.action === 'approve' ? 'Approve' : 'Reject';
    overlay.innerHTML = '<div class="approval-confirm-card"><h3 id="approval-confirm-title">' + actionLabel + ' high-risk work item?</h3>' +
      '<p id="approval-confirm-description"><strong>' + escapeClient(request.title || request.workItemId) + '</strong></p>' +
      '<p class="approval-confirm-kind">Action: ' + escapeClient(request.actionKind || 'Reject work item') + '</p>' +
      '<p>Risk: ' + escapeClient(request.risk) + '</p><p>Target: ' + escapeClient(request.target || 'Not specified') + '</p>' +
      '<p>Reason: ' + escapeClient(request.reason || '') + '</p>' +
      '<p>Active execution mode: ' + escapeClient(confirmedMode || 'Unavailable') + '.</p>' +
      '<p>ACS will validate authorization and the exact action binding before recording this decision.</p>' +
      '<details><summary>Technical identity</summary><p>Work item: <code>' + escapeClient(request.workItemId) + '</code></p>' +
      (request.actionHash ? '<p>Action hash: <code>' + escapeClient(request.actionHash) + '</code></p>' : '') + '</details>' +
      '<div class="approval-confirm-actions"><button type="button" id="approval-confirm-cancel">Cancel</button><button type="button" id="approval-confirm-ok">' + actionLabel + '</button></div></div>';
    const background = Array.from(document.body.children).filter(function (node) { return node.tagName !== 'SCRIPT'; }).map(function (node) { const wasInert = node.inert; node.inert = true; return [node, wasInert]; });
    function finish(confirmed) {
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
      background.forEach(function (entry) { entry[0].inert = entry[1]; });
      if (trigger && trigger.isConnected) trigger.focus({ preventScroll: true });
      else document.querySelector('#view-heading').focus({ preventScroll: true });
      resolve(confirmed);
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') { event.preventDefault(); finish(false); }
      if (event.key === 'Tab') {
        const controls = Array.from(overlay.querySelectorAll('button:not(:disabled),summary'));
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    }
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKeyDown);
    overlay.querySelector('#approval-confirm-cancel').onclick = function () { finish(false); };
    overlay.querySelector('#approval-confirm-ok').onclick = function () { finish(true); };
    overlay.querySelector('#approval-confirm-cancel').focus();
  });
}
function restoreModeSelection() {
  document.querySelectorAll('[data-execution-mode]').forEach(function (input) { input.checked = input.value === confirmedMode; });
}
// A failed transport can hide a successful POST. Reconcile; never automatically replay it.
async function mutate(key, url, payload, output, progress) {
  if (pendingActions.has(key) || uncertainActions.has(key)) return false;
  pendingActions.add(key);
  const owner = key === 'mode' ? document.querySelector('#execution-mode-control') : key === 'create' ? document.querySelector('#task-form') : output.closest('.approval-item');
  const buttons = owner ? Array.from(owner.querySelectorAll('button')) : [];
  const labels = buttons.map(function (button) { return button.innerHTML; });
  if (owner) { owner.setAttribute('aria-busy', 'true'); owner.dataset.mutationState = 'submitting'; }
  if (output) output.textContent = progress;
  updateActionAvailability();
  const active = buttons.find(function (button) { return button === document.activeElement; }) || buttons[0];
  if (active) active.textContent = progress;
  let success = false;
  let message = '';
  try {
    const response = await fetchWithTimeout(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const body = await response.json();
    if (!response.ok) {
      message = 'Rejected: ' + redactClient(body.error || body.code || ('HTTP ' + response.status));
      if (key === 'mode') restoreModeSelection();
    } else {
      success = true;
      message = key === 'create' ? 'Created ' + redactClient(body.id) + '. Your draft is retained.' : 'Confirmed by ACS. Refreshing state…';
    }
  } catch {
    uncertainActions.add(key);
    message = 'Outcome uncertain — the request was not retried. Reconciling server state before another action.';
    if (key === 'mode') restoreModeSelection();
  }
  if (key !== 'mode' && key !== 'create') mutationMessages.set(key, message);
  if (output) output.textContent = message;
  snapshotCurrent = false;
  snapshotVersion += 1;
  updateActionAvailability();
  // If a previous snapshot was already in flight, wait before starting a post-mutation read.
  if (reconcileFlight) await reconcileFlight;
  const reconciled = await reconcileSnapshot();
  pendingActions.delete(key);
  if (key === 'mode') restoreModeSelection();
  if (owner) { owner.setAttribute('aria-busy', 'false'); owner.dataset.mutationState = success ? 'confirmed' : 'error'; }
  buttons.forEach(function (button, index) { if (button.isConnected) button.innerHTML = labels[index]; });
  if (!reconciled) message += ' State unavailable — use Refresh state before continuing.';
  else if (success && key !== 'create') message = 'Confirmed by ACS. State refreshed.';
  else if (message.startsWith('Outcome uncertain')) message += key === 'create' ? ' Review the Work Queue before allowing another submission.' : ' State refreshed; review the result before choosing another action.';
  if (output && output.isConnected) output.textContent = message;
  else document.querySelector('#state-result').textContent = message;
  if (key !== 'mode' && key !== 'create') mutationMessages.set(key, message);
  if (key === 'create' && uncertainActions.has(key) && reconciled) showCreateRecovery();
  updateActionAvailability();
  return success;
}
function showCreateRecovery() {
  if (document.querySelector('#create-recovery')) return;
  const button = document.createElement('button'); button.type = 'button'; button.id = 'create-recovery';
  button.textContent = 'I reviewed the Work Queue — allow another submission';
  button.onclick = function () { uncertainActions.delete('create'); button.remove(); updateActionAvailability(); };
  document.querySelector('#task-form').appendChild(button);
}
document.querySelectorAll('[data-execution-mode]').forEach(function (input) { input.addEventListener('change', updateActionAvailability); });
document.querySelector('#execution-mode-apply').addEventListener('click', async function () {
  if (!snapshotCurrent || !sseConnected || pendingActions.has('mode')) return;
  const input = document.querySelector('[data-execution-mode]:checked');
  if (!input || input.value === confirmedMode) return;
  await mutate('mode', '/execution-mode', { mode: input.value, reason: 'operator set ' + input.value + ' from mission control' }, document.querySelector('#execution-mode-result'), 'Applying mode…');
});
document.querySelector('#approvals').addEventListener('click', async function (event) {
  const button = event.target.closest('[data-approve],[data-reject],[data-unblock]');
  if (!button || button.disabled || !snapshotCurrent || !sseConnected) return;
  const id = button.dataset.approve || button.dataset.reject || button.dataset.unblock;
  if (pendingActions.has(id) || uncertainActions.has(id)) return;
  const action = button.dataset.approve ? 'approve' : button.dataset.reject ? 'reject' : 'unblock';
  const card = button.closest('.approval-item');
  const reasonInput = card.querySelector('[data-reason]');
  const reason = reasonInput.value.trim();
  const output = card.querySelector('output');
  reasonInput.removeAttribute('aria-invalid');
  if (action !== 'unblock' && !reason) { output.textContent = 'Reason required for ' + (action === 'reject' ? 'rejection' : 'approval'); reasonInput.setAttribute('aria-invalid', 'true'); reasonInput.focus(); return; }
  const reviewBinding = [button.dataset.actionHash, button.dataset.risk, card.dataset.updatedAt, card.dataset.target].join('|');
  const risk = button.dataset.risk || '';
  if (action !== 'unblock' && isElevatedApprovalRisk(risk)) {
    const confirmed = await requestApprovalConfirm({ workItemId: id, action, actionHash: button.dataset.actionHash, actionKind: button.dataset.actionKind || card.dataset.actions, risk, title: card.querySelector('strong').textContent, target: card.dataset.target, reason });
    if (!confirmed) return;
  }
  // Recheck after the operator's decision: the stream, binding, or selected action may have changed while the modal was open.
  if (!snapshotCurrent || !sseConnected || reviewBinding !== [button.dataset.actionHash, button.dataset.risk, card.dataset.updatedAt, card.dataset.target].join('|') || !button.isConnected || button.disabled) { output.textContent = 'State changed during review. Review the refreshed action and try again.'; return; }
  const payload = action === 'unblock' ? {} : { reason };
  if (action === 'approve') {
    if (!button.dataset.actionHash) { output.textContent = 'Approval action hash unavailable'; return; }
    payload.actionHash = button.dataset.actionHash;
  }
  await mutate(id, '/work-items/' + encodeURIComponent(id) + '/' + action, payload, output, action === 'approve' ? 'Approving…' : action === 'reject' ? 'Rejecting…' : 'Unblocking…');
});
document.querySelector('#task-form').addEventListener('submit', async function (event) {
  event.preventDefault();
  if (pendingActions.has('create') || uncertainActions.has('create')) return;
  const formElement = event.currentTarget;
  if (!formElement.reportValidity()) return;
  const form = new FormData(formElement);
  const service = String(form.get('service') || '').trim();
  const payload = {
    title: String(form.get('title') || '').trim(), intent: String(form.get('intent') || '').trim(),
    risk: String(form.get('risk') || 'medium'), target: service ? { services: [service] } : {},
    requestedActions: [{ kind: String(form.get('actionKind') || '').trim() || 'agent.prompt', description: String(form.get('actionDescription') || '').trim() || 'Dispatch prompt to selected agent', params: {} }]
  };
  for (const field of ['title', 'intent']) {
    const input = formElement.elements.namedItem(field);
    input.removeAttribute('aria-invalid');
    if (!payload[field]) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', 'task-result'); document.querySelector('#task-result').textContent = field + ' must not be blank.'; input.focus(); return; }
  }
  await mutate('create', '/work-items', payload, document.querySelector('#task-result'), 'Creating work item…');
});
const viewAliases = { overview: 'overview', queue: 'queue', execution: 'execution', visualizer: 'visualizer', approvals: 'approvals', agents: 'agents', connectors: 'connectors', 'operator-metrics': 'metrics', metrics: 'metrics', events: 'audit', audit: 'audit', policy: 'policy', system: 'system', dispatch: 'dispatch' };
const viewTitles = { overview: 'Overview', queue: 'Work Queue', execution: 'Execution', visualizer: 'Visualizer', approvals: 'Approvals', agents: 'Agents', connectors: 'Connectors', metrics: 'Operator metrics', audit: 'Audit', policy: 'Policy', system: 'System', dispatch: 'New work item' };
const viewDescriptions = { overview: 'What needs your attention?', queue: 'Authoritative work-item queue', execution: 'Plans, attempts, and lease authority', visualizer: 'Canonical Visualizer execution graph projected from ACS lifecycle evidence', approvals: 'Human decisions and blocked work', agents: 'Registered and observed agent state', connectors: 'Connector and tunnel state', metrics: 'Operational control-plane metrics', audit: 'Append-only recent audit window', policy: 'Recent policy decisions', system: 'Readiness and authority state', dispatch: 'Create a policy-governed work item' };
function currentView() { return viewAliases[(location.hash || '#overview').slice(1).split(/[?&]/)[0]] || 'overview'; }
let systemProbeLoaded = false;
let systemProbePending = false;
async function loadSystemProbe() {
  if (systemProbePending) return;
  systemProbePending = true;
  const root = document.querySelector('#system-probes');
  const button = document.querySelector('#system-refresh');
  button.disabled = true;
  root.setAttribute('aria-busy', 'true');
  freshness('system', 'stale', 'Loading readiness…');
  const started = performance.now();
  try {
    const response = await fetchWithTimeout('/readyz', { headers: { accept: 'application/json' }, cache: 'no-store' });
    const status = response.ok ? 'Ready' : response.status === 401 || response.status === 403 ? 'Unavailable — session or permission required' : 'Not ready';
    root.textContent = status + ' · HTTP ' + response.status + ' · ' + Math.round(performance.now() - started) + ' ms';
    freshness('system', response.ok ? 'current' : 'unavailable', status + ' — checked ' + new Date().toLocaleTimeString(undefined, { timeZoneName: 'short' }));
    systemProbeLoaded = true;
  } catch { root.textContent = 'Readiness unavailable — Retry'; freshness('system', 'unavailable'); }
  finally { systemProbePending = false; button.disabled = false; root.setAttribute('aria-busy', 'false'); }
}
function showView(name, keyboard) {
  const view = viewAliases[name] || 'overview';
  document.body.dataset.activeView = view;
  document.querySelectorAll('[data-view-panel], [data-view-section]').forEach(function (node) { const views = node.dataset.viewPanel || node.dataset.viewSection; node.hidden = !views.split(' ').includes(view); });
  document.querySelectorAll('nav a[data-nav]').forEach(function (link) {
    link.classList.toggle('active', link.dataset.nav === view);
    if (link.dataset.nav === view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  const heading = document.querySelector('#view-heading'); heading.textContent = viewTitles[view];
  document.title = viewTitles[view] + ' · ACS Mission Control';
  document.querySelector('#view-description').textContent = viewDescriptions[view] || 'ACS operator control plane';
  document.querySelector('#queue-heading').textContent = view === 'execution' ? 'Execution — plans, attempts, and leases' : 'Work Queue';
  document.querySelector('#execution-help').hidden = view !== 'execution';
  applyQueueFilterClient(readQueueFilterFromDom());
  if (view === 'system' && !systemProbeLoaded) void loadSystemProbe();
  if (view === 'overview' || view === 'visualizer') void loadVisualizerStatus(false);
  if (view === 'visualizer') void loadVisualizerProjection(false);
  if (keyboard) heading.focus({ preventScroll: false });
}
document.addEventListener('click', function (event) {
  const link = event.target.closest('a[data-nav],a[data-count-nav]');
  if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button > 0) return;
  event.preventDefault();
  const view = link.dataset.countNav || link.dataset.nav;
  const url = new URL(location.href);
  if (link.hasAttribute('data-count-nav')) {
    url.searchParams.delete('status');
    if (link.dataset.countStatus) url.searchParams.set('status', link.dataset.countStatus);
    url.searchParams.delete('q'); url.searchParams.delete('agent'); url.searchParams.delete('text');
  }
  url.hash = view;
  history.pushState(null, '', url.pathname + url.search + url.hash);
  syncQueueFilterControls(parseQueueFilterFromLocation());
  showView(view, event.detail === 0);
});
function submitGlobalSearch() {
  const input = document.querySelector('#global-search');
  if (!input) return;
  const query = input.value.trim();
  const url = new URL(location.href);
  url.searchParams.delete('status');
  url.searchParams.delete('agent');
  url.searchParams.delete('text');
  if (query) url.searchParams.set('q', query); else url.searchParams.delete('q');
  url.hash = 'queue';
  history.pushState(null, '', url.pathname + url.search + url.hash);
  syncQueueFilterControls(parseQueueFilterFromLocation());
  showView('queue', false);
  document.querySelector('#queue-filter-text')?.focus({ preventScroll: false });
}
const globalSearch = document.querySelector('#global-search');
if (globalSearch) {
  globalSearch.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') { event.preventDefault(); submitGlobalSearch(); }
  });
}
document.addEventListener('keydown', function (event) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    document.querySelector('#global-search')?.focus();
  }
});
function restoreLocation() { syncQueueFilterControls(parseQueueFilterFromLocation()); showView(currentView(), false); }
window.addEventListener('popstate', restoreLocation);
window.addEventListener('hashchange', restoreLocation);
document.querySelector('[data-clear-filters]').addEventListener('click', function () { const filter = { statuses: [], agentId: '', text: '' }; syncQueueFilterControls(filter); writeQueueFilterToLocation(filter); applyQueueFilterClient(filter); document.querySelector('#queue-filter-text').focus(); });
document.querySelector('[data-refresh]').addEventListener('click', async function () { scheduleRefresh(); if (reconcileFlight) await reconcileFlight; const ok = await reconcileSnapshot(); if (ok && uncertainActions.has('create')) showCreateRecovery(); });
document.querySelector('#system-refresh').addEventListener('click', loadSystemProbe);
document.querySelector('#visualizer-refresh').addEventListener('click', function () { void loadVisualizerStatus(true); void loadVisualizerProjection(true); });
['#visualizer-filter-text', '#visualizer-filter-runtime', '#visualizer-filter-state'].forEach(function (selector) {
  const control = document.querySelector(selector);
  if (control) control.addEventListener(selector === '#visualizer-filter-text' ? 'input' : 'change', applyVisualizerFilter);
});
document.querySelector('#audit-follow').addEventListener('change', function (event) { auditFollowing = event.target.checked; if (auditFollowing) flushAudit(); });
document.querySelector('#audit-new').addEventListener('click', flushAudit);
document.querySelector('#events').addEventListener('toggle', function (event) { if (event.target.tagName === 'DETAILS' && event.target.open) { auditFollowing = false; document.querySelector('#audit-follow').checked = false; } }, true);
window.addEventListener('scroll', function () { if (currentView() === 'audit' && window.scrollY > 80 && auditFollowing) { auditFollowing = false; document.querySelector('#audit-follow').checked = false; } }, { passive: true });
const freshnessTimer = setInterval(function () {
  document.querySelectorAll('.timeline time[datetime]').forEach(function (node) { const date = new Date(node.dateTime); if (Number.isFinite(date.getTime())) node.textContent = relativeTime(date.getTime()) + ' · ' + date.toLocaleString(undefined, { timeZoneName: 'short' }); });
  document.querySelectorAll('[data-freshness][data-updated]').forEach(function (node) { if (node.dataset.state === 'current') node.textContent = 'Current — updated ' + relativeTime(Number(node.dataset.updated)); });
  const dataStatus = document.querySelector('#data-current-status');
  if (dataStatus?.dataset.updated) dataStatus.textContent = 'Current · ' + relativeTime(Number(dataStatus.dataset.updated));
}, 1000);
const reconcileTimer = setInterval(function () {
  if (document.visibilityState !== 'hidden') {
    scheduleRefresh();
    const view = currentView();
    if (view === 'system') void loadSystemProbe();
    void loadVisualizerStatus(true);
    if (view === 'visualizer') void loadVisualizerProjection(true);
  }
}, 30000);
window.addEventListener('offline', function () { applySseConnectionState(document, false); if (sseSource) sseSource.close(); });
window.addEventListener('online', function () { connectSse(); });
document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') scheduleRefresh(); });
window.addEventListener('pagehide', function () { if (sseSource) sseSource.close(); clearInterval(freshnessTimer); clearInterval(reconcileTimer); clearTimeout(refreshTimer); clearTimeout(sseReconnectTimer); });
bindQueueFilter();
bindWorkItems();
bindAgentRows();
showView(currentView(), false);
void loadVisualizerStatus(false);
updateActionAvailability();
connectSse();
`;
}
