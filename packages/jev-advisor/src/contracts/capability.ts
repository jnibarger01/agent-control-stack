/**
 * Jev capability contract.
 *
 * Full capability (prompt version + noul/choice/score) comes from engine
 * health metadata or the configured local binary profile. A `/v1/systemone`
 * decision body does not advertise those flags. Absent fields stay absent;
 * they are never defaulted to false.
 */

export type JevCapability = {
  promptVersion: string;
  supportsNoul: boolean;
  supportsChoice: boolean;
  supportsScore: boolean;
  fingerprint: string;
  ggufRevision?: string;
};

/** Fields actually present on a source. Omitted flags were not advertised. */
export type JevCapabilityObservation = {
  promptVersion?: string;
  supportsNoul?: boolean;
  supportsChoice?: boolean;
  supportsScore?: boolean;
  fingerprint?: string;
  ggufRevision?: string;
};

export type JevCapabilityCheck =
  | { ok: true; capability: JevCapability | JevCapabilityObservation }
  | { ok: false; reason: "incompatible_model"; detail: string };

/** Local jevos binary contract. Used when /health is not consulted per request. */
export const LOCAL_BINARY_CAPABILITY: JevCapability = {
  promptVersion: "binary",
  supportsNoul: true,
  supportsChoice: false,
  supportsScore: false,
  fingerprint: ""
};

export function checkCapability(actual: JevCapability, expected: JevCapability): JevCapabilityCheck {
  if (actual.promptVersion !== expected.promptVersion) {
    return mismatch(`prompt_version mismatch: expected ${expected.promptVersion}, got ${actual.promptVersion}`);
  }
  if (expected.supportsNoul && !actual.supportsNoul) {
    return mismatch("noul support required but model does not support it");
  }
  if (expected.supportsChoice && !actual.supportsChoice) {
    return mismatch("choice required but model does not support it");
  }
  if (expected.supportsScore && !actual.supportsScore) {
    return mismatch("score required but model does not support it");
  }
  return { ok: true, capability: actual };
}

/**
 * Validate only fields a decision response actually carried.
 * Missing supportsNoul/supportsChoice/supportsScore are not `false`.
 */
export function checkObservedCapability(
  observed: JevCapabilityObservation,
  expected: JevCapability
): JevCapabilityCheck {
  if (observed.promptVersion !== undefined && observed.promptVersion !== expected.promptVersion) {
    return mismatch(`prompt_version mismatch: expected ${expected.promptVersion}, got ${observed.promptVersion}`);
  }
  if (observed.supportsNoul === false && expected.supportsNoul) {
    return mismatch("noul support mismatch: expected true, got false");
  }
  if (observed.supportsChoice === false && expected.supportsChoice) {
    return mismatch("choice required but model does not support it");
  }
  if (observed.supportsScore === false && expected.supportsScore) {
    return mismatch("score required but model does not support it");
  }
  return { ok: true, capability: observed };
}

export type JevPrimitive = "noul" | "choice" | "score";

/**
 * Convert trusted health/metadata into a complete capability profile.
 * Missing support flags stay unknown: an incomplete source returns null rather
 * than silently turning an absent field into `false`.
 */
export function capabilityFromMetadata(metadata: {
  promptVersion?: string;
  fingerprint?: string;
  ggufRevision?: string;
  supportsNoul?: boolean;
  supportsChoice?: boolean;
  supportsScore?: boolean;
}): JevCapability | null {
  if (
    typeof metadata.promptVersion !== "string" ||
    metadata.promptVersion.length === 0 ||
    typeof metadata.supportsNoul !== "boolean" ||
    typeof metadata.supportsChoice !== "boolean" ||
    typeof metadata.supportsScore !== "boolean"
  ) {
    return null;
  }
  return {
    promptVersion: metadata.promptVersion,
    supportsNoul: metadata.supportsNoul,
    supportsChoice: metadata.supportsChoice,
    supportsScore: metadata.supportsScore,
    fingerprint: typeof metadata.fingerprint === "string" ? metadata.fingerprint : "",
    ...(metadata.ggufRevision !== undefined ? { ggufRevision: metadata.ggufRevision } : {})
  };
}

export function supportsPrimitive(capability: JevCapability, primitive: JevPrimitive): boolean {
  if (primitive === "noul") return capability.supportsNoul;
  if (primitive === "choice") return capability.supportsChoice;
  return capability.supportsScore;
}

/** Pull only advertised capability fields from a decision or model object. */
export function observeCapability(source: unknown): JevCapabilityObservation {
  if (source === null || typeof source !== "object" || Array.isArray(source)) return {};
  const record = source as Record<string, unknown>;
  const nested = record.model;
  const modelRecord =
    nested !== null && typeof nested === "object" && !Array.isArray(nested) ? (nested as Record<string, unknown>) : {};
  const observed: JevCapabilityObservation = {};
  const promptVersion = firstString(
    record.promptVersion,
    record.prompt_version,
    modelRecord.promptVersion,
    modelRecord.prompt_version
  );
  if (promptVersion !== undefined) observed.promptVersion = promptVersion;
  assignBoolean(observed, "supportsNoul", record.supportsNoul, modelRecord.supportsNoul);
  assignBoolean(observed, "supportsChoice", record.supportsChoice, modelRecord.supportsChoice);
  assignBoolean(observed, "supportsScore", record.supportsScore, modelRecord.supportsScore);
  const fingerprint = firstString(record.fingerprint, modelRecord.fingerprint, modelRecord.gguf_sha256);
  if (fingerprint !== undefined) observed.fingerprint = fingerprint;
  return observed;
}

function assignBoolean(
  target: JevCapabilityObservation,
  key: "supportsNoul" | "supportsChoice" | "supportsScore",
  ...values: unknown[]
): void {
  for (const value of values) {
    if (typeof value === "boolean") {
      target[key] = value;
      return;
    }
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function mismatch(detail: string): JevCapabilityCheck {
  return { ok: false, reason: "incompatible_model", detail };
}
