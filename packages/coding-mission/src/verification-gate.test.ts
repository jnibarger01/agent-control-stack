import { describe, expect, it } from "vitest";
import type {
  VerificationCriterion,
  VerificationEvidence,
  VerificationResult,
  VerificationUsageReservation,
  Verifier
} from "@agent-control-stack/verification";
import type { MissionBudget } from "./budget.js";
import type { VerificationPolicy } from "./mission-model.js";
import { CodingMissionStore } from "./store.js";
import { WorkUnitVerificationGate } from "./verification-gate.js";
import { WorkUnitExecutionLedger, type ResultEnvelope } from "./worker-execution.js";

const T0 = "2026-10-06T00:00:00.000Z";
const T1 = "2026-10-06T00:00:01.000Z";
const T2 = "2026-10-06T00:00:02.000Z";
const T3 = "2026-10-06T00:00:03.000Z";

const CRITERIA: VerificationCriterion[] = [
  { id: "c1", description: "result exists", expected: "a result hash is present" }
];

interface VerifierOptions {
  throws?: boolean;
  summary?: string;
  observed?: string;
  usage?: VerificationResult["usage"];
  usageReservation?: VerificationUsageReservation;
  onVerify?: (evidence: VerificationEvidence) => void;
}

function verifier(engineId: string, verdict: VerificationResult["verdict"], options: VerifierOptions = {}): Verifier {
  return {
    engineId,
    ...(options.usageReservation ? { usageReservation: options.usageReservation } : {}),
    async verify(criteria, evidence) {
      options.onVerify?.(evidence);
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
  if (policy !== "none") {
    store.setVerificationRequirement("m1", "u1", options.criteria ?? CRITERIA, T0);
  }
  store.releaseReadyUnits("m1", T0);
  const claim = {
    token: "claim-super-secret",
    workerId: "worker-1",
    route: { lane: "coder" as const, implementerEngineId: "codex" },
    claimedAt: T1
  };
  expect(store.claimUnit("m1", "u1", claim)).toMatchObject({ ok: true, attempt: 1 });
  const ledger = new WorkUnitExecutionLedger(store);
  const dispatch = ledger.beginDispatch({
    missionId: "m1",
    unitId: "u1",
    claimToken: claim.token,
    workerId: claim.workerId,
    implementerEngineId: "codex",
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
  return {
    store,
    ledger,
    gate: new WorkUnitVerificationGate(store, options.clock),
    claim,
    dispatch
  };
}

function gateInput(claimToken: string, verifiers: readonly Verifier[]) {
  return {
    missionId: "m1",
    unitId: "u1",
    claimToken,
    verifiers
  };
}

describe("work-unit verification gate", () => {
  it("promotes only an attempt-bound independent pass", async () => {
    const { store, gate, claim, dispatch } = verifyingUnit("independent");

    expect(() =>
      store.completeOperation("m1", "u1", claim.token, { resultHash: "result-1", files: ["a.ts"] }, T3)
    ).toThrow();

    await expect(gate.verifyUnit(gateInput(claim.token, [verifier("claude", "pass")]))).resolves.toMatchObject({
      outcome: "succeeded",
      verdict: "pass"
    });

    expect(store.workUnits("m1")[0]).toMatchObject({ status: "succeeded", resultHash: "result-1" });
    const row = store.db
      .prepare(
        `SELECT execution_attempt_id, result_hash, criteria_hash, implementer_worker_id,
                implementer_engine_id, outcome
         FROM work_unit_verification_decisions`
      )
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({
      execution_attempt_id: dispatch.attemptId,
      result_hash: "result-1",
      implementer_worker_id: "worker-1",
      implementer_engine_id: "codex",
      outcome: "succeeded"
    });
  });

  it("rejects the same implementer engine even when the worker identity differs", async () => {
    const { store, gate, claim } = verifyingUnit("independent");
    await expect(gate.verifyUnit(gateInput(claim.token, [verifier("codex", "pass")]))).resolves.toMatchObject({
      outcome: "inconclusive",
      reason: "verifier_identity_collision"
    });
    expect(store.workUnits("m1")[0]?.status).toBe("verifying");
  });

  it("rejects an identity collision before reserving or charging verifier budget", async () => {
    const { store, gate, claim } = verifyingUnit("independent", {
      budget: { maxToolCalls: 1, maxSpendUsd: 0.01 }
    });
    await expect(
      gate.verifyUnit(
        gateInput(claim.token, [
          verifier("codex", "pass", {
            usageReservation: { maxSpendMicroUsd: 5_000 }
          })
        ])
      )
    ).resolves.toMatchObject({
      outcome: "inconclusive",
      reason: "verifier_identity_collision"
    });
    expect(store.budget("m1")?.usage.tool_calls).toBeUndefined();
    expect(
      (
        store.db
          .prepare("SELECT COUNT(*) AS n FROM work_unit_verification_usage_reservations")
          .get() as { n: number }
      ).n
    ).toBe(0);
  });

  it("derives verifier evidence only from the durable execution report and receipts", async () => {
    let observed: VerificationEvidence | undefined;
    const { gate, claim, dispatch } = verifyingUnit("independent");
    await gate.verifyUnit(
      gateInput(claim.token, [
        verifier("claude", "pass", {
          onVerify: (evidence) => {
            observed = evidence;
          }
        })
      ])
    );

    expect(observed).toMatchObject({
      workItemId: "u1",
      commandResults: [
        {
          commandProfile: "opaque_receipt:tool_result",
          observedSuccess: false,
          stdout: "opaque receipt hash only: receipt-1; no command attestation is present"
        }
      ]
    });
    expect(observed?.implementerClaim).toContain(dispatch.attemptId);
    expect(observed?.diffSummary).toContain("a.ts");
  });

  it("refuses the first claim when a verified unit has no admitted rubric", () => {
    const store = new CodingMissionStore(":memory:");
    store.createGeneral({ missionId: "m1", summary: "execute", now: T0 });
    store.addWorkUnits(
      "m1",
      [{ unitId: "u1", kind: "coding", title: "unit", verificationPolicy: "independent" }],
      T0
    );
    store.releaseReadyUnits("m1", T0);
    expect(
      store.claimUnit("m1", "u1", {
        token: "claim",
        workerId: "worker-1",
        route: { lane: "coder", implementerEngineId: "codex" },
        claimedAt: T1
      })
    ).toEqual({ ok: false, outcome: "verification_requirement_missing" });
    expect(store.workUnits("m1")[0]?.attempt).toBe(0);
  });

  it("resets a migration-quarantined unit only after a new rubric is admitted", () => {
    const store = new CodingMissionStore(":memory:");
    store.createGeneral({ missionId: "m1", summary: "execute", now: T0 });
    store.addWorkUnits(
      "m1",
      [{ unitId: "u1", kind: "coding", title: "unit", verificationPolicy: "independent" }],
      T0
    );
    store.db
      .prepare(
        `UPDATE coding_operations
         SET status = 'failed', attempt = 1, failure_category = 'verification_failure'
         WHERE mission_id = 'm1' AND operation_id = 'u1'`
      )
      .run();
    store.db
      .prepare(
        `INSERT INTO work_unit_verification_quarantine (mission_id, unit_id, reason, quarantined_at)
         VALUES ('m1', 'u1', 'migration_057_missing_verification_authority', ?)`
      )
      .run(T0);

    store.setVerificationRequirement("m1", "u1", CRITERIA, T1);

    expect(store.workUnits("m1")[0]).toMatchObject({
      status: "pending",
      attempt: 1
    });
    expect(
      store.db
        .prepare("SELECT COUNT(*) AS n FROM work_unit_verification_quarantine WHERE mission_id = 'm1' AND unit_id = 'u1'")
        .get()
    ).toEqual({ n: 0 });
    expect(store.events("m1").map((event) => event.name)).toContain("verification.migration_recovered");
  });

  it("audits a fail-closed authority lookup failure", async () => {
    const { store, gate, claim } = verifyingUnit("independent");
    store.db.exec("DROP TRIGGER work_unit_verification_requirements_immutable_delete");
    store.db.exec("DELETE FROM work_unit_verification_requirements WHERE mission_id = 'm1' AND unit_id = 'u1'");

    await expect(gate.verifyUnit(gateInput(claim.token, [verifier("claude", "pass")]))).resolves.toMatchObject({
      outcome: "inconclusive",
      reason: "missing_verification_requirement"
    });
    expect(store.events("m1")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "verification.authority_denied",
          body: expect.objectContaining({
            reason: "missing_verification_requirement",
            unitAttempt: 1
          })
        })
      ])
    );
  });

  it("refuses migration recovery when the pre-057 external outcome was unknown", () => {
    const store = new CodingMissionStore(":memory:");
    store.createGeneral({ missionId: "m1", summary: "execute", now: T0 });
    store.addWorkUnits(
      "m1",
      [{ unitId: "u1", kind: "coding", title: "unit", verificationPolicy: "independent" }],
      T0
    );
    store.db
      .prepare(
        `UPDATE coding_operations
         SET status = 'failed', attempt = 1, failure_category = 'verification_failure'
         WHERE mission_id = 'm1' AND operation_id = 'u1'`
      )
      .run();
    store.db
      .prepare(
        `INSERT INTO work_unit_verification_quarantine
           (mission_id, unit_id, reason, previous_status, quarantined_at)
         VALUES ('m1', 'u1', 'migration_057_missing_verification_authority', 'unknown', ?)`
      )
      .run(T0);

    expect(() => store.setVerificationRequirement("m1", "u1", CRITERIA, T1)).toThrow(
      /must be reconciled/
    );
    expect(store.workUnits("m1")[0]).toMatchObject({ status: "failed", attempt: 1 });
  });

  it("fails closed when the persisted execution report hash is tampered", async () => {
    const { store, gate, claim, dispatch } = verifyingUnit("independent");
    store.db
      .prepare("UPDATE work_unit_execution_attempts SET report_hash = ? WHERE attempt_id = ?")
      .run("tampered-report-hash", dispatch.attemptId);

    await expect(gate.verifyUnit(gateInput(claim.token, [verifier("claude", "pass")]))).rejects.toThrow(
      /report hash does not match/
    );
    expect(store.workUnits("m1")[0]?.status).toBe("verifying");
  });

  it("fails closed when persisted receipt rows diverge from report_json", async () => {
    const { store, gate, claim, dispatch } = verifyingUnit("independent");
    store.db
      .prepare("UPDATE work_unit_execution_receipts SET hash = 'tampered' WHERE attempt_id = ?")
      .run(dispatch.attemptId);

    await expect(gate.verifyUnit(gateInput(claim.token, [verifier("claude", "pass")]))).rejects.toThrow(
      /receipts do not match/
    );
    expect(store.workUnits("m1")[0]?.status).toBe("verifying");
  });

  it("persists the actual retryable lifecycle outcome on a failed check", async () => {
    const { store, gate, claim } = verifyingUnit("independent");
    await expect(gate.verifyUnit(gateInput(claim.token, [verifier("claude", "fail")]))).resolves.toMatchObject({
      outcome: "retryable",
      verdict: "fail"
    });
    expect(store.workUnits("m1")[0]).toMatchObject({
      status: "retryable",
      failureCategory: "verification_failure"
    });
    expect(
      (store.db.prepare("SELECT outcome FROM work_unit_verification_decisions").get() as { outcome: string }).outcome
    ).toBe("retryable");
  });

  it("makes release-gate failure terminal", async () => {
    const { store, gate, claim } = verifyingUnit("release_gate");
    await expect(gate.verifyUnit(gateInput(claim.token, [verifier("claude", "fail")]))).resolves.toMatchObject({
      outcome: "failed",
      verdict: "fail"
    });
    expect(store.workUnits("m1")[0]).toMatchObject({
      status: "failed",
      failureCategory: "verification_failure"
    });
  });

  it("requires two distinct multi-verifiers and stops after a decisive failure", async () => {
    const one = verifyingUnit("multi_verifier");
    await expect(one.gate.verifyUnit(gateInput(one.claim.token, [verifier("claude", "pass")]))).resolves.toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient_verifiers",
      verifierEngineIds: ["claude"]
    });

    let laterVerifierRan = false;
    const failed = verifyingUnit("multi_verifier");
    await expect(
      failed.gate.verifyUnit(
        gateInput(failed.claim.token, [
          verifier("claude-a", "fail"),
          verifier("claude-b", "pass", {
            onVerify: () => {
              laterVerifierRan = true;
            },
            throws: true
          })
        ])
      )
    ).resolves.toMatchObject({ outcome: "retryable", verdict: "fail" });
    expect(laterVerifierRan).toBe(false);

    const passed = verifyingUnit("multi_verifier");
    await expect(
      passed.gate.verifyUnit(
        gateInput(passed.claim.token, [verifier("claude-a", "pass"), verifier("claude-b", "pass")])
      )
    ).resolves.toMatchObject({ outcome: "succeeded", verdict: "pass" });
  });

  it("allows a fresh verification run after an inconclusive run", async () => {
    const { store, gate, claim } = verifyingUnit("independent");
    await expect(
      gate.verifyUnit(gateInput(claim.token, [verifier("claude", "pass", { throws: true })]))
    ).resolves.toMatchObject({ outcome: "inconclusive", reason: "verifier_error" });

    await expect(gate.verifyUnit(gateInput(claim.token, [verifier("claude", "pass")]))).resolves.toMatchObject({
      outcome: "succeeded",
      verdict: "pass"
    });
    expect(
      (store.db.prepare("SELECT COUNT(*) AS n FROM work_unit_verification_decisions").get() as { n: number }).n
    ).toBe(2);
  });

  it("rejects a late pass after cancellation while verification is running", async () => {
    const { store, gate, claim } = verifyingUnit("independent");
    const cancelling: Verifier = {
      engineId: "claude",
      async verify(criteria) {
        store.cancelMission("m1", { reason: "operator_stop", now: T3 });
        return {
          verdict: "pass",
          summary: "pass",
          criteriaResults: criteria.map((criterion) => ({
            criterionId: criterion.id,
            satisfied: true,
            observed: "ok"
          })),
          verifierEngineId: "claude",
          durationMs: 1
        };
      }
    };

    await expect(gate.verifyUnit(gateInput(claim.token, [cancelling]))).resolves.toMatchObject({
      outcome: "not_verifying",
      reason: "verification_binding_stale"
    });
    expect(store.workUnits("m1")[0]?.status).toBe("cancelled");
    expect(
      (store.db.prepare("SELECT outcome FROM work_unit_verification_decisions").get() as { outcome: string }).outcome
    ).toBe("rejected_stale");
  });

  it("persists bounded redacted summaries and hashes rather than raw verifier evidence", async () => {
    const secret = "redaction-test-only-1234567890";
    const { store, gate, claim } = verifyingUnit("independent");
    await gate.verifyUnit(
      gateInput(claim.token, [
        verifier("claude", "pass", {
          summary: `Authorization: Bearer ${secret}`,
          observed: `Bearer ${secret}`
        })
      ])
    );

    const decision = (
      store.db.prepare("SELECT evidence_json FROM work_unit_verification_decisions").get() as { evidence_json: string }
    ).evidence_json;
    expect(decision).not.toContain(secret);
    expect(decision).not.toContain("receipt_hash=receipt-1");
    expect(decision).toContain("stdoutHash");
    expect(decision.length).toBeLessThan(20_000);
  });

  it("accounts exact verifier usage after an atomic reservation", async () => {
    const { store, gate, claim } = verifyingUnit("independent", {
      budget: { maxToolCalls: 2, maxModelTokens: 100, maxSpendUsd: 0.02 }
    });
    await expect(
      gate.verifyUnit(
        gateInput(claim.token, [
          verifier("claude", "pass", {
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

  it("counts active verifier reservations during concurrent budget admission", () => {
    const { store, dispatch } = verifyingUnit("independent", { budget: { maxSpendUsd: 0.01 } });
    expect(
      store.reserveVerificationUsage({
        reservationId: "reserve-one",
        runId: "run-one",
        missionId: "m1",
        executionAttemptId: dispatch.attemptId,
        verifierEngineId: "claude-a",
        spendMicroUsd: 8_000,
        now: T3
      })
    ).toEqual({ ok: true });
    expect(
      store.reserveVerificationUsage({
        reservationId: "reserve-two",
        runId: "run-two",
        missionId: "m1",
        executionAttemptId: dispatch.attemptId,
        verifierEngineId: "claude-b",
        spendMicroUsd: 3_000,
        now: T3
      })
    ).toEqual({ ok: false, reason: "verification_budget_exhausted" });
  });

  it("does not invoke a verifier whose reservation cannot fit the mission budget", async () => {
    let invoked = false;
    const { store, gate, claim } = verifyingUnit("independent", {
      budget: { maxSpendUsd: 0.01 }
    });
    await expect(
      gate.verifyUnit(
        gateInput(claim.token, [
          verifier("claude", "pass", {
            usageReservation: { maxSpendMicroUsd: 20_000 },
            onVerify: () => {
              invoked = true;
            }
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
    const { gate, claim } = verifyingUnit("independent", {
      budget: { maxModelTokens: 100 }
    });
    await expect(
      gate.verifyUnit(
        gateInput(claim.token, [
          verifier("claude", "pass", {
            onVerify: () => {
              invoked = true;
            }
          })
        ])
      )
    ).resolves.toMatchObject({
      outcome: "inconclusive",
      reason: "verification_budget_unaccounted"
    });
    expect(invoked).toBe(false);
  });

  it("preserves a fail verdict even when observed usage exceeds the reservation", async () => {
    const { store, gate, claim } = verifyingUnit("independent", {
      budget: { maxSpendUsd: 0.01 }
    });
    await expect(
      gate.verifyUnit(
        gateInput(claim.token, [
          verifier("claude", "fail", {
            usageReservation: { maxSpendMicroUsd: 5_000 },
            usage: { spendMicroUsd: 20_000 }
          })
        ])
      )
    ).resolves.toMatchObject({
      outcome: "retryable",
      verdict: "fail",
      reason: "verification_budget_exhausted"
    });
    expect(store.workUnits("m1")[0]).toMatchObject({
      status: "retryable",
      failureCategory: "verification_failure"
    });
  });

  it("is a no-op for policy none", async () => {
    const { gate, claim } = verifyingUnit("none");
    await expect(gate.verifyUnit(gateInput(claim.token, [verifier("claude", "pass")]))).resolves.toMatchObject({
      outcome: "policy_none"
    });
  });
});
