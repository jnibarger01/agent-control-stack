/**
 * @agent-control-stack/jev-advisor
 *
 * Advisory Jev classifier client (shadow mode). Jev is a local yes/no
 * probability engine. This adapter is ADVISORY ONLY: its output must never
 * influence policy, approval, routing authority, or any deterministic
 * decision. It never rejects — on any failure it resolves with
 * `degraded: true`, empty signals, and no fabricated probabilities.
 */

import { JEV_CLASSIFIER_VERSION } from "./telemetry.js";
export * from "./telemetry.js";
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
  probability: number;
  classification: "yes" | "no" | "unknown";
  highThreshold: number;
  lowThreshold: number;
};

export type JevResult = {
  classifierVersion: typeof JEV_CLASSIFIER_VERSION;
  model: string | null;
  latencyMs: number;
  signals: Record<string, ClassifiedSignal>;
  degraded: boolean;
};

/** `[low, high]` pair. Overridable per signal. */
export type JevThresholdPair = readonly [number, number];

/** Per-signal default thresholds, exactly as specified by the advisory contract. */
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

export type ClassifyJevOptions = {
  /** Override the `ACS_JEV_URL` endpoint. */
  url?: string;
  /** Override the `ACS_JEV_TIMEOUT_MS` timeout. */
  timeoutMs?: number;
  /** Override the `ACS_JEV_ENABLED` gate. */
  enabled?: boolean;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-signal threshold overrides. */
  thresholds?: JevThresholdOverrides;
};

function readEnv(name: string): string | undefined {
  return typeof process !== "undefined" && process.env ? process.env[name] : undefined;
}

/** Feature gate: active only when `ACS_JEV_ENABLED` is exactly `1`. */
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

export function classifyProbability(p: number, thresholds: JevThresholdPair): "yes" | "no" | "unknown" {
  const [low, high] = thresholds;
  if (p >= high) return "yes";
  if (p <= low) return "no";
  return "unknown";
}

function degradedResult(latencyMs: number): JevResult {
  return {
    classifierVersion: JEV_CLASSIFIER_VERSION,
    model: null,
    latencyMs,
    signals: {},
    degraded: true
  };
}

type JevAnswerShape = { noul?: unknown; type?: unknown };
type JevResponseShape = { model?: unknown; answers?: Record<string, unknown> };

/** Prefilter decision, derived only from a JevResult. Never inferred from prose/telemetry. */
export type JevDecision = "skip" | "continue" | "duplicate_check_required" | "degraded";

/**
 * Machine-readable decision contract:
 * - "degraded": any Jev failure/disabled/unavailable/timeout/malformed result
 *   (overrides any probability — never skip on degraded data);
 * - "duplicate_check_required": status ok AND duplicate_like classified "yes"
 *   (the authoritative GitHub/open-PR duplicate check must run; Jev alone
 *   NEVER discards);
 * - "skip": status ok AND the probability assigned to the returned no
 *   classification for `actionable` is <= 0.05 with classification "no";
 * - "continue": everything else (including missing required signals).
 * Precedence: degraded > duplicate_check_required > skip > continue.
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

/**
 * Classify all questions against the Jev engine in ONE batched POST.
 * DEGRADE-never-fail: resolves (never rejects) with `degraded: true` on any
 * failure. Output is advisory data only.
 */
export async function classifyJev(
  state: string | object,
  questions: Record<string, string>,
  options: ClassifyJevOptions = {}
): Promise<JevResult> {
  const startedAt = Date.now();
  const elapsed = () => Math.max(0, Date.now() - startedAt);

  const enabled = options.enabled ?? isJevEnabled();
  if (!enabled) {
    // Inert by default: no network call, no fabricated data.
    return degradedResult(elapsed());
  }

  const signalNames = Object.keys(questions);
  if (signalNames.length === 0) {
    return { classifierVersion: JEV_CLASSIFIER_VERSION, model: null, latencyMs: 0, signals: {}, degraded: false };
  }

  const thresholds = resolveThresholds(options.thresholds);
  const url = options.url ?? readEnv("ACS_JEV_URL") ?? DEFAULT_JEV_URL;
  const timeoutMs = options.timeoutMs ?? readNumberEnv("ACS_JEV_TIMEOUT_MS") ?? DEFAULT_JEV_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;

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
          state,
          questions: Object.fromEntries(
            signalNames.map((name) => [name, { type: "noul", instructions: questions[name] }])
          )
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return degradedResult(elapsed());
  }
  if (!response.ok) return degradedResult(elapsed());

  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    return degradedResult(elapsed());
  }

  const body = parsed as JevResponseShape;
  const answers = body?.answers;
  if (answers === null || typeof answers !== "object") return degradedResult(elapsed());

  const signals: Record<string, ClassifiedSignal> = {};
  for (const name of signalNames) {
    const answer = (answers as Record<string, unknown>)[name] as JevAnswerShape | undefined;
    const probability = answer?.noul;
    // Unknown question names, malformed answers, and out-of-range probabilities
    // count as missing answers: degrade with NO fabricated values.
    if (
      answer === null ||
      typeof answer !== "object" ||
      answer.type !== "noul" ||
      typeof probability !== "number" ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1
    ) {
      return degradedResult(elapsed());
    }
    const pair = thresholds[name as JevSignal] ?? [
      DEFAULT_JEV_THRESHOLDS.actionable[0],
      DEFAULT_JEV_THRESHOLDS.actionable[1]
    ];
    signals[name] = {
      probability,
      classification: classifyProbability(probability, pair),
      lowThreshold: pair[0],
      highThreshold: pair[1]
    };
  }

  return {
    classifierVersion: JEV_CLASSIFIER_VERSION,
    model: typeof body.model === "string" ? sanitizeModelName(body.model) : null,
    latencyMs: elapsed(),
    signals,
    degraded: false
  };
}

/**
 * The `model` string originates from the remote engine and is echoed into
 * consumer-visible output (CLI stdout, logs). Restrict it to a safe charset
 * and length so it can never carry newlines, control characters, or
 * prompt-injection payloads; anything else is treated as absent (null).
 */
function sanitizeModelName(model: string): string | null {
  return /^[\w.:/+-]{1,64}$/.test(model) ? model : null;
}

function readNumberEnv(name: string): number | undefined {
  const raw = readEnv(name);
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
