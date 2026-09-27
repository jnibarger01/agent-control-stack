/**
 * Shadow intake adapter. Jev observes a goal and returns advisory evidence.
 * The caller-supplied authoritative classifier snapshot is returned unchanged.
 */
import { classifyJev, type JevFailureReason, type JevResult } from "./index.js";
import type { ClassifyJevOptions } from "./index.js";

export const JEV_INTAKE_QUESTIONS: Record<string, string> = {
  actionable: "Does this request require an action rather than only conversation?",
  duplicate_like: "Is this a duplicate or near-duplicate of existing work?",
  needs_code: "Does fulfilling this request require writing or modifying code?",
  needs_shell: "Does fulfilling this request require running shell commands?",
  needs_browser: "Does fulfilling this request require browser or web interaction?",
  needs_mobile: "Does fulfilling this request require a mobile device?",
  needs_desktop: "Does fulfilling this request require desktop or GUI automation?",
  destructive: "Would fulfilling this request be destructive or irreversible?",
  auth_sensitive: "Does this request involve credentials, secrets, or authentication material?",
  runtime_mutation: "Would fulfilling this request mutate runtime or system state?",
  approval_likely: "Is human approval likely required for this request?"
};

export type JevIntakeStatus = "ok" | JevFailureReason;

export type JevIntakeProbabilities = {
  actionable?: number;
  duplicateLike?: number;
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
  promptVersion: "binary";
  probabilities: JevIntakeProbabilities;
  latencyMs: number;
  questionSetVersion: "jev-routing-v1";
};

const PROBABILITY_KEYS: Record<string, keyof JevIntakeProbabilities> = {
  actionable: "actionable",
  duplicate_like: "duplicateLike",
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
  const result = await classifyJev(goal, JEV_INTAKE_QUESTIONS, { ...options, enabled: options.enabled ?? true });
  return {
    classifier,
    status: intakeStatus(result),
    shadow: true,
    model: result.model,
    promptVersion: "binary",
    probabilities: probabilitiesFrom(result),
    latencyMs: result.latencyMs,
    questionSetVersion: result.classifierVersion
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
