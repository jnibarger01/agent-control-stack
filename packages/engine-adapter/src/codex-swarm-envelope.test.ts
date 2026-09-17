import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  buildExecutionEnvelope,
  evidenceMatchesEnvelope,
  executionEnvelopeHash,
  verifyExecutionEnvelope,
  type BuildExecutionEnvelopeInput,
  type SwarmExecutionEvidence
} from "./codex-swarm-envelope.js";

const fixture = createRequire(import.meta.url)("./__fixtures__/codex-swarm-envelope.fixture.json") as {
  secret: string;
  body: Record<string, unknown>;
  envelopeHash: string;
  mac: string;
};

const SECRET = "x".repeat(48);

function bodyInput(overrides: Partial<BuildExecutionEnvelopeInput> = {}): BuildExecutionEnvelopeInput {
  return {
    acsWorkItemId: "wrk_1",
    acsAttemptId: "attempt_1",
    planId: "plan_1",
    admittedPlanHash: "a".repeat(64),
    leaseId: "lease_1",
    fencingEpoch: 3,
    auditCorrelationId: "evt_started_1",
    idempotencyKey: "idem_1",
    workspace: {
      allocationId: "ws_1",
      hostPath: "/srv/acs/workspaces/attempt_1",
      expectedBaseSha: "0".repeat(40)
    },
    objective: "add a bounded feature behind lanes",
    permittedPaths: ["src/**", "test/**"],
    forbiddenPaths: [".github/**", "infra/**"],
    permittedOwnerProfiles: ["codex", "claude"],
    maxLanes: 4,
    maxLoopIterations: 2,
    networkPolicy: "none",
    timeoutMs: 20 * 60 * 1_000,
    acceptanceCommands: [["npm", "test"]],
    validationCommands: [["npm", "run", "lint"]],
    evidenceRequirements: ["diff", "tests"],
    issuedAt: "2026-09-03T00:00:00.000Z",
    expiresAt: "2026-09-03T00:30:00.000Z",
    ...overrides
  };
}

function evidenceFor(envelope: ReturnType<typeof buildExecutionEnvelope>): SwarmExecutionEvidence {
  return {
    schemaVersion: "acs.codex-swarm-evidence.v1",
    acsAttemptId: envelope.acsAttemptId,
    envelopeHash: envelope.envelopeHash,
    leaseId: envelope.leaseId,
    fencingEpoch: envelope.fencingEpoch,
    exitStatus: "completed",
    startedAt: "2026-09-03T00:01:00.000Z",
    endedAt: "2026-09-03T00:09:00.000Z",
    laneResults: [],
    integration: null,
    aggregateVerdict: "PASS",
    swarmInternalRecommendationIdentity: "sha256:abc",
    loopIterationsRun: 1,
    loopStopReason: null,
    evidenceBundle: {
      auditEventCount: 12,
      auditLogHash: "b".repeat(64),
      diffHash: "c".repeat(64)
    }
  };
}

describe("buildExecutionEnvelope / verifyExecutionEnvelope", () => {
  it("round-trips a well-formed envelope", () => {
    const envelope = buildExecutionEnvelope(bodyInput(), SECRET);
    const result = verifyExecutionEnvelope(envelope, SECRET, {
      now: () => new Date("2026-09-03T00:10:00.000Z"),
      expectedAttemptId: "attempt_1"
    });
    expect(result).toEqual({ ok: true, envelope });
  });

  it("is stable under input key ordering", () => {
    const a = buildExecutionEnvelope(bodyInput(), SECRET);
    const reordered: BuildExecutionEnvelopeInput = {
      ...bodyInput(),
      // rebuild the object with keys in a different declaration order
      expiresAt: "2026-09-03T00:30:00.000Z",
      acsWorkItemId: "wrk_1"
    };
    const b = buildExecutionEnvelope(reordered, SECRET);
    expect(b.envelopeHash).toBe(a.envelopeHash);
    expect(b.mac).toBe(a.mac);
  });

  it("rejects a tampered envelopeHash", () => {
    const envelope = { ...buildExecutionEnvelope(bodyInput(), SECRET), envelopeHash: "d".repeat(64) };
    expect(verifyExecutionEnvelope(envelope, SECRET)).toEqual({ ok: false, reason: "envelope_hash_mismatch" });
  });

  it("rejects a tampered body field (hash no longer matches)", () => {
    const envelope = { ...buildExecutionEnvelope(bodyInput(), SECRET), maxLanes: 64 };
    expect(verifyExecutionEnvelope(envelope, SECRET)).toEqual({ ok: false, reason: "envelope_hash_mismatch" });
  });

  it("rejects a wrong MAC secret", () => {
    const envelope = buildExecutionEnvelope(bodyInput(), SECRET);
    expect(verifyExecutionEnvelope(envelope, "y".repeat(48))).toEqual({ ok: false, reason: "envelope_mac_mismatch" });
  });

  it("rejects a tampered MAC", () => {
    const envelope = { ...buildExecutionEnvelope(bodyInput(), SECRET), mac: "e".repeat(64) };
    expect(verifyExecutionEnvelope(envelope, SECRET)).toEqual({ ok: false, reason: "envelope_mac_mismatch" });
  });

  it("rejects an expired envelope", () => {
    const envelope = buildExecutionEnvelope(bodyInput(), SECRET);
    expect(
      verifyExecutionEnvelope(envelope, SECRET, { now: () => new Date("2026-09-03T01:00:00.000Z") })
    ).toEqual({ ok: false, reason: "envelope_expired" });
  });

  it("rejects an attempt-id mismatch when an expectation is supplied", () => {
    const envelope = buildExecutionEnvelope(bodyInput(), SECRET);
    expect(
      verifyExecutionEnvelope(envelope, SECRET, {
        now: () => new Date("2026-09-03T00:10:00.000Z"),
        expectedAttemptId: "attempt_other"
      })
    ).toEqual({ ok: false, reason: "envelope_attempt_mismatch" });
  });

  it("rejects a structurally invalid document", () => {
    const result = verifyExecutionEnvelope({ schemaVersion: "acs.codex-swarm-envelope.v1" }, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.startsWith("envelope_schema_invalid")).toBe(true);
  });

  it("rejects an unknown extra field (strict)", () => {
    const envelope = { ...buildExecutionEnvelope(bodyInput(), SECRET), sneaky: true };
    const result = verifyExecutionEnvelope(envelope, SECRET);
    expect(result.ok).toBe(false);
  });

  it("refuses to build or verify with an under-length secret", () => {
    expect(() => buildExecutionEnvelope(bodyInput(), "short")).toThrow(/at least 32/);
    const envelope = buildExecutionEnvelope(bodyInput(), SECRET);
    const result = verifyExecutionEnvelope(envelope, "short");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.startsWith("envelope_mac_secret_invalid")).toBe(true);
  });

  it("rejects expiresAt <= issuedAt at build time", () => {
    expect(() =>
      buildExecutionEnvelope(
        bodyInput({ issuedAt: "2026-09-03T00:30:00.000Z", expiresAt: "2026-09-03T00:30:00.000Z" }),
        SECRET
      )
    ).toThrow();
  });

  it("rejects a scoped-egress policy that is not a hash", () => {
    expect(() => buildExecutionEnvelope(bodyInput({ networkPolicy: "scoped-egress:api.openai.com" }), SECRET)).toThrow();
    const ok = buildExecutionEnvelope(bodyInput({ networkPolicy: `scoped-egress:${"f".repeat(64)}` }), SECRET);
    expect(verifyExecutionEnvelope(ok, SECRET, { now: () => new Date("2026-09-03T00:10:00.000Z") }).ok).toBe(true);
  });
});

describe("cross-repo fixture parity", () => {
  // If this breaks, the wire format changed. Regenerate
  // packages/engine-adapter/src/__fixtures__/codex-swarm-envelope.fixture.json
  // AND copy it to codex-swarm/test/acs/fixtures/ so both parsers stay in sync.
  it("reproduces the shared envelopeHash and mac", () => {
    const { schemaVersion: _ignored, ...body } = fixture.body;
    const rebuilt = buildExecutionEnvelope(body as unknown as BuildExecutionEnvelopeInput, fixture.secret);
    expect(rebuilt.envelopeHash).toBe(fixture.envelopeHash);
    expect(rebuilt.mac).toBe(fixture.mac);
  });

  it("verifies the shared fixture envelope", () => {
    const result = verifyExecutionEnvelope(fixture.body ? { ...fixture.body, envelopeHash: fixture.envelopeHash, mac: fixture.mac } : null, fixture.secret, {
      now: () => new Date("2026-09-03T00:10:00.000Z")
    });
    expect(result.ok).toBe(true);
  });
});

describe("executionEnvelopeHash", () => {
  it("changes when any bound field changes", () => {
    const base = executionEnvelopeHash({ schemaVersion: "acs.codex-swarm-envelope.v1", ...bodyInput() });
    const changed = executionEnvelopeHash({
      schemaVersion: "acs.codex-swarm-envelope.v1",
      ...bodyInput({ objective: "something else" })
    });
    expect(changed).not.toBe(base);
  });
});

describe("evidenceMatchesEnvelope", () => {
  const envelope = buildExecutionEnvelope(bodyInput(), SECRET);

  it("accepts evidence that echoes the envelope", () => {
    expect(evidenceMatchesEnvelope(evidenceFor(envelope), envelope)).toEqual({ ok: true });
  });

  it("rejects an attempt-id mismatch", () => {
    expect(evidenceMatchesEnvelope({ ...evidenceFor(envelope), acsAttemptId: "attempt_x" }, envelope)).toEqual({
      ok: false,
      reason: "evidence_attempt_mismatch"
    });
  });

  it("rejects an envelope-hash mismatch", () => {
    expect(evidenceMatchesEnvelope({ ...evidenceFor(envelope), envelopeHash: "0".repeat(64) }, envelope)).toEqual({
      ok: false,
      reason: "evidence_envelope_hash_mismatch"
    });
  });

  it("rejects a lease mismatch", () => {
    expect(evidenceMatchesEnvelope({ ...evidenceFor(envelope), leaseId: "lease_x" }, envelope)).toEqual({
      ok: false,
      reason: "evidence_lease_mismatch"
    });
  });

  it("rejects a fencing-epoch mismatch", () => {
    expect(evidenceMatchesEnvelope({ ...evidenceFor(envelope), fencingEpoch: 99 }, envelope)).toEqual({
      ok: false,
      reason: "evidence_fencing_mismatch"
    });
  });
});
