/**
 * Operator workflow helpers: approval triage order and wait/SLA display (#14),
 * work-item deep links (#15), background notifications and the title badge
 * (#16), and keyboard shortcuts (#13).
 */
import type { WorkItem } from "@agent-control-stack/work-items";

/** Default time an approval may wait before it is flagged as over SLA. */
export const DEFAULT_APPROVAL_SLA_MS = 30 * 60 * 1000;

const RISK_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** When an item started waiting on an operator: its last transition, falling back to creation. */
export function approvalWaitStart(item: Pick<WorkItem, "createdAt" | "updatedAt">): string {
  return item.updatedAt || item.createdAt;
}

export function approvalWaitMs(item: Pick<WorkItem, "createdAt" | "updatedAt">, now: Date): number | undefined {
  const started = Date.parse(approvalWaitStart(item));
  return Number.isFinite(started) ? Math.max(0, now.getTime() - started) : undefined;
}

/** Triage order: highest risk first, then the longest wait. Stable for ties. */
export function sortApprovalItems<T extends Pick<WorkItem, "id" | "risk" | "createdAt" | "updatedAt">>(
  items: readonly T[],
  now: Date
): T[] {
  return items
    .map((item, index) => ({ item, index, rank: RISK_RANK[item.risk] ?? 4, wait: approvalWaitMs(item, now) ?? -1 }))
    .sort((left, right) => left.rank - right.rank || right.wait - left.wait || left.index - right.index)
    .map((entry) => entry.item);
}

/** Compact human duration for wait badges: 45s, 12m, 3h 5m, 2d 4h. */
export function formatWait(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export interface ShortcutHelp {
  keys: string;
  action: string;
}

export const KEYBOARD_SHORTCUTS: readonly ShortcutHelp[] = [
  { keys: "j / k", action: "Next / previous work item" },
  { keys: "/", action: "Search the work queue" },
  { keys: "a", action: "Go to the first waiting approval's reason" },
  { keys: "g o", action: "Overview" },
  { keys: "g q", action: "Work queue" },
  { keys: "g a", action: "Approvals" },
  { keys: "g g", action: "Agents" },
  { keys: "g m", action: "Metrics" },
  { keys: "g e", action: "Audit events" },
  { keys: "g p", action: "Policy" },
  { keys: "g s", action: "System" },
  { keys: "?", action: "Show or hide this help" },
  { keys: "Esc", action: "Close help" }
];

const GO_TO_VIEWS: Readonly<Record<string, string>> = {
  o: "overview",
  q: "queue",
  a: "approvals",
  g: "agents",
  c: "connectors",
  x: "execution",
  m: "metrics",
  e: "audit",
  p: "policy",
  s: "system"
};

function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * Relies on the dashboard client's `showView`, `selectedWorkItemId`,
 * `loadWorkDetail`, `announce`, and `escapeClient`.
 */
export function operatorWorkflowClientSource(): string {
  return `
const goToViews = ${scriptSafeJson(GO_TO_VIEWS)};
const keyboardShortcuts = ${scriptSafeJson(KEYBOARD_SHORTCUTS)};
const baseDocumentTitle = document.title;
let pendingGoKeyAt = 0;
let notificationsWanted = false;
try { notificationsWanted = localStorage.getItem('acs.mc.notifications') === 'on'; } catch {}

// --- #15 deep links: ?item=<id> selects and opens a work item.
function workItemIdFromLocation() {
  return new URLSearchParams(location.search).get('item');
}
// URL sync is best-effort: it must never block selecting a work item.
function safeReplaceState(path) {
  try { history.replaceState(null, '', path); } catch {}
}
function writeSelectedItemToLocation(id) {
  try {
    const url = new URL(location.href);
    if (id) url.searchParams.set('item', id); else url.searchParams.delete('item');
    safeReplaceState(url.pathname + url.search + url.hash);
  } catch {}
}
function selectWorkItem(id, options) {
  if (!id) return;
  document.querySelectorAll('[data-work-item]').forEach(function (candidate) {
    const match = candidate.dataset.workItem === id;
    candidate.classList.toggle('selected', match);
    if (match) candidate.setAttribute('aria-current', 'true'); else candidate.removeAttribute('aria-current');
  });
  selectedWorkItemId = id;
  writeSelectedItemToLocation(id);
  if (options && options.scroll) {
    const row = document.querySelector('[data-work-item="' + cssAttr(id) + '"]');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  }
  void loadWorkDetail(id, { preserve: false, focusDetail: !(options && options.keepFocus) });
}
function workItemPermalink(id) {
  return '?item=' + encodeURIComponent(id) + '#queue';
}
function openWorkItemFromLocation() {
  const id = workItemIdFromLocation();
  if (!id) return;
  if (!location.hash) showView('queue');
  selectWorkItem(id, { scroll: true });
}
window.addEventListener('popstate', openWorkItemFromLocation);

// --- #14 live wait badges between refreshes.
function formatWaitClient(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return seconds + 's';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h ' + (minutes % 60) + 'm';
  return Math.floor(hours / 24) + 'd ' + (hours % 24) + 'h';
}
function refreshWaitBadges() {
  document.querySelectorAll('[data-waiting-since]').forEach(function (badge) {
    const started = Date.parse(badge.dataset.waitingSince || '');
    if (!Number.isFinite(started)) return;
    const wait = Math.max(0, Date.now() - started);
    const sla = Number(badge.dataset.slaMs) || 0;
    const over = sla > 0 && wait >= sla;
    badge.textContent = 'waiting ' + formatWaitClient(wait) + (over ? ' · over SLA' : '');
    const card = badge.closest('.approval-item');
    if (card) card.classList.toggle('overdue', over);
  });
}
setInterval(refreshWaitBadges, 15000);

// --- #16 title badge + opt-in notifications.
function pendingApprovalCount() {
  return document.querySelectorAll('#approvals-list .approval-item[data-status="needs_approval"]').length;
}
function updateTitleBadge() {
  const count = pendingApprovalCount();
  document.title = count ? '(' + count + ') ' + baseDocumentTitle : baseDocumentTitle;
}
function notificationsSupported() {
  return typeof Notification !== 'undefined';
}
function renderNotificationToggle() {
  const toggle = document.getElementById('notifications-toggle');
  if (!toggle) return;
  if (!notificationsSupported()) {
    toggle.hidden = true;
    return;
  }
  const denied = Notification.permission === 'denied';
  const on = notificationsWanted && Notification.permission === 'granted';
  toggle.disabled = denied;
  toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
  toggle.textContent = denied ? 'Notifications blocked' : on ? 'Notifications on' : 'Notify me';
  toggle.title = denied ? 'Notifications are blocked in browser settings' : 'Notify when new work needs approval while this tab is in the background';
}
async function toggleNotifications() {
  if (!notificationsSupported()) return;
  if (notificationsWanted && Notification.permission === 'granted') {
    notificationsWanted = false;
  } else {
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    notificationsWanted = permission === 'granted';
  }
  try { localStorage.setItem('acs.mc.notifications', notificationsWanted ? 'on' : 'off'); } catch {}
  announce(notificationsWanted ? 'Approval notifications on' : 'Approval notifications off');
  renderNotificationToggle();
}
function notifyApprovalNeeded(data) {
  if (!notificationsWanted || !notificationsSupported() || Notification.permission !== 'granted') return;
  if (document.visibilityState !== 'hidden') return;
  const attrs = (data && data.attributes) || {};
  const id = attrs['work_item.id'] || '';
  const risk = attrs['work_item.risk'] ? ' (' + attrs['work_item.risk'] + ' risk)' : '';
  try {
    const notification = new Notification('Approval needed', {
      body: (id ? 'Work item ' + id : 'A work item') + risk + ' is waiting on an operator.',
      tag: 'acs-approval-' + id
    });
    notification.onclick = function () {
      window.focus();
      showView('approvals');
      if (id) selectWorkItem(id, { scroll: true });
      notification.close();
    };
  } catch {}
}
document.getElementById('notifications-toggle')?.addEventListener('click', function () { void toggleNotifications(); });

// --- #13 keyboard shortcuts.
function isTypingTarget(element) {
  if (!element) return false;
  const tag = String(element.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable === true;
}
function visibleQueueItems() {
  return Array.from(document.querySelectorAll('#queue-list [data-work-item]')).filter(function (row) { return !row.hidden; });
}
function moveQueueSelection(delta) {
  const rows = visibleQueueItems();
  if (!rows.length) return;
  const current = rows.findIndex(function (row) { return row.dataset.workItem === selectedWorkItemId; });
  const next = current === -1 ? (delta > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, current + delta));
  const row = rows[next];
  const view = document.body.dataset.activeView;
  if (view !== 'queue' && view !== 'execution' && view !== 'overview') showView('queue');
  row.focus({ preventScroll: false });
  selectWorkItem(row.dataset.workItem, { scroll: true, keepFocus: true });
}
function shortcutHelpDialog() {
  let dialog = document.getElementById('shortcut-help');
  if (dialog) return dialog;
  dialog = document.createElement('div');
  dialog.id = 'shortcut-help';
  dialog.className = 'approval-confirm-overlay';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'shortcut-help-title');
  dialog.hidden = true;
  dialog.innerHTML = '<div class="approval-confirm-card shortcut-card"><h3 id="shortcut-help-title">Keyboard shortcuts</h3><dl class="shortcut-list">' +
    keyboardShortcuts.map(function (entry) { return '<div><dt><kbd>' + escapeClient(entry.keys) + '</kbd></dt><dd>' + escapeClient(entry.action) + '</dd></div>'; }).join('') +
    '</dl><p class="muted">Shortcuts are ignored while typing in a field.</p><div class="approval-confirm-actions"><button type="button" id="shortcut-help-close">Close</button></div></div>';
  document.body.appendChild(dialog);
  dialog.querySelector('#shortcut-help-close').addEventListener('click', function () { setShortcutHelp(false); });
  return dialog;
}
let shortcutHelpReturnFocus = null;
function setShortcutHelp(open) {
  const dialog = shortcutHelpDialog();
  if (open && dialog.hidden) {
    shortcutHelpReturnFocus = document.activeElement;
    dialog.hidden = false;
    dialog.querySelector('#shortcut-help-close').focus();
  } else if (!open && !dialog.hidden) {
    dialog.hidden = true;
    if (shortcutHelpReturnFocus && shortcutHelpReturnFocus.focus) shortcutHelpReturnFocus.focus();
  }
}
document.addEventListener('keydown', function (event) {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
  const help = document.getElementById('shortcut-help');
  const helpOpen = Boolean(help && !help.hidden);
  if (event.key === 'Escape' && helpOpen) {
    event.preventDefault();
    setShortcutHelp(false);
    return;
  }
  if (document.getElementById('approval-confirm-dialog')) return;
  if (isTypingTarget(event.target)) return;
  const key = event.key;
  if (key === '?') {
    event.preventDefault();
    setShortcutHelp(!helpOpen);
    return;
  }
  if (helpOpen) return;
  if (pendingGoKeyAt && Date.now() - pendingGoKeyAt < 1500) {
    pendingGoKeyAt = 0;
    const view = goToViews[key];
    if (view) {
      event.preventDefault();
      showView(view);
      safeReplaceState(location.pathname + location.search + '#' + view);
    }
    return;
  }
  pendingGoKeyAt = 0;
  if (key === 'g') { pendingGoKeyAt = Date.now(); return; }
  if (key === 'j' || key === 'k') { event.preventDefault(); moveQueueSelection(key === 'j' ? 1 : -1); return; }
  if (key === '/') {
    event.preventDefault();
    showView('queue');
    document.getElementById('queue-filter-text')?.focus();
    return;
  }
  if (key === 'a') {
    const reason = document.querySelector('#approvals-list .approval-item[data-status="needs_approval"] [data-reason]');
    if (!reason) { announce('No approvals waiting'); return; }
    event.preventDefault();
    showView('approvals');
    reason.focus();
  }
});
`;
}
