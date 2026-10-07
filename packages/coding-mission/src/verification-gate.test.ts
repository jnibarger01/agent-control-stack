import { describe, expect, it } from "vitest";
import type {
  VerificationCriterion,
  VerificationEvidence,
  VerificationResult,
  Verifier
} from "@agent-control-stack/verification";
import { CodingMissionStore } from "./store.js";
import { WorkUnitVerificationGate } from "./verification-gate.js";
import { WorkUnitExecutionLedger, type ResultEnvelope } from "./worker-execution.js";
import type { VerificationPolicy } from "./mission-model.js";

const T0 = "2026-10-06T00:00:00.000Z";
const T1 = "2026-10-06T00:00:01.000Z";
const T2 = "2026-10-06T00:00:02.000Z";
const T3 = "2026-10-06T00:00:03.000Z";

const CRITERIA: VerificationCriterion[] = [
  { id: "c1", description: "result exists", expected: "a result hash is present" }
];
const EVIDENCE: VerificationEvidence = {
  workItemId: "u1",
  implementerClaim: "done",
  diffSummary: "a.ts changed",
  commandResults: []
};

function verifier(engineId: string, verdict: VerificationResult["verdict"]): Verifier {
  return {
    engineId,
    async verify(criteria) {
      return {
        verdict,
        summary: `${engineId} says ${verdict}`,
        criteriaResults: criteria.map((criterion) => ({
          criterionId: criterion.id,
          satisfied: verdict === "pass",
          observed: `observed ${verdict}`
        })),
        verifierEngineId: engineId,
        durationMs: 1
      };
    }
  };
}

/** A claimed unit whose successful execution is parked in `verifying`. */
function verifyingUnit(policy: VerificationPolicy) {
  const store = new CodingMissionStore(":memory:");
  store.createGeneral({ missionId: "m1", summary: "execute", now: T0 });
  store.addWorkUnits("m1", [{ unitId: "u1", kind: "coding", title: "unit", verificationPolicy: policy }], T0);
  store.releaseReadyUnits("m1", T0);
  const claim = { token: "claim-super-secret", workerId: "worker-1", route: { lane: "coder" as const }, claimedAt: T1 };
  expect(store.claimUnit("m1", "u1", claim)).toMatchObject({ ok: true, attempt: 1 });
  const ledger = new WorkUnitExecutionLedger(store);
  const dispatch = ledger.beginDispatch({
    missionId: "m1",
    unitId: "u1",
    claimToken: claim.token,
    workerId: claim.workerId,
    lane: "coder",
    now: T1
  });
  const result: ResultEnvelope = {
    schemaVersion: "acs.work-unit-result.v1",
    attemptId: dispatch.attemptId,
    missionId: "m1",
    unitId: "u1",
    unitAttempt: 1,
    workerId: "worker-1",
    lane: "coder",
    claimTokenHash: dispatch.claimTokenHash,
    outcome: "succeeded",
    startedAt: T1,
    finishedAt: T2,
    receipts: [{ kind: "tool_result", hash: "receipt-1" }],
    result: { resultHash: "result-1", files: ["a.ts"] },
    externalStateUncertain: false
  };
  expect(ledger.applyResult({ claimToken: claim.token, result })).toEqual({ applied: "awaiting_verification" });
  expect(store.workUnits("m1")[0]?.status).toBe("verifying");
  return { store, gate: new WorkUnitVerificationGate(store), claim, dispatch };
}

function gateInput(claimToken: string, verifiers: Verifier[]) {
  return {
    missionId: "m1",
    unitId: "u1",
    claimToken,
    implementerEngineId: "worker-1",
    verifiers,
    criteria: CRITERIA,
    evidence: EVIDENCE,
    now: T3
  };
}

describe("work-unit verification gate", () => {
  it("promotes a unit only on an independent pass, never on maker success alone", async () => {
    const { store, gate, claim } = verifyingUnit("independent");
    // The maker-facing completion path cannot complete a verifying unit.
    expect(() =>
      store.completeOperation("m1", "u1", claim.token, { resultHash: "result-1", files: ["a.ts"] }, T3)
    ).toThrow();
    expect(store.workUnits("m1")[0]?.status).toBe("verifying");

    await expect(gate.verifyUnit(gateInput(claim.token, [verifier("verifier-a", "pass")]))).resolves.toMatchObject({
      outcome: "succeeded",
      verdict: "pass"
    });
    expect(store.workUnits("m1")[0]).toMatchObject({ status: "succeeded", resultHash: "result-1" });
    expect(store.events("m1").map((event) => event.name)).toContain("verification.completed");
    expect(store.evidence("m1", "verification:u1:1")).toMatchObject({ outcome: "succeeded", verdict: "pass" });
  });

  it("turns an independent failure into a retryable verification_failure", async () => {
    const { store, gate, claim } = verifyingUnit("independent");
    await expect(gate.verifyUnit(gateInput(claim.token, [verifier("verifier-a", "fail")]))).resolves.toMatchObject({
      outcome: "retryable",
      verdict: "fail"
    });
    expect(store.workUnits("m1")[0]).toMatchObject({ status: "retryable", failureCategory: "verification_failure" });
  });

  it("makes a release-gate failure terminal instead of auto-retryable", async () => {
    const { store, gate, claim } = verifyingUnit("release_gate");
    await expect(gate.verifyUnit(gateInput(claim.token, [verifier("verifier-a", "fail")]))).resolves.toMatchObject({
      outcome: "failed",
      verdict: "fail"
    });
    expect(store.workUnits("m1")[0]).toMatchObject({ status: "failed", failureCategory: "verification_failure" });
  });

  it("holds inconclusive verdicts in verifying without succeeding or failing", async () => {
    const { store, gate, claim } = verifyingUnit("independent");
    await expect(
      gate.verifyUnit(gateInput(claim.token, [verifier("verifier-a", "inconclusive")]))
    ).resolves.toMatchObject({
      outcome: "inconclusive",
      verdict: "inconclusive"
    });
    expect(store.workUnits("m1")[0]?.status).toBe("verifying");
  });

  it("refuses to let the implementer verify its own work", async () => {
    const { store, gate, claim } = verifyingUnit("independent");
    await expect(gate.verifyUnit(gateInput(claim.token, [verifier("worker-1", "pass")]))).resolves.toMatchObject({
      outcome: "inconclusive",
      reason: "verifier_identity_collision"
    });
    expect(store.workUnits("m1")[0]?.status).toBe("verifying");
  });

  it("requires two distinct verifiers for multi_verifier and requires every one to pass", async () => {
    const one = verifyingUnit("multi_verifier");
    await expect(
      one.gate.verifyUnit(gateInput(one.claim.token, [verifier("verifier-a", "pass")]))
    ).resolves.toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient_verifiers"
    });
    expect(one.store.workUnits("m1")[0]?.status).toBe("verifying");

    const dup = verifyingUnit("multi_verifier");
    await expect(
      dup.gate.verifyUnit(gateInput(dup.claim.token, [verifier("verifier-a", "pass"), verifier("verifier-a", "pass")]))
    ).resolves.toMatchObject({ outcome: "inconclusive", reason: "duplicate_verifier" });

    const split = verifyingUnit("multi_verifier");
    await expect(
      split.gate.verifyUnit(
        gateInput(split.claim.token, [verifier("verifier-a", "pass"), verifier("verifier-b", "fail")])
      )
    ).resolves.toMatchObject({ outcome: "retryable", verdict: "fail" });

    const both = verifyingUnit("multi_verifier");
    await expect(
      both.gate.verifyUnit(
        gateInput(both.claim.token, [verifier("verifier-a", "pass"), verifier("verifier-b", "pass")])
      )
    ).resolves.toMatchObject({ outcome: "succeeded", verdict: "pass" });
    expect(both.store.workUnits("m1")[0]?.status).toBe("succeeded");
  });

  it("rejects a verdict presented under a stale claim without changing the unit", async () => {
    const { store, gate } = verifyingUnit("independent");
    await expect(
      gate.verifyUnit(gateInput("someone-elses-token", [verifier("verifier-a", "pass")]))
    ).resolves.toMatchObject({
      outcome: "not_verifying"
    });
    expect(store.workUnits("m1")[0]?.status).toBe("verifying");
  });

  it("does not promote a unit cancelled while verification was running", async () => {
    const { store, gate, claim } = verifyingUnit("independent");
    const cancelling: Verifier = {
      engineId: "verifier-a",
      async verify(criteria) {
        store.cancelMission("m1", { reason: "operator_stop", now: T3 });
        return verifier("verifier-a", "pass").verify(criteria, EVIDENCE);
      }
    };
    await expect(gate.verifyUnit(gateInput(claim.token, [cancelling]))).resolves.toMatchObject({
      outcome: "not_verifying"
    });
    expect(store.workUnits("m1")[0]?.status).toBe("cancelled");
  });

  it("binds evidence to the unit being verified", async () => {
    const { gate, claim } = verifyingUnit("independent");
    await expect(
      gate.verifyUnit({
        ...gateInput(claim.token, [verifier("verifier-a", "pass")]),
        evidence: { ...EVIDENCE, workItemId: "u2" }
      })
    ).rejects.toThrow();
  });

  it("is a no-op for units whose policy is none", async () => {
    const store = new CodingMissionStore(":memory:");
    store.createGeneral({ missionId: "m1", summary: "execute", now: T0 });
    store.addWorkUnits("m1", [{ unitId: "u1", kind: "coding", title: "unit", verificationPolicy: "none" }], T0);
    const gate = new WorkUnitVerificationGate(store);
    await expect(
      gate.verifyUnit({
        missionId: "m1",
        unitId: "u1",
        claimToken: "unused",
        implementerEngineId: "worker-1",
        verifiers: [verifier("verifier-a", "pass")],
        criteria: CRITERIA,
        evidence: EVIDENCE,
        now: T3
      })
    ).resolves.toMatchObject({ outcome: "policy_none" });
  });
});
