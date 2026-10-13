/**
 * Read-only operator insights. These functions never approve, deny, or execute.
 * They only classify data the dashboard already has.
 */

export const RISK_WEIGHT: Readonly<Record<string, number>> = {
  critical: 100,
  high: 70,
  medium: 40,
  low: 10
};

const ATTENTION_STATUSES = new Set(["needs_approval", "blocked", "quarantined"]);

export interface ScoreableWorkItem {
  id?: string;
  risk: string;
  status: string;
  createdAt: string;
}

/** 1. Higher score means the operator should look at the item sooner. */
export function riskWeightedQueueScore(item: ScoreableWorkItem, now: Date): number {
  const risk = RISK_WEIGHT[item.risk] ?? 0;
  const attention = ATTENTION_STATUSES.has(item.status) ? 25 : 0;
  const created = Date.parse(item.createdAt);
  const ageHours = Number.isFinite(created) ? Math.max(0, (now.getTime() - created) / 3_600_000) : 0;
  return risk + attention + Math.min(20, Math.floor(ageHours));
}

export type SlaClass = "unknown" | "ok" | "warning" | "breach";

/** 2. Warning starts at 75% of the SLA. Non-positive SLA is unknown, not a breach. */
export function classifyApprovalSla(waitMs: number | undefined, slaMs: number): SlaClass {
  if (waitMs === undefined || !Number.isFinite(waitMs) || waitMs < 0) return "unknown";
  if (!Number.isFinite(slaMs) || slaMs <= 0) return "unknown";
  if (waitMs >= slaMs) return "breach";
  if (waitMs >= slaMs * 0.75) return "warning";
  return "ok";
}

export interface LeaseExpiry {
  id: string;
  expiresAt: string;
}

/** 3. A lease is stale when its expiry is at or before now. Unparseable times are ignored. */
export function detectStaleLeases(leases: readonly LeaseExpiry[], now: Date): string[] {
  const nowMs = now.getTime();
  return leases
    .filter((lease) => {
      const expires = Date.parse(lease.expiresAt);
      return lease.id.trim() !== "" && Number.isFinite(expires) && expires <= nowMs;
    })
    .map((lease) => lease.id);
}

/** 4. Missing positive integer sequences between the min and max present values. */
export function detectAuditSequenceGaps(events: readonly { sequence: number }[]): number[] {
  const sequences = [...new Set(events.map((event) => event.sequence))]
    .filter((sequence) => Number.isInteger(sequence) && sequence > 0)
    .sort((left, right) => left - right);
  const gaps: number[] = [];
  for (let index = 1; index < sequences.length; index += 1) {
    const previous = sequences[index - 1];
    const current = sequences[index];
    if (previous === undefined || current === undefined) continue;
    for (let missing = previous + 1; missing < current; missing += 1) gaps.push(missing);
  }
  return gaps;
}

export type AgeBucket = "fresh" | "aging" | "stale" | "ancient" | "unknown";

/** 5. Age buckets from createdAt. Future or unparseable times are unknown. */
export function bucketWorkItemAge(createdAt: string, now: Date): AgeBucket {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return "unknown";
  const hours = (now.getTime() - created) / 3_600_000;
  if (hours < 0) return "unknown";
  if (hours < 1) return "fresh";
  if (hours < 24) return "aging";
  if (hours < 24 * 7) return "stale";
  return "ancient";
}

export function bucketWorkItemAges(
  items: readonly { id: string; createdAt: string }[],
  now: Date
): Record<AgeBucket, string[]> {
  const buckets: Record<AgeBucket, string[]> = { fresh: [], aging: [], stale: [], ancient: [], unknown: [] };
  for (const item of items) buckets[bucketWorkItemAge(item.createdAt, now)].push(item.id);
  return buckets;
}

export type AgentActivity = "active" | "idle" | "stale" | "unknown";

/** 6. Heartbeat age. Defaults: active < 5m, idle < 30m, otherwise stale. */
export function classifyAgentActivity(
  lastSeenAt: string | undefined,
  now: Date,
  idleAfterMs = 5 * 60 * 1000,
  staleAfterMs = 30 * 60 * 1000
): AgentActivity {
  if (!lastSeenAt) return "unknown";
  const seen = Date.parse(lastSeenAt);
  if (!Number.isFinite(seen)) return "unknown";
  const age = now.getTime() - seen;
  if (age < 0) return "unknown";
  if (age < idleAfterMs) return "active";
  if (age < staleAfterMs) return "idle";
  return "stale";
}

/** Normalized intent key used for duplicate detection. Not an authority token. */
export function normalizeIntentKey(intent: string): string {
  return intent.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
}

/** 7. Groups ids that share a normalized intent. Singletons are omitted. */
export function detectDuplicateIntents(items: readonly { id: string; intent: string }[]): Record<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const item of items) {
    const key = normalizeIntentKey(item.intent);
    if (!key || !item.id) continue;
    const list = groups.get(key) ?? [];
    list.push(item.id);
    groups.set(key, list);
  }
  // Prototype-free: untrusted intents may normalize to "__proto__".
  const duplicates: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const [key, ids] of groups) {
    if (ids.length > 1) duplicates[key] = ids;
  }
  return duplicates;
}

/** 8. Fraction of decisions whose outcome is deny/denied. Empty input is undefined, not zero. */
export function policyDenialRate(decisions: readonly { outcome: string }[]): number | undefined {
  if (decisions.length === 0) return undefined;
  const denied = decisions.filter((decision) => {
    const outcome = decision.outcome.trim().toLowerCase();
    return outcome === "deny" || outcome === "denied";
  }).length;
  return denied / decisions.length;
}

/** 9. Items whose retry sequence has reached the threshold. Default threshold is 3. */
export function detectRetryStorms(
  items: readonly { id: string; retrySequence?: number }[],
  threshold = 3
): string[] {
  if (!Number.isFinite(threshold) || threshold < 1) return [];
  return items.filter((item) => (item.retrySequence ?? 0) >= threshold && item.id.trim() !== "").map((item) => item.id);
}

/**
 * 10. Display-only warning. Admin mode never implies live execution, and this
 * function does not change execution mode.
 */
export function executionModeDisplayWarning(
  executionMode: string | undefined,
  resultMode: string | undefined
): string | undefined {
  if (executionMode === "admin" && resultMode === "dry_run") {
    return "Admin mode is on, but this result is still dry-run. Admin mode does not prove live execution.";
  }
  if (executionMode === "admin") {
    return "Admin mode disables human approval. This display does not grant execution authority.";
  }
  return undefined;
}
