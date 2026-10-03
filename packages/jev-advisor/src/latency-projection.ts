import type { CanonicalTraceEvent } from "@agent-control-stack/work-items";
import { redactValue } from "@agent-control-stack/shared";

export interface CapabilityIssuanceLatency {
  capabilityId: string | null;
  issuanceLatencyMs: number | null;
  fromApprovalToGrantMs: number | null;
}

export interface ExecutionLatency {
  executionLatencyMs: number | null;
  toolCallCount: number;
  verificationCount: number;
  longestToolCallMs: number | null;
}

export interface JevLatencyMetrics {
  capabilityIssuance: CapabilityIssuanceLatency;
  execution: ExecutionLatency;
  totalTraceMs: number | null;
  /** Deterministic latency buckets — computed from trace timestamps, not LLM interpretation. */
  capabilityIssuanceBucket: "fast" | "moderate" | "slow" | "unknown";
  executionBucket: "fast" | "moderate" | "slow" | "unknown";
  traceBucket: "fast" | "moderate" | "slow" | "unknown";
}

function findEventByKind(
  events: readonly CanonicalTraceEvent[],
  kind: string
): CanonicalTraceEvent | undefined {
  return events.find((event) => event.kind === kind);
}

function extractTimestamp(event: CanonicalTraceEvent): number {
  const ts = event.ts;
  if (!ts) return 0;
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractDurationMs(payload: Record<string, unknown>): number | null {
  const duration = payload.duration_ms ?? payload.durationMs ?? payload.duration;
  if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0) return duration;
  return null;
}

function extractCapabilityId(payload: Record<string, unknown>): string | null {
  const id = payload.capability_id ?? payload.capabilityId ?? payload.id;
  if (typeof id === "string" && id.length > 0) return id;
  return null;
}

export function projectLatencyMetrics(events: readonly CanonicalTraceEvent[]): JevLatencyMetrics {
  const capabilityIssuance = projectCapabilityIssuanceLatency(events);
  const execution = projectExecutionLatency(events);
  const totalTraceMs = projectTotalTraceMs(events);

  return {
    capabilityIssuance,
    execution,
    totalTraceMs,
    capabilityIssuanceBucket: classifyLatency(capabilityIssuance.issuanceLatencyMs, 100, 500),
    executionBucket: classifyLatency(execution.executionLatencyMs, 1000, 5000),
    traceBucket: classifyLatency(totalTraceMs, 500, 5000)
  };
}

function projectCapabilityIssuanceLatency(
  events: readonly CanonicalTraceEvent[]
): CapabilityIssuanceLatency {
  const approvalRequested = findEventByKind(events, "approval.requested");
  const approvalDecided = findEventByKind(events, "approval.decided");
  const approvalGranted = findEventByKind(events, "acs.approval.granted");

  const capabilityId =
    extractCapabilityId(approvalRequested?.payload ?? {}) ??
    extractCapabilityId(approvalGranted?.payload ?? {});

  let fromApprovalToGrantMs: number | null = null;
  if (approvalRequested && approvalGranted) {
    const requestTime = extractTimestamp(approvalRequested);
    const grantTime = extractTimestamp(approvalGranted);
    if (requestTime > 0 && grantTime > 0 && grantTime >= requestTime) {
      fromApprovalToGrantMs = grantTime - requestTime;
    }
  }

  let issuanceLatencyMs: number | null = null;
  if (approvalDecided) {
    const duration = extractDurationMs(approvalDecided.payload ?? {});
    if (duration !== null) issuanceLatencyMs = duration;
  }
  if (issuanceLatencyMs === null && approvalGranted) {
    const duration = extractDurationMs(approvalGranted.payload ?? {});
    if (duration !== null) issuanceLatencyMs = duration;
  }

  return {
    capabilityId,
    issuanceLatencyMs,
    fromApprovalToGrantMs
  };
}

function projectExecutionLatency(events: readonly CanonicalTraceEvent[]): ExecutionLatency {
  const runStarted = findEventByKind(events, "run.started");
  const runCompleted = findEventByKind(events, "run.completed");
  const runFailed = findEventByKind(events, "run.failed");

  let executionLatencyMs: number | null = null;
  if (runStarted && (runCompleted || runFailed)) {
    const startTime = extractTimestamp(runStarted);
    const endTime = extractTimestamp(runCompleted ?? runFailed!);
    if (startTime > 0 && endTime > 0 && endTime >= startTime) {
      executionLatencyMs = endTime - startTime;
    }
  }

  const toolCalls = events.filter((event) => event.kind === "tool.call.started");
  let longestToolCallMs: number | null = null;
  for (const toolCall of toolCalls) {
    const duration = extractDurationMs(toolCall.payload ?? {});
    if (duration !== null && (longestToolCallMs === null || duration > longestToolCallMs)) {
      longestToolCallMs = duration;
    }
  }

  const verifications = events.filter(
    (event) => event.kind === "verification.started" || event.kind === "verification.finished"
  );

  return {
    executionLatencyMs,
    toolCallCount: toolCalls.length,
    verificationCount: verifications.length,
    longestToolCallMs
  };
}

function projectTotalTraceMs(events: readonly CanonicalTraceEvent[]): number | null {
  if (events.length === 0) return null;
  const firstTs = extractTimestamp(events[0]);
  const lastTs = extractTimestamp(events[events.length - 1]);
  if (firstTs > 0 && lastTs > 0 && lastTs >= firstTs) return lastTs - firstTs;
  return null;
}

export function classifyLatency(ms: number | null, fastThreshold: number, slowThreshold: number): "fast" | "moderate" | "slow" | "unknown" {
  if (ms === null) return "unknown";
  if (ms <= fastThreshold) return "fast";
  if (ms >= slowThreshold) return "slow";
  return "moderate";
}

export function redactLatencyPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return redactValue(payload) as Record<string, unknown>;
}
