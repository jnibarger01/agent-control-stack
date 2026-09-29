import { CONFIRM_COPY } from "./approval-actions.js";
import { auditTimelineClientSource } from "./audit-timeline.js";
import { composerClientSource } from "./composer.js";
import { liveDashboardClientSource } from "./live-dashboard.js";
import { operatorWorkflowClientSource } from "./operator-workflow.js";
import { WORK_ITEM_RISK_VALUES } from "./queue-filter.js";
import { redactionClientSource } from "./redaction.js";
import { systemProbesClientSource } from "./system-probes.js";
import { ADMIN_MODE_BANNER_TEXT } from "./types.js";
import { auditRowsClientSource, metricsClientSource, themeClientSource } from "./visibility.js";
import { workItemControlsClientSource } from "./work-item-controls.js";

export function clientScript(): string {
  return `
let sseSource = null;
let sseReconnectAttempt = 0;
let sseReconnectTimer = null;
let sseEverOpened = false;
let sseConnected = false;
let sseReconnectAt = 0;
let serverClockOffsetMs = 0;
let leaseWarningTimer = null;
let leaseWarningRoot = null;
// Largest round trip for which an HTTP Date sample is trusted. Slower
// responses may have been queued in transit, so their Date header no longer
// reflects the observation time; adopting it would drag the projected server
// clock backwards by the delay.
const SERVER_CLOCK_MAX_RTT_MS = 10000;
const sseEventNames = [
  'work_item.created',
  'work_item.pending_policy',
  'work_item.needs_approval',
  'work_item.approved',
  'work_item.running',
  'work_item.blocked',
  'work_item.failed',
  'work_item.succeeded',
  'work_item.cancelled',
  'work_item.rejected',
  'work_item.cancelling',
  'work_item.unknown',
  'work_item.quarantined',
  'work_item.retried',
  'work_item.cloned',
  'agent.created',
  'agent.updated',
  'agent.heartbeat',
  'agent.capabilities_replaced',
  'connector.registered',
  'connector.key_rotated',
  'tunnel_session.registered',
  'tunnel_session.revoked',
  'tunnel_session.reconciled',
  'desktop_commander.runtime_activated',
  'acp.initialized',
  'acp.disconnected',
  'acp.error',
  'tunnel_session.heartbeat',
  'execution_attempt.created',
  'execution_attempt.transitioned',
  'execution_attempt.result_accepted',
  'attempt_lease.issued',
  'attempt_lease.renewed',
  'attempt_lease.stolen',
  'attempt_lease.expired'
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
  root.querySelectorAll('[data-approve],[data-reject],[data-unblock],[data-work-control]').forEach(function (button) {
    const approveWithoutHash = Boolean(button.dataset.approve) && !button.dataset.actionHash;
    button.disabled = !connected || approveWithoutHash;
  });
  renderLiveStatus();
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
    const reconnected = sseEverOpened && !sseConnected;
    sseReconnectAttempt = 0;
    sseReconnectAt = 0;
    sseEverOpened = true;
    applySseConnectionState(document, true);
    // Events may have been missed while the stream was down (or before it
    // first opened): catch up by re-fetching sections instead of reloading.
    scheduleDashboardRefresh(0, { catchUp: reconnected });
    if (reconnected) {
      refreshAgentRoster();
      refreshExecutorRoster();
      refreshConnectorRoster();
      if (selectedAgentId) loadAgentDetail(selectedAgentId);
      if (selectedExecutorId) loadExecutorDetail(selectedExecutorId);
      if (selectedConnectorId) loadConnectorDetail(selectedConnectorId);
      announce('Live stream reconnected');
      if (selectedWorkItemId) void loadWorkDetail(selectedWorkItemId, { preserve: true });
    }
  });
  sseSource.addEventListener('error', function () {
    if (sseSource) {
      sseSource.close();
      sseSource = null;
    }
    if (!sseReconnectTimer) {
      const delay = nextSseReconnectDelayMs(sseReconnectAttempt);
      sseReconnectAttempt += 1;
      sseReconnectAt = Date.now() + delay;
      sseReconnectTimer = setTimeout(function () {
        sseReconnectTimer = null;
        connectSse();
      }, delay);
    }
    applySseConnectionState(document, false);
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
  if (!data.name) data.name = event.type;
  insertLiveTimelineEvent(data);
  if (data.name === 'work_item.needs_approval') notifyApprovalNeeded(data);
  const eventName = String(data.name || event.type || '');
  onLiveAuditEvent(eventName, data);
  if (eventName.startsWith('agent.') || eventName.startsWith('acp.')) {
    refreshAgentRoster();
    if (selectedAgentId) loadAgentDetail(selectedAgentId);
  }
  if (eventName === 'desktop_commander.runtime_activated') {
    refreshExecutorRoster();
    if (selectedExecutorId) loadExecutorDetail(selectedExecutorId);
  }
  if (eventName.startsWith('connector.') || eventName.startsWith('tunnel_session.')) {
    refreshConnectorRoster();
    if (selectedConnectorId) loadConnectorDetail(selectedConnectorId);
  }
}

let selectedAgentId = null;
let selectedExecutorId = null;
let selectedConnectorId = null;
let agentRosterAgents = [];

function escapeClient(value) {
  return String(value ?? '').replace(/[&<>"']/g, function (char) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] || char;
  });
}

${redactionClientSource()}
${workItemControlsClientSource()}
${liveDashboardClientSource()}
${auditTimelineClientSource()}
${systemProbesClientSource()}
${operatorWorkflowClientSource()}
${auditRowsClientSource()}
${metricsClientSource()}
${themeClientSource()}
function onDashboardFragmentsApplied() {
  updateTitleBadge();
  refreshWaitBadges();
  if (document.body.dataset.activeView === 'connectors') refreshConnectorRoster();
}
function onWorkItemControlSucceeded(control, id, body) {
  const created = body && body.workItem && body.workItem.id;
  announce(control === 'cancel' ? 'Cancel accepted for ' + id : control + ' created ' + (created || 'a new work item'));
  scheduleDashboardRefresh(0);
  if (selectedWorkItemId) void loadWorkDetail(selectedWorkItemId, { preserve: true });
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

function observeServerClock(res, requestStartedMs) {
  const raw = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('date') : null;
  const serverMs = Date.parse(raw || '');
  if (!Number.isFinite(serverMs)) return;
  const receivedMs = Date.now();
  const startMs = Number.isFinite(requestStartedMs) && requestStartedMs <= receivedMs ? requestStartedMs : receivedMs;
  const roundTripMs = receivedMs - startMs;
  // A stale sample is worse than none: keep the previous offset (which starts
  // at the local clock) instead of adopting a Date header that arrived late.
  if (roundTripMs > SERVER_CLOCK_MAX_RTT_MS) return;
  // Assume the server stamped Date halfway through the request so a slow (but
  // still trusted) response cannot skew the projection by the full round trip.
  serverClockOffsetMs = serverMs - startMs - roundTripMs / 2;
}

function serverNowMs() {
  return Date.now() + serverClockOffsetMs;
}

function fetchJson(url) {
  const requestStartedMs = Date.now();
  return fetch(url, { headers: { accept: 'application/json' } }).then(async function (res) {
    observeServerClock(res, requestStartedMs);
    const body = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      throw new Error(body.error || body.code || ('HTTP ' + res.status));
    }
    return body;
  });
}

function bindWorkItems() {
  // Delegated: queue items are replaced by live fragment patches.
  document.addEventListener('click', function (event) {
    const button = event.target && event.target.closest ? event.target.closest('[data-work-item]') : null;
    if (!button) return;
    selectWorkItem(button.dataset.workItem);
  });
}

let workDetailGeneration = 0;
async function loadWorkDetail(id, options) {
  const target = document.querySelector('#work-detail');
  if (!target || !id) return;
  const generation = ++workDetailGeneration;
  const preserve = Boolean(options && options.preserve);
  const reasonInput = preserve ? target.querySelector('[data-control-reason]') : null;
  const reason = reasonInput ? reasonInput.value : '';
  const output = preserve ? target.querySelector('.approval-result') : null;
  const outputText = output ? output.textContent : '';
  const active = document.activeElement;
  const activeId = preserve && active && active.id && target.contains(active) ? active.id : null;
  if (!preserve) {
    stopLeaseExpiryWarningRefresh();
    target.innerHTML = '<div class="detail-loading">Loading work item...</div>';
  }
  try {
    const body = await fetchJson('/work-items/' + encodeURIComponent(id));
    // Drop responses superseded by a newer load, even for the same item.
    if (generation !== workDetailGeneration || selectedWorkItemId !== id) return;
    renderWorkDetail(target, body.workItem, body.events || [], body.executionAttempts || [], body.attemptLeases || []);
    if (!preserve) {
      if (!options || options.focusDetail !== false) target.focus({ preventScroll: false });
      return;
    }
    const nextReason = target.querySelector('[data-control-reason]');
    if (nextReason && reason) nextReason.value = reason;
    const nextOutput = target.querySelector('.approval-result');
    if (nextOutput && outputText) nextOutput.textContent = outputText;
    const nextActive = activeId ? document.getElementById(activeId) : null;
    if (nextActive) nextActive.focus({ preventScroll: true });
  } catch (error) {
    if (preserve || generation !== workDetailGeneration) return;
    target.innerHTML = '<div class="detail-error" role="alert">' + escapeClient(error.message) + '</div>';
    target.focus({ preventScroll: false });
  }
}

function agentRoleLabelClient(role) {
  if (!role) return 'Role not reported';
  return String(role).toLowerCase().split('_').map(function (part) {
    return part.charAt(0).toUpperCase() + part.slice(1);
  }).join(' ');
}

function agentAttentionRankClient(agent) {
  if (agent.lastError) return 0;
  if (agent.status === 'stale') return 1;
  if (agent.status === 'online' && agent.currentTask) return 2;
  if (agent.status === 'online') return 3;
  if (agent.status === 'observed') return 4;
  if (agent.status === 'offline') return 5;
  return 6;
}

function agentNameForSort(agent) {
  return String(agent.displayName || agent.name || agent.id || '').toLowerCase();
}

function sortAgentRosterClient(agents, attentionFirst) {
  return agents.slice().sort(function (left, right) {
    if (attentionFirst) {
      const rank = agentAttentionRankClient(left) - agentAttentionRankClient(right);
      if (rank !== 0) return rank;
    }
    const name = agentNameForSort(left).localeCompare(agentNameForSort(right));
    return name || String(left.id || '').localeCompare(String(right.id || ''));
  });
}

function agentSearchText(agent) {
  const metadata = agent.metadata || {};
  return [
    agent.displayName,
    agent.name,
    agent.id,
    agent.kind,
    metadata.acpRole,
    agentRoleLabelClient(metadata.acpRole),
    metadata.provider,
    metadata.model,
    agent.currentTask,
    agent.lastError,
    ...(Array.isArray(agent.capabilities) ? agent.capabilities : [])
  ].filter(Boolean).join(' ').toLowerCase();
}

function readAgentDiscoveryState() {
  const search = document.querySelector('#agent-search');
  const role = document.querySelector('#agent-role-filter');
  const status = document.querySelector('#agent-status-filter');
  const attention = document.querySelector('#agent-attention-first');
  return {
    search: search ? String(search.value || '').trim().toLowerCase() : '',
    role: role ? String(role.value || '') : '',
    status: status ? String(status.value || '') : '',
    attentionFirst: attention ? Boolean(attention.checked) : true
  };
}

function filterAgentRosterClient(agents, state) {
  const terms = state.search.split(' ').filter(Boolean);
  return agents.filter(function (agent) {
    const metadata = agent.metadata || {};
    if (state.role && metadata.acpRole !== state.role) return false;
    if (state.status && agent.status !== state.status) return false;
    if (!terms.length) return true;
    const haystack = agentSearchText(agent);
    return terms.every(function (term) { return haystack.includes(term); });
  });
}

function syncAgentRoleOptions(agents) {
  const select = document.querySelector('#agent-role-filter');
  if (!select) return;
  const selected = select.value;
  const roles = Array.from(new Set(agents.map(function (agent) {
    return agent.metadata && agent.metadata.acpRole;
  }).filter(Boolean))).sort(function (left, right) {
    return agentRoleLabelClient(left).localeCompare(agentRoleLabelClient(right));
  });
  select.innerHTML = '<option value="">All roles</option>' + roles.map(function (role) {
    return '<option value="' + escapeClient(role) + '">' + escapeClient(agentRoleLabelClient(role)) + '</option>';
  }).join('');
  if (roles.includes(selected)) select.value = selected;
}

function agentSummaryMarkup(agents) {
  const online = agents.filter(function (agent) { return agent.status === 'online'; }).length;
  const activeTasks = agents.filter(function (agent) { return Boolean(agent.currentTask); }).length;
  const unavailable = agents.filter(function (agent) { return agent.status === 'stale' || agent.status === 'offline'; }).length;
  return '<div class="agent-summary" id="agent-summary">' +
    '<div><span>Registered</span><strong>' + agents.length + '</strong></div>' +
    '<div><span>Online</span><strong>' + online + '</strong></div>' +
    '<div><span>Active tasks</span><strong>' + activeTasks + '</strong></div>' +
    '<div><span>Stale / offline</span><strong>' + unavailable + '</strong></div>' +
  '</div>';
}

function agentCardsMarkup(agents) {
  return agents.map(function (agent) {
    const id = escapeClient(agent.id);
    const name = escapeClient(agent.displayName || agent.name || agent.id);
    const metadata = agent.metadata || {};
    const role = escapeClient(agentRoleLabelClient(metadata.acpRole));
    const attentionClass = agent.lastError ? ' has-error' : agent.status === 'stale' ? ' is-stale' : '';
    const providerModel = [metadata.provider, metadata.model].filter(Boolean).join(' · ');
    const runtime = escapeClient(providerModel ? ((agent.kind || '—') + ' · ' + providerModel) : (agent.kind || '—'));
    const initial = escapeClient(String(agent.displayName || agent.name || agent.id || '?').trim().charAt(0).toUpperCase() || '?');
    const task = escapeClient(agent.currentTask || 'No active task reported');
    const heartbeat = agent.lastHeartbeatAt ? ('Heartbeat ' + formatClientTime(agent.lastHeartbeatAt)) : 'No heartbeat observed';
    const capabilityCount = Array.isArray(agent.capabilities) ? agent.capabilities.length : 0;
    const error = agent.lastError ? '<span class="agent-card-error">' + escapeClient(redactClient(agent.lastError)) + '</span>' : '';
    return '<button type="button" class="agent-card' + attentionClass + '" data-agent="' + id + '" data-agent-id="' + id + '" data-agent-role="' + escapeClient(metadata.acpRole || '') + '" data-agent-status="' + escapeClient(agent.status || '') + '" aria-label="Open ' + name + '">' +
      '<span class="agent-card-head">' +
        '<span class="agent-avatar" aria-hidden="true">' + initial + '</span>' +
        '<span class="agent-card-identity"><strong>' + name + '</strong><small>' + id + '</small></span>' +
        pillMarkup(agent.status || 'observed') +
      '</span>' +
      '<span class="agent-card-meta"><span>' + role + '</span><span>' + runtime + '</span></span>' +
      '<span class="agent-card-task"><small>Current task</small><span>' + task + '</span></span>' +
      error +
      '<span class="agent-card-foot"><span>' + escapeClient(heartbeat) + '</span><span>' + capabilityCount + ' capabilit' + (capabilityCount === 1 ? 'y' : 'ies') + '</span></span>' +
    '</button>';
  }).join('');
}

function renderAgentTable(agents) {
  const summary = document.querySelector('#agent-summary');
  const grid = document.querySelector('#agent-roster-body');
  if (!summary || !grid) return;
  summary.outerHTML = agentSummaryMarkup(agentRosterAgents);
  grid.innerHTML = agentCardsMarkup(agents);
  bindAgentRows();
}

function bindAgentRows() {
  document.querySelectorAll('[data-agent]').forEach(function (card) {
    card.addEventListener('click', function () {
      selectedAgentId = card.dataset.agent;
      document.querySelectorAll('[data-agent]').forEach(function (candidate) { candidate.classList.remove('selected'); });
      card.classList.add('selected');
      loadAgentDetail(selectedAgentId);
    });
  });
}

function applyAgentDiscovery() {
  const state = readAgentDiscoveryState();
  const filtered = filterAgentRosterClient(agentRosterAgents, state);
  const visible = sortAgentRosterClient(filtered, state.attentionFirst);
  const grid = document.querySelector('#agent-roster-body');
  if (grid && !visible.length) {
    const message = agentRosterAgents.length ? 'No agents match the current filters.' : 'No registered agents.';
    grid.innerHTML = '<p class="empty agent-empty">' + message + '</p>';
    const summary = document.querySelector('#agent-summary');
    if (summary) summary.outerHTML = agentSummaryMarkup(agentRosterAgents);
  } else {
    renderAgentTable(visible);
  }

  if (selectedAgentId) {
    document.querySelectorAll('[data-agent]').forEach(function (card) {
      if (card.dataset.agent === selectedAgentId) card.classList.add('selected');
    });
  }

  const count = document.querySelector('#agent-count');
  const filteredState = Boolean(state.search || state.role || state.status);
  if (count) {
    count.textContent = filteredState
      ? (visible.length + ' of ' + agentRosterAgents.length + ' agents')
      : (agentRosterAgents.length + ' registered');
  }
  const live = document.querySelector('#agent-filter-live');
  if (live) {
    const ordering = state.attentionFirst ? 'attention first' : 'name order';
    live.textContent = filteredState
      ? ('Showing ' + visible.length + ' of ' + agentRosterAgents.length + ' agents · ' + ordering)
      : ('Showing all ' + agentRosterAgents.length + ' agents · ' + ordering);
  }
  return visible;
}

function bindAgentDiscovery() {
  const root = document.querySelector('#agent-discovery');
  if (!root) return;
  const apply = function () { applyAgentDiscovery(); };
  const search = document.querySelector('#agent-search');
  const role = document.querySelector('#agent-role-filter');
  const status = document.querySelector('#agent-status-filter');
  const attention = document.querySelector('#agent-attention-first');
  const clear = document.querySelector('#agent-filter-clear');
  if (search) search.addEventListener('input', apply);
  if (role) role.addEventListener('change', apply);
  if (status) status.addEventListener('change', apply);
  if (attention) attention.addEventListener('change', apply);
  if (clear) clear.addEventListener('click', function () {
    if (search) search.value = '';
    if (role) role.value = '';
    if (status) status.value = '';
    if (attention) attention.checked = true;
    applyAgentDiscovery();
    if (search) search.focus();
  });
}

async function refreshAgentRoster() {
  try {
    const body = await fetchJson('/agents');
    const agents = Array.isArray(body.agents) ? body.agents : [];
    agentRosterAgents = agents;
    syncAgentRoleOptions(agents);
    applyAgentDiscovery();
    if (selectedAgentId && !agents.some(function (agent) { return agent.id === selectedAgentId; })) {
      selectedAgentId = null;
      const detail = document.querySelector('#agent-detail');
      if (detail) {
        detail.innerHTML = '<div class="detail-empty"><h3>No agent selected</h3><p>Select an agent card to inspect identity, activity, sessions, and capabilities.</p></div>';
      }
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
    const detail = await fetchJson('/api/agents/' + encodeURIComponent(id));
    renderAgentDetail(target, detail);
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
  const agent = detail.agent || {};
  const activity = detail.activity || {};
  const capabilities = Array.from(new Set(capabilityNames(agent.capabilities || []))).sort();
  const sessions = Array.isArray(detail.sessions) ? detail.sessions : [];
  const adapter = detail.adapterStatus ? (detail.adapterStatus.state || detail.adapterStatus.status || 'connected') : 'not configured';
  const status = agent.effectiveStatus || agent.status || 'UNKNOWN';
  target.innerHTML = '<div class="detail-head"><div><h3>' + escapeClient(agent.name || agent.id || 'Agent') + '</h3><small>' + escapeClient(agent.id || '') + '</small></div><div>' + pillMarkup(status) + '</div></div>' +
    '<dl class="detail-grid">' +
      detailRow('Role', agent.acpRole) +
      detailRow('Runtime', agent.kind) +
      detailRow('Provider', agent.provider) +
      detailRow('Model', agent.model) +
      detailRow('Current task', activity.currentTask || (agent.latestHeartbeat && agent.latestHeartbeat.currentTask)) +
      detailRow('Current work item', activity.currentWorkItemId) +
      detailRow('Current ACP session', activity.currentSessionId) +
      detailRow('Active ACP sessions', activity.activeSessionCount) +
      detailRow('Last heartbeat', formatClientTime(agent.lastHeartbeatAt)) +
      detailRow('Last activity', formatClientTime(activity.lastActivityAt)) +
      detailRow('Adapter', adapter) +
      detailRow('Endpoint', agent.endpoint ? redactClient(agent.endpoint) : undefined) +
    '</dl>' +
    '<div class="detail-section"><h4>Agent capabilities</h4>' + capabilityList(capabilities) + '</div>' +
    '<div class="detail-section"><h4>Recent ACP sessions</h4>' + agentSessionTable(sessions) + '</div>' +
    '<div class="detail-section"><h4>Recent agent events</h4>' + eventList(detail.events || []) + '</div>';
}

function agentSessionTable(sessions) {
  if (!sessions.length) return '<p class="muted">No ACP sessions observed.</p>';
  return '<div class="table-wrap"><table class="agent-table agent-session-table"><thead><tr><th>Session</th><th>Status</th><th>Work item</th><th>Last event</th><th>Activity</th></tr></thead><tbody>' +
    sessions.map(function (session) {
      return '<tr><td>' + escapeClient(session.sessionId || '—') + '</td>' +
        '<td>' + pillMarkup(session.status || 'unknown') + '</td>' +
        '<td>' + escapeClient(session.workItemId || '—') + '</td>' +
        '<td>' + escapeClient(session.lastEventType || '—') + '</td>' +
        '<td>' + escapeClient(formatClientTime(session.lastEventAt)) + '</td></tr>';
    }).join('') + '</tbody></table></div>';
}

function executorRowsMarkup(executors) {
  return executors.map(function (executor) {
    const id = escapeClient(executor.id);
    return '<tr class="agent-row executor-row" tabindex="0" data-executor="' + id + '">' +
      '<td><strong>' + escapeClient(executor.displayName || executor.id) + '</strong><small>' + id + '</small></td>' +
      '<td>' + escapeClient(executor.contract || '—') + '</td>' +
      '<td>' + pillMarkup(executor.status || 'unknown') + '</td>' +
      '<td>' + escapeClient(executor.runtimeId || '—') + '</td>' +
      '<td>' + escapeClient(String(executor.capabilityCount || 0)) + '</td>' +
      '<td>' + escapeClient(String(executor.unsupportedToolCount || 0)) + '</td>' +
    '</tr>';
  }).join('');
}

function renderExecutorTable(executors) {
  const wrap = document.querySelector('#executors .table-wrap');
  if (!wrap) return;
  if (!executors.length) {
    wrap.innerHTML = '<p class="empty">No managed executors configured.</p>';
    return;
  }
  wrap.innerHTML = '<table class="agent-table executor-table"><thead><tr><th>Executor</th><th>Contract</th><th>Status</th><th>Runtime</th><th>Capabilities</th><th>Unsupported</th></tr></thead><tbody>' + executorRowsMarkup(executors) + '</tbody></table>';
  bindExecutorRows();
}

function bindExecutorRows() {
  document.querySelectorAll('[data-executor]').forEach(function (row) {
    const activate = function () {
      selectedExecutorId = row.dataset.executor;
      document.querySelectorAll('[data-executor]').forEach(function (candidate) { candidate.classList.remove('selected'); });
      row.classList.add('selected');
      loadExecutorDetail(selectedExecutorId);
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

async function refreshExecutorRoster() {
  try {
    const body = await fetchJson('/api/executors');
    const executors = Array.isArray(body.executors) ? body.executors : [];
    const count = document.querySelector('#executor-count');
    if (count) count.textContent = executors.length + ' managed';
    renderExecutorTable(executors);
    if (selectedExecutorId && executors.some(function (executor) { return executor.id === selectedExecutorId; })) {
      document.querySelectorAll('[data-executor]').forEach(function (row) {
        if (row.dataset.executor === selectedExecutorId) row.classList.add('selected');
      });
    }
  } catch (error) {
    const detail = document.querySelector('#executor-detail');
    if (detail && !selectedExecutorId) {
      detail.innerHTML = '<div class="detail-error">Executor backend unavailable: ' + escapeClient(error.message) + '</div>';
    }
  }
}

async function loadExecutorDetail(id) {
  const target = document.querySelector('#executor-detail');
  if (!target || !id) return;
  target.innerHTML = '<div class="detail-loading">Loading executor detail...</div>';
  try {
    const detail = await fetchJson('/api/executors/' + encodeURIComponent(id));
    const capabilities = await fetchJson('/api/executors/' + encodeURIComponent(id) + '/capabilities');
    renderExecutorDetail(target, detail.executor || {}, detail.runtimes || [], capabilities.capabilities || []);
  } catch (error) {
    target.innerHTML = '<div class="detail-error">' + escapeClient(error.message) + '</div>';
  }
}

function renderExecutorDetail(target, executor, runtimes, capabilities) {
  target.innerHTML = '<div class="detail-head"><div><h3>' + escapeClient(executor.displayName || executor.id || 'Executor') + '</h3><small>' + escapeClient(executor.id || '') + '</small></div><div>' + pillMarkup(executor.status || 'unknown') + '</div></div>' +
    '<dl class="detail-grid">' +
      detailRow('Contract', executor.contract) +
      detailRow('Type', executor.kind) +
      detailRow('Configured', executor.configured ? 'yes' : 'no') +
      detailRow('Runtime', executor.runtimeId) +
      detailRow('Capabilities', executor.capabilityCount) +
      detailRow('Unsupported tools', executor.unsupportedToolCount) +
      detailRow('Attested', formatClientTime(executor.attestedAt)) +
      detailRow('Granted scopes', Array.isArray(executor.scopes) && executor.scopes.length ? executor.scopes.join(', ') : '—') +
    '</dl>' +
    '<div class="detail-section"><h4>Runtime registrations</h4>' + executorRuntimeList(runtimes) + '</div>' +
    '<div class="detail-section"><h4>Tool capabilities</h4>' + executorCapabilityTable(capabilities) + '</div>';
}

function executorRuntimeList(runtimes) {
  if (!Array.isArray(runtimes) || !runtimes.length) return '<p class="muted">No durable runtime registration.</p>';
  return '<ul class="action-list">' + runtimes.map(function (runtime) {
    return '<li><strong>' + escapeClient(runtime.runtimeId || 'runtime') + '</strong><small>' +
      escapeClient((runtime.status || 'unknown') + ' · attested ' + formatClientTime(runtime.attestedAt)) +
      '</small><small>' + escapeClient(Array.isArray(runtime.scopes) ? runtime.scopes.join(', ') : '') + '</small></li>';
  }).join('') + '</ul>';
}

function executorCapabilityTable(capabilities) {
  if (!Array.isArray(capabilities) || !capabilities.length) return '<p class="muted">No tool capabilities declared.</p>';
  return '<div class="table-wrap"><table class="agent-table executor-capability-table"><thead><tr><th>Tool</th><th>Managed</th><th>Scope</th><th>Approval</th><th>Risk</th></tr></thead><tbody>' +
    capabilities.map(function (capability) {
      const scopes = Array.isArray(capability.scopes) ? capability.scopes.join(', ') : '';
      const approval = capability.requiresApproval === undefined ? '—' : capability.requiresApproval ? 'required' : 'not required';
      return '<tr><td><strong>' + escapeClient(capability.name || 'tool') + '</strong><small>' + escapeClient(capability.toolClass || '') + '</small></td>' +
        '<td>' + pillMarkup(capability.managed || 'unknown') + '</td>' +
        '<td>' + escapeClient(scopes || '—') + '</td>' +
        '<td>' + escapeClient(approval) + '</td>' +
        '<td>' + escapeClient(capability.riskClass || '—') + '</td></tr>';
    }).join('') + '</tbody></table></div>';
}

function connectorRowsMarkup(connectors) {
  return connectors.map(function (connector) {
    const id = escapeClient(connector.id);
    const scopes = Array.isArray(connector.allowedScopes) ? connector.allowedScopes.join(', ') : '';
    return '<tr class="agent-row connector-row" tabindex="0" data-connector="' + id + '">' +
      '<td><strong>' + escapeClient(connector.displayName || connector.id) + '</strong><small>' + id + '</small></td>' +
      '<td>' + pillMarkup(connector.status || 'unknown') + '</td>' +
      '<td>' + escapeClient(String(connector.activeSessionCount || 0) + ' / ' + String(connector.sessionCount || 0)) + '</td>' +
      '<td>' + escapeClient(scopes || '—') + '</td>' +
      '<td>' + escapeClient(formatClientTime(connector.lastHeartbeatAt)) + '</td>' +
    '</tr>';
  }).join('');
}

function renderConnectorTable(connectors) {
  const wrap = document.querySelector('#connectors .table-wrap');
  if (!wrap) return;
  if (!connectors.length) {
    wrap.innerHTML = '<p class="empty">No registered connectors.</p>';
    return;
  }
  wrap.innerHTML = '<table class="agent-table connector-table"><thead><tr><th>Connector</th><th>Status</th><th>Active sessions</th><th>Scopes</th><th>Last heartbeat</th></tr></thead><tbody>' + connectorRowsMarkup(connectors) + '</tbody></table>';
  bindConnectorRows();
}

function bindConnectorRows() {
  document.querySelectorAll('[data-connector]').forEach(function (row) {
    const activate = function () {
      selectedConnectorId = row.dataset.connector;
      document.querySelectorAll('[data-connector]').forEach(function (candidate) { candidate.classList.remove('selected'); });
      row.classList.add('selected');
      loadConnectorDetail(selectedConnectorId);
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

async function refreshConnectorRoster() {
  try {
    const body = await fetchJson('/api/connectors');
    const connectors = Array.isArray(body.connectors) ? body.connectors : [];
    const count = document.querySelector('#connector-count');
    if (count) count.textContent = connectors.length + ' registered';
    renderConnectorTable(connectors);
    if (selectedConnectorId && connectors.some(function (connector) { return connector.id === selectedConnectorId; })) {
      document.querySelectorAll('[data-connector]').forEach(function (row) {
        if (row.dataset.connector === selectedConnectorId) row.classList.add('selected');
      });
    }
  } catch (error) {
    const detail = document.querySelector('#connector-detail');
    if (detail && !selectedConnectorId) {
      detail.innerHTML = '<div class="detail-error">Connector backend unavailable: ' + escapeClient(error.message) + '</div>';
    }
  }
}

async function loadConnectorDetail(id) {
  const target = document.querySelector('#connector-detail');
  if (!target || !id) return;
  target.innerHTML = '<div class="detail-loading">Loading connector detail...</div>';
  try {
    const detail = await fetchJson('/api/connectors/' + encodeURIComponent(id));
    renderConnectorDetail(target, detail.connector || {}, detail.sessions || []);
  } catch (error) {
    target.innerHTML = '<div class="detail-error">' + escapeClient(error.message) + '</div>';
  }
}

function renderConnectorDetail(target, connector, sessions) {
  const scopes = Array.isArray(connector.allowedScopes) ? connector.allowedScopes : [];
  target.innerHTML = '<div class="detail-head"><div><h3>' + escapeClient(connector.displayName || connector.id || 'Connector') + '</h3><small>' + escapeClient(connector.id || '') + '</small></div><div>' + pillMarkup(connector.status || 'unknown') + '</div></div>' +
    '<dl class="detail-grid">' +
      detailRow('Active sessions', String(connector.activeSessionCount || 0) + ' / ' + String(connector.sessionCount || 0)) +
      detailRow('Last heartbeat', formatClientTime(connector.lastHeartbeatAt)) +
      detailRow('Next expiry', formatClientTime(connector.nextSessionExpiryAt)) +
      detailRow('Updated', formatClientTime(connector.updatedAt)) +
      detailRow('Public key fingerprint', connector.publicKeyFingerprint ? shortHash(connector.publicKeyFingerprint) : '—') +
    '</dl>' +
    '<div class="detail-section"><h4>Granted scopes</h4>' + capabilityList(scopes) + '</div>' +
    '<div class="detail-section"><h4>Tunnel sessions</h4>' + connectorSessionTable(sessions) + '</div>';
}

function connectorSessionTable(sessions) {
  if (!Array.isArray(sessions) || !sessions.length) return '<p class="muted">No tunnel sessions registered.</p>';
  return '<div class="table-wrap"><table class="agent-table connector-session-table"><thead><tr><th>Tunnel</th><th>Session</th><th>Status</th><th>Heartbeat</th><th>Expires</th></tr></thead><tbody>' +
    sessions.map(function (session) {
      const status = session.effectiveStatus || session.status || 'unknown';
      const reason = session.staleReason ? ' · ' + String(session.staleReason).replaceAll('_', ' ') : '';
      return '<tr><td>' + escapeClient(session.tunnelId || '—') + '</td>' +
        '<td>' + escapeClient(session.sessionId || '—') + '</td>' +
        '<td>' + pillMarkup(status) + '<small>' + escapeClient(reason) + '</small></td>' +
        '<td>' + escapeClient(formatClientTime(session.lastHeartbeatAt)) + '</td>' +
        '<td>' + escapeClient(formatClientTime(session.expiresAt)) + '</td></tr>';
    }).join('') + '</tbody></table></div>';
}

function detailRow(label, value) {
  const shown = value === 0 ? '0' : value || '—';
  return '<div><dt>' + escapeClient(label) + '</dt><dd>' + escapeClient(redactClient(shown)) + '</dd></div>';
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

function shortHash(value) {
  const text = String(value || '');
  return text.length > 16 ? text.slice(0, 12) + '…' : text;
}

// Presentation-only signal. Lease authority remains server-side; this only
// projects the persisted timestamps using the latest observed server clock.
function leaseExpiringSoon(lease, nowMs) {
  if (!lease || lease.status !== 'active') return false;
  const expiresAtMs = Date.parse(lease.expiresAt || '');
  if (!Number.isFinite(expiresAtMs)) return false;
  const currentMs = Number.isFinite(nowMs) ? nowMs : serverNowMs();
  if (expiresAtMs <= currentMs) return false;
  const ttlStartMs = Date.parse(lease.lastRenewedAt || lease.issuedAt || '');
  const observedTtlMs = Number.isFinite(ttlStartMs) ? Math.max(0, expiresAtMs - ttlStartMs) : 0;
  const thresholdMs = Math.max(60 * 1000, 0.2 * observedTtlMs);
  return expiresAtMs - currentMs < thresholdMs;
}

function refreshLeaseExpiryWarnings(root) {
  if (!root) return;
  root.querySelectorAll('[data-lease-expiry]').forEach(function (node) {
    const lease = {
      status: node.dataset.leaseStatus || '',
      issuedAt: node.dataset.leaseIssuedAt || '',
      lastRenewedAt: node.dataset.leaseLastRenewedAt || '',
      expiresAt: node.dataset.leaseExpiresAt || ''
    };
    const warning = node.querySelector('[data-lease-expiry-warning]');
    if (!warning) return;
    const show = leaseExpiringSoon(lease);
    const message = show ? 'expiring soon — warning only' : '';
    // Only touch the live region when the warning state actually transitions:
    // rewriting textContent on every tick re-announces the same warning.
    if (warning.hidden === show || warning.textContent !== message) {
      warning.hidden = !show;
      warning.textContent = message;
    }
  });
}

function clearLeaseWarningTimer() {
  if (leaseWarningTimer) {
    clearInterval(leaseWarningTimer);
    leaseWarningTimer = null;
  }
}

function stopLeaseExpiryWarningRefresh() {
  clearLeaseWarningTimer();
  leaseWarningRoot = null;
}

function leaseWarningTick() {
  if (!leaseWarningRoot || !leaseWarningRoot.isConnected) {
    stopLeaseExpiryWarningRefresh();
    return;
  }
  refreshLeaseExpiryWarnings(leaseWarningRoot);
}

// The work-item detail panel is only visible while the queue or execution
// view is active. Pause the refresh while it is hidden and resume on return
// so an off-screen detail never keeps refreshing.
function leaseWarningViewActive() {
  const view = document.body.dataset.activeView;
  return (view === 'queue' || view === 'execution') && document.visibilityState !== 'hidden';
}

function syncLeaseExpiryWarningRefresh() {
  if (!leaseWarningRoot || !leaseWarningRoot.isConnected || !leaseWarningRoot.querySelector('[data-lease-expiry]')) {
    stopLeaseExpiryWarningRefresh();
    return;
  }
  if (leaseWarningViewActive()) {
    if (!leaseWarningTimer) {
      leaseWarningTick();
      leaseWarningTimer = setInterval(leaseWarningTick, 5000);
    }
  } else {
    clearLeaseWarningTimer();
  }
}

function scheduleLeaseExpiryWarningRefresh(root) {
  stopLeaseExpiryWarningRefresh();
  leaseWarningRoot = root || null;
  syncLeaseExpiryWarningRefresh();
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
    const expiring = leaseExpiringSoon(lease);
    const warning = '<span class="pill warning lease-expiry-warning" role="status" data-lease-expiry-warning' + (expiring ? '' : ' hidden') + '>' + (expiring ? 'expiring soon — warning only' : '') + '</span>';
    const leaseMarkup = lease
      ? '<div class="lease-block" data-lease-expiry data-lease-status="' + escapeClient(lease.status || '') + '" data-lease-issued-at="' + escapeClient(lease.issuedAt || '') + '" data-lease-last-renewed-at="' + escapeClient(lease.lastRenewedAt || '') + '" data-lease-expires-at="' + escapeClient(lease.expiresAt || '') + '"><div class="lease-head"><strong>Lease ' + escapeClient(lease.leaseId) + '</strong>' + pillMarkup(lease.status || 'unknown') + warning + '</div><dl class="detail-grid compact">' +
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
    return '<article class="execution-card"><div class="execution-head"><div><strong>Attempt #' + escapeClient(attempt.attemptNumber) + '</strong><small>' + escapeClient(attempt.attemptId) + '</small></div>' + pillMarkup(attempt.status || 'unknown') + attemptExecutionModeChipClient(attempt) + '</div><dl class="detail-grid compact">' +
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

var EXECUTION_MODE_LABELS_CLIENT = { dry_run: 'DRY RUN', desktop_commander: 'LIVE EXECUTION', unknown: 'MODE UNKNOWN' };

function recognizedExecutionModesClient(candidates) {
  var seen = {};
  var distinct = [];
  for (var i = 0; i < candidates.length; i++) {
    var candidate = candidates[i];
    if ((candidate === 'dry_run' || candidate === 'desktop_commander') && !seen[candidate]) {
      seen[candidate] = true;
      distinct.push(candidate);
    }
  }
  return distinct;
}

function resultExecutionModeClient(workItem) {
  var result = workItem && workItem.result;
  if (!result || typeof result !== 'object') return 'none';
  var sim = result.simulationMetadata;
  var modes = recognizedExecutionModesClient([result.executionMode, result.execution_mode, sim && typeof sim === 'object' ? sim.executionMode : undefined]);
  // Fail closed: conflicting mode metadata must not produce a confident label.
  if (modes.length !== 1) return 'unknown';
  return modes[0];
}

function executionModeChipClient(workItem) {
  var mode = resultExecutionModeClient(workItem);
  if (mode === 'none') return '';
  return ' <span class="pill execution-mode execution-mode-' + escapeClient(mode) + '" data-execution-mode="' + escapeClient(mode) + '">' + EXECUTION_MODE_LABELS_CLIENT[mode] + '</span>';
}

function attemptExecutionModeClient(attempt) {
  // An attempt's mode comes from its own persisted data — its per-attempt
  // result or its bound plan's constraints — never from the work item's final
  // persisted result, which may reflect a later replanned execution.
  if (!attempt || typeof attempt !== 'object') return 'none';
  var result = attempt.result;
  var plan = attempt.plan;
  var planConstraints = plan && plan.definition && plan.definition.constraints;
  var sim = result && typeof result === 'object' ? result.simulationMetadata : undefined;
  var modes = recognizedExecutionModesClient([
    result && typeof result === 'object' ? result.executionMode : undefined,
    result && typeof result === 'object' ? result.execution_mode : undefined,
    sim && typeof sim === 'object' ? sim.executionMode : undefined,
    planConstraints && typeof planConstraints === 'object' ? planConstraints.executionMode : undefined
  ]);
  if (modes.length === 0) return 'none';
  // Fail closed on conflicting evidence, same as the work-item derivation.
  if (modes.length !== 1) return 'unknown';
  return modes[0];
}

function attemptExecutionModeChipClient(attempt) {
  var mode = attemptExecutionModeClient(attempt);
  if (mode === 'none') return '';
  return ' <span class="pill execution-mode execution-mode-' + escapeClient(mode) + '" data-execution-mode="' + escapeClient(mode) + '">' + EXECUTION_MODE_LABELS_CLIENT[mode] + '</span>';
}

function renderWorkDetail(target, workItem, events, executionAttempts, attemptLeases) {
  if (!workItem) {
    stopLeaseExpiryWarningRefresh();
    target.innerHTML = '<div class="detail-error">Work item not found.</div>';
    return;
  }
  const actions = Array.isArray(workItem.requestedActions) ? workItem.requestedActions : [];
  target.setAttribute('aria-labelledby', 'work-detail-title');
  target.innerHTML = '<div class="detail-head"><div><h3 id="work-detail-title">' + escapeClient(workItem.title) + '</h3><small>' + escapeClient(workItem.id) + ' · <a class="permalink" href="' + escapeClient(workItemPermalink(workItem.id)) + '">Permalink</a></small></div><div>' + pillMarkup(workItem.status) + ' ' + pillMarkup(workItem.risk) + executionModeChipClient(workItem) + '</div></div>' +
    '<dl class="detail-grid">' +
      detailRow('Requester', workItem.requester) +
      detailRow('Intent', workItem.intent) +
      detailRow('Target', workItem.target ? redactedAttributesJsonClient(workItem.target) : '—') +
      detailRow('Created', formatClientTime(workItem.createdAt)) +
    '</dl>' +
    '<div class="detail-section"><h4>Requested Actions</h4>' + (actions.length ? '<ul class="action-list">' + actions.map(function (action) { return '<li><strong>' + escapeClient(action.kind) + '</strong><small>' + escapeClient(redactClient(action.description)) + '</small></li>'; }).join('') + '</ul>' : '<p class="muted">No requested actions.</p>') + '</div>' +
    renderExecutionAuthority(executionAttempts, attemptLeases) +
    workItemControlsMarkup(workItem, sseConnected) +
    '<div class="detail-section"><h4>Timeline</h4>' + eventList(events || []) + '</div>';
  scheduleLeaseExpiryWarningRefresh(target);
}

function knownQueueStatuses() {
  return new Set(['draft', 'pending_policy', 'needs_approval', 'approved', 'running', 'cancelling', 'succeeded', 'failed', 'blocked', 'cancelled', 'rejected', 'unknown', 'quarantined']);
}

function knownQueueRisks() {
  return new Set(${JSON.stringify(WORK_ITEM_RISK_VALUES)});
}

function readQueueFilterFromDom() {
  const statuses = [];
  document.querySelectorAll('[data-queue-status]').forEach(function (input) {
    if (input.checked) statuses.push(input.getAttribute('data-queue-status') || input.value || '');
  });
  const risks = [];
  document.querySelectorAll('[data-queue-risk]').forEach(function (input) {
    if (input.checked) risks.push(input.getAttribute('data-queue-risk') || input.value || '');
  });
  const agentInput = document.querySelector('#queue-filter-agent');
  const textInput = document.querySelector('#queue-filter-text');
  return {
    statuses: statuses.filter(Boolean),
    risks: risks.filter(Boolean),
    agentId: agentInput ? String(agentInput.value || '').trim() : '',
    text: textInput ? String(textInput.value || '').trim() : ''
  };
}

function parseQueueFilterFromLocation() {
  const params = new URLSearchParams(location.search || '');
  if (![...params.keys()].some(function (key) { return key === 'status' || key === 'risk' || key === 'q' || key === 'text' || key === 'agent'; })) {
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
  const risks = [];
  params.getAll('risk').forEach(function (entry) {
    String(entry).split(',').forEach(function (part) {
      const risk = part.trim();
      if (risk) risks.push(risk);
    });
  });
  return {
    statuses: statuses,
    risks: risks,
    agentId: String(params.get('agent') || '').trim(),
    text: String(params.get('q') || params.get('text') || '').trim()
  };
}

function writeQueueFilterToLocation(filter) {
  const url = new URL(location.href);
  const filterKeys = ['status', 'risk', 'q', 'text', 'agent'];
  filterKeys.forEach(function (key) { url.searchParams.delete(key); });

  // Hash deep links are accepted on read (for example #queue?risk=high), so
  // remove the same filter keys there before writing canonical query params.
  // Otherwise a cleared filter reappears after reload when parsing the stale hash.
  const rawHash = String(url.hash || '').replace(/^#/, '');
  if (rawHash) {
    const question = rawHash.indexOf('?');
    const firstAmp = rawHash.indexOf('&');
    const firstEq = rawHash.indexOf('=');
    let anchor = '';
    let delimiter = '';
    let hashQuery = '';
    if (question >= 0) {
      anchor = rawHash.slice(0, question);
      delimiter = '?';
      hashQuery = rawHash.slice(question + 1);
    } else if (firstAmp >= 0 && firstEq > firstAmp) {
      anchor = rawHash.slice(0, firstAmp);
      delimiter = '&';
      hashQuery = rawHash.slice(firstAmp + 1);
    } else if (firstEq >= 0) {
      hashQuery = rawHash;
    }

    if (hashQuery) {
      const hashParams = new URLSearchParams(hashQuery);
      filterKeys.forEach(function (key) { hashParams.delete(key); });
      const remainingHashParams = hashParams.toString();
      if (anchor) {
        url.hash = '#' + anchor + (remainingHashParams ? delimiter + remainingHashParams : '');
      } else {
        url.hash = remainingHashParams ? '#' + remainingHashParams : '';
      }
    }
  }

  filter.statuses.forEach(function (status) {
    if (status) url.searchParams.append('status', status);
  });
  (filter.risks || []).forEach(function (risk) {
    if (risk) url.searchParams.append('risk', risk);
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
  const selectedRisks = new Set((filter.risks || []).map(function (risk) { return String(risk).trim().toLowerCase(); }));
  document.querySelectorAll('[data-queue-risk]').forEach(function (input) {
    const risk = String(input.getAttribute('data-queue-risk') || input.value || '').trim().toLowerCase();
    input.checked = selectedRisks.has(risk);
  });
  const agentInput = document.querySelector('#queue-filter-agent');
  const textInput = document.querySelector('#queue-filter-text');
  if (agentInput) agentInput.value = filter.agentId || '';
  if (textInput) textInput.value = filter.text || '';
}

function applyQueueFilterClient(filter) {
  const known = knownQueueStatuses();
  const knownStatuses = filter.statuses.filter(function (status) { return known.has(status); });
  const knownRisks = (filter.risks || []).map(function (risk) { return String(risk).trim().toLowerCase(); }).filter(function (risk) { return knownQueueRisks().has(risk); });
  const text = String(filter.text || '').trim().toLowerCase();
  const agent = String(filter.agentId || '').trim().toLowerCase();
  const buttons = Array.from(document.querySelectorAll('[data-work-item]'));
  let visible = 0;
  buttons.forEach(function (el) {
    const id = el.getAttribute('data-work-item') || '';
    const title = el.getAttribute('data-title') || '';
    const status = el.getAttribute('data-status') || '';
    const risk = String(el.getAttribute('data-risk') || '').trim().toLowerCase();
    const agentId = (el.getAttribute('data-agent-id') || '').toLowerCase();
    let show = true;
    if (knownStatuses.length && knownStatuses.indexOf(status) === -1) show = false;
    if (show && knownRisks.length && knownRisks.indexOf(risk) === -1) show = false;
    if (show && text) {
      const hay = (title + ' ' + id).toLowerCase();
      if (hay.indexOf(text) === -1) show = false;
    }
    if (show && agent && agentId.indexOf(agent) === -1) show = false;
    el.hidden = !show;
    el.classList.toggle('queue-item-filtered-out', !show);
    if (show) visible += 1;
  });
  const effectivelyEmpty = !knownStatuses.length && !knownRisks.length && !text && !agent;
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
  document.querySelectorAll('[data-queue-status], [data-queue-risk]').forEach(function (input) {
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
bindAgentDiscovery();
refreshAgentRoster();
connectSse();
renderNotificationToggle();
updateTitleBadge();

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

const confirmCopy = ${JSON.stringify(CONFIRM_COPY)};
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
    const copy = confirmCopy[request.action] || confirmCopy.approve;
    const actionLabel = copy.label;
    const hashPrefix = approvalActionHashPrefix(request.actionHash || '');
    const hashLine = hashPrefix
      ? '<p class="approval-confirm-hash">Action hash: <code>' + escapeClientHtml(hashPrefix) + '</code></p>'
      : '';
    const kindLine = request.actionKind
      ? '<p class="approval-confirm-kind">Action: <code>' + escapeClientHtml(request.actionKind) + '</code></p>'
      : '';
    overlay.innerHTML = '<div class="approval-confirm-card">' +
      '<h3 id="approval-confirm-title">' + escapeClientHtml(copy.heading) + '</h3>' +
      '<p class="approval-confirm-id">Work item: <code>' + escapeClientHtml(request.workItemId) + '</code></p>' +
      '<p class="approval-confirm-risk">Risk: <strong>' + escapeClientHtml(request.risk) + '</strong></p>' +
      kindLine +
      hashLine +
      '<div class="approval-confirm-actions">' +
        '<button type="button" id="approval-confirm-cancel" data-approval-confirm-cancel>' + escapeClientHtml(copy.dismiss) + '</button>' +
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

document.querySelectorAll('[data-execution-mode]').forEach((input) => {
  input.addEventListener('change', async () => {
    if (!input.checked) return;
    const output = document.querySelector('#execution-mode-result');
    const headers = { 'content-type': 'application/json' };
    const res = await fetch('/execution-mode', {
      method: 'POST',
      headers,
      body: JSON.stringify({ mode: input.value, reason: 'operator set ' + input.value + ' from mission control' })
    });
    const body = await res.json().catch(() => ({}));
    if (output) output.textContent = res.ok ? 'mode ' + body.executionMode : 'Rejected: ' + (body.error || body.code || res.status);
    if (res.ok) {
      // Update in place (no hard reload): banners follow the confirmed mode.
      const admin = document.querySelector('#admin-mode-banner');
      const problem = document.querySelector('#execution-mode-problem');
      if (admin) {
        admin.hidden = body.executionMode !== 'admin';
        admin.textContent = body.executionMode === 'admin' ? ${JSON.stringify(ADMIN_MODE_BANNER_TEXT)} : '';
      }
      if (problem) problem.hidden = true;
    }
  });
});

// Delegated: approval cards are replaced by live fragment patches.
document.addEventListener('click', async (event) => {
    const button = event.target && event.target.closest ? event.target.closest('[data-approve],[data-reject],[data-unblock]') : null;
    if (!button || button.disabled) return;
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
        actionKind: button.dataset.actionKind,
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
    const res = await fetch('/work-items/' + encodeURIComponent(id) + '/' + action, { method: 'POST', headers, body: JSON.stringify(payload) });
    const body = await res.json().catch(() => ({}));
    output.textContent = res.ok ? action + ' accepted' : 'Rejected: ' + (body.error || body.code || res.status);
    if (res.ok) {
      announce(action + ' accepted for ' + id);
      scheduleDashboardRefresh(0);
    }
});


${composerClientSource()}

const viewAliases = {
  overview: 'overview',
  queue: 'queue',
  execution: 'execution',
  approvals: 'approvals',
  agents: 'agents',
  executors: 'executors',
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
  if (view === 'executors') refreshExecutorRoster();
  if (view === 'connectors') refreshConnectorRoster();
  syncSystemProbes();
  syncMetricsPolling();
  syncLeaseExpiryWarningRefresh();
}

function openDashboardDrilldown(link) {
  const view = link.dataset.dashboardView || 'overview';
  const rawStatuses = link.dataset.dashboardStatuses;
  if (rawStatuses !== undefined) {
    const filter = {
      statuses: String(rawStatuses).split(',').map(function (value) { return value.trim(); }).filter(Boolean),
      risks: [],
      agentId: '',
      text: ''
    };
    syncQueueFilterControls(filter);
    applyQueueFilterClient(filter);
    writeQueueFilterToLocation(filter);
  }
  showView(view);
  const url = new URL(location.href);
  if (rawStatuses === undefined) {
    url.search = '';
  } else {
    url.searchParams.delete('item');
  }
  url.hash = '#' + view;
  history.replaceState(null, '', url.pathname + url.search + url.hash);
}

document.addEventListener('click', function (event) {
  const link = event.target && event.target.closest ? event.target.closest('a[data-dashboard-view]') : null;
  if (!link) return;
  event.preventDefault();
  openDashboardDrilldown(link);
});

document.addEventListener('visibilitychange', syncLeaseExpiryWarningRefresh);
document.querySelector('aside nav')?.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-nav]');
  if (!link) return;
  event.preventDefault();
  showView(link.dataset.nav);
  const href = link.getAttribute('href') || '#overview';
  history.replaceState(null, '', href);
});
showView((location.hash || '#overview').replace('#', ''));
openWorkItemFromLocation();`;
}
