import { describe, expect, it, vi } from "vitest";
import { buildExecutionEnvelope, type SwarmExecutionEvidence } from "./codex-swarm-envelope.js";
import { assertCodexSwarmTestBackendEnabled, CodexSwarmCoordinator, type AttemptAuthority, type DispatchReservation } from "./codex-swarm.js";

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

function harness(mode: "reserved" | "replay" | "conflict" = "reserved") {
  const authority: AttemptAuthority = {
    workItemId: "wrk_1", attemptId: "attempt_1", leaseId: "lease_1", fencingEpoch: 1, active: true, revoked: false,
    workspace: { allocationId: "alloc_1", hostPath: "/isolated/attempt_1", expectedBaseSha: "0".repeat(40) }, admittedPlanHash: "a".repeat(64)
  };
  const starts = vi.fn(async () => undefined);
  const cancels = vi.fn(async () => undefined);
  const audit = vi.fn();
  const coordinator = new CodexSwarmCoordinator(
    { read: vi.fn(() => authority), cancel: vi.fn() },
    { reserve: vi.fn((_tuple: DispatchReservation) => ({ kind: mode })) },
    { start: starts, cancel: cancels },
    { append: audit },
    { verify: vi.fn(async () => ({ ok: true })) },
    () => now
  );
  return { coordinator, authority, starts, cancels, audit };
}

describe("CodexSwarmCoordinator", () => {
  it("never enables the backend without its injected test provider or in production", () => {
    expect(() => assertCodexSwarmTestBackendEnabled({})).toThrow(/injected/);
    expect(() => assertCodexSwarmTestBackendEnabled({ NODE_ENV: "production", ACS_CODEX_SWARM_TEST_PROVIDER: "in_memory" })).toThrow(/production/);
    expect(() => assertCodexSwarmTestBackendEnabled({ ACS_CODEX_SWARM_TEST_PROVIDER: "in_memory" })).not.toThrow();
  });

  it("starts only an atomically reserved, current attempt and exact replay does not start again", async () => {
    const first = harness();
    await expect(first.coordinator.dispatch(envelope())).resolves.toEqual({ kind: "started" });
    expect(first.starts).toHaveBeenCalledTimes(1);
    const replay = harness("replay");
    await expect(replay.coordinator.dispatch(envelope())).resolves.toEqual({ kind: "replay" });
    expect(replay.starts).not.toHaveBeenCalled();
    const conflict = harness("conflict");
    await expect(conflict.coordinator.dispatch(envelope())).rejects.toThrow("idempotency_conflict");
    expect(conflict.starts).not.toHaveBeenCalled();
  });

  it("rejects stale authority and unauthenticated cancellation before touching the child", async () => {
    const h = harness();
    h.authority.revoked = true;
    await expect(h.coordinator.dispatch(envelope())).rejects.toThrow("authority_inactive");
    await expect(h.coordinator.cancel({ workItemId: "wrk_1", attemptId: "attempt_1", leaseId: "lease_1", fencingEpoch: 1, requestId: "r_1", authenticated: false })).rejects.toThrow("unauthenticated");
    expect(h.cancels).not.toHaveBeenCalled();
  });

  it("quarantines nested lifecycle claims and missing independent verification without accepting evidence", async () => {
    const h = harness();
    const nested = { ...evidence(), evidenceBundle: { ...evidence().evidenceBundle, nested: { accepted: true } } };
    await expect(h.coordinator.ingestEvidence(nested, envelope())).resolves.toEqual({ status: "quarantined", reason: "evidence_forbidden_lifecycle_claim" });
    const verifierFail = new CodexSwarmCoordinator(
      { read: () => h.authority, cancel: vi.fn() }, { reserve: () => ({ kind: "reserved" }) }, { start: vi.fn(), cancel: vi.fn() }, { append: vi.fn() },
      { verify: async () => ({ ok: false, reason: "verifier_missing" }) }, () => now
    );
    await expect(verifierFail.ingestEvidence(evidence(), envelope())).resolves.toEqual({ status: "quarantined", reason: "verifier_missing" });
  });
});
