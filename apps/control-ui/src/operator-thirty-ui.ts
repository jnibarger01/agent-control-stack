import { ADMIN_MODE_BANNER_TEXT } from "./types.js";
import { escapeHtml } from "./html.js";
import { FOCUS_RING_TOKEN, KNOWN_VIEWS, LAST_VIEW_STORAGE_KEY, REDUCED_MOTION_QUERY } from "./operator-impact.js";
import { RISK_WEIGHT } from "./operator-insights.js";
import {
  DENSITY_STORAGE_KEY,
  FOCUS_STORAGE_KEY,
  PINS_STORAGE_KEY,
  RECENT_STORAGE_KEY,
  SORT_STORAGE_KEY,
  printAuditCss
} from "./operator-ux.js";

export const OPERATOR_THIRTY = [
  "risk-weighted-queue-score",
  "approval-sla-class",
  "stale-lease-detector",
  "audit-sequence-gaps",
  "work-item-age-buckets",
  "agent-activity-class",
  "duplicate-intent-detector",
  "policy-denial-rate",
  "retry-storm-detector",
  "execution-mode-display-warning",
  "relative-time",
  "id-only-clipboard",
  "filter-aware-empty-queue",
  "refresh-shortcut",
  "last-view-restore",
  "focus-ring-token",
  "reduced-motion",
  "nav-badge-counts",
  "filter-chip-summary",
  "admin-mode-must-confirm",
  "density-toggle",
  "queue-sort",
  "pin-work-items",
  "recent-work-items",
  "command-result-ranking",
  "skip-link-targets",
  "filter-count-announcement",
  "status-glyph",
  "print-audit-stylesheet",
  "timezone-label"
] as const;

function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Toolbar and insight shell. No timestamps, so rendered HTML stays stable. */
export function operatorToolbarHtml(): string {
  return `<div id="operator-toolbar" class="operator-toolbar" data-operator-thirty="1" role="region" aria-label="Operator tools">
    <label class="operator-field" for="operator-density">Density
      <select id="operator-density">
        <option value="comfortable">Comfortable</option>
        <option value="compact">Compact</option>
      </select>
    </label>
    <label class="operator-field" for="operator-sort">Queue sort
      <select id="operator-sort">
        <option value="server">Server order</option>
        <option value="attention">Needs attention</option>
        <option value="newest">Newest</option>
        <option value="oldest">Oldest</option>
        <option value="risk">Risk</option>
        <option value="id">Id</option>
      </select>
    </label>
    <label class="operator-field" for="operator-jump">Jump to view
      <input id="operator-jump" type="search" autocomplete="off" placeholder="approvals, queue, audit…" />
    </label>
    <div id="operator-jump-results" class="operator-jump-results" hidden></div>
    <button type="button" id="operator-copy-id" class="tool-button">Copy selected id</button>
    <button type="button" id="operator-pin" class="tool-button">Pin selected</button>
    <button type="button" id="operator-focus-plus" class="tool-button" aria-pressed="false">Focus ring</button>
    <button type="button" id="operator-admin-warning" class="tool-button">Admin-mode warning</button>
    <span id="operator-timezone" class="operator-timezone">Timezone</span>
    <p id="operator-filter-summary" class="operator-filter-summary" aria-live="polite">Showing all items</p>
    <p id="operator-empty-hint" class="operator-empty-hint" hidden></p>
    <ol id="operator-recent" class="operator-recent" aria-label="Recently viewed work items"></ol>
  </div>`;
}

export function operatorInsightsHtml(): string {
  return `<section id="operator-insights" class="panel operator-insights" data-view-panel="overview" aria-label="Operator insights">
    <div class="panel-head"><h2>Operator insights</h2><span>read-only · no authority</span></div>
    <p class="muted">Computed in the browser from the current dashboard. These readouts cannot approve, deny, or execute work.</p>
    <dl class="operator-insight-grid">
      <div><dt>Triage scores</dt><dd id="insight-scores">Waiting for queue rows.</dd></div>
      <div><dt>SLA</dt><dd id="insight-sla">Waiting for approval waits.</dd></div>
      <div><dt>Stale leases</dt><dd id="insight-leases">No lease expiry in view.</dd></div>
      <div><dt>Audit gaps</dt><dd id="insight-gaps">No sequence gaps in view.</dd></div>
      <div><dt>Age buckets</dt><dd id="insight-ages">Waiting for created times.</dd></div>
      <div><dt>Agent activity</dt><dd id="insight-agents">Waiting for heartbeats.</dd></div>
      <div><dt>Duplicate intents</dt><dd id="insight-dupes">No duplicate intents in view.</dd></div>
      <div><dt>Policy denial rate</dt><dd id="insight-denial">No policy decisions in view.</dd></div>
      <div><dt>Retry storms</dt><dd id="insight-retries">No retry storms in view.</dd></div>
      <div><dt>Execution display</dt><dd id="insight-execution">${escapeHtml(ADMIN_MODE_BANNER_TEXT)} is display-only.</dd></div>
    </dl>
  </section>`;
}

export function operatorThirtyStyles(): string {
  return `
.skip-links { position: absolute; }
.operator-toolbar { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: end; margin: 0 0 12px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
.operator-field { display: grid; gap: 4px; color: var(--muted); font-size: 12px; }
.operator-field select, .operator-field input { color: var(--ink); background: var(--control-bg); border: 1px solid var(--control-line); border-radius: 6px; padding: 6px 8px; }
.operator-timezone, .operator-filter-summary, .operator-empty-hint { margin: 0; color: var(--muted-strong); font-size: 12px; }
.operator-recent { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
.operator-recent a { color: var(--ink); }
.queue-item.pinned { box-shadow: inset 3px 0 var(--accent); }
.queue-item.pinned::before { content: "Pinned"; color: var(--accent); font-size: 11px; font-weight: 700; }
.operator-jump-results { display: flex; flex-wrap: wrap; gap: 6px; }
.operator-insights { margin-top: 12px; }
.operator-insight-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin: 0; }
.operator-insight-grid div { border-top: 1px solid var(--line); padding-top: 8px; }
.operator-insight-grid dt { color: var(--muted); font-size: 12px; }
.operator-insight-grid dd { margin: 4px 0 0; }
.nav-count { margin-left: 6px; min-width: 1.25rem; text-align: center; border-radius: 999px; background: var(--nav-active); color: var(--nav-active-ink); font-size: 11px; }
.status-glyph { margin-left: 6px; font-weight: 700; }
.relative-time { margin-left: 8px; color: var(--muted); font-size: 12px; }
body[data-density="compact"] .queue-item { padding-top: 6px; padding-bottom: 6px; }
body[data-density="compact"] .panel-head h2 { font-size: 15px; }
body.acs-focus-plus :focus-visible { outline: ${FOCUS_RING_TOKEN}; outline-offset: 2px; }
@media ${REDUCED_MOTION_QUERY} {
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; scroll-behavior: auto !important; }
}
${printAuditCss()}
`;
}

export function operatorThirtyClientSource(): string {
  const config = {
    riskWeight: RISK_WEIGHT,
    knownViews: KNOWN_VIEWS,
    keys: {
      density: DENSITY_STORAGE_KEY,
      sort: SORT_STORAGE_KEY,
      pins: PINS_STORAGE_KEY,
      recent: RECENT_STORAGE_KEY,
      lastView: LAST_VIEW_STORAGE_KEY,
      focus: FOCUS_STORAGE_KEY
    },
    adminWarning: ADMIN_MODE_BANNER_TEXT,
    retryThreshold: 3
  };
  return `
const operatorThirty = ${scriptSafeJson(config)};
function operatorStorageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function operatorStorageSet(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}
function operatorSessionGet(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function operatorSessionSet(key, value) {
  try { sessionStorage.setItem(key, value); } catch {}
}
function operatorParseIds(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(function (id) { return typeof id === 'string' && id && id.length <= 128; }) : [];
  } catch { return []; }
}
function operatorRelativeTime(iso, nowMs) {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return 'unknown time';
  const delta = nowMs - parsed;
  const future = delta < 0;
  const seconds = Math.floor(Math.abs(delta) / 1000);
  if (seconds < 10) return future ? 'in a moment' : 'just now';
  const suffix = future ? 'from now' : 'ago';
  if (seconds < 60) return seconds + 's ' + suffix;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm ' + suffix;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h ' + suffix;
  return Math.floor(hours / 24) + 'd ' + suffix;
}
function operatorQueueRows() {
  return Array.from(document.querySelectorAll('#queue-list [data-work-item]'));
}
function applyOperatorDensity() {
  const select = document.getElementById('operator-density');
  const stored = operatorStorageGet(operatorThirty.keys.density);
  const density = stored === 'compact' ? 'compact' : 'comfortable';
  document.body.dataset.density = density;
  if (select) select.value = density;
}
function applyOperatorFocus() {
  const on = operatorStorageGet(operatorThirty.keys.focus) === 'on';
  document.body.classList.toggle('acs-focus-plus', on);
  const button = document.getElementById('operator-focus-plus');
  if (button) button.setAttribute('aria-pressed', on ? 'true' : 'false');
}
function applyOperatorTimezone() {
  const node = document.getElementById('operator-timezone');
  if (!node) return;
  let zone = 'UTC';
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch {}
  let formatted = zone;
  try {
    formatted = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  } catch { formatted = 'UTC'; zone = 'UTC'; }
  node.textContent = zone + ' · ' + formatted;
}
function applyOperatorRelativeTimes() {
  const nowMs = Date.now();
  document.querySelectorAll('[data-relative-time]').forEach(function (node) {
    const iso = node.getAttribute('data-relative-time') || '';
    node.textContent = operatorRelativeTime(iso, nowMs);
  });
}
function applyOperatorNavBadges() {
  const rows = operatorQueueRows();
  const counts = { approvals: 0, attention: 0, failed: 0 };
  rows.forEach(function (row) {
    const status = row.getAttribute('data-status') || '';
    if (status === 'needs_approval') counts.approvals += 1;
    if (status === 'needs_approval' || status === 'blocked' || status === 'quarantined') counts.attention += 1;
    if (status === 'failed' || status === 'blocked') counts.failed += 1;
  });
  const map = { approvals: counts.approvals, queue: counts.attention, execution: counts.failed };
  document.querySelectorAll('[data-nav-count]').forEach(function (badge) {
    const view = badge.getAttribute('data-nav-count');
    const count = map[view] || 0;
    badge.hidden = count === 0;
    badge.textContent = count ? ' ' + String(count) : '';
    if (count) badge.setAttribute('aria-label', String(count) + ' items');
    else badge.removeAttribute('aria-label');
  });
}
function applyOperatorPins() {
  const pins = operatorParseIds(operatorStorageGet(operatorThirty.keys.pins));
  operatorQueueRows().forEach(function (row) {
    const id = row.getAttribute('data-work-item') || '';
    row.classList.toggle('pinned', pins.indexOf(id) !== -1);
  });
}
function applyOperatorSort() {
  const select = document.getElementById('operator-sort');
  const sort = operatorStorageGet(operatorThirty.keys.sort) || 'server';
  if (select) select.value = ['attention', 'newest', 'oldest', 'risk', 'id'].indexOf(sort) === -1 ? 'server' : sort;
  if (!select) return;
  const list = document.getElementById('queue-list');
  if (!list) return;
  const rows = operatorQueueRows();
  rows.forEach(function (row, index) {
    if (!row.hasAttribute('data-operator-server-order')) row.setAttribute('data-operator-server-order', String(index));
  });
  if (select.value === 'server') {
    rows.sort(function (left, right) {
      return Number(left.getAttribute('data-operator-server-order')) - Number(right.getAttribute('data-operator-server-order'));
    }).forEach(function (row) { list.appendChild(row); });
    return;
  }
  const riskRank = { critical: 0, high: 1, medium: 2, low: 3 };
  const attention = function (status) { return status === 'needs_approval' || status === 'blocked' || status === 'quarantined' ? 0 : 1; };
  rows.sort(function (left, right) {
    if (select.value === 'id') return (left.getAttribute('data-work-item') || '').localeCompare(right.getAttribute('data-work-item') || '');
    if (select.value === 'risk') return (riskRank[left.getAttribute('data-risk')] ?? 9) - (riskRank[right.getAttribute('data-risk')] ?? 9);
    if (select.value === 'newest' || select.value === 'oldest') {
      const leftTime = Date.parse(left.getAttribute('data-created-at') || '');
      const rightTime = Date.parse(right.getAttribute('data-created-at') || '');
      const delta = (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
      return select.value === 'newest' ? delta : -delta;
    }
    return attention(left.getAttribute('data-status') || '') - attention(right.getAttribute('data-status') || '');
  }).forEach(function (row) { list.appendChild(row); });
}
function renderOperatorRecent() {
  const list = document.getElementById('operator-recent');
  if (!list) return;
  const ids = operatorParseIds(operatorSessionGet(operatorThirty.keys.recent));
  list.replaceChildren();
  ids.forEach(function (id) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = '?item=' + encodeURIComponent(id) + '#queue';
    link.textContent = id;
    item.appendChild(link);
    list.appendChild(item);
  });
}
function rememberOperatorWorkItem(id) {
  if (!id) return;
  const next = [id].concat(operatorParseIds(operatorSessionGet(operatorThirty.keys.recent)).filter(function (entry) { return entry !== id; })).slice(0, 8);
  operatorSessionSet(operatorThirty.keys.recent, JSON.stringify(next));
  renderOperatorRecent();
}
function renderOperatorInsights() {
  const rows = operatorQueueRows();
  const now = typeof serverNowMs === 'function' ? serverNowMs() : Date.now();
  const scores = rows.map(function (row) {
    const risk = operatorThirty.riskWeight[row.getAttribute('data-risk')] || 0;
    const status = row.getAttribute('data-status') || '';
    const attention = status === 'needs_approval' || status === 'blocked' || status === 'quarantined' ? 25 : 0;
    const created = Date.parse(row.getAttribute('data-created-at') || '');
    const ageHours = Number.isFinite(created) ? Math.max(0, (now - created) / 3600000) : 0;
    return { id: row.getAttribute('data-work-item') || '', score: risk + attention + Math.min(20, Math.floor(ageHours)) };
  }).sort(function (left, right) { return right.score - left.score; }).slice(0, 3);
  const scoresNode = document.getElementById('insight-scores');
  if (scoresNode) scoresNode.textContent = scores.length ? scores.map(function (entry) { return entry.id + ' (' + entry.score + ')'; }).join(', ') : 'Waiting for queue rows.';
  const slaNode = document.getElementById('insight-sla');
  if (slaNode) {
    let breach = 0;
    let warning = 0;
    document.querySelectorAll('[data-waiting-since]').forEach(function (badge) {
      const started = Date.parse(badge.getAttribute('data-waiting-since') || '');
      const sla = Number(badge.getAttribute('data-sla-ms'));
      if (!Number.isFinite(started) || !Number.isFinite(sla) || sla <= 0) return;
      const wait = Math.max(0, now - started);
      if (wait >= sla) breach += 1;
      else if (wait >= sla * 0.75) warning += 1;
    });
    slaNode.textContent = breach || warning ? breach + ' breach, ' + warning + ' warning' : 'No SLA warning in view.';
  }
  const leases = Array.from(document.querySelectorAll('[data-lease-expires]')).filter(function (node) {
    const owner = node.closest('[data-work-item]');
    const status = owner && owner.getAttribute('data-status');
    if (status === 'succeeded' || status === 'failed' || status === 'approved' || status === 'cancelled') return false;
    const expires = Date.parse(node.getAttribute('data-lease-expires') || '');
    return Number.isFinite(expires) && expires <= now;
  }).map(function (node) { return node.getAttribute('data-lease-id') || 'lease'; });
  const leaseNode = document.getElementById('insight-leases');
  if (leaseNode) leaseNode.textContent = leases.length ? leases.join(', ') : 'No stale leases in view.';
  const sequences = Array.from(document.querySelectorAll('#events-timeline [data-sequence]')).map(function (node) {
    return Number(node.getAttribute('data-sequence'));
  }).filter(function (sequence) { return Number.isSafeInteger(sequence) && sequence > 0; }).sort(function (left, right) { return left - right; });
  const gaps = [];
  let moreGaps = false;
  for (let index = 1; index < sequences.length; index += 1) {
    for (let missing = sequences[index - 1] + 1; missing < sequences[index]; missing += 1) {
      if (gaps.length === 8) { moreGaps = true; break; }
      gaps.push(missing);
    }
    if (moreGaps) break;
  }
  const gapNode = document.getElementById('insight-gaps');
  if (gapNode) gapNode.textContent = gaps.length ? 'Missing ' + gaps.join(', ') + (moreGaps ? ' …' : '') : 'No sequence gaps in view.';
  const ages = { fresh: 0, aging: 0, stale: 0, ancient: 0, unknown: 0 };
  rows.forEach(function (row) {
    const created = Date.parse(row.getAttribute('data-created-at') || '');
    if (!Number.isFinite(created) || now - created < 0) { ages.unknown += 1; return; }
    const hours = (now - created) / 3600000;
    if (hours < 1) ages.fresh += 1;
    else if (hours < 24) ages.aging += 1;
    else if (hours < 168) ages.stale += 1;
    else ages.ancient += 1;
  });
  const ageNode = document.getElementById('insight-ages');
  if (ageNode) ageNode.textContent = 'fresh ' + ages.fresh + ', aging ' + ages.aging + ', stale ' + ages.stale + ', ancient ' + ages.ancient + ', unknown ' + ages.unknown;
  const activity = { active: 0, idle: 0, stale: 0, unknown: 0 };
  document.querySelectorAll('#agent-roster-body [data-agent]').forEach(function (node) {
    const seenValue = node.getAttribute('data-last-seen');
    if (!seenValue) { activity.unknown += 1; return; }
    const seen = Date.parse(seenValue);
    if (!Number.isFinite(seen) || now - seen < 0) { activity.unknown += 1; return; }
    const age = now - seen;
    if (age < 300000) activity.active += 1;
    else if (age < 1800000) activity.idle += 1;
    else activity.stale += 1;
  });
  const agentNode = document.getElementById('insight-agents');
  if (agentNode) agentNode.textContent = 'active ' + activity.active + ', idle ' + activity.idle + ', stale ' + activity.stale + ', unknown ' + activity.unknown;
  // Map, not a plain object: intents are untrusted and may normalize to keys
  // such as __proto__ or constructor. Retries and clones copy their source
  // intent by design, so members of one lineage count once: each row is keyed
  // by its lineage root (source id, else itself) and a group is a duplicate
  // only when it spans more than one distinct root.
  const groups = new Map();
  rows.forEach(function (row) {
    const key = row.getAttribute('data-intent-norm') || '';
    if (!key) return;
    const id = row.getAttribute('data-work-item') || '';
    const root = (row.getAttribute('data-lineage') && row.getAttribute('data-lineage-source')) || id;
    const roots = groups.get(key) || new Set();
    roots.add(root);
    groups.set(key, roots);
  });
  const dupes = Array.from(groups.keys()).filter(function (key) { return groups.get(key).size > 1; });
  const dupeNode = document.getElementById('insight-dupes');
  if (dupeNode) dupeNode.textContent = dupes.length ? dupes.length + ' duplicate intent group' + (dupes.length === 1 ? '' : 's') : 'No duplicate intents in view.';
  const decisions = Array.from(document.querySelectorAll('#events-timeline li')).filter(function (node) {
    return (node.querySelector('strong') && node.querySelector('strong').textContent) === 'policy.decided';
  });
  // Use the structured policy.decision attribute only, never row text.
  const denied = decisions.filter(function (node) { return node.getAttribute('data-policy-decision') === 'deny'; }).length;
  const denialNode = document.getElementById('insight-denial');
  if (denialNode) denialNode.textContent = decisions.length ? Math.round((denied / decisions.length) * 100) + '% denied in view' : 'No policy decisions in view.';
  const storms = rows.filter(function (row) {
    return Number(row.getAttribute('data-retry-sequence') || '0') >= operatorThirty.retryThreshold;
  }).map(function (row) { return row.getAttribute('data-work-item'); });
  const retryNode = document.getElementById('insight-retries');
  if (retryNode) retryNode.textContent = storms.length ? storms.join(', ') : 'No retry storms in view.';
  const executionNode = document.getElementById('insight-execution');
  if (executionNode) {
    const admin = document.querySelector('[data-execution-mode="admin"]');
    const adminOn = !!(admin && admin.checked);
    const strict = document.querySelector('[data-execution-mode="strict"]');
    const strictOn = !!(strict && strict.checked);
    const dryRun = rows.some(function (row) { return !!row.querySelector('[data-execution-mode="dry_run"]'); });
    if (adminOn && dryRun) executionNode.textContent = 'Admin mode is on, but a visible result is still dry-run. Admin mode does not prove live execution.';
    else if (adminOn) executionNode.textContent = operatorThirty.adminWarning + ' This display does not grant execution authority.';
    else if (strictOn) executionNode.textContent = 'Strict mode. Display does not grant execution authority.';
    else executionNode.textContent = 'Execution mode is missing or corrupt; treat as fail-closed. Display does not grant execution authority.';
  }
}
function renderOperatorFilterSummary() {
  const rows = operatorQueueRows();
  const visible = rows.filter(function (row) { return !row.hidden; }).length;
  const summary = document.getElementById('operator-filter-summary');
  if (summary) summary.textContent = visible === rows.length ? 'Showing all ' + rows.length + ' work items' : 'Showing ' + visible + ' of ' + rows.length + ' work items';
  const hint = document.getElementById('operator-empty-hint');
  if (!hint) return;
  const filterActive = visible !== rows.length;
  hint.hidden = !(filterActive && visible === 0 && rows.length > 0);
  hint.textContent = hint.hidden ? '' : 'No work items match this filter. Clear filters to see the full queue.';
}
function copySelectedOperatorId() {
  const id = typeof selectedWorkItemId === 'string' ? selectedWorkItemId.trim() : '';
  let rejected = !id || id.length > 128;
  if (!rejected) {
    for (let operatorIdIndex = 0; operatorIdIndex < id.length; operatorIdIndex += 1) {
      const code = id.charCodeAt(operatorIdIndex);
      if (code <= 32 || code === 34 || code === 39 || code === 60 || code === 62 || code === 96) rejected = true;
    }
  }
  if (!rejected && /secret|token|password|api[_-]?key|bearer /i.test(id)) rejected = true;
  if (rejected) {
    if (typeof announce === 'function') announce('No safe work-item id to copy');
    return;
  }
  const write = navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(id) : Promise.reject();
  Promise.resolve(write).then(function () {
    if (typeof announce === 'function') announce('Copied work item id');
  }).catch(function () {
    if (typeof announce === 'function') announce('Could not copy work item id');
  });
}
function toggleSelectedOperatorPin() {
  const id = typeof selectedWorkItemId === 'string' ? selectedWorkItemId.trim() : '';
  if (!id) {
    if (typeof announce === 'function') announce('Select a work item before pinning');
    return;
  }
  const pins = operatorParseIds(operatorStorageGet(operatorThirty.keys.pins));
  const next = pins.indexOf(id) === -1 ? [id].concat(pins).slice(0, 20) : pins.filter(function (pin) { return pin !== id; });
  operatorStorageSet(operatorThirty.keys.pins, JSON.stringify(next));
  applyOperatorPins();
  if (typeof announce === 'function') announce(next.indexOf(id) === -1 ? 'Unpinned ' + id : 'Pinned ' + id);
}
function applyOperatorThirty() {
  applyOperatorDensity();
  applyOperatorFocus();
  applyOperatorTimezone();
  applyOperatorRelativeTimes();
  applyOperatorNavBadges();
  applyOperatorPins();
  applyOperatorSort();
  renderOperatorRecent();
  renderOperatorInsights();
  renderOperatorFilterSummary();
}
function bindOperatorThirty() {
  if (document.body.dataset.operatorThirtyBound === '1') return;
  document.body.dataset.operatorThirtyBound = '1';
  document.getElementById('operator-density')?.addEventListener('change', function (event) {
    const value = event.target && event.target.value === 'compact' ? 'compact' : 'comfortable';
    operatorStorageSet(operatorThirty.keys.density, value);
    applyOperatorDensity();
  });
  document.getElementById('operator-sort')?.addEventListener('change', function (event) {
    const value = event.target ? event.target.value : 'server';
    operatorStorageSet(operatorThirty.keys.sort, value);
    applyOperatorSort();
  });
  document.getElementById('operator-focus-plus')?.addEventListener('click', function () {
    const on = !document.body.classList.contains('acs-focus-plus');
    operatorStorageSet(operatorThirty.keys.focus, on ? 'on' : 'off');
    applyOperatorFocus();
  });
  document.getElementById('operator-copy-id')?.addEventListener('click', copySelectedOperatorId);
  const workDrawer = document.getElementById('work-drawer');
  if (workDrawer && !document.getElementById('operator-copy-id-drawer')) {
    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.id = 'operator-copy-id-drawer';
    copyButton.className = 'tool-button';
    copyButton.textContent = 'Copy work item id';
    copyButton.addEventListener('click', copySelectedOperatorId);
    workDrawer.querySelector('.drawer-head')?.appendChild(copyButton);
  }
  document.getElementById('operator-pin')?.addEventListener('click', toggleSelectedOperatorPin);
  // The drawer is modal (the toolbar is inert while it is open), so the pin
  // action must also live in the drawer, like copy.
  if (workDrawer && !document.getElementById('operator-pin-drawer')) {
    const pinButton = document.createElement('button');
    pinButton.type = 'button';
    pinButton.id = 'operator-pin-drawer';
    pinButton.className = 'tool-button';
    pinButton.textContent = 'Pin work item';
    pinButton.addEventListener('click', toggleSelectedOperatorPin);
    workDrawer.querySelector('.drawer-head')?.appendChild(pinButton);
  }
  document.getElementById('operator-admin-warning')?.addEventListener('click', function () {
    if (typeof announce === 'function') announce(operatorThirty.adminWarning + ' Confirmation is still required. This button does not change execution mode.');
  });
  document.getElementById('operator-jump')?.addEventListener('input', function (event) {
    const query = (event.target && event.target.value || '').trim().toLowerCase();
    const results = document.getElementById('operator-jump-results');
    if (!results) return;
    results.replaceChildren();
    if (!query) { results.hidden = true; return; }
    const ranked = operatorThirty.knownViews.map(function (view) { return { label: view, keywords: view }; }).filter(function (view) {
      return view.label.startsWith(query) || view.label.includes(query);
    }).sort(function (left, right) {
      const leftScore = left.label.startsWith(query) ? 2 : 1;
      const rightScore = right.label.startsWith(query) ? 2 : 1;
      return rightScore - leftScore;
    });
    results.hidden = ranked.length === 0;
    ranked.forEach(function (view) {
      const link = document.createElement('a');
      link.href = '#' + view.label;
      link.textContent = view.label;
      results.appendChild(link);
    });
  });
  document.addEventListener('click', function (event) {
    const skip = event.target && event.target.closest ? event.target.closest('a.skip-link') : null;
    if (!skip) return;
    const href = skip.getAttribute('href') || '';
    if (href !== '#approvals' && href !== '#queue') return;
    event.preventDefault();
    const id = href.slice(1);
    try { if (typeof showView === 'function') showView(id); } catch (error) {}
    const target = document.getElementById(id);
    if (target && target.focus) target.focus();
    try { history.replaceState(null, '', location.pathname + location.search + href); } catch (error) {}
  });
  const queueFilter = document.getElementById('queue-filter');
  if (queueFilter) {
    queueFilter.addEventListener('input', renderOperatorFilterSummary);
    queueFilter.addEventListener('change', renderOperatorFilterSummary);
  }
  window.addEventListener('hashchange', function () {
    const view = (location.hash || '').slice(1);
    if (operatorThirty.knownViews.indexOf(view) !== -1) operatorStorageSet(operatorThirty.keys.lastView, view);
  });
  if (!location.hash) {
    setTimeout(function () {
      try {
        const stored = operatorStorageGet(operatorThirty.keys.lastView);
        if (stored && operatorThirty.knownViews.indexOf(stored) !== -1 && typeof showView === 'function') showView(stored);
      } catch (error) {}
    }, 0);
  }
  applyOperatorThirty();
  setInterval(function () { applyOperatorRelativeTimes(); renderOperatorInsights(); }, 15000);
}
bindOperatorThirty();
`;
}
