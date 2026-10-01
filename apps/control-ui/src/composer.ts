/**
 * New Task Composer (#17): action-kind suggestions from the policy's supported
 * kinds, optional JSON params, and a live policy preview
 * (`POST /dashboard/policy-preview`) before anything is created.
 */
import { escapeHtml } from "./html.js";

export const COMPOSER_PREVIEW_DEBOUNCE_MS = 600;
export const DEFAULT_ACTION_KIND = "agent.prompt";

export function composerHtml(
  actionKinds: readonly string[] = [],
  agents: readonly { id: string; displayName: string; metadata: Record<string, string> }[] = []
): string {
  const options = actionKinds.map((kind) => `<option value="${escapeHtml(kind)}"></option>`).join("");
  const agentOptions = agents
    .filter((agent) => agent.metadata.registered === "true")
    .map((agent) => `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.displayName)}</option>`)
    .join("");
  return `<form id="task-form" novalidate data-known-action-kinds="${escapeHtml(JSON.stringify(actionKinds))}">
    <label>Task title<input name="title" required maxlength="120" placeholder="Investigate a failing route" /></label>
    <label>What should the agent do?<textarea name="intent" required rows="4" placeholder="Describe the goal and what a good result looks like."></textarea></label>
    <div class="form-row">
      <label>Agent<select name="service" required><option value="">Choose an agent</option>${agentOptions}</select></label>
      <label>Project / repo<input name="repo" placeholder="/home/jacen/projects/agent-control-stack" /></label>
    </div>
    <label class="composer-worktree" style="display:flex;align-items:center;gap:.55rem"><input type="checkbox" name="newWorktree" value="true" checked style="width:auto;min-width:auto" /> Use a new worktree</label>
    <details class="composer-advanced"><summary>Advanced options</summary>
      <label>Risk<select name="risk"><option>low</option><option selected>medium</option><option>high</option><option>critical</option></select></label>
      <label>Action kind<input name="actionKind" list="composer-action-kinds" autocomplete="off" spellcheck="false" placeholder="${DEFAULT_ACTION_KIND}" aria-describedby="composer-kind-hint" /></label>
      <datalist id="composer-action-kinds">${options}</datalist>
      <small id="composer-kind-hint" class="field-hint">${actionKinds.length ? "Policy-approved action kinds are suggested; other kinds are denied." : "Defaults to " + DEFAULT_ACTION_KIND + "."}</small>
      <label>Action description<input name="actionDescription" placeholder="Defaults to prompt dispatch" /></label>
      <label>Action parameters (JSON, optional)<textarea name="actionParams" rows="3" spellcheck="false" placeholder='{"paths": ["README.md"]}' aria-describedby="composer-params-error"></textarea></label>
      <small id="composer-params-error" class="field-error" role="alert"></small>
    </details>
    <section id="composer-preview" class="composer-preview" aria-live="polite" aria-label="Policy preview"><p class="muted">Add a title, goal, and agent to check policy.</p></section>
    <div class="composer-actions"><button type="button" id="composer-preview-button" class="tool-button">Check policy</button><button type="submit">Create task</button></div><output id="task-result"></output>
  </form>`;
}

/** Relies on the dashboard client's `escapeClient`, `announce`, and `scheduleDashboardRefresh`. */
export function composerClientSource(): string {
  return `
const composerForm = document.getElementById('task-form');
let composerKnownKinds = [];
try { composerKnownKinds = JSON.parse(composerForm ? composerForm.dataset.knownActionKinds || '[]' : '[]'); } catch {}
let composerPreviewTimer = null;
let composerPreviewSeq = 0;

function composerDraft(form) {
  const data = new FormData(form);
  const kind = String(data.get('actionKind') || '').trim() || '${DEFAULT_ACTION_KIND}';
  const description = String(data.get('actionDescription') || '').trim() || 'Dispatch prompt to selected agent';
  const service = String(data.get('service') || '').trim();
  const repo = String(data.get('repo') || '').trim();
  const newWorktree = data.get('newWorktree') === 'true';
  const intent = String(data.get('intent') || '');
  const rawParams = String(data.get('actionParams') || '').trim();
  let params = {};
  let paramsError = '';
  if (rawParams) {
    try {
      params = JSON.parse(rawParams);
      if (params === null || typeof params !== 'object' || Array.isArray(params)) paramsError = 'Params must be a JSON object, like {"paths": ["README.md"]}.';
    } catch (error) {
      paramsError = 'Params are not valid JSON: ' + (error && error.message ? error.message : 'parse error');
    }
  }
  return {
    ready: Boolean(String(data.get('title') || '').trim() && intent.trim() && service),
    kind: kind,
    paramsError: paramsError,
    payload: {
      title: String(data.get('title') || ''),
      intent: intent + (newWorktree ? '\\n\\nWorktree preference: use a new git worktree for this task.' : '\\n\\nWorktree preference: use the selected project checkout.'),
      risk: String(data.get('risk') || 'medium'),
      target: { services: [service], ...(repo ? { repo } : {}), ...(repo.startsWith("/") ? { cwd: repo } : {}) },
      requestedActions: [{ kind: kind, description: description, params: paramsError ? {} : params }]
    }
  };
}

function showComposerParamsError(form, message) {
  const field = form.querySelector('[name="actionParams"]');
  const error = document.getElementById('composer-params-error');
  if (error) error.textContent = message;
  if (field) {
    if (message) field.setAttribute('aria-invalid', 'true'); else field.removeAttribute('aria-invalid');
  }
}

const previewOutcomeCopy = {
  auto_admitted: 'Would be auto-admitted: no approval needed.',
  needs_approval: 'Would wait for operator approval.',
  blocked: 'Would be blocked by policy.',
  rejected: 'Would be rejected before policy runs.'
};

function renderComposerPreview(preview) {
  const root = document.getElementById('composer-preview');
  if (!root) return;
  root.dataset.outcome = preview.outcome || '';
  const actions = Array.isArray(preview.actions) ? preview.actions : [];
  root.innerHTML = '<p class="preview-outcome"><strong>' + escapeClient(previewOutcomeCopy[preview.outcome] || preview.outcome || 'Unknown') + '</strong> ' + escapeClient(preview.reason || '') + '</p>' +
    (actions.length ? '<ul class="preview-actions">' + actions.map(function (action) {
      return '<li><code>' + escapeClient(action.kind) + '</code> ' + pillMarkup(action.decision) + ' <small>' + escapeClient(action.reason) + '</small></li>';
    }).join('') + '</ul>' : '') +
    (Array.isArray(preview.matchedRules) && preview.matchedRules.length ? '<small class="muted">Rules: ' + escapeClient(preview.matchedRules.join(', ')) + '</small>' : '');
}

function renderComposerHint(form, draft) {
  const hint = document.getElementById('composer-kind-hint');
  if (!hint || !composerKnownKinds.length) return;
  const unknown = composerKnownKinds.indexOf(draft.kind) === -1;
  hint.classList.toggle('field-error', unknown);
  hint.textContent = unknown
    ? draft.kind + ' is not an action kind policy knows; it will be denied.'
    : 'Suggestions are the action kinds policy evaluates; any other kind is denied.';
}

async function previewComposerPolicy(form) {
  const draft = composerDraft(form);
  renderComposerHint(form, draft);
  showComposerParamsError(form, draft.paramsError);
  const root = document.getElementById('composer-preview');
  if (!draft.ready) {
    if (root) { root.dataset.outcome = ''; root.innerHTML = '<p class="muted">Add a title, goal, and agent to check policy.</p>'; }
    return;
  }
  if (draft.paramsError) return;
  const seq = ++composerPreviewSeq;
  try {
    const res = await fetch('/dashboard/policy-preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(draft.payload)
    });
    const body = await res.json().catch(function () { return {}; });
    if (seq !== composerPreviewSeq) return;
    if (!res.ok) {
      if (root) { root.dataset.outcome = 'error'; root.innerHTML = '<p class="muted">Preview unavailable: ' + escapeClient(body.error || body.code || res.status) + '</p>'; }
      return;
    }
    renderComposerPreview(body);
  } catch (error) {
    if (seq === composerPreviewSeq && root) { root.dataset.outcome = 'error'; root.innerHTML = '<p class="muted">Preview unavailable.</p>'; }
  }
}

function scheduleComposerPreview(form) {
  if (composerPreviewTimer) clearTimeout(composerPreviewTimer);
  composerPreviewTimer = setTimeout(function () {
    composerPreviewTimer = null;
    void previewComposerPolicy(form);
  }, ${COMPOSER_PREVIEW_DEBOUNCE_MS});
}

composerForm?.addEventListener('input', function () { scheduleComposerPreview(composerForm); });
composerForm?.addEventListener('change', function () { scheduleComposerPreview(composerForm); });
document.getElementById('composer-preview-button')?.addEventListener('click', function () { void previewComposerPolicy(composerForm); });

composerForm?.addEventListener('submit', async function (event) {
  event.preventDefault();
  const form = composerForm;
  const result = document.getElementById('task-result');
  const draft = composerDraft(form);
  showComposerParamsError(form, draft.paramsError);
  if (!draft.ready) {
    if (result) result.textContent = 'Task title, instructions, and agent are required';
    (form.querySelector('[name="title"]').value.trim() ? (form.querySelector('[name="intent"]').value.trim() ? form.querySelector('[name="service"]') : form.querySelector('[name="intent"]')) : form.querySelector('[name="title"]')).focus();
    return;
  }
  if (draft.paramsError) {
    if (result) result.textContent = 'Fix the action params first';
    form.querySelector('[name="actionParams"]')?.focus();
    return;
  }
  const res = await fetch('/work-items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft.payload) });
  const body = await res.json().catch(function () { return {}; });
  const createdId = body.id || (body.workItem && body.workItem.id) || '';
  if (result) result.textContent = res.ok ? 'Created ' + createdId + (body.status ? ' (' + body.status + ')' : '') : 'Rejected: ' + (body.error || res.status);
  if (res.ok) {
    form.reset();
    composerPreviewSeq += 1;
    const root = document.getElementById('composer-preview');
    if (root) { root.dataset.outcome = ''; root.innerHTML = '<p class="muted">Add a title, goal, and agent to check policy.</p>'; }
    announce('Created ' + createdId);
    scheduleDashboardRefresh(0);
  }
});
`;
}
