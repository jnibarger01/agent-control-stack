import type { JevResult } from "./index.js";

export const JEV_CLASSIFIER_VERSION = "jev-advisory-v2" as const;
export const JEV_TELEMETRY_SCHEMA_VERSION = "jev-advisory-event/2" as const;

export type JevCorrelation = {
  requestId?: string | null;
  workItemId?: string | null;
  traceId?: string | null;
};

export type JevDeterministicBaseline = {
  classifierId: string;
  classifierVersion: string;
  taskRecommendation: string;
  riskRecommendation: string;
  sensitivityCategories: readonly string[];
};

export type JevTelemetryObservation =
  | {
      primitive: "noul";
      probability: number;
      classification: "yes" | "no" | "unknown";
    }
  | {
      primitive: "choice";
      choice: string;
      probabilities: Readonly<Record<string, number>>;
      confidence: number;
    }
  | {
      primitive: "score";
      score: number;
      probabilities: Readonly<Record<string, number>>;
      confidence: number;
    };

export type JevTelemetryEvent = {
  schema_version: typeof JEV_TELEMETRY_SCHEMA_VERSION;
  classifier: typeof JEV_CLASSIFIER_VERSION;
  consumer: string;
  question_set_version: string | null;
  correlation: {
    request_id?: string;
    work_item_id?: string;
    trace_id?: string;
  };
  model: string | null;
  capability_profile: {
    prompt_version: string;
    supports_noul: boolean;
    supports_choice: boolean;
    supports_score: boolean;
    fingerprint: string;
    gguf_revision?: string;
  } | null;
  latency_ms: number;
  observations: Record<string, JevTelemetryObservation>;
  signals: Record<string, number>;
  deterministic_baseline: {
    classifier_id: string;
    classifier_version: string;
    task_recommendation: string;
    risk_recommendation: string;
    sensitivity_categories: string[];
  } | null;
  actual_outcome: string | null;
  degraded: boolean;
  failure_reason: string | null;
};

export type JevTelemetryInput = {
  result: JevResult;
  consumer: string;
  questionSetVersion?: string | null;
  correlation?: JevCorrelation;
  deterministicBaseline?: JevDeterministicBaseline | null;
  actualOutcome?: string | null;
};

function safeText(value: unknown, max = 128): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
  return text.length > 0 ? text : null;
}

function safeCorrelation(input: JevCorrelation | undefined): JevTelemetryEvent["correlation"] {
  const correlation: JevTelemetryEvent["correlation"] = {};
  const requestId = safeText(input?.requestId, 256);
  const workItemId = safeText(input?.workItemId, 256);
  const traceId = typeof input?.traceId === "string" && /^[a-f0-9]{32}$/.test(input.traceId) ? input.traceId : null;
  if (requestId) correlation.request_id = requestId;
  if (workItemId) correlation.work_item_id = workItemId;
  if (traceId) correlation.trace_id = traceId;
  return correlation;
}
function safeBaseline(
  baseline: JevDeterministicBaseline | null | undefined
): JevTelemetryEvent["deterministic_baseline"] {
  if (!baseline) return null;
  const classifierId = safeText(baseline.classifierId);
  const classifierVersion = safeText(baseline.classifierVersion);
  const taskRecommendation = safeText(baseline.taskRecommendation);
  const riskRecommendation = safeText(baseline.riskRecommendation);
  if (!classifierId || !classifierVersion || !taskRecommendation || !riskRecommendation) return null;
  return {
    classifier_id: classifierId,
    classifier_version: classifierVersion,
    task_recommendation: taskRecommendation,
    risk_recommendation: riskRecommendation,
    sensitivity_categories: baseline.sensitivityCategories
      .map((entry) => safeText(entry, 64))
      .filter((entry): entry is string => entry !== null)
      .slice(0, 16)
  };
}

function observationsFrom(result: JevResult): Record<string, JevTelemetryObservation> {
  if (result.degraded) return {};
  const observations: Record<string, JevTelemetryObservation> = {};
  for (const [id, answer] of Object.entries(result.answers)) {
    if (answer.type === "noul") {
      const signal = result.signals[id];
      if (!signal) continue;
      observations[id] = {
        primitive: "noul",
        probability: answer.noul,
        classification: signal.classification
      };
      continue;
    }
    if (answer.type === "choice") {
      observations[id] = {
        primitive: "choice",
        choice: answer.choice.slice(0, 128),
        probabilities: answer.probabilities,
        confidence: answer.confidence
      };
      continue;
    }
    observations[id] = {
      primitive: "score",
      score: answer.score,
      probabilities: answer.probabilities,
      confidence: answer.confidence
    };
  }
  return observations;
}

export function buildJevTelemetryEvent(input: JevTelemetryInput): JevTelemetryEvent {
  const { result } = input;
  const signals: Record<string, number> = {};
  if (!result.degraded) {
    for (const [name, signal] of Object.entries(result.signals)) signals[name] = signal.probability;
  }
  const capability = result.capability;
  const consumer = safeText(input.consumer) ?? "unknown";
  const questionSetVersion = safeText(input.questionSetVersion);
  return {
    schema_version: JEV_TELEMETRY_SCHEMA_VERSION,
    classifier: JEV_CLASSIFIER_VERSION,
    consumer,
    question_set_version: questionSetVersion,
    correlation: safeCorrelation(input.correlation),
    model: result.model,
    capability_profile:
      capability === null
        ? null
        : {
            prompt_version: capability.promptVersion,
            supports_noul: capability.supportsNoul,
            supports_choice: capability.supportsChoice,
            supports_score: capability.supportsScore,
            fingerprint: capability.fingerprint,
            ...(capability.ggufRevision !== undefined ? { gguf_revision: capability.ggufRevision } : {})
          },
    latency_ms: result.latencyMs,
    observations: observationsFrom(result),
    signals,
    deterministic_baseline: safeBaseline(input.deterministicBaseline),
    actual_outcome: safeText(input.actualOutcome),
    degraded: result.degraded,
    failure_reason: result.failureReason ?? null
  };
}

export function formatJevTelemetry(event: JevTelemetryEvent): string {
  return JSON.stringify(event);
}
