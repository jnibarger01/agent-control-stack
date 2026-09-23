import type { WorkItem } from "../api/types";
import { needsAttention } from "./status";

export interface WorkFilters {
  q: string;
  status: string;
  risk: string;
  requester: string;
  source: string;
  agent: string;
  window: string; // "", "1h", "24h", "7d", "30d"
  attention: boolean;
  sort: WorkSort;
  dir: "asc" | "desc";
}

export type WorkSort = "created" | "updated" | "risk" | "status" | "title";

export const DEFAULT_WORK_FILTERS: WorkFilters = {
  q: "",
  status: "",
  risk: "",
  requester: "",
  source: "",
  agent: "",
  window: "",
  attention: false,
  sort: "created",
  dir: "desc"
};

const WINDOWS_MS: Record<string, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000
};
const RISK_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function parseWorkFilters(params: URLSearchParams): WorkFilters {
  const sort = params.get("sort");
  const dir = params.get("dir");
  return {
    q: params.get("q") ?? "",
    status: params.get("status") ?? "",
    risk: params.get("risk") ?? "",
    requester: params.get("requester") ?? "",
    source: params.get("source") ?? "",
    agent: params.get("agent") ?? "",
    window: params.get("window") ?? "",
    attention: params.get("attention") === "1",
    sort: sort === "updated" || sort === "risk" || sort === "status" || sort === "title" ? sort : "created",
    dir: dir === "asc" ? "asc" : "desc"
  };
}

export function serializeWorkFilters(filters: WorkFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of ["q", "status", "risk", "requester", "source", "agent", "window"] as const) {
    if (filters[key]) params.set(key, filters[key]);
  }
  if (filters.attention) params.set("attention", "1");
  if (filters.sort !== DEFAULT_WORK_FILTERS.sort) params.set("sort", filters.sort);
  if (filters.dir !== DEFAULT_WORK_FILTERS.dir) params.set("dir", filters.dir);
  return params;
}

/** Where a work item came from: the webhook source ACS recorded, else retry/clone lineage, else direct creation. */
export function workItemSource(item: WorkItem): string {
  return item.metadata?.webhookSource ?? item.lineageType ?? "direct";
}

export function workItemTargetLabel(item: WorkItem): string {
  const target = item.target ?? {};
  return target.services?.[0] ?? target.repo ?? target.cwd ?? target.files?.[0] ?? "—";
}

export function applyWorkFilters(
  items: readonly WorkItem[],
  filters: WorkFilters,
  now: number,
  agentByItem?: ReadonlyMap<string, string>
): WorkItem[] {
  const q = filters.q.trim().toLowerCase();
  const windowMs = WINDOWS_MS[filters.window];
  const out = items.filter((item) => {
    if (filters.status && item.status !== filters.status) return false;
    if (filters.risk && item.risk !== filters.risk) return false;
    if (filters.requester && item.requester !== filters.requester && item.requesterSubject !== filters.requester)
      return false;
    if (filters.source && workItemSource(item) !== filters.source) return false;
    if (filters.agent && agentByItem?.get(item.id) !== filters.agent) return false;
    if (filters.attention && !needsAttention(item.status)) return false;
    if (windowMs !== undefined && now - Date.parse(item.createdAt) > windowMs) return false;
    if (q) {
      const haystack = [
        item.id,
        item.title,
        item.intent,
        item.requester,
        item.requesterSubject,
        workItemTargetLabel(item)
      ]
        .filter((part): part is string => typeof part === "string")
        .join("\n")
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
  const sign = filters.dir === "asc" ? 1 : -1;
  return out.sort((a, b) => {
    let cmp: number;
    switch (filters.sort) {
      case "updated":
        cmp = a.updatedAt.localeCompare(b.updatedAt);
        break;
      case "risk":
        cmp = (RISK_RANK[a.risk] ?? 0) - (RISK_RANK[b.risk] ?? 0);
        break;
      case "status":
        cmp = a.status.localeCompare(b.status);
        break;
      case "title":
        cmp = a.title.localeCompare(b.title);
        break;
      default:
        cmp = a.createdAt.localeCompare(b.createdAt);
    }
    return sign * (cmp || a.id.localeCompare(b.id));
  });
}

export function paginate<T>(
  items: readonly T[],
  page: number,
  pageSize: number
): { rows: T[]; pages: number; page: number } {
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const clamped = Math.min(Math.max(1, page), pages);
  return { rows: items.slice((clamped - 1) * pageSize, clamped * pageSize), pages, page: clamped };
}
