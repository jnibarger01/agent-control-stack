import { type ExecutionAttempt, type WorkItem } from "@agent-control-stack/work-items";
import { type MissionControlAttemptLease } from "./types.js";

/** Canonical work-item statuses used by the queue filter chips. Unknown values are ignored (no-op). */
export const WORK_ITEM_STATUS_VALUES = [
  "draft",
  "pending_policy",
  "needs_approval",
  "approved",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
  "rejected",
  "unknown",
  "quarantined"
] as const;

const KNOWN_WORK_ITEM_STATUSES: ReadonlySet<string> = new Set(WORK_ITEM_STATUS_VALUES);

export type QueueFilter = {
  /** Status chips selected by the operator. Unknown entries are ignored when matching. */
  statuses: string[];
  /** Optional agent / worker / target id (case-insensitive substring). */
  agentId: string;
  /** Free-text match against work-item title and id (case-insensitive substring). */
  text: string;
};

export function emptyQueueFilter(): QueueFilter {
  return { statuses: [], agentId: "", text: "" };
}

export function isQueueFilterEmpty(filter: QueueFilter): boolean {
  return filter.statuses.length === 0 && filter.agentId.trim() === "" && filter.text.trim() === "";
}

/** Derive the agent/target id shown for queue filtering (target first, else latest worker). */
export function workItemAgentId(
  item: Pick<WorkItem, "target">,
  attempts: ExecutionAttempt[] = [],
  leases: MissionControlAttemptLease[] = []
): string {
  const fromTarget = item.target.services?.[0] ?? item.target.repo ?? item.target.cwd;
  if (fromTarget) return fromTarget;
  const attempt = attempts.at(-1);
  const lease = [...leases].reverse().find((candidate) => attempt && candidate.attemptId === attempt.attemptId);
  return lease?.workerId ?? attempt?.claimedByWorkerId ?? "";
}

function collectStatusParams(params: URLSearchParams): string[] {
  const raw = [...params.getAll("status")];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    for (const part of entry.split(",")) {
      const status = part.trim();
      if (!status || seen.has(status)) continue;
      seen.add(status);
      out.push(status);
    }
  }
  return out;
}

function paramsFromLocationLike(
  source: string | URLSearchParams | { search?: string; hash?: string }
): URLSearchParams {
  if (typeof source === "string") {
    const trimmed = source.trim();
    if (!trimmed) return new URLSearchParams();
    if (trimmed.startsWith("?")) return new URLSearchParams(trimmed.slice(1));
    if (trimmed.startsWith("#")) {
      const hash = trimmed.slice(1);
      const query = hash.includes("?")
        ? hash.slice(hash.indexOf("?") + 1)
        : hash.includes("=")
          ? hash.replace(/^[A-Za-z0-9_-]+&/, "")
          : "";
      return new URLSearchParams(query);
    }
    return new URLSearchParams(trimmed.includes("=") ? trimmed : "");
  }
  if (source instanceof URLSearchParams) {
    return new URLSearchParams(source.toString());
  }
  const search = (source.search ?? "").replace(/^\?/, "");
  if (search) return new URLSearchParams(search);
  const hash = (source.hash ?? "").replace(/^#/, "");
  if (!hash) return new URLSearchParams();
  if (hash.includes("?")) return new URLSearchParams(hash.slice(hash.indexOf("?") + 1));
  if (hash.includes("=")) return new URLSearchParams(hash.replace(/^[A-Za-z0-9_-]+&/, ""));
  return new URLSearchParams();
}

/** Read queue filter from URL search params or hash (e.g. `?status=running&q=foo` or `#queue?status=running`). */
export function parseQueueFilter(
  source: string | URLSearchParams | { search?: string; hash?: string } = ""
): QueueFilter {
  const params = paramsFromLocationLike(source);
  return {
    statuses: collectStatusParams(params),
    agentId: (params.get("agent") ?? "").trim(),
    text: (params.get("q") ?? params.get("text") ?? "").trim()
  };
}

export function serializeQueueFilter(filter: QueueFilter): URLSearchParams {
  const params = new URLSearchParams();
  for (const status of filter.statuses.map((value) => value.trim()).filter(Boolean)) {
    params.append("status", status);
  }
  if (filter.agentId.trim()) params.set("agent", filter.agentId.trim());
  if (filter.text.trim()) params.set("q", filter.text.trim());
  return params;
}

export type QueueFilterableItem = {
  id: string;
  title: string;
  status: string;
  agentId?: string;
};

/** Client-side filter over the in-memory / already-rendered queue model. */
export function filterWorkItems<T extends QueueFilterableItem>(items: T[], filter: QueueFilter): T[] {
  const knownStatuses = filter.statuses.filter((status) => KNOWN_WORK_ITEM_STATUSES.has(status));
  // Unknown status chips are a no-op: they do not narrow (and do not error).
  const text = filter.text.trim().toLowerCase();
  const agent = filter.agentId.trim().toLowerCase();
  if (!knownStatuses.length && !text && !agent) return items;

  return items.filter((item) => {
    if (knownStatuses.length > 0 && !knownStatuses.includes(item.status)) return false;
    if (text) {
      const haystack = `${item.title} ${item.id}`.toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    if (agent) {
      const itemAgent = (item.agentId ?? "").toLowerCase();
      if (!itemAgent.includes(agent)) return false;
    }
    return true;
  });
}

export type QueueFilterDomRoot = {
  querySelector(selectors: string): QueueFilterDomElement | null;
  querySelectorAll(selectors: string): ArrayLike<QueueFilterDomElement>;
};

export type QueueFilterDomElement = {
  hidden?: boolean;
  textContent?: string | null;
  getAttribute(name: string): string | null;
  classList?: { toggle(token: string, force?: boolean): unknown };
};

/** Hide non-matching queue buttons and announce the visible count via aria-live. */
export function applyQueueFilterToDom(root: QueueFilterDomRoot, filter: QueueFilter): number {
  const nodeList = root.querySelectorAll("[data-work-item]");
  const queueButtons = Array.from({ length: nodeList.length }, (_, index) => nodeList[index]!);
  let visible = 0;
  for (const el of queueButtons) {
    const id = el.getAttribute("data-work-item") ?? "";
    const title = el.getAttribute("data-title") ?? "";
    const status = el.getAttribute("data-status") ?? "";
    const agentId = el.getAttribute("data-agent-id") ?? "";
    const show = filterWorkItems([{ id, title, status, agentId }], filter).length > 0;
    if ("hidden" in el) el.hidden = !show;
    el.classList?.toggle("queue-item-filtered-out", !show);
    if (show) visible += 1;
  }
  const total = queueButtons.length;
  // Treat "only unknown statuses" as empty for the count label.
  const effectivelyEmpty =
    isQueueFilterEmpty(filter) ||
    (filter.statuses.every((status) => !KNOWN_WORK_ITEM_STATUSES.has(status)) &&
      filter.agentId.trim() === "" &&
      filter.text.trim() === "");
  const count = root.querySelector("#queue-filter-count");
  if (count) {
    count.textContent = effectivelyEmpty ? `${total} items` : `${visible} of ${total} items`;
  }
  const live = root.querySelector("#queue-filter-live");
  if (live) {
    live.textContent = effectivelyEmpty
      ? `Showing all ${total} work items`
      : `Showing ${visible} of ${total} work items`;
  }
  return visible;
}
