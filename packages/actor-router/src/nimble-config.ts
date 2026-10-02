export const DEFAULT_NIMBLE_ROUTING_URL = "http://127.0.0.1:11434/v1/systemone";
export const DEFAULT_NIMBLE_ROUTING_MODEL = "nimble:latest";
export const DEFAULT_NIMBLE_CONFIDENCE_THRESHOLD = 0.8;
export const DEFAULT_NIMBLE_TIMEOUT_MS = 5_000;
export const NIMBLE_ROUTER_VERSION = "acs-nimble-authority@1";
export const NIMBLE_PROMPT_VERSION = "nimble-executor-choice@1";

export type NimbleLowConfidencePolicy = "fallback" | "reject";
export type NimbleFallbackMode = "deterministic_score";

export interface NimbleRoutingConfig {
  enabled: boolean;
  url: string;
  model: string;
  timeoutMs: number;
  confidenceThreshold: number;
  lowConfidencePolicy: NimbleLowConfidencePolicy;
  fallbackMode: NimbleFallbackMode;
  operatorDeny: readonly string[];
}

export class NimbleRoutingConfigError extends Error {
  readonly code = "nimble_routing_config_invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "NimbleRoutingConfigError";
  }
}

/** Read routing configuration. Disabled is the default. Enabled with a bad value fails immediately. */
export function resolveNimbleRoutingConfig(env: NodeJS.ProcessEnv = process.env): NimbleRoutingConfig {
  const enabledRaw = env.ACS_NIMBLE_ROUTING_ENABLED;
  if (enabledRaw === undefined || enabledRaw === "" || enabledRaw === "0") {
    return disabledConfig();
  }
  if (enabledRaw !== "1") {
    throw new NimbleRoutingConfigError("ACS_NIMBLE_ROUTING_ENABLED must be 1 or 0");
  }
  const url = env.ACS_NIMBLE_URL?.trim() || DEFAULT_NIMBLE_ROUTING_URL;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NimbleRoutingConfigError("ACS_NIMBLE_URL must be an absolute HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new NimbleRoutingConfigError("ACS_NIMBLE_URL must be HTTP(S) without credentials, query, or fragment");
  }
  const model = env.ACS_NIMBLE_MODEL?.trim() || DEFAULT_NIMBLE_ROUTING_MODEL;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)) {
    throw new NimbleRoutingConfigError("ACS_NIMBLE_MODEL is invalid");
  }
  const timeoutMs = parseBoundedInteger(
    env.ACS_NIMBLE_TIMEOUT_MS,
    DEFAULT_NIMBLE_TIMEOUT_MS,
    1,
    30_000,
    "ACS_NIMBLE_TIMEOUT_MS"
  );
  const threshold = parseThreshold(env.ACS_NIMBLE_CONFIDENCE_THRESHOLD);
  const lowConfidencePolicy = parseEnum(
    env.ACS_NIMBLE_LOW_CONFIDENCE_POLICY,
    ["fallback", "reject"] as const,
    "fallback",
    "ACS_NIMBLE_LOW_CONFIDENCE_POLICY"
  );
  const fallbackMode = parseEnum(
    env.ACS_NIMBLE_FALLBACK_MODE,
    ["deterministic_score"] as const,
    "deterministic_score",
    "ACS_NIMBLE_FALLBACK_MODE"
  );
  const operatorDeny = (env.ACS_NIMBLE_OPERATOR_DENY ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (operatorDeny.some((entry) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(entry))) {
    throw new NimbleRoutingConfigError("ACS_NIMBLE_OPERATOR_DENY contains an invalid executor id");
  }
  return {
    enabled: true,
    url,
    model,
    timeoutMs,
    confidenceThreshold: threshold,
    lowConfidencePolicy,
    fallbackMode,
    operatorDeny
  };
}

export function isAuthoritativeRoutingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveNimbleRoutingConfig(env).enabled;
}

function disabledConfig(): NimbleRoutingConfig {
  return {
    enabled: false,
    url: DEFAULT_NIMBLE_ROUTING_URL,
    model: DEFAULT_NIMBLE_ROUTING_MODEL,
    timeoutMs: DEFAULT_NIMBLE_TIMEOUT_MS,
    confidenceThreshold: DEFAULT_NIMBLE_CONFIDENCE_THRESHOLD,
    lowConfidencePolicy: "fallback",
    fallbackMode: "deterministic_score",
    operatorDeny: []
  };
}

function parseThreshold(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_NIMBLE_CONFIDENCE_THRESHOLD;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new NimbleRoutingConfigError("ACS_NIMBLE_CONFIDENCE_THRESHOLD must be a number from 0 to 1");
  }
  return value;
}

function parseBoundedInteger(raw: string | undefined, fallback: number, min: number, max: number, key: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new NimbleRoutingConfigError(`${key} must be an integer`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new NimbleRoutingConfigError(`${key} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function parseEnum<T extends string>(raw: string | undefined, allowed: readonly T[], fallback: T, key: string): T {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!allowed.includes(raw as T)) {
    throw new NimbleRoutingConfigError(`${key} must be one of ${allowed.join(", ")}`);
  }
  return raw as T;
}
