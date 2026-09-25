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
};

/** Exponential backoff for EventSource reconnect: 1s, 2s, 4s, 8s, 16s, then 30s cap. */
export function nextSseReconnectDelayMs(attempt: number): number {
  const n = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  return Math.min(30_000, 1_000 * 2 ** Math.min(n, 5));
}

/** Show/hide the stale-stream banner and disable approve/deny/unblock and work-item controls while disconnected. */
export function applySseConnectionState(root: SseConnectionRoot, connected: boolean): void {
  const banner = root.querySelector("#sse-stale-banner");
  if (banner) banner.hidden = connected;
  const live = root.querySelector(".live");
  if (live) {
    live.classList.toggle("disconnected", !connected);
    live.innerHTML = connected
      ? `<span aria-hidden="true"></span> Live`
      : `<span aria-hidden="true"></span> Disconnected`;
  }
  for (const button of Array.from(
    root.querySelectorAll("[data-approve],[data-reject],[data-unblock],[data-work-control]")
  )) {
    const approveWithoutHash = button.getAttribute("data-approve") !== null && !button.getAttribute("data-action-hash");
    button.disabled = !connected || approveWithoutHash;
  }
}
