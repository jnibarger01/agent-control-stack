/**
 * UI/UX helpers for Mission Control. Local-only preferences; no authority.
 */

export const DENSITY_STORAGE_KEY = "acs.mc.density";
export const SORT_STORAGE_KEY = "acs.mc.queueSort";
export const PINS_STORAGE_KEY = "acs.mc.pins";
export const RECENT_STORAGE_KEY = "acs.mc.recent";
export const FOCUS_STORAGE_KEY = "acs.mc.focusPlus";

export type Density = "comfortable" | "compact";
export type QueueSort = "server" | "attention" | "newest" | "oldest" | "risk" | "id";

/** 21. Unknown density values fall back to comfortable so the layout cannot collapse. */
export function densityClass(value: string | null | undefined): Density {
  return value === "compact" ? "compact" : "comfortable";
}

const RISK_RANK: Readonly<Record<string, number>> = { critical: 0, high: 1, medium: 2, low: 3 };

function attentionRank(status: string): number {
  return status === "needs_approval" || status === "blocked" || status === "quarantined" ? 0 : 1;
}

export interface SortableQueueItem {
  id: string;
  status: string;
  risk: string;
  createdAt: string;
}

/** 22. Stable sort. `server` preserves the incoming order. */
export function sortQueueItems<T extends SortableQueueItem>(items: readonly T[], sort: QueueSort): T[] {
  const copy = items.map((item, index) => ({ item, index }));
  if (sort === "server") return copy.map((entry) => entry.item);
  copy.sort((left, right) => {
    if (sort === "id") return left.item.id.localeCompare(right.item.id) || left.index - right.index;
    if (sort === "risk") {
      return (RISK_RANK[left.item.risk] ?? 9) - (RISK_RANK[right.item.risk] ?? 9) || left.index - right.index;
    }
    if (sort === "newest" || sort === "oldest") {
      const leftTime = Date.parse(left.item.createdAt);
      const rightTime = Date.parse(right.item.createdAt);
      const leftValue = Number.isFinite(leftTime) ? leftTime : 0;
      const rightValue = Number.isFinite(rightTime) ? rightTime : 0;
      const delta = sort === "newest" ? rightValue - leftValue : leftValue - rightValue;
      return delta || left.index - right.index;
    }
    return attentionRank(left.item.status) - attentionRank(right.item.status) || left.index - right.index;
  });
  return copy.map((entry) => entry.item);
}

export function parseQueueSort(value: string | null | undefined): QueueSort {
  if (value === "attention" || value === "newest" || value === "oldest" || value === "risk" || value === "id") return value;
  return "server";
}

/** 23. Pin toggle stores ids only, newest pin first, capped. */
export function togglePinnedId(pins: readonly string[], id: string, max = 20): string[] {
  const clean = id.trim();
  if (!clean) return [...pins];
  if (pins.includes(clean)) return pins.filter((pin) => pin !== clean);
  return [clean, ...pins.filter((pin) => pin !== clean)].slice(0, Math.max(1, max));
}

/** 24. Most-recently viewed ids, deduped, capped. Titles and intents are never stored. */
export function pushRecentId(recent: readonly string[], id: string, max = 8): string[] {
  const clean = id.trim();
  if (!clean) return [...recent];
  return [clean, ...recent.filter((entry) => entry !== clean)].slice(0, Math.max(1, max));
}

export interface CommandResult {
  label: string;
  keywords?: string;
}

/** 25. Prefix matches outrank substring matches, which outrank keyword matches. */
export function rankCommandResults<T extends CommandResult>(query: string, results: readonly T[]): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...results];
  return results
    .map((item, index) => {
      const label = item.label.toLowerCase();
      const keywords = (item.keywords ?? "").toLowerCase();
      let score = 0;
      if (label.startsWith(needle)) score = 3;
      else if (label.includes(needle)) score = 2;
      else if (keywords.includes(needle)) score = 1;
      return { item, index, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.item);
}

/** 26. Extra skip targets. The main-content skip link stays first. */
export const SKIP_LINK_TARGETS = [
  { href: "#main-content", label: "Skip to main content" },
  { href: "#approvals", label: "Skip to approvals" },
  { href: "#queue", label: "Skip to work queue" }
] as const;

/** 27. Live-region text for filter result counts. */
export function filterCountAnnouncement(visible: number, total: number): string {
  const shown = Math.max(0, Math.floor(visible));
  const all = Math.max(0, Math.floor(total));
  if (shown === all) return `Showing all ${all} work items`;
  return `Showing ${shown} of ${all} work items`;
}

const STATUS_GLYPHS: Readonly<Record<string, string>> = {
  needs_approval: "!",
  blocked: "×",
  quarantined: "!",
  failed: "×",
  running: "▶",
  succeeded: "✓",
  approved: "✓",
  cancelled: "–",
  pending_policy: "…",
  draft: "·"
};

/** 28. Status is never color-only. The glyph is paired with the status word in the label. */
export function statusGlyph(status: string): string {
  return STATUS_GLYPHS[status] ?? "•";
}

export function statusGlyphLabel(status: string): string {
  return `${statusGlyph(status)} ${status.replaceAll("_", " ")}`;
}

/** 29. Print stylesheet that keeps the audit trail and hides chrome. */
export function printAuditCss(): string {
  return `@media print {
  aside, .header-controls, .page-actions, #command-results, .tool-button, #operator-toolbar { display: none !important; }
  body { background: white; color: black; }
  [data-view-panel="audit"], #events, #audit-operations { display: block !important; }
}`;
}

/** 30. Operator timezone label. Falls back to UTC when Intl rejects the zone. */
export function timezoneLabel(now: Date, timeZone?: string): string {
  const zone = timeZone && timeZone.trim() ? timeZone.trim() : "UTC";
  try {
    const formatted = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).format(now);
    return `${zone} · ${formatted}`;
  } catch {
    return "UTC";
  }
}
