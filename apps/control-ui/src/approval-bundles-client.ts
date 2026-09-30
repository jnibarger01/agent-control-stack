import type { ApprovalBundleReview, ApprovalDeltaEntryView } from "./approval-bundles.js";

/**
 * Inline client source for the approval bundle review.
 *
 * Composed into the page exactly like the other `*ClientSource()` modules, so the
 * behaviour ships with the server markup that it operates on and needs no bundler.
 *
 * Two invariants this deliberately keeps:
 *
 * - Nothing is ever approved implicitly. "Approve all" posts `approve_all`; the
 *   selection controls post `approve_selected` with the ids the operator actually
 *   left ticked. There is no path that sends an empty selection and hopes for the best.
 * - A reason is required before any decision, matching the existing approval flow.
 */

export const BUNDLE_REFRESH_EVENT_NAMES = [
  "approval_bundle.created",
  "approval_bundle.revised",
  "approval_bundle.approved",
  "approval_bundle.partially_approved",
  "approval_bundle.rejected",
  "approval_bundle.invalidated",
  "approval_strategy.changed"
] as const;

export function approvalBundlesClientSource(): string {
  return `
${BUNDLE_REFRESH_EVENT_NAMES.map((name) => `    '${name}',`).join("\n")}
document.addEventListener('click', function (event) {
  var button = event.target && event.target.closest
    ? event.target.closest('[data-bundle-decision],[data-bundle-tab]')
    : null;
  if (!button || button.disabled) return;
  if (button.dataset.bundleTab) {
    event.preventDefault();
    selectBundleTab(button);
    return;
  }
  if (!sseConnected) {
    var gate = bundleOutputFor(button.dataset.bundleId);
    if (gate) gate.textContent = 'Reconnect before deciding';
    return;
  }
  event.preventDefault();
  postBundleDecision(button);
});
document.addEventListener('change', function (event) {
  var input = event.target && event.target.closest ? event.target.closest('[data-approval-strategy]') : null;
  if (!input) return;
  if (!sseConnected) {
    input.checked = false;
    return;
  }
  postApprovalStrategy(input);
});
`;
}

/**
 * Preserve bundle operator state across live fragment patches.
 *
 * Without this, a typed reason or a deliberate set of unticked changes would be
 * silently discarded every time an SSE event refreshed the section.
 */
export function captureApprovalBundleOperatorState(): {
  reasons: Record<string, string>;
  outputs: Record<string, string>;
  unticked: Record<string, string[]>;
} {
  const reasons: Record<string, string> = {};
  const outputs: Record<string, string> = {};
  const unticked: Record<string, string[]> = {};
  document.querySelectorAll<HTMLInputElement>("[data-bundle-reason]").forEach(function (input) {
    const id = input.dataset.bundleReason;
    if (id) {
      reasons[id] = String(input.value || "");
    }
  });
  document.querySelectorAll<HTMLElement>(".approval-result[id^='bundle-result-']").forEach(function (node) {
    outputs[node.id] = String(node.textContent || "");
  });
  document.querySelectorAll<HTMLElement>("[data-bundle-ref]").forEach(function (card) {
    const bundleId = card.dataset.bundleRef;
    if (!bundleId) {
      return;
    }
    unticked[bundleId] = Array.prototype.slice
      .call(card.querySelectorAll("[data-bundle-select]"))
      .filter(function (input: Element) {
        return !(input as HTMLInputElement).checked;
      })
      .map(function (input: Element) {
        return (input as HTMLInputElement).dataset.bundleSelect ?? "";
      })
      .filter((value: string) => value.length > 0);
  });
  return { reasons, outputs, unticked };
}

export function restoreApprovalBundleOperatorState(state: {
  reasons: Record<string, string>;
  outputs: Record<string, string>;
  unticked: Record<string, string[]>;
}): void {
  Object.entries(state.reasons).forEach(([bundleId, reason]) => {
    const input = document.querySelector<HTMLInputElement>('[data-bundle-reason="' + bundleId + '"]');
    if (input) {
      input.value = reason;
    }
  });
  Object.entries(state.outputs).forEach(([nodeId, text]) => {
    const node = document.getElementById(nodeId);
    if (node) {
      node.textContent = text;
    }
  });
  Object.entries(state.unticked).forEach(([bundleId, changeIds]) => {
    document
      .querySelectorAll<HTMLInputElement>('[data-bundle-ref="' + bundleId + '"] [data-bundle-select]')
      .forEach(function (input) {
        const id = input.dataset.bundleSelect;
        if (id) {
          input.checked = !changeIds.includes(id);
        }
      });
  });
}

export type { ApprovalBundleReview, ApprovalDeltaEntryView };
