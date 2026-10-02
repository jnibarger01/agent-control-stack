/**
 * Mission-intake Jev observer.
 *
 * ADVISORY ONLY: one typed System One fan-out call emits correlated telemetry.
 * The result is never returned to or consumed by any authoritative ACS path.
 * JEV routing signals are not an executor-selection authority. Nimble, via
 * decideAuthoritativeRoute, is the only model consulted for that decision.
 */
import {
  JEV_INTAKE_QUESTIONS,
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
