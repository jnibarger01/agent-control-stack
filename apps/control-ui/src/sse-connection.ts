import {
  MUTATING_CONTROL_SELECTOR,
  MUTATION_GATE_MARKER_ATTRIBUTE,
  MUTATION_GATE_WAS_DISABLED_ATTRIBUTE
} from "./mutation-gate.js";

export type SseConnectionRoot = {
  querySelector(selectors: string): SseConnectionElement | null;
  querySelectorAll(selectors: string): ArrayLike<SseConnectionButton>;
};

export type SseConnectionElement = {
  hidden: boolean;
  classList: { toggle(token: string, force?: boolean): unknown };
  innerHTML: string;
};

export type SseConnectionButton = {
  disabled: boolean;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

/** Exponential backoff for EventSource reconnect: 1s, 2s, 4s, 8s, 16s, then 30s cap. */
export function nextSseReconnectDelayMs(attempt: number): number {
  const n = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  return Math.min(30_000, 1_000 * 2 ** Math.min(n, 5));
}

/**
 * Fail-closed gate over every mutating control (wave-2 plan item #18).
 *
 * While the stream is stale every declared control is disabled. On reconnect a
 * control returns to the state the server rendered, so a control disabled for
 * another reason — for example an approve button whose action hash is
 * unavailable — is never enabled by the gate.
 */
export function applyMutationGate(root: SseConnectionRoot, enabled: boolean): void {
  for (const control of Array.from(root.querySelectorAll(MUTATING_CONTROL_SELECTOR))) {
    const gated = control.getAttribute(MUTATION_GATE_MARKER_ATTRIBUTE) !== null;
    if (!enabled) {
      if (!gated) {
        control.setAttribute(MUTATION_GATE_MARKER_ATTRIBUTE, "1");
        if (control.disabled) control.setAttribute(MUTATION_GATE_WAS_DISABLED_ATTRIBUTE, "1");
      }
      control.disabled = true;
      continue;
    }
    if (gated) {
      control.disabled = control.getAttribute(MUTATION_GATE_WAS_DISABLED_ATTRIBUTE) !== null;
      control.removeAttribute(MUTATION_GATE_MARKER_ATTRIBUTE);
      control.removeAttribute(MUTATION_GATE_WAS_DISABLED_ATTRIBUTE);
    }
    // An approval with no bound action hash can never be submitted.
    if (control.getAttribute("data-approve") !== null && control.getAttribute("data-action-hash") === null) {
      control.disabled = true;
    }
  }
}

/** Show/hide the stale-stream banner and gate every mutating control while disconnected. */
export function applySseConnectionState(root: SseConnectionRoot, connected: boolean): void {
  const banner = root.querySelector("#sse-stale-banner");
  if (banner) banner.hidden = connected;
  const live = root.querySelector(".live");
  if (live) {
    live.classList.toggle("disconnected", !connected);
    // Static literal markup, no interpolated data: safe for innerHTML.
    live.innerHTML = connected
      ? `<span aria-hidden="true"></span> Live`
      : `<span aria-hidden="true"></span> Disconnected`;
  }
  applyMutationGate(root, connected);
}
