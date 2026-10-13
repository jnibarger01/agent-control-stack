import type { DatabaseSync } from "node:sqlite";
import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import { circuitState, percentile, wilsonLowerBound, type OutcomeForCircuit } from "./policy.js";
import type { CircuitState, EvidenceStats, RoutingDecision, RoutingPolicy } from "./types.js";

export interface OutcomeInput {
  decisionId: string;
  attempt: number;
  providerId: string;
  model: string;
  taskType: string;
  ok: boolean;
  failureKind?: "provider" | "request";
  latencyMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  costMicroUsd?: number;
  recordedAt: string;
}

const STATS_ROW_LIMIT = 200;
const nullable = (value: number | undefined) => (value === undefined ? null : value);

/**
 * The broker's memory: decisions, outcomes and verifications, all append-only (migration 064). Reads are bounded. A
 * measurement nobody reported is stored and returned as absent, never as zero.
 */
export class ModelEvidenceStore {
  constructor(private readonly db: DatabaseSync) {}

  findDecision(requestId: string): RoutingDecision | undefined {
    const row = this.db
      .prepare("SELECT decision_id, body_json FROM model_route_decisions WHERE request_id = ?")
      .get(requestId) as { decision_id: string; body_json: string } | undefined;
    if (!row) return undefined;
    const body = JSON.parse(row.body_json) as Omit<RoutingDecision, "decisionId" | "replayed">;
    if (stableHash(body) !== row.decision_id) {
      throw new ControlStackError("model_route_integrity", "a stored routing decision does not match its hash");
    }
    return { ...body, decisionId: row.decision_id, replayed: true };
  }

  /** Stores a decision once per request id. A second call returns the first, so a retried request is not re-routed. */
  recordDecision(decision: Omit<RoutingDecision, "decisionId" | "replayed">): RoutingDecision {
    const existing = this.findDecision(decision.requestId);
    if (existing) return existing;
    const decisionId = stableHash(decision);
    this.db
      .prepare(
        `INSERT INTO model_route_decisions
           (decision_id, request_id, task_type, privacy, mode, chosen_provider, chosen_model, body_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        decisionId,
        decision.requestId,
        decision.taskType,
        decision.privacy,
        decision.mode,
        decision.ranking[0]?.providerId ?? null,
        decision.ranking[0]?.model ?? null,
        JSON.stringify(decision),
        decision.createdAt
      );
    return { ...decision, decisionId, replayed: false };
  }

  /** The next unused attempt number for a decision, so a re-run of the same decision never overwrites earlier evidence. */
  nextAttempt(decisionId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(attempt), 0) AS n FROM model_route_outcomes WHERE decision_id = ?")
      .get(decisionId) as { n: number };
    return row.n + 1;
  }

  /** Idempotent per decision and attempt: recording the same attempt twice keeps the first. Returns the outcome id. */
  recordOutcome(input: OutcomeInput): string {
    const outcomeId = stableHash({ decisionId: input.decisionId, attempt: input.attempt });
    const exists = this.db.prepare("SELECT 1 FROM model_route_outcomes WHERE outcome_id = ?").get(outcomeId);
    if (exists) return outcomeId;
    this.db
      .prepare(
        `INSERT INTO model_route_outcomes
           (outcome_id, decision_id, attempt, provider_id, model, task_type, ok, failure_kind, latency_ms,
            tokens_in, tokens_out, cost_micro_usd, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        outcomeId,
        input.decisionId,
        input.attempt,
        input.providerId,
        input.model,
        input.taskType,
        input.ok ? 1 : 0,
        input.ok ? null : (input.failureKind ?? "provider"),
        nullable(input.latencyMs),
        nullable(input.tokensIn),
        nullable(input.tokensOut),
        nullable(input.costMicroUsd),
        input.recordedAt
      );
    return outcomeId;
  }

  /** An independent verdict on whether an outcome was correct. Only successful outcomes can be verified, and once. */
  recordVerification(input: { outcomeId: string; passed: boolean; verifier: string; recordedAt: string }): void {
    const outcome = this.db.prepare("SELECT ok FROM model_route_outcomes WHERE outcome_id = ?").get(input.outcomeId) as
      | { ok: number }
      | undefined;
    if (!outcome) throw new ControlStackError("model_route_outcome_unknown", "no such outcome to verify");
    if (outcome.ok !== 1) {
      throw new ControlStackError("model_route_verification_invalid", "only a successful outcome can be verified");
    }
    const prior = this.db.prepare("SELECT passed FROM model_route_verifications WHERE outcome_id = ?").get(input.outcomeId) as
      | { passed: number }
      | undefined;
    if (prior) {
      if ((prior.passed === 1) !== input.passed) {
        throw new ControlStackError("model_route_verification_conflict", "this outcome was already verified differently");
      }
      return;
    }
    this.db
      .prepare("INSERT INTO model_route_verifications (outcome_id, passed, verifier, recorded_at) VALUES (?, ?, ?, ?)")
      .run(input.outcomeId, input.passed ? 1 : 0, input.verifier, input.recordedAt);
  }

  stats(providerId: string, model: string, taskType: string, policy: RoutingPolicy, now: Date): EvidenceStats {
    const since = new Date(now.getTime() - policy.evidenceWindowMs).toISOString();
    const rows = this.db
      .prepare(
        `SELECT o.ok, o.failure_kind, o.latency_ms, o.cost_micro_usd, v.passed
         FROM model_route_outcomes o LEFT JOIN model_route_verifications v ON v.outcome_id = o.outcome_id
         WHERE o.provider_id = ? AND o.model = ? AND o.task_type = ? AND o.recorded_at >= ?
         ORDER BY o.recorded_at DESC, o.outcome_id DESC LIMIT ?`
      )
      .all(providerId, model, taskType, since, STATS_ROW_LIMIT) as Array<{
      ok: number;
      failure_kind: string | null;
      latency_ms: number | null;
      cost_micro_usd: number | null;
      passed: number | null;
    }>;
    const verified = rows.filter((r) => r.passed !== null);
    const passed = verified.filter((r) => r.passed === 1).length;
    const latencies = rows
      .filter((r) => r.ok === 1 && r.latency_ms !== null)
      .map((r) => r.latency_ms!)
      .sort((a, b) => a - b);
    const costs = rows.filter((r) => r.ok === 1 && r.cost_micro_usd !== null).map((r) => r.cost_micro_usd!);
    return {
      attempts: rows.length,
      providerFailures: rows.filter((r) => r.failure_kind === "provider").length,
      verified: verified.length,
      verifiedPassed: passed,
      ...(verified.length >= policy.minSamples ? { correctnessLowerBound: wilsonLowerBound(passed, verified.length) } : {}),
      ...(latencies.length > 0 ? { latencyP50Ms: percentile(latencies, 50)!, latencyP95Ms: percentile(latencies, 95)! } : {}),
      ...(costs.length > 0 ? { meanCostMicroUsd: costs.reduce((a, b) => a + b, 0) / costs.length } : {}),
      costReportedFor: costs.length
    };
  }

  circuit(providerId: string, policy: RoutingPolicy, now: Date): CircuitState {
    const rows = this.db
      .prepare(
        `SELECT ok, failure_kind, recorded_at FROM model_route_outcomes WHERE provider_id = ?
         ORDER BY recorded_at DESC, outcome_id DESC LIMIT ?`
      )
      .all(providerId, Math.max(policy.circuit.failureThreshold * 2, 10)) as Array<{
      ok: number;
      failure_kind: "provider" | "request" | null;
      recorded_at: string;
    }>;
    const outcomes: OutcomeForCircuit[] = rows.map((r) => ({ ok: r.ok === 1, failureKind: r.failure_kind, recordedAt: r.recorded_at }));
    return circuitState(outcomes, policy, now);
  }
}
