import {
  CODEX_SWARM_ENGINE_ID,
  evidenceMatchesEnvelope,
  swarmExecutionEvidenceSchema,
  type ExecutionEnvelope,
  type VerifyExecutionEnvelopeResult,
  type SwarmExecutionEvidence
} from "./codex-swarm-envelope.js";
import type {
  AuthenticatedCodexSwarmCancellation,
  CancelCodexSwarmAttemptResult,
  CodexSwarmDispatchReservationInput,
  CodexSwarmDispatchReservationResult,
  CodexSwarmDispatchStartResult,
  CompleteCodexSwarmDispatchStartResult
} from "@agent-control-stack/work-items";

/** Test-only coordinator boundary. It deliberately has no shell, filesystem, network, or MCP dependency. */
export const CODEX_SWARM_TEST_PROVIDER = "in_memory" as const;
const evidenceFreshnessMs = 30_000;
const evidenceMaxClockSkewMs = 5_000;
const forbiddenLifecycleKeys = new Set(["succeeded", "approved", "promoted", "granted", "authorized", "accepted"]);
const verifiedEnvelopeDenialReasons = new Set([
  "envelope_schema_invalid",
  "envelope_hash_mismatch",
  "envelope_mac_secret_invalid",
  "envelope_mac_mismatch",
  "envelope_ttl_exceeded",
  "envelope_expired",
  "envelope_issued_at_in_future",
  "envelope_attempt_mismatch"
]);

export interface DispatchReservation {
  workItemId: string;
  attemptId: string;
  leaseId: string;
  fencingEpoch: number;
  envelopeHash: string;
  idempotencyKey: string;
}

export interface AttemptAuthority extends Pick<DispatchReservation, "workItemId" | "attemptId" | "leaseId" | "fencingEpoch"> {
  active: boolean;
  revoked: boolean;
  workspace: { allocationId: string; hostPath: string; expectedBaseSha: string };
  admittedPlanHash: string;
}

export interface CodexSwarmAuthorityPort {
  read(binding: Pick<DispatchReservation, "workItemId" | "attemptId" | "leaseId" | "fencingEpoch">): AttemptAuthority | undefined;
  /** Atomically authenticate, fence, revoke, and persist this request-id result. */
  cancel(input: AuthenticatedCancellationRequest): { kind: "cancelled" | "replay" | "stale" };
}

export interface CancellationRequest extends Pick<DispatchReservation, "workItemId" | "attemptId" | "leaseId" | "fencingEpoch"> {
  requestId: string;
}

/** Produced by the ACS authentication boundary, never supplied by the caller. */
export interface AuthenticatedCancellationRequest extends CancellationRequest {
  principalId: string;
  canonicalIntentHash: string;
  providerBinding: AuthenticatedCodexSwarmCancellation["providerBinding"];
}

export interface CancellationAuthenticationVerifier {
  verify(input: CancellationRequest): AuthenticatedCancellationRequest | undefined;
}

export interface DispatchReservationPort {
  /** Must execute atomically in durable ACS storage, never in the child process. */
  reserve(tuple: DispatchReservation): { kind: "reserved" } | { kind: "replay" } | { kind: "conflict" };
  /** Persist the immutable child-start result before the coordinator returns it. */
  completeStart(
    tuple: DispatchReservation,
    result: { kind: "started" } | { kind: "failed_start"; reason: string }
  ): { kind: "completed" } | { kind: "replay" } | { kind: "conflict" };
}

/**
 * Test-only adapter to the one canonical durable authority. It does not read
 * authority and cannot grant it: `reserveCodexSwarmDispatch` revalidates the
 * current tuple in its writer transaction.
 */
export function createCodexSwarmStoreReservationPort(
  store: Pick<
    {
      reserveCodexSwarmDispatch(input: CodexSwarmDispatchReservationInput): CodexSwarmDispatchReservationResult;
      completeCodexSwarmDispatchStart(
        input: CodexSwarmDispatchReservationInput,
        result: CodexSwarmDispatchStartResult
      ): CompleteCodexSwarmDispatchStartResult;
    },
    "reserveCodexSwarmDispatch" | "completeCodexSwarmDispatchStart"
  >
): DispatchReservationPort {
  return {
    reserve: (tuple) => store.reserveCodexSwarmDispatch(tuple),
    completeStart: (tuple, result) => store.completeCodexSwarmDispatchStart(tuple, result)
  };
}

/**
 * Test-only adapter to the canonical cancellation writer. Authentication facts
 * are accepted only from the injected verifier and copied into the store-owned
 * shape; the store revalidates all durable bindings atomically.
 */
export function createCodexSwarmStoreAuthorityPort(
  store: Pick<
    { cancelCodexSwarmAttempt(input: AuthenticatedCodexSwarmCancellation): CancelCodexSwarmAttemptResult },
    "cancelCodexSwarmAttempt"
  >
): Pick<CodexSwarmAuthorityPort, "cancel"> {
  return {
    cancel: (input) => {
      const result = store.cancelCodexSwarmAttempt({
        requestId: input.requestId,
        workItemId: input.workItemId,
        attemptId: input.attemptId,
        leaseId: input.leaseId,
        fencingEpoch: input.fencingEpoch,
        authenticatedPrincipalId: input.principalId,
        canonicalIntentHash: input.canonicalIntentHash,
        providerBinding: input.providerBinding
      });
      return result.kind === "committed" ? { kind: "cancelled" } : result.kind === "replay" ? { kind: "replay" } : { kind: "stale" };
    }
  };
}

export interface CodexSwarmChildController {
  start(input: { envelope: ExecutionEnvelope }): Promise<void>;
  cancel(input: Pick<DispatchReservation, "attemptId" | "leaseId" | "fencingEpoch">): Promise<void>;
}

export interface CanonicalAuditPort {
  append(event: { name: "execution.codex_swarm.dispatched" | "execution.codex_swarm.dispatch_denied" | "execution.codex_swarm.start_failed" | "execution.codex_swarm.cancelled" | "execution.codex_swarm.evidence_quarantined" | "execution.codex_swarm.evidence_verified"; workItemId: string; attemptId: string; reason?: string }): void;
}

export interface IndependentEvidenceVerifier {
  verify(input: { envelope: ExecutionEnvelope; evidence: SwarmExecutionEvidence }): Promise<{ ok: boolean; reason?: string }>;
}

/** Injected by the ACS attempt-secret provider; no unsigned default exists. */
export interface ExecutionEnvelopeVerifier {
  verify(value: unknown): VerifyExecutionEnvelopeResult;
}

export function assertCodexSwarmTestBackendEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === "production") throw new Error("codex_swarm backend is disabled in production");
  if (env.ACS_CODEX_SWARM_TEST_PROVIDER !== CODEX_SWARM_TEST_PROVIDER) {
    throw new Error("codex_swarm backend requires an injected in_memory test provider");
  }
}

export interface CodexSwarmCoordinator {
  readonly id: typeof CODEX_SWARM_ENGINE_ID;
  dispatch(value: unknown): Promise<{ kind: "started" | "replay" | "failed_start" } | { kind: "denied"; reason: string }>;
  cancel(input: CancellationRequest): Promise<{ kind: "cancelled" | "replay" | "denied"; reason?: string }>;
  ingestEvidence(value: unknown, envelope: unknown): Promise<{ status: "verified" | "quarantined"; reason?: string }>;
}

export interface CodexSwarmTestCoordinatorDependencies {
  authority: CodexSwarmAuthorityPort;
  reservations: DispatchReservationPort;
  child: CodexSwarmChildController;
  audit: CanonicalAuditPort;
  verifier: IndependentEvidenceVerifier;
  envelopeVerifier: ExecutionEnvelopeVerifier;
  cancellationAuthentication: CancellationAuthenticationVerifier;
  now?: () => Date;
}

/** The sole exported construction seam; this test-only boundary is guarded. */
export function createCodexSwarmTestCoordinator(
  dependencies: CodexSwarmTestCoordinatorDependencies,
  env: NodeJS.ProcessEnv = process.env
): CodexSwarmCoordinator {
  assertCodexSwarmTestBackendEnabled(env);
  return new TestOnlyCodexSwarmCoordinator(
    dependencies.authority,
    dependencies.reservations,
    dependencies.child,
    dependencies.audit,
    dependencies.verifier,
    dependencies.envelopeVerifier,
    dependencies.cancellationAuthentication,
    dependencies.now
  );
}

class TestOnlyCodexSwarmCoordinator implements CodexSwarmCoordinator {
  readonly id = CODEX_SWARM_ENGINE_ID;

  constructor(
    private readonly authority: CodexSwarmAuthorityPort,
    private readonly reservations: DispatchReservationPort,
    private readonly child: CodexSwarmChildController,
    private readonly audit: CanonicalAuditPort,
    private readonly verifier: IndependentEvidenceVerifier,
    private readonly envelopeVerifier: ExecutionEnvelopeVerifier,
    private readonly cancellationAuthentication: CancellationAuthenticationVerifier,
    private readonly now: () => Date = () => new Date()
  ) {}

  async dispatch(value: unknown): Promise<{ kind: "started" | "replay" | "failed_start" } | { kind: "denied"; reason: string }> {
    let verified: VerifyExecutionEnvelopeResult;
    try {
      verified = this.envelopeVerifier.verify(value);
    } catch {
      return this.denyDispatch("envelope_verification_failed");
    }
    if (!verified.ok) return this.denyDispatch(stableEnvelopeDenialReason(verified.reason));
    const envelope = verified.envelope;
    const binding = bindingFromEnvelope(envelope);
    const authorityDenial = this.currentAuthorityDenial(envelope);
    if (authorityDenial) return this.denyDispatch(authorityDenial, envelope);
    const tuple = { ...binding, envelopeHash: envelope.envelopeHash, idempotencyKey: envelope.idempotencyKey };
    let reservation: ReturnType<DispatchReservationPort["reserve"]>;
    try {
      reservation = this.reservations.reserve(tuple);
    } catch {
      return this.denyDispatch("codex_swarm_dispatch_reservation_failed", envelope);
    }
    if (reservation.kind === "conflict") return this.denyDispatch("codex_swarm_dispatch_idempotency_conflict", envelope);
    if (reservation.kind === "replay") return { kind: "replay" };
    try {
      await this.child.start({ envelope });
    } catch {
      const completion = this.completeStart(tuple, { kind: "failed_start", reason: "codex_swarm_child_start_failed" });
      if (!completion) return this.denyDispatch("codex_swarm_start_completion_failed", envelope);
      if (completion === "conflict") {
        return this.denyDispatch("codex_swarm_start_outcome_conflict", envelope);
      }
      this.audit.append({ name: "execution.codex_swarm.start_failed", workItemId: envelope.acsWorkItemId, attemptId: envelope.acsAttemptId, reason: "codex_swarm_child_start_failed" });
      return { kind: "failed_start" };
    }
    const completion = this.completeStart(tuple, { kind: "started" });
    if (!completion) return this.denyDispatch("codex_swarm_start_completion_failed", envelope);
    if (completion === "conflict") {
      return this.denyDispatch("codex_swarm_start_outcome_conflict", envelope);
    }
    this.audit.append({ name: "execution.codex_swarm.dispatched", workItemId: envelope.acsWorkItemId, attemptId: envelope.acsAttemptId });
    return { kind: "started" };
  }

  async cancel(input: CancellationRequest): Promise<{ kind: "cancelled" | "replay" | "denied"; reason?: string }> {
    if (!input.requestId) throw new Error("codex_swarm_cancel_unauthenticated");
    const authenticated = this.cancellationAuthentication.verify(input);
    if (!authenticated || !sameCancellationBinding(input, authenticated)) {
      throw new Error("codex_swarm_cancel_unauthenticated");
    }
    const cancellation = this.authority.cancel(authenticated);
    if (cancellation.kind === "stale") return { kind: "denied", reason: "codex_swarm_cancel_stale_authority" };
    if (cancellation.kind === "replay") return { kind: "replay" };
    try {
      await this.child.cancel(input);
    } catch {
      this.audit.append({ name: "execution.codex_swarm.cancelled", workItemId: input.workItemId, attemptId: input.attemptId, reason: "codex_swarm_child_cancel_failed" });
      return { kind: "cancelled", reason: "codex_swarm_child_cancel_failed" };
    }
    this.audit.append({ name: "execution.codex_swarm.cancelled", workItemId: input.workItemId, attemptId: input.attemptId });
    return { kind: "cancelled" };
  }

  async ingestEvidence(value: unknown, envelopeValue: unknown): Promise<{ status: "verified" | "quarantined"; reason?: string }> {
    const verifiedEnvelope = this.envelopeVerifier.verify(envelopeValue);
    if (!verifiedEnvelope.ok) return this.quarantineUnknown("evidence_envelope_verification_failed");
    const envelope = verifiedEnvelope.envelope;
    if (containsForbiddenLifecycleKey(value)) return this.quarantine(envelope, "evidence_forbidden_lifecycle_claim");
    const parsed = swarmExecutionEvidenceSchema.safeParse(value);
    if (!parsed.success) return this.quarantine(envelope, "evidence_schema_invalid");
    const echo = evidenceMatchesEnvelope(parsed.data, envelope);
    if (!echo.ok) return this.quarantine(envelope, echo.reason);
    if (this.currentAuthorityDenial(envelope)) return this.quarantine(envelope, "evidence_stale_authority");
    const now = this.now().getTime();
    const endedAt = Date.parse(parsed.data.endedAt);
    const startedAt = Date.parse(parsed.data.startedAt);
    if (
      !Number.isFinite(startedAt) ||
      !Number.isFinite(endedAt) ||
      endedAt < startedAt ||
      startedAt - now > evidenceMaxClockSkewMs ||
      endedAt - now > evidenceMaxClockSkewMs ||
      now - endedAt > evidenceFreshnessMs
    ) {
      return this.quarantine(envelope, "evidence_stale_or_chronology_invalid");
    }
    const result = await this.verifier.verify({ envelope, evidence: parsed.data });
    if (!result.ok) return this.quarantine(envelope, "independent_verification_failed");
    this.audit.append({ name: "execution.codex_swarm.evidence_verified", workItemId: envelope.acsWorkItemId, attemptId: envelope.acsAttemptId });
    return { status: "verified" };
  }

  private currentAuthorityDenial(envelope: ExecutionEnvelope): string | undefined {
    let authority: AttemptAuthority | undefined;
    try {
      authority = this.authority.read(bindingFromEnvelope(envelope));
    } catch {
      return "codex_swarm_authority_unavailable";
    }
    if (!authority || !authority.active || authority.revoked) return "codex_swarm_authority_inactive";
    if (
      authority.workspace.allocationId !== envelope.workspace.allocationId ||
      authority.workspace.hostPath !== envelope.workspace.hostPath ||
      authority.workspace.expectedBaseSha !== envelope.workspace.expectedBaseSha ||
      authority.admittedPlanHash !== envelope.admittedPlanHash
    ) {
      return "codex_swarm_authority_binding_mismatch";
    }
    return undefined;
  }

  private completeStart(
    tuple: DispatchReservation,
    result: { kind: "started" } | { kind: "failed_start"; reason: string }
  ): "completed" | "replay" | "conflict" | undefined {
    try {
      return this.reservations.completeStart(tuple, result).kind;
    } catch {
      return undefined;
    }
  }

  private quarantine(envelope: ExecutionEnvelope, reason: string): { status: "quarantined"; reason: string } {
    this.audit.append({ name: "execution.codex_swarm.evidence_quarantined", workItemId: envelope.acsWorkItemId, attemptId: envelope.acsAttemptId, reason });
    return { status: "quarantined", reason };
  }

  private quarantineUnknown(reason: string): { status: "quarantined"; reason: string } {
    this.audit.append({ name: "execution.codex_swarm.evidence_quarantined", workItemId: "unknown", attemptId: "unknown", reason });
    return { status: "quarantined", reason };
  }

  private denyDispatch(reason: string, envelope?: ExecutionEnvelope): { kind: "denied"; reason: string } {
    const stableReason = reason.split(":", 1)[0] || "envelope_verification_failed";
    this.audit.append({
      name: "execution.codex_swarm.dispatch_denied",
      workItemId: envelope?.acsWorkItemId ?? "unknown",
      attemptId: envelope?.acsAttemptId ?? "unknown",
      reason: stableReason
    });
    return { kind: "denied", reason: stableReason };
  }
}

function sameCancellationBinding(request: CancellationRequest, authenticated: AuthenticatedCancellationRequest): boolean {
  return (
    request.workItemId === authenticated.workItemId &&
    request.attemptId === authenticated.attemptId &&
    request.leaseId === authenticated.leaseId &&
    request.fencingEpoch === authenticated.fencingEpoch &&
    request.requestId === authenticated.requestId &&
    typeof authenticated.principalId === "string" &&
    authenticated.principalId.length > 0
  );
}

function bindingFromEnvelope(envelope: ExecutionEnvelope): Pick<DispatchReservation, "workItemId" | "attemptId" | "leaseId" | "fencingEpoch"> {
  return { workItemId: envelope.acsWorkItemId, attemptId: envelope.acsAttemptId, leaseId: envelope.leaseId, fencingEpoch: envelope.fencingEpoch };
}

function stableEnvelopeDenialReason(reason: string): string {
  const candidate = reason.split(":", 1)[0];
  return candidate && verifiedEnvelopeDenialReasons.has(candidate) ? candidate : "envelope_verification_failed";
}

function containsForbiddenLifecycleKey(value: unknown, seen = new Set<unknown>()): boolean {
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => containsForbiddenLifecycleKey(entry, seen));
  for (const [key, nested] of Object.entries(value)) {
    if (forbiddenLifecycleKeys.has(key)) return true;
    if (containsForbiddenLifecycleKey(nested, seen)) return true;
  }
  return false;
}
