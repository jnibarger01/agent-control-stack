import { ControlStackError } from "@agent-control-stack/shared";
import {
  runIndependentVerification,
  type VerificationCriterion,
  type VerificationEvidence,
  type VerificationResult,
  type Verifier
} from "@agent-control-stack/verification";
import type { VerificationPolicy } from "./mission-model.js";
import type { CodingMissionStore } from "./store.js";

/**
 * Mandatory independent-verification gate for mission work units.
 *
 * `WorkUnitExecutionLedger.applyResult` parks a successful unit in `verifying`
 * whenever its verification policy is not `none`. This gate is the only path
 * out of that state: it runs verifiers whose identity differs from the
 * implementer's (enforced by `runIndependentVerification`, never trusted to
 * self-report), records durable evidence and a `verification.completed`
 * event, and only then promotes the unit. A maker's own "done" is evidence
 * input (`implementerClaim`), never a verdict.
 *
 * Policy routing:
 * - `lightweight` / `independent`: at least one distinct verifier.
 *   fail -> `verification_failure`, retryable within the mission retry budget.
 * - `multi_verifier`: at least two distinct verifiers, every one must pass.
 * - `release_gate`: at least one distinct verifier; a failure is terminal
 *   (never auto-retryable) because release is a human decision after that.
 *
 * `inconclusive` (including verifier errors, identity collisions and
 * insufficient verifiers) never succeeds and never fails the unit: the unit
 * stays in `verifying`, held for re-verification or a human, with the
 * inconclusive record persisted as evidence. Verification verdicts are
 * applied under the live claim fence, re-checked after the verifiers run,
 * so a unit cancelled or re-claimed while verification was in flight can
 * no longer be promoted by a stale verdict.
 */
export type VerificationGateOutcome =
  "succeeded" | "failed" | "retryable" | "inconclusive" | "not_verifying" | "policy_none";

export interface VerificationGateResult {
  outcome: VerificationGateOutcome;
  policy: VerificationPolicy;
  /** Aggregate verdict across every verifier that ran; absent when none ran. */
  verdict?: VerificationResult["verdict"];
  verifierEngineIds: string[];
  reason?: string;
}

const MAX_CRITERIA = 32;

export class WorkUnitVerificationGate {
  constructor(private readonly store: CodingMissionStore) {}

  async verifyUnit(input: {
    missionId: string;
    unitId: string;
    claimToken: string;
    /** Engine/worker identity that produced the work. Must differ from every verifier. */
    implementerEngineId: string;
    verifiers: readonly Verifier[];
    criteria: VerificationCriterion[];
    evidence: VerificationEvidence;
    now: string;
  }): Promise<VerificationGateResult> {
    const unit = this.store.workUnits(input.missionId).find((candidate) => candidate.unitId === input.unitId);
    if (!unit) throw new ControlStackError("work_unit_not_found", "work unit does not exist");
    if (input.evidence.workItemId !== input.unitId) {
      throw new ControlStackError(
        "verification_evidence_mismatch",
        "verification evidence must be bound to the work unit being verified"
      );
    }
    const policy = unit.verificationPolicy;
    if (policy === "none") return { outcome: "policy_none", policy, verifierEngineIds: [] };
    if (unit.status !== "verifying" || unit.claimToken !== input.claimToken) {
      return { outcome: "not_verifying", policy, verifierEngineIds: [] };
    }

    const verifierEngineIds = input.verifiers.map((verifier) => verifier.engineId);
    const hold = (reason: string): VerificationGateResult =>
      this.apply(input, { outcome: "inconclusive", policy, verifierEngineIds, reason });

    if (input.criteria.length === 0 || input.criteria.length > MAX_CRITERIA) {
      return hold("invalid_criteria");
    }
    if (input.verifiers.length === 0) return hold("no_verifier");
    if (new Set(verifierEngineIds).size !== verifierEngineIds.length) return hold("duplicate_verifier");
    if (policy === "multi_verifier" && input.verifiers.length < 2) return hold("insufficient_verifiers");

    const results: VerificationResult[] = [];
    for (const verifier of input.verifiers) {
      try {
        results.push(
          await runIndependentVerification({
            implementerEngineId: input.implementerEngineId,
            verifier,
            criteria: input.criteria,
            evidence: input.evidence
          })
        );
      } catch (error) {
        // Identity collisions, criteria mismatches and verifier failures are
        // not passes and not proof the work failed: hold for a human.
        return hold(error instanceof ControlStackError ? error.code : "verifier_error");
      }
    }

    const verdict: VerificationResult["verdict"] = results.some((result) => result.verdict === "fail")
      ? "fail"
      : results.some((result) => result.verdict === "inconclusive")
        ? "inconclusive"
        : "pass";

    return this.apply(input, {
      outcome: verdict === "pass" ? "succeeded" : verdict === "fail" ? "failed" : "inconclusive",
      policy,
      verdict,
      verifierEngineIds,
      results
    });
  }

  /** Apply a decided verdict under the live claim fence. No awaits happen in here. */
  private apply(
    input: {
      missionId: string;
      unitId: string;
      claimToken: string;
      implementerEngineId: string;
      now: string;
    },
    decided: VerificationGateResult & { results?: VerificationResult[] }
  ): VerificationGateResult {
    return this.store.transaction(() => {
      const unit = this.store.workUnits(input.missionId).find((candidate) => candidate.unitId === input.unitId);
      if (!unit || unit.status !== "verifying" || unit.claimToken !== input.claimToken) {
        // Cancelled, completed or re-claimed while the verifiers were running:
        // a stale verdict must never promote or fail the live unit.
        return {
          outcome: "not_verifying" as const,
          policy: decided.policy,
          verifierEngineIds: decided.verifierEngineIds
        };
      }

      this.store.putEvidence(
        input.missionId,
        `verification:${input.unitId}:${unit.attempt}`,
        {
          unitId: input.unitId,
          attempt: unit.attempt,
          policy: decided.policy,
          outcome: decided.outcome,
          ...(decided.verdict ? { verdict: decided.verdict } : {}),
          ...(decided.reason ? { reason: decided.reason } : {}),
          implementerEngineId: input.implementerEngineId,
          verifierEngineIds: decided.verifierEngineIds,
          results: (decided.results ?? []).map((result) => ({
            verdict: result.verdict,
            summary: result.summary,
            verifierEngineId: result.verifierEngineId,
            durationMs: result.durationMs,
            criteriaResults: result.criteriaResults
          }))
        },
        input.now
      );
      this.store.db
        .prepare(
          `INSERT INTO coding_events (mission_id, name, body_json, created_at) VALUES (?, 'verification.completed', ?, ?)`
        )
        .run(
          input.missionId,
          JSON.stringify({
            unitId: input.unitId,
            attempt: unit.attempt,
            policy: decided.policy,
            outcome: decided.outcome,
            ...(decided.verdict ? { verdict: decided.verdict } : {}),
            ...(decided.reason ? { reason: decided.reason } : {}),
            verifierEngineIds: decided.verifierEngineIds
          }),
          input.now
        );

      const base: VerificationGateResult = {
        outcome: decided.outcome,
        policy: decided.policy,
        verifierEngineIds: decided.verifierEngineIds,
        ...(decided.verdict ? { verdict: decided.verdict } : {}),
        ...(decided.reason ? { reason: decided.reason } : {})
      };
      switch (decided.outcome) {
        case "succeeded":
          this.store.succeedVerifiedUnit(input.missionId, input.unitId, input.claimToken, input.now);
          return base;
        case "failed": {
          const next = this.store.failUnit(input.missionId, input.unitId, input.claimToken, {
            category: "verification_failure",
            retryable: decided.policy !== "release_gate",
            now: input.now
          });
          return { ...base, outcome: next };
        }
        default:
          // inconclusive: hold in `verifying`. Not a success, not a failure.
          return { ...base, outcome: "inconclusive" as const };
      }
    });
  }
}
