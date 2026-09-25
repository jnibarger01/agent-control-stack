import { escapeHtml } from "./html.js";

/** High/critical risk (elevated require_approval) needs a second confirm before POST. */
export function isElevatedApprovalRisk(risk: string): boolean {
  const normalized = String(risk ?? "")
    .trim()
    .toLowerCase();
  return normalized === "high" || normalized === "critical";
}

/** Short prefix of an action hash for confirm dialog copy (full hash stays on the button). */
export function approvalActionHashPrefix(hash: string, maxLen = 12): string {
  const text = String(hash ?? "");
  if (!text) return "";
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

export type ApprovalConfirmRequest = {
  workItemId: string;
  action: "approve" | "reject" | "cancel" | "retry" | "clone";
  actionHash?: string;
  /** Requested action kind the hash approves, when known. */
  actionKind?: string;
  risk: string;
};

export type ApprovalConfirmDocument = {
  body: { appendChild(node: HTMLElement): unknown };
  createElement(tagName: string): HTMLElement;
  addEventListener(type: string, listener: (event: KeyboardEvent) => void): void;
  removeEventListener(type: string, listener: (event: KeyboardEvent) => void): void;
  getElementById(id: string): HTMLElement | null;
  activeElement?: { focus?(): void } | null;
};

/** Confirm dialog copy. Cancel's dismiss button must not read "Cancel". */
export const CONFIRM_COPY: Record<
  ApprovalConfirmRequest["action"],
  { label: string; heading: string; dismiss: string }
> = {
  approve: { label: "Approve", heading: "Approve high-risk work item?", dismiss: "Cancel" },
  reject: { label: "Deny", heading: "Deny high-risk work item?", dismiss: "Cancel" },
  cancel: { label: "Cancel work item", heading: "Cancel this work item?", dismiss: "Keep work item" },
  retry: { label: "Retry", heading: "Retry this work item as a new item?", dismiss: "Go back" },
  clone: { label: "Clone", heading: "Clone this work item as a new item?", dismiss: "Go back" }
};

/**
 * Modal confirm for elevated-risk approve/deny and for work-item controls.
 * Esc or Cancel resolves false without side effects; Confirm resolves true.
 * Initial focus is on Cancel (confirm is never the default focused control).
 */
export function requestApprovalConfirm(
  doc: ApprovalConfirmDocument,
  request: ApprovalConfirmRequest
): Promise<boolean> {
  return new Promise((resolve) => {
    const existing = doc.getElementById("approval-confirm-dialog");
    if (existing) existing.remove();

    const overlay = doc.createElement("div");
    overlay.id = "approval-confirm-dialog";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "approval-confirm-title");
    overlay.className = "approval-confirm-overlay";

    const copy = CONFIRM_COPY[request.action];
    const actionLabel = copy.label;
    const hashPrefix = approvalActionHashPrefix(request.actionHash ?? "");
    const hashLine = hashPrefix
      ? `<p class="approval-confirm-hash">Action hash: <code>${escapeHtml(hashPrefix)}</code></p>`
      : "";
    const kindLine = request.actionKind
      ? `<p class="approval-confirm-kind">Action: <code>${escapeHtml(request.actionKind)}</code></p>`
      : "";

    overlay.innerHTML = `<div class="approval-confirm-card">
  <h3 id="approval-confirm-title">${escapeHtml(copy.heading)}</h3>
  <p class="approval-confirm-id">Work item: <code>${escapeHtml(request.workItemId)}</code></p>
  <p class="approval-confirm-risk">Risk: <strong>${escapeHtml(request.risk)}</strong></p>
  ${kindLine}
  ${hashLine}
  <div class="approval-confirm-actions">
    <button type="button" id="approval-confirm-cancel" data-approval-confirm-cancel>${escapeHtml(copy.dismiss)}</button>
    <button type="button" id="approval-confirm-ok" data-approval-confirm-ok>${escapeHtml(actionLabel)}</button>
  </div>
</div>`;

    const finish = (confirmed: boolean) => {
      doc.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      resolve(confirmed);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    };

    doc.body.appendChild(overlay);
    doc.addEventListener("keydown", onKeyDown);

    const cancelBtn = overlay.querySelector("#approval-confirm-cancel") as HTMLElement | null;
    const okBtn = overlay.querySelector("#approval-confirm-ok") as HTMLElement | null;
    cancelBtn?.addEventListener("click", () => finish(false));
    okBtn?.addEventListener("click", () => finish(true));
    // Confirm must not be the initially focused control.
    cancelBtn?.focus?.();
  });
}

export type ApprovalPostResult = {
  posted: boolean;
  confirmed?: boolean;
  cancelled?: boolean;
  status?: number;
  error?: string;
};

export type ApprovalActionClickOptions = {
  document: ApprovalConfirmDocument & {
    querySelector(selectors: string): { value?: string; focus?(): void; textContent?: string | null } | null;
  };
  button: {
    dataset: {
      approve?: string;
      reject?: string;
      unblock?: string;
      actionHash?: string;
      actionKind?: string;
      risk?: string;
    };
    getAttribute?(name: string): string | null;
  };
  connected: boolean;
  fetchImpl: (
    input: string,
    init: { method: string; headers: Record<string, string>; body: string }
  ) => Promise<{
    ok: boolean;
    status: number;
    json(): Promise<{ error?: string; code?: string }>;
  }>;
  /** Optional override for tests; defaults to requestApprovalConfirm. */
  requestConfirm?: (doc: ApprovalConfirmDocument, request: ApprovalConfirmRequest) => Promise<boolean>;
};

/**
 * Shared approve/deny/unblock click path used by Mission Control (and component tests).
 * Elevated risk requires a confirm step before POST; Cancel/Esc leaves state unchanged.
 */
export async function handleApprovalActionClick(options: ApprovalActionClickOptions): Promise<ApprovalPostResult> {
  const { button, connected, fetchImpl } = options;
  const doc = options.document;
  const id = button.dataset.approve || button.dataset.reject || button.dataset.unblock;
  if (!id) return { posted: false, error: "missing work item id" };
  const action = button.dataset.approve ? "approve" : button.dataset.reject ? "reject" : "unblock";
  const risk =
    button.dataset.risk || (typeof button.getAttribute === "function" ? button.getAttribute("data-risk") : null) || "";
  const output = doc.querySelector("#approval-result-" + id);
  if (!connected) {
    if (output) output.textContent = "Disconnected: actions disabled until reconnect";
    return { posted: false, error: "disconnected" };
  }
  const reasonInput = doc.querySelector('[data-reason="' + id + '"]');
  const reason = reasonInput && typeof reasonInput.value === "string" ? reasonInput.value.trim() : "";
  if (action !== "unblock" && !reason) {
    if (output) output.textContent = "Reason required";
    reasonInput?.focus?.();
    return { posted: false, error: "reason required" };
  }

  if ((action === "approve" || action === "reject") && isElevatedApprovalRisk(risk)) {
    if (doc.getElementById("approval-confirm-dialog")) {
      // Another confirm is already open — do not POST.
      return { posted: false, cancelled: true };
    }
    const confirmFn = options.requestConfirm ?? requestApprovalConfirm;
    const confirmed = await confirmFn(doc, {
      workItemId: id,
      action,
      actionHash: button.dataset.actionHash,
      actionKind: button.dataset.actionKind,
      risk
    });
    if (!confirmed) {
      return { posted: false, cancelled: true, confirmed: false };
    }
  }

  const headers = { "content-type": "application/json" };
  const payload: Record<string, string> = action === "unblock" ? {} : { reason };
  if (action === "approve") {
    const actionHash = button.dataset.actionHash;
    if (!actionHash) {
      if (output) output.textContent = "Approval action hash unavailable";
      return { posted: false, error: "action hash unavailable" };
    }
    payload.actionHash = actionHash;
  }
  const res = await fetchImpl("/work-items/" + id + "/" + action, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });
  const body = await res.json();
  if (output) {
    output.textContent = res.ok ? action + " accepted" : "Rejected: " + (body.error || body.code || res.status);
  }
  return {
    posted: true,
    confirmed: true,
    status: res.status,
    error: res.ok ? undefined : body.error || body.code || String(res.status)
  };
}
