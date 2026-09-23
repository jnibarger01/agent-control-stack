/**
 * Live dashboard updates.
 *
 * The server stays the only renderer: `GET /dashboard/fragments` returns the
 * same section markup the page was rendered with (see
 * `renderDashboardFragments`). The client re-fetches those fragments when SSE
 * events arrive, after its own actions, and after a reconnect, then patches
 * each section in place. It keeps typed reasons, focus, the selected work
 * item, and the queue filter, so a patch never costs the operator their place.
 */

/** Section id → element that receives the fragment markup. */
export const DASHBOARD_FRAGMENT_TARGETS = {
  cards: "#overview",
  queueList: "#queue-list",
  queueFooter: "#queue-footer",
  approvalsList: "#approvals-list",
  approvalsCount: "#approvals-count",
  metrics: "#operator-metrics-body",
  systemStats: "#system-stats"
} as const;

/**
 * Sections that SSE events append to or refresh on their own. They are only
 * replaced after a reconnect, because `/events` does not replay what was
 * missed while the stream was down.
 */
export const DASHBOARD_CATCH_UP_TARGETS = {
  eventsTimeline: "#events-timeline",
  connectors: "#connectors-body",
  policyEvents: "#policy-body"
} as const;

export type DashboardFragmentName = keyof typeof DASHBOARD_FRAGMENT_TARGETS | keyof typeof DASHBOARD_CATCH_UP_TARGETS;
export type DashboardFragments = Record<DashboardFragmentName, string> & { generatedAt: string };

/** Debounce for work-item events, so a burst of transitions costs one fetch. */
export const WORK_ITEM_REFRESH_DEBOUNCE_MS = 250;
/** Agent heartbeats only move counters; refresh for them lazily. */
export const AGENT_REFRESH_DEBOUNCE_MS = 5_000;
/** Never fetch fragments more often than this. */
export const MIN_REFRESH_INTERVAL_MS = 1_000;
/**
 * Agent status ages out on elapsed time alone (online → stale → offline), so
 * refresh on this cadence while connected even when no event arrives.
 */
export const PERIODIC_REFRESH_MS = 30_000;
/** Retry a failed fragment fetch with backoff, capped here. */
export const MAX_REFRESH_RETRY_MS = 30_000;

/** Event name prefixes that change work items, attempts, or leases. */
export const WORK_EVENT_PREFIXES = ["work_item.", "execution_attempt.", "attempt_lease."] as const;

function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * Relies on the dashboard client's `fetchJson`, `sseConnected`,
 * `sseReconnectAt`, `sseReconnectAttempt`, `readQueueFilterFromDom`,
 * `applyQueueFilterClient`, and `loadWorkDetail`.
 */
export function liveDashboardClientSource(): string {
  return `
const dashboardFragmentTargets = ${scriptSafeJson(DASHBOARD_FRAGMENT_TARGETS)};
const dashboardCatchUpTargets = ${scriptSafeJson(DASHBOARD_CATCH_UP_TARGETS)};
const workEventPrefixes = ${scriptSafeJson(WORK_EVENT_PREFIXES)};
const appliedFragments = {};
let dashboardRefreshTimer = null;
let dashboardRefreshDueAt = 0;
let dashboardRefreshInFlight = false;
let dashboardRefreshQueued = false;
let lastDashboardRefreshAt = 0;
let lastDashboardAttemptAt = 0;
let dashboardRefreshFailures = 0;
let dashboardCatchUpPending = false;
let lastSseEventAt = 0;
let dashboardRefreshError = '';
let selectedWorkItemId = null;
let dashboardFinishedLimit = (function () {
  const raw = new URLSearchParams(location.search).get('finished');
  const value = raw === null ? NaN : Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
})();

// Finished items are paged; "show more" widens the window and keeps it in the URL.
document.addEventListener('click', function (event) {
  const button = event.target && event.target.closest ? event.target.closest('[data-load-more-finished]') : null;
  if (!button) return;
  const shown = Number(button.dataset.shown) || 0;
  dashboardFinishedLimit = shown + (Number(button.dataset.step) || 50);
  const params = new URLSearchParams(location.search);
  params.set('finished', String(dashboardFinishedLimit));
  try { history.replaceState(null, '', location.pathname + '?' + params.toString() + location.hash); } catch {}
  button.disabled = true;
  scheduleDashboardRefresh(0);
});

function cssAttr(value) {
  return String(value).replace(/["\\\\]/g, '\\\\$&');
}

function scheduleDashboardRefresh(delayMs, options) {
  if (options && options.catchUp) dashboardCatchUpPending = true;
  const earliest = lastDashboardAttemptAt + ${MIN_REFRESH_INTERVAL_MS};
  const due = Math.max(Date.now() + Math.max(0, delayMs || 0), earliest);
  if (dashboardRefreshTimer && dashboardRefreshDueAt <= due) return;
  if (dashboardRefreshTimer) clearTimeout(dashboardRefreshTimer);
  dashboardRefreshDueAt = due;
  dashboardRefreshTimer = setTimeout(function () {
    dashboardRefreshTimer = null;
    void refreshDashboard();
  }, Math.max(0, due - Date.now()));
}

async function refreshDashboard() {
  if (dashboardRefreshInFlight) {
    dashboardRefreshQueued = true;
    return;
  }
  dashboardRefreshInFlight = true;
  lastDashboardAttemptAt = Date.now();
  const catchUp = dashboardCatchUpPending;
  dashboardCatchUpPending = false;
  let retryIn = 0;
  try {
    const body = await fetchJson('/dashboard/fragments' + (dashboardFinishedLimit === null ? '' : '?finished=' + dashboardFinishedLimit));
    if (!body || !body.fragments) throw new Error('invalid fragments response');
    applyDashboardFragments(body.fragments, { catchUp: catchUp });
    dashboardRefreshError = '';
    dashboardRefreshFailures = 0;
    // Only a response that was actually applied counts as "updated".
    lastDashboardRefreshAt = Date.now();
  } catch (error) {
    dashboardRefreshFailures += 1;
    dashboardRefreshError = 'refresh failed, retrying';
    if (catchUp) dashboardCatchUpPending = true;
    retryIn = Math.min(${MAX_REFRESH_RETRY_MS}, 1000 * Math.pow(2, dashboardRefreshFailures - 1));
  } finally {
    dashboardRefreshInFlight = false;
    renderLiveStatus();
    if (retryIn) {
      dashboardRefreshQueued = false;
      scheduleDashboardRefresh(retryIn);
    } else if (dashboardRefreshQueued) {
      dashboardRefreshQueued = false;
      scheduleDashboardRefresh(${WORK_ITEM_REFRESH_DEBOUNCE_MS});
    }
  }
}

// Agent freshness ages out without events; keep counters honest while live.
setInterval(function () {
  if (sseConnected && document.visibilityState !== 'hidden') scheduleDashboardRefresh(0);
}, ${PERIODIC_REFRESH_MS});

function captureOperatorState() {
  const active = document.activeElement;
  const reasons = {};
  document.querySelectorAll('[data-reason]').forEach(function (input) {
    if (input.value) reasons[input.dataset.reason] = input.value;
  });
  const outputs = {};
  document.querySelectorAll('.approval-result[id]').forEach(function (output) {
    if (output.textContent) outputs[output.id] = output.textContent;
  });
  return {
    activeId: active && active.id ? active.id : null,
    activeSelector: active && active.dataset && active.dataset.workItem ? '[data-work-item="' + cssAttr(active.dataset.workItem) + '"]' : null,
    reasons: reasons,
    outputs: outputs
  };
}

function restoreOperatorState(state) {
  Object.keys(state.reasons).forEach(function (id) {
    const input = document.querySelector('[data-reason="' + cssAttr(id) + '"]');
    if (input && !input.value) input.value = state.reasons[id];
  });
  Object.keys(state.outputs).forEach(function (id) {
    const output = document.getElementById(id);
    if (output && !output.textContent) output.textContent = state.outputs[id];
  });
  if (selectedWorkItemId) {
    const selected = document.querySelector('[data-work-item="' + cssAttr(selectedWorkItemId) + '"]');
    if (selected) {
      selected.classList.add('selected');
      selected.setAttribute('aria-current', 'true');
    }
  }
  const target = (state.activeId && document.getElementById(state.activeId)) ||
    (state.activeSelector && document.querySelector(state.activeSelector));
  if (target && document.activeElement !== target && typeof target.focus === 'function') {
    target.focus({ preventScroll: true });
  }
}

function applyDashboardFragments(fragments, options) {
  const targets = Object.assign({}, dashboardFragmentTargets, options && options.catchUp ? dashboardCatchUpTargets : {});
  const changed = Object.keys(targets).filter(function (name) {
    return typeof fragments[name] === 'string' && appliedFragments[name] !== fragments[name];
  });
  if (!changed.length) return false;
  const state = captureOperatorState();
  changed.forEach(function (name) {
    const target = document.querySelector(targets[name]);
    if (!target) return;
    target.innerHTML = fragments[name];
    appliedFragments[name] = fragments[name];
  });
  if (changed.indexOf('queueList') !== -1) applyQueueFilterClient(readQueueFilterFromDom());
  if (changed.indexOf('approvalsList') !== -1) applySseConnectionState(document, sseConnected);
  restoreOperatorState(state);
  if (typeof onDashboardFragmentsApplied === 'function') onDashboardFragmentsApplied(changed);
  return true;
}

function announce(message) {
  const region = document.getElementById('action-status');
  if (region) region.textContent = message;
}

function eventWorkItemId(data) {
  const attrs = (data && data.attributes) || {};
  return attrs['work_item.id'] || attrs['work_item.source_id'] || '';
}

function onLiveAuditEvent(name, data) {
  lastSseEventAt = Date.now();
  renderLiveStatus();
  if (workEventPrefixes.some(function (prefix) { return name.indexOf(prefix) === 0; })) {
    scheduleDashboardRefresh(${WORK_ITEM_REFRESH_DEBOUNCE_MS});
    const id = eventWorkItemId(data);
    if (selectedWorkItemId && id === selectedWorkItemId) void loadWorkDetail(selectedWorkItemId, { preserve: true });
  } else if (name.indexOf('agent.') === 0 || name.indexOf('acp.') === 0 || name === 'tunnel_session.heartbeat') {
    scheduleDashboardRefresh(${AGENT_REFRESH_DEBOUNCE_MS});
  }
}

function secondsSince(timestamp) {
  return Math.max(0, Math.round((Date.now() - timestamp) / 1000));
}

function renderLiveStatus() {
  const live = document.querySelector('.live');
  if (!live) return;
  let state;
  let text;
  if (sseConnected) {
    state = 'live';
    text = 'Live';
    if (lastSseEventAt) text += ' · last event ' + secondsSince(lastSseEventAt) + 's ago';
  } else if (!sseEverOpened && !sseReconnectAt) {
    state = 'connecting';
    text = 'Connecting…';
  } else {
    state = 'disconnected';
    const wait = sseReconnectAt ? Math.max(0, Math.ceil((sseReconnectAt - Date.now()) / 1000)) : 0;
    text = 'Disconnected · ' + (wait > 0 ? 'reconnecting in ' + wait + 's' : 'reconnecting…') + ' (attempt ' + Math.max(1, sseReconnectAttempt) + ')';
  }
  if (dashboardRefreshError) text += ' · ' + dashboardRefreshError;
  live.dataset.state = state;
  live.classList.toggle('disconnected', state === 'disconnected');
  live.classList.toggle('connecting', state === 'connecting');
  const label = live.querySelector('[data-live-label]');
  if (label) label.textContent = text;
  else live.innerHTML = '<span aria-hidden="true"></span> <span data-live-label>' + escapeClient(text) + '</span>';
  const updated = document.getElementById('dashboard-updated');
  if (updated) updated.textContent = lastDashboardRefreshAt ? 'Updated ' + new Date(lastDashboardRefreshAt).toLocaleTimeString() : '';
}

setInterval(renderLiveStatus, 1000);
`;
}
