/**
 * Immediate operator-impact helpers. None of these mutate work items or policy.
 */

export const LAST_VIEW_STORAGE_KEY = "acs.mc.lastView";
export const FOCUS_RING_TOKEN = "3px solid var(--accent)";
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export const KNOWN_VIEWS = [
  "overview",
  "queue",
  "execution",
  "approvals",
  "agents",
  "dispatch",
  "executors",
  "connectors",
  "metrics",
  "audit",
  "policy",
  "system"
] as const;

export type KnownView = (typeof KNOWN_VIEWS)[number];

/** 11. Compact relative time. Unparseable input is explicit, not a blank. */
export function relativeTime(iso: string, now: Date): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "unknown time";
  const delta = now.getTime() - parsed;
  const future = delta < 0;
  const seconds = Math.floor(Math.abs(delta) / 1000);
  if (seconds < 10) return future ? "in a moment" : "just now";
  const suffix = future ? "from now" : "ago";
  if (seconds < 60) return `${seconds}s ${suffix}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${suffix}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${suffix}`;
  return `${Math.floor(hours / 24)}d ${suffix}`;
}

const SECRETISH = /(?:secret|token|password|api[_-]?key|bearer\s)/i;

/**
 * 12. Clipboard payload is the work-item id only. Rejects blank, oversized,
 * whitespace, markup, and secret-looking strings.
 */
export function clipboardPayload(workItemId: string): string | undefined {
  const id = workItemId.trim();
  if (!id || id.length > 128 || SECRETISH.test(id) || /[\s<>"'`]/.test(id)) return undefined;
  return id;
}

/** 13. Filter-aware empty copy. A non-empty hidden queue is not "no work items". */
export function emptyQueueMessage(filterActive: boolean, total: number): string {
  if (total <= 0) return "No work items.";
  if (filterActive) return "No work items match this filter. Clear filters to see the full queue.";
  return "No work items.";
}

export interface ShortcutEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
}

/** 14. Refresh shortcut is bare `r`, and never while typing or with modifiers. */
export function shouldHandleRefreshShortcut(event: ShortcutEvent, typing: boolean): boolean {
  if (typing || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return false;
  return event.key === "r";
}

/** 15. Only canonical dashboard views may be restored. Anything else is ignored. */
export function parseStoredView(value: string | null | undefined): KnownView | undefined {
  if (!value) return undefined;
  return (KNOWN_VIEWS as readonly string[]).includes(value) ? (value as KnownView) : undefined;
}

/** 16. High-contrast focus ring token. Applied only when the operator opts in. */
export function focusRingToken(): string {
  return FOCUS_RING_TOKEN;
}

/** 17. Media query the stylesheet and client both honor. */
export function reducedMotionQuery(): string {
  return REDUCED_MOTION_QUERY;
}

export interface NavBadgeCounts {
  approvals: number;
  attention: number;
  failed: number;
}

/** 18. Nav badge counts. Attention includes quarantined; failed includes blocked. */
export function navBadgeCounts(items: readonly { status: string }[]): NavBadgeCounts {
  let approvals = 0;
  let attention = 0;
  let failed = 0;
  for (const item of items) {
    if (item.status === "needs_approval") approvals += 1;
    if (item.status === "needs_approval" || item.status === "blocked" || item.status === "quarantined") attention += 1;
    if (item.status === "failed" || item.status === "blocked") failed += 1;
  }
  return { approvals, attention, failed };
}

export interface FilterChipInput {
  statuses: readonly string[];
  risks: readonly string[];
  agentId: string;
  text: string;
}

/** 19. Short summary of which filter chips are narrowing the queue. */
export function filterChipSummary(filter: FilterChipInput): string {
  const parts: string[] = [];
  if (filter.statuses.length) parts.push(`${filter.statuses.length} status${filter.statuses.length === 1 ? "" : "es"}`);
  if (filter.risks.length) parts.push(`${filter.risks.length} risk${filter.risks.length === 1 ? "" : "s"}`);
  if (filter.agentId.trim()) parts.push("agent");
  if (filter.text.trim()) parts.push("text");
  return parts.length ? parts.join(", ") : "all items";
}

/**
 * 20. Admin mode always requires an explicit operator confirmation.
 * This helper cannot enable admin mode.
 */
export function adminModeMustConfirm(): true {
  return true;
}
