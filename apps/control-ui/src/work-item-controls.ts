/**
 * Operator controls for a single work item: cancel, retry, clone.
 *
 * These are mutating controls. Eligibility mirrors the backend rules
 * (packages/work-items state machine + store): the gateway still enforces
 * them, the UI only avoids offering controls that are certain to fail.
 * One table feeds both the server-rendered markup and the inline client.
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

/** Controls section for the work-item detail panel. Empty when nothing applies. */
export function workItemControlsHtml(workItem: WorkItemControlsView, connected = true): string {
  const controls = workItemControlsFor(workItem.status);
  if (!controls.length) return "";
  const id = escapeHtml(workItem.id);
  const reasonId = `control-reason-${id}`;
  const needsReason = controls.some((control) => REASON_REQUIRED_CONTROLS.includes(control));
  const reason = needsReason
    ? `<label class="reason-field" for="${reasonId}"><span class="reason-label">Reason <span class="req">(required for cancel and retry)</span></span><input id="${reasonId}" data-control-reason="${id}" autocomplete="off" placeholder="Why cancel or retry" /></label>`
    : "";
  const buttons = controls
    .map(
      (control) =>
        `<button type="button" data-work-control="${control}" data-work-item-id="${id}" data-risk="${escapeHtml(workItem.risk)}"${needsReason ? ` aria-describedby="${reasonId}"` : ""}${connected ? "" : " disabled"}>${WORK_ITEM_CONTROL_LABELS[control]}</button>`
    )
    .join("");
  return `<div class="detail-section work-controls" data-work-controls="${id}"><h4>Controls</h4>${reason}<div class="approval-actions" role="group" aria-label="Controls for ${escapeHtml(workItem.title)}">${buttons}</div><output id="control-result-${id}" class="approval-result" aria-live="polite"></output></div>`;
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
const workItemControlStatuses = ${scriptSafeJson(WORK_ITEM_CONTROL_STATUSES)};
const workItemControlLabels = ${scriptSafeJson(WORK_ITEM_CONTROL_LABELS)};
const reasonRequiredControls = ${scriptSafeJson(REASON_REQUIRED_CONTROLS)};
function workItemControlsFor(status) {
  return ${scriptSafeJson(WORK_ITEM_CONTROLS)}.filter(function (control) {
    const statuses = workItemControlStatuses[control];
    return statuses.indexOf('*') !== -1 || statuses.indexOf(status) !== -1;
  });
}
function workItemControlsMarkup(workItem, connected) {
  const controls = workItemControlsFor(String(workItem.status || ''));
  if (!controls.length) return '';
  const id = escapeClient(workItem.id);
  const reasonId = 'control-reason-' + id;
  const needsReason = controls.some(function (control) { return reasonRequiredControls.indexOf(control) !== -1; });
  const reason = needsReason
    ? '<label class="reason-field" for="' + reasonId + '"><span class="reason-label">Reason <span class="req">(required for cancel and retry)</span></span><input id="' + reasonId + '" data-control-reason="' + id + '" autocomplete="off" placeholder="Why cancel or retry" /></label>'
    : '';
  const buttons = controls.map(function (control) {
    return '<button type="button" data-work-control="' + control + '" data-work-item-id="' + id + '" data-risk="' + escapeClient(workItem.risk) + '"' + (needsReason ? ' aria-describedby="' + reasonId + '"' : '') + (connected ? '' : ' disabled') + '>' + workItemControlLabels[control] + '</button>';
  }).join('');
  return '<div class="detail-section work-controls" data-work-controls="' + id + '"><h4>Controls</h4>' + reason + '<div class="approval-actions" role="group" aria-label="Controls for ' + escapeClient(workItem.title) + '">' + buttons + '</div><output id="control-result-' + id + '" class="approval-result" aria-live="polite"></output></div>';
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
