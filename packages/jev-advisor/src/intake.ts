/**
 * Shadow intake adapter. Jev observes a redacted/bounded goal and returns
 * advisory evidence. The caller-supplied classifier snapshot is returned
 * unchanged and is never mutated by this package.
 */
import { classifyJev, type JevFailureReason, type JevResult } from "./index.js";
import type { ClassifyJevOptions } from "./index.js";
import { JEV_INTAKE_QUESTIONS, JEV_INTAKE_QUESTION_SET_VERSION } from "./question-registry.js";

export { JEV_INTAKE_QUESTIONS, JEV_INTAKE_QUESTION_SET_VERSION };

export type JevIntakeStatus = "ok" | JevFailureReason;

export type JevIntakeProbabilities = {
  actionable?: number;
  needsCode?: number;
  needsShell?: number;
  needsBrowser?: number;
  needsMobile?: number;
  needsDesktop?: number;
  destructive?: number;
  authSensitive?: number;
  runtimeMutation?: number;
  approvalLikely?: number;
};
export type JevIntakeShadow<T> = {
  classifier: T;
  status: JevIntakeStatus;
  shadow: true;
  model: string | null;
  promptVersion: string | null;
  probabilities: JevIntakeProbabilities;
  latencyMs: number;
  questionSetVersion: typeof JEV_INTAKE_QUESTION_SET_VERSION;
};

const PROBABILITY_KEYS: Record<string, keyof JevIntakeProbabilities> = {
  actionable: "actionable",
  needs_code: "needsCode",
  needs_shell: "needsShell",
  needs_browser: "needsBrowser",
  needs_mobile: "needsMobile",
  needs_desktop: "needsDesktop",
  destructive: "destructive",
  auth_sensitive: "authSensitive",
  runtime_mutation: "runtimeMutation",
  approval_likely: "approvalLikely"
};

export async function runJevIntake<T>(
  goal: string,
  classifier: T,
  options: ClassifyJevOptions = {}
): Promise<JevIntakeShadow<T>> {
  const result = await classifyJev(goal, JEV_INTAKE_QUESTIONS, {
    ...options,
    enabled: options.enabled ?? true
  });
  return {
    classifier,
    status: intakeStatus(result),
    shadow: true,
    model: result.model,
    promptVersion: result.capability?.promptVersion ?? null,
    probabilities: probabilitiesFrom(result),
    latencyMs: result.latencyMs,
    questionSetVersion: JEV_INTAKE_QUESTION_SET_VERSION
  };
}

function intakeStatus(result: JevResult): JevIntakeStatus {
  if (!result.degraded && result.failureReason === undefined) return "ok";
  return result.failureReason ?? "NO_ADVICE";
}

function probabilitiesFrom(result: JevResult): JevIntakeProbabilities {
  if (result.degraded) return {};
  const probabilities: JevIntakeProbabilities = {};
  for (const [name, signal] of Object.entries(result.signals)) {
    const key = PROBABILITY_KEYS[name];
    if (key) probabilities[key] = signal.probability;
  }
  return probabilities;
}
