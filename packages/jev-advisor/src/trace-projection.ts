import { redactValue } from "@agent-control-stack/shared";
import type { CanonicalTraceEvent, CanonicalTraceEventKind } from "@agent-control-stack/work-items";

export const DEFAULT_TRACE_PROJECTION_LIMITS = Object.freeze({
  maxEvents: 32,
  maxDetailLength: 192,
  maxDetailKeys: 8,
  maxSerializedChars: 12_000
});

export type TraceProjectionLimits = {
  maxEvents?: number;
  maxDetailLength?: number;
  maxDetailKeys?: number;
  maxSerializedChars?: number;
};

export type JevTraceProjectionEvent = {
  seq: number;
  kind: CanonicalTraceEventKind;
  source: string;
  ts: string;
  detail: Record<string, string | number | boolean | null>;
};

export type JevTraceProjection = {
  schema_version: "jev-trace-projection/1";
  trace_id: string | null;
  work_item_id: string | null;
  original_event_count: number;
  selected_event_count: number;
  truncated: boolean;
  events: JevTraceProjectionEvent[];
};

const SENSITIVE_KEY =
  /(?:password|passwd|secret|authorization|bearer|api[_-]?key|private[_-]?key|credential|token|capability)/i;
const RAW_ARGUMENT_KEY = /^(?:argv|args|arguments|command|stdin|environment|env)$/i;
const DETAIL_KEYS = new Set([
  "tool",
  "status",
  "outcome",
  "result",
  "ok",
  "code",
  "error_code",
  "reason",
  "message",
  "exitCode",
  "exit_code",
  "timedOut",
  "timed_out",
  "spawnFailed",
  "durationMs",
  "duration_ms",
  "replay",
  "route",
  "risk",
  "taskType",
  "task_type",
  "verifier",
  "check",
  "attempt",
  "count",
  "jc_event_type",
  "jc_seq"
]);

export function projectCanonicalTraceForJev(
  events: readonly CanonicalTraceEvent[],
  limits: TraceProjectionLimits = {}
): JevTraceProjection {
  const resolved = {
    maxEvents: boundedInteger(limits.maxEvents, DEFAULT_TRACE_PROJECTION_LIMITS.maxEvents, 1, 128),
    maxDetailLength: boundedInteger(limits.maxDetailLength, DEFAULT_TRACE_PROJECTION_LIMITS.maxDetailLength, 16, 512),
    maxDetailKeys: boundedInteger(limits.maxDetailKeys, DEFAULT_TRACE_PROJECTION_LIMITS.maxDetailKeys, 1, 16),
    maxSerializedChars: boundedInteger(
      limits.maxSerializedChars,
      DEFAULT_TRACE_PROJECTION_LIMITS.maxSerializedChars,
      512,
      64_000
    )
  };
  assertOrderedSingleTrace(events);
  const traceId = events[0]?.trace_id ?? null;
  const workItemId = uniqueWorkItemId(events);

  let selected = events
    .map((event, index) => ({ event, index, priority: eventPriority(event.kind) }))
    .sort((left, right) => right.priority - left.priority || right.index - left.index)
    .slice(0, resolved.maxEvents);

  let projection = renderProjection(events.length, traceId, workItemId, selected, resolved);
  while (JSON.stringify(projection).length > resolved.maxSerializedChars && selected.length > 1) {
    let removeAt = 0;
    for (let index = 1; index < selected.length; index += 1) {
      const candidate = selected[index];
      const current = selected[removeAt];
      if (
        candidate.priority < current.priority ||
        (candidate.priority === current.priority && candidate.index < current.index)
      ) {
        removeAt = index;
      }
    }
    selected = selected.filter((_, index) => index !== removeAt);
    projection = renderProjection(events.length, traceId, workItemId, selected, resolved);
  }
  return projection;
}

function renderProjection(
  originalCount: number,
  traceId: string | null,
  workItemId: string | null,
  selected: Array<{ event: CanonicalTraceEvent; index: number; priority: number }>,
  limits: Required<TraceProjectionLimits>
): JevTraceProjection {
  const projected = [...selected]
    .sort((left, right) => left.index - right.index)
    .map(({ event }) => ({
      seq: event.seq,
      kind: event.kind,
      source: event.source.system + ":" + event.source.component.slice(0, 96),
      ts: event.ts,
      detail: compactDetail(event.payload, limits)
    }));
  return {
    schema_version: "jev-trace-projection/1",
    trace_id: traceId,
    work_item_id: workItemId,
    original_event_count: originalCount,
    selected_event_count: projected.length,
    truncated: projected.length < originalCount,
    events: projected
  };
}

function compactDetail(
  payload: Record<string, unknown>,
  limits: Required<TraceProjectionLimits>
): Record<string, string | number | boolean | null> {
  const redacted = redactValue(payload);
  if (!isRecord(redacted)) return {};
  const output: Record<string, string | number | boolean | null> = {};
  for (const key of Object.keys(redacted).sort()) {
    if (Object.keys(output).length >= limits.maxDetailKeys) break;
    if (!DETAIL_KEYS.has(key) || SENSITIVE_KEY.test(key) || RAW_ARGUMENT_KEY.test(key)) continue;
    const value = redacted[key];
    if (typeof value === "string") output[key] = value.slice(0, limits.maxDetailLength);
    else if (typeof value === "number" && Number.isFinite(value)) output[key] = value;
    else if (typeof value === "boolean" || value === null) output[key] = value;
  }
  return output;
}

function eventPriority(kind: CanonicalTraceEventKind): number {
  if (kind === "run.failed" || kind === "replay.diverged" || kind === "promotion.blocked") return 5;
  if (kind === "verification.finished" || kind === "tool.call.finished" || kind === "approval.decided") return 4;
  if (
    kind === "tool.call.started" ||
    kind === "verification.started" ||
    kind === "promotion.completed" ||
    kind === "executor.started"
  ) {
    return 3;
  }
  return 2;
}

function uniqueWorkItemId(events: readonly CanonicalTraceEvent[]): string | null {
  const ids = new Set(
    events
      .map((event) => event.subject?.work_item_id)
      .filter((value): value is string => typeof value === "string" && value.length > 0)
  );
  return ids.size === 1 ? [...ids][0] : null;
}

function assertOrderedSingleTrace(events: readonly CanonicalTraceEvent[]): void {
  let traceId: string | null = null;
  let previousSeq = 0;
  for (const event of events) {
    if (traceId === null) traceId = event.trace_id;
    if (event.trace_id !== traceId) throw new TypeError("trace projection requires one canonical trace_id");
    if (!Number.isSafeInteger(event.seq) || event.seq <= previousSeq) {
      throw new TypeError("trace projection requires strictly increasing canonical sequence");
    }
    previousSeq = event.seq;
  }
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new TypeError("invalid trace projection limit");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
