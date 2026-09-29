import { createHash } from "node:crypto";

export const CANONICAL_TRACE_EVENT_SCHEMA_VERSION = "trace-event/1" as const;
export const CANONICAL_TRACE_GENESIS_HASH = "0".repeat(64);

export const CANONICAL_TRACE_EVENT_KINDS = [
  "acs.approval.granted",
  "acs.approval.consumed",
  "run.received",
  "run.started",
  "classification.recorded",
  "route.recorded",
  "approval.requested",
  "approval.decided",
  "capability.issued",
  "executor.started",
  "tool.call.started",
  "tool.call.finished",
  "verification.started",
  "verification.finished",
  "promotion.blocked",
  "promotion.completed",
  "run.failed",
  "run.completed",
  "replay.diverged"
] as const;

export type CanonicalTraceEventKind = (typeof CANONICAL_TRACE_EVENT_KINDS)[number];
export type CanonicalTraceSourceSystem = "acs" | "dc" | "codex-swarm" | "hermes";
export type CanonicalTraceClass = "authority" | "evidence" | "telemetry";
export type CanonicalTraceActorType = "human" | "agent" | "system";

export type CanonicalTraceEvent = {
  schema_version: typeof CANONICAL_TRACE_EVENT_SCHEMA_VERSION;
  event_id: string;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  source: {
    system: CanonicalTraceSourceSystem;
    component: string;
    instance: string;
    release_sha: string;
  };
  class: CanonicalTraceClass;
  kind: CanonicalTraceEventKind;
  actor: { id: string; type: CanonicalTraceActorType };
  subject?: {
    work_item_id?: string;
    capability_id?: string;
    commit_sha?: string;
    worktree?: string;
  };
  seq: number;
  prev_hash: string;
  ts: string;
  payload: Record<string, unknown>;
  payload_hash: string;
};

/** Sorted-key JSON matching the canonical LoopTrace trace-event/1 hash form. */
export function canonicalTraceJson(value: unknown): string {
  return JSON.stringify(normalizeTraceJson(value));
}

function normalizeTraceJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("trace value is not JSON-safe");
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => normalizeTraceJson(entry));
  if (!value || typeof value !== "object") throw new TypeError("trace value is not JSON-safe");
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry === undefined) throw new TypeError("trace value contains undefined");
    output[key] = normalizeTraceJson(entry);
  }
  return output;
}

export function traceSha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalTracePayloadHash(payload: Record<string, unknown>): string {
  return traceSha256(canonicalTraceJson(payload));
}

/** Hash used as the next trace-event/1 prev_hash. */
export function canonicalTraceEventHash(event: CanonicalTraceEvent): string {
  return traceSha256(canonicalTraceJson(event));
}
