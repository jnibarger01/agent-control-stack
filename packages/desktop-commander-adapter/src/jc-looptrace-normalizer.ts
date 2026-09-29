import { createHash } from "node:crypto";
import { redactValue } from "@agent-control-stack/shared";
import {
  CANONICAL_TRACE_EVENT_SCHEMA_VERSION,
  CANONICAL_TRACE_GENESIS_HASH,
  canonicalTraceEventHash,
  canonicalTraceJson,
  canonicalTracePayloadHash,
  traceSha256,
  type CanonicalTraceEvent,
  type CanonicalTraceEventKind
} from "@agent-control-stack/work-items";

export const JC_LOCAL_TRACE_EVENT_TYPES = [
  "task_received",
  "task_validated",
  "risk_classified",
  "route_selected",
  "approval_requested",
  "approval_decision",
  "rollback_checkpoint_created",
  "agent_started",
  "tool_call_started",
  "tool_call_finished",
  "file_diff_detected",
  "verification_started",
  "verification_finished",
  "promotion_blocked",
  "promotion_completed",
  "run_failed",
  "run_completed",
  "run_replay_started",
  "replay_divergence_detected",
  "trace_sealed"
] as const;

export type JcLocalTraceEventType = (typeof JC_LOCAL_TRACE_EVENT_TYPES)[number];
export type JcLocalTraceEvent = {
  run_id: string;
  seq: number;
  ts: string;
  type: JcLocalTraceEventType;
  payload: Record<string, unknown>;
  redacted: boolean;
  prev_hash: string;
  hash: string;
};
export type JcTraceNormalizationOptions = {
  traceId?: string;
  workItemId?: string;
  instance?: string;
  releaseSha?: string;
};
export type JcTraceNormalization = {
  traceId: string;
  workItemId: string | null;
  events: CanonicalTraceEvent[];
  omitted: Array<{ seq: number; type: JcLocalTraceEventType; reason: "no_canonical_lifecycle_kind" }>;
};

const JC_TYPE_SET = new Set<string>(JC_LOCAL_TRACE_EVENT_TYPES);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TRACE_ID_RE = /^[a-f0-9]{32}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const RELEASE_RE = /^(?:[a-f0-9]{40}|unreleased)$/;
const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PRIVATE_RUN_RE = /^[A-Za-z0-9._:-]{6,128}$/;
const PRIVATE_SECRET_KEY =
  /(?:password|passwd|secret|authorization|bearer|api[_-]?key|private[_-]?key|credential|token|capability)/i;
const RAW_EXECUTION_KEY = /^(?:argv|args|arguments|command|stdin|environment|env)$/i;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const MAPPING: Readonly<Record<JcLocalTraceEventType, readonly CanonicalTraceEventKind[]>> = {
  task_received: ["run.received"],
  task_validated: [],
  risk_classified: ["classification.recorded"],
  route_selected: ["route.recorded"],
  approval_requested: ["approval.requested"],
  approval_decision: ["approval.decided"],
  rollback_checkpoint_created: [],
  agent_started: ["run.started", "executor.started"],
  tool_call_started: ["tool.call.started"],
  tool_call_finished: ["tool.call.finished"],
  file_diff_detected: [],
  verification_started: ["verification.started"],
  verification_finished: ["verification.finished"],
  promotion_blocked: ["promotion.blocked"],
  promotion_completed: ["promotion.completed"],
  run_failed: ["run.failed"],
  run_completed: ["run.completed"],
  run_replay_started: ["run.started"],
  replay_divergence_detected: ["replay.diverged"],
  trace_sealed: []
};

export function canonicalKindsForJcEvent(type: JcLocalTraceEventType): readonly CanonicalTraceEventKind[] {
  return MAPPING[type];
}

export function verifyJcLocalTrace(events: readonly JcLocalTraceEvent[]): boolean {
  let prev = CANONICAL_TRACE_GENESIS_HASH;
  let runId: string | null = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event || event.seq !== index || !PRIVATE_RUN_RE.test(event.run_id) || !JC_TYPE_SET.has(event.type))
      return false;
    if (runId === null) runId = event.run_id;
    if (event.run_id !== runId || event.prev_hash !== prev || !HASH_RE.test(event.hash)) return false;
    if (!validUtc(event.ts) || typeof event.redacted !== "boolean" || !isRecord(event.payload)) return false;
    const { hash: _hash, ...body } = event;
    const expected = traceSha256(prev + "\n" + canonicalTraceJson(body));
    if (event.hash !== expected) return false;
    prev = event.hash;
  }
  return true;
}

export function normalizeJcLoopTrace(
  events: readonly JcLocalTraceEvent[],
  options: JcTraceNormalizationOptions = {}
): JcTraceNormalization {
  if (!verifyJcLocalTrace(events)) throw new TypeError("JC local trace chain is invalid");
  const runId = events[0]?.run_id ?? "jc-empty-trace";
  const traceId = options.traceId ?? traceIdFromRun(runId);
  if (!TRACE_ID_RE.test(traceId)) throw new TypeError("canonical trace id is invalid");
  const instance = options.instance ?? "jc-normalizer";
  if (!ID_RE.test(instance)) throw new TypeError("JC trace source instance is invalid");
  const releaseSha = options.releaseSha ?? "unreleased";
  if (!RELEASE_RE.test(releaseSha)) throw new TypeError("JC trace release sha is invalid");
  const explicitWorkItemId = options.workItemId;
  if (explicitWorkItemId !== undefined && !ID_RE.test(explicitWorkItemId)) {
    throw new TypeError("canonical work item id is invalid");
  }

  const output: CanonicalTraceEvent[] = [];
  const omitted: JcTraceNormalization["omitted"] = [];
  let prevHash = CANONICAL_TRACE_GENESIS_HASH;
  let correlatedWorkItem = explicitWorkItemId ?? null;
  for (const local of events) {
    const kinds = MAPPING[local.type];
    if (kinds.length === 0) {
      omitted.push({ seq: local.seq, type: local.type, reason: "no_canonical_lifecycle_kind" });
      continue;
    }
    const localWorkItem = extractWorkItemId(local.payload);
    if (correlatedWorkItem === null && localWorkItem !== null) correlatedWorkItem = localWorkItem;
    const workItemId = explicitWorkItemId ?? localWorkItem ?? correlatedWorkItem;
    for (let mappingIndex = 0; mappingIndex < kinds.length; mappingIndex += 1) {
      const kind = kinds[mappingIndex];
      const seq = output.length + 1;
      const payload = sanitizeCanonicalPayload({
        jc_event_type: local.type,
        jc_seq: local.seq,
        ...(local.type === "run_replay_started" ? { replay: true } : {}),
        ...local.payload
      });
      const material = traceId + ":" + local.seq + ":" + mappingIndex + ":" + kind + ":" + local.ts;
      const event: CanonicalTraceEvent = {
        schema_version: CANONICAL_TRACE_EVENT_SCHEMA_VERSION,
        event_id: deterministicUlid(material),
        trace_id: traceId,
        span_id: traceSha256("span:" + material).slice(0, 16),
        source: { system: "dc", component: "jace-commander", instance, release_sha: releaseSha },
        class: "evidence",
        kind,
        actor: { id: "jace-commander", type: "system" },
        ...(workItemId !== null ? { subject: { work_item_id: workItemId } } : {}),
        seq,
        prev_hash: prevHash,
        ts: local.ts,
        payload,
        payload_hash: canonicalTracePayloadHash(payload)
      };
      output.push(event);
      prevHash = canonicalTraceEventHash(event);
    }
  }
  return { traceId, workItemId: correlatedWorkItem, events: output, omitted };
}

function traceIdFromRun(runId: string): string {
  return traceSha256("jc-run:" + runId).slice(0, 32);
}
function deterministicUlid(material: string): string {
  const bytes = createHash("sha256").update(material).digest().subarray(0, 16);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let output = "";
  for (let index = 0; index < 26; index += 1) {
    output = CROCKFORD[Number(value & 31n)] + output;
    value >>= 5n;
  }
  return output;
}
function sanitizeCanonicalPayload(input: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactValue(input);
  if (!isRecord(redacted)) return {};
  return boundedObject(redacted, 0);
}
function boundedObject(input: Record<string, unknown>, depth: number): Record<string, unknown> {
  if (depth > 6) return { truncated: true };
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input).slice(0, 24)) {
    if (PRIVATE_SECRET_KEY.test(key) || RAW_EXECUTION_KEY.test(key)) continue;
    const safe = boundedValue(value, depth + 1);
    if (safe !== undefined) output[key.slice(0, 128)] = safe;
  }
  return output;
}
function boundedValue(value: unknown, depth: number): unknown {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") return value.slice(0, 512);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) return value.slice(0, 16).map((entry) => boundedValue(entry, depth + 1) ?? null);
  if (isRecord(value)) return boundedObject(value, depth);
  return undefined;
}
function extractWorkItemId(payload: Record<string, unknown>): string | null {
  const value = payload.workItemId ?? payload.work_item_id;
  return typeof value === "string" && ID_RE.test(value) ? value : null;
}
function validUtc(value: unknown): value is string {
  return (
    typeof value === "string" &&
    UTC_RE.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
