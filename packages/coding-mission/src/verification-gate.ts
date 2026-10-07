import { ControlStackError, redactValue, stableHash } from "@agent-control-stack/shared";
import {
  runIndependentVerification,
  verificationEvidenceSchema,
  verificationResultSchema,
  type VerificationEvidence,
  type VerificationResult,
  type Verifier
} from "@agent-control-stack/verification";
import { TERMINAL_MISSION_STATES, type VerificationPolicy } from "./mission-model.js";
import type { CodingMissionStore, WorkUnitVerificationRequirement } from "./store.js";

/**
 * Evidence handed to a verifier is caller-collected, but its durable execution
 * binding is not caller-authoritative. The gate checks these four fields
 * against migration 055 before invoking any verifier.
 */
export interface BoundVerificationEvidence extends VerificationEvidence {
  executionAttemptId: string;
  unitAttempt: number;
  resultHash: string;
  reportHash: string;
}

export type VerificationGateOutcome =
  "succeeded" | "failed" | "retryable" | "inconclusive" | "not_verifying" | "policy_none";

export interface VerificationGateResult {
  outcome: VerificationGateOutcome;
  policy: VerificationPolicy;
  verdict?: VerificationResult["verdict"];
  verifierEngineIds: string[];
  reason?: string;
}

interface ExecutionBinding {
  attemptId: string;
  missionId: string;
  unitId: string;
  unitAttempt: number;
  workerId: string;
  resultHash: string;
  reportHash: string;
}

interface VerificationContext {
  missionId: string;
  unitId: string;
  claimToken: string;
  policy: Exclude<VerificationPolicy, "none">;
  requirement: WorkUnitVerificationRequirement;
  binding: ExecutionBinding;
  evidence: BoundVerificationEvidence;
}

interface DecidedVerification {
  outcome: "succeeded" | "failed" | "inconclusive";
  verdict?: VerificationResult["verdict"];
  verifierEngineIds: string[];
  results?: VerificationResult[];
  reason?: string;
}

/**
 * ACS-owned verification transition for WorkUnits.
 *
 * The implementer identity, rubric, execution attempt, result hash and report
 * hash all come from durable ACS state. Callers may supply verifier instances
 * and observed evidence, but cannot select the producer identity or replace
 * the admitted rubric after seeing the result.
 */
export class WorkUnitVerificationGate {
  constructor(
    private readonly store: CodingMissionStore,
    private readonly clock: () => string = () => new Date().toISOString()
  ) {}

  async verifyUnit(input: {
    missionId: string;
    unitId: string;
    claimToken: string;
    verifiers: readonly Verifier[];
    evidence: BoundVerificationEvidence;
  }): Promise<VerificationGateResult> {
    const mission = this.store.require(input.missionId);
    const unit = this.store.workUnits(input.missionId).find((candidate) => candidate.unitId === input.unitId);
    if (!unit) throw new ControlStackError("work_unit_not_found", "work unit does not exist");

    const policy = unit.verificationPolicy;
    if (policy === "none") return { outcome: "policy_none", policy, verifierEngineIds: [] };
    if (
      TERMINAL_MISSION_STATES.has(mission.state) ||
      unit.status !== "verifying" ||
      unit.claimToken !== input.claimToken
    ) {
      return { outcome: "not_verifying", policy, verifierEngineIds: [] };
    }

    const requirement = this.store.verificationRequirement(input.missionId, input.unitId);
    if (!requirement) {
      return {
        outcome: "inconclusive",
        policy,
        verifierEngineIds: [],
        reason: "missing_verification_requirement"
      };
    }

    const binding = this.executionBinding(input.missionId, input.unitId, unit.attempt);
    if (!binding) {
      return {
        outcome: "inconclusive",
        policy,
        verifierEngineIds: [],
        reason: "missing_execution_binding"
      };
    }
    this.assertEvidenceBinding(input.evidence, binding);

    const context: VerificationContext = {
      missionId: input.missionId,
      unitId: input.unitId,
      claimToken: input.claimToken,
      policy,
      requirement,
      binding,
      evidence: input.evidence
    };
    const verifierEngineIds = input.verifiers.map((verifier) => verifier.engineId);
    const hold = (reason: string, results: VerificationResult[] = []): VerificationGateResult =>
      this.apply(context, {
        outcome: "inconclusive",
        verifierEngineIds,
        reason,
        results
      });

    if (input.verifiers.length === 0) return hold("no_verifier");
    if (new Set(verifierEngineIds).size !== verifierEngineIds.length) return hold("duplicate_verifier");
    if (policy === "multi_verifier" && input.verifiers.length < 2) return hold("insufficient_verifiers");

    const verifierEvidence = verificationEvidenceSchema.parse({
      workItemId: input.evidence.workItemId,
      implementerClaim: input.evidence.implementerClaim,
      diffSummary: input.evidence.diffSummary,
      commandResults: input.evidence.commandResults
    });

    const results: VerificationResult[] = [];
    for (const verifier of input.verifiers) {
      const admissionFailure = this.verifierBudgetAdmission(input.missionId, verifier);
      if (admissionFailure) return hold(admissionFailure, results);

      try {
        const raw = await runIndependentVerification({
          implementerEngineId: binding.workerId,
          verifier,
          criteria: requirement.criteria,
          evidence: verifierEvidence
        });
        const result = verificationResultSchema.parse(raw);
        const accountingFailure = this.accountVerifierUsage(input.missionId, verifier, result);
        if (accountingFailure) return hold(accountingFailure, results);
        results.push(result);

        // Every supported policy is "all required verifiers must pass".
        // A failure is decisive; do not spend more or let a later verifier
        // exception erase a failure already observed.
        if (result.verdict === "fail" || result.verdict === "inconclusive") break;
      } catch (error) {
        const accountingFailure = this.accountVerifierUsage(input.missionId, verifier);
        if (results.some((result) => result.verdict === "fail")) break;
        return hold(accountingFailure ?? (error instanceof ControlStackError ? error.code : "verifier_error"), results);
      }
    }

    const verdict: VerificationResult["verdict"] = results.some((result) => result.verdict === "fail")
      ? "fail"
      : results.some((result) => result.verdict === "inconclusive")
        ? "inconclusive"
        : results.length === input.verifiers.length
          ? "pass"
          : "inconclusive";

    return this.apply(context, {
      outcome: verdict === "pass" ? "succeeded" : verdict === "fail" ? "failed" : "inconclusive",
      verdict,
      verifierEngineIds: results.map((result) => result.verifierEngineId),
      results
    });
  }

  private verifierBudgetAdmission(missionId: string, verifier: Verifier): string | undefined {
    const budget = this.store.budget(missionId);
    if (!budget) return undefined;

    const toolLimit = budget.limits.tool_calls;
    if (toolLimit !== undefined && (budget.usage.tool_calls ?? 0) + 1 > toolLimit) {
      return "verification_budget_exhausted";
    }

    const tokenLimit = budget.limits.model_tokens;
    if (tokenLimit !== undefined) {
      const reserved = verifier.usageReservation?.maxModelTokens;
      if (reserved === undefined) return "verification_budget_unaccounted";
      if ((budget.usage.model_tokens ?? 0) + reserved > tokenLimit) return "verification_budget_exhausted";
    }

    const spendLimit = budget.limits.spend_micro_usd;
    if (spendLimit !== undefined) {
      const reserved = verifier.usageReservation?.maxSpendMicroUsd;
      if (reserved === undefined) return "verification_budget_unaccounted";
      if ((budget.usage.spend_micro_usd ?? 0) + reserved > spendLimit) return "verification_budget_exhausted";
    }
    return undefined;
  }

  /**
   * Record every verifier invocation. When a call fails before exact provider
   * usage is available, charge the conservative reservation for capped model
   * metrics rather than silently treating unknown usage as zero.
   */
  private accountVerifierUsage(missionId: string, verifier: Verifier, result?: VerificationResult): string | undefined {
    const now = this.clock();
    if (!this.store.recordUsage(missionId, "tool_calls", 1, now).decision.allowed) {
      return "verification_budget_exhausted";
    }

    const budget = this.store.budget(missionId);
    const cappedTokens = budget?.limits.model_tokens !== undefined;
    const cappedSpend = budget?.limits.spend_micro_usd !== undefined;
    const modelTokens =
      result?.usage?.modelTokens ?? (cappedTokens ? verifier.usageReservation?.maxModelTokens : undefined);
    const spendMicroUsd =
      result?.usage?.spendMicroUsd ?? (cappedSpend ? verifier.usageReservation?.maxSpendMicroUsd : undefined);

    if (cappedTokens && modelTokens === undefined) return "verification_budget_unaccounted";
    if (cappedSpend && spendMicroUsd === undefined) return "verification_budget_unaccounted";

    if (
      modelTokens !== undefined &&
      !this.store.recordUsage(missionId, "model_tokens", modelTokens, now).decision.allowed
    ) {
      return "verification_budget_exhausted";
    }
    if (
      spendMicroUsd !== undefined &&
      !this.store.recordUsage(missionId, "spend_micro_usd", spendMicroUsd, now).decision.allowed
    ) {
      return "verification_budget_exhausted";
    }
    return undefined;
  }

  private apply(context: VerificationContext, decided: DecidedVerification): VerificationGateResult {
    const decidedAt = this.clock();
    return this.store.transaction(() => {
      const mission = this.store.require(context.missionId);
      const unit = this.store.workUnits(context.missionId).find((candidate) => candidate.unitId === context.unitId);
      const currentBinding = this.executionBinding(context.missionId, context.unitId, context.binding.unitAttempt);
      const requirement = this.store.verificationRequirement(context.missionId, context.unitId);

      const stale =
        TERMINAL_MISSION_STATES.has(mission.state) ||
        !unit ||
        unit.status !== "verifying" ||
        unit.claimToken !== context.claimToken ||
        unit.attempt !== context.binding.unitAttempt ||
        unit.resultHash !== context.binding.resultHash ||
        !currentBinding ||
        currentBinding.attemptId !== context.binding.attemptId ||
        currentBinding.resultHash !== context.binding.resultHash ||
        currentBinding.reportHash !== context.binding.reportHash ||
        currentBinding.workerId !== context.binding.workerId ||
        !requirement ||
        requirement.criteriaHash !== context.requirement.criteriaHash;

      if (stale) {
        this.persistDecision(context, decided, "rejected_stale", decidedAt);
        return {
          outcome: "not_verifying",
          policy: context.policy,
          verifierEngineIds: decided.verifierEngineIds,
          ...(decided.verdict ? { verdict: decided.verdict } : {}),
          reason: "verification_binding_stale"
        };
      }

      let outcome: "succeeded" | "failed" | "retryable" | "inconclusive";
      if (decided.outcome === "succeeded") {
        const changed = this.store.db
          .prepare(
            `UPDATE coding_operations
             SET status = 'succeeded'
             WHERE mission_id = ? AND operation_id = ? AND status = 'verifying'
               AND claim_token = ? AND attempt = ? AND result_hash = ?`
          )
          .run(
            context.missionId,
            context.unitId,
            context.claimToken,
            context.binding.unitAttempt,
            context.binding.resultHash
          );
        if (changed.changes !== 1) {
          throw new ControlStackError("coding_mission_claim_conflict", "verified completion lost its durable binding");
        }
        this.store.db
          .prepare(
            `INSERT INTO coding_events (mission_id, name, body_json, created_at)
             VALUES (?, 'work_unit.completed', ?, ?)`
          )
          .run(
            context.missionId,
            JSON.stringify({
              unitId: context.unitId,
              resultHash: context.binding.resultHash,
              verified: true,
              executionAttemptId: context.binding.attemptId
            }),
            decidedAt
          );
        outcome = "succeeded";
      } else if (decided.outcome === "failed") {
        outcome = this.store.failUnit(context.missionId, context.unitId, context.claimToken, {
          category: "verification_failure",
          retryable: context.policy !== "release_gate",
          now: decidedAt
        });
      } else {
        outcome = "inconclusive";
      }

      this.persistDecision(context, decided, outcome, decidedAt);

      const evidencePayload = redactValue({
        unitId: context.unitId,
        attempt: context.binding.unitAttempt,
        executionAttemptId: context.binding.attemptId,
        executionReportHash: context.binding.reportHash,
        resultHash: context.binding.resultHash,
        criteriaHash: context.requirement.criteriaHash,
        policy: context.policy,
        outcome,
        ...(decided.verdict ? { verdict: decided.verdict } : {}),
        ...(decided.reason ? { reason: decided.reason } : {}),
        implementerWorkerId: context.binding.workerId,
        verifierEngineIds: decided.verifierEngineIds,
        evidence: context.evidence,
        results: decided.results ?? []
      });
      this.store.putEvidence(
        context.missionId,
        `verification:${context.unitId}:${context.binding.unitAttempt}`,
        evidencePayload,
        decidedAt
      );
      this.store.db
        .prepare(
          `INSERT INTO coding_events (mission_id, name, body_json, created_at)
           VALUES (?, 'verification.completed', ?, ?)`
        )
        .run(
          context.missionId,
          JSON.stringify({
            unitId: context.unitId,
            attempt: context.binding.unitAttempt,
            executionAttemptId: context.binding.attemptId,
            criteriaHash: context.requirement.criteriaHash,
            policy: context.policy,
            outcome,
            ...(decided.verdict ? { verdict: decided.verdict } : {}),
            ...(decided.reason ? { reason: decided.reason } : {}),
            verifierEngineIds: decided.verifierEngineIds
          }),
          decidedAt
        );

      return {
        outcome,
        policy: context.policy,
        verifierEngineIds: decided.verifierEngineIds,
        ...(decided.verdict ? { verdict: decided.verdict } : {}),
        ...(decided.reason ? { reason: decided.reason } : {})
      };
    });
  }

  private persistDecision(
    context: VerificationContext,
    decided: DecidedVerification,
    outcome: "succeeded" | "failed" | "retryable" | "inconclusive" | "rejected_stale",
    now: string
  ): void {
    const evidenceHash = stableHash(context.evidence);
    const verifierEngineIdsJson = JSON.stringify(decided.verifierEngineIds);
    const payload = redactValue({
      evidence: context.evidence,
      results: decided.results ?? [],
      ...(decided.reason ? { reason: decided.reason } : {})
    });
    const decisionId = `wuv_${stableHash({
      executionAttemptId: context.binding.attemptId,
      criteriaHash: context.requirement.criteriaHash,
      evidenceHash,
      verifierEngineIds: decided.verifierEngineIds,
      outcome,
      verdict: decided.verdict ?? null
    }).slice(0, 32)}`;

    const inserted = this.store.db
      .prepare(
        `INSERT OR IGNORE INTO work_unit_verification_decisions (
           decision_id, mission_id, unit_id, unit_attempt, execution_attempt_id, execution_report_hash,
           result_hash, criteria_hash, verification_policy, outcome, verdict, implementer_worker_id,
           verifier_engine_ids_json, evidence_hash, evidence_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        decisionId,
        context.missionId,
        context.unitId,
        context.binding.unitAttempt,
        context.binding.attemptId,
        context.binding.reportHash,
        context.binding.resultHash,
        context.requirement.criteriaHash,
        context.policy,
        outcome,
        decided.verdict ?? null,
        context.binding.workerId,
        verifierEngineIdsJson,
        evidenceHash,
        JSON.stringify(payload),
        now
      );

    if (inserted.changes === 0) {
      const existing = this.store.db
        .prepare(
          `SELECT decision_id, outcome, verdict
           FROM work_unit_verification_decisions
           WHERE execution_attempt_id = ? AND criteria_hash = ?
             AND verifier_engine_ids_json = ? AND evidence_hash = ?`
        )
        .get(context.binding.attemptId, context.requirement.criteriaHash, verifierEngineIdsJson, evidenceHash) as
        { decision_id: string; outcome: string; verdict: string | null } | undefined;
      if (
        !existing ||
        existing.decision_id !== decisionId ||
        existing.outcome !== outcome ||
        existing.verdict !== (decided.verdict ?? null)
      ) {
        throw new ControlStackError(
          "verification_decision_conflict",
          "the same bound verification evidence already has a different durable decision"
        );
      }
    }
  }

  private executionBinding(missionId: string, unitId: string, unitAttempt: number): ExecutionBinding | undefined {
    const row = this.store.db
      .prepare(
        `SELECT attempt_id, mission_id, unit_id, unit_attempt, worker_id, state, result_hash, report_hash
         FROM work_unit_execution_attempts
         WHERE mission_id = ? AND unit_id = ? AND unit_attempt = ?`
      )
      .get(missionId, unitId, unitAttempt) as
      | {
          attempt_id: string;
          mission_id: string;
          unit_id: string;
          unit_attempt: number;
          worker_id: string;
          state: string;
          result_hash: string | null;
          report_hash: string | null;
        }
      | undefined;
    if (!row || row.state !== "succeeded" || !row.result_hash || !row.report_hash) return undefined;
    return {
      attemptId: row.attempt_id,
      missionId: row.mission_id,
      unitId: row.unit_id,
      unitAttempt: row.unit_attempt,
      workerId: row.worker_id,
      resultHash: row.result_hash,
      reportHash: row.report_hash
    };
  }

  private assertEvidenceBinding(evidence: BoundVerificationEvidence, binding: ExecutionBinding): void {
    if (
      evidence.workItemId !== binding.unitId ||
      evidence.executionAttemptId !== binding.attemptId ||
      evidence.unitAttempt !== binding.unitAttempt ||
      evidence.resultHash !== binding.resultHash ||
      evidence.reportHash !== binding.reportHash
    ) {
      throw new ControlStackError(
        "verification_evidence_mismatch",
        "verification evidence does not match the durable execution attempt and result"
      );
    }
  }
}
