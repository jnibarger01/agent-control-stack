import { createHash } from "node:crypto";
import { canonicalJson } from "@agent-control-stack/shared";
import { z } from "zod";

/**
 * LoopTrace Query: canonical execution-evidence model (looptrace-evidence/1).
 *
 * Invariant: NO EVIDENCE, NO VERIFIED SUCCESS.
 *
 * Every event carries a trust class that records WHO vouches for it:
 *   - authoritative: a fact ACS itself decided/recorded in its own transaction
 *                    (policy decision, approval record, lease, state change).
 *   - observed:      machine-derived by a subsystem that is not the executing
 *                    agent (validation run, evidence manifest, release observer,
 *                    independent verification decision).
 *   - asserted:      reported by the executing agent/worker/tool itself, or by an
 *                    external runtime we cannot independently check. ACS may have
 *                    stored it, but ACS only proves it was SUBMITTED, not true.
 *
 * Only `authoritative`/`observed` evidence can ever establish a PASS about an
 * outcome. `asserted` evidence alone is, at best, INCONCLUSIVE.
 */

export const CONTRACT_VERSION = "looptrace-query/1" as const;
export const EVIDENCE_SCHEMA_VERSION = "looptrace-evidence/1" as const;

export const STAGES = [
  "request",
  "routing",
  "policy",
  "approval",
  "dispatch",
  "tool_execution",
  "result",
  "observation",
  "verification"
] as const;
export type Stage = (typeof STAGES)[number];

/** Non-chain bookkeeping events (current state, session context). Never required. */
export const LIFECYCLE_STAGE = "lifecycle" as const;
export type EventStage = Stage | typeof LIFECYCLE_STAGE;

export const TRUST_CLASSES = ["authoritative", "observed", "asserted"] as const;
export type Trust = (typeof TRUST_CLASSES)[number];

export const EVENT_TYPES = [
  "request.received",
  "lifecycle.state",
  "route.decided",
  "policy.decided",
  "approval.requested",
  "approval.granted",
  "approval.denied",
  "approval.consumed",
  "approval.invalidated",
  "dispatch.admitted",
  "dispatch.attempt_created",
  "dispatch.lease_issued",
  "capability.issued",
  "executor.started",
  "tool.started",
  "tool.finished",
  "result.reported",
  "result.promotion_completed",
  "result.promotion_blocked",
  "observation.validation_run",
  "observation.evidence_manifest",
  "observation.release",
  "observation.session",
  "verification.required",
  "verification.decided",
  "jc.session",
  "jc.tool.finished",
  "jc.coverage"
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_STAGE: Record<EventType, EventStage> = {
  "request.received": "request",
  "lifecycle.state": LIFECYCLE_STAGE,
  "route.decided": "routing",
  "policy.decided": "policy",
  "approval.requested": "approval",
  "approval.granted": "approval",
  "approval.denied": "approval",
  "approval.consumed": "approval",
  "approval.invalidated": "approval",
  "dispatch.admitted": "dispatch",
  "dispatch.attempt_created": "dispatch",
  "dispatch.lease_issued": "dispatch",
  "capability.issued": "dispatch",
  "executor.started": "tool_execution",
  "tool.started": "tool_execution",
  "tool.finished": "tool_execution",
  "result.reported": "result",
  "result.promotion_completed": "result",
  "result.promotion_blocked": "result",
  "observation.validation_run": "observation",
  "observation.evidence_manifest": "observation",
  "observation.release": "observation",
  "observation.session": LIFECYCLE_STAGE,
  "verification.required": "verification",
  "verification.decided": "verification",
  // JC events are the executor's own (asserted) record. They stay in the lifecycle stage so they can never count as an
  // observed ACS stage (tool_execution / result) and thereby satisfy a required one.
  "jc.session": LIFECYCLE_STAGE,
  "jc.tool.finished": LIFECYCLE_STAGE,
  "jc.coverage": LIFECYCLE_STAGE
};

export const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SEVERITY_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u);

export const evidenceEventSchema = z
  .object({
    schema_version: z.literal(EVIDENCE_SCHEMA_VERSION),
    event_id: identifier,
    trace_id: z.string().min(1).max(64).nullable(),
    request_id: z.string().min(1).max(160).nullable(),
    work_item_id: identifier.nullable(),
    span_id: z.string().min(1).max(64).nullable(),
    parent_span_id: z.string().min(1).max(64).nullable(),
    timestamp: z.string().max(40).nullable(),
    observed_at: z.string().max(40),
    actor: z
      .object({
        id: z.string().min(1).max(160),
        type: z.enum(["human", "agent", "system", "service", "unknown"])
      })
      .strict()
      .nullable(),
    source: z
      .object({
        system: z.string().min(1).max(64),
        component: z.string().min(1).max(160),
        instance: z.string().min(1).max(160).nullable()
      })
      .strict(),
    event_type: z.enum(EVENT_TYPES),
    stage: z.enum([...STAGES, LIFECYCLE_STAGE]),
    decision: z.string().max(64).nullable(),
    tool_name: z.string().max(160).nullable(),
    capability_id: z.string().max(160).nullable(),
    release_sha: z.string().max(64).nullable(),
    status: z.string().max(64).nullable(),
    evidence_ref: z.string().min(1).max(240),
    integrity: z
      .object({
        trust: z.enum(TRUST_CLASSES),
        basis: z.string().min(1).max(120),
        hash_verified: z.boolean().nullable(),
        chain: z.enum(["verified", "link_verified", "broken", "not_chained"]),
        content_hash: z.string().regex(/^[a-f0-9]{64}$/u)
      })
      .strict(),
    causes: z.array(z.string().max(200)).max(32),
    /** Typed, bounded facts set ONLY by adapters from structured columns (never from free text). Analysis reads these. */
    facts: z.record(z.string().max(48), z.union([z.string().max(200), z.number(), z.boolean(), z.null()])),
    refs: z.record(z.string(), z.string().max(200)),
    untrusted: z.record(z.string(), z.unknown()),
    flags: z.array(z.string().max(64)).max(16)
  })
  .strict();

export type EvidenceEvent = z.infer<typeof evidenceEventSchema>;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function contentHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** Builds a stable, source-namespaced event id so ids from different systems never collide. */
export function eventId(system: string, nativeId: string): string {
  return `${system}:${nativeId}`;
}

export function isTrusted(trust: Trust): boolean {
  return trust === "authoritative" || trust === "observed";
}

export function stageOf(type: EventType): EventStage {
  return EVENT_STAGE[type];
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

/** Normalises any parseable timestamp to canonical UTC ISO-8601 or null. Never throws. */
export function normalizeTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return null;
  if (!ISO_UTC.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** SQLite `unixepoch nanos` string (audit_events.time_unix_nano) to ISO. */
export function nanosToIso(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{10,20}$/u.test(value)) return null;
  const ms = Number(BigInt(value) / 1_000_000n);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
