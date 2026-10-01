import { PAGE_META } from "./render/operations.js";

/** Interaction layer reuses the dashboard's authenticated fetch/actions and refresh scheduler. */
export function operationsClientSource(): string {
  return `
const pageMeta = ${JSON.stringify(PAGE_META).replace(/</g, "\\u003c")};
let drawerReturnFocus = null;
let executionSearch = '';
let executionStageFilter = '';
let auditSearchText = '';
let auditTypeFilter = '';
let auditReturnFocus = null;
function closeAuditDrawer() {
  const drawer = document.getElementById('audit-drawer');
  if (drawer.hidden) return;
  drawer.hidden = true;
  document.querySelector('aside').inert = false;
  Array.from(document.getElementById('main-content').children).forEach(function (child) { child.inert = false; });
  document.body.style.overflow = '';
  if (auditReturnFocus?.isConnected) auditReturnFocus.focus({ preventScroll: true });
}
document.getElementById('audit-drawer-close')?.addEventListener('click', closeAuditDrawer);
document.addEventListener('click', function (event) {
  const button = event.target.closest?.('[data-inspect-audit]');
  if (!button) return;
  const row = button.closest('tr');
  const template = row.querySelector('template[data-audit-detail]');
  if (!template) return;
  auditReturnFocus = button;
  const drawer = document.getElementById('audit-drawer');
  const detail = document.getElementById('audit-detail');
  detail.replaceChildren(template.content.cloneNode(true));
  drawer.hidden = false;
  document.querySelector('aside').inert = true;
  Array.from(document.getElementById('main-content').children).forEach(function (child) { if (child !== drawer) child.inert = true; });
  document.body.style.overflow = 'hidden'; detail.focus();
});
document.addEventListener('keydown', function (event) {
  const drawer = document.getElementById('audit-drawer');
  if (drawer.hidden) return;
  if (event.key === 'Escape') { event.preventDefault(); closeAuditDrawer(); }
  if (event.key === 'Tab') {
    const fields = Array.from(drawer.querySelectorAll('button:not([disabled]), a[href], summary, [tabindex="0"]')).filter(function (e) { return !e.hidden; });
    const first = fields[0], last = fields[fields.length - 1];
    if (event.shiftKey && (document.activeElement === first || !fields.includes(document.activeElement))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !fields.includes(document.activeElement))) { event.preventDefault(); first?.focus(); }
  }
});
function openWorkDrawer() {
  const drawer = document.getElementById('work-drawer');
  if (!drawer) return;
  if (drawer.hidden) drawerReturnFocus = document.activeElement;
  drawer.hidden = false;
  document.querySelector('aside').inert = true;
  Array.from(document.getElementById('main-content').children).forEach(function (child) { if (child !== drawer) child.inert = true; });
  document.body.style.overflow = 'hidden';
}
function closeWorkDrawer() {
  const drawer = document.getElementById('work-drawer');
  if (!drawer || drawer.hidden) return;
  drawer.hidden = true;
  document.querySelector('aside').inert = false;
  Array.from(document.getElementById('main-content').children).forEach(function (child) { child.inert = false; });
  document.body.style.overflow = '';
  selectedWorkItemId = null;
  workDetailGeneration += 1;
  stopLeaseExpiryWarningRefresh();
  writeSelectedItemToLocation(null);
  if (drawerReturnFocus && drawerReturnFocus.isConnected) drawerReturnFocus.focus({ preventScroll: true });
  else document.getElementById('main-content').focus({ preventScroll: true });
}
document.getElementById('work-drawer-close')?.addEventListener('click', closeWorkDrawer);
document.addEventListener('keydown', function (event) {
  const drawer = document.getElementById('work-drawer');
  if (!drawer || drawer.hidden || document.getElementById('approval-confirm-dialog')) return;
  if (event.key === 'Escape') { event.preventDefault(); closeWorkDrawer(); }
  if (event.key === 'Tab') {
    const fields = Array.from(drawer.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex="0"]')).filter(function (e) { return !e.hidden; });
    const first = fields[0], last = fields[fields.length - 1];
    if (event.shiftKey && (document.activeElement === first || !fields.includes(document.activeElement))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !fields.includes(document.activeElement))) { event.preventDefault(); first?.focus(); }
  }
});
function syncPageHeading(view) {
  const meta = pageMeta[view] || pageMeta.overview;
  document.getElementById('page-title').textContent = meta.title;
  document.getElementById('page-description').textContent = meta.description;
  document.querySelectorAll('nav a[data-nav]').forEach(function (link) {
    if (link.dataset.nav === view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
}
function applyOperationFilters() {
  const text = executionSearch.toLowerCase();
  let runs = 0, runTotal = 0;
  document.querySelectorAll('[data-run-stage]').forEach(function (row) {
    row.hidden = !!((executionStageFilter && row.dataset.runStage !== executionStageFilter) || (text && !row.textContent.toLowerCase().includes(text)));
    runTotal += 1; if (!row.hidden) runs += 1;
  });
  const runCount = document.getElementById('execution-filter-count');
  if (runCount) runCount.textContent = runs + ' / ' + runTotal + ' work items';
  const runSearch = document.getElementById('execution-search');
  if (runSearch) runSearch.value = executionSearch;
  const runStage = document.getElementById('execution-stage');
  if (runStage) {
    if (executionStageFilter && !Array.from(runStage.options).some(function (o) { return o.value === executionStageFilter; })) {
      const option = document.createElement('option'); option.textContent = executionStageFilter; runStage.append(option);
    }
    runStage.value = executionStageFilter;
  }
  let shown = 0, total = 0;
  document.querySelectorAll('[data-audit-name]').forEach(function (row) {
    row.hidden = !!((auditTypeFilter && !row.dataset.auditName.toLowerCase().includes(auditTypeFilter.toLowerCase())) || (auditSearchText && !(row.textContent + ' ' + (row.querySelector('template')?.content.textContent || '')).toLowerCase().includes(auditSearchText.toLowerCase())));
    total += 1; if (!row.hidden) shown += 1;
  });
  const auditCount = document.getElementById('audit-filter-count');
  if (auditCount) auditCount.textContent = shown + ' / ' + total + ' retained events';
}
document.addEventListener('input', function (event) {
  const id = event.target.id;
  if (id === 'execution-search') executionSearch = event.target.value;
  else if (id === 'execution-stage') executionStageFilter = event.target.value;
  else if (id === 'audit-search') auditSearchText = event.target.value;
  else if (id === 'audit-type') auditTypeFilter = event.target.value;
  else return;
  applyOperationFilters();
});
document.addEventListener('change', function (event) {
  if (event.target.id === 'execution-stage') { executionStageFilter = event.target.value; applyOperationFilters(); }
});
document.addEventListener('click', function (event) {
  const node = event.target.closest ? event.target.closest('[data-review-approval], [data-inspect-work], [data-inspect-agent], [data-create-task], [data-refresh-dashboard], [data-search-view]') : null;
  if (!node) return;
  if (node.dataset.reviewApproval) {
    const id = node.dataset.reviewApproval; closeWorkDrawer(); showView('approvals'); history.pushState(null, '', '#approvals');
    document.querySelector('[data-reason="' + cssAttr(id) + '"]')?.focus();
  } else if (node.dataset.inspectWork) {
    selectWorkItem(node.dataset.inspectWork);
  } else if (node.dataset.inspectAgent) {
    event.preventDefault(); showView('agents'); history.pushState(null, '', '#agents');
    selectedAgentId = node.dataset.inspectAgent; void loadAgentDetail(selectedAgentId);
  } else if (node.hasAttribute('data-create-task')) {
    showView('overview'); history.pushState(null, '', '#overview');
    const composer = document.getElementById('dispatch');
    composer.open = true;
    composer.scrollIntoView?.({ block: 'start' }); composer.querySelector('input')?.focus();
  } else if (node.hasAttribute('data-refresh-dashboard')) {
    announce('Refreshing backend state…'); scheduleDashboardRefresh(0, { catchUp: true });
  } else if (node.dataset.searchView) {
    showView(node.dataset.searchView); history.pushState(null, '', '#' + node.dataset.searchView);
  }
  document.getElementById('command-results').hidden = true;
});
function searchCommands() {
  const query = document.getElementById('command-search').value.trim().toLowerCase();
  const results = document.getElementById('command-results');
  results.hidden = !query;
  if (!query) return;
  const rows = [];
  Object.keys(pageMeta).forEach(function (view) {
    const meta = pageMeta[view];
    if ((meta.title + ' ' + meta.description).toLowerCase().includes(query)) rows.push('<button data-search-view="' + view + '">' + escapeClient(meta.title) + '<small>Open page</small></button>');
  });
  const seen = new Set();
  document.querySelectorAll('#queue-list [data-work-item]').forEach(function (row) {
    const id = row.dataset.workItem;
    if (seen.has(id) || !row.textContent.toLowerCase().includes(query)) return;
    seen.add(id); rows.push('<button data-inspect-work="' + escapeClient(id) + '">' + escapeClient(row.dataset.title) + '<small>' + escapeClient(id) + '</small></button>');
  });
  document.querySelectorAll('#agent-roster-body [data-agent]').forEach(function (row) {
    if (row.textContent.toLowerCase().includes(query)) rows.push('<button data-inspect-agent="' + escapeClient(row.dataset.agent) + '">' + escapeClient(row.querySelector('strong')?.textContent || row.dataset.agent) + '<small>Agent detail</small></button>');
  });
  results.innerHTML = '<p class="muted">Pages and currently loaded ACS entities</p>' + (rows.slice(0, 20).join('') || '<p class="empty">No matching loaded entities.</p>');
}
document.getElementById('command-search')?.addEventListener('input', searchCommands);
document.addEventListener('keydown', function (event) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); document.getElementById('command-search').focus(); }
  if (event.key === 'Escape') document.getElementById('command-results').hidden = true;
});
window.addEventListener('hashchange', function () { showView(location.hash.slice(1)); });
window.addEventListener('popstate', function () { showView(location.hash.slice(1)); if (!workItemIdFromLocation()) closeWorkDrawer(); });
window.addEventListener('pagehide', function () { if (sseSource) sseSource.close(); });
applyOperationFilters();
`;
}
