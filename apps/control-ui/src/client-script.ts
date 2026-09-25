import { CONFIRM_COPY } from "./approval-actions.js";
import { auditTimelineClientSource } from "./audit-timeline.js";
import { composerClientSource } from "./composer.js";
import { liveDashboardClientSource } from "./live-dashboard.js";
import { operatorWorkflowClientSource } from "./operator-workflow.js";
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
      if (selectedAgentId) loadAgentDetail(selectedAgentId);
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
  if (!preserve) target.innerHTML = '<div class="detail-loading">Loading work item...</div>';
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
  target.innerHTML = '<div class="detail-head"><div><h3 id="work-detail-title">' + escapeClient(workItem.title) + '</h3><small>' + escapeClient(workItem.id) + ' · <a class="permalink" href="' + escapeClient(workItemPermalink(workItem.id)) + '">Permalink</a></small></div><div>' + pillMarkup(workItem.status) + ' ' + pillMarkup(workItem.risk) + '</div></div>' +
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
  syncSystemProbes();
  syncMetricsPolling();
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
openWorkItemFromLocation();`;
}
