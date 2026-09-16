import { describe, expect, it, vi } from "vitest";
import {
  buildExecutionEnvelope,
  verifyExecutionEnvelope,
  type SwarmExecutionEvidence
} from "./codex-swarm-envelope.js";
import {
  assertCodexSwarmTestBackendEnabled,
  createCodexSwarmStoreAuthorityPort,
  createCodexSwarmStoreReservationPort,
  createCodexSwarmTestCoordinator,
  type AttemptAuthority,
  type CancellationRequest,
  type DispatchReservation
} from "./codex-swarm.js";

const secret = "s".repeat(48);
const now = new Date("2026-09-03T00:00:20.000Z");

function envelope() {
  return buildExecutionEnvelope(
    {
      acsWorkItemId: "wrk_1",
      acsAttemptId: "attempt_1",
      planId: "plan_1",
      admittedPlanHash: "a".repeat(64),
      leaseId: "lease_1",
      fencingEpoch: 1,
      auditCorrelationId: "audit_1",
      idempotencyKey: "idem_1",
      workspace: { allocationId: "alloc_1", hostPath: "/isolated/attempt_1", expectedBaseSha: "0".repeat(40) },
      objective: "bounded test",
      permittedPaths: ["src/**"],
      forbiddenPaths: [".git/**"],
      permittedOwnerProfiles: ["codex"],
      maxLanes: 1,
      maxLoopIterations: 0,
      networkPolicy: "none",
      timeoutMs: 1000,
      acceptanceCommands: [],
      validationCommands: [],
      evidenceRequirements: ["diff"],
      issuedAt: "2026-09-03T00:00:00.000Z",
      expiresAt: "2026-09-03T00:00:30.000Z"
    },
    secret
  );
}

function evidence(e = envelope()): SwarmExecutionEvidence {
  return {
    schemaVersion: "acs.codex-swarm-evidence.v1",
    acsWorkItemId: e.acsWorkItemId,
    acsAttemptId: e.acsAttemptId,
    envelopeHash: e.envelopeHash,
    leaseId: e.leaseId,
    fencingEpoch: e.fencingEpoch,
    auditCorrelationId: e.auditCorrelationId,
    exitStatus: "completed",
    startedAt: "2026-09-03T00:00:01.000Z",
    endedAt: "2026-09-03T00:00:10.000Z",
    laneResults: [],
    integration: null,
    aggregateVerdict: "PASS",
    swarmInternalRecommendationIdentity: null,
    loopIterationsRun: 0,
    loopStopReason: null,
    evidenceBundle: { auditEventCount: 1, auditLogHash: "b".repeat(64), diffHash: "c".repeat(64) }
  };
}

function authenticatedCancellation(input: CancellationRequest) {
  return {
    ...input,
    principalId: "actor-user",
    canonicalIntentHash: "f".repeat(64),
    providerBinding: {
      contextHash: "1".repeat(64),
      proofBindingHash: "2".repeat(64),
      providerGeneration: 1,
      sessionEpochBindingHash: "3".repeat(64)
    }
  };
}

function harness(
  mode: "reserved" | "replay" | "conflict" = "reserved",
  start = vi.fn(async () => undefined),
  cancel = vi.fn(async () => undefined)
) {
  const authority: AttemptAuthority = {
    workItemId: "wrk_1",
    attemptId: "attempt_1",
    leaseId: "lease_1",
    fencingEpoch: 1,
    active: true,
    revoked: false,
    workspace: { allocationId: "alloc_1", hostPath: "/isolated/attempt_1", expectedBaseSha: "0".repeat(40) },
    admittedPlanHash: "a".repeat(64)
  };
  const starts = start;
  const cancels = cancel;
  const audit = vi.fn();
  const atomicCancel = vi.fn((): { kind: "cancelled" | "replay" | "stale" } => ({ kind: "cancelled" }));
  const reserve = vi.fn((_tuple: DispatchReservation) => ({ kind: mode }));
  const completeStart = vi.fn(() => ({ kind: "completed" as const }));
  const coordinator = createCodexSwarmTestCoordinator(
    {
      authority: { read: vi.fn(() => authority), cancel: atomicCancel },
      reservations: { reserve, completeStart },
      child: { start: starts, cancel: cancels },
      audit: { append: audit },
      verifier: { verify: vi.fn(async () => ({ ok: true })) },
      envelopeVerifier: { verify: (value) => verifyExecutionEnvelope(value, secret, { now: () => now }) },
      cancellationAuthentication: { verify: authenticatedCancellation },
      now: () => now
    },
    { ACS_CODEX_SWARM_TEST_PROVIDER: "in_memory" }
  );
  return { coordinator, authority, starts, cancels, audit, atomicCancel, reserve, completeStart };
}

describe("CodexSwarmCoordinator", () => {
  it("forwards only verifier-produced cancellation facts to the durable ACS authority", () => {
    const cancelCodexSwarmAttempt = vi.fn(() => ({
      kind: "committed" as const,
      cancellationId: "cancellation-1",
      serializedOutcome: '{"status":"accepted"}',
      outcomeHash: "a".repeat(64),
      replay: false as const
    }));
    const authority = createCodexSwarmStoreAuthorityPort({ cancelCodexSwarmAttempt });
    const authenticated = {
      requestId: "request-1",
      workItemId: "wrk_1",
      attemptId: "attempt_1",
      leaseId: "lease_1",
      fencingEpoch: 1,
      principalId: "actor-user",
      canonicalIntentHash: "b".repeat(64),
      providerBinding: {
        contextHash: "c".repeat(64),
        proofBindingHash: "d".repeat(64),
        providerGeneration: 1,
        sessionEpochBindingHash: "e".repeat(64)
      }
    };

    expect(authority.cancel(authenticated)).toEqual({ kind: "cancelled" });
    expect(cancelCodexSwarmAttempt).toHaveBeenCalledWith({
      requestId: authenticated.requestId,
      workItemId: authenticated.workItemId,
      attemptId: authenticated.attemptId,
      leaseId: authenticated.leaseId,
      fencingEpoch: authenticated.fencingEpoch,
      authenticatedPrincipalId: authenticated.principalId,
      canonicalIntentHash: authenticated.canonicalIntentHash,
      providerBinding: authenticated.providerBinding
    });
  });

  it("uses the canonical durable store for both reservation and persisted start outcome", () => {
    const reserveCodexSwarmDispatch = vi.fn(() => ({ kind: "reserved" as const }));
    const completeCodexSwarmDispatchStart = vi.fn(() => ({ kind: "completed" as const }));
    const port = createCodexSwarmStoreReservationPort({ reserveCodexSwarmDispatch, completeCodexSwarmDispatchStart });
    const tuple: DispatchReservation = {
      workItemId: "wrk_1",
      attemptId: "attempt_1",
      leaseId: "lease_1",
      fencingEpoch: 1,
      envelopeHash: "a".repeat(64),
      idempotencyKey: "idem_1"
    };

    expect(port.reserve(tuple)).toEqual({ kind: "reserved" });
    port.completeStart(tuple, { kind: "failed_start", reason: "untrusted child error" });
    expect(completeCodexSwarmDispatchStart).toHaveBeenCalledWith(tuple, {
      kind: "failed_start",
      reason: "untrusted child error"
    });
  });

  it("never enables the backend without its injected test provider or in production", () => {
    expect(() => assertCodexSwarmTestBackendEnabled({})).toThrow(/injected/);
    expect(() =>
      assertCodexSwarmTestBackendEnabled({ NODE_ENV: "production", ACS_CODEX_SWARM_TEST_PROVIDER: "in_memory" })
    ).toThrow(/production/);
    expect(() => assertCodexSwarmTestBackendEnabled({ ACS_CODEX_SWARM_TEST_PROVIDER: "in_memory" })).not.toThrow();
  });

  it("permits construction only through the guarded test-only factory", () => {
    const h = harness();
    expect(() =>
      createCodexSwarmTestCoordinator(
        {
          authority: { read: () => h.authority, cancel: () => ({ kind: "cancelled" }) },
          reservations: {
            reserve: () => ({ kind: "reserved" }),
            completeStart: () => ({ kind: "completed" as const })
          },
          child: { start: async () => undefined, cancel: async () => undefined },
          audit: { append: () => undefined },
          verifier: { verify: async () => ({ ok: true }) },
          envelopeVerifier: { verify: (value) => verifyExecutionEnvelope(value, secret, { now: () => now }) },
          cancellationAuthentication: { verify: authenticatedCancellation }
        },
        { NODE_ENV: "production", ACS_CODEX_SWARM_TEST_PROVIDER: "in_memory" }
      )
    ).toThrow(/disabled in production/);
  });

  it("starts only an atomically reserved, current attempt and exact replay does not start again", async () => {
    const first = harness();
    await expect(first.coordinator.dispatch(envelope())).resolves.toEqual({ kind: "started" });
    expect(first.starts).toHaveBeenCalledTimes(1);
    expect(first.completeStart).toHaveBeenCalledWith(expect.anything(), { kind: "started" });
    // Durable lifecycle events are appended atomically by the store, not this adapter callback.
    const replay = harness("replay");
    await expect(replay.coordinator.dispatch(envelope())).resolves.toEqual({ kind: "replay" });
    expect(replay.starts).not.toHaveBeenCalled();
    const conflict = harness("conflict");
    await expect(conflict.coordinator.dispatch(envelope())).resolves.toEqual({
      kind: "denied",
      reason: "codex_swarm_dispatch_idempotency_conflict"
    });
    expect(conflict.starts).not.toHaveBeenCalled();
  });

  it("denies a malformed runtime envelope before reservation or child start and audits only a stable redacted reason", async () => {
    const h = harness();
    await expect(
      h.coordinator.dispatch({ acsWorkItemId: "wrk_1", acsAttemptId: "attempt_1" } as never)
    ).resolves.toEqual({
      kind: "denied",
      reason: "envelope_schema_invalid"
    });
    expect(h.starts).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith({
      name: "execution.codex_swarm.dispatch_denied",
      workItemId: "unknown",
      attemptId: "unknown",
      reason: "envelope_schema_invalid"
    });
  });

  it("rejects stale authority and an unauthenticated cancellation before touching the child", async () => {
    const h = harness();
    h.authority.revoked = true;
    await expect(h.coordinator.dispatch(envelope())).resolves.toEqual({
      kind: "denied",
      reason: "codex_swarm_authority_inactive"
    });
    const denied = createCodexSwarmTestCoordinator(
      {
        authority: { read: () => h.authority, cancel: h.atomicCancel },
        reservations: { reserve: () => ({ kind: "reserved" }), completeStart: () => ({ kind: "completed" as const }) },
        child: { start: h.starts, cancel: h.cancels },
        audit: { append: h.audit },
        verifier: { verify: async () => ({ ok: true }) },
        envelopeVerifier: { verify: (value) => verifyExecutionEnvelope(value, secret, { now: () => now }) },
        cancellationAuthentication: { verify: () => undefined }
      },
      { ACS_CODEX_SWARM_TEST_PROVIDER: "in_memory" }
    );
    await expect(
      denied.cancel({
        workItemId: "wrk_1",
        attemptId: "attempt_1",
        leaseId: "lease_1",
        fencingEpoch: 1,
        requestId: "r_1"
      })
    ).resolves.toEqual({ kind: "denied", reason: "codex_swarm_cancel_unauthenticated" });
    expect(h.atomicCancel).not.toHaveBeenCalled();
    expect(h.cancels).not.toHaveBeenCalled();
  });

  it("quarantines nested lifecycle claims and missing independent verification without accepting evidence", async () => {
    const h = harness();
    const nested = { ...evidence(), evidenceBundle: { ...evidence().evidenceBundle, nested: { accepted: true } } };
    await expect(h.coordinator.ingestEvidence(nested, envelope())).resolves.toEqual({
      status: "quarantined",
      reason: "evidence_forbidden_lifecycle_claim"
    });
    const verifierFail = createCodexSwarmTestCoordinator(
      {
        authority: { read: () => h.authority, cancel: () => ({ kind: "cancelled" }) },
        reservations: { reserve: () => ({ kind: "reserved" }), completeStart: () => ({ kind: "completed" as const }) },
        child: { start: vi.fn(), cancel: vi.fn() },
        audit: { append: vi.fn() },
        verifier: { verify: async () => ({ ok: false, reason: "verifier_missing" }) },
        envelopeVerifier: { verify: (value) => verifyExecutionEnvelope(value, secret, { now: () => now }) },
        cancellationAuthentication: { verify: authenticatedCancellation },
        now: () => now
      },
      { ACS_CODEX_SWARM_TEST_PROVIDER: "in_memory" }
    );
    await expect(verifierFail.ingestEvidence(evidence(), envelope())).resolves.toEqual({
      status: "quarantined",
      reason: "independent_verification_failed"
    });
  });

  it("denies hostile verifier output with a stable code before reservation or child start", async () => {
    const h = harness();
    const hostile = "SECRET_TOKEN=top-secret\n\u0000😈".repeat(20_000);
    const reserve = vi.fn(() => ({ kind: "reserved" as const }));
    const verifierFail = createCodexSwarmTestCoordinator(
      {
        authority: { read: () => h.authority, cancel: () => ({ kind: "cancelled" }) },
        reservations: { reserve, completeStart: () => ({ kind: "completed" as const }) },
        child: { start: h.starts, cancel: h.cancels },
        audit: { append: h.audit },
        verifier: { verify: async () => ({ ok: false, reason: hostile }) },
        envelopeVerifier: { verify: () => ({ ok: false, reason: hostile }) },
        cancellationAuthentication: { verify: authenticatedCancellation },
        now: () => now
      },
      { ACS_CODEX_SWARM_TEST_PROVIDER: "in_memory" }
    );

    await expect(verifierFail.dispatch(envelope())).resolves.toEqual({
      kind: "denied",
      reason: "envelope_verification_failed"
    });
    expect(h.audit).toHaveBeenCalledWith({
      name: "execution.codex_swarm.dispatch_denied",
      workItemId: "unknown",
      attemptId: "unknown",
      reason: "envelope_verification_failed"
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(h.starts).not.toHaveBeenCalled();
    expect(
      JSON.stringify({ result: await verifierFail.dispatch(envelope()), audit: h.audit.mock.calls })
    ).not.toContain("SECRET_TOKEN");
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("😈");
  });

  it("denies authority exceptions with a stable code before reservation or child start", async () => {
    const h = harness();
    const hostile = "SECRET_AUTHORITY=top-secret\r\n\u0000雪".repeat(20_000);
    const reserve = vi.fn(() => ({ kind: "reserved" as const }));
    const coordinator = createCodexSwarmTestCoordinator(
      {
        authority: {
          read: () => {
            throw new Error(hostile);
          },
          cancel: () => ({ kind: "cancelled" })
        },
        reservations: { reserve, completeStart: h.completeStart },
        child: { start: h.starts, cancel: h.cancels },
        audit: { append: h.audit },
        verifier: { verify: async () => ({ ok: true }) },
        envelopeVerifier: { verify: (value) => verifyExecutionEnvelope(value, secret, { now: () => now }) },
        cancellationAuthentication: { verify: authenticatedCancellation },
        now: () => now
      },
      { ACS_CODEX_SWARM_TEST_PROVIDER: "in_memory" }
    );

    await expect(coordinator.dispatch(envelope())).resolves.toEqual({
      kind: "denied",
      reason: "codex_swarm_authority_unavailable"
    });
    expect(h.audit).toHaveBeenCalledWith({
      name: "execution.codex_swarm.dispatch_denied",
      workItemId: "wrk_1",
      attemptId: "attempt_1",
      reason: "codex_swarm_authority_unavailable"
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(h.completeStart).not.toHaveBeenCalled();
    expect(h.starts).not.toHaveBeenCalled();
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("SECRET_AUTHORITY");
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("雪");
  });

  it("denies reservation exceptions with a stable code before child start", async () => {
    const h = harness();
    const hostile = "SECRET_RESERVATION=top-secret\r\n\u0000ß".repeat(20_000);
    const reserve = vi.fn(() => {
      throw new Error(hostile);
    });
    const coordinator = createCodexSwarmTestCoordinator(
      {
        authority: { read: () => h.authority, cancel: () => ({ kind: "cancelled" }) },
        reservations: { reserve, completeStart: h.completeStart },
        child: { start: h.starts, cancel: h.cancels },
        audit: { append: h.audit },
        verifier: { verify: async () => ({ ok: true }) },
        envelopeVerifier: { verify: (value) => verifyExecutionEnvelope(value, secret, { now: () => now }) },
        cancellationAuthentication: { verify: authenticatedCancellation },
        now: () => now
      },
      { ACS_CODEX_SWARM_TEST_PROVIDER: "in_memory" }
    );

    await expect(coordinator.dispatch(envelope())).resolves.toEqual({
      kind: "denied",
      reason: "codex_swarm_dispatch_reservation_failed"
    });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "codex_swarm_dispatch_reservation_failed" })
    );
    expect(h.completeStart).not.toHaveBeenCalled();
    expect(h.starts).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalledWith(expect.objectContaining({ name: "execution.codex_swarm.dispatched" }));
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("SECRET_RESERVATION");
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("ß");
  });

  it("converts hostile cancellation and evidence exceptions into stable fail-closed outcomes", async () => {
    const hostile = "SECRET_DEPENDENCY=top-secret\r\n\u0000雪😈".repeat(20_000);
    const request = {
      workItemId: "wrk_1",
      attemptId: "attempt_1",
      leaseId: "lease_1",
      fencingEpoch: 1,
      requestId: "r_hostile"
    };
    const authentication = harness();
    const authenticationFailure = createCodexSwarmTestCoordinator(
      {
        authority: { read: () => authentication.authority, cancel: authentication.atomicCancel },
        reservations: { reserve: () => ({ kind: "reserved" }), completeStart: authentication.completeStart },
        child: { start: authentication.starts, cancel: authentication.cancels },
        audit: { append: authentication.audit },
        verifier: { verify: async () => ({ ok: true }) },
        envelopeVerifier: { verify: (value) => verifyExecutionEnvelope(value, secret, { now: () => now }) },
        cancellationAuthentication: {
          verify: () => {
            throw new Error(hostile);
          }
        },
        now: () => now
      },
      { ACS_CODEX_SWARM_TEST_PROVIDER: "in_memory" }
    );
    await expect(authenticationFailure.cancel(request)).resolves.toEqual({
      kind: "denied",
      reason: "codex_swarm_cancellation_authentication_failed"
    });
    expect(authentication.atomicCancel).not.toHaveBeenCalled();
    expect(authentication.cancels).not.toHaveBeenCalled();
    expect(authentication.audit).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "execution.codex_swarm.cancelled" })
    );

    const cancellation = harness();
    const cancellationFailure = createCodexSwarmTestCoordinator(
      {
        authority: {
          read: () => cancellation.authority,
          cancel: () => {
            throw new Error(hostile);
          }
        },
        reservations: { reserve: () => ({ kind: "reserved" }), completeStart: cancellation.completeStart },
        child: { start: cancellation.starts, cancel: cancellation.cancels },
        audit: { append: cancellation.audit },
        verifier: { verify: async () => ({ ok: true }) },
        envelopeVerifier: { verify: (value) => verifyExecutionEnvelope(value, secret, { now: () => now }) },
        cancellationAuthentication: { verify: authenticatedCancellation },
        now: () => now
      },
      { ACS_CODEX_SWARM_TEST_PROVIDER: "in_memory" }
    );
    await expect(cancellationFailure.cancel(request)).resolves.toEqual({
      kind: "denied",
      reason: "codex_swarm_cancel_authority_unavailable"
    });
    expect(cancellation.cancels).not.toHaveBeenCalled();
    expect(cancellation.audit).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "execution.codex_swarm.cancelled" })
    );

    const envelopeFailure = harness();
    const envelopeEvidenceFailure = createCodexSwarmTestCoordinator(
      {
        authority: { read: () => envelopeFailure.authority, cancel: envelopeFailure.atomicCancel },
        reservations: { reserve: () => ({ kind: "reserved" }), completeStart: envelopeFailure.completeStart },
        child: { start: envelopeFailure.starts, cancel: envelopeFailure.cancels },
        audit: { append: envelopeFailure.audit },
        verifier: { verify: async () => ({ ok: true }) },
        envelopeVerifier: {
          verify: () => {
            throw new Error(hostile);
          }
        },
        cancellationAuthentication: { verify: authenticatedCancellation },
        now: () => now
      },
      { ACS_CODEX_SWARM_TEST_PROVIDER: "in_memory" }
    );
    await expect(envelopeEvidenceFailure.ingestEvidence(evidence(), envelope())).resolves.toEqual({
      status: "quarantined",
      reason: "evidence_envelope_verification_failed"
    });

    const independent = harness();
    const independentFailure = createCodexSwarmTestCoordinator(
      {
        authority: { read: () => independent.authority, cancel: independent.atomicCancel },
        reservations: { reserve: () => ({ kind: "reserved" }), completeStart: independent.completeStart },
        child: { start: independent.starts, cancel: independent.cancels },
        audit: { append: independent.audit },
        verifier: {
          verify: async () => {
            throw new Error(hostile);
          }
        },
        envelopeVerifier: { verify: (value) => verifyExecutionEnvelope(value, secret, { now: () => now }) },
        cancellationAuthentication: { verify: authenticatedCancellation },
        now: () => now
      },
      { ACS_CODEX_SWARM_TEST_PROVIDER: "in_memory" }
    );
    await expect(independentFailure.ingestEvidence(evidence(), envelope())).resolves.toEqual({
      status: "quarantined",
      reason: "independent_verification_failed"
    });
    const persisted = JSON.stringify({
      authentication: authentication.audit.mock.calls,
      cancellation: cancellation.audit.mock.calls,
      envelope: envelopeFailure.audit.mock.calls,
      independent: independent.audit.mock.calls
    });
    expect(persisted).not.toContain("SECRET_DEPENDENCY");
    expect(persisted).not.toContain("雪");
    expect(persisted).not.toContain("😈");
  });

  it("fails closed on throwing getters and null dependency results without leaking them", async () => {
    const hostile = "SECRET_GETTER=top-secret\r\n\u0000雪😈".repeat(20_000);
    const throwing = (property: string) =>
      Object.defineProperty({}, property, {
        get: () => {
          throw new Error(hostile);
        }
      });
    const request = {
      workItemId: "wrk_1",
      attemptId: "attempt_1",
      leaseId: "lease_1",
      fencingEpoch: 1,
      requestId: "r_getter"
    };
    const h = harness();
    const make = (overrides: Partial<Parameters<typeof createCodexSwarmTestCoordinator>[0]>) =>
      createCodexSwarmTestCoordinator(
        {
          authority: { read: () => h.authority, cancel: h.atomicCancel },
          reservations: { reserve: h.reserve, completeStart: h.completeStart },
          child: { start: h.starts, cancel: h.cancels },
          audit: { append: h.audit },
          verifier: { verify: async () => ({ ok: true }) },
          envelopeVerifier: { verify: (value) => verifyExecutionEnvelope(value, secret, { now: () => now }) },
          cancellationAuthentication: { verify: authenticatedCancellation },
          now: () => now,
          ...overrides
        },
        { ACS_CODEX_SWARM_TEST_PROVIDER: "in_memory" }
      );

    await expect(
      make({ envelopeVerifier: { verify: () => throwing("ok") as never } }).dispatch(envelope())
    ).resolves.toEqual({ kind: "denied", reason: "envelope_verification_failed" });
    await expect(
      make({
        authority: {
          read: () =>
            Object.defineProperty({ ...h.authority }, "active", {
              get: () => {
                throw new Error(hostile);
              }
            }),
          cancel: h.atomicCancel
        }
      }).dispatch(envelope())
    ).resolves.toEqual({ kind: "denied", reason: "codex_swarm_authority_unavailable" });
    await expect(
      make({ reservations: { reserve: () => throwing("kind") as never, completeStart: h.completeStart } }).dispatch(
        envelope()
      )
    ).resolves.toEqual({ kind: "denied", reason: "codex_swarm_dispatch_reservation_failed" });
    await expect(
      make({ cancellationAuthentication: { verify: () => throwing("workItemId") as never } }).cancel(request)
    ).resolves.toEqual({ kind: "denied", reason: "codex_swarm_cancellation_authentication_failed" });
    await expect(
      make({ verifier: { verify: async () => throwing("ok") as never } }).ingestEvidence(evidence(), envelope())
    ).resolves.toEqual({ status: "quarantined", reason: "independent_verification_failed" });
    await expect(make({ envelopeVerifier: { verify: () => null as never } }).dispatch(envelope())).resolves.toEqual({
      kind: "denied",
      reason: "envelope_verification_failed"
    });
    await expect(
      make({ authority: { read: () => null as never, cancel: h.atomicCancel } }).dispatch(envelope())
    ).resolves.toEqual({ kind: "denied", reason: "codex_swarm_authority_inactive" });
    await expect(
      make({ reservations: { reserve: () => null as never, completeStart: h.completeStart } }).dispatch(envelope())
    ).resolves.toEqual({ kind: "denied", reason: "codex_swarm_dispatch_reservation_failed" });
    await expect(
      make({ cancellationAuthentication: { verify: () => null as never } }).cancel(request)
    ).resolves.toEqual({ kind: "denied", reason: "codex_swarm_cancel_unauthenticated" });
    await expect(
      make({ verifier: { verify: async () => null as never } }).ingestEvidence(evidence(), envelope())
    ).resolves.toEqual({ status: "quarantined", reason: "independent_verification_failed" });
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.starts).not.toHaveBeenCalled();
    expect(h.atomicCancel).not.toHaveBeenCalled();
    expect(h.cancels).not.toHaveBeenCalled();
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("SECRET_GETTER");
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("雪");
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("😈");
  });

  it("does not use the adapter audit port for durable lifecycle transitions", async () => {
    const hostile = "SECRET_AUDIT=top-secret\r\n\u0000雪😈".repeat(20_000);
    const h = harness();
    const reserve = vi.fn(() => ({ kind: "reserved" as const }));
    const coordinator = createCodexSwarmTestCoordinator(
      {
        authority: { read: () => h.authority, cancel: h.atomicCancel },
        reservations: { reserve, completeStart: h.completeStart },
        child: { start: h.starts, cancel: h.cancels },
        audit: {
          append: () => {
            throw new Error(hostile);
          }
        },
        verifier: { verify: async () => ({ ok: true }) },
        envelopeVerifier: { verify: (value) => verifyExecutionEnvelope(value, secret, { now: () => now }) },
        cancellationAuthentication: { verify: authenticatedCancellation },
        now: () => now
      },
      { ACS_CODEX_SWARM_TEST_PROVIDER: "in_memory" }
    );
    const request = {
      workItemId: "wrk_1",
      attemptId: "attempt_1",
      leaseId: "lease_1",
      fencingEpoch: 1,
      requestId: "r_audit"
    };
    await expect(coordinator.dispatch(envelope())).resolves.toEqual({ kind: "started" });
    await expect(coordinator.cancel(request)).resolves.toEqual({ kind: "cancelled" });
    await expect(coordinator.ingestEvidence(evidence(), envelope())).resolves.toEqual({
      status: "quarantined",
      reason: "codex_swarm_audit_unavailable"
    });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(h.completeStart).toHaveBeenCalledTimes(1);
    expect(h.starts).toHaveBeenCalledTimes(1);
    expect(h.atomicCancel).toHaveBeenCalledTimes(1);
    expect(h.cancels).toHaveBeenCalledTimes(1);
  });

  it("persists failed starts and makes cancellation atomic, replay-safe, and auditable", async () => {
    const startFailure = harness(
      "reserved",
      vi.fn(async () => {
        throw new Error("start failed");
      })
    );
    await expect(startFailure.coordinator.dispatch(envelope())).resolves.toEqual({ kind: "failed_start" });
    expect(startFailure.completeStart).toHaveBeenCalledWith(expect.anything(), {
      kind: "failed_start",
      reason: "codex_swarm_child_start_failed"
    });

    const h = harness();
    const request = {
      workItemId: "wrk_1",
      attemptId: "attempt_1",
      leaseId: "lease_1",
      fencingEpoch: 1,
      requestId: "r_1"
    };
    await expect(h.coordinator.cancel(request)).resolves.toEqual({ kind: "cancelled" });
    expect(h.atomicCancel).toHaveBeenCalledTimes(1);

    h.atomicCancel.mockReturnValue({ kind: "replay" });
    await expect(h.coordinator.cancel(request)).resolves.toEqual({ kind: "replay" });
    expect(h.cancels).toHaveBeenCalledTimes(1);

    const cancelFailure = harness(
      "reserved",
      vi.fn(async () => undefined),
      vi.fn(async () => {
        throw new Error("cancel failed");
      })
    );
    await expect(cancelFailure.coordinator.cancel({ ...request, requestId: "r_2" })).resolves.toEqual({
      kind: "cancelled",
      reason: "codex_swarm_child_cancel_failed"
    });
  });

  it("does not emit a cancellation success audit for stale authority", async () => {
    const h = harness();
    h.atomicCancel.mockReturnValue({ kind: "stale" });
    await expect(
      h.coordinator.cancel({
        workItemId: "wrk_1",
        attemptId: "attempt_1",
        leaseId: "lease_1",
        fencingEpoch: 1,
        requestId: "r_stale"
      })
    ).resolves.toEqual({
      kind: "denied",
      reason: "codex_swarm_cancel_stale_authority"
    });
    expect(h.cancels).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalledWith(expect.objectContaining({ name: "execution.codex_swarm.cancelled" }));
  });

  it("quarantines future evidence and forged evidence envelopes before verification", async () => {
    const h = harness();
    await expect(
      h.coordinator.ingestEvidence(
        { ...evidence(), startedAt: "2026-09-03T00:00:26.000Z", endedAt: "2026-09-03T00:00:27.000Z" },
        envelope()
      )
    ).resolves.toEqual({ status: "quarantined", reason: "evidence_stale_or_chronology_invalid" });
    await expect(h.coordinator.ingestEvidence(evidence(), { ...envelope(), mac: "0".repeat(64) })).resolves.toEqual({
      status: "quarantined",
      reason: "evidence_envelope_verification_failed"
    });
  });
});
