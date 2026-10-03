/**
 * Operator controls for a single work item: cancel, retry, clone.
 *
 * These are mutating controls. Eligibility mirrors the backend rules
 * (packages/work-items state machine + store): the gateway still enforces
 * them, the UI only avoids offering controls that are certain to fail.
 * One table and one template feed both the server-rendered markup and the inline client.
 */
import { escapeHtml } from "./html.js";

export type WorkItemControl = "cancel" | "retry" | "clone";

export const WORK_ITEM_CONTROLS: readonly WorkItemControl[] = ["cancel", "retry", "clone"];

/** Statuses each control is offered for. `"*"` means any status. */
export const WORK_ITEM_CONTROL_STATUSES: Readonly<Record<WorkItemControl, readonly string[]>> = {
  // Non-terminal statuses with a direct transition to `cancelled`.
  cancel: ["draft", "pending_policy", "needs_approval", "approved", "running", "blocked"],
  // Store requires a terminal source item; retry creates a linked work item.
  retry: ["succeeded", "failed", "cancelled", "rejected"],
  // Clone creates a new linked work item from any source.
  clone: ["*"]
};

/** Controls that must carry an operator reason. */
export const REASON_REQUIRED_CONTROLS: readonly WorkItemControl[] = ["cancel", "retry"];

export const WORK_ITEM_CONTROL_LABELS: Readonly<Record<WorkItemControl, string>> = {
  cancel: "Cancel work item",
  retry: "Retry as new item",
  clone: "Clone as new item"
};

export function workItemControlsFor(status: string): WorkItemControl[] {
  return WORK_ITEM_CONTROLS.filter((control) => {
    const statuses = WORK_ITEM_CONTROL_STATUSES[control];
    return statuses.includes("*") || statuses.includes(status);
  });
}

export interface WorkItemControlsView {
  id: string;
  title: string;
  status: string;
  risk: string;
}

interface ControlsTemplateTables {
  controls: readonly WorkItemControl[];
  statuses: Readonly<Record<WorkItemControl, readonly string[]>>;
  labels: Readonly<Record<WorkItemControl, string>>;
  reasonRequired: readonly WorkItemControl[];
}

/**
 * The single template for the controls section. It is deliberately self-contained (no module-level
 * references): the server calls it directly and the dashboard client receives its source text via
 * `Function.prototype.toString`, so the two renderings cannot drift. Keep it plain ES2022 JavaScript.
 */
function renderControlsTemplate(
  workItem: { id: string; title: string; status: string; risk: string },
  connected: boolean,
  esc: (value: string) => string,
  tables: ControlsTemplateTables
): string {
  const controls = tables.controls.filter((control) => {
    const statuses = tables.statuses[control];
    return statuses.includes("*") || statuses.includes(workItem.status);
  });
  if (!controls.length) return "";
  const id = esc(workItem.id);
  const reasonId = `control-reason-${id}`;
  const needsReason = controls.some((control) => tables.reasonRequired.includes(control));
  const reason = needsReason
    ? `<label class="reason-field" for="${reasonId}"><span class="reason-label">Reason <span class="req">(required for cancel and retry)</span></span><input id="${reasonId}" data-control-reason="${id}" autocomplete="off" placeholder="Why cancel or retry" /></label>`
    : "";
  const buttons = controls
    .map(
      (control) =>
        `<button type="button" data-work-control="${control}" data-work-item-id="${id}" data-risk="${esc(workItem.risk)}"${needsReason ? ` aria-describedby="${reasonId}"` : ""}${connected ? "" : " disabled"}>${tables.labels[control]}</button>`
    )
    .join("");
  return `<div class="detail-section work-controls" data-work-controls="${id}"><h4>Controls</h4>${reason}<div class="approval-actions" role="group" aria-label="Controls for ${esc(workItem.title)}">${buttons}</div><output id="control-result-${id}" class="approval-result" aria-live="polite"></output></div>`;
}

const CONTROLS_TEMPLATE_TABLES: ControlsTemplateTables = {
  controls: WORK_ITEM_CONTROLS,
  statuses: WORK_ITEM_CONTROL_STATUSES,
  labels: WORK_ITEM_CONTROL_LABELS,
  reasonRequired: REASON_REQUIRED_CONTROLS
};

/** Controls section for the work-item detail panel. Empty when nothing applies. */
export function workItemControlsHtml(workItem: WorkItemControlsView, connected = true): string {
  return renderControlsTemplate(workItem, connected, escapeHtml, CONTROLS_TEMPLATE_TABLES);
}

function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * Client-side markup builder and delegated click handler. Relies on the
 * dashboard client's `escapeClient`, `sseConnected`, `isElevatedApprovalRisk`,
 * and `requestApprovalConfirm`.
 */
export function workItemControlsClientSource(): string {
  return `
const reasonRequiredControls = ${scriptSafeJson(REASON_REQUIRED_CONTROLS)};
const renderControlsTemplate = ${renderControlsTemplate.toString()};
const controlsTemplateTables = ${scriptSafeJson(CONTROLS_TEMPLATE_TABLES)};
function workItemControlsMarkup(workItem, connected) {
  return renderControlsTemplate(
    { id: workItem.id, title: workItem.title, status: String(workItem.status || ''), risk: workItem.risk },
    connected,
    escapeClient,
    controlsTemplateTables
  );
}
let workItemControlInFlight = false;
document.addEventListener('click', async function (event) {
  const button = event.target && event.target.closest ? event.target.closest('[data-work-control]') : null;
  if (!button) return;
  const control = button.dataset.workControl;
  const id = button.dataset.workItemId;
  const output = document.getElementById('control-result-' + id);
  const say = function (text) { if (output) output.textContent = text; };
  if (!sseConnected) { say('Disconnected: controls disabled until reconnect'); return; }
  if (workItemControlInFlight || document.getElementById('approval-confirm-dialog')) return;
  const reasonInput = document.querySelector('[data-control-reason="' + id + '"]');
  const reason = reasonInput ? reasonInput.value.trim() : '';
  if (reasonRequiredControls.indexOf(control) !== -1 && !reason) {
    say('Reason required');
    if (reasonInput) reasonInput.focus();
    return;
  }
  const risk = button.dataset.risk || '';
  if (control === 'cancel' || isElevatedApprovalRisk(risk)) {
    const confirmed = await requestApprovalConfirm({ workItemId: id, action: control, risk: risk });
    if (!confirmed) { say(''); return; }
  }
  workItemControlInFlight = true;
  button.disabled = true;
  try {
    const payload = control === 'clone' ? {} : { reason: reason };
    const res = await fetch('/work-items/' + encodeURIComponent(id) + '/' + control, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const body = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      say('Rejected: ' + (body.error || body.code || res.status));
      return;
    }
    const created = control === 'cancel' ? '' : (body.workItem && body.workItem.id) || '';
    say(control === 'cancel' ? 'cancel accepted' : control + ' created ' + created);
    if (typeof onWorkItemControlSucceeded === 'function') onWorkItemControlSucceeded(control, id, body);
  } catch (error) {
    say('Request failed: ' + (error && error.message ? error.message : 'network error'));
  } finally {
    workItemControlInFlight = false;
    button.disabled = !sseConnected;
  }
});
`;
}
