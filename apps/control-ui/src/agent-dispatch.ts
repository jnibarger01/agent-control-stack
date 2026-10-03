/**
 * Mission Control "Dispatch" page: the CLI agents, a confirm-before-run dispatch form, and live runs.
 *
 * The server renders only the empty containers. The browser fills them from `/api/agent-clis` and
 * `/api/agent-runs`, so there is exactly one renderer (no server/client copy to drift). Every value is
 * escaped with `escapeClient` or set via `textContent`; run output is never interpreted as HTML.
 */
export function agentDispatchPanelHtml(): string {
  return `<section id="agent-dispatch" class="grid dispatch-grid" data-view-panel="dispatch">
  <article class="panel wide" id="governed-dispatch-panel">
    <div class="panel-head"><div><h2>Execute an approved mission</h2><p>ACS checks the approved plan, reserves execution capacity, and fences results with worker leases. Jev supplies advice only.</p></div></div>
    <form id="mission-dispatch-form">
      <label>Mission identifier<input name="missionId" required autocomplete="off"></label>
      <label>Approval identifier<input name="approvalId" required autocomplete="off"></label>
      <button type="submit" class="primary-button">Review mission</button>
      <output id="mission-dispatch-result" role="status" aria-live="polite"></output>
    </form>
    <div id="mission-dispatch-review" hidden></div>
    <button type="button" id="mission-dispatch-confirm" class="primary-button" hidden>Confirm execution</button>
    <button type="button" id="mission-dispatch-refresh" class="tool-button">Refresh mission progress</button>
    <div id="mission-dispatch-progress" role="status" aria-live="polite"></div>
  </article>
  <article class="panel wide" id="cli-agents-panel">
    <div class="panel-head"><div><h2>CLI agents</h2><p>Installed coding agents on this machine. Dispatch is human-confirmed and runs in a fresh git worktree.</p></div>
      <span class="panel-tools"><button type="button" id="cli-agents-sync" class="tool-button">Add to roster</button><button type="button" id="cli-agents-refresh" class="tool-button">Refresh</button></span></div>
    <p id="dispatch-banner" class="dispatch-banner" role="status" hidden></p>
    <div id="cli-agent-grid" class="cli-grid" aria-live="polite"><p class="muted">Loading CLI agents…</p></div>
  </article>
  <article class="panel wide" id="dispatch-form-panel">
    <div class="panel-head"><div><h2>Host-side CLI run</h2><p>This separate path uses the CLI’s own permissions and your saved login. It does not govern each tool through ACS. Nothing runs until you confirm.</p></div></div>
    <form id="dispatch-form" novalidate>
      <div class="form-row">
        <label>Agent<select name="agentId" required></select></label>
        <label>Repository<input name="repo" list="dispatch-repos" required autocomplete="off" placeholder="/absolute/path/to/repo"><datalist id="dispatch-repos"></datalist></label>
      </div>
      <fieldset class="dispatch-mode"><legend>Mode</legend>
        <label><input type="radio" name="mode" value="edit" checked> Edit in a fresh worktree</label>
        <label><input type="radio" name="mode" value="read-only"> Read-only (analysis, no edits)</label>
      </fieldset>
      <label>What should the agent do?<textarea name="prompt" required rows="5" maxlength="32000" placeholder="Describe the goal and what a good result looks like."></textarea></label>
      <label>Time limit (minutes)<input name="minutes" type="number" min="1" max="60" value="15"></label>
      <div class="composer-actions"><button type="submit" id="dispatch-submit" class="primary-button">Review &amp; dispatch</button></div>
      <output id="dispatch-result" role="status" aria-live="polite"></output>
    </form>
  </article>
  <article class="panel wide" id="agent-runs-panel">
    <div class="panel-head"><div><h2>Runs</h2><p>Recorded in the audit log. Output is redacted.</p></div><span id="agent-runs-count">loading</span></div>
    <div class="agent-runs-layout"><div id="agent-run-list" class="agent-run-list" aria-live="polite"><p class="muted">No runs yet.</p></div><div id="agent-run-detail" class="agent-run-detail" tabindex="-1"><p class="muted">Select a run to see its output.</p></div></div>
  </article>
</section>`;
}

export const AGENT_DISPATCH_EVENT_NAMES = [
  "agent_run.requested",
  "agent_run.started",
  "agent_run.finished",
  "agent_run.cancel_requested",
  "agent_run.interrupted",
  "agent_cli.tested",
  "mission.dispatch.requested",
  "mission.dispatch.observed"
] as const;

export function agentDispatchStyles(): string {
  return `
.dispatch-grid { display: grid; gap: 1rem; }
.dispatch-banner { margin: 0 0 .75rem; padding: .6rem .8rem; border: 1px solid var(--warn-line); background: var(--warn-bg); border-radius: 8px; }
.cli-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: .75rem; }
.cli-card { border: 1px solid var(--line); border-radius: 10px; padding: .75rem .85rem; background: var(--surface-2); display: grid; gap: .4rem; align-content: start; }
.cli-card h3 { margin: 0; font-size: 14px; display: flex; gap: .5rem; align-items: center; justify-content: space-between; }
.cli-card p { margin: 0; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.cli-card .cli-reason { color: var(--ink); }
.cli-card .cli-meta { display: flex; flex-wrap: wrap; gap: .35rem; }
.pill.ready { background: var(--ok-bg); border-color: var(--ok-line); color: var(--green); }
.pill.blocked, .pill.failed, .pill.timed_out, .pill.interrupted { background: var(--bad-bg); border-color: var(--bad-line); color: var(--red); }
.pill.off, .pill.missing, .pill.cancelled, .pill.queued { background: var(--pill-bg); }
.pill.running { background: var(--warn-bg); border-color: var(--warn-line); color: var(--amber); }
.pill.succeeded { background: var(--ok-bg); border-color: var(--ok-line); color: var(--green); }
.dispatch-mode { border: 1px solid var(--line); border-radius: 8px; display: flex; gap: 1.25rem; flex-wrap: wrap; padding: .5rem .75rem; }
.dispatch-mode label { display: flex; align-items: center; gap: .5rem; }
.dispatch-mode input[type="radio"] { width: auto; min-width: 0; flex: none; margin: 0; }
.dispatch-mode legend { padding: 0 .35rem; }
.agent-runs-layout { display: grid; grid-template-columns: minmax(240px, 1fr) minmax(0, 2fr); gap: 1rem; }
@media (max-width: 900px) { .agent-runs-layout { grid-template-columns: 1fr; } }
.agent-run-list { display: grid; gap: .4rem; align-content: start; max-height: 520px; overflow: auto; }
.agent-run-row { display: grid; gap: .15rem; text-align: left; padding: .5rem .65rem; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2); color: inherit; cursor: pointer; font: inherit; }
.agent-run-row[aria-current="true"] { border-color: var(--accent); }
.agent-run-row small { color: var(--muted); }
.agent-run-detail { min-width: 0; display: grid; gap: .6rem; align-content: start; }
.agent-run-detail dl { display: grid; grid-template-columns: max-content 1fr; gap: .25rem .75rem; margin: 0; font-size: 12px; }
.agent-run-detail dt { color: var(--muted); }
.agent-run-detail dd { margin: 0; overflow-wrap: anywhere; }
pre.run-output { margin: 0; max-height: 420px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--control-bg); border: 1px solid var(--control-line); border-radius: 8px; padding: .6rem .75rem; font-size: 12px; }
.dispatch-confirm dl { display: grid; grid-template-columns: max-content 1fr; gap: .3rem .75rem; margin: .5rem 0; font-size: 13px; }
.dispatch-confirm dt { color: var(--muted); }
.dispatch-confirm dd { margin: 0; overflow-wrap: anywhere; }
`;
}

/** Relies on the dashboard client's `escapeClient`, `announce`, `redactClient`, and `formatClientTime`. */
export function agentDispatchClientSource(): string {
  return `
const dispatchState = { agents: [], dispatch: { enabled: false, repoRoots: [], repos: [] }, runs: [], selectedRunId: null, loaded: false };
let dispatchRunsTimer = null;

async function dispatchJson(url, init) {
  const res = await fetch(url, init);
  const body = await res.json().catch(function () { return {}; });
  if (!res.ok) { const error = new Error(body.error || body.code || ('Request failed (' + res.status + ')')); error.code = body.code; throw error; }
  return body;
}

function dispatchStatusPill(agent) {
  if (!agent.installed) return '<span class="pill missing">not installed</span>';
  if (agent.dispatchBlockedReason) return '<span class="pill blocked">blocked</span>';
  if (!dispatchState.dispatch.enabled) return '<span class="pill off">dispatch off</span>';
  return '<span class="pill ready">ready</span>';
}

function renderCliAgents() {
  const grid = document.getElementById('cli-agent-grid');
  const banner = document.getElementById('dispatch-banner');
  if (!grid) return;
  if (banner) {
    const off = !dispatchState.dispatch.enabled;
    banner.hidden = !off;
    banner.textContent = off ? 'Agent dispatch is off on this gateway. Set ACS_AGENT_DISPATCH_ENABLED=1 and ACS_AGENT_REPO_ROOTS (colon-separated repository roots), then restart it. Agents below are detected but cannot run.' : '';
  }
  if (!dispatchState.agents.length) { grid.innerHTML = '<p class="muted">No CLI agents known.</p>'; return; }
  grid.innerHTML = dispatchState.agents.map(function (agent) {
    const test = agent.lastTest
      ? '<p>Last test ' + escapeClient(formatClientTime(agent.lastTest.at)) + ': ' + (agent.lastTest.ok ? 'passed' : 'failed — ' + escapeClient(redactClient(agent.lastTest.detail).slice(0, 140))) + '</p>'
      : '<p>Not tested yet.</p>';
    const reason = agent.unavailableReason ? '<p class="cli-reason">' + escapeClient(agent.unavailableReason) + '</p>' : '';
    const meta = [
      agent.version ? 'v' + escapeClient(agent.version) : '',
      agent.versionDrift ? 'newer than verified (' + escapeClient(agent.verifiedAgainst) + ')' : '',
      agent.installed ? (agent.loginDetected ? 'login found' : 'no login found') : '',
      agent.readOnlySupported ? 'read-only mode' : 'edit only',
      agent.registered ? 'in roster' : ''
    ].filter(Boolean).map(function (item) { return '<span class="pill">' + item + '</span>'; }).join('');
    return '<div class="cli-card" data-cli-agent="' + escapeClient(agent.id) + '"><h3>' + escapeClient(agent.displayName) + dispatchStatusPill(agent) + '</h3>' +
      '<div class="cli-meta">' + meta + '</div>' + reason + test +
      '<p>' + escapeClient(agent.editContainment) + '</p>' +
      '<p class="cli-governance" data-governance="' + escapeClient(agent.governance) + '"><strong>ACS governance:</strong> ' + escapeClient(agent.governanceSummary) + '</p>' +
      '<div><button type="button" class="tool-button" data-cli-test="' + escapeClient(agent.id) + '"' + (agent.installed && dispatchState.dispatch.enabled ? '' : ' disabled') + '>Test connection</button></div></div>';
  }).join('');
}

function renderDispatchForm() {
  const form = document.getElementById('dispatch-form');
  if (!form) return;
  const select = form.querySelector('select[name="agentId"]');
  const previous = select.value;
  const ready = dispatchState.agents.filter(function (agent) { return agent.dispatchable; });
  select.innerHTML = ready.length
    ? ready.map(function (agent) { return '<option value="' + escapeClient(agent.id) + '">' + escapeClient(agent.displayName) + '</option>'; }).join('')
    : '<option value="">No agent is ready</option>';
  if (previous && ready.some(function (agent) { return agent.id === previous; })) select.value = previous;
  const repos = form.querySelector('#dispatch-repos');
  const suggestions = dispatchState.dispatch.repos && dispatchState.dispatch.repos.length ? dispatchState.dispatch.repos : dispatchState.dispatch.repoRoots;
  repos.innerHTML = suggestions.map(function (path) { return '<option value="' + escapeClient(path) + '"></option>'; }).join('');
  const repoInput = form.querySelector('input[name="repo"]');
  if (!repoInput.value && suggestions.length) repoInput.value = suggestions[0];
  syncDispatchModes();
  form.querySelector('#dispatch-submit').disabled = !ready.length;
}

function syncDispatchModes() {
  const form = document.getElementById('dispatch-form');
  if (!form) return;
  const agent = dispatchState.agents.find(function (item) { return item.id === form.querySelector('select[name="agentId"]').value; });
  const readOnly = form.querySelector('input[name="mode"][value="read-only"]');
  readOnly.disabled = !agent || !agent.readOnlySupported;
  if (readOnly.disabled && readOnly.checked) form.querySelector('input[name="mode"][value="edit"]').checked = true;
}

async function loadCliAgents() {
  try {
    const body = await dispatchJson('/api/agent-clis');
    dispatchState.agents = body.agents || [];
    dispatchState.dispatch = body.dispatch || dispatchState.dispatch;
    dispatchState.loaded = true;
    renderCliAgents();
    renderDispatchForm();
  } catch (error) {
    const grid = document.getElementById('cli-agent-grid');
    if (grid) grid.innerHTML = '<p class="muted" role="alert">Could not load CLI agents: ' + escapeClient(redactClient(error.message)) + '</p>';
  }
}

function renderAgentRuns() {
  const list = document.getElementById('agent-run-list');
  const count = document.getElementById('agent-runs-count');
  if (!list) return;
  if (count) count.textContent = dispatchState.runs.length + ' recent';
  if (!dispatchState.runs.length) { list.innerHTML = '<p class="muted">No runs yet.</p>'; return; }
  list.innerHTML = dispatchState.runs.map(function (run) {
    return '<button type="button" class="agent-run-row" data-agent-run="' + escapeClient(run.runId) + '"' + (run.runId === dispatchState.selectedRunId ? ' aria-current="true"' : '') + '>' +
      '<span>' + escapeClient(run.agentId) + ' · ' + escapeClient(run.mode) + ' <span class="pill ' + escapeClient(run.status) + '">' + escapeClient(run.status) + '</span></span>' +
      '<small>' + escapeClient(redactClient(run.promptPreview).slice(0, 90)) + '</small>' +
      '<small>' + escapeClient(formatClientTime(run.requestedAt)) + '</small></button>';
  }).join('');
}

async function loadAgentRuns() {
  try {
    const body = await dispatchJson('/api/agent-runs');
    dispatchState.runs = body.runs || [];
    renderAgentRuns();
    await loadMissionDispatchProgress();
    if (dispatchState.selectedRunId) await loadAgentRunDetail(dispatchState.selectedRunId);
    syncDispatchRunsTimer();
  } catch (error) {
    const list = document.getElementById('agent-run-list');
    if (list) list.innerHTML = '<p class="muted" role="alert">Could not load runs: ' + escapeClient(redactClient(error.message)) + '</p>';
  }
}

function syncDispatchRunsTimer() {
  const active = dispatchState.runs.some(function (run) { return run.status === 'running' || run.status === 'queued'; });
  const visible = document.body.dataset.activeView === 'dispatch';
  if (active && visible && !dispatchRunsTimer) {
    dispatchRunsTimer = setInterval(function () { if (dispatchState.selectedRunId) loadAgentRunDetail(dispatchState.selectedRunId); }, 2500);
  } else if ((!active || !visible) && dispatchRunsTimer) {
    clearInterval(dispatchRunsTimer);
    dispatchRunsTimer = null;
  }
}

async function loadAgentRunDetail(runId) {
  const target = document.getElementById('agent-run-detail');
  if (!target) return;
  try {
    const body = await dispatchJson('/api/agent-runs/' + encodeURIComponent(runId));
    if (runId !== dispatchState.selectedRunId) return;
    const run = body.run;
    const active = run.status === 'running' || run.status === 'queued';
    const rows = [
      ['Agent', run.agentId + ' (' + run.mode + ')'],
      ['Repository', run.repoRoot],
      ['Branch', run.branch || '—'],
      ['Worktree', run.worktreePath || '—'],
      ['Requested', formatClientTime(run.requestedAt) + ' by ' + run.actorId],
      ['Duration', run.durationMs !== undefined ? Math.round(run.durationMs / 1000) + 's' : '—'],
      ['Exit code', run.exitCode === undefined || run.exitCode === null ? '—' : String(run.exitCode)]
    ].map(function (row) { return '<dt>' + escapeClient(row[0]) + '</dt><dd>' + escapeClient(redactClient(row[1])) + '</dd>'; }).join('');
    const files = run.changedFiles && run.changedFiles.length
      ? '<div><strong>Changed files (' + run.changedFiles.length + ')</strong><ul>' + run.changedFiles.map(function (file) { return '<li><code>' + escapeClient(file) + '</code></li>'; }).join('') + '</ul></div>' : (run.changedFiles ? '<p class="muted">The agent left no uncommitted file changes.' + (run.commitsAhead ? ' It made ' + escapeClient(run.commitsAhead) + ' commit(s) on the branch.' : '') + '</p>' : '');
    const diff = run.diffStat ? '<pre class="run-output" aria-label="Diff summary"></pre>' : '';
    target.innerHTML = '<div class="detail-head"><div><h3>' + escapeClient(run.runId) + '</h3></div><div><span class="pill ' + escapeClient(run.status) + '">' + escapeClient(run.status) + '</span></div></div>' +
      '<dl>' + rows + '</dl>' + (run.error ? '<p role="alert">' + escapeClient(redactClient(run.error)) + '</p>' : '') + files + diff +
      '<div class="approval-actions">' + (active ? '<button type="button" data-agent-run-cancel="' + escapeClient(run.runId) + '">Cancel run</button>' : '') + (run.worktreePath ? '<button type="button" data-copy-text="' + escapeClient(run.worktreePath) + '">Copy worktree path</button>' : '') + '</div>' +
      '<pre class="run-output" id="agent-run-output" aria-label="Agent output"></pre><output id="agent-run-result" role="status" aria-live="polite"></output>';
    const outputNode = document.getElementById('agent-run-output');
    outputNode.textContent = body.output || (active ? 'Waiting for output…' : 'No output was captured.');
    if (run.diffStat) { const pre = target.querySelector('pre[aria-label="Diff summary"]'); if (pre) pre.textContent = run.diffStat; }
    if (active) outputNode.scrollTop = outputNode.scrollHeight;
  } catch (error) {
    target.innerHTML = '<p class="muted" role="alert">Could not load run: ' + escapeClient(redactClient(error.message)) + '</p>';
  }
}

function requestDispatchConfirm(preview, prompt) {
  return new Promise(function (resolve) {
    const existing = document.getElementById('dispatch-confirm-dialog');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'dispatch-confirm-dialog';
    overlay.className = 'approval-confirm-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'dispatch-confirm-title');
    overlay.innerHTML = '<div class="approval-confirm-card dispatch-confirm"><h3 id="dispatch-confirm-title">Dispatch ' + escapeClient(preview.displayName) + '?</h3>' +
      '<dl><dt>Mode</dt><dd>' + escapeClient(preview.mode) + '</dd><dt>Repository</dt><dd>' + escapeClient(preview.repoRoot) + '</dd>' +
      '<dt>Branch</dt><dd>' + escapeClient(preview.branchPattern) + '</dd><dt>Time limit</dt><dd>' + escapeClient(Math.round(preview.timeoutSec / 60)) + ' min</dd>' +
      '<dt>Containment</dt><dd>' + escapeClient(preview.containment) + '</dd><dt>ACS governance</dt><dd>' + escapeClient(preview.governanceSummary) + '</dd><dt>Prompt</dt><dd>' + escapeClient(preview.promptChars) + ' characters (shown below)</dd>' +
      '<dt>Command hash</dt><dd><code>' + escapeClient(preview.confirmationHash.slice(0, 16)) + '…</code></dd></dl>' +
      '<pre class="run-output" id="dispatch-confirm-prompt"></pre>' +
      '<p class="muted">This runs on your machine with your login. It cannot push or merge; it works on its own branch in a new worktree.</p>' +
      '<div class="approval-confirm-actions"><button type="button" id="dispatch-confirm-cancel">Cancel</button><button type="button" id="dispatch-confirm-ok">Dispatch</button></div></div>';
    document.body.appendChild(overlay);
    overlay.querySelector('#dispatch-confirm-prompt').textContent = prompt;
    function finish(value) { document.removeEventListener('keydown', onKey); overlay.remove(); resolve(value); }
    function onKey(event) { if (event.key === 'Escape') { event.preventDefault(); finish(false); } }
    document.addEventListener('keydown', onKey);
    overlay.querySelector('#dispatch-confirm-cancel').addEventListener('click', function () { finish(false); });
    overlay.querySelector('#dispatch-confirm-ok').addEventListener('click', function () { finish(true); });
    overlay.querySelector('#dispatch-confirm-cancel').focus();
  });
}

let pendingMissionDispatch = null;
async function loadMissionDispatchProgress() {
  const target = document.getElementById('mission-dispatch-progress');
  if (!target) return;
  try {
    const body = await dispatchJson('/api/mission-dispatch');
    target.textContent = !body.enabled ? 'Governed mission dispatch is off on this gateway.' :
      (body.dispatches || []).map(function (entry) {
        return entry.missionId + ': ' + (entry.code || (entry.observation && entry.observation.code) || (entry.progress.completion ? 'completed' : entry.progress.operations.map(function (operation) { return operation.operationId + ' ' + operation.status; }).join(', ')));
      }).join('\\n') || 'No governed missions dispatched.';
  } catch (error) { target.textContent = 'Could not load mission progress: ' + redactClient(error.message); }
}
document.addEventListener('submit', async function (event) {
  const form = event.target;
  if (!form || form.id !== 'mission-dispatch-form') return;
  event.preventDefault();
  pendingMissionDispatch = null;
  const output = document.getElementById('mission-dispatch-result');
  const confirm = document.getElementById('mission-dispatch-confirm');
  const review = document.getElementById('mission-dispatch-review');
  confirm.hidden = true;
  review.hidden = true;
  if (!sseConnected) { output.textContent = 'Disconnected: reconnect before reviewing a mission.'; return; }
  const data = new FormData(form);
  const missionId = String(data.get('missionId') || '').trim();
  const approvalId = String(data.get('approvalId') || '').trim();
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  output.textContent = 'Checking the approved mission…';
  try {
    const snapshot = await dispatchJson('/work-items/' + encodeURIComponent(missionId) + '/change-sets');
    const payload = { missionId: missionId, approvalId: approvalId, expectedManifestHash: snapshot.manifestHash };
    const preview = (await dispatchJson('/api/mission-dispatch/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).preview;
    pendingMissionDispatch = Object.assign({}, payload, { confirmationHash: preview.confirmationHash });
    review.textContent = preview.objective + ' — Executor: ' + preview.executingActorId + '. Operations: ' + preview.operations.map(function (operation) { return operation.toolName; }).join(', ') + '. Approval expires: ' + formatClientTime(preview.expiresAt);
    review.hidden = false;
    confirm.hidden = false;
    output.textContent = 'Review the approved operations, then confirm execution.';
  } catch (error) { output.textContent = 'Rejected: ' + redactClient(error.message); }
  finally { submit.disabled = false; }
});
document.addEventListener('input', function (event) {
  if (event.target && event.target.closest && event.target.closest('#mission-dispatch-form')) {
    pendingMissionDispatch = null;
    document.getElementById('mission-dispatch-confirm').hidden = true;
    document.getElementById('mission-dispatch-review').hidden = true;
  }
});
document.addEventListener('click', async function (event) {
  const target = event.target;
  if (!target) return;
  if (target.id === 'mission-dispatch-refresh') { await loadMissionDispatchProgress(); return; }
  if (target.id !== 'mission-dispatch-confirm' || !pendingMissionDispatch) return;
  const output = document.getElementById('mission-dispatch-result');
  if (!sseConnected) { output.textContent = 'Disconnected: reconnect before dispatching.'; return; }
  target.disabled = true;
  try {
    await dispatchJson('/api/mission-dispatch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pendingMissionDispatch) });
    pendingMissionDispatch = null;
    target.hidden = true;
    output.textContent = 'Scheduled for the ACS worker. Accepted scheduling does not mean execution completed.';
    await loadMissionDispatchProgress();
  } catch (error) { output.textContent = 'Rejected: ' + redactClient(error.message); }
  finally { target.disabled = false; }
});

document.addEventListener('submit', async function (event) {
  const form = event.target;
  if (!form || form.id !== 'dispatch-form') return;
  event.preventDefault();
  const output = document.getElementById('dispatch-result');
  const data = new FormData(form);
  const payload = {
    agentId: String(data.get('agentId') || ''),
    repo: String(data.get('repo') || '').trim(),
    mode: String(data.get('mode') || 'edit'),
    prompt: String(data.get('prompt') || '').trim(),
    timeoutSec: Math.min(60, Math.max(1, Number(data.get('minutes')) || 15)) * 60
  };
  if (!payload.agentId || !payload.repo || !payload.prompt) { output.textContent = 'Choose an agent, a repository, and describe the task.'; return; }
  if (!sseConnected) { output.textContent = 'Disconnected: dispatch is disabled until the live stream reconnects.'; return; }
  const submit = form.querySelector('#dispatch-submit');
  submit.disabled = true;
  output.textContent = 'Checking…';
  try {
    const preview = (await dispatchJson('/api/agent-runs/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).preview;
    output.textContent = '';
    if (!(await requestDispatchConfirm(preview, payload.prompt))) { output.textContent = 'Not dispatched.'; return; }
    const started = await dispatchJson('/api/agent-runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({}, payload, { confirmationHash: preview.confirmationHash })) });
    dispatchState.selectedRunId = started.run.runId;
    output.textContent = 'Dispatched ' + started.run.runId;
    announce('Dispatched ' + preview.displayName);
    form.querySelector('textarea[name="prompt"]').value = '';
    await loadAgentRuns();
  } catch (error) {
    output.textContent = 'Rejected: ' + redactClient(error.message);
  } finally {
    submit.disabled = false;
  }
});

document.addEventListener('change', function (event) {
  if (event.target && event.target.matches && event.target.matches('#dispatch-form select[name="agentId"]')) syncDispatchModes();
});

document.addEventListener('click', async function (event) {
  const target = event.target && event.target.closest ? event.target : null;
  if (!target) return;
  const runButton = target.closest('[data-agent-run]');
  if (runButton) { dispatchState.selectedRunId = runButton.dataset.agentRun; renderAgentRuns(); await loadAgentRunDetail(dispatchState.selectedRunId); syncDispatchRunsTimer(); return; }
  const cancel = target.closest('[data-agent-run-cancel]');
  if (cancel) {
    cancel.disabled = true;
    const out = document.getElementById('agent-run-result');
    try { await dispatchJson('/api/agent-runs/' + encodeURIComponent(cancel.dataset.agentRunCancel) + '/cancel', { method: 'POST' }); if (out) out.textContent = 'Cancel requested'; }
    catch (error) { cancel.disabled = false; if (out) out.textContent = 'Rejected: ' + redactClient(error.message); }
    return;
  }
  const copy = target.closest('[data-copy-text]');
  if (copy) { try { await navigator.clipboard.writeText(copy.dataset.copyText); announce('Copied'); } catch { announce('Copy is not available here'); } return; }
  const test = target.closest('[data-cli-test]');
  if (test) {
    test.disabled = true;
    const label = test.textContent;
    test.textContent = 'Testing…';
    try { await dispatchJson('/api/agent-clis/' + encodeURIComponent(test.dataset.cliTest) + '/test', { method: 'POST' }); }
    catch (error) { announce('Test rejected: ' + redactClient(error.message)); }
    test.textContent = label;
    await loadCliAgents();
    return;
  }
  if (target.closest('#cli-agents-refresh')) { await loadCliAgents(); await loadAgentRuns(); return; }
  if (target.closest('#cli-agents-sync')) {
    try { const result = await dispatchJson('/api/agent-clis/sync', { method: 'POST' }); announce('Roster updated: ' + result.created + ' added, ' + result.updated + ' refreshed'); refreshAgentRoster(); }
    catch (error) { announce('Could not update roster: ' + redactClient(error.message)); }
    await loadCliAgents();
  }
});

function onDispatchAuditEvent(eventName) {
  if (!eventName.startsWith('agent_run.') && eventName !== 'agent_cli.tested') return;
  if (document.body.dataset.activeView !== 'dispatch') return;
  if (eventName === 'agent_cli.tested') loadCliAgents(); else loadAgentRuns();
}

function onDispatchViewShown() {
  loadCliAgents();
  loadAgentRuns();
}
`;
}
