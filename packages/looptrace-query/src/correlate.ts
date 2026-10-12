import { STAGES, type EvidenceEvent } from "./model.js";

export interface Correlated {
  /** Deduplicated, deterministically ordered events. */
  events: EvidenceEvent[];
  duplicates: string[];
  /** Same event_id from the same source with different content: neither is trusted blindly. */
  conflicts: Array<{ event_id: string; hashes: string[] }>;
  /** [effect_event_id, cause_event_id] where the effect is timestamped BEFORE its cause. */
  skew: Array<{ effect: string; cause: string; delta_ms: number }>;
  /** Events naming a cause that is not present in the evidence (lost parent). */
  missingCauses: Array<{ event_id: string; cause: string }>;
  /** Events with no usable timestamp (ordered last). */
  untimed: string[];
}

const SKEW_TOLERANCE_MS = 2000;
const stageRank = new Map<string, number>([...STAGES.map((s, i) => [s as string, i + 1] as const), ["lifecycle", 99]]);

/**
 * Merges events from any number of sources. Never invents ordering: ordering is by source
 * timestamp, with stage rank as a tiebreak, and any causal inversion is REPORTED (clock skew),
 * not silently corrected.
 */
export function correlate(input: EvidenceEvent[]): Correlated {
  const byId = new Map<string, EvidenceEvent>();
  const hashesById = new Map<string, Set<string>>();
  const duplicates: string[] = [];
  for (const e of input) {
    const hashes = hashesById.get(e.event_id) ?? new Set<string>();
    hashes.add(e.integrity.content_hash);
    hashesById.set(e.event_id, hashes);
    if (byId.has(e.event_id)) duplicates.push(e.event_id);
    else byId.set(e.event_id, e);
  }
  const conflicts = [...hashesById.entries()]
    .filter(([, h]) => h.size > 1)
    .map(([event_id, h]) => ({ event_id, hashes: [...h].sort() }));

  const events = [...byId.values()].sort((a, b) => {
    const ta = a.timestamp ? Date.parse(a.timestamp) : Number.POSITIVE_INFINITY;
    const tb = b.timestamp ? Date.parse(b.timestamp) : Number.POSITIVE_INFINITY;
    if (ta !== tb) return ta < tb ? -1 : 1;
    const ra = stageRank.get(a.stage) ?? 99;
    const rb = stageRank.get(b.stage) ?? 99;
    if (ra !== rb) return ra - rb;
    return a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;
  });

  const skew: Correlated["skew"] = [];
  const missingCauses: Correlated["missingCauses"] = [];
  for (const e of events) {
    for (const cause of e.causes) {
      const c = byId.get(cause);
      if (!c) {
        missingCauses.push({ event_id: e.event_id, cause });
        continue;
      }
      if (e.timestamp && c.timestamp) {
        const delta = Date.parse(e.timestamp) - Date.parse(c.timestamp);
        if (delta < -SKEW_TOLERANCE_MS) skew.push({ effect: e.event_id, cause, delta_ms: delta });
      }
    }
  }
  return {
    events,
    duplicates: [...new Set(duplicates)].sort(),
    conflicts,
    skew,
    missingCauses,
    untimed: events.filter((e) => e.timestamp === null).map((e) => e.event_id)
  };
}
