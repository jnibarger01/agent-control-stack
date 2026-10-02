/**
 * Mission Control "MCP clients" panel (Connectors page) and the global unrecognized-client alert.
 *
 * Shows who is connecting to the Jace Commander (/jc/mcp) and Desktop Commander (/mcp) edge lanes. The OAuth
 * `client_id` is verified by the edge; client names and user agents are self-declared and always labelled as
 * such. The server renders only empty containers; the browser fills them from `GET /api/mcp-clients`, so
 * there is a single renderer. Every value is escaped or set through `textContent`.
 */
export function mcpClientsPanelHtml(): string {
  return `<article id="mcp-clients-panel" class="panel wide" data-view-panel="connectors">
  <div class="panel-head"><div><h2>MCP clients</h2><p>Who is connecting to Jace Commander (<code>/jc/mcp</code>) and Desktop Commander (<code>/mcp</code>). The client ID is verified by OAuth; names and user agents are self-declared.</p></div>
    <span class="panel-tools"><span id="mcp-clients-policy" class="pill">loading</span><span id="mcp-clients-count" class="muted"></span></span></div>
  <p id="mcp-clients-notice" class="mcp-notice" role="status" hidden></p>
  <div class="table-wrap"><table id="mcp-clients-table" class="mcp-table"><thead><tr><th scope="col">Client</th><th scope="col">Client ID</th><th scope="col">Says it is (unverified)</th><th scope="col">Lane</th><th scope="col">Activity</th><th scope="col">Last seen</th></tr></thead><tbody id="mcp-clients-body"><tr><td colspan="6" class="muted">Loading MCP clients…</td></tr></tbody></table></div>
  <details id="mcp-legacy" class="mcp-legacy" hidden><summary>Earlier callers without a client ID</summary><p class="muted">These calls were recorded before ACS stored the OAuth client ID, so they cannot be labelled.</p><table class="mcp-table"><thead><tr><th scope="col">Subject</th><th scope="col">Lane</th><th scope="col">Issued</th><th scope="col">Denied</th><th scope="col">Last seen</th></tr></thead><tbody id="mcp-legacy-body"></tbody></table></details>
</article>`;
}

export function mcpClientAlertHtml(): string {
  return `<a id="mcp-client-alert" class="admin-mode-banner mcp-alert" href="#connectors" data-nav-alert="connectors" role="status" hidden></a>`;
}

export const MCP_CLIENT_EVENT_NAMES = ["mcp_client.seen", "mcp_client.labelled", "mcp_client.label_cleared"] as const;

export function mcpClientsStyles(): string {
  return `
.mcp-table { width: 100%; min-width: 700px; border-collapse: collapse; font-size: 12px; }
#mcp-clients-panel .table-wrap { overflow-x: auto; }
.mcp-actions { margin-top: .4rem; display: flex; gap: .35rem; flex-wrap: wrap; }
.mcp-table th { text-align: left; color: var(--muted); font-weight: 600; padding: 6px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
.mcp-table td { padding: 8px; border-bottom: 1px solid var(--soft-line); vertical-align: top; overflow-wrap: anywhere; }
.mcp-table code { font-size: 11px; }
.mcp-notice { margin: 0 0 .75rem; padding: .6rem .8rem; border: 1px solid var(--warn-line); background: var(--warn-bg); border-radius: 8px; }
.mcp-live { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--green); margin-right: 6px; }
.mcp-idle { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); margin-right: 6px; opacity: .5; }
.pill.unrecognized { background: var(--warn-bg); border-color: var(--warn-line); color: var(--amber); }
.pill.labelled { background: var(--ok-bg); border-color: var(--ok-line); color: var(--green); }
.mcp-alert { display: block; text-decoration: none; }
.mcp-alert[hidden] { display: none; }
.mcp-legacy { margin-top: .75rem; }
.mcp-label-form { display: grid; gap: .6rem; margin: .5rem 0; }
.mcp-label-form label { display: grid; gap: .25rem; font-size: 12px; }
.mcp-claims { margin: 0; padding: 0; list-style: none; display: grid; gap: .25rem; }
`;
}

/** Relies on the dashboard client's `escapeClient`, `announce`, `redactClient`, `sseConnected` and `formatClientTime`. */
export function mcpClientsClientSource(): string {
  return `
const mcpState = { summary: null, clients: [], legacy: [], loaded: false };
let mcpRefreshTimer = null;
const MCP_KIND_LABELS = { chatgpt: 'ChatGPT', muse: 'Muse', grok: 'Grok', claude: 'Claude', gemini: 'Gemini', other: 'Other' };

function mcpAgo(value) {
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

function mcpPolicyBlocks() { return !!(mcpState.summary && mcpState.summary.policy === 'require_label'); }

function renderMcpClients() {
  const body = document.getElementById('mcp-clients-body');
  if (!body) return;
  const summary = mcpState.summary || { total: 0, unrecognized: 0, liveUnrecognized: 0, policy: 'observe' };
  const policy = document.getElementById('mcp-clients-policy');
  if (policy) {
    policy.textContent = summary.policy === 'require_label' ? 'Unlabelled clients are blocked' : 'Observe only';
    policy.className = 'pill ' + (summary.policy === 'require_label' ? 'blocked' : 'off');
  }
  const count = document.getElementById('mcp-clients-count');
  if (count) count.textContent = summary.total + ' client' + (summary.total === 1 ? '' : 's') + ' · ' + summary.unrecognized + ' unrecognized';
  const notice = document.getElementById('mcp-clients-notice');
  if (notice) {
    const lines = [];
    if (summary.policy === 'require_label' && summary.unrecognized > 0) lines.push(summary.unrecognized + ' unlabelled client' + (summary.unrecognized === 1 ? ' is' : 's are') + ' blocked from ACS capability issuance until you label ' + (summary.unrecognized === 1 ? 'it' : 'them') + '.');
    if (summary.policy === 'observe' && summary.unrecognized > 0) lines.push('Unrecognized clients can still use ACS. Label the ones you trust; set ACS_MCP_CLIENT_POLICY=require_label on the gateway to block the rest.');
    notice.hidden = lines.length === 0;
    notice.textContent = lines.join(' ');
  }
  if (!mcpState.clients.length) {
    body.innerHTML = '<tr><td colspan="6" class="muted">No MCP client has connected yet. When ChatGPT, Muse, Grok or another client uses the endpoint it will appear here.</td></tr>';
  } else {
    body.innerHTML = mcpState.clients.map(function (client) {
      const who = client.status === 'labelled'
        ? '<strong>' + escapeClient(client.label) + '</strong> <span class="pill labelled">' + escapeClient(MCP_KIND_LABELS[client.kind] || client.kind) + '</span>' + (client.note ? '<br><small class="muted">' + escapeClient(client.note) + '</small>' : '')
        : '<span class="pill unrecognized">Unrecognized</span>' + (client.suggestedKind ? '<br><small class="muted">Looks like ' + escapeClient(MCP_KIND_LABELS[client.suggestedKind] || client.suggestedKind) + ' (unverified)</small>' : '');
      const claims = client.claims && client.claims.length
        ? '<ul class="mcp-claims">' + client.claims.map(function (c) { return '<li>' + escapeClient([c.name, c.version].filter(Boolean).join(' ') || '—') + (c.userAgent ? '<br><small class="muted">' + escapeClient(c.userAgent) + '</small>' : '') + '</li>'; }).join('') + '</ul>'
        : '<span class="muted">nothing declared</span>';
      const lanes = (client.lanes || []).map(function (lane) { return lane === 'jc' ? 'Jace Commander' : 'Desktop Commander'; }).join(', ');
      const activity = client.connects + ' connect' + (client.connects === 1 ? '' : 's') + ' · ' + client.issued + ' issued · ' + client.denied + ' denied' + (client.lastTool ? '<br><small class="muted">last: ' + escapeClient(client.lastTool) + '</small>' : '');
      const action = client.status === 'labelled'
        ? '<button type="button" class="tool-button" data-mcp-edit="' + escapeClient(client.clientId) + '">Edit</button> <button type="button" class="tool-button" data-mcp-clear="' + escapeClient(client.clientId) + '">Clear</button>'
        : '<button type="button" class="tool-button" data-mcp-label="' + escapeClient(client.clientId) + '">Label…</button>';
      return '<tr data-mcp-client="' + escapeClient(client.clientId) + '"><td>' + who + '<div class="mcp-actions">' + action + '</div></td><td><code>' + escapeClient(client.clientId) + '</code>' + (client.subjects && client.subjects.length ? '<br><small class="muted">subject ' + escapeClient(client.subjects.join(', ')) + '</small>' : '') + '</td><td>' + claims + '</td><td>' + escapeClient(lanes) + '</td><td>' + activity + '</td><td><span class="' + (client.live ? 'mcp-live' : 'mcp-idle') + '" aria-hidden="true"></span>' + escapeClient(client.live ? 'live' : mcpAgo(client.lastSeenAt)) + '<br><small class="muted">first ' + escapeClient(formatClientTime(client.firstSeenAt)) + '</small></td></tr>';
    }).join('');
  }
  const legacy = document.getElementById('mcp-legacy');
  const legacyBody = document.getElementById('mcp-legacy-body');
  if (legacy && legacyBody) {
    legacy.hidden = !mcpState.legacy.length;
    legacyBody.innerHTML = mcpState.legacy.map(function (row) {
      return '<tr><td><code>' + escapeClient(row.subject) + '</code></td><td>' + escapeClient(row.lane === 'jc' ? 'Jace Commander' : 'Desktop Commander') + '</td><td>' + escapeClient(row.issued) + '</td><td>' + escapeClient(row.denied) + '</td><td>' + escapeClient(mcpAgo(row.lastSeenAt)) + '</td></tr>';
    }).join('');
  }
  renderMcpAlert();
}

function renderMcpAlert() {
  const alert = document.getElementById('mcp-client-alert');
  if (!alert) return;
  const summary = mcpState.summary;
  const live = mcpState.clients.filter(function (c) { return c.status === 'unrecognized' && c.live; });
  if (!summary || !live.length) { alert.hidden = true; alert.textContent = ''; return; }
  const names = live.slice(0, 3).map(function (c) { return c.suggestedKind ? (MCP_KIND_LABELS[c.suggestedKind] + '?') : c.clientId.slice(0, 18); }).join(', ');
  alert.textContent = (mcpPolicyBlocks() ? 'Blocked: ' : 'Unrecognized MCP client active: ') + live.length + ' (' + names + '). ' + (mcpPolicyBlocks() ? 'Label it in Connectors to allow it.' : 'Review in Connectors.');
  alert.hidden = false;
}

async function loadMcpClients() {
  try {
    const res = await fetch('/api/mcp-clients');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    mcpState.summary = body.summary || null;
    mcpState.clients = body.clients || [];
    mcpState.legacy = body.legacy || [];
    mcpState.loaded = true;
    renderMcpClients();
  } catch (error) {
    const bodyEl = document.getElementById('mcp-clients-body');
    if (bodyEl && !mcpState.loaded) bodyEl.innerHTML = '<tr><td colspan="6" class="muted" role="alert">Could not load MCP clients: ' + escapeClient(redactClient(error.message)) + '</td></tr>';
  }
}

function scheduleMcpClientsRefresh() {
  if (mcpRefreshTimer) return;
  mcpRefreshTimer = setTimeout(function () { mcpRefreshTimer = null; loadMcpClients(); }, 800);
}

function onMcpClientAuditEvent(eventName) {
  if (eventName.startsWith('mcp_client.') || eventName === 'connector.requested') scheduleMcpClientsRefresh();
}

function mcpDialog(title, html) {
  return new Promise(function (resolve) {
    const existing = document.getElementById('mcp-client-dialog');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'mcp-client-dialog';
    overlay.className = 'approval-confirm-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'mcp-client-dialog-title');
    overlay.innerHTML = '<div class="approval-confirm-card"><h3 id="mcp-client-dialog-title"></h3>' + html + '<p id="mcp-dialog-error" class="field-error" role="alert"></p><div class="approval-confirm-actions"><button type="button" id="mcp-dialog-cancel">Cancel</button><button type="button" id="mcp-dialog-ok">Save</button></div></div>';
    document.body.appendChild(overlay);
    overlay.querySelector('#mcp-client-dialog-title').textContent = title;
    function finish(value) { document.removeEventListener('keydown', onKey); overlay.remove(); resolve(value); }
    function onKey(event) { if (event.key === 'Escape') { event.preventDefault(); finish(null); } }
    document.addEventListener('keydown', onKey);
    overlay.querySelector('#mcp-dialog-cancel').addEventListener('click', function () { finish(null); });
    overlay.querySelector('#mcp-dialog-ok').addEventListener('click', function () { finish({ overlay: overlay, close: function () { finish(true); } }); });
    const first = overlay.querySelector('select, input');
    if (first) first.focus(); else overlay.querySelector('#mcp-dialog-cancel').focus();
  });
}

async function mcpPost(url, payload) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const body = await res.json().catch(function () { return {}; });
  if (!res.ok) throw new Error(body.error || body.code || ('Request failed (' + res.status + ')'));
  return body;
}

async function labelMcpClient(clientId) {
  const client = mcpState.clients.find(function (c) { return c.clientId === clientId; });
  if (!client) return;
  if (!sseConnected) { announce('Disconnected: labelling is disabled until the live stream reconnects'); return; }
  const kind = client.kind || client.suggestedKind || 'other';
  const options = Object.keys(MCP_KIND_LABELS).map(function (k) { return '<option value="' + k + '"' + (k === kind ? ' selected' : '') + '>' + MCP_KIND_LABELS[k] + '</option>'; }).join('');
  const warn = mcpPolicyBlocks() ? '<p class="muted">Labelling lets this client use ACS capability issuance. Approvals, policy and leases still apply to every call.</p>' : '<p class="muted">A label is a name for your records. It does not approve or widen anything.</p>';
  const dialog = mcpDialog(client.status === 'labelled' ? 'Edit client label' : 'Label this client',
    '<p>Client ID: <code id="mcp-dialog-id"></code></p>' + warn +
    '<div class="mcp-label-form"><label>Kind<select id="mcp-dialog-kind">' + options + '</select></label>' +
    '<label>Label<input id="mcp-dialog-label" maxlength="64" autocomplete="off"></label>' +
    '<label>Note (optional)<input id="mcp-dialog-note" maxlength="200" autocomplete="off"></label></div>');
  const overlay = document.getElementById('mcp-client-dialog');
  overlay.querySelector('#mcp-dialog-id').textContent = clientId;
  const labelInput = overlay.querySelector('#mcp-dialog-label');
  const kindSelect = overlay.querySelector('#mcp-dialog-kind');
  labelInput.value = client.label || MCP_KIND_LABELS[kind];
  overlay.querySelector('#mcp-dialog-note').value = client.note || '';
  kindSelect.addEventListener('change', function () { if (!client.label) labelInput.value = MCP_KIND_LABELS[kindSelect.value]; });
  const result = await dialog;
  if (!result) return;
  const label = labelInput.value.trim();
  if (!label) { announce('A label is required'); return; }
  try {
    await mcpPost('/api/mcp-clients/label', { clientId: clientId, kind: kindSelect.value, label: label, note: overlay.querySelector('#mcp-dialog-note').value.trim() || undefined });
    announce('Labelled ' + label);
  } catch (error) { announce('Could not label: ' + redactClient(error.message)); }
  await loadMcpClients();
}

async function clearMcpClient(clientId) {
  const client = mcpState.clients.find(function (c) { return c.clientId === clientId; });
  if (!client) return;
  if (!sseConnected) { announce('Disconnected: changes are disabled until the live stream reconnects'); return; }
  const message = mcpPolicyBlocks() ? '<p>This client will be blocked from ACS capability issuance until it is labelled again.</p>' : '<p>The client will show as Unrecognized again.</p>';
  const result = await mcpDialog('Clear label for ' + (client.label || clientId) + '?', message);
  if (!result) return;
  try { await mcpPost('/api/mcp-clients/label/clear', { clientId: clientId }); announce('Label cleared'); }
  catch (error) { announce('Could not clear label: ' + redactClient(error.message)); }
  await loadMcpClients();
}

document.addEventListener('click', function (event) {
  const target = event.target && event.target.closest ? event.target : null;
  if (!target) return;
  const label = target.closest('[data-mcp-label],[data-mcp-edit]');
  if (label) { void labelMcpClient(label.dataset.mcpLabel || label.dataset.mcpEdit); return; }
  const clear = target.closest('[data-mcp-clear]');
  if (clear) void clearMcpClient(clear.dataset.mcpClear);
});

setTimeout(loadMcpClients, 0);
// Keep "live" and relative times honest without refetching.
setInterval(function () { if (mcpState.loaded) renderMcpClients(); }, 30000);
`;
}
