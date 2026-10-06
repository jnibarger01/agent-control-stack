/**
 * Mission-intake Jev observer.
 *
 * ADVISORY ONLY: one typed System One fan-out call emits correlated telemetry.
 * The result is never returned to or consumed by any authoritative ACS path.
 * JEV routing signals are not an executor-selection authority. Nimble, via
 * decideAuthoritativeRoute, is the only model consulted for that decision.
 * ADR 0025: the route observer below runs after the decision is persisted (shadow stage) and its output is only
 * ever written to routing_shadow_observations.
 */
import {
  JEV_INTAKE_QUESTIONS,
  noul,
  type JevQuestions,
  JEV_INTAKE_QUESTION_SET_VERSION,
  JEV_RISK_SIGNALS,
  JEV_ROUTING_SIGNALS,
  buildJevTelemetryEvent,
  classifyJev,
  formatJevTelemetry,
  isJevEnabled,
  type ClassifyJevOptions,
  type JevCorrelation,
  type JevDeterministicBaseline
} from "@agent-control-stack/jev-advisor";
import type { RouteShadowObserver, RouteShadowOptions, RouteShadowRecorder } from "@agent-control-stack/actor-router";
import { missionIntakeSchema, type ClassifierEvidence } from "@agent-control-stack/work-items";
import { classifyMissionIntake } from "./mission-classifier.js";

export { JEV_RISK_SIGNALS, JEV_ROUTING_SIGNALS };

export type JevShadowOptions = ClassifyJevOptions & {
  sink?: (line: string) => void;
  correlation?: JevCorrelation;
  deterministicBaseline?: JevDeterministicBaseline | null;
};

function defaultSink(line: string): void {
  process.stderr.write(`${line}\n`);
}
function baselineSnapshot(evidence: ClassifierEvidence): JevDeterministicBaseline {
  return {
    classifierId: evidence.classifier.id,
    classifierVersion: evidence.classifier.version,
    taskRecommendation: evidence.taskType.recommendation,
    riskRecommendation: evidence.risk.recommendation,
    sensitivityCategories: evidence.sensitivity.categories
  };
}

function deterministicBaseline(intake: unknown): JevDeterministicBaseline | null {
  try {
    return baselineSnapshot(
      classifyMissionIntake(intake, {
        evidenceId: "jev-shadow-baseline",
        generatedAt: "2026-01-01T00:00:00.000Z"
      })
    );
  } catch {
    return null;
  }
}

/** One POST, exactly the canonical ten independent intake questions. */
export async function runJevShadowAdvisory(state: string, options: JevShadowOptions = {}): Promise<void> {
  const result = await classifyJev(state, JEV_INTAKE_QUESTIONS, options);
  const event = buildJevTelemetryEvent({
    result,
    consumer: "mission-intake",
    questionSetVersion: JEV_INTAKE_QUESTION_SET_VERSION,
    correlation: options.correlation,
    deterministicBaseline: options.deterministicBaseline
  });
  try {
    (options.sink ?? defaultSink)(formatJevTelemetry(event));
  } catch {
    // A telemetry sink is never part of the authoritative request path.
  }
}

/**
 * Gateway boundary helper. Runs only after create_work_item succeeded.
 * Feature-gated, fire-and-forget, and never throws into the request path.
 */
export async function maybeRunJevShadowAdvisory(intakeInput: unknown, options: JevShadowOptions = {}): Promise<void> {
  try {
    if (options.enabled === false) return;
    const explicitlyEnabled = options.enabled === true;
    if (!explicitlyEnabled && !isJevEnabled()) return;

    const parsed = missionIntakeSchema.safeParse(intakeInput);
    if (!parsed.success) return;

    const correlation: JevCorrelation = {
      ...options.correlation,
      requestId: options.correlation?.requestId ?? parsed.data.requestId
    };
    const baseline = options.deterministicBaseline ?? deterministicBaseline(parsed.data);
    await runJevShadowAdvisory(parsed.data.goal, {
      ...options,
      correlation,
      deterministicBaseline: baseline
    });
  } catch {
    // Jev and its telemetry are advisory only.
  }
}

export const JEV_ROUTE_SHADOW_QUESTION_SET_VERSION = "jev-route-shadow@1" as const;

/**
 * Observer for the authoritative route's shadow stage (ADR 0025). One independent Noul question per candidate
 * ("is this executor a good fit?"), because the deployed runtime is Noul-only. The recommendation is the
 * candidate with the strictly highest P(yes); a tie or a missing answer is recorded as no recommendation.
 * Candidate ids never become question keys, and nothing is repaired or inferred when Jev degrades.
 */
export function createJevRouteShadowObserver(options: ClassifyJevOptions = {}): RouteShadowObserver {
  return async (input) => {
    const keys = input.candidates.map((_, index) => `fit_${index}`);
    const questions: Record<string, ReturnType<typeof noul>> = {};
    input.candidates.forEach((candidate, index) => {
      questions[keys[index]!] = noul(
        `For the described operation, is executor ${index + 1} (role ${candidate.role ?? "unspecified"}, kind ${
          candidate.kind ?? "unspecified"
        }, capabilities ${candidate.capabilities.join(", ") || "none"}) a good fit?`
      );
    });
    const state = {
      operationType: input.operationType,
      requiredCapabilities: input.requiredCapabilities,
      lane: input.lane ?? null
    };
    const result = await classifyJev(state, questions as JevQuestions, options);
    const base = {
      questionSetVersion: JEV_ROUTE_SHADOW_QUESTION_SET_VERSION,
      latencyMs: Math.round(result.latencyMs),
      ...(result.model ? { model: result.model } : {})
    };
    if (result.degraded) {
      return { ...base, status: "degraded", failureReason: result.failureReason ?? "degraded" };
    }
    const probabilities: Record<string, number> = {};
    for (const [index, candidate] of input.candidates.entries()) {
      const answer = result.answers[keys[index]!];
      if (answer?.type === "noul" && Number.isFinite(answer.noul)) probabilities[candidate.id] = answer.noul;
    }
    const scored = Object.entries(probabilities).sort((left, right) => right[1] - left[1]);
    if (scored.length < input.candidates.length) {
      return { ...base, status: "no_recommendation", failureReason: "incomplete_answers", probabilities };
    }
    const [top, runnerUp] = scored;
    if (!top || (runnerUp && runnerUp[1] === top[1])) {
      return { ...base, status: "no_recommendation", failureReason: "tie", probabilities };
    }
    return {
      ...base,
      status: "recommended",
      recommendedExecutorId: top[0],
      confidence: top[1],
      probabilities
    };
  };
}

/**
 * Composition-root helper: the shadow options for a store, or undefined while Jev is disabled. The two
 * authoritative-claim composition roots are the only permitted callers (ADR 0025).
 */
export function createJevRouteShadow(
  recorder: RouteShadowRecorder,
  options: ClassifyJevOptions & { timeoutMs?: number; track?: (settled: Promise<void>) => void } = {}
): RouteShadowOptions | undefined {
  if (options.enabled === false) return undefined;
  if (options.enabled !== true && !isJevEnabled()) return undefined;
  const { track, ...classifyOptions } = options;
  return {
    observer: createJevRouteShadowObserver(classifyOptions),
    recorder,
    ...(track ? { track } : {})
  };
}
