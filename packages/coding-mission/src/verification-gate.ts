import { randomUUID } from "node:crypto";
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
import type { ExecutionReceipt, ResultEnvelope } from "./worker-execution.js";

export type VerificationGateOutcome =
  | "succeeded"
  | "failed"
  | "retryable"
  | "inconclusive"
  | "not_verifying"
  | "policy_none";

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
  implementerEngineId: string;
  resultHash: string;
  reportHash: string;
  report: ResultEnvelope;
  receipts: ExecutionReceipt[];
}

interface VerificationContext {
  missionId: string;
  unitId: string;
  claimToken: string;
  policy: Exclude<VerificationPolicy, "none">;
  requirement: WorkUnitVerificationRequirement;
  binding: ExecutionBinding;
  evidence: VerificationEvidence;
}

interface DecidedVerification {
  outcome: "succeeded" | "failed" | "inconclusive";
  verdict?: VerificationResult["verdict"];
  verifierEngineIds: string[];
  results?: VerificationResult[];
  reason?: string;
}

function boundedText(value: string, max: number): string {
  return value.slice(0, max);
}

/**
 * ACS-owned verification transition for WorkUnits.
 *
 * The rubric, implementer engine identity, execution report, result hash and
 * verifier evidence all come from durable ACS state. Callers select verifier
 * implementations only; they cannot supply or rewrite the evidence being judged.
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
      const reason = "missing_verification_requirement";
      this.auditAuthorityHold(input.missionId, input.unitId, policy, reason);
      return { outcome: "inconclusive", policy, verifierEngineIds: [], reason };
    }

    const binding = this.executionBinding(input.missionId, input.unitId, unit.attempt);
    if (!binding) {
      const reason = "missing_execution_binding";
      this.auditAuthorityHold(input.missionId, input.unitId, policy, reason);
      return { outcome: "inconclusive", policy, verifierEngineIds: [], reason };
    }

    const context: VerificationContext = {
      missionId: input.missionId,
      unitId: input.unitId,
      claimToken: input.claimToken,
      policy,
      requirement,
      binding,
      evidence: this.durableEvidence(binding)
    };
    const runId = `wvr_${randomUUID().replaceAll("-", "")}`;
    const verifierEngineIds = input.verifiers.map((verifier) => verifier.engineId);
    const hold = (
      reason: string,
      results: VerificationResult[] = [],
      verdict?: VerificationResult["verdict"]
    ): VerificationGateResult =>
      this.apply(context, runId, {
        outcome: "inconclusive",
        verifierEngineIds:
          results.length > 0 ? results.map((result) => result.verifierEngineId) : verifierEngineIds,
        reason,
        results,
        ...(verdict ? { verdict } : {})
      });

    if (input.verifiers.length === 0) return hold("no_verifier");
    if (new Set(verifierEngineIds).size !== verifierEngineIds.length) return hold("duplicate_verifier");
    if (policy === "multi_verifier" && input.verifiers.length < 2) return hold("insufficient_verifiers");

    const results: VerificationResult[] = [];
    let accountingReason: string | undefined;

    for (const [index, verifier] of input.verifiers.entries()) {
      if (verifier.engineId === binding.implementerEngineId) {
        return hold("verifier_identity_collision", results);
      }
      const reservationId = `wub_${stableHash({ runId, index, verifier: verifier.engineId }).slice(0, 32)}`;
      const reserved = this.store.reserveVerificationUsage({
        reservationId,
        runId,
        missionId: input.missionId,
        executionAttemptId: binding.attemptId,
        verifierEngineId: verifier.engineId,
        ...(verifier.usageReservation?.maxModelTokens === undefined
          ? {}
          : { modelTokens: verifier.usageReservation.maxModelTokens }),
        ...(verifier.usageReservation?.maxSpendMicroUsd === undefined
          ? {}
          : { spendMicroUsd: verifier.usageReservation.maxSpendMicroUsd }),
        now: this.clock()
      });
      if (!reserved.ok) return hold(reserved.reason, results);

      try {
        const raw = await runIndependentVerification({
          implementerEngineId: binding.implementerEngineId,
          verifier,
          criteria: requirement.criteria,
          evidence: context.evidence
        });
        const result = verificationResultSchema.parse(raw);
        results.push(result);

        const settled = this.store.settleVerificationUsage(
          reservationId,
          {
            ...(result.usage?.modelTokens === undefined ? {} : { modelTokens: result.usage.modelTokens }),
            ...(result.usage?.spendMicroUsd === undefined ? {} : { spendMicroUsd: result.usage.spendMicroUsd })
          },
          this.clock()
        );
        accountingReason = settled.reason ?? accountingReason;

        // A validated failure is decisive even if the provider overspent its
        // reservation. Budget exhaustion is still recorded, but never erases
        // negative verification evidence.
        if (result.verdict === "fail" || result.verdict === "inconclusive") break;
        if (settled.reason) return hold(settled.reason, results, result.verdict);
      } catch (error) {
        const settled = this.store.settleVerificationUsage(reservationId, {}, this.clock());
        const reason =
          settled.reason ?? (error instanceof ControlStackError ? error.code : "verifier_error");
        return hold(reason, results);
      }
    }

    const verdict: VerificationResult["verdict"] = results.some((result) => result.verdict === "fail")
      ? "fail"
      : results.some((result) => result.verdict === "inconclusive")
        ? "inconclusive"
        : results.length === input.verifiers.length
          ? "pass"
          : "inconclusive";

    return this.apply(context, runId, {
      outcome: verdict === "pass" ? "succeeded" : verdict === "fail" ? "failed" : "inconclusive",
      verdict,
      verifierEngineIds: results.map((result) => result.verifierEngineId),
      results,
      ...(verdict === "fail" && accountingReason ? { reason: accountingReason } : {})
    });
  }

  private apply(
    context: VerificationContext,
    runId: string,
    decided: DecidedVerification
  ): VerificationGateResult {
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
        currentBinding.implementerEngineId !== context.binding.implementerEngineId ||
        !requirement ||
        requirement.criteriaHash !== context.requirement.criteriaHash;

      if (stale) {
        this.persistDecision(context, runId, decided, "rejected_stale", decidedAt);
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

      const durablePayload = this.persistDecision(context, runId, decided, outcome, decidedAt);
      this.store.putEvidence(
        context.missionId,
        `verification:${context.unitId}:${context.binding.unitAttempt}:${runId}`,
        durablePayload,
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
            runId,
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
    runId: string,
    decided: DecidedVerification,
    outcome: "succeeded" | "failed" | "retryable" | "inconclusive" | "rejected_stale",
    now: string
  ): unknown {
    const evidenceHash = stableHash(context.evidence);
    const verifierEngineIdsJson = JSON.stringify(decided.verifierEngineIds);
    const payload = this.boundedDecisionPayload(context, runId, decided, outcome);
    const decisionId = `wuv_${stableHash({ runId, executionAttemptId: context.binding.attemptId }).slice(0, 32)}`;

    this.store.db
      .prepare(
        `INSERT INTO work_unit_verification_decisions (
           decision_id, run_id, mission_id, unit_id, unit_attempt, execution_attempt_id, execution_report_hash,
           result_hash, criteria_hash, verification_policy, outcome, verdict, implementer_worker_id,
           implementer_engine_id, verifier_engine_ids_json, evidence_hash, evidence_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        decisionId,
        runId,
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
        context.binding.implementerEngineId,
        verifierEngineIdsJson,
        evidenceHash,
        JSON.stringify(payload),
        now
      );
    return payload;
  }

  private boundedDecisionPayload(
    context: VerificationContext,
    runId: string,
    decided: DecidedVerification,
    outcome: string
  ): unknown {
    const payload = {
      runId,
      unitId: context.unitId,
      unitAttempt: context.binding.unitAttempt,
      executionAttemptId: context.binding.attemptId,
      executionReportHash: context.binding.reportHash,
      resultHash: context.binding.resultHash,
      criteriaHash: context.requirement.criteriaHash,
      policy: context.policy,
      outcome,
      ...(decided.verdict ? { verdict: decided.verdict } : {}),
      ...(decided.reason ? { reason: boundedText(decided.reason, 256) } : {}),
      implementerWorkerId: context.binding.workerId,
      implementerEngineId: context.binding.implementerEngineId,
      verifierEngineIds: decided.verifierEngineIds,
      evidence: {
        workItemId: context.evidence.workItemId,
        implementerClaimHash: stableHash(context.evidence.implementerClaim),
        diffSummaryHash: stableHash(context.evidence.diffSummary),
        commandResults: context.evidence.commandResults.map((command) => ({
          commandProfile: boundedText(command.commandProfile, 128),
          exitCode: command.exitCode,
          observedSuccess: command.observedSuccess,
          stdoutHash: stableHash(command.stdout),
          stderrHash: stableHash(command.stderr)
        }))
      },
      results: (decided.results ?? []).map((result) => ({
        verdict: result.verdict,
        verifierEngineId: result.verifierEngineId,
        durationMs: result.durationMs,
        ...(result.usage ? { usage: result.usage } : {}),
        summary: boundedText(result.summary, 1_000),
        criteriaResults: result.criteriaResults.map((criterion) => ({
          criterionId: boundedText(criterion.criterionId, 128),
          satisfied: criterion.satisfied,
          observed: boundedText(criterion.observed, 500)
        }))
      }))
    };
    return redactValue(payload);
  }

  private executionBinding(missionId: string, unitId: string, unitAttempt: number): ExecutionBinding | undefined {
    const row = this.store.db
      .prepare(
        `SELECT attempt_id, mission_id, unit_id, unit_attempt, worker_id, implementer_engine_id,
                state, result_hash, report_hash, report_json
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
          implementer_engine_id: string | null;
          state: string;
          result_hash: string | null;
          report_hash: string | null;
          report_json: string | null;
        }
      | undefined;
    if (
      !row ||
      row.state !== "succeeded" ||
      !row.result_hash ||
      !row.report_hash ||
      !row.report_json ||
      !row.implementer_engine_id
    ) {
      return undefined;
    }
    const report = JSON.parse(row.report_json) as ResultEnvelope;
    if (stableHash(report) !== row.report_hash) {
      throw new ControlStackError("coding_mission_integrity", "persisted execution report hash does not match report_json");
    }
    if (
      report.attemptId !== row.attempt_id ||
      report.unitId !== row.unit_id ||
      report.unitAttempt !== row.unit_attempt ||
      report.workerId !== row.worker_id ||
      report.result?.resultHash !== row.result_hash
    ) {
      throw new ControlStackError("coding_mission_integrity", "persisted execution report binding is invalid");
    }
    const receipts = this.store.db
      .prepare(
        `SELECT kind, hash
         FROM work_unit_execution_receipts
         WHERE attempt_id = ?
         ORDER BY receipt_index`
      )
      .all(row.attempt_id) as Array<{ kind: string; hash: string }>;
    if (stableHash(receipts) !== stableHash(report.receipts)) {
      throw new ControlStackError("coding_mission_integrity", "persisted execution receipts do not match report_json");
    }

    return {
      attemptId: row.attempt_id,
      missionId: row.mission_id,
      unitId: row.unit_id,
      unitAttempt: row.unit_attempt,
      workerId: row.worker_id,
      implementerEngineId: row.implementer_engine_id,
      resultHash: row.result_hash,
      reportHash: row.report_hash,
      report,
      receipts
    };
  }

  private durableEvidence(binding: ExecutionBinding): VerificationEvidence {
    const files = (binding.report.result?.files ?? []).slice(0, 128).map((file) => boundedText(file, 256));
    return verificationEvidenceSchema.parse({
      workItemId: binding.unitId,
      implementerClaim: boundedText(
        `Durable execution ${binding.attemptId} reported ${binding.report.outcome} with result ${binding.resultHash}.`,
        2_000
      ),
      diffSummary: boundedText(
        files.length > 0 ? `Durable result files: ${files.join(", ")}` : "Durable execution reported no result files.",
        8_000
      ),
      commandResults: binding.receipts.slice(0, 32).map((receipt) => ({
        commandProfile: boundedText(`opaque_receipt:${receipt.kind}`, 128),
        exitCode: null,
        observedSuccess: false,
        stdout: boundedText(`opaque receipt hash only: ${receipt.hash}; no command attestation is present`, 512),
        stderr: ""
      }))
    });
  }

  private auditAuthorityHold(
    missionId: string,
    unitId: string,
    policy: Exclude<VerificationPolicy, "none">,
    reason: string
  ): void {
    const now = this.clock();
    const unit = this.store.workUnits(missionId).find((candidate) => candidate.unitId === unitId);
    const executionAttempt = unit?.attempt
      ? this.store.db
          .prepare(
            `SELECT attempt_id FROM work_unit_execution_attempts
             WHERE mission_id = ? AND unit_id = ? AND unit_attempt = ?`
          )
          .get(missionId, unitId, unit.attempt) as { attempt_id: string } | undefined
      : undefined;
    const body = {
      unitId,
      policy,
      reason,
      ...(unit ? { unitAttempt: unit.attempt } : {}),
      ...(executionAttempt ? { executionAttemptId: executionAttempt.attempt_id } : {})
    };
    this.store.putEvidence(missionId, `verification_authority_denied:${unitId}:${stableHash(body).slice(0, 12)}`, body, now);
    this.store.db
      .prepare(
        `INSERT INTO coding_events (mission_id, name, body_json, created_at)
         VALUES (?, 'verification.authority_denied', ?, ?)`
      )
      .run(missionId, JSON.stringify(body), now);
  }
}
