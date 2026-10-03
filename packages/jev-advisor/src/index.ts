/**
 * @agent-control-stack/jev-advisor
 *
 * Typed, capability-aware Jev/System One client. Jev is ADVISORY ONLY.
 * Any disabled, unavailable, incompatible, timed-out, or malformed result
 * degrades to empty evidence and must not affect ACS authority.
 */

import {
  LOCAL_BINARY_CAPABILITY,
  capabilityFromMetadata,
  checkCapability,
  checkObservedCapability,
  observeCapability,
  supportsPrimitive,
  type JevCapability,
  type JevPrimitive
} from "./contracts/capability.js";
import { parseJevAnswer, type JevAnswer, type JevQuestion, type JevQuestions } from "./contracts/questions.js";
import { prepareJevState } from "./redaction.js";
import { JEV_CLASSIFIER_VERSION } from "./telemetry.js";

export * from "./telemetry.js";
export * from "./contracts/questions.js";
export * from "./question-registry.js";
export * from "./redaction.js";
export {
  LOCAL_BINARY_CAPABILITY,
  capabilityFromMetadata,
  checkCapability,
  checkObservedCapability,
  observeCapability,
  supportsPrimitive
} from "./contracts/capability.js";
export type { JevCapability, JevCapabilityObservation, JevPrimitive } from "./contracts/capability.js";

export const DEFAULT_JEV_URL = "http://127.0.0.1:8017/v1/systemone";
export const DEFAULT_JEV_TIMEOUT_MS = 750;
export const JEV_ENABLED_ENV = "ACS_JEV_ENABLED";

export type JevSignal =
  | "actionable"
  | "urgent"
  | "needs_code"
  | "needs_shell"
  | "needs_browser"
  | "needs_mobile"
  | "needs_desktop"
  | "duplicate_like"
  | "destructive"
  | "auth_sensitive"
  | "runtime_mutation"
  | "approval_likely";
export type ClassifiedSignal = {
  /** TypeSafe Noul probability P(yes). */
  probability: number;
  classification: "yes" | "no" | "unknown";
  highThreshold: number;
  lowThreshold: number;
};

export type JevFailureReason = "NO_ADVICE" | "TIMEOUT" | "UNAVAILABLE" | "INCOMPATIBLE_MODEL";

export type JevResult = {
  classifierVersion: typeof JEV_CLASSIFIER_VERSION;
  model: string | null;
  latencyMs: number;
  answers: Record<string, JevAnswer>;
  signals: Record<string, ClassifiedSignal>;
  capability: JevCapability | null;
  degraded: boolean;
  /** Present only when the call did not produce usable advisory answers. */
  failureReason?: JevFailureReason;
};

/** [low, high] thresholds over Noul P(yes). */
export type JevThresholdPair = readonly [number, number];
export const DEFAULT_JEV_THRESHOLDS: Readonly<Record<JevSignal, JevThresholdPair>> = {
  actionable: [0.15, 0.85],
  urgent: [0.1, 0.9],
  needs_code: [0.15, 0.85],
  needs_shell: [0.1, 0.9],
  needs_browser: [0.15, 0.85],
  needs_mobile: [0.1, 0.9],
  needs_desktop: [0.1, 0.9],
  duplicate_like: [0.05, 0.95],
  destructive: [0.03, 0.97],
  auth_sensitive: [0.03, 0.97],
  runtime_mutation: [0.03, 0.97],
  approval_likely: [0.03, 0.97]
};

export type JevThresholdOverrides = Partial<Record<JevSignal, JevThresholdPair>>;

export type JevCapabilityProvider = () => JevCapability | null | undefined | Promise<JevCapability | null | undefined>;

export type ClassifyJevOptions = {
  url?: string;
  timeoutMs?: number;
  enabled?: boolean;
  fetchImpl?: typeof fetch;
  thresholds?: JevThresholdOverrides;
  /**
   * Complete capability profile supplied by runtime configuration, transport
   * initialization, trusted metadata discovery, or tests.
   */
  capabilityProfile?: JevCapability;
  /**
   * Trusted runtime capability discovery. If configured but unable to return
   * a complete profile, the call degrades rather than assuming support.
   */
  capabilityProvider?: JevCapabilityProvider;
};

function readEnv(name: string): string | undefined {
  return typeof process !== "undefined" && process.env ? process.env[name] : undefined;
}

export function isJevEnabled(envValue: string | undefined = readEnv(JEV_ENABLED_ENV)): boolean {
  return envValue === "1";
}

function validateThresholdPair(signal: string, pair: JevThresholdPair): void {
  const [low, high] = pair;
  if (!Number.isFinite(low) || !Number.isFinite(high) || low < 0 || high > 1 || !(low < high)) {
    throw new Error(
      `invalid jev threshold override for ${signal}: expected 0 <= low < high <= 1, got [${String(low)}, ${String(high)}]`
    );
  }
}
function resolveThresholds(overrides: JevThresholdOverrides | undefined): Record<JevSignal, JevThresholdPair> {
  const resolved = { ...DEFAULT_JEV_THRESHOLDS };
  if (overrides) {
    for (const signal of Object.keys(overrides) as JevSignal[]) {
      const pair = overrides[signal];
      if (!pair) continue;
      validateThresholdPair(signal, pair);
      resolved[signal] = [pair[0], pair[1]];
    }
  }
  return resolved;
}

/** Threshold a TypeSafe Noul probability, which is always P(yes). */
export function classifyProbability(p: number, thresholds: JevThresholdPair): "yes" | "no" | "unknown" {
  const [low, high] = thresholds;
  if (p >= high) return "yes";
  if (p <= low) return "no";
  return "unknown";
}

function degradedResult(
  latencyMs: number,
  failureReason: JevFailureReason | undefined,
  capability: JevCapability | null = null
): JevResult {
  return {
    classifierVersion: JEV_CLASSIFIER_VERSION,
    model: null,
    latencyMs,
    answers: {},
    signals: {},
    capability,
    degraded: true,
    ...(failureReason !== undefined ? { failureReason } : {})
  };
}
type JevResponseShape = { model?: unknown; answers?: unknown };

export type JevDecision = "skip" | "continue" | "duplicate_check_required" | "degraded";

/**
 * Offline advisory recommendation only:
 * - degraded: no usable Jev evidence;
 * - duplicate_check_required: duplicate_like is a strong yes;
 * - skip: actionable P(yes) <= 0.05 and classified no;
 * - continue: otherwise.
 *
 * A low Noul is a strong NO, not a probability assigned to a "no class".
 * This helper is never wired into authoritative ACS intake.
 */
export function deriveJevDecision(result: JevResult): JevDecision {
  if (result.degraded) return "degraded";
  const duplicateLike = result.signals.duplicate_like;
  if (duplicateLike?.classification === "yes") return "duplicate_check_required";
  const actionable = result.signals.actionable;
  if (actionable !== undefined && actionable.classification === "no" && actionable.probability <= 0.05) {
    return "skip";
  }
  return "continue";
}

function primitiveOf(question: unknown): JevPrimitive | null {
  if (!question || typeof question !== "object" || Array.isArray(question)) return null;
  const type = (question as { type?: unknown }).type;
  return type === "noul" || type === "choice" || type === "score" ? type : null;
}
function sanitizeCapability(profile: JevCapability | null | undefined): JevCapability | null {
  if (!profile) return null;
  if (
    typeof profile.promptVersion !== "string" ||
    !/^[A-Za-z0-9._:-]{1,64}$/.test(profile.promptVersion) ||
    typeof profile.supportsNoul !== "boolean" ||
    typeof profile.supportsChoice !== "boolean" ||
    typeof profile.supportsScore !== "boolean" ||
    typeof profile.fingerprint !== "string" ||
    !/^[A-Za-z0-9._:-]{0,128}$/.test(profile.fingerprint)
  ) {
    return null;
  }
  if (
    profile.ggufRevision !== undefined &&
    (typeof profile.ggufRevision !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(profile.ggufRevision))
  ) {
    return null;
  }
  return {
    promptVersion: profile.promptVersion,
    supportsNoul: profile.supportsNoul,
    supportsChoice: profile.supportsChoice,
    supportsScore: profile.supportsScore,
    fingerprint: profile.fingerprint,
    ...(profile.ggufRevision !== undefined ? { ggufRevision: profile.ggufRevision } : {})
  };
}

async function resolveCapability(options: ClassifyJevOptions): Promise<JevCapability | null> {
  if (options.capabilityProfile !== undefined) return sanitizeCapability(options.capabilityProfile);
  if (options.capabilityProvider !== undefined) {
    try {
      return sanitizeCapability(await options.capabilityProvider());
    } catch {
      return null;
    }
  }
  return LOCAL_BINARY_CAPABILITY;
}
function serializeQuestion(question: JevQuestion): Record<string, unknown> {
  if (question.type === "noul") {
    return question.criteria === undefined
      ? { type: "noul", instructions: question.instructions }
      : { type: "noul", instructions: question.instructions, criteria: question.criteria };
  }
  if (question.type === "choice") {
    return { type: "choice", instructions: question.instructions, criteria: question.criteria };
  }
  return { type: "score", instructions: question.instructions, criteria: question.criteria };
}

function questionsSupported(questions: JevQuestions, capability: JevCapability): boolean {
  for (const question of Object.values(questions)) {
    const primitive = primitiveOf(question);
    if (primitive === null || !supportsPrimitive(capability, primitive)) return false;
  }
  return true;
}

/**
 * Evaluate all independent typed questions in one System One POST.
 * Never heuristically falls back. Runtime failures resolve to degraded evidence.
 */
export async function classifyJev(
  state: string | object,
  questions: JevQuestions,
  options: ClassifyJevOptions = {}
): Promise<JevResult> {
  const startedAt = Date.now();
  const elapsed = () => Math.max(0, Date.now() - startedAt);

  const enabled = options.enabled ?? isJevEnabled();
  if (!enabled) return degradedResult(elapsed(), undefined);

  const questionEntries = Object.entries(questions);
  if (questionEntries.length === 0) {
    const capability = await resolveCapability(options);
    return {
      classifierVersion: JEV_CLASSIFIER_VERSION,
      model: null,
      latencyMs: elapsed(),
      answers: {},
      signals: {},
      capability,
      degraded: false
    };
  }

  const capability = await resolveCapability(options);
  if (capability === null || !questionsSupported(questions, capability)) {
    return degradedResult(elapsed(), "INCOMPATIBLE_MODEL", capability);
  }

  const thresholds = resolveThresholds(options.thresholds);
  const url = options.url ?? readEnv("ACS_JEV_URL") ?? DEFAULT_JEV_URL;
  const timeoutMs = options.timeoutMs ?? readNumberEnv("ACS_JEV_TIMEOUT_MS") ?? DEFAULT_JEV_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;
  const safeState = prepareJevState(state);

  let response: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "jev-latest",
          state: safeState,
          questions: Object.fromEntries(questionEntries.map(([name, question]) => [name, serializeQuestion(question)]))
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return degradedResult(elapsed(), timedOut ? "TIMEOUT" : "UNAVAILABLE", capability);
  }
  if (!response.ok) return degradedResult(elapsed(), "UNAVAILABLE", capability);

  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    return degradedResult(elapsed(), "NO_ADVICE", capability);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return degradedResult(elapsed(), "NO_ADVICE", capability);
  }

  const body = parsed as JevResponseShape;
  const observed = checkObservedCapability(observeCapability(body), capability);
  if (!observed.ok) return degradedResult(elapsed(), "INCOMPATIBLE_MODEL", capability);
  if (!body.answers || typeof body.answers !== "object" || Array.isArray(body.answers)) {
    return degradedResult(elapsed(), "NO_ADVICE", capability);
  }
  const rawAnswers = body.answers as Record<string, unknown>;
  const answers: Record<string, JevAnswer> = {};
  const signals: Record<string, ClassifiedSignal> = {};

  for (const [name, question] of questionEntries) {
    const primitive = primitiveOf(question);
    if (primitive === null) return degradedResult(elapsed(), "INCOMPATIBLE_MODEL", capability);
    const answer = parseJevAnswer(question, rawAnswers[name]);
    if (answer === null) return degradedResult(elapsed(), "NO_ADVICE", capability);
    answers[name] = answer;
    if (answer.type === "noul") {
      const pair = thresholds[name as JevSignal] ?? DEFAULT_JEV_THRESHOLDS.actionable;
      signals[name] = {
        probability: answer.noul,
        classification: classifyProbability(answer.noul, pair),
        lowThreshold: pair[0],
        highThreshold: pair[1]
      };
    }
  }

  return {
    classifierVersion: JEV_CLASSIFIER_VERSION,
    model: typeof body.model === "string" ? sanitizeModelName(body.model) : null,
    latencyMs: elapsed(),
    answers,
    signals,
    capability,
    degraded: false
  };
}

function sanitizeModelName(model: string): string | null {
  return /^[A-Za-z0-9._-]{1,64}$/.test(model) ? model : null;
}
function readNumberEnv(name: string): number | undefined {
  const raw = readEnv(name);
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
