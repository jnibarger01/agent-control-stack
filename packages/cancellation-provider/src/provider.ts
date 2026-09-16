import type {
  CodexSwarmProviderBinding,
  CurrentProviderBindingValidation,
  CurrentProviderBindingValidator
} from "@agent-control-stack/work-items";
import {
  resolveProtectedCancellationProviderAdapter,
  type ProtectedCancellationProviderAdapter,
  type ProtectedCancellationProviderSession,
  type ProviderLifecycleGuard,
  type ProviderLifecycleSnapshot
} from "./provider-internal.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ADAPTER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const CONTEXT_TTL_MS = 30_000;
const MAX_CLOCK_SKEW_MS = 2_000;
const ROTATION_OVERLAP_MS = 30_000;
const STARTUP_TIMEOUT_MS = 5_000;
const SESSION_BINDING_DOMAIN = "acs-cancellation-session-epoch-v1";
const DESCRIPTOR_KEYS = [
  "schemaVersion",
  "providerId",
  "adapterId",
  "audience",
  "operation",
  "contextTtlSeconds",
  "maxClockSkewSeconds",
  "rotationOverlapSeconds",
  "startupTimeoutMs"
] as const;
const VERIFY_INPUT_KEYS = [
  "schemaVersion",
  "peerContext",
  "audience",
  "operation",
  "canonicalRequestHash",
  "requestIdHash",
  "now"
] as const;
const PRINCIPAL_KEYS = [
  "schemaVersion",
  "principalId",
  "credentialProviderId",
  "verificationMethod",
  "authnAt",
  "credentialExpiresAt",
  "providerGeneration",
  "proofBindingHash",
  "sessionEpoch"
] as const;
const FAILURE_KINDS = ["invalid", "revoked", "expired", "unavailable", "timeout", "malformed"] as const;
const HEALTH_STATES = ["starting", "ready", "degraded", "revoked", "closed"] as const;

/** Intentionally empty until a concrete provider passes its separate production gate. */
const PRODUCTION_ADAPTER_IDS = Object.freeze([] as string[]);
const observedProviderEpochs = new WeakSet<object>();

declare const opaquePeerContextBrand: unique symbol;
declare const providerCapabilityBrand: unique symbol;
declare const providerSessionEpochBrand: unique symbol;

export type OpaquePeerContext = object & { readonly [opaquePeerContextBrand]: true };
export type CancellationProviderCapability = object & { readonly [providerCapabilityBrand]: true };
export type ProviderSessionEpoch = object & { readonly [providerSessionEpochBrand]: true };

export type ProviderBootstrapDescriptorV1 = Readonly<{
  schemaVersion: "acs.trusted-cancellation-provider.v1";
  providerId: string;
  adapterId: string;
  audience: "acs-cancellation";
  operation: "cancel";
  contextTtlSeconds: 30;
  maxClockSkewSeconds: 2;
  rotationOverlapSeconds: 30;
  startupTimeoutMs: 5000;
}>;

export type ProviderVerifyInputV1 = Readonly<{
  schemaVersion: "acs.provider-verify-input.v1";
  peerContext: OpaquePeerContext;
  audience: "acs-cancellation";
  operation: "cancel";
  canonicalRequestHash: string;
  requestIdHash: string;
  now: string;
}>;

export type VerifiedCancellationPrincipalV1 = Readonly<{
  schemaVersion: "acs.verified-cancellation-principal.v1";
  principalId: string;
  credentialProviderId: string;
  verificationMethod: string;
  authnAt: string;
  credentialExpiresAt: string;
  providerGeneration: number;
  proofBindingHash: string;
  sessionEpoch: ProviderSessionEpoch;
}>;

export type ProviderFailureV1 = Readonly<{
  schemaVersion: "acs.provider-failure.v1";
  kind: (typeof FAILURE_KINDS)[number];
}>;

export type ProviderHealthV1 = Readonly<{
  schemaVersion: "acs.provider-health.v1";
  state: (typeof HEALTH_STATES)[number];
  activeGeneration?: number;
}>;

export type SealedProviderLifecycleBinding = Readonly<CodexSwarmProviderBinding>;

export type ProviderBindingIssueInputV1 = Readonly<{
  contextHash: string;
  issuedAt: string;
  expiresAt: string;
}>;

export interface MonotonicWallClock {
  now(): Date;
  monotonicNowMs(): number;
}

export interface TrustedCancellationProviderSession {
  readonly descriptor: ProviderBootstrapDescriptorV1;
  readonly sessionEpoch: ProviderSessionEpoch;
  readonly currentProviderBindingValidator: CurrentProviderBindingValidator;
  health(): Promise<ProviderHealthV1>;
  verify(input: ProviderVerifyInputV1): Promise<VerifiedCancellationPrincipalV1 | ProviderFailureV1>;
  sealCurrentBinding(
    principal: VerifiedCancellationPrincipalV1,
    input: ProviderBindingIssueInputV1
  ): SealedProviderLifecycleBinding;
  beginRotation(): Promise<
    Readonly<{
      oldGeneration: number;
      activeGeneration: number;
      activatedAt: string;
      overlapEndsAt: string;
    }>
  >;
  revoke(generation: number | "all"): Promise<void>;
  closeAndZeroize(deadlineMs: 5000): Promise<Readonly<{ closed: true; zeroizationConfirmed: true }>>;
}

export type CancellationProviderErrorCode =
  | "cancellation_provider_descriptor_invalid"
  | "cancellation_provider_unavailable"
  | "cancellation_provider_timeout"
  | "cancellation_provider_malformed"
  | "cancellation_provider_not_ready"
  | "cancellation_provider_binding_invalid"
  | "cancellation_provider_zeroization_failed";

export class CancellationProviderError extends Error {
  readonly code: CancellationProviderErrorCode;

  constructor(code: CancellationProviderErrorCode, message: string) {
    super(message);
    this.name = "CancellationProviderError";
    this.code = code;
  }
}

class OpaqueRuntimeProviderSessionEpoch {
  toJSON(): never {
    throw new TypeError("ProviderSessionEpoch is process-local and cannot be serialized");
  }
}

interface VerifiedPrincipalRecord {
  adapterEpoch: object;
  authnAtMs: number;
  credentialExpiresAtMs: number;
  providerGeneration: number;
  proofBindingHash: string;
}

interface IssuedBindingRecord extends VerifiedPrincipalRecord {
  contextHash: string;
  issuedAtMs: number;
  issuedAtMonotonicMs: number;
  expiresAtMs: number;
  sessionEpochBindingHash: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[]
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function isAdapterId(value: unknown): value is string {
  return typeof value === "string" && ADAPTER_ID_PATTERN.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function isPositiveGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validateDescriptor(value: ProviderBootstrapDescriptorV1): void {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, DESCRIPTOR_KEYS) ||
    value.schemaVersion !== "acs.trusted-cancellation-provider.v1" ||
    !isIdentifier(value.providerId) ||
    !isAdapterId(value.adapterId) ||
    value.audience !== "acs-cancellation" ||
    value.operation !== "cancel" ||
    value.contextTtlSeconds !== 30 ||
    value.maxClockSkewSeconds !== 2 ||
    value.rotationOverlapSeconds !== 30 ||
    value.startupTimeoutMs !== 5000
  ) {
    throw new CancellationProviderError(
      "cancellation_provider_descriptor_invalid",
      "trusted cancellation provider descriptor is malformed or changes a frozen bound"
    );
  }
}

function validateHealth(value: unknown): ProviderHealthV1 | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["schemaVersion", "state"], ["activeGeneration"])) return undefined;
  if (value.schemaVersion !== "acs.provider-health.v1" || !HEALTH_STATES.includes(value.state as never))
    return undefined;
  if (value.activeGeneration !== undefined && !isPositiveGeneration(value.activeGeneration)) return undefined;
  return Object.freeze({
    schemaVersion: "acs.provider-health.v1" as const,
    state: value.state as ProviderHealthV1["state"],
    ...(value.activeGeneration === undefined ? {} : { activeGeneration: value.activeGeneration as number })
  });
}

function validateVerifyInput(value: ProviderVerifyInputV1): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, VERIFY_INPUT_KEYS) &&
    value.schemaVersion === "acs.provider-verify-input.v1" &&
    typeof value.peerContext === "object" &&
    value.peerContext !== null &&
    value.audience === "acs-cancellation" &&
    value.operation === "cancel" &&
    isHash(value.canonicalRequestHash) &&
    isHash(value.requestIdHash) &&
    parseTimestamp(value.now) !== undefined
  );
}

function sanitizeFailure(value: unknown): ProviderFailureV1 | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "kind"]) ||
    value.schemaVersion !== "acs.provider-failure.v1" ||
    !FAILURE_KINDS.includes(value.kind as never)
  ) {
    return undefined;
  }
  return Object.freeze({ schemaVersion: "acs.provider-failure.v1", kind: value.kind as ProviderFailureV1["kind"] });
}

function bindingKey(binding: CodexSwarmProviderBinding): string {
  return `${binding.contextHash}:${binding.proofBindingHash}:${binding.providerGeneration}:${binding.sessionEpochBindingHash}`;
}

function snapshotIsWellFormed(snapshot: ProviderLifecycleSnapshot): boolean {
  if (!isRecord(snapshot) || !HEALTH_STATES.includes(snapshot.state as never)) return false;
  if (snapshot.activeGeneration !== undefined && !isPositiveGeneration(snapshot.activeGeneration)) return false;
  if (!isHash(snapshot.sessionEpochBindingHash) || !(snapshot.revokedGenerations instanceof Set)) return false;
  if (snapshot.previousGeneration !== undefined) {
    if (
      !isRecord(snapshot.previousGeneration) ||
      !isPositiveGeneration(snapshot.previousGeneration.generation) ||
      parseTimestamp(snapshot.previousGeneration.overlapEndsAt) === undefined
    ) {
      return false;
    }
  }
  for (const generation of snapshot.revokedGenerations) {
    if (!isPositiveGeneration(generation)) return false;
  }
  return true;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new CancellationProviderError("cancellation_provider_timeout", "provider operation timed out")),
          timeoutMs
        );
        timer.unref();
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class TrustedCancellationProviderRuntime implements TrustedCancellationProviderSession {
  readonly descriptor: ProviderBootstrapDescriptorV1;
  readonly sessionEpoch: ProviderSessionEpoch;
  readonly currentProviderBindingValidator: CurrentProviderBindingValidator;

  private readonly providerSession: ProtectedCancellationProviderSession;
  private readonly adapterEpoch: object;
  private readonly clock: MonotonicWallClock;
  private readonly clockAnchorWallMs: number;
  private readonly clockAnchorMonotonicMs: number;
  private readonly verifiedPrincipals = new WeakMap<object, VerifiedPrincipalRecord>();
  private readonly issuedBindings = new Map<string, IssuedBindingRecord>();
  private lastMonotonicMs: number;
  private previousGenerationWindow: Readonly<{ generation: number; overlapEndsAtMonotonicMs: number }> | undefined;
  private terminal = false;

  constructor(
    descriptor: ProviderBootstrapDescriptorV1,
    providerSession: ProtectedCancellationProviderSession,
    clock: MonotonicWallClock
  ) {
    this.descriptor = Object.freeze({ ...descriptor });
    this.providerSession = providerSession;
    this.adapterEpoch = providerSession.sessionEpoch;
    this.clock = clock;
    this.clockAnchorWallMs = clock.now().getTime();
    this.clockAnchorMonotonicMs = clock.monotonicNowMs();
    this.lastMonotonicMs = this.clockAnchorMonotonicMs;
    if (
      !Number.isFinite(this.clockAnchorWallMs) ||
      !Number.isFinite(this.clockAnchorMonotonicMs) ||
      this.clockAnchorMonotonicMs < 0
    ) {
      throw new CancellationProviderError("cancellation_provider_unavailable", "provider clock is unverifiable");
    }
    this.sessionEpoch = Object.freeze(new OpaqueRuntimeProviderSessionEpoch()) as unknown as ProviderSessionEpoch;
    this.currentProviderBindingValidator = Object.freeze({
      validateCurrent: (binding: CodexSwarmProviderBinding, now: string): CurrentProviderBindingValidation =>
        this.validateCurrent(binding, now)
    });
  }

  async health(): Promise<ProviderHealthV1> {
    if (this.terminal) return Object.freeze({ schemaVersion: "acs.provider-health.v1", state: "closed" });
    try {
      const health = validateHealth(await withTimeout(this.providerSession.health(), STARTUP_TIMEOUT_MS));
      if (health === undefined) return Object.freeze({ schemaVersion: "acs.provider-health.v1", state: "degraded" });
      return health;
    } catch {
      return Object.freeze({ schemaVersion: "acs.provider-health.v1", state: "degraded" });
    }
  }

  async verify(input: ProviderVerifyInputV1): Promise<VerifiedCancellationPrincipalV1 | ProviderFailureV1> {
    if (this.terminal) return Object.freeze({ schemaVersion: "acs.provider-failure.v1", kind: "unavailable" });
    if (!validateVerifyInput(input))
      return Object.freeze({ schemaVersion: "acs.provider-failure.v1", kind: "malformed" });

    const readinessGuard = this.acquireLifecycleGuard();
    if (
      readinessGuard === undefined ||
      readinessGuard.snapshot.state !== "ready" ||
      readinessGuard.snapshot.activeGeneration === undefined
    ) {
      readinessGuard?.release();
      return Object.freeze({ schemaVersion: "acs.provider-failure.v1", kind: "unavailable" });
    }
    readinessGuard.release();

    let raw: unknown;
    try {
      raw = await withTimeout(this.providerSession.verify(input), STARTUP_TIMEOUT_MS);
    } catch (error) {
      return Object.freeze({
        schemaVersion: "acs.provider-failure.v1",
        kind:
          error instanceof CancellationProviderError && error.code === "cancellation_provider_timeout"
            ? "timeout"
            : "unavailable"
      });
    }

    const failure = sanitizeFailure(raw);
    if (failure !== undefined) return failure;
    if (!isRecord(raw) || !hasExactKeys(raw, PRINCIPAL_KEYS)) {
      return Object.freeze({ schemaVersion: "acs.provider-failure.v1", kind: "malformed" });
    }
    const authnAtMs = parseTimestamp(raw.authnAt);
    const credentialExpiresAtMs = parseTimestamp(raw.credentialExpiresAt);
    const inputNowMs = parseTimestamp(input.now);
    const freshClock = this.sampleClock();
    if (
      raw.schemaVersion !== "acs.verified-cancellation-principal.v1" ||
      !isIdentifier(raw.principalId) ||
      raw.credentialProviderId !== this.descriptor.providerId ||
      !isIdentifier(raw.verificationMethod) ||
      authnAtMs === undefined ||
      credentialExpiresAtMs === undefined ||
      inputNowMs === undefined ||
      !isPositiveGeneration(raw.providerGeneration) ||
      !isHash(raw.proofBindingHash) ||
      raw.sessionEpoch !== this.adapterEpoch ||
      freshClock === undefined
    ) {
      return Object.freeze({ schemaVersion: "acs.provider-failure.v1", kind: "malformed" });
    }
    if (credentialExpiresAtMs + MAX_CLOCK_SKEW_MS < freshClock.wallMs) {
      return Object.freeze({ schemaVersion: "acs.provider-failure.v1", kind: "expired" });
    }
    const freshGuard = this.acquireLifecycleGuard();
    if (freshGuard === undefined || freshGuard.snapshot.state !== "ready") {
      freshGuard?.release();
      return Object.freeze({ schemaVersion: "acs.provider-failure.v1", kind: "unavailable" });
    }
    try {
      if (freshGuard.snapshot.revokedGenerations.has(raw.providerGeneration)) {
        return Object.freeze({ schemaVersion: "acs.provider-failure.v1", kind: "revoked" });
      }
      if (
        authnAtMs > inputNowMs + MAX_CLOCK_SKEW_MS ||
        raw.providerGeneration !== freshGuard.snapshot.activeGeneration
      ) {
        return Object.freeze({ schemaVersion: "acs.provider-failure.v1", kind: "invalid" });
      }

      const principal = Object.freeze({
        schemaVersion: "acs.verified-cancellation-principal.v1" as const,
        principalId: raw.principalId,
        credentialProviderId: raw.credentialProviderId,
        verificationMethod: raw.verificationMethod,
        authnAt: raw.authnAt as string,
        credentialExpiresAt: raw.credentialExpiresAt as string,
        providerGeneration: raw.providerGeneration,
        proofBindingHash: raw.proofBindingHash,
        sessionEpoch: this.sessionEpoch
      });
      this.verifiedPrincipals.set(principal, {
        adapterEpoch: this.adapterEpoch,
        authnAtMs,
        credentialExpiresAtMs,
        providerGeneration: principal.providerGeneration,
        proofBindingHash: principal.proofBindingHash
      });
      return principal;
    } finally {
      freshGuard.release();
    }
  }

  sealCurrentBinding(
    principal: VerifiedCancellationPrincipalV1,
    input: ProviderBindingIssueInputV1
  ): SealedProviderLifecycleBinding {
    const verified = this.verifiedPrincipals.get(principal);
    const issuedAtMs = parseTimestamp(input.issuedAt);
    const expiresAtMs = parseTimestamp(input.expiresAt);
    const clock = this.sampleClock();
    const guard = this.acquireLifecycleGuard();
    const snapshot = guard?.snapshot;
    if (
      this.terminal ||
      verified === undefined ||
      verified.adapterEpoch !== this.adapterEpoch ||
      !isHash(input.contextHash) ||
      issuedAtMs === undefined ||
      expiresAtMs === undefined ||
      clock === undefined ||
      snapshot === undefined ||
      snapshot.state !== "ready" ||
      snapshot.activeGeneration !== verified.providerGeneration ||
      snapshot.revokedGenerations.has(verified.providerGeneration) ||
      verified.authnAtMs > issuedAtMs + MAX_CLOCK_SKEW_MS ||
      issuedAtMs > clock.wallMs + MAX_CLOCK_SKEW_MS ||
      issuedAtMs < clock.wallMs - MAX_CLOCK_SKEW_MS ||
      expiresAtMs <= issuedAtMs ||
      expiresAtMs - issuedAtMs > CONTEXT_TTL_MS ||
      expiresAtMs > verified.credentialExpiresAtMs
    ) {
      guard?.release();
      throw new CancellationProviderError(
        "cancellation_provider_binding_invalid",
        "verified principal cannot be sealed into a current provider binding"
      );
    }

    const binding = Object.freeze({
      contextHash: input.contextHash,
      proofBindingHash: verified.proofBindingHash,
      providerGeneration: verified.providerGeneration,
      sessionEpochBindingHash: snapshot.sessionEpochBindingHash
    });
    this.issuedBindings.set(bindingKey(binding), {
      ...verified,
      contextHash: binding.contextHash,
      issuedAtMs,
      issuedAtMonotonicMs: clock.monotonicMs,
      expiresAtMs,
      sessionEpochBindingHash: binding.sessionEpochBindingHash
    });
    guard!.release();
    return binding;
  }

  async beginRotation(): Promise<
    Readonly<{ oldGeneration: number; activeGeneration: number; activatedAt: string; overlapEndsAt: string }>
  > {
    if (this.terminal)
      throw new CancellationProviderError("cancellation_provider_not_ready", "provider session is closed");
    const before = this.requireReadySnapshot();
    const result = await withTimeout(this.providerSession.beginRotation(), STARTUP_TIMEOUT_MS);
    if (
      !isRecord(result) ||
      !hasExactKeys(result, ["oldGeneration", "activeGeneration", "activatedAt", "overlapEndsAt"])
    ) {
      throw new CancellationProviderError(
        "cancellation_provider_malformed",
        "provider returned a malformed rotation result"
      );
    }
    const activatedAtMs = parseTimestamp(result.activatedAt);
    const overlapEndsAtMs = parseTimestamp(result.overlapEndsAt);
    const clock = this.sampleClock();
    const after = this.requireReadySnapshot();
    if (
      result.oldGeneration !== before.activeGeneration ||
      !isPositiveGeneration(result.activeGeneration) ||
      result.activeGeneration === result.oldGeneration ||
      activatedAtMs === undefined ||
      overlapEndsAtMs === undefined ||
      clock === undefined ||
      overlapEndsAtMs - activatedAtMs !== ROTATION_OVERLAP_MS ||
      after.activeGeneration !== result.activeGeneration ||
      after.previousGeneration?.generation !== result.oldGeneration ||
      after.previousGeneration.overlapEndsAt !== result.overlapEndsAt
    ) {
      this.terminal = true;
      throw new CancellationProviderError("cancellation_provider_malformed", "provider rotation state is inconsistent");
    }
    this.previousGenerationWindow = Object.freeze({
      generation: result.oldGeneration as number,
      overlapEndsAtMonotonicMs: clock.monotonicMs + (overlapEndsAtMs - clock.wallMs)
    });
    return Object.freeze({
      oldGeneration: result.oldGeneration as number,
      activeGeneration: result.activeGeneration,
      activatedAt: result.activatedAt as string,
      overlapEndsAt: result.overlapEndsAt as string
    });
  }

  async revoke(generation: number | "all"): Promise<void> {
    if (generation !== "all" && !isPositiveGeneration(generation)) {
      throw new CancellationProviderError(
        "cancellation_provider_binding_invalid",
        "revocation generation must be positive"
      );
    }
    await withTimeout(this.providerSession.revoke(generation), STARTUP_TIMEOUT_MS);
    const snapshot = this.safeSnapshot();
    const reflected =
      snapshot !== undefined &&
      (generation === "all"
        ? snapshot.state === "revoked" || snapshot.state === "closed"
        : snapshot.revokedGenerations.has(generation));
    if (!reflected) {
      this.terminal = true;
      throw new CancellationProviderError(
        "cancellation_provider_malformed",
        "provider revocation was not visible before revoke returned"
      );
    }
  }

  async closeAndZeroize(deadlineMs: 5000): Promise<Readonly<{ closed: true; zeroizationConfirmed: true }>> {
    if (deadlineMs !== 5000) {
      throw new CancellationProviderError(
        "cancellation_provider_zeroization_failed",
        "zeroization deadline must be 5000ms"
      );
    }
    this.terminal = true;
    this.issuedBindings.clear();
    try {
      await withTimeout(this.providerSession.revoke("all"), deadlineMs);
      const revoked = this.safeSnapshot();
      if (revoked === undefined || (revoked.state !== "revoked" && revoked.state !== "closed")) {
        throw new CancellationProviderError(
          "cancellation_provider_zeroization_failed",
          "provider revocation was not visible before zeroization"
        );
      }
      const result = await withTimeout(this.providerSession.closeAndZeroize(5000), deadlineMs);
      if (
        !isRecord(result) ||
        !hasExactKeys(result, ["closed", "zeroizationConfirmed"]) ||
        result.closed !== true ||
        result.zeroizationConfirmed !== true
      ) {
        throw new CancellationProviderError(
          "cancellation_provider_zeroization_failed",
          "provider did not confirm closure and zeroization"
        );
      }
      return Object.freeze({ closed: true, zeroizationConfirmed: true });
    } catch (error) {
      if (error instanceof CancellationProviderError && error.code === "cancellation_provider_zeroization_failed")
        throw error;
      throw new CancellationProviderError(
        "cancellation_provider_zeroization_failed",
        "provider zeroization failed closed"
      );
    }
  }

  private safeSnapshot(): ProviderLifecycleSnapshot | undefined {
    const guard = this.acquireLifecycleGuard();
    if (guard === undefined) return undefined;
    try {
      return guard.snapshot;
    } finally {
      guard.release();
    }
  }

  private acquireLifecycleGuard(): ProviderLifecycleGuard | undefined {
    try {
      const guard = this.providerSession.acquireLifecycleGuard();
      if (
        guard === undefined ||
        !isRecord(guard) ||
        typeof guard.release !== "function" ||
        !snapshotIsWellFormed(guard.snapshot as ProviderLifecycleSnapshot)
      ) {
        if (isRecord(guard) && typeof guard.release === "function") {
          try {
            guard.release();
          } catch {
            // malformed guard remains a fail-closed provider result
          }
        }
        return undefined;
      }
      return guard as unknown as ProviderLifecycleGuard;
    } catch {
      return undefined;
    }
  }

  private sampleClock(): Readonly<{ wallMs: number; monotonicMs: number }> | undefined {
    try {
      const wallMs = this.clock.now().getTime();
      const monotonicMs = this.clock.monotonicNowMs();
      const expectedWallMs = this.clockAnchorWallMs + (monotonicMs - this.clockAnchorMonotonicMs);
      if (
        !Number.isFinite(wallMs) ||
        !Number.isFinite(monotonicMs) ||
        monotonicMs < this.lastMonotonicMs ||
        Math.abs(wallMs - expectedWallMs) > MAX_CLOCK_SKEW_MS
      ) {
        return undefined;
      }
      this.lastMonotonicMs = monotonicMs;
      return Object.freeze({ wallMs, monotonicMs });
    } catch {
      return undefined;
    }
  }

  private requireReadySnapshot(): ProviderLifecycleSnapshot & { activeGeneration: number } {
    const snapshot = this.safeSnapshot();
    if (snapshot === undefined || snapshot.state !== "ready" || snapshot.activeGeneration === undefined) {
      throw new CancellationProviderError("cancellation_provider_not_ready", "provider is not ready");
    }
    return snapshot as ProviderLifecycleSnapshot & { activeGeneration: number };
  }

  private validateCurrent(binding: CodexSwarmProviderBinding, now: string): CurrentProviderBindingValidation {
    if (this.terminal) return { kind: "unavailable" };
    if (
      !isRecord(binding) ||
      !hasExactKeys(binding, ["contextHash", "proofBindingHash", "providerGeneration", "sessionEpochBindingHash"]) ||
      !isHash(binding.contextHash) ||
      !isHash(binding.proofBindingHash) ||
      !isPositiveGeneration(binding.providerGeneration) ||
      !isHash(binding.sessionEpochBindingHash)
    ) {
      return { kind: "proof_invalid" };
    }
    const nowMs = parseTimestamp(now);
    const clock = this.sampleClock();
    if (nowMs === undefined || clock === undefined || Math.abs(nowMs - clock.wallMs) > MAX_CLOCK_SKEW_MS) {
      return { kind: "unavailable" };
    }
    const guard = this.acquireLifecycleGuard();
    if (guard === undefined) return { kind: "unavailable" };
    const finish = (result: CurrentProviderBindingValidation): CurrentProviderBindingValidation => {
      if (result.kind === "current") {
        queueMicrotask(() => {
          try {
            guard.release();
          } catch {
            this.terminal = true;
          }
        });
      } else {
        try {
          guard.release();
        } catch {
          this.terminal = true;
          return { kind: "unavailable" };
        }
      }
      return result;
    };
    const snapshot = guard.snapshot;
    if (snapshot.state === "starting" || snapshot.state === "degraded") return finish({ kind: "unavailable" });
    if (snapshot.state === "revoked" || snapshot.state === "closed") return finish({ kind: "revoked" });
    if (snapshot.sessionEpochBindingHash !== binding.sessionEpochBindingHash) {
      return finish({ kind: "session_stale" });
    }
    const issued = this.issuedBindings.get(bindingKey(binding));
    if (
      issued === undefined ||
      issued.contextHash !== binding.contextHash ||
      issued.proofBindingHash !== binding.proofBindingHash ||
      issued.providerGeneration !== binding.providerGeneration ||
      issued.sessionEpochBindingHash !== binding.sessionEpochBindingHash
    ) {
      return finish({ kind: "proof_invalid" });
    }
    if (snapshot.revokedGenerations.has(binding.providerGeneration)) return finish({ kind: "revoked" });
    const elapsedMs = clock.monotonicMs - issued.issuedAtMonotonicMs;
    if (elapsedMs < 0 || elapsedMs > issued.expiresAtMs - issued.issuedAtMs + MAX_CLOCK_SKEW_MS) {
      return finish({ kind: "proof_invalid" });
    }
    if (snapshot.activeGeneration === binding.providerGeneration) return finish({ kind: "current" });
    if (
      snapshot.previousGeneration?.generation === binding.providerGeneration &&
      this.previousGenerationWindow?.generation === binding.providerGeneration &&
      clock.monotonicMs <= this.previousGenerationWindow.overlapEndsAtMonotonicMs &&
      nowMs <= (parseTimestamp(snapshot.previousGeneration.overlapEndsAt) ?? Number.NEGATIVE_INFINITY)
    ) {
      return finish({ kind: "current" });
    }
    return finish({ kind: "generation_invalid" });
  }
}

export function productionCancellationProviderAdapterIds(): readonly string[] {
  return PRODUCTION_ADAPTER_IDS;
}

export async function bootstrapTrustedCancellationProvider(
  descriptor: ProviderBootstrapDescriptorV1,
  capability: CancellationProviderCapability,
  clock: MonotonicWallClock
): Promise<TrustedCancellationProviderSession> {
  return bootstrapTrustedCancellationProviderInternal(descriptor, capability, clock, false);
}

export async function bootstrapTrustedCancellationProviderInternal(
  descriptor: ProviderBootstrapDescriptorV1,
  capability: CancellationProviderCapability,
  clock: MonotonicWallClock,
  allowTestAdapter: boolean
): Promise<TrustedCancellationProviderSession> {
  validateDescriptor(descriptor);
  const adapter = resolveProtectedCancellationProviderAdapter(capability);
  if (adapter === undefined || adapter.adapterId !== descriptor.adapterId) {
    throw new CancellationProviderError(
      "cancellation_provider_unavailable",
      "provider capability is absent or mismatched"
    );
  }
  enforceAdapterPolicy(adapter, allowTestAdapter);

  let providerSession: ProtectedCancellationProviderSession;
  try {
    providerSession = await withTimeout(adapter.open(descriptor), descriptor.startupTimeoutMs);
  } catch (error) {
    if (error instanceof CancellationProviderError) throw error;
    throw new CancellationProviderError("cancellation_provider_unavailable", "provider bootstrap failed");
  }
  if (
    providerSession.providerId !== descriptor.providerId ||
    providerSession.adapterId !== descriptor.adapterId ||
    typeof providerSession.sessionEpoch !== "object" ||
    providerSession.sessionEpoch === null ||
    observedProviderEpochs.has(providerSession.sessionEpoch)
  ) {
    throw new CancellationProviderError(
      "cancellation_provider_malformed",
      "provider session identity or epoch is invalid"
    );
  }
  observedProviderEpochs.add(providerSession.sessionEpoch);

  let health: ProviderHealthV1 | undefined;
  try {
    health = validateHealth(await withTimeout(providerSession.health(), descriptor.startupTimeoutMs));
  } catch (error) {
    if (error instanceof CancellationProviderError && error.code === "cancellation_provider_timeout") throw error;
    throw new CancellationProviderError("cancellation_provider_unavailable", "provider health check failed");
  }
  const snapshot = (() => {
    let guard: ProviderLifecycleGuard | undefined;
    try {
      guard = providerSession.acquireLifecycleGuard();
      return guard?.snapshot;
    } catch {
      return undefined;
    } finally {
      try {
        guard?.release();
      } catch {
        // malformed guard keeps bootstrap unready
      }
    }
  })();
  if (
    health?.state !== "ready" ||
    health.activeGeneration === undefined ||
    snapshot === undefined ||
    !snapshotIsWellFormed(snapshot) ||
    snapshot.state !== "ready" ||
    snapshot.activeGeneration !== health.activeGeneration ||
    !isHash(snapshot.sessionEpochBindingHash)
  ) {
    throw new CancellationProviderError("cancellation_provider_not_ready", "provider did not become ready");
  }
  return new TrustedCancellationProviderRuntime(descriptor, providerSession, clock);
}

function enforceAdapterPolicy(adapter: ProtectedCancellationProviderAdapter, allowTestAdapter: boolean): void {
  if (allowTestAdapter) {
    if (!adapter.testOnly || !adapter.adapterId.startsWith("test-only/")) {
      throw new CancellationProviderError(
        "cancellation_provider_unavailable",
        "test bootstrap requires a test-only adapter"
      );
    }
    return;
  }
  if (
    adapter.testOnly ||
    adapter.adapterId.startsWith("test-only/") ||
    !PRODUCTION_ADAPTER_IDS.includes(adapter.adapterId)
  ) {
    throw new CancellationProviderError(
      "cancellation_provider_unavailable",
      "provider adapter is not statically registered for production"
    );
  }
}

export const providerContractConstants = Object.freeze({
  contextTtlMs: CONTEXT_TTL_MS,
  maxClockSkewMs: MAX_CLOCK_SKEW_MS,
  rotationOverlapMs: ROTATION_OVERLAP_MS,
  startupTimeoutMs: STARTUP_TIMEOUT_MS,
  sessionBindingDomain: SESSION_BINDING_DOMAIN
});
