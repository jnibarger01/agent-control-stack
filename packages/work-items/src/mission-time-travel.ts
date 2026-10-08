import { domainHash } from "@agent-control-stack/shared";
import type { WorkItemStore } from "./store.js";

/** A read-only projection. It never executes or authorizes historical actions. */
export const MISSION_TIME_TRAVEL_VERSION = "acs.mission-time-travel.v1" as const;
type Ledger = Pick<WorkItemStore, "verifyAuditChain" | "getMissionTrace">;
export interface TimeTravelEvent {
  sequence: number;
  id: string;
  name: string;
  timeUnixNano: string;
  eventHash: string;
  previousHash: string;
  category: "authorization" | "routing" | "execution" | "verification" | "lifecycle" | "other";
  actorIdHash?: string;
  attemptIdHash?: string;
  leaseIdHash?: string;
  actionHash?: string;
  evidenceManifestHash?: string;
}
export interface MissionTimeTravelSnapshot {
  schemaVersion: typeof MISSION_TIME_TRAVEL_VERSION;
  missionId: string;
  asOfSequence: number | null;
  auditHeadHash: string;
  auditEventCount: number;
  integrity: "full-chain-verified";
  sideEffects: "disabled";
  events: TimeTravelEvent[];
  snapshotHash: string;
}
// Correlation data can come from caller-controlled audit event attributes.
// Expose bounded, domain-separated digests, never raw identities or secrets.
function correlationDigest(value: unknown, field: string): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    ? domainHash(MISSION_TIME_TRAVEL_VERSION + "." + field, value)
    : undefined;
}
function safeEvidenceHash(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : undefined;
}
function category(name: string): TimeTravelEvent["category"] {
  if (/^(policy|approval|authorization|capability|grant|admin)[._]/u.test(name)) return "authorization";
  if (/^(route|routing|dispatch)[._]/u.test(name)) return "routing";
  if (/^(execution|worker|tool|lease|attempt|command|work_unit)[._]/u.test(name)) return "execution";
  if (/^(verification|evidence|review|validation)[._]/u.test(name)) return "verification";
  if (/^(mission|coding_mission|work_item|change_set)[._]/u.test(name)) return "lifecycle";
  return "other";
}
const safeNumber = (n: number) => Number.isSafeInteger(n) && n >= 0;

/**
 * Local shape and content-hash consistency only. An untrusted producer can
 * recalculate snapshotHash; NEVER use this predicate as historical evidence.
 */
function locallyConsistent(value: MissionTimeTravelSnapshot): boolean {
  if (
    !value || typeof value !== "object" ||
    value.schemaVersion !== MISSION_TIME_TRAVEL_VERSION ||
    value.integrity !== "full-chain-verified" ||
    value.sideEffects !== "disabled" ||
    !Array.isArray(value.events) ||
    !safeNumber(value.auditEventCount) ||
    (value.asOfSequence !== null && !safeNumber(value.asOfSequence)) ||
    !/^[a-f0-9]{64}$/u.test(value.auditHeadHash)
  ) return false;
  let prior = 0;
  const seen = new Set<string>();
  for (const e of value.events) {
    if (
      !e || typeof e !== "object" ||
      !safeNumber(e.sequence) ||
      e.sequence <= prior ||
      typeof e.id !== "string" || seen.has(e.id) ||
      (value.asOfSequence !== null && e.sequence > value.asOfSequence) ||
      typeof e.eventHash !== "string" || !/^[a-f0-9]{64}$/u.test(e.eventHash) ||
      (e.previousHash !== "" && !/^[a-f0-9]{64}$/u.test(e.previousHash)) ||
      typeof e.name !== "string" || category(e.name) !== e.category
    ) return false;
    prior = e.sequence;
    seen.add(e.id);
  }
  const { snapshotHash, ...body } = value;
  return typeof snapshotHash === "string" && domainHash(MISSION_TIME_TRAVEL_VERSION, body) === snapshotHash;
}

/**
 * Authoritative validation requires an ACS-owned ledger, not only a matching
 * caller-supplied hash. Re-read and verify the canonical audit chain; the
 * candidate must exactly match the current canonical projection. Historical
 * snapshots whose head has since advanced fail closed until independently
 * anchored as-of verification is implemented.
 */
export function verifyMissionTimeTravel(value: MissionTimeTravelSnapshot, store: Ledger): boolean {
  if (!store || !locallyConsistent(value)) return false;
  try {
    const current = readMissionTimeTravel(store, value.missionId, {
      ...(value.asOfSequence === null ? {} : { asOfSequence: value.asOfSequence }),
      maxEvents: Math.min(2000, Math.max(1, value.events.length))
    });
    return current.snapshotHash === value.snapshotHash;
  } catch {
    return false;
  }
}

/**
 * Full-chain verification before and after a bounded projection, using the
 * canonical mission trace reader. Pages are observational, not a single
 * transactional snapshot; concurrent head movement is rejected.
 */
export function readMissionTimeTravel(
  store: Ledger,
  missionId: string,
  options: { asOfSequence?: number; maxEvents?: number } = {}
): MissionTimeTravelSnapshot {
  const maxEvents = options.maxEvents ?? 1000;
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(missionId)) throw new Error("time_travel_invalid_mission");
  if (
    (options.asOfSequence !== undefined && !safeNumber(options.asOfSequence)) ||
    !Number.isSafeInteger(maxEvents) ||
    maxEvents < 1 ||
    maxEvents > 2000
  )
    throw new Error("time_travel_invalid_limit");
  const initial = store.verifyAuditChain();
  if (!initial.ok) throw new Error("time_travel_audit_integrity_failed");

  let afterSequence = 0;
  const seen = new Set<string>();
  const events: TimeTravelEvent[] = [];
  let finished = false;
  while (!finished) {
    const page = store.getMissionTrace(missionId, {
      afterSequence,
      limit: Math.min(200, maxEvents + 1 - events.length)
    });
    if (page.missionId !== missionId || page.schemaVersion !== "acs.mission-trace.v1")
      throw new Error("time_travel_trace_mismatch");
    for (const { event, correlation } of page.events) {
      if (!safeNumber(event.sequence) || event.sequence <= afterSequence || seen.has(event.id))
        throw new Error("time_travel_trace_order_invalid");
      afterSequence = event.sequence;
      seen.add(event.id);
      if (options.asOfSequence !== undefined && event.sequence > options.asOfSequence) {
        finished = true;
        break;
      }
      if (events.length >= maxEvents) throw new Error("time_travel_resource_limit");
      events.push({
        sequence: event.sequence,
        id: event.id,
        name: event.name,
        timeUnixNano: event.timeUnixNano,
        eventHash: event.eventHash,
        previousHash: event.previousHash,
        category: category(event.name),
        ...(correlationDigest(correlation.actorId, "actor")
          ? { actorIdHash: correlationDigest(correlation.actorId, "actor") }
          : {}),
        ...(correlationDigest(correlation.attemptId, "attempt")
          ? { attemptIdHash: correlationDigest(correlation.attemptId, "attempt") }
          : {}),
        ...(correlationDigest(correlation.leaseId, "lease")
          ? { leaseIdHash: correlationDigest(correlation.leaseId, "lease") }
          : {}),
        ...(safeEvidenceHash(correlation.actionHash) ? { actionHash: correlation.actionHash } : {}),
        ...(safeEvidenceHash(correlation.evidenceManifestHash)
          ? { evidenceManifestHash: correlation.evidenceManifestHash }
          : {})
      });
    }
    if (page.nextAfterSequence === undefined) finished = true;
    else if (options.asOfSequence !== undefined && afterSequence >= options.asOfSequence) finished = true;
    else if (page.nextAfterSequence !== afterSequence) throw new Error("time_travel_cursor_invalid");
    else if (events.length >= maxEvents) throw new Error("time_travel_resource_limit");
  }
  const final = store.verifyAuditChain();
  if (!final.ok || final.headHash !== initial.headHash || final.eventCount !== initial.eventCount)
    throw new Error("time_travel_audit_changed_during_read");
  const body = {
    schemaVersion: MISSION_TIME_TRAVEL_VERSION,
    missionId,
    asOfSequence: options.asOfSequence ?? null,
    auditHeadHash: final.headHash,
    auditEventCount: final.eventCount,
    integrity: "full-chain-verified" as const,
    sideEffects: "disabled" as const,
    events
  };
  const snapshot = { ...body, snapshotHash: domainHash(MISSION_TIME_TRAVEL_VERSION, body) };
  if (!locallyConsistent(snapshot)) throw new Error("time_travel_projection_integrity_failed");
  return snapshot;
}

/** Locate the first divergence; no tool re-execution is performed. */
export function compareMissionTimeTravel(
  a: MissionTimeTravelSnapshot,
  b: MissionTimeTravelSnapshot
): {
  equal: boolean;
  firstDivergence?: number;
  reason?: "different_mission" | "added" | "removed" | "changed";
} {
  if (!locallyConsistent(a) || !locallyConsistent(b))
    throw new Error("time_travel_snapshot_integrity_failed");
  if (a.missionId !== b.missionId) return { equal: false, reason: "different_mission" };
  for (let i = 0; i < Math.max(a.events.length, b.events.length); i++) {
    const left = a.events[i],
      right = b.events[i];
    if (!left) return { equal: false, firstDivergence: right!.sequence, reason: "added" };
    if (!right) return { equal: false, firstDivergence: left.sequence, reason: "removed" };
    if (domainHash(MISSION_TIME_TRAVEL_VERSION + ".event", left) !== domainHash(MISSION_TIME_TRAVEL_VERSION + ".event", right))
      return { equal: false, firstDivergence: Math.min(left.sequence, right.sequence), reason: "changed" };
  }
  return { equal: true };
}