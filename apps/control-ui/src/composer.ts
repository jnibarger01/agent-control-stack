/**
 * New Task Composer (#17): action-kind suggestions from the policy's supported
 * kinds, optional JSON params, and a live policy preview
 * (`POST /dashboard/policy-preview`) before anything is created.
 */
import { escapeHtml } from "./html.js";

export const COMPOSER_PREVIEW_DEBOUNCE_MS = 600;
export const DEFAULT_ACTION_KIND = "agent.prompt";

export function composerHtml(actionKinds: readonly string[] = []): string {
  const options = actionKinds.map((kind) => `<option value="${escapeHtml(kind)}"></option>`).join("");
  return `<form id="task-form" novalidate data-known-action-kinds="${escapeHtml(JSON.stringify(actionKinds))}">
    <label>Title<input name="title" required maxlength="120" placeholder="Investigate failing agent route" /></label>
    <label>Prompt / instructions<textarea name="intent" required rows="7" placeholder="State the objective, constraints, and expected output."></textarea></label>
    <div class="form-row"><label>Risk<select name="risk"><option>low</option><option selected>medium</option><option>high</option><option>critical</option></select></label><label>Target service<input name="service" placeholder="codex-agent, hermes, worker" /></label></div>
    <label>Requested action kind<input name="actionKind" list="composer-action-kinds" autocomplete="off" spellcheck="false" placeholder="${DEFAULT_ACTION_KIND}" aria-describedby="composer-kind-hint" /></label>
    <datalist id="composer-action-kinds">${options}</datalist>
    <small id="composer-kind-hint" class="field-hint">${actionKinds.length ? "Suggestions are the action kinds policy evaluates; any other kind is denied." : "Defaults to " + DEFAULT_ACTION_KIND + "."}</small>
    <label>Requested action description<input name="actionDescription" placeholder="Defaults to prompt dispatch when blank" /></label>
    <label>Action params (JSON object, optional)<textarea name="actionParams" rows="3" spellcheck="false" placeholder='{"paths": ["README.md"]}' aria-describedby="composer-params-error"></textarea></label>
    <small id="composer-params-error" class="field-error" role="alert"></small>
    <section id="composer-preview" class="composer-preview" aria-live="polite" aria-label="Policy preview"><p class="muted">Fill in a title and instructions to preview policy.</p></section>
    <div class="composer-actions"><button type="button" id="composer-preview-button" class="tool-button">Check policy</button><button type="submit">Create Work Item</button></div><output id="task-result"></output>
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
    ready: Boolean(String(data.get('title') || '').trim() && String(data.get('intent') || '').trim()),
    kind: kind,
    paramsError: paramsError,
    payload: {
      title: String(data.get('title') || ''),
      intent: String(data.get('intent') || ''),
      risk: String(data.get('risk') || 'medium'),
      target: service ? { services: [service] } : {},
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
    if (root) { root.dataset.outcome = ''; root.innerHTML = '<p class="muted">Fill in a title and instructions to preview policy.</p>'; }
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
    if (result) result.textContent = 'Title and instructions are required';
    (form.querySelector('[name="title"]').value.trim() ? form.querySelector('[name="intent"]') : form.querySelector('[name="title"]')).focus();
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
    if (root) { root.dataset.outcome = ''; root.innerHTML = '<p class="muted">Fill in a title and instructions to preview policy.</p>'; }
    announce('Created ' + createdId);
    scheduleDashboardRefresh(0);
  }
});
`;
}
