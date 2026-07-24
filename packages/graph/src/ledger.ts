import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { stableHash } from "@agent-control-stack/shared";
import {
  redactGraphDefinition,
  redactGraphValue,
  redactJsonValue,
  redactNodeExecutionResult,
  graphJsonBoundsError,
  nodeExecutionResultSchema,
  validateJsonSchema,
  type GraphDefinition,
  type GraphNodeState,
  type GraphRunState,
  type GraphVerdict,
  type JsonValue,
  type NodeExecutionResult
} from "./contract.js";
import type { ValidatedGraph } from "./validator.js";
import {
  configureGraphLedgerDatabase,
  migrateGraphLedgerDatabase,
  validateGraphLedgerSchemaVersion
} from "./migrations.js";
import { calculateGraphVerdict } from "./verdict.js";

const TERMINAL_NODE_STATES = new Set<GraphNodeState>(["SUCCEEDED", "FAILED", "BLOCKED", "SKIPPED", "CANCELLED"]);

const NODE_TRANSITIONS: Readonly<Record<GraphNodeState, readonly GraphNodeState[]>> = {
  PENDING: ["READY", "BLOCKED", "CANCELLED"],
  READY: ["RUNNING", "FAILED", "BLOCKED", "CANCELLED"],
  RUNNING: ["READY", "SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED"],
  SUCCEEDED: [],
  FAILED: [],
  BLOCKED: [],
  SKIPPED: [],
  CANCELLED: []
};

const RUN_TRANSITIONS: Readonly<Record<GraphRunState, readonly GraphRunState[]>> = {
  PENDING: ["RUNNING", "BLOCKED"],
  RUNNING: ["SUCCEEDED", "FAILED", "BLOCKED"],
  SUCCEEDED: [],
  FAILED: [],
  BLOCKED: [],
  CANCELLED: []
};

export class GraphLedgerInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphLedgerInvariantError";
  }
}

export class GraphLedgerWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GraphLedgerWriteError";
  }
}

export class GraphBudgetAdmissionError extends Error {
  constructor(
    message: string,
    public readonly temporary = false
  ) {
    super(message);
    this.name = "GraphBudgetAdmissionError";
  }
}

export class GraphSchedulerLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphSchedulerLeaseError";
  }
}

export interface GraphSchedulerLeaseRecord {
  runId: string;
  ownerId: string;
  leaseEpoch: number;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface RunLeaseToken {
  runId: string;
  ownerId: string;
  epoch: number;
}

export interface GraphRunBudgetRecord {
  runId: string;
  tokenCeiling: number;
  dollarCeilingUsd: number;
  apiConcurrency: number;
  usedTokens: number;
  usedCostUsd: number;
  reservedTokens: number;
  reservedCostUsd: number;
  activeApiReservations: number;
}

export interface GraphBudgetReservationRecord {
  reservationId: string;
  runId: string;
  nodeId: string;
  attemptNumber: number;
  maxTokens: number;
  maxCostUsd: number;
  apiSlots: number;
  actualTokens: number | null;
  actualCostUsd: number | null;
  state: "RESERVED" | "SETTLED" | "RELEASED";
  createdAt: string;
  settledAt: string | null;
}

export interface GraphRunRecord {
  runId: string;
  graphId: string;
  graphHash: string;
  definition: GraphDefinition;
  requestedBy: GraphDefinition["requested_by"];
  intent: string;
  risk: GraphDefinition["risk"];
  idempotencyKey: string;
  correlationId: string;
  state: GraphRunState;
  verdict: GraphVerdict | null;
  verdictSummary: unknown | null;
  createdAt: string;
  updatedAt: string;
}

export interface GraphIdempotencyDecisionRecord {
  decisionId: number;
  idempotencyKey: string;
  runId: string;
  graphHash: string;
  decision: "ADMITTED" | "DEDUPLICATED" | "REJECTED_CONFLICT";
  decidedAt: string;
}

export interface GraphRunAdmission {
  run: GraphRunRecord;
  decision: "ADMITTED" | "DEDUPLICATED";
}

export interface GraphNodeRecord {
  runId: string;
  nodeId: string;
  state: GraphNodeState;
  required: boolean;
  sideEffect: GraphDefinition["nodes"][number]["sideEffect"];
  adapter: string;
  attemptCount: number;
  result: NodeExecutionResult | null;
  outputHash: string | null;
  error: unknown | null;
  updatedAt: string;
}

export interface GraphAttemptRecord {
  attemptId: string;
  runId: string;
  nodeId: string;
  attemptNumber: number;
  state: GraphNodeState;
  inputHash: string;
  result: NodeExecutionResult | null;
  outputHash: string | null;
  error: unknown | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface GraphTransitionRecord {
  sequence: number;
  runId: string;
  entityType: "RUN" | "NODE";
  nodeId: string | null;
  fromState: GraphNodeState | null;
  toState: GraphNodeState;
  reason: string;
  attemptId: string | null;
  at: string;
  previousHash: string | null;
  transitionHash: string;
}

interface RunRow {
  run_id: string;
  graph_id: string;
  graph_hash: string;
  definition_json: string;
  requested_by_json: string;
  intent: string;
  risk: GraphRunRecord["risk"];
  idempotency_key: string;
  correlation_id: string;
  state: GraphRunState;
  verdict: GraphVerdict | null;
  verdict_summary_json: string | null;
  created_at: string;
  updated_at: string;
}

interface IdempotencyDecisionRow {
  decision_id: number;
  idempotency_key: string;
  run_id: string;
  graph_hash: string;
  decision: GraphIdempotencyDecisionRecord["decision"];
  decided_at: string;
}

interface NodeRow {
  run_id: string;
  node_id: string;
  state: GraphNodeState;
  required: number;
  side_effect: GraphNodeRecord["sideEffect"];
  adapter: string;
  attempt_count: number;
  result_json: string | null;
  output_hash: string | null;
  error_json: string | null;
  updated_at: string;
}

interface AttemptRow {
  attempt_id: string;
  run_id: string;
  node_id: string;
  attempt_number: number;
  state: GraphNodeState;
  input_hash: string;
  result_json: string | null;
  output_hash: string | null;
  error_json: string | null;
  started_at: string;
  finished_at: string | null;
}

interface TransitionRow {
  sequence: number;
  run_id: string;
  entity_type: "RUN" | "NODE";
  node_id: string | null;
  from_state: GraphNodeState | null;
  to_state: GraphNodeState;
  reason: string;
  attempt_id: string | null;
  at: string;
  previous_hash: string | null;
  transition_hash: string;
}

interface RunBudgetRow {
  run_id: string;
  token_ceiling: number;
  dollar_ceiling_usd: number;
  api_concurrency: number;
  used_tokens: number;
  used_cost_usd: number;
  reserved_tokens: number;
  reserved_cost_usd: number;
  active_api_reservations: number;
}

interface BudgetReservationRow {
  reservation_id: string;
  run_id: string;
  node_id: string;
  attempt_number: number;
  max_tokens: number;
  max_cost_usd: number;
  api_slots: number;
  actual_tokens: number | null;
  actual_cost_usd: number | null;
  state: GraphBudgetReservationRecord["state"];
  created_at: string;
  settled_at: string | null;
}

interface SchedulerLeaseRow {
  run_id: string;
  owner_id: string;
  lease_epoch: number;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
}

export class SqliteGraphLedger {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    try {
      configureGraphLedgerDatabase(this.database);
      migrateGraphLedgerDatabase(this.database);
      validateGraphLedgerSchemaVersion(this.database);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  createRun(graph: ValidatedGraph, runId: string = randomUUID()): GraphRunRecord {
    return this.createRunWithAdmission(graph, runId).run;
  }

  createRunWithAdmission(graph: ValidatedGraph, runId: string = randomUUID()): GraphRunAdmission {
    assertRunIdentifier(runId);
    const now = new Date().toISOString();
    const persistedDefinition = redactGraphDefinition(graph.definition);
    const persistedGraphHash = stableHash(persistedDefinition);
    if (persistedGraphHash !== graph.graphHash) {
      throw new GraphLedgerInvariantError("validated graph hash does not match its redacted durable projection");
    }
    let existingRunId: string | null = null;
    let conflictingRunId: string | null = null;
    let admissionDecision: GraphRunAdmission["decision"] = "ADMITTED";
    this.transaction(() => {
      const existing = this.database
        .prepare("SELECT run_id, graph_hash FROM graph_runs WHERE idempotency_key = ?")
        .get(graph.definition.idempotency_key) as unknown as { run_id: string; graph_hash: string } | undefined;
      if (existing) {
        existingRunId = existing.run_id;
        const decision = existing.graph_hash === graph.graphHash ? "DEDUPLICATED" : "REJECTED_CONFLICT";
        this.database
          .prepare(
            `INSERT INTO graph_idempotency_decisions
              (idempotency_key, run_id, graph_hash, decision, decided_at)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(graph.definition.idempotency_key, existing.run_id, graph.graphHash, decision, now);
        if (decision === "REJECTED_CONFLICT") {
          conflictingRunId = existing.run_id;
        } else {
          admissionDecision = "DEDUPLICATED";
        }
        return;
      }
      this.database
        .prepare(
          `INSERT INTO graph_runs
            (run_id, graph_id, graph_hash, definition_json, requested_by_json, intent, risk,
             idempotency_key, correlation_id, state, verdict, verdict_summary_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, NULL, ?, ?)`
        )
        .run(
          runId,
          graph.definition.graphId,
          graph.graphHash,
          JSON.stringify(persistedDefinition),
          JSON.stringify(persistedDefinition.requested_by),
          persistedDefinition.intent,
          persistedDefinition.risk,
          persistedDefinition.idempotency_key,
          persistedDefinition.correlation_id,
          now,
          now
        );
      this.database
        .prepare(
          `INSERT INTO graph_idempotency_decisions
            (idempotency_key, run_id, graph_hash, decision, decided_at)
           VALUES (?, ?, ?, 'ADMITTED', ?)`
        )
        .run(graph.definition.idempotency_key, runId, graph.graphHash, now);
      this.database
        .prepare(
          `INSERT INTO graph_run_budgets
            (run_id, token_ceiling, dollar_ceiling_usd, api_concurrency,
             used_tokens, used_cost_usd, reserved_tokens, reserved_cost_usd, active_api_reservations)
           VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0)`
        )
        .run(
          runId,
          graph.definition.limits.tokenCeiling,
          graph.definition.limits.dollarCeilingUsd,
          graph.definition.limits.apiConcurrency
        );
      this.appendTransition(runId, "RUN", null, null, "PENDING", "run admitted", null, now);

      for (const node of graph.definition.nodes) {
        this.database
          .prepare(
            `INSERT INTO graph_nodes
              (run_id, node_id, state, required, side_effect, adapter, attempt_count, result_json, output_hash, error_json, updated_at)
             VALUES (?, ?, 'PENDING', ?, ?, ?, 0, NULL, NULL, NULL, ?)`
          )
          .run(runId, node.id, node.required ? 1 : 0, node.sideEffect, node.adapter, now);
        this.appendTransition(runId, "NODE", node.id, null, "PENDING", "node admitted", null, now);
      }
    });
    if (conflictingRunId) {
      throw new GraphLedgerInvariantError(
        `idempotency key ${graph.definition.idempotency_key} conflicts with admitted graph run ${conflictingRunId}`
      );
    }
    return { run: this.getRun(existingRunId ?? runId), decision: admissionDecision };
  }

  getRun(runId: string): GraphRunRecord {
    const row = this.database.prepare("SELECT * FROM graph_runs WHERE run_id = ?").get(runId) as unknown as
      RunRow | undefined;
    if (!row) {
      throw new GraphLedgerInvariantError(`unknown graph run ${runId}`);
    }
    return mapRun(row);
  }

  acquireSchedulerLease(
    runId: string,
    ownerId: string,
    ttlMs: number,
    now: Date = new Date()
  ): { lease: GraphSchedulerLeaseRecord; recovered: boolean } {
    assertRunIdentifier(runId);
    assertOwnerIdentifier(ownerId);
    const { nowIso, expiresIso } = leaseTimes(ownerId, ttlMs, now);
    return this.transaction(() => {
      this.getRun(runId);
      const existing = this.getSchedulerLease(runId);
      if (!existing) {
        this.database
          .prepare(
            `INSERT INTO graph_scheduler_leases
              (run_id, owner_id, lease_epoch, acquired_at, heartbeat_at, expires_at)
             VALUES (?, ?, 1, ?, ?, ?)`
          )
          .run(runId, ownerId, nowIso, nowIso, expiresIso);
        return { lease: this.requireSchedulerLease(runId), recovered: false };
      }
      if (existing.expiresAt > nowIso) {
        throw new GraphSchedulerLeaseError(
          `graph run ${runId} is actively owned by ${existing.ownerId} through ${existing.expiresAt}`
        );
      }
      const recovered = this.database
        .prepare(
          `UPDATE graph_scheduler_leases
           SET owner_id = ?, lease_epoch = lease_epoch + 1, acquired_at = ?, heartbeat_at = ?, expires_at = ?
           WHERE run_id = ? AND lease_epoch = ? AND expires_at <= ?`
        )
        .run(ownerId, nowIso, nowIso, expiresIso, runId, existing.leaseEpoch, nowIso);
      if (Number(recovered.changes) !== 1) {
        throw new GraphSchedulerLeaseError(`expired owner recovery lost its race for graph run ${runId}`);
      }
      return { lease: this.requireSchedulerLease(runId), recovered: true };
    });
  }

  getSchedulerLease(runId: string): GraphSchedulerLeaseRecord | null {
    const row = this.database.prepare("SELECT * FROM graph_scheduler_leases WHERE run_id = ?").get(runId) as unknown as
      SchedulerLeaseRow | undefined;
    return row ? mapSchedulerLease(row) : null;
  }

  assertSchedulerLease(runId: string, ownerId: string, leaseEpoch: number, now: Date = new Date()): void {
    const nowIso = validDateIso(now);
    const lease = this.getSchedulerLease(runId);
    if (!lease || lease.ownerId !== ownerId || lease.leaseEpoch !== leaseEpoch || lease.expiresAt <= nowIso) {
      throw new GraphSchedulerLeaseError(`scheduler owner ${ownerId}/${leaseEpoch} does not hold graph run ${runId}`);
    }
  }

  heartbeatSchedulerLease(
    runId: string,
    ownerId: string,
    leaseEpoch: number,
    ttlMs: number,
    now: Date = new Date()
  ): GraphSchedulerLeaseRecord {
    const { nowIso, expiresIso } = leaseTimes(ownerId, ttlMs, now);
    return this.transaction(() => {
      const renewed = this.database
        .prepare(
          `UPDATE graph_scheduler_leases
           SET heartbeat_at = ?, expires_at = ?
           WHERE run_id = ? AND owner_id = ? AND lease_epoch = ? AND expires_at > ?`
        )
        .run(nowIso, expiresIso, runId, ownerId, leaseEpoch, nowIso);
      if (Number(renewed.changes) !== 1) {
        throw new GraphSchedulerLeaseError(`scheduler owner ${ownerId}/${leaseEpoch} cannot renew graph run ${runId}`);
      }
      return this.requireSchedulerLease(runId);
    });
  }

  releaseSchedulerLease(lease: RunLeaseToken): void {
    this.transaction(() => {
      this.assertSchedulerLeaseToken(lease);
      const released = this.database
        .prepare(
          `DELETE FROM graph_scheduler_leases
           WHERE run_id = ? AND owner_id = ? AND lease_epoch = ? AND expires_at > ?`
        )
        .run(lease.runId, lease.ownerId, lease.epoch, new Date().toISOString());
      if (Number(released.changes) !== 1) {
        throw new GraphSchedulerLeaseError(
          `scheduler owner ${lease.ownerId}/${lease.epoch} cannot release graph run ${lease.runId}`
        );
      }
    });
  }

  getNode(runId: string, nodeId: string): GraphNodeRecord {
    const row = this.database
      .prepare("SELECT * FROM graph_nodes WHERE run_id = ? AND node_id = ?")
      .get(runId, nodeId) as unknown as NodeRow | undefined;
    if (!row) {
      throw new GraphLedgerInvariantError(`unknown graph node ${runId}/${nodeId}`);
    }
    return mapNode(row);
  }

  listNodes(runId: string): GraphNodeRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM graph_nodes WHERE run_id = ? ORDER BY rowid")
      .all(runId) as unknown as NodeRow[];
    return rows.map(mapNode);
  }

  listIdempotencyDecisions(idempotencyKey?: string): GraphIdempotencyDecisionRecord[] {
    const rows = (idempotencyKey
      ? this.database
          .prepare("SELECT * FROM graph_idempotency_decisions WHERE idempotency_key = ? ORDER BY decision_id")
          .all(idempotencyKey)
      : this.database
          .prepare("SELECT * FROM graph_idempotency_decisions ORDER BY decision_id")
          .all()) as unknown as IdempotencyDecisionRow[];
    return rows.map(mapIdempotencyDecision);
  }

  transitionRun(
    lease: RunLeaseToken,
    toState: GraphRunState,
    reason: string,
    outcome?: { verdict: GraphVerdict; summary: unknown }
  ): void {
    this.transaction(() => {
      this.assertSchedulerLeaseToken(lease);
      const runId = lease.runId;
      const run = this.getRun(runId);
      assertTransition("run", run.state, toState, RUN_TRANSITIONS);
      if (isVerdictRunState(toState)) {
        assertTerminalRunOutcome(run, toState, outcome, this.listNodes(runId));
      }
      const now = new Date().toISOString();
      this.database
        .prepare(
          `UPDATE graph_runs
           SET state = ?, verdict = ?, verdict_summary_json = ?, updated_at = ?
           WHERE run_id = ?`
        )
        .run(
          toState,
          outcome?.verdict ?? run.verdict,
          outcome
            ? JSON.stringify(redactGraphValue(outcome.summary))
            : run.verdictSummary === null
              ? null
              : JSON.stringify(redactGraphValue(run.verdictSummary)),
          now,
          runId
        );
      this.appendTransition(runId, "RUN", null, run.state, toState, reason, null, now);
    });
  }

  transitionNode(lease: RunLeaseToken, nodeId: string, toState: GraphNodeState, reason: string): void {
    this.transaction(() => {
      this.assertSchedulerLeaseToken(lease);
      const runId = lease.runId;
      const run = this.getRun(runId);
      assertRunIsRunning(run);
      const node = this.getNode(runId, nodeId);
      assertTransition("node", node.state, toState, NODE_TRANSITIONS);
      if (toState === "READY") {
        const definition = run.definition.nodes.find((candidate) => candidate.id === nodeId);
        if (!definition) {
          throw new GraphLedgerInvariantError(`persisted definition lacks node ${runId}/${nodeId}`);
        }
        this.assertNodeReadyForExecution(runId, definition);
      }
      if (toState === "RUNNING") {
        throw new GraphLedgerInvariantError("node RUNNING state requires an atomic attempt reservation");
      }
      const now = new Date().toISOString();
      const terminalError =
        toState === "FAILED" || toState === "BLOCKED"
          ? JSON.stringify(redactGraphValue({ code: "NODE_TRANSITION", message: reason }))
          : null;
      this.database
        .prepare("UPDATE graph_nodes SET state = ?, error_json = ?, updated_at = ? WHERE run_id = ? AND node_id = ?")
        .run(toState, terminalError, now, runId, nodeId);
      this.appendTransition(runId, "NODE", nodeId, node.state, toState, reason, null, now);
    });
  }

  startAttempt(
    lease: RunLeaseToken,
    nodeId: string,
    inputHash?: string,
    budget?: GraphDefinition["nodes"][number]["budget"]
  ): { attemptId: string; attemptNumber: number; reservationId: string; inputHash: string } {
    return this.transaction(() => {
      this.assertSchedulerLeaseToken(lease);
      const runId = lease.runId;
      const run = this.getRun(runId);
      assertRunIsRunning(run);
      const node = this.getNode(runId, nodeId);
      const persistedDefinition = run.definition;
      const nodeDefinition = persistedDefinition.nodes.find((candidate) => candidate.id === nodeId);
      if (!nodeDefinition) {
        throw new GraphLedgerInvariantError(`persisted definition lacks node ${runId}/${nodeId}`);
      }
      this.assertNodeReadyForExecution(runId, nodeDefinition);
      if (node.attemptCount >= nodeDefinition.retry.maxAttempts) {
        throw new GraphLedgerInvariantError(`node ${runId}/${nodeId} has exhausted its retry budget`);
      }
      const expectedInputHash = this.calculateAttemptInputHash(runId, nodeDefinition);
      if (inputHash !== undefined && inputHash !== expectedInputHash) {
        throw new GraphLedgerInvariantError(
          `attempt input hash does not match the admitted inputs for ${runId}/${nodeId}`
        );
      }
      const admittedBudget = nodeDefinition.budget;
      if (
        budget !== undefined &&
        (budget.maxTokens !== admittedBudget.maxTokens ||
          budget.maxCostUsd !== admittedBudget.maxCostUsd ||
          budget.apiSlots !== admittedBudget.apiSlots)
      ) {
        throw new GraphLedgerInvariantError(`attempt budget does not match the admitted budget for ${runId}/${nodeId}`);
      }
      const reservationBudget = admittedBudget;
      assertTransition("node", node.state, "RUNNING", NODE_TRANSITIONS);
      const attemptId = randomUUID();
      const reservationId = randomUUID();
      const attemptNumber = node.attemptCount + 1;
      const now = new Date().toISOString();
      const admitted = this.database
        .prepare(
          `UPDATE graph_run_budgets
           SET reserved_tokens = reserved_tokens + ?,
               reserved_cost_usd = reserved_cost_usd + ?,
               active_api_reservations = active_api_reservations + ?
           WHERE run_id = ?
             AND used_tokens <= token_ceiling
             AND used_tokens + reserved_tokens + ? <= token_ceiling
             AND used_cost_usd <= dollar_ceiling_usd
             AND used_cost_usd + reserved_cost_usd + ? <= dollar_ceiling_usd
             AND active_api_reservations + ? <= api_concurrency`
        )
        .run(
          reservationBudget.maxTokens,
          reservationBudget.maxCostUsd,
          reservationBudget.apiSlots,
          runId,
          reservationBudget.maxTokens,
          reservationBudget.maxCostUsd,
          reservationBudget.apiSlots
        );
      if (Number(admitted.changes) !== 1) {
        const currentBudget = this.database
          .prepare("SELECT * FROM graph_run_budgets WHERE run_id = ?")
          .get(runId) as unknown as RunBudgetRow | undefined;
        if (!currentBudget) {
          throw new GraphLedgerInvariantError(`missing budget record for graph run ${runId}`);
        }
        const permanentlyTooLarge =
          currentBudget.used_tokens + reservationBudget.maxTokens > currentBudget.token_ceiling ||
          currentBudget.used_cost_usd + reservationBudget.maxCostUsd > currentBudget.dollar_ceiling_usd ||
          reservationBudget.apiSlots > currentBudget.api_concurrency;
        const temporarilyContended =
          !permanentlyTooLarge &&
          (currentBudget.used_tokens + currentBudget.reserved_tokens + reservationBudget.maxTokens >
            currentBudget.token_ceiling ||
            currentBudget.used_cost_usd + currentBudget.reserved_cost_usd + reservationBudget.maxCostUsd >
              currentBudget.dollar_ceiling_usd ||
            currentBudget.active_api_reservations + reservationBudget.apiSlots > currentBudget.api_concurrency);
        throw new GraphBudgetAdmissionError(
          `budget reservation denied for ${runId}/${nodeId} attempt ${attemptNumber}`,
          temporarilyContended
        );
      }
      this.database
        .prepare(
          `INSERT INTO graph_budget_reservations
            (reservation_id, run_id, node_id, attempt_number, max_tokens, max_cost_usd, api_slots,
             actual_tokens, actual_cost_usd, state, created_at, settled_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'RESERVED', ?, NULL)`
        )
        .run(
          reservationId,
          runId,
          nodeId,
          attemptNumber,
          reservationBudget.maxTokens,
          reservationBudget.maxCostUsd,
          reservationBudget.apiSlots,
          now
        );
      this.database
        .prepare(
          `INSERT INTO graph_attempts
            (attempt_id, run_id, node_id, attempt_number, state, input_hash, result_json, output_hash, error_json, started_at, finished_at)
           VALUES (?, ?, ?, ?, 'RUNNING', ?, NULL, NULL, NULL, ?, NULL)`
        )
        .run(attemptId, runId, nodeId, attemptNumber, expectedInputHash, now);
      this.database
        .prepare(
          `UPDATE graph_nodes
           SET state = 'RUNNING', attempt_count = ?, result_json = NULL, output_hash = NULL, error_json = NULL, updated_at = ?
           WHERE run_id = ? AND node_id = ?`
        )
        .run(attemptNumber, now, runId, nodeId);
      this.appendTransition(runId, "NODE", nodeId, node.state, "RUNNING", "attempt started", attemptId, now);
      return { attemptId, attemptNumber, reservationId, inputHash: expectedInputHash };
    });
  }

  completeAttempt(input: {
    lease: RunLeaseToken;
    nodeId: string;
    attemptId: string;
    state: "SUCCEEDED" | "FAILED" | "BLOCKED";
    result?: NodeExecutionResult;
    outputHash?: string;
    error?: unknown;
    retryable?: boolean;
  }): boolean {
    return this.transaction(() => {
      this.assertSchedulerLeaseToken(input.lease);
      if (input.result === undefined && input.error === undefined) {
        throw new GraphLedgerInvariantError("a terminal attempt requires a result or structured error");
      }
      const runId = input.lease.runId;
      const run = this.getRun(runId);
      assertRunIsRunning(run);
      const node = this.getNode(runId, input.nodeId);
      const attempt = this.database
        .prepare("SELECT * FROM graph_attempts WHERE attempt_id = ? AND run_id = ? AND node_id = ?")
        .get(input.attemptId, runId, input.nodeId) as unknown as AttemptRow | undefined;
      if (!attempt || attempt.state !== "RUNNING") {
        throw new GraphLedgerInvariantError(`attempt ${input.attemptId} is not active for ${runId}/${input.nodeId}`);
      }
      const persistedDefinition = run.definition;
      const nodeDefinition = persistedDefinition.nodes.find((candidate) => candidate.id === input.nodeId);
      if (!nodeDefinition) {
        throw new GraphLedgerInvariantError(`persisted definition lacks node ${runId}/${input.nodeId}`);
      }
      const result = validateAttemptResult(nodeDefinition, input.result, input.state);
      const usage = result?.usage;
      const reservation = this.database
        .prepare(
          `SELECT max_tokens, max_cost_usd FROM graph_budget_reservations
           WHERE run_id = ? AND node_id = ? AND attempt_number = ? AND state = 'RESERVED'`
        )
        .get(runId, input.nodeId, attempt.attempt_number) as { max_tokens: number; max_cost_usd: number } | undefined;
      if (!reservation) {
        throw new GraphLedgerInvariantError(
          `active budget reservation is missing for ${runId}/${input.nodeId} attempt ${attempt.attempt_number}`
        );
      }
      const actualTokens = usage ? usage.inputTokens + usage.outputTokens : 0;
      const actualCostUsd = usage?.costUsd ?? 0;
      const overBudget =
        usage !== undefined && (actualTokens > reservation.max_tokens || actualCostUsd > reservation.max_cost_usd);
      const effectiveState: "SUCCEEDED" | "FAILED" | "BLOCKED" = overBudget ? "FAILED" : input.state;
      assertTransition("node", node.state, effectiveState, NODE_TRANSITIONS);
      if (!overBudget && input.result !== undefined && input.outputHash !== undefined) {
        const suppliedOutputHash = stableHash(input.result.output);
        if (input.outputHash !== suppliedOutputHash) {
          throw new GraphLedgerInvariantError(`output hash does not match result for ${runId}/${input.nodeId}`);
        }
      }
      const effectiveResult = overBudget ? undefined : result;
      const effectiveUsage = overBudget ? undefined : usage;
      const effectiveError = overBudget
        ? { code: "BUDGET_EXCEEDED", message: "reported usage exceeds the admitted node reservation" }
        : input.error;
      const shouldRetry =
        !overBudget &&
        effectiveState === "FAILED" &&
        (input.retryable === true || result?.retryable === true) &&
        attempt.attempt_number < nodeDefinition.retry.maxAttempts;
      const nextNodeState: GraphNodeState = shouldRetry ? "READY" : effectiveState;
      const now = new Date().toISOString();
      const persistedResult = effectiveResult === undefined ? undefined : redactNodeExecutionResult(effectiveResult);
      const resultJson = persistedResult === undefined ? null : JSON.stringify(persistedResult);
      const persistedOutputHash = persistedResult === undefined ? null : stableHash(persistedResult.output);
      const errorJson = effectiveError === undefined ? null : JSON.stringify(redactGraphValue(effectiveError));
      this.settleBudgetReservation(attempt, effectiveUsage);
      this.database
        .prepare(
          `UPDATE graph_attempts
           SET state = ?, result_json = ?, output_hash = ?, error_json = ?,
               input_tokens = ?, output_tokens = ?, cost_usd = ?, duration_ms = ?, finished_at = ?
           WHERE attempt_id = ?`
        )
        .run(
          effectiveState,
          resultJson,
          persistedOutputHash,
          errorJson,
          effectiveUsage?.inputTokens ?? null,
          effectiveUsage?.outputTokens ?? null,
          effectiveUsage?.costUsd ?? null,
          effectiveUsage?.durationMs ?? null,
          now,
          input.attemptId
        );
      this.database
        .prepare(
          `UPDATE graph_nodes
           SET state = ?, result_json = ?, output_hash = ?, error_json = ?, updated_at = ?
           WHERE run_id = ? AND node_id = ?`
        )
        .run(
          nextNodeState,
          shouldRetry ? null : resultJson,
          shouldRetry ? null : persistedOutputHash,
          shouldRetry
            ? JSON.stringify({
                code: "RETRY_SCHEDULED",
                message: redactGraphValue(input.error ?? "retryable node failure"),
                attemptNumber: attempt.attempt_number
              })
            : errorJson,
          now,
          runId,
          input.nodeId
        );
      this.appendTransition(
        runId,
        "NODE",
        input.nodeId,
        node.state,
        nextNodeState,
        shouldRetry
          ? `retryable attempt failed; retry ${attempt.attempt_number + 1} of ${nodeDefinition.retry.maxAttempts} scheduled`
          : overBudget
            ? "reported usage exceeded the admitted node reservation"
            : effectiveError === undefined
              ? "attempt completed"
              : "attempt failed",
        input.attemptId,
        now
      );
      return shouldRetry;
    });
  }

  reconcileInterruptedNode(lease: RunLeaseToken, nodeId: string): "REQUEUED" | "BLOCKED" {
    return this.transaction(() => {
      this.assertSchedulerLeaseToken(lease);
      const runId = lease.runId;
      const run = this.getRun(runId);
      assertRunIsRunning(run);
      const node = this.getNode(runId, nodeId);
      if (node.state !== "RUNNING") {
        throw new GraphLedgerInvariantError(`node ${runId}/${nodeId} is not interrupted`);
      }
      const attempt = this.database
        .prepare(
          "SELECT * FROM graph_attempts WHERE run_id = ? AND node_id = ? AND state = 'RUNNING' ORDER BY attempt_number DESC LIMIT 1"
        )
        .get(runId, nodeId) as unknown as AttemptRow | undefined;
      if (!attempt) {
        throw new GraphLedgerInvariantError(`node ${runId}/${nodeId} has no active attempt to reconcile`);
      }
      const mayRequeue = node.sideEffect === "NONE" || node.sideEffect === "READ_ONLY";
      const nextState: GraphNodeState = mayRequeue ? "READY" : "BLOCKED";
      const attemptState: GraphNodeState = mayRequeue ? "CANCELLED" : "BLOCKED";
      const reason = mayRequeue
        ? "interrupted side-effect-free attempt requeued"
        : "interrupted write-capable attempt requires manual reconciliation";
      const error = {
        code: mayRequeue ? "INTERRUPTED_ATTEMPT_REQUEUED" : "INTERRUPTED_WRITE_REQUIRES_RECONCILIATION",
        message: reason
      };
      const now = new Date().toISOString();
      this.settleBudgetReservation(attempt, undefined, now);
      this.database
        .prepare(
          `UPDATE graph_attempts
           SET state = ?, error_json = ?, finished_at = ?
           WHERE attempt_id = ?`
        )
        .run(attemptState, JSON.stringify(error), now, attempt.attempt_id);
      this.database
        .prepare(
          `UPDATE graph_nodes
           SET state = ?, result_json = NULL, output_hash = NULL, error_json = ?, updated_at = ?
           WHERE run_id = ? AND node_id = ?`
        )
        .run(nextState, JSON.stringify(error), now, runId, nodeId);
      this.appendTransition(runId, "NODE", nodeId, "RUNNING", nextState, reason, attempt.attempt_id, now);
      return mayRequeue ? "REQUEUED" : "BLOCKED";
    });
  }

  getRunBudget(runId: string): GraphRunBudgetRecord {
    const row = this.database.prepare("SELECT * FROM graph_run_budgets WHERE run_id = ?").get(runId) as unknown as
      RunBudgetRow | undefined;
    if (!row) {
      throw new GraphLedgerInvariantError(`missing budget record for graph run ${runId}`);
    }
    return mapRunBudget(row);
  }

  listBudgetReservations(runId: string): GraphBudgetReservationRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM graph_budget_reservations WHERE run_id = ? ORDER BY created_at, reservation_id")
      .all(runId) as unknown as BudgetReservationRow[];
    return rows.map(mapBudgetReservation);
  }

  listAttempts(runId: string, nodeId?: string): GraphAttemptRecord[] {
    const rows = (nodeId
      ? this.database
          .prepare("SELECT * FROM graph_attempts WHERE run_id = ? AND node_id = ? ORDER BY attempt_number")
          .all(runId, nodeId)
      : this.database
          .prepare("SELECT * FROM graph_attempts WHERE run_id = ? ORDER BY started_at, attempt_id")
          .all(runId)) as unknown as AttemptRow[];
    return rows.map(mapAttempt);
  }

  listTransitions(runId?: string): GraphTransitionRecord[] {
    const rows = (runId
      ? this.database.prepare("SELECT * FROM graph_transitions WHERE run_id = ? ORDER BY sequence").all(runId)
      : this.database.prepare("SELECT * FROM graph_transitions ORDER BY sequence").all()) as unknown as TransitionRow[];
    return rows.map(mapTransition);
  }

  verifyTransitionChain(): { valid: boolean; checked: number } {
    const transitions = this.listTransitions();
    let previousHash: string | null = null;
    let checked = 0;
    for (const transition of transitions) {
      checked += 1;
      const expected = transitionHash({
        runId: transition.runId,
        entityType: transition.entityType,
        nodeId: transition.nodeId,
        fromState: transition.fromState,
        toState: transition.toState,
        reason: transition.reason,
        attemptId: transition.attemptId,
        at: transition.at,
        previousHash
      });
      if (transition.previousHash !== previousHash || transition.transitionHash !== expected) {
        return { valid: false, checked };
      }
      previousHash = transition.transitionHash;
    }
    return { valid: true, checked };
  }

  private assertNodeReadyForExecution(runId: string, definition: GraphDefinition["nodes"][number]): void {
    if (definition.approval_required || definition.approval === "HUMAN") {
      throw new GraphLedgerInvariantError(`node ${runId}/${definition.id} requires approval before execution`);
    }
    const byId = new Map(this.listNodes(runId).map((node) => [node.nodeId, node]));
    const incoming = this.getRun(runId).definition.edges.filter((edge) => edge.to.nodeId === definition.id);
    if (
      !incoming.every((edge) => {
        const source = byId.get(edge.from.nodeId);
        return source !== undefined && isTerminalNodeState(source.state);
      })
    ) {
      throw new GraphLedgerInvariantError(`node ${runId}/${definition.id} has an incomplete dependency`);
    }
    if (
      incoming.some((edge) => {
        const source = byId.get(edge.from.nodeId);
        return edge.required && source?.state !== "SUCCEEDED";
      })
    ) {
      throw new GraphLedgerInvariantError(`node ${runId}/${definition.id} has a failed required dependency`);
    }
    if (
      definition.inputs.some(
        (port) =>
          port.required &&
          !incoming.some((edge) => edge.to.port === port.name && byId.get(edge.from.nodeId)?.state === "SUCCEEDED")
      )
    ) {
      throw new GraphLedgerInvariantError(`node ${runId}/${definition.id} is missing a successful required input`);
    }
  }

  private calculateAttemptInputHash(runId: string, definition: GraphDefinition["nodes"][number]): string {
    const run = this.getRun(runId);
    const inputs: Record<string, JsonValue[]> = {};
    for (const port of definition.inputs) {
      inputs[port.name] = [];
    }
    for (const edge of run.definition.edges.filter((candidate) => candidate.to.nodeId === definition.id)) {
      const source = this.getNode(runId, edge.from.nodeId);
      const parsed = nodeExecutionResultSchema.safeParse(source.result);
      if (!isTerminalNodeState(source.state)) {
        throw new GraphLedgerInvariantError(
          `successful dependency output is unavailable for ${runId}/${definition.id}`
        );
      }
      if (source.state !== "SUCCEEDED") continue;
      if (!parsed.success) {
        throw new GraphLedgerInvariantError(
          `successful dependency output is unavailable for ${runId}/${definition.id}`
        );
      }
      const value = parsed.data.output[edge.from.port];
      if (value === undefined) {
        throw new GraphLedgerInvariantError(
          `successful dependency output ${edge.from.nodeId}.${edge.from.port} is unavailable for ${runId}/${definition.id}`
        );
      }
      inputs[edge.to.port]!.push(value as JsonValue);
    }
    const payload: Record<string, unknown> = {
      graphHash: run.graphHash,
      nodeId: definition.id,
      parameters: redactGraphValue(definition.parameters),
      inputs: redactGraphValue(inputs)
    };
    if (definition.input !== undefined) {
      payload.input = redactJsonValue(definition.input);
    }
    return stableHash(payload);
  }

  private requireSchedulerLease(runId: string): GraphSchedulerLeaseRecord {
    const lease = this.getSchedulerLease(runId);
    if (!lease) {
      throw new GraphSchedulerLeaseError(`graph run ${runId} has no scheduler owner lease`);
    }
    return lease;
  }

  private assertSchedulerLeaseToken(token: RunLeaseToken): void {
    this.assertSchedulerLease(token.runId, token.ownerId, token.epoch);
  }

  private settleBudgetReservation(
    attempt: AttemptRow,
    usage: NodeExecutionResult["usage"] | undefined,
    settledAt: string = new Date().toISOString()
  ): void {
    const reservation = this.database
      .prepare(
        `SELECT * FROM graph_budget_reservations
         WHERE run_id = ? AND node_id = ? AND attempt_number = ?`
      )
      .get(attempt.run_id, attempt.node_id, attempt.attempt_number) as unknown as BudgetReservationRow | undefined;
    if (!reservation || reservation.state !== "RESERVED") {
      throw new GraphLedgerInvariantError(
        `active budget reservation is missing for ${attempt.run_id}/${attempt.node_id} attempt ${attempt.attempt_number}`
      );
    }

    const actualTokens = usage ? usage.inputTokens + usage.outputTokens : 0;
    const actualCostUsd = usage?.costUsd ?? 0;
    const budgetUpdate = this.database
      .prepare(
        `UPDATE graph_run_budgets
         SET reserved_tokens = reserved_tokens - ?,
             reserved_cost_usd = reserved_cost_usd - ?,
             active_api_reservations = active_api_reservations - ?,
             used_tokens = used_tokens + ?,
             used_cost_usd = used_cost_usd + ?
         WHERE run_id = ?
           AND reserved_tokens >= ?
           AND reserved_cost_usd >= ?
           AND active_api_reservations >= ?
           AND used_tokens + ? <= token_ceiling
           AND used_cost_usd + ? <= dollar_ceiling_usd`
      )
      .run(
        reservation.max_tokens,
        reservation.max_cost_usd,
        reservation.api_slots,
        actualTokens,
        actualCostUsd,
        attempt.run_id,
        reservation.max_tokens,
        reservation.max_cost_usd,
        reservation.api_slots,
        actualTokens,
        actualCostUsd
      );
    if (Number(budgetUpdate.changes) !== 1) {
      throw new GraphLedgerInvariantError(
        `budget counters cannot settle ${attempt.run_id}/${attempt.node_id} attempt ${attempt.attempt_number}`
      );
    }

    const reservationState: GraphBudgetReservationRecord["state"] = usage ? "SETTLED" : "RELEASED";
    const reservationUpdate = this.database
      .prepare(
        `UPDATE graph_budget_reservations
         SET state = ?, actual_tokens = ?, actual_cost_usd = ?, settled_at = ?
         WHERE reservation_id = ? AND state = 'RESERVED'`
      )
      .run(
        reservationState,
        usage ? actualTokens : null,
        usage ? actualCostUsd : null,
        settledAt,
        reservation.reservation_id
      );
    if (Number(reservationUpdate.changes) !== 1) {
      throw new GraphLedgerInvariantError(`budget reservation ${reservation.reservation_id} was already settled`);
    }
  }

  private appendTransition(
    runId: string,
    entityType: "RUN" | "NODE",
    nodeId: string | null,
    fromState: GraphNodeState | null,
    toState: GraphNodeState,
    reason: string,
    attemptId: string | null,
    at: string
  ): void {
    const persistedReason = String(redactGraphValue(reason));
    const previous = this.database
      .prepare("SELECT transition_hash FROM graph_transitions ORDER BY sequence DESC LIMIT 1")
      .get() as unknown as { transition_hash: string } | undefined;
    const previousHash = previous?.transition_hash ?? null;
    const hash = transitionHash({
      runId,
      entityType,
      nodeId,
      fromState,
      toState,
      reason: persistedReason,
      attemptId,
      at,
      previousHash
    });
    this.database
      .prepare(
        `INSERT INTO graph_transitions
          (run_id, entity_type, node_id, from_state, to_state, reason, attempt_id, at, previous_hash, transition_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(runId, entityType, nodeId, fromState, toState, persistedReason, attemptId, at, previousHash, hash);
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const integrity = this.verifyTransitionChain();
      if (!integrity.valid) {
        throw new GraphLedgerInvariantError(
          `graph transition chain is invalid at record ${integrity.checked}; writes are blocked`
        );
      }
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original write failure; a failed rollback is itself fail-closed.
      }
      if (
        error instanceof GraphLedgerInvariantError ||
        error instanceof GraphLedgerWriteError ||
        error instanceof GraphBudgetAdmissionError ||
        error instanceof GraphSchedulerLeaseError
      ) {
        throw error;
      }
      throw new GraphLedgerWriteError("graph ledger transaction rolled back", { cause: error });
    }
  }
}

function validateAttemptResult(
  definition: GraphDefinition["nodes"][number],
  value: NodeExecutionResult | undefined,
  expectedState: "SUCCEEDED" | "FAILED" | "BLOCKED"
): NodeExecutionResult | undefined {
  if (value === undefined) return undefined;
  const valueBoundsError = graphJsonBoundsError(value);
  if (valueBoundsError) {
    throw new GraphLedgerInvariantError(`attempt result exceeds the graph payload bounds: ${valueBoundsError}`);
  }
  const parsed = nodeExecutionResultSchema.safeParse(value);
  if (!parsed.success || parsed.data.status !== expectedState) {
    throw new GraphLedgerInvariantError("attempt result failed the admitted result contract");
  }
  const outputNames = Object.keys(parsed.data.output).sort();
  const declaredOutputNames = definition.outputs.map((port) => port.name).sort();
  if (parsed.data.status === "SUCCEEDED") {
    if (JSON.stringify(outputNames) !== JSON.stringify(declaredOutputNames)) {
      throw new GraphLedgerInvariantError("successful attempt output ports do not match the admitted node contract");
    }
    const durableResult = redactNodeExecutionResult(parsed.data);
    const schemaError = validateJsonSchema(definition.output_schema, durableResult.output, "$", true);
    if (schemaError) {
      throw new GraphLedgerInvariantError("successful attempt output failed the admitted output schema");
    }
    const evidenceKinds = new Set(parsed.data.evidence.map((evidence) => evidence.kind));
    if (definition.evidenceRequirements.some((kind) => !evidenceKinds.has(kind))) {
      throw new GraphLedgerInvariantError("successful attempt is missing required evidence");
    }
  } else if (outputNames.length > 0) {
    throw new GraphLedgerInvariantError("non-successful attempt must not claim output ports");
  }
  return parsed.data;
}

function isVerdictRunState(state: GraphRunState): state is "SUCCEEDED" | "FAILED" | "BLOCKED" {
  return state === "SUCCEEDED" || state === "FAILED" || state === "BLOCKED";
}

function runStateForVerdict(verdict: GraphVerdict): "SUCCEEDED" | "FAILED" | "BLOCKED" {
  return verdict === "PASS" ? "SUCCEEDED" : verdict === "BLOCK" ? "BLOCKED" : "FAILED";
}

function assertRunIsRunning(run: GraphRunRecord): void {
  if (run.state !== "RUNNING") {
    throw new GraphLedgerInvariantError(`graph run ${run.runId} must be RUNNING for a scheduler mutation`);
  }
}

function assertTerminalRunOutcome(
  run: GraphRunRecord,
  toState: "SUCCEEDED" | "FAILED" | "BLOCKED",
  outcome: { verdict: GraphVerdict; summary: unknown } | undefined,
  nodes: readonly GraphNodeRecord[]
): void {
  if (!outcome) {
    throw new GraphLedgerInvariantError(`terminal graph run ${run.runId} requires a verdict outcome`);
  }
  if (!nodes.every((node) => isTerminalNodeState(node.state))) {
    throw new GraphLedgerInvariantError(`terminal graph run ${run.runId} requires every node to be terminal`);
  }
  const expected = calculateGraphVerdict(run.definition, nodes);
  if (outcome.verdict !== expected.verdict || runStateForVerdict(expected.verdict) !== toState) {
    throw new GraphLedgerInvariantError(`terminal graph run ${run.runId} verdict does not match its node states`);
  }
  if (stableHash(redactGraphValue(outcome.summary)) !== stableHash(redactGraphValue(expected))) {
    throw new GraphLedgerInvariantError(`terminal graph run ${run.runId} summary does not match its node states`);
  }
}

function assertTransition<State extends string>(
  entity: "run" | "node",
  from: State,
  to: State,
  allowed: Readonly<Record<State, readonly State[]>>
): void {
  if (!allowed[from].includes(to)) {
    throw new GraphLedgerInvariantError(`invalid ${entity} transition ${from} -> ${to}`);
  }
}

function transitionHash(input: Omit<GraphTransitionRecord, "sequence" | "transitionHash">): string {
  return stableHash(input);
}

function parseJson(value: string | null): unknown | null {
  return value === null ? null : (JSON.parse(value) as unknown);
}

function validDateIso(value: Date): string {
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new GraphSchedulerLeaseError("scheduler lease time must be a valid date");
  }
  return new Date(milliseconds).toISOString();
}

function leaseTimes(ownerId: string, ttlMs: number, now: Date): { nowIso: string; expiresIso: string } {
  assertOwnerIdentifier(ownerId);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new GraphSchedulerLeaseError("scheduler lease TTL must be a positive integer number of milliseconds");
  }
  const nowIso = validDateIso(now);
  const expiresIso = validDateIso(new Date(now.getTime() + ttlMs));
  return { nowIso, expiresIso };
}

function assertRunIdentifier(runId: string): void {
  if (!isCredentialFreeIdentifier(runId)) {
    throw new GraphLedgerInvariantError("graph run ID must be a bounded credential-free identifier");
  }
}

function assertOwnerIdentifier(ownerId: string): void {
  if (!isCredentialFreeIdentifier(ownerId)) {
    throw new GraphSchedulerLeaseError("scheduler owner ID must be a bounded credential-free identifier");
  }
}

function isCredentialFreeIdentifier(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value) &&
    redactGraphValue(value) === value
  );
}

function mapSchedulerLease(row: SchedulerLeaseRow): GraphSchedulerLeaseRecord {
  return {
    runId: row.run_id,
    ownerId: row.owner_id,
    leaseEpoch: row.lease_epoch,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at
  };
}

function mapRun(row: RunRow): GraphRunRecord {
  return {
    runId: row.run_id,
    graphId: row.graph_id,
    graphHash: row.graph_hash,
    definition: JSON.parse(row.definition_json) as GraphDefinition,
    requestedBy: JSON.parse(row.requested_by_json) as GraphDefinition["requested_by"],
    intent: row.intent,
    risk: row.risk,
    idempotencyKey: row.idempotency_key,
    correlationId: row.correlation_id,
    state: row.state,
    verdict: row.verdict,
    verdictSummary: parseJson(row.verdict_summary_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapIdempotencyDecision(row: IdempotencyDecisionRow): GraphIdempotencyDecisionRecord {
  return {
    decisionId: row.decision_id,
    idempotencyKey: row.idempotency_key,
    runId: row.run_id,
    graphHash: row.graph_hash,
    decision: row.decision,
    decidedAt: row.decided_at
  };
}

function mapNode(row: NodeRow): GraphNodeRecord {
  return {
    runId: row.run_id,
    nodeId: row.node_id,
    state: row.state,
    required: row.required === 1,
    sideEffect: row.side_effect,
    adapter: row.adapter,
    attemptCount: row.attempt_count,
    result: parseJson(row.result_json) as NodeExecutionResult | null,
    outputHash: row.output_hash,
    error: parseJson(row.error_json),
    updatedAt: row.updated_at
  };
}

function mapRunBudget(row: RunBudgetRow): GraphRunBudgetRecord {
  return {
    runId: row.run_id,
    tokenCeiling: row.token_ceiling,
    dollarCeilingUsd: row.dollar_ceiling_usd,
    apiConcurrency: row.api_concurrency,
    usedTokens: row.used_tokens,
    usedCostUsd: row.used_cost_usd,
    reservedTokens: row.reserved_tokens,
    reservedCostUsd: row.reserved_cost_usd,
    activeApiReservations: row.active_api_reservations
  };
}

function mapBudgetReservation(row: BudgetReservationRow): GraphBudgetReservationRecord {
  return {
    reservationId: row.reservation_id,
    runId: row.run_id,
    nodeId: row.node_id,
    attemptNumber: row.attempt_number,
    maxTokens: row.max_tokens,
    maxCostUsd: row.max_cost_usd,
    apiSlots: row.api_slots,
    actualTokens: row.actual_tokens,
    actualCostUsd: row.actual_cost_usd,
    state: row.state,
    createdAt: row.created_at,
    settledAt: row.settled_at
  };
}

function mapAttempt(row: AttemptRow): GraphAttemptRecord {
  return {
    attemptId: row.attempt_id,
    runId: row.run_id,
    nodeId: row.node_id,
    attemptNumber: row.attempt_number,
    state: row.state,
    inputHash: row.input_hash,
    result: parseJson(row.result_json) as NodeExecutionResult | null,
    outputHash: row.output_hash,
    error: parseJson(row.error_json),
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}

function mapTransition(row: TransitionRow): GraphTransitionRecord {
  return {
    sequence: row.sequence,
    runId: row.run_id,
    entityType: row.entity_type,
    nodeId: row.node_id,
    fromState: row.from_state,
    toState: row.to_state,
    reason: row.reason,
    attemptId: row.attempt_id,
    at: row.at,
    previousHash: row.previous_hash,
    transitionHash: row.transition_hash
  };
}

export function isTerminalNodeState(state: GraphNodeState): boolean {
  return TERMINAL_NODE_STATES.has(state);
}
