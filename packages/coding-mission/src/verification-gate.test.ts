import { describe, expect, it } from "vitest";
import type {
  VerificationCriterion,
  VerificationResult,
  VerificationUsageReservation,
  Verifier
} from "@agent-control-stack/verification";
import type { MissionBudget } from "./budget.js";
import type { VerificationPolicy } from "./mission-model.js";
import { CodingMissionStore } from "./store.js";
import { WorkUnitVerificationGate, type BoundVerificationEvidence } from "./verification-gate.js";
import { WorkUnitExecutionLedger, type ResultEnvelope } from "./worker-execution.js";

const T0 = "2026-10-06T00:00:00.000Z";
const T1 = "2026-10-06T00:00:01.000Z";
const T2 = "2026-10-06T00:00:02.000Z";
const T3 = "2026-10-06T00:00:03.000Z";
const T4 = "2026-10-06T00:00:04.000Z";
const T5 = "2026-10-06T00:00:05.000Z";

const CRITERIA: VerificationCriterion[] = [
  { id: "c1", description: "result exists", expected: "a result hash is present" }
];

interface VerifierOptions {
  throws?: boolean;
  summary?: string;
  observed?: string;
  usage?: VerificationResult["usage"];
  usageReservation?: VerificationUsageReservation;
  onVerify?: () => void;
}

function verifier(engineId: string, verdict: VerificationResult["verdict"], options: VerifierOptions = {}): Verifier {
  return {
    engineId,
    ...(options.usageReservation ? { usageReservation: options.usageReservation } : {}),
    async verify(criteria) {
      options.onVerify?.();
      if (options.throws) throw new Error("verifier exploded");
      return {
        verdict,
        summary: options.summary ?? `${engineId} says ${verdict}`,
        criteriaResults: criteria.map((criterion) => ({
          criterionId: criterion.id,
          satisfied: verdict === "pass",
          observed: options.observed ?? `observed ${verdict}`
        })),
        verifierEngineId: engineId,
        durationMs: 1,
        ...(options.usage ? { usage: options.usage } : {})
      };
    }
  };
}

function verifyingUnit(
  policy: VerificationPolicy,
  options: {
    budget?: MissionBudget;
    criteria?: VerificationCriterion[];
    setRequirement?: boolean;
    clock?: () => string;
  } = {}
) {
  const store = new CodingMissionStore(":memory:");
  store.createGeneral({
    missionId: "m1",
    summary: "execute",
    now: T0,
    ...(options.budget ? { budget: options.budget } : {})
  });
  store.addWorkUnits("m1", [{ unitId: "u1", kind: "coding", title: "unit", verificationPolicy: policy }], T0);
  if (policy !== "none" && options.setRequirement !== false) {
    store.setVerificationRequirement("m1", "u1", options.criteria ?? CRITERIA, T0);
  }
  store.releaseReadyUnits("m1", T0);
  const claim = {
    token: "claim-super-secret",
    workerId: "worker-1",
    route: { lane: "coder" as const },
    claimedAt: T1
  };
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
  expect(ledger.applyResult({ claimToken: claim.token, result })).toEqual({
    applied: policy === "none" ? "completed" : "awaiting_verification"
  });
  const attempt = ledger.attempt(dispatch.attemptId);
  const evidence: BoundVerificationEvidence = {
    workItemId: "u1",
    executionAttemptId: dispatch.attemptId,
    unitAttempt: 1,
    resultHash: "result-1",
    reportHash: attempt?.reportHash ?? "",
    implementerClaim: "done",
    diffSummary: "a.ts changed",
    commandResults: []
  };
  return {
    store,
    ledger,
    gate: new WorkUnitVerificationGate(store, options.clock),
    claim,
    dispatch,
    evidence
  };
}

function gateInput(claimToken: string, evidence: BoundVerificationEvidence, verifiers: readonly Verifier[]) {
  return {
    missionId: "m1",
    unitId: "u1",
    claimToken,
    verifiers,
    evidence
  };
}

describe("work-unit verification gate", () => {
  it("promotes only an attempt-bound independent pass", async () => {
    const { store, gate, claim, evidence, dispatch } = verifyingUnit("independent");

    expect(() =>
      store.completeOperation("m1", "u1", claim.token, { resultHash: "result-1", files: ["a.ts"] }, T3)
    ).toThrow();
    expect((store as unknown as Record<string, unknown>).succeedVerifiedUnit).toBeUndefined();

    await expect(
      gate.verifyUnit(gateInput(claim.token, evidence, [verifier("verifier-a", "pass")]))
    ).resolves.toMatchObject({ outcome: "succeeded", verdict: "pass" });

    expect(store.workUnits("m1")[0]).toMatchObject({ status: "succeeded", resultHash: "result-1" });
    const row = store.db
      .prepare(
        "SELECT execution_attempt_id, result_hash, criteria_hash, implementer_worker_id, outcome FROM work_unit_verification_decisions"
      )
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({
      execution_attempt_id: dispatch.attemptId,
      result_hash: "result-1",
      implementer_worker_id: "worker-1",
      outcome: "succeeded"
    });
    expect(row.criteria_hash).toBe(store.verificationRequirement("m1", "u1")?.criteriaHash);
  });

  it("derives producer identity from the durable execution attempt", async () => {
    const { store, gate, claim, evidence } = verifyingUnit("independent");
    await expect(
      gate.verifyUnit(gateInput(claim.token, evidence, [verifier("worker-1", "pass")]))
    ).resolves.toMatchObject({
      outcome: "inconclusive",
      reason: "verifier_identity_collision"
    });
    expect(store.workUnits("m1")[0]?.status).toBe("verifying");
  });

  it.each([
    ["executionAttemptId", "wua_wrong"],
    ["unitAttempt", 2],
    ["resultHash", "wrong-result"],
    ["reportHash", "wrong-report"]
  ] as const)("rejects evidence with a stale %s binding", async (field, value) => {
    const { store, gate, claim, evidence } = verifyingUnit("independent");
    await expect(
      gate.verifyUnit(gateInput(claim.token, { ...evidence, [field]: value }, [verifier("verifier-a", "pass")]))
    ).rejects.toThrow(/durable execution attempt/);
    expect(store.workUnits("m1")[0]?.status).toBe("verifying");
  });

  it("uses the immutable admitted rubric instead of caller-selected criteria", async () => {
    const setup = verifyingUnit("independent");
    expect(() =>
      setup.store.setVerificationRequirement("m1", "u1", [{ id: "easy", description: "trivial", expected: "yes" }], T3)
    ).toThrow(/before the first execution attempt/);

    await expect(
      setup.gate.verifyUnit(gateInput(setup.claim.token, setup.evidence, [verifier("verifier-a", "pass")]))
    ).resolves.toMatchObject({ outcome: "succeeded" });
  });

  it("holds when no authoritative verification requirement was admitted", async () => {
    const { store, gate, claim, evidence } = verifyingUnit("independent", { setRequirement: false });
    await expect(
      gate.verifyUnit(gateInput(claim.token, evidence, [verifier("verifier-a", "pass")]))
    ).resolves.toMatchObject({
      outcome: "inconclusive",
      reason: "missing_verification_requirement"
    });
    expect(store.workUnits("m1")[0]?.status).toBe("verifying");
  });

  it("persists the actual retryable lifecycle outcome on a failed check", async () => {
    const { store, gate, claim, evidence } = verifyingUnit("independent");
    await expect(
      gate.verifyUnit(gateInput(claim.token, evidence, [verifier("verifier-a", "fail")]))
    ).resolves.toMatchObject({ outcome: "retryable", verdict: "fail" });

    expect(store.workUnits("m1")[0]).toMatchObject({
      status: "retryable",
      failureCategory: "verification_failure"
    });
    const row = store.db.prepare("SELECT outcome FROM work_unit_verification_decisions").get() as { outcome: string };
    expect(row.outcome).toBe("retryable");
    expect(store.evidence<{ outcome: string }>("m1", "verification:u1:1")?.outcome).toBe("retryable");
  });

  it("makes release-gate failure terminal", async () => {
    const { store, gate, claim, evidence } = verifyingUnit("release_gate");
    await expect(
      gate.verifyUnit(gateInput(claim.token, evidence, [verifier("verifier-a", "fail")]))
    ).resolves.toMatchObject({ outcome: "failed", verdict: "fail" });
    expect(store.workUnits("m1")[0]).toMatchObject({
      status: "failed",
      failureCategory: "verification_failure"
    });
  });

  it("requires two distinct multi-verifiers and stops after a decisive failure", async () => {
    const one = verifyingUnit("multi_verifier");
    await expect(
      one.gate.verifyUnit(gateInput(one.claim.token, one.evidence, [verifier("verifier-a", "pass")]))
    ).resolves.toMatchObject({ outcome: "inconclusive", reason: "insufficient_verifiers" });

    const duplicate = verifyingUnit("multi_verifier");
    await expect(
      duplicate.gate.verifyUnit(
        gateInput(duplicate.claim.token, duplicate.evidence, [
          verifier("verifier-a", "pass"),
          verifier("verifier-a", "pass")
        ])
      )
    ).resolves.toMatchObject({ outcome: "inconclusive", reason: "duplicate_verifier" });

    let laterVerifierRan = false;
    const failed = verifyingUnit("multi_verifier");
    await expect(
      failed.gate.verifyUnit(
        gateInput(failed.claim.token, failed.evidence, [
          verifier("verifier-a", "fail"),
          verifier("verifier-b", "pass", { onVerify: () => (laterVerifierRan = true), throws: true })
        ])
      )
    ).resolves.toMatchObject({ outcome: "retryable", verdict: "fail" });
    expect(laterVerifierRan).toBe(false);

    const passed = verifyingUnit("multi_verifier");
    await expect(
      passed.gate.verifyUnit(
        gateInput(passed.claim.token, passed.evidence, [verifier("verifier-a", "pass"), verifier("verifier-b", "pass")])
      )
    ).resolves.toMatchObject({ outcome: "succeeded", verdict: "pass" });
  });

  it("rejects a late pass after cancellation while verification is running", async () => {
    const { store, gate, claim, evidence } = verifyingUnit("independent");
    const cancelling: Verifier = {
      engineId: "verifier-a",
      async verify(criteria) {
        store.cancelMission("m1", { reason: "operator_stop", now: T3 });
        return verifier("verifier-a", "pass").verify(criteria, evidence);
      }
    };

    await expect(gate.verifyUnit(gateInput(claim.token, evidence, [cancelling]))).resolves.toMatchObject({
      outcome: "not_verifying",
      reason: "verification_binding_stale"
    });
    expect(store.workUnits("m1")[0]?.status).toBe("cancelled");
    expect(
      (store.db.prepare("SELECT outcome FROM work_unit_verification_decisions").get() as { outcome: string }).outcome
    ).toBe("rejected_stale");
  });

  it("redacts verifier prose before durable persistence", async () => {
    const secret = "redaction-test-only-1234567890";
    const { store, gate, claim, evidence } = verifyingUnit("independent");
    await gate.verifyUnit(
      gateInput(claim.token, evidence, [
        verifier("verifier-a", "pass", {
          summary: `Authorization: Bearer ${secret}`,
          observed: `Bearer ${secret}`
        })
      ])
    );

    const durable = JSON.stringify(store.evidence("m1", "verification:u1:1"));
    const decision = (
      store.db.prepare("SELECT evidence_json FROM work_unit_verification_decisions").get() as { evidence_json: string }
    ).evidence_json;
    expect(durable).not.toContain(secret);
    expect(decision).not.toContain(secret);
    expect(`${durable}${decision}`).toContain("[redacted]");
  });

  it("accounts verifier calls and exact reported model usage", async () => {
    const { store, gate, claim, evidence } = verifyingUnit("independent", {
      budget: { maxToolCalls: 2, maxModelTokens: 100, maxSpendUsd: 0.02 }
    });
    await expect(
      gate.verifyUnit(
        gateInput(claim.token, evidence, [
          verifier("verifier-a", "pass", {
            usageReservation: { maxModelTokens: 50, maxSpendMicroUsd: 10_000 },
            usage: { modelTokens: 12, spendMicroUsd: 3_000 }
          })
        ])
      )
    ).resolves.toMatchObject({ outcome: "succeeded" });
    expect(store.budget("m1")?.usage).toMatchObject({
      tool_calls: 1,
      model_tokens: 12,
      spend_micro_usd: 3_000
    });
  });

  it("does not invoke a verifier whose reservation cannot fit the mission budget", async () => {
    let invoked = false;
    const { store, gate, claim, evidence } = verifyingUnit("independent", {
      budget: { maxSpendUsd: 0.01 }
    });
    await expect(
      gate.verifyUnit(
        gateInput(claim.token, evidence, [
          verifier("verifier-a", "pass", {
            usageReservation: { maxSpendMicroUsd: 20_000 },
            onVerify: () => (invoked = true)
          })
        ])
      )
    ).resolves.toMatchObject({
      outcome: "inconclusive",
      reason: "verification_budget_exhausted"
    });
    expect(invoked).toBe(false);
    expect(store.workUnits("m1")[0]?.status).toBe("verifying");
  });

  it("refuses capped model verification when the verifier cannot bound token usage", async () => {
    let invoked = false;
    const { gate, claim, evidence } = verifyingUnit("independent", {
      budget: { maxModelTokens: 100 }
    });
    await expect(
      gate.verifyUnit(
        gateInput(claim.token, evidence, [verifier("verifier-a", "pass", { onVerify: () => (invoked = true) })])
      )
    ).resolves.toMatchObject({
      outcome: "inconclusive",
      reason: "verification_budget_unaccounted"
    });
    expect(invoked).toBe(false);
  });

  it("samples the durable decision timestamp after verifier execution", async () => {
    const clockValues = [T4, T5];
    let index = 0;
    const { store, gate, claim, evidence } = verifyingUnit("independent", {
      clock: () => clockValues[Math.min(index++, clockValues.length - 1)] ?? T5
    });
    await gate.verifyUnit(gateInput(claim.token, evidence, [verifier("verifier-a", "pass")]));
    const row = store.db.prepare("SELECT created_at FROM work_unit_verification_decisions").get() as {
      created_at: string;
    };
    expect(row.created_at).toBe(T5);
  });

  it("is a no-op for policy none", async () => {
    const { gate, claim, evidence } = verifyingUnit("none");
    await expect(
      gate.verifyUnit(gateInput(claim.token, evidence, [verifier("verifier-a", "pass")]))
    ).resolves.toMatchObject({ outcome: "policy_none" });
  });
});
