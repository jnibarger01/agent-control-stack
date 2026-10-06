import { DatabaseSync } from "node:sqlite";
import { ControlStackError, applyControlPlaneMigrations, stableHash } from "@agent-control-stack/shared";
import {
  BudgetDecision,
  BudgetLimits,
  BudgetMetric,
  MissionBudget,
  REPORTED_METRICS,
  budgetToLimits,
  evaluateBudget
} from "./budget.js";
import {
  IN_FLIGHT_WORK_UNIT_STATUSES,
  NON_RETRYABLE_FAILURES,
  TERMINAL_MISSION_STATES,
  assertMissionTransition,
  parseWorkUnitPayload,
  type FailureCategory,
  type MissionKind,
  type MissionState,
  type VerificationPolicy,
  type WorkUnit,
  type WorkUnitKind,
  type WorkUnitStatus
} from "./mission-model.js";

export const CODING_MISSION_STATES = [
  "PLANNING",
  "RUNNING",
  "RECONCILING",
  "VALIDATING",
  "PREPARING_CHANGE_SET",
  "PUBLISHING_PROPOSAL",
  "WAITING_FOR_APPROVAL",
  "APPROVED",
  "EXECUTING",
  "VERIFYING",
  "COMPLETED",
  "FAILED",
  "DEGRADED"
] as const;
/** Persisted mission states are the shared MissionState set; CODING_MISSION_STATES lists the coding-profile subset. */
export type CodingMissionState = MissionState;
export type OperationStatus = WorkUnitStatus;

export interface ValidationEvidence {
  checks: Record<"tests" | "typecheck" | "lint" | "format" | "repository" | "review", "PASS" | "FAIL">;
  risks: string[];
}

export interface CodingOperation {
  operationId: string;
  dependsOn: string[];
  title: string;
  status: OperationStatus;
  claimToken?: string;
  claimedAt?: string;
  workerId?: string;
  route?: unknown;
  resultHash?: string;
  files: string[];
}

export interface CodingMissionRecord {
  missionId: string;
  kind: MissionKind;
  initiatorId?: string;
  repository: string;
  baseRef: string;
  baseSha: string;
  summary: string;
  state: CodingMissionState;
  version: number;
  headSha?: string;
  branch: string;
  changeSetHash?: string;
  validation?: ValidationEvidence;
  prNumber?: number;
  prUrl?: string;
  approvalId?: string;
  approvalHash?: string;
  approvedChangeSetHash?: string;
  approverId?: string;
  grantId?: string;
  mergeSha?: string;
  deploymentId?: string;
  deploymentRequired: boolean;
  deploymentAction: string;
  deploymentImpact: string;
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CodingEffect {
  kind: string;
  outcome: "unknown" | "succeeded";
  externalId?: string;
  detail?: unknown;
}

interface MissionRow {
  mission_id: string;
  repository: string;
  base_ref: string;
  base_sha: string;
  summary: string;
  state: CodingMissionState;
  version: number;
  head_sha: string | null;
  branch: string;
  change_set_hash: string | null;
  validation_json: string | null;
  pr_number: number | null;
  pr_url: string | null;
  approval_id: string | null;
  approval_hash: string | null;
  approved_change_set_hash: string | null;
  approver_id: string | null;
  grant_id: string | null;
  merge_sha: string | null;
  deployment_id: string | null;
  deployment_required: number;
  deployment_action: string;
  deployment_impact: string;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
  mission_kind: MissionKind;
  initiator_id: string | null;
}

interface UnitRow {
  mission_id: string;
  operation_id: string;
  depends_on: string;
  title: string;
  status: WorkUnitStatus;
  claim_token: string | null;
  claimed_at: string | null;
  worker_id: string | null;
  route_json: string | null;
  result_hash: string | null;
  files_json: string | null;
  unit_kind: WorkUnitKind;
  attempt: number;
  payload_json: string | null;
  parent_unit_id: string | null;
  depth: number;
  verification_policy: VerificationPolicy;
  failure_category: FailureCategory | null;
  cancel_external_state: "none" | "uncertain" | null;
}

export interface NewWorkUnit {
  unitId: string;
  kind: WorkUnitKind;
  title: string;
  dependsOn?: string[];
  payload?: unknown;
  parentUnitId?: string;
  verificationPolicy?: VerificationPolicy;
}

export type BudgetRefusal = { ok: false; outcome: "budget_exhausted"; decision: BudgetDecision };
export type AddWorkUnitsResult = { ok: true; created: string[]; decision: BudgetDecision } | BudgetRefusal;
export type ClaimUnitResult =
  | { ok: true; attempt: number; decision: BudgetDecision }
  | BudgetRefusal
  | { ok: false; outcome: "mission_not_active" | "dependencies_unmet" | "claim_conflict" };
export type RetryUnitResult =
  | { ok: true; attempt: number }
  | BudgetRefusal
  | { ok: false; outcome: "mission_not_active" | "retry_unsafe" | "not_retryable" | "not_found" };
export type CancelMissionResult =
  | { ok: true; mission: CodingMissionRecord; alreadyCancelled: boolean; cancelled: string[]; uncertain: string[] }
  | { ok: false; outcome: "already_terminal"; state: MissionState };

function parseStringArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new ControlStackError("coding_mission_integrity", "persisted operation list is invalid");
  }
  return parsed;
}

export function codingChangeSetBody(
  mission: CodingMissionRecord,
  operations: readonly CodingOperation[]
): Record<string, unknown> {
  return {
    schemaVersion: "acs.coding-change-set.v1",
    missionId: mission.missionId,
    repository: mission.repository,
    baseRef: mission.baseRef,
    baseSha: mission.baseSha,
    headSha: mission.headSha ?? null,
    branch: mission.branch,
    operations: [...operations]
      .sort((left, right) => left.operationId.localeCompare(right.operationId))
      .map((operation) => ({
        operationId: operation.operationId,
        dependsOn: [...operation.dependsOn].sort(),
        resultHash: operation.resultHash ?? null,
        files: [...operation.files].sort()
      })),
    validation: mission.validation ?? null,
    pullRequest: mission.prNumber === undefined ? null : { number: mission.prNumber, url: mission.prUrl ?? null },
    deployment: {
      required: mission.deploymentRequired,
      action: mission.deploymentAction,
      impact: mission.deploymentImpact
    }
  };
}

export function codingChangeSetHash(mission: CodingMissionRecord, operations: readonly CodingOperation[]): string {
  return stableHash({ domain: "acs.coding-change-set.v1", record: codingChangeSetBody(mission, operations) });
}

export class CodingMissionStore {
  readonly db: DatabaseSync;
  private readonly ownsDb: boolean;

  constructor(dbOrPath: string | DatabaseSync) {
    this.ownsDb = typeof dbOrPath === "string";
    this.db = typeof dbOrPath === "string" ? new DatabaseSync(dbOrPath) : dbOrPath;
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    applyControlPlaneMigrations(this.db);
  }

  close(): void {
    if (this.ownsDb) this.db.close();
  }

  private transactionDepth = 0;

  transaction<T>(work: () => T): T {
    if (this.transactionDepth > 0) return work();
    this.transactionDepth += 1;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The statement that failed may already have rolled the transaction back.
      }
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  create(input: {
    missionId: string;
    repository: string;
    baseRef: string;
    baseSha: string;
    summary: string;
    branch: string;
    deploymentRequired: boolean;
    deploymentAction: string;
    deploymentImpact: string;
    now: string;
    budget?: MissionBudget;
    initiatorId?: string;
  }): CodingMissionRecord {
    return this.transaction(() => {
      const existing = this.get(input.missionId);
      if (existing) {
        if (
          existing.repository !== input.repository ||
          existing.baseRef !== input.baseRef ||
          existing.baseSha !== input.baseSha ||
          existing.summary !== input.summary
        ) {
          throw new ControlStackError(
            "coding_mission_identity_conflict",
            "mission id already belongs to another proposal"
          );
        }
        return existing;
      }
      this.db
        .prepare(
          `INSERT INTO coding_missions (
            mission_id, repository, base_ref, base_sha, summary, state, version, branch,
            deployment_required, deployment_action, deployment_impact, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'PLANNING', 1, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.missionId,
          input.repository,
          input.baseRef,
          input.baseSha,
          input.summary,
          input.branch,
          input.deploymentRequired ? 1 : 0,
          input.deploymentAction,
          input.deploymentImpact,
          input.now,
          input.now
        );
      this.event(input.missionId, "coding_mission.created", { state: "PLANNING" }, input.now);
      if (input.initiatorId) {
        this.db
          .prepare("UPDATE coding_missions SET initiator_id = ? WHERE mission_id = ?")
          .run(input.initiatorId, input.missionId);
      }
      if (input.budget) this.writeBudget(input.missionId, input.budget, input.now);
      return this.require(input.missionId);
    });
  }

  /**
   * Create a non-coding mission in CREATED. The coding-profile columns are required by the table and hold ''.
   * Idempotent on mission id; an id that already belongs to another proposal is refused.
   */
  createGeneral(input: {
    missionId: string;
    summary: string;
    initiatorId?: string;
    budget?: MissionBudget;
    now: string;
  }): CodingMissionRecord {
    return this.transaction(() => {
      const existing = this.get(input.missionId);
      if (existing) {
        if (existing.kind !== "general" || existing.summary !== input.summary) {
          throw new ControlStackError(
            "coding_mission_identity_conflict",
            "mission id already belongs to another proposal"
          );
        }
        return existing;
      }
      this.db
        .prepare(
          `INSERT INTO coding_missions (
            mission_id, repository, base_ref, base_sha, summary, state, version, branch,
            deployment_required, deployment_action, deployment_impact, created_at, updated_at, mission_kind, initiator_id
          ) VALUES (?, '', '', '', ?, 'CREATED', 1, '', 0, '', '', ?, ?, 'general', ?)`
        )
        .run(input.missionId, input.summary, input.now, input.now, input.initiatorId ?? null);
      this.event(input.missionId, "mission.created", { state: "CREATED", kind: "general" }, input.now);
      if (input.budget) this.writeBudget(input.missionId, input.budget, input.now);
      return this.require(input.missionId);
    });
  }

  private writeBudget(missionId: string, budget: MissionBudget, now: string): void {
    const limits = budgetToLimits(budget);
    this.db
      .prepare(
        `INSERT INTO mission_budgets (mission_id, max_wall_clock_ms, max_tool_calls, max_work_units,
           max_parallel_work_units, max_retries_per_work_unit, max_child_depth, max_child_work_units, max_model_tokens,
           max_spend_micro_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        missionId,
        limits.wall_clock_ms ?? null,
        limits.tool_calls ?? null,
        limits.work_units ?? null,
        limits.parallel_work_units ?? null,
        limits.retries_per_work_unit ?? null,
        limits.child_depth ?? null,
        limits.child_work_units ?? null,
        limits.model_tokens ?? null,
        limits.spend_micro_usd ?? null,
        now
      );
    this.event(missionId, "budget.set", { limits }, now);
  }

  /** Limits (undefined while the mission has no budget, which means uncapped) and worker-reported usage. */
  budget(missionId: string): { limits: BudgetLimits; usage: Partial<Record<BudgetMetric, number>> } | undefined {
    const row = this.db.prepare("SELECT * FROM mission_budgets WHERE mission_id = ?").get(missionId) as
      Record<string, number | string | null> | undefined;
    if (!row) return undefined;
    const limits: BudgetLimits = {};
    const pull = (column: string, key: keyof BudgetLimits) => {
      if (row[column] !== null && row[column] !== undefined) limits[key] = row[column] as number;
    };
    pull("max_wall_clock_ms", "wall_clock_ms");
    pull("max_tool_calls", "tool_calls");
    pull("max_work_units", "work_units");
    pull("max_parallel_work_units", "parallel_work_units");
    pull("max_retries_per_work_unit", "retries_per_work_unit");
    pull("max_child_depth", "child_depth");
    pull("max_child_work_units", "child_work_units");
    pull("max_model_tokens", "model_tokens");
    pull("max_spend_micro_usd", "spend_micro_usd");
    const usage: Partial<Record<BudgetMetric, number>> = {};
    const usageRows = this.db
      .prepare("SELECT metric, used FROM mission_budget_usage WHERE mission_id = ?")
      .all(missionId) as Array<{ metric: BudgetMetric; used: number }>;
    for (const entry of usageRows) usage[entry.metric] = entry.used;
    return { limits, usage };
  }

  /** Record a budget refusal as durable evidence and return it as an explicit outcome, never an opaque error. */
  private refuse(missionId: string, operation: string, decision: BudgetDecision, now: string): BudgetRefusal {
    this.event(missionId, "budget.exhausted", { operation, exhausted: decision.exhausted }, now);
    return { ok: false, outcome: "budget_exhausted", decision };
  }

  get(missionId: string): CodingMissionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM coding_missions WHERE mission_id = ?").get(missionId) as
      MissionRow | undefined;
    return row ? this.mapMission(row) : undefined;
  }

  require(missionId: string): CodingMissionRecord {
    const mission = this.get(missionId);
    if (!mission) throw new ControlStackError("coding_mission_not_found", "coding mission does not exist");
    return mission;
  }

  listResumable(): CodingMissionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM coding_missions
         WHERE mission_kind = 'coding' AND state NOT IN ('WAITING_FOR_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED')
         ORDER BY mission_id`
      )
      .all() as unknown as MissionRow[];
    return rows.map((row) => this.mapMission(row));
  }

  listRecent(limit: number): CodingMissionRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM coding_missions ORDER BY updated_at DESC, mission_id ASC LIMIT ?`)
      .all(limit) as unknown as MissionRow[];
    return rows.map((row) => this.mapMission(row));
  }

  operations(missionId: string): CodingOperation[] {
    const rows = this.db
      .prepare(
        `SELECT operation_id, depends_on, title, status, claim_token, claimed_at, worker_id, route_json, result_hash, files_json
         FROM coding_operations WHERE mission_id = ? ORDER BY operation_id`
      )
      .all(missionId) as Array<{
      operation_id: string;
      depends_on: string;
      title: string;
      status: OperationStatus;
      claim_token: string | null;
      claimed_at: string | null;
      worker_id: string | null;
      route_json: string | null;
      result_hash: string | null;
      files_json: string | null;
    }>;
    return rows.map((row) => ({
      operationId: row.operation_id,
      dependsOn: parseStringArray(row.depends_on),
      title: row.title,
      status: row.status,
      ...(row.claim_token ? { claimToken: row.claim_token } : {}),
      ...(row.claimed_at ? { claimedAt: row.claimed_at } : {}),
      ...(row.worker_id ? { workerId: row.worker_id } : {}),
      ...(row.route_json ? { route: JSON.parse(row.route_json) as unknown } : {}),
      ...(row.result_hash ? { resultHash: row.result_hash } : {}),
      files: row.files_json ? parseStringArray(row.files_json) : []
    }));
  }

  replaceOperations(
    mission: CodingMissionRecord,
    operations: ReadonlyArray<{ operationId: string; dependsOn: string[]; title: string }>,
    now: string
  ): CodingMissionRecord {
    return this.transaction(() => {
      this.db.prepare("DELETE FROM coding_operations WHERE mission_id = ?").run(mission.missionId);
      const insert = this.db.prepare(
        `INSERT INTO coding_operations (mission_id, operation_id, depends_on, title, status, files_json)
         VALUES (?, ?, ?, ?, 'pending', '[]')`
      );
      for (const operation of operations) {
        insert.run(mission.missionId, operation.operationId, JSON.stringify(operation.dependsOn), operation.title);
      }
      return this.transition(mission, "RUNNING", now, { event: "coding_mission.planned" });
    });
  }

  claim(
    missionId: string,
    operationId: string,
    claim: { token: string; workerId: string; route: unknown; claimedAt: string }
  ): boolean {
    return this.claimUnit(missionId, operationId, claim).ok;
  }

  /**
   * Claim one work unit. Mission activity, dependency satisfaction and budgets are checked in the same IMMEDIATE
   * transaction as the claim, so two workers (or two parallel-cap checks) cannot both win.
   */
  claimUnit(
    missionId: string,
    operationId: string,
    claim: { token: string; workerId: string; route: unknown; claimedAt: string }
  ): ClaimUnitResult {
    return this.transaction(() => {
      const mission = this.get(missionId);
      if (!mission || TERMINAL_MISSION_STATES.has(mission.state)) return { ok: false, outcome: "mission_not_active" };
      const units = this.unitRows(missionId);
      const unit = units.find((row) => row.operation_id === operationId);
      if (!unit || (unit.status !== "pending" && unit.status !== "ready"))
        return { ok: false, outcome: "claim_conflict" };
      const succeeded = new Set(units.filter((row) => row.status === "succeeded").map((row) => row.operation_id));
      if (!parseStringArray(unit.depends_on).every((dependency) => succeeded.has(dependency))) {
        return { ok: false, outcome: "dependencies_unmet" };
      }
      const budget = this.budget(missionId);
      let decision: BudgetDecision = { allowed: true, exhausted: [], unaccounted: [] };
      if (budget) {
        const inFlight = units.filter((row) =>
          (IN_FLIGHT_WORK_UNIT_STATUSES as readonly string[]).includes(row.status)
        );
        decision = evaluateBudget(
          budget.limits,
          {
            parallel_work_units: inFlight.length + 1,
            wall_clock_ms: Math.max(0, Date.parse(claim.claimedAt) - Date.parse(mission.createdAt))
          },
          new Set(Object.keys(budget.usage) as BudgetMetric[])
        );
        if (!decision.allowed) return this.refuse(missionId, "claim", decision, claim.claimedAt);
      }
      const result = this.db
        .prepare(
          `UPDATE coding_operations
           SET status = 'running', claim_token = ?, claimed_at = ?, worker_id = ?, route_json = ?, attempt = attempt + 1
           WHERE mission_id = ? AND operation_id = ? AND status IN ('pending', 'ready')`
        )
        .run(claim.token, claim.claimedAt, claim.workerId, JSON.stringify(claim.route), missionId, operationId);
      if (result.changes !== 1) return { ok: false, outcome: "claim_conflict" };
      this.event(
        missionId,
        "work_unit.claimed",
        { unitId: operationId, workerId: claim.workerId, attempt: unit.attempt + 1 },
        claim.claimedAt
      );
      return { ok: true, attempt: unit.attempt + 1, decision };
    });
  }

  resetClaim(missionId: string, operationId: string): void {
    this.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE coding_operations
           SET status = 'pending', claim_token = NULL, worker_id = NULL, attempt = MAX(attempt - 1, 0)
           WHERE mission_id = ? AND operation_id = ? AND status IN ('claimed', 'running', 'unknown')`
        )
        .run(missionId, operationId);
      if (result.changes !== 1) {
        throw new ControlStackError("coding_mission_claim_conflict", "operation claim could not be released");
      }
    });
  }

  completeOperation(
    missionId: string,
    operationId: string,
    claimToken: string,
    result: { resultHash: string; files: string[] },
    now: string = new Date().toISOString()
  ): void {
    this.transaction(() => {
      const resultRow = this.db
        .prepare(
          `UPDATE coding_operations
           SET status = 'succeeded', result_hash = ?, files_json = ?
           WHERE mission_id = ? AND operation_id = ? AND status IN ('running', 'checkpointed', 'unknown') AND claim_token = ?`
        )
        .run(result.resultHash, JSON.stringify(result.files), missionId, operationId, claimToken);
      if (resultRow.changes !== 1) {
        throw new ControlStackError("coding_mission_claim_conflict", "operation completion did not match the claim");
      }
      this.event(missionId, "work_unit.completed", { unitId: operationId, resultHash: result.resultHash }, now);
    });
  }

  markOperation(missionId: string, operationId: string, status: "conflict" | "unknown" | "failed"): void {
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE coding_operations SET status = ? WHERE mission_id = ? AND operation_id = ? AND status = 'running'`
        )
        .run(status, missionId, operationId);
    });
  }

  reserveEffect(missionId: string, kind: string): "owned" | "unknown" | "succeeded" {
    return this.transaction(() => {
      const existing = this.effect(missionId, kind);
      if (existing?.outcome === "succeeded") return "succeeded";
      if (existing?.outcome === "unknown") return "unknown";
      this.db
        .prepare(`INSERT INTO coding_effects (mission_id, effect_kind, outcome) VALUES (?, ?, 'unknown')`)
        .run(missionId, kind);
      return "owned";
    });
  }

  effect(missionId: string, kind: string): CodingEffect | undefined {
    const row = this.db
      .prepare(
        `SELECT effect_kind, outcome, external_id, detail_json FROM coding_effects
         WHERE mission_id = ? AND effect_kind = ?`
      )
      .get(missionId, kind) as
      | {
          effect_kind: string;
          outcome: "unknown" | "succeeded";
          external_id: string | null;
          detail_json: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      kind: row.effect_kind,
      outcome: row.outcome,
      ...(row.external_id ? { externalId: row.external_id } : {}),
      ...(row.detail_json ? { detail: JSON.parse(row.detail_json) as unknown } : {})
    };
  }

  succeedEffect(missionId: string, kind: string, externalId: string, detail: unknown): void {
    this.transaction(() => {
      const encoded = JSON.stringify(detail);
      const result = this.db
        .prepare(
          `UPDATE coding_effects SET outcome = 'succeeded', external_id = ?, detail_json = ?
           WHERE mission_id = ? AND effect_kind = ? AND outcome = 'unknown'`
        )
        .run(externalId, encoded, missionId, kind);
      if (result.changes !== 1) {
        const current = this.effect(missionId, kind);
        if (current?.outcome === "succeeded" && current.externalId === externalId) return;
        throw new ControlStackError("coding_mission_effect_conflict", "effect outcome changed before it was recorded");
      }
    });
  }

  clearEffect(missionId: string, kind: string): void {
    this.transaction(() => {
      this.db
        .prepare(`DELETE FROM coding_effects WHERE mission_id = ? AND effect_kind = ? AND outcome = 'unknown'`)
        .run(missionId, kind);
    });
  }

  putEvidence(missionId: string, kind: string, payload: unknown, now: string): void {
    const payloadJson = JSON.stringify(payload);
    const evidenceId = `${kind}:${stableHash(payload).slice(0, 16)}`;
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO coding_evidence (mission_id, evidence_id, kind, payload_hash, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(missionId, evidenceId, kind, stableHash(payload), payloadJson, now);
    });
  }

  evidence<T>(missionId: string, kind: string): T | undefined {
    const row = this.db
      .prepare(
        `SELECT payload_json FROM coding_evidence WHERE mission_id = ? AND kind = ? ORDER BY evidence_id LIMIT 1`
      )
      .get(missionId, kind) as { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as T) : undefined;
  }

  events(missionId: string): Array<{ name: string; body: unknown }> {
    const rows = this.db
      .prepare(`SELECT name, body_json FROM coding_events WHERE mission_id = ? ORDER BY event_id`)
      .all(missionId) as Array<{ name: string; body_json: string }>;
    return rows.map((row) => ({ name: row.name, body: JSON.parse(row.body_json) as unknown }));
  }

  transition(
    mission: CodingMissionRecord,
    state: CodingMissionState,
    now: string,
    patch: {
      event: string;
      headSha?: string;
      validation?: ValidationEvidence;
      changeSetHash?: string;
      prNumber?: number;
      prUrl?: string;
      approvalId?: string | null;
      approvalHash?: string | null;
      approvedChangeSetHash?: string | null;
      approverId?: string | null;
      grantId?: string | null;
      mergeSha?: string;
      deploymentId?: string;
      failureCode?: string | null;
      body?: Record<string, unknown>;
    }
  ): CodingMissionRecord {
    assertMissionTransition(mission.kind, mission.state, state);
    return this.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE coding_missions SET
          state = ?, version = version + 1, updated_at = ?,
          head_sha = COALESCE(?, head_sha),
          validation_json = COALESCE(?, validation_json),
          change_set_hash = COALESCE(?, change_set_hash),
          pr_number = COALESCE(?, pr_number),
          pr_url = COALESCE(?, pr_url),
          approval_id = ?,
          approval_hash = ?,
          approved_change_set_hash = ?,
          approver_id = ?,
          grant_id = ?,
          merge_sha = COALESCE(?, merge_sha),
          deployment_id = COALESCE(?, deployment_id),
          failure_code = ?
         WHERE mission_id = ? AND version = ? AND state = ?`
        )
        .run(
          state,
          now,
          patch.headSha ?? null,
          patch.validation ? JSON.stringify(patch.validation) : null,
          patch.changeSetHash ?? null,
          patch.prNumber ?? null,
          patch.prUrl ?? null,
          patch.approvalId === undefined ? (mission.approvalId ?? null) : patch.approvalId,
          patch.approvalHash === undefined ? (mission.approvalHash ?? null) : patch.approvalHash,
          patch.approvedChangeSetHash === undefined
            ? (mission.approvedChangeSetHash ?? null)
            : patch.approvedChangeSetHash,
          patch.approverId === undefined ? (mission.approverId ?? null) : patch.approverId,
          patch.grantId === undefined ? (mission.grantId ?? null) : patch.grantId,
          patch.mergeSha ?? null,
          patch.deploymentId ?? null,
          patch.failureCode === undefined ? (mission.failureCode ?? null) : patch.failureCode,
          mission.missionId,
          mission.version,
          mission.state
        );
      if (result.changes !== 1) {
        throw new ControlStackError("coding_mission_version_conflict", "mission state changed before the transition");
      }
      this.event(mission.missionId, patch.event, { from: mission.state, to: state, ...(patch.body ?? {}) }, now);
      return this.require(mission.missionId);
    });
  }

  // ---- Generalized work-unit runtime -------------------------------------------------------------------------

  private unitRows(missionId: string): UnitRow[] {
    return this.db
      .prepare(
        `SELECT mission_id, operation_id, depends_on, title, status, claim_token, claimed_at, worker_id, route_json,
                result_hash, files_json, unit_kind, attempt, payload_json, parent_unit_id, depth, verification_policy,
                failure_category, cancel_external_state
         FROM coding_operations WHERE mission_id = ? ORDER BY operation_id`
      )
      .all(missionId) as unknown as UnitRow[];
  }

  /** Generalized view of the mission's operation rows. */
  workUnits(missionId: string): WorkUnit[] {
    return this.unitRows(missionId).map((row) => ({
      missionId: row.mission_id,
      unitId: row.operation_id,
      kind: row.unit_kind,
      title: row.title,
      status: row.status,
      dependsOn: parseStringArray(row.depends_on),
      attempt: row.attempt,
      depth: row.depth,
      ...(row.parent_unit_id ? { parentUnitId: row.parent_unit_id } : {}),
      verificationPolicy: row.verification_policy,
      ...(row.payload_json ? { payload: parseWorkUnitPayload(row.unit_kind, JSON.parse(row.payload_json)) } : {}),
      ...(row.worker_id ? { workerId: row.worker_id } : {}),
      ...(row.claim_token ? { claimToken: row.claim_token } : {}),
      ...(row.claimed_at ? { claimedAt: row.claimed_at } : {}),
      ...(row.route_json ? { route: JSON.parse(row.route_json) as unknown } : {}),
      ...(row.result_hash ? { resultHash: row.result_hash } : {}),
      files: row.files_json ? parseStringArray(row.files_json) : [],
      ...(row.failure_category ? { failureCategory: row.failure_category } : {}),
      ...(row.cancel_external_state ? { cancelExternalState: row.cancel_external_state } : {})
    }));
  }

  /**
   * Add work units to a live mission without disturbing existing ones. Dependencies must exist (or be in the same
   * batch) and form no cycle. Unit, depth and child-count caps are checked in the same transaction as the insert.
   */
  addWorkUnits(missionId: string, units: readonly NewWorkUnit[], now: string): AddWorkUnitsResult {
    return this.transaction(() => {
      const mission = this.require(missionId);
      if (TERMINAL_MISSION_STATES.has(mission.state)) {
        throw new ControlStackError("mission_not_active", `mission is ${mission.state}`);
      }
      const existing = this.unitRows(missionId);
      const byId = new Map(
        existing.map((row) => [row.operation_id, { depth: row.depth, deps: parseStringArray(row.depends_on) }])
      );
      const batchIds = new Set<string>();
      for (const unit of units) {
        if (!/^[A-Za-z0-9._:-]{1,128}$/.test(unit.unitId)) {
          throw new ControlStackError("work_unit_invalid", "work unit id is invalid");
        }
        if (byId.has(unit.unitId) || batchIds.has(unit.unitId)) {
          throw new ControlStackError("work_unit_duplicate", `work unit ${unit.unitId} already exists`);
        }
        batchIds.add(unit.unitId);
      }
      const resolved = new Map<string, { depth: number; deps: string[] }>(byId);
      const pendingBatch = [...units];
      // Resolve in dependency/parent order so depth is derived from a unit that exists and cycles are detected.
      while (pendingBatch.length > 0) {
        const index = pendingBatch.findIndex((unit) =>
          [...(unit.dependsOn ?? []), ...(unit.parentUnitId ? [unit.parentUnitId] : [])].every((id) => resolved.has(id))
        );
        if (index < 0) {
          throw new ControlStackError("work_unit_graph_invalid", "work unit dependencies are missing or cyclic");
        }
        const [unit] = pendingBatch.splice(index, 1);
        if (!unit) break;
        if ((unit.dependsOn ?? []).includes(unit.unitId)) {
          throw new ControlStackError("work_unit_graph_invalid", "a work unit cannot depend on itself");
        }
        const parentDepth = unit.parentUnitId ? resolved.get(unit.parentUnitId)!.depth + 1 : 0;
        resolved.set(unit.unitId, { depth: parentDepth, deps: unit.dependsOn ?? [] });
      }
      const parsed = units.map((unit) => ({
        unit,
        payload: unit.payload === undefined ? undefined : parseWorkUnitPayload(unit.kind, unit.payload),
        depth: resolved.get(unit.unitId)!.depth
      }));
      const budget = this.budget(missionId);
      let decision: BudgetDecision = { allowed: true, exhausted: [], unaccounted: [] };
      if (budget) {
        const children = existing.filter((row) => row.parent_unit_id !== null).length;
        decision = evaluateBudget(
          budget.limits,
          {
            work_units: existing.length + units.length,
            child_work_units: children + units.filter((unit) => unit.parentUnitId).length,
            child_depth: Math.max(0, ...parsed.map((entry) => entry.depth)),
            wall_clock_ms: Math.max(0, Date.parse(now) - Date.parse(mission.createdAt))
          },
          new Set(Object.keys(budget.usage) as BudgetMetric[])
        );
        if (!decision.allowed) return this.refuse(missionId, "create_work_units", decision, now);
      }
      const insert = this.db.prepare(
        `INSERT INTO coding_operations (mission_id, operation_id, depends_on, title, status, files_json, unit_kind,
           payload_json, parent_unit_id, depth, verification_policy)
         VALUES (?, ?, ?, ?, 'pending', '[]', ?, ?, ?, ?, ?)`
      );
      for (const { unit, payload, depth } of parsed) {
        insert.run(
          missionId,
          unit.unitId,
          JSON.stringify(unit.dependsOn ?? []),
          unit.title,
          unit.kind,
          payload === undefined ? null : JSON.stringify(payload),
          unit.parentUnitId ?? null,
          depth,
          unit.verificationPolicy ?? "none"
        );
        this.event(missionId, "work_unit.created", { unitId: unit.unitId, kind: unit.kind, depth }, now);
      }
      return { ok: true, created: units.map((unit) => unit.unitId), decision };
    });
  }

  /** Move pending units whose dependencies have all succeeded to ready. Does nothing for a terminal mission. */
  releaseReadyUnits(missionId: string, now: string): string[] {
    return this.transaction(() => {
      const mission = this.get(missionId);
      if (!mission || TERMINAL_MISSION_STATES.has(mission.state)) return [];
      const units = this.unitRows(missionId);
      const succeeded = new Set(units.filter((row) => row.status === "succeeded").map((row) => row.operation_id));
      const released: string[] = [];
      for (const unit of units) {
        if (unit.status !== "pending") continue;
        if (!parseStringArray(unit.depends_on).every((dependency) => succeeded.has(dependency))) continue;
        const result = this.db
          .prepare(
            `UPDATE coding_operations SET status = 'ready' WHERE mission_id = ? AND operation_id = ? AND status = 'pending'`
          )
          .run(missionId, unit.operation_id);
        if (result.changes === 1) {
          released.push(unit.operation_id);
          this.event(missionId, "work_unit.ready", { unitId: unit.operation_id }, now);
        }
      }
      return released;
    });
  }

  /**
   * Fail a claimed unit with a normalized category. Only the current claim token may do it, so a stale worker cannot.
   * A retryable category parks the unit as `retryable`; the retry itself is a separate, budget-checked step.
   */
  failUnit(
    missionId: string,
    unitId: string,
    claimToken: string,
    failure: { category: FailureCategory; retryable: boolean; now: string }
  ): "failed" | "retryable" {
    return this.transaction(() => {
      const next = failure.retryable && !NON_RETRYABLE_FAILURES.has(failure.category) ? "retryable" : "failed";
      const result = this.db
        .prepare(
          `UPDATE coding_operations SET status = ?, failure_category = ?
           WHERE mission_id = ? AND operation_id = ? AND claim_token = ?
             AND status IN ('running', 'checkpointed', 'verifying')`
        )
        .run(next, failure.category, missionId, unitId, claimToken);
      if (result.changes !== 1) {
        throw new ControlStackError("coding_mission_claim_conflict", "work unit failure did not match the claim");
      }
      this.event(missionId, "work_unit.failed", { unitId, category: failure.category, next }, failure.now);
      return next;
    });
  }

  /**
   * Schedule another attempt. The retry cap is checked from the durable attempt counter, so a restart or a racing
   * retry cannot exceed it. `unknown` and `conflict` units are never retried here: their external effect is unproven.
   */
  retryUnit(missionId: string, unitId: string, now: string): RetryUnitResult {
    return this.transaction(() => {
      const mission = this.get(missionId);
      if (!mission || TERMINAL_MISSION_STATES.has(mission.state)) return { ok: false, outcome: "mission_not_active" };
      const unit = this.unitRows(missionId).find((row) => row.operation_id === unitId);
      if (!unit) return { ok: false, outcome: "not_found" };
      if (unit.status === "unknown" || unit.status === "conflict") return { ok: false, outcome: "retry_unsafe" };
      if (unit.status !== "retryable" && unit.status !== "failed") return { ok: false, outcome: "not_retryable" };
      if (unit.failure_category && NON_RETRYABLE_FAILURES.has(unit.failure_category)) {
        return { ok: false, outcome: "not_retryable" };
      }
      const budget = this.budget(missionId);
      if (budget) {
        const decision = evaluateBudget(
          budget.limits,
          {
            // attempt counts claims, so after this retry the unit will have been retried `attempt` times.
            retries_per_work_unit: unit.attempt,
            wall_clock_ms: Math.max(0, Date.parse(now) - Date.parse(mission.createdAt))
          },
          new Set(Object.keys(budget.usage) as BudgetMetric[])
        );
        if (!decision.allowed) {
          this.db
            .prepare(
              `UPDATE coding_operations SET status = 'failed', failure_category = 'retry_budget_exhausted'
               WHERE mission_id = ? AND operation_id = ? AND status IN ('retryable', 'failed')`
            )
            .run(missionId, unitId);
          return this.refuse(missionId, "retry", decision, now);
        }
      }
      const result = this.db
        .prepare(
          `UPDATE coding_operations
           SET status = 'pending', claim_token = NULL, worker_id = NULL, failure_category = NULL
           WHERE mission_id = ? AND operation_id = ? AND status IN ('retryable', 'failed')`
        )
        .run(missionId, unitId);
      if (result.changes !== 1) return { ok: false, outcome: "not_retryable" };
      this.event(missionId, "work_unit.retry_scheduled", { unitId, attempt: unit.attempt }, now);
      return { ok: true, attempt: unit.attempt };
    });
  }

  /**
   * Cancel a mission and every unit that has not finished. Units that may have started external work are reported
   * as `uncertain`: cancellation never claims their side effects were rolled back. Their claim tokens are kept, so a
   * late result from the old worker is rejected by status rather than accepted.
   */
  cancelMission(
    missionId: string,
    input: { reason: string; now: string; expectedVersion?: number }
  ): CancelMissionResult {
    return this.transaction(() => {
      const mission = this.require(missionId);
      if (mission.state === "CANCELLED") {
        return { ok: true, mission, alreadyCancelled: true, cancelled: [], uncertain: [] };
      }
      if (TERMINAL_MISSION_STATES.has(mission.state))
        return { ok: false, outcome: "already_terminal", state: mission.state };
      if (input.expectedVersion !== undefined && input.expectedVersion !== mission.version) {
        throw new ControlStackError("coding_mission_version_conflict", "mission state changed before the cancellation");
      }
      const cancelled: string[] = [];
      const uncertain: string[] = [];
      for (const unit of this.unitRows(missionId)) {
        if (unit.status === "succeeded" || unit.status === "cancelled" || unit.status === "failed") continue;
        const external = (IN_FLIGHT_WORK_UNIT_STATUSES as readonly string[]).includes(unit.status)
          ? "uncertain"
          : "none";
        this.db
          .prepare(
            `UPDATE coding_operations SET status = 'cancelled', cancel_external_state = ?, failure_category = 'cancelled'
             WHERE mission_id = ? AND operation_id = ?`
          )
          .run(external, missionId, unit.operation_id);
        cancelled.push(unit.operation_id);
        if (external === "uncertain") uncertain.push(unit.operation_id);
        this.event(
          missionId,
          "work_unit.cancelled",
          { unitId: unit.operation_id, was: unit.status, externalState: external },
          input.now
        );
      }
      const next = this.transition(mission, "CANCELLED", input.now, {
        event: "mission.state_changed",
        failureCode: input.reason,
        body: { reason: input.reason, cancelled: cancelled.length, uncertain }
      });
      return { ok: true, mission: next, alreadyCancelled: false, cancelled, uncertain };
    });
  }

  /**
   * Ingest worker-reported usage. Usage never decreases. The caps are re-checked after ingestion and a crossed cap is
   * recorded as budget.exhausted; ACS stops admitting new work, it does not trust the worker to stop itself.
   */
  recordUsage(
    missionId: string,
    metric: Extract<BudgetMetric, "tool_calls" | "model_tokens" | "spend_micro_usd">,
    delta: number,
    now: string
  ): { used: number; decision: BudgetDecision } {
    if (!(REPORTED_METRICS as readonly string[]).includes(metric) || !Number.isInteger(delta) || delta < 0) {
      throw new ControlStackError(
        "mission_usage_invalid",
        "usage must be a non-negative integer for a reported metric"
      );
    }
    return this.transaction(() => {
      this.require(missionId);
      this.db
        .prepare(
          `INSERT INTO mission_budget_usage (mission_id, metric, used, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (mission_id, metric) DO UPDATE SET used = used + excluded.used, updated_at = excluded.updated_at`
        )
        .run(missionId, metric, delta, now);
      const budget = this.budget(missionId);
      const used = budget?.usage[metric] ?? delta;
      if (!budget) return { used, decision: { allowed: true, exhausted: [], unaccounted: [] } };
      const before = used - delta;
      const limit = budget.limits[metric];
      const decision = evaluateBudget(
        budget.limits,
        { [metric]: used },
        new Set(Object.keys(budget.usage) as BudgetMetric[])
      );
      if (!decision.allowed)
        this.event(missionId, "budget.exhausted", { operation: "usage", exhausted: decision.exhausted }, now);
      else if (limit !== undefined && limit > 0 && used * 5 >= limit * 4 && before * 5 < limit * 4) {
        this.event(missionId, "budget.threshold_reached", { metric, used, limit }, now);
      }
      return { used, decision };
    });
  }

  private event(missionId: string, name: string, body: unknown, now: string): void {
    this.db
      .prepare(`INSERT INTO coding_events (mission_id, name, body_json, created_at) VALUES (?, ?, ?, ?)`)
      .run(missionId, name, JSON.stringify(scrub(body)), now);
  }

  private mapMission(row: MissionRow): CodingMissionRecord {
    return {
      missionId: row.mission_id,
      kind: row.mission_kind,
      ...(row.initiator_id ? { initiatorId: row.initiator_id } : {}),
      repository: row.repository,
      baseRef: row.base_ref,
      baseSha: row.base_sha,
      summary: row.summary,
      state: row.state,
      version: row.version,
      ...(row.head_sha ? { headSha: row.head_sha } : {}),
      branch: row.branch,
      ...(row.change_set_hash ? { changeSetHash: row.change_set_hash } : {}),
      ...(row.validation_json ? { validation: JSON.parse(row.validation_json) as ValidationEvidence } : {}),
      ...(row.pr_number !== null ? { prNumber: row.pr_number } : {}),
      ...(row.pr_url ? { prUrl: row.pr_url } : {}),
      ...(row.approval_id ? { approvalId: row.approval_id } : {}),
      ...(row.approval_hash ? { approvalHash: row.approval_hash } : {}),
      ...(row.approved_change_set_hash ? { approvedChangeSetHash: row.approved_change_set_hash } : {}),
      ...(row.approver_id ? { approverId: row.approver_id } : {}),
      ...(row.grant_id ? { grantId: row.grant_id } : {}),
      ...(row.merge_sha ? { mergeSha: row.merge_sha } : {}),
      ...(row.deployment_id ? { deploymentId: row.deployment_id } : {}),
      deploymentRequired: row.deployment_required === 1,
      deploymentAction: row.deployment_action,
      deploymentImpact: row.deployment_impact,
      ...(row.failure_code ? { failureCode: row.failure_code } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => scrub(entry));
  if (value && typeof value === "object") {
    const clean: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (/token|secret|authorization|password|cookie|credential/i.test(key)) continue;
      clean[key] = scrub(child);
    }
    return clean;
  }
  return value;
}
