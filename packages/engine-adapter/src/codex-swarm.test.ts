import { describe, expect, it, vi } from "vitest";
import { buildExecutionEnvelope, verifyExecutionEnvelope, type SwarmExecutionEvidence } from "./codex-swarm-envelope.js";
import { assertCodexSwarmTestBackendEnabled, createCodexSwarmStoreAuthorityPort, createCodexSwarmStoreReservationPort, createCodexSwarmTestCoordinator, type AttemptAuthority, type CancellationRequest, type DispatchReservation } from "./codex-swarm.js";

const secret = "s".repeat(48);
const now = new Date("2026-09-03T00:00:20.000Z");

function envelope() {
  return buildExecutionEnvelope(
    {
      acsWorkItemId: "wrk_1", acsAttemptId: "attempt_1", planId: "plan_1", admittedPlanHash: "a".repeat(64), leaseId: "lease_1", fencingEpoch: 1,
      auditCorrelationId: "audit_1", idempotencyKey: "idem_1", workspace: { allocationId: "alloc_1", hostPath: "/isolated/attempt_1", expectedBaseSha: "0".repeat(40) },
      objective: "bounded test", permittedPaths: ["src/**"], forbiddenPaths: [".git/**"], permittedOwnerProfiles: ["codex"], maxLanes: 1,
      maxLoopIterations: 0, networkPolicy: "none", timeoutMs: 1000, acceptanceCommands: [], validationCommands: [], evidenceRequirements: ["diff"],
      issuedAt: "2026-09-03T00:00:00.000Z", expiresAt: "2026-09-03T00:00:30.000Z"
    },
    secret
  );
}

function evidence(e = envelope()): SwarmExecutionEvidence {
  return {
    schemaVersion: "acs.codex-swarm-evidence.v1", acsWorkItemId: e.acsWorkItemId, acsAttemptId: e.acsAttemptId, envelopeHash: e.envelopeHash,
    leaseId: e.leaseId, fencingEpoch: e.fencingEpoch, auditCorrelationId: e.auditCorrelationId, exitStatus: "completed",
    startedAt: "2026-09-03T00:00:01.000Z", endedAt: "2026-09-03T00:00:10.000Z", laneResults: [], integration: null, aggregateVerdict: "PASS",
    swarmInternalRecommendationIdentity: null, loopIterationsRun: 0, loopStopReason: null,
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

function harness(mode: "reserved" | "replay" | "conflict" = "reserved", start = vi.fn(async () => undefined), cancel = vi.fn(async () => undefined)) {
  const authority: AttemptAuthority = {
    workItemId: "wrk_1", attemptId: "attempt_1", leaseId: "lease_1", fencingEpoch: 1, active: true, revoked: false,
    workspace: { allocationId: "alloc_1", hostPath: "/isolated/attempt_1", expectedBaseSha: "0".repeat(40) }, admittedPlanHash: "a".repeat(64)
  };
  const starts = start;
  const cancels = cancel;
  const audit = vi.fn();
  const atomicCancel = vi.fn((): { kind: "cancelled" | "replay" | "stale" } => ({ kind: "cancelled" }));
  const completeStart = vi.fn(() => ({ kind: "completed" as const }));
  const coordinator = createCodexSwarmTestCoordinator(
    {
      authority: { read: vi.fn(() => authority), cancel: atomicCancel },
      reservations: { reserve: vi.fn((_tuple: DispatchReservation) => ({ kind: mode })), completeStart },
      child: { start: starts, cancel: cancels }, audit: { append: audit },
      verifier: { verify: vi.fn(async () => ({ ok: true })) },
      envelopeVerifier: { verify: (value) => verifyExecutionEnvelope(value, secret, { now: () => now }) },
      cancellationAuthentication: { verify: authenticatedCancellation }, now: () => now
    },
    { ACS_CODEX_SWARM_TEST_PROVIDER: "in_memory" }
  );
  return { coordinator, authority, starts, cancels, audit, atomicCancel, completeStart };
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
      requestId: "request-1", workItemId: "wrk_1", attemptId: "attempt_1", leaseId: "lease_1", fencingEpoch: 1,
      principalId: "actor-user", canonicalIntentHash: "b".repeat(64),
      providerBinding: { contextHash: "c".repeat(64), proofBindingHash: "d".repeat(64), providerGeneration: 1, sessionEpochBindingHash: "e".repeat(64) }
    };

    expect(authority.cancel(authenticated)).toEqual({ kind: "cancelled" });
    expect(cancelCodexSwarmAttempt).toHaveBeenCalledWith({
      requestId: authenticated.requestId, workItemId: authenticated.workItemId, attemptId: authenticated.attemptId,
      leaseId: authenticated.leaseId, fencingEpoch: authenticated.fencingEpoch,
      authenticatedPrincipalId: authenticated.principalId, canonicalIntentHash: authenticated.canonicalIntentHash,
      providerBinding: authenticated.providerBinding
    });
  });

  it("uses the canonical durable store for both reservation and persisted start outcome", () => {
    const reserveCodexSwarmDispatch = vi.fn(() => ({ kind: "reserved" as const }));
    const completeCodexSwarmDispatchStart = vi.fn(() => ({ kind: "completed" as const }));
    const port = createCodexSwarmStoreReservationPort({ reserveCodexSwarmDispatch, completeCodexSwarmDispatchStart });
    const tuple: DispatchReservation = { workItemId: "wrk_1", attemptId: "attempt_1", leaseId: "lease_1", fencingEpoch: 1, envelopeHash: "a".repeat(64), idempotencyKey: "idem_1" };

    expect(port.reserve(tuple)).toEqual({ kind: "reserved" });
    port.completeStart(tuple, { kind: "failed_start", reason: "untrusted child error" });
    expect(completeCodexSwarmDispatchStart).toHaveBeenCalledWith(tuple, { kind: "failed_start", reason: "untrusted child error" });
  });

  it("never enables the backend without its injected test provider or in production", () => {
    expect(() => assertCodexSwarmTestBackendEnabled({})).toThrow(/injected/);
    expect(() => assertCodexSwarmTestBackendEnabled({ NODE_ENV: "production", ACS_CODEX_SWARM_TEST_PROVIDER: "in_memory" })).toThrow(/production/);
    expect(() => assertCodexSwarmTestBackendEnabled({ ACS_CODEX_SWARM_TEST_PROVIDER: "in_memory" })).not.toThrow();
  });

  it("permits construction only through the guarded test-only factory", () => {
    const h = harness();
    expect(() => createCodexSwarmTestCoordinator({
      authority: { read: () => h.authority, cancel: () => ({ kind: "cancelled" }) }, reservations: { reserve: () => ({ kind: "reserved" }), completeStart: () => ({ kind: "completed" as const }) },
      child: { start: async () => undefined, cancel: async () => undefined }, audit: { append: () => undefined }, verifier: { verify: async () => ({ ok: true }) },
      envelopeVerifier: { verify: (value) => verifyExecutionEnvelope(value, secret, { now: () => now }) },
      cancellationAuthentication: { verify: authenticatedCancellation }
    }, { NODE_ENV: "production", ACS_CODEX_SWARM_TEST_PROVIDER: "in_memory" })).toThrow(/disabled in production/);
  });

  it("starts only an atomically reserved, current attempt and exact replay does not start again", async () => {
    const first = harness();
    await expect(first.coordinator.dispatch(envelope())).resolves.toEqual({ kind: "started" });
    expect(first.starts).toHaveBeenCalledTimes(1);
    expect(first.completeStart).toHaveBeenCalledWith(expect.anything(), { kind: "started" });
    const replay = harness("replay");
    await expect(replay.coordinator.dispatch(envelope())).resolves.toEqual({ kind: "replay" });
    expect(replay.starts).not.toHaveBeenCalled();
    const conflict = harness("conflict");
    await expect(conflict.coordinator.dispatch(envelope())).resolves.toEqual({ kind: "denied", reason: "codex_swarm_dispatch_idempotency_conflict" });
    expect(conflict.starts).not.toHaveBeenCalled();
  });

  it("denies a malformed runtime envelope before reservation or child start and audits only a stable redacted reason", async () => {
    const h = harness();
    await expect(h.coordinator.dispatch({ acsWorkItemId: "wrk_1", acsAttemptId: "attempt_1" } as never)).resolves.toEqual({
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
    await expect(h.coordinator.dispatch(envelope())).resolves.toEqual({ kind: "denied", reason: "codex_swarm_authority_inactive" });
    const denied = createCodexSwarmTestCoordinator({
      authority: { read: () => h.authority, cancel: h.atomicCancel }, reservations: { reserve: () => ({ kind: "reserved" }), completeStart: () => ({ kind: "completed" as const }) },
      child: { start: h.starts, cancel: h.cancels }, audit: { append: h.audit }, verifier: { verify: async () => ({ ok: true }) },
      envelopeVerifier: { verify: (value) => verifyExecutionEnvelope(value, secret, { now: () => now }) },
      cancellationAuthentication: { verify: () => undefined }
    }, { ACS_CODEX_SWARM_TEST_PROVIDER: "in_memory" });
    await expect(denied.cancel({ workItemId: "wrk_1", attemptId: "attempt_1", leaseId: "lease_1", fencingEpoch: 1, requestId: "r_1" })).rejects.toThrow("unauthenticated");
    expect(h.atomicCancel).not.toHaveBeenCalled();
    expect(h.cancels).not.toHaveBeenCalled();
  });

  it("quarantines nested lifecycle claims and missing independent verification without accepting evidence", async () => {
    const h = harness();
    const nested = { ...evidence(), evidenceBundle: { ...evidence().evidenceBundle, nested: { accepted: true } } };
    await expect(h.coordinator.ingestEvidence(nested, envelope())).resolves.toEqual({ status: "quarantined", reason: "evidence_forbidden_lifecycle_claim" });
    const verifierFail = createCodexSwarmTestCoordinator({
      authority: { read: () => h.authority, cancel: () => ({ kind: "cancelled" }) },
      reservations: { reserve: () => ({ kind: "reserved" }), completeStart: () => ({ kind: "completed" as const }) },
      child: { start: vi.fn(), cancel: vi.fn() }, audit: { append: vi.fn() },
      verifier: { verify: async () => ({ ok: false, reason: "verifier_missing" }) },
      envelopeVerifier: { verify: (value) => verifyExecutionEnvelope(value, secret, { now: () => now }) },
      cancellationAuthentication: { verify: authenticatedCancellation }, now: () => now
    }, { ACS_CODEX_SWARM_TEST_PROVIDER: "in_memory" });
    await expect(verifierFail.ingestEvidence(evidence(), envelope())).resolves.toEqual({ status: "quarantined", reason: "independent_verification_failed" });
  });

  it("denies hostile verifier output with a stable code before reservation or child start", async () => {
    const h = harness();
    const hostile = "SECRET_TOKEN=top-secret\n\u0000😈".repeat(20_000);
    const reserve = vi.fn(() => ({ kind: "reserved" as const }));
    const verifierFail = createCodexSwarmTestCoordinator({
      authority: { read: () => h.authority, cancel: () => ({ kind: "cancelled" }) },
      reservations: { reserve, completeStart: () => ({ kind: "completed" as const }) },
      child: { start: h.starts, cancel: h.cancels }, audit: { append: h.audit },
      verifier: { verify: async () => ({ ok: false, reason: hostile }) },
      envelopeVerifier: { verify: () => ({ ok: false, reason: hostile }) },
      cancellationAuthentication: { verify: authenticatedCancellation }, now: () => now
    }, { ACS_CODEX_SWARM_TEST_PROVIDER: "in_memory" });

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
    expect(JSON.stringify({ result: await verifierFail.dispatch(envelope()), audit: h.audit.mock.calls })).not.toContain("SECRET_TOKEN");
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("😈");
  });

  it("denies authority exceptions with a stable code before reservation or child start", async () => {
    const h = harness();
    const hostile = "SECRET_AUTHORITY=top-secret\r\n\u0000雪".repeat(20_000);
    const reserve = vi.fn(() => ({ kind: "reserved" as const }));
    const coordinator = createCodexSwarmTestCoordinator({
      authority: { read: () => { throw new Error(hostile); }, cancel: () => ({ kind: "cancelled" }) },
      reservations: { reserve, completeStart: h.completeStart },
      child: { start: h.starts, cancel: h.cancels }, audit: { append: h.audit },
      verifier: { verify: async () => ({ ok: true }) },
      envelopeVerifier: { verify: (value) => verifyExecutionEnvelope(value, secret, { now: () => now }) },
      cancellationAuthentication: { verify: authenticatedCancellation }, now: () => now
    }, { ACS_CODEX_SWARM_TEST_PROVIDER: "in_memory" });

    await expect(coordinator.dispatch(envelope())).resolves.toEqual({ kind: "denied", reason: "codex_swarm_authority_unavailable" });
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
    const reserve = vi.fn(() => { throw new Error(hostile); });
    const coordinator = createCodexSwarmTestCoordinator({
      authority: { read: () => h.authority, cancel: () => ({ kind: "cancelled" }) },
      reservations: { reserve, completeStart: h.completeStart },
      child: { start: h.starts, cancel: h.cancels }, audit: { append: h.audit },
      verifier: { verify: async () => ({ ok: true }) },
      envelopeVerifier: { verify: (value) => verifyExecutionEnvelope(value, secret, { now: () => now }) },
      cancellationAuthentication: { verify: authenticatedCancellation }, now: () => now
    }, { ACS_CODEX_SWARM_TEST_PROVIDER: "in_memory" });

    await expect(coordinator.dispatch(envelope())).resolves.toEqual({ kind: "denied", reason: "codex_swarm_dispatch_reservation_failed" });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ reason: "codex_swarm_dispatch_reservation_failed" }));
    expect(h.completeStart).not.toHaveBeenCalled();
    expect(h.starts).not.toHaveBeenCalled();
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("SECRET_RESERVATION");
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("ß");
  });

  it("persists failed starts and makes cancellation atomic, replay-safe, and auditable", async () => {
    const startFailure = harness("reserved", vi.fn(async () => { throw new Error("start failed"); }));
    await expect(startFailure.coordinator.dispatch(envelope())).resolves.toEqual({ kind: "failed_start" });
    expect(startFailure.completeStart).toHaveBeenCalledWith(expect.anything(), { kind: "failed_start", reason: "codex_swarm_child_start_failed" });
    expect(startFailure.audit).toHaveBeenCalledWith(expect.objectContaining({ name: "execution.codex_swarm.start_failed" }));

    const h = harness();
    const request = { workItemId: "wrk_1", attemptId: "attempt_1", leaseId: "lease_1", fencingEpoch: 1, requestId: "r_1" };
    await expect(h.coordinator.cancel(request)).resolves.toEqual({ kind: "cancelled" });
    expect(h.atomicCancel).toHaveBeenCalledTimes(1);
    h.atomicCancel.mockReturnValue({ kind: "replay" });
    await expect(h.coordinator.cancel(request)).resolves.toEqual({ kind: "replay" });
    expect(h.cancels).toHaveBeenCalledTimes(1);

    const cancelFailure = harness("reserved", vi.fn(async () => undefined), vi.fn(async () => { throw new Error("cancel failed"); }));
    await expect(cancelFailure.coordinator.cancel({ ...request, requestId: "r_2" })).resolves.toEqual({ kind: "cancelled", reason: "codex_swarm_child_cancel_failed" });
    expect(cancelFailure.audit).toHaveBeenCalledWith(expect.objectContaining({ name: "execution.codex_swarm.cancelled", reason: "codex_swarm_child_cancel_failed" }));
  });

  it("quarantines future evidence and forged evidence envelopes before verification", async () => {
    const h = harness();
    await expect(h.coordinator.ingestEvidence({ ...evidence(), startedAt: "2026-09-03T00:00:26.000Z", endedAt: "2026-09-03T00:00:27.000Z" }, envelope())).resolves.toEqual({ status: "quarantined", reason: "evidence_stale_or_chronology_invalid" });
    await expect(h.coordinator.ingestEvidence(evidence(), { ...envelope(), mac: "0".repeat(64) })).resolves.toEqual({ status: "quarantined", reason: "evidence_envelope_verification_failed" });
  });
});
