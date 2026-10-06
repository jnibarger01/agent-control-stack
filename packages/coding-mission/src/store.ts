import { DatabaseSync } from "node:sqlite";
import { ControlStackError, applyControlPlaneMigrations, stableHash } from "@agent-control-stack/shared";

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
export type CodingMissionState = (typeof CODING_MISSION_STATES)[number];
export type MissionState = CodingMissionState;
export type OperationStatus = "pending" | "running" | "succeeded" | "failed" | "conflict" | "unknown";
export type WorkUnitStatus = OperationStatus;

export interface MissionBudgetLimits {
  maxIterations: number;
  maxWorkUnits: number;
  maxWallTimeMs: number;
}

export interface MissionBudgetUsage {
  iterations: number;
  workUnits: number;
  wallTimeMs: number;
}

export interface MissionBudget {
  limits: MissionBudgetLimits;
  usage: MissionBudgetUsage;
  exhausted?: "iterations" | "work_units" | "wall_time";
  updatedAt: string;
}

export const DEFAULT_MISSION_BUDGET: MissionBudgetLimits = {
  maxIterations: 256,
  maxWorkUnits: 64,
  maxWallTimeMs: 86_400_000
};

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

export interface Mission {
  missionId: string;
  kind: "coding";
  goal: string;
  state: MissionState;
  version: number;
  budget: MissionBudget;
  createdAt: string;
  updatedAt: string;
}

export interface WorkUnit {
  workUnitId: string;
  missionId: string;
  kind: "coding";
  dependsOn: string[];
  title: string;
  status: WorkUnitStatus;
  workerId?: string;
  resultHash?: string;
  files: string[];
}

export interface CodingMissionRecord {
  missionId: string;
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

interface MissionBudgetRow {
  mission_id: string;
  max_iterations: number;
  max_work_units: number;
  max_wall_time_ms: number;
  used_iterations: number;
  created_at: string;
  updated_at: string;
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
}

function parseStringArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new ControlStackError("coding_mission_integrity", "persisted operation list is invalid");
  }
  return parsed;
}

function normalizeMissionBudget(input: Partial<MissionBudgetLimits> | undefined): MissionBudgetLimits {
  const limits = { ...DEFAULT_MISSION_BUDGET, ...(input ?? {}) };
  if (!Number.isInteger(limits.maxIterations) || limits.maxIterations < 1 || limits.maxIterations > 100_000) {
    throw new ControlStackError("mission_budget_invalid", "maxIterations must be an integer between 1 and 100000");
  }
  if (!Number.isInteger(limits.maxWorkUnits) || limits.maxWorkUnits < 1 || limits.maxWorkUnits > 64) {
    throw new ControlStackError("mission_budget_invalid", "maxWorkUnits must be an integer between 1 and 64");
  }
  if (!Number.isInteger(limits.maxWallTimeMs) || limits.maxWallTimeMs < 1 || limits.maxWallTimeMs > 604_800_000) {
    throw new ControlStackError("mission_budget_invalid", "maxWallTimeMs must be an integer between 1 and 604800000");
  }
  return limits;
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
    budget?: Partial<MissionBudgetLimits>;
    now: string;
  }): CodingMissionRecord {
    return this.transaction(() => {
      const existing = this.get(input.missionId);
      if (existing) {
        const requestedBudget = input.budget ? normalizeMissionBudget(input.budget) : undefined;
        const existingBudget = requestedBudget ? this.budget(input.missionId, input.now).limits : undefined;
        if (
          existing.repository !== input.repository ||
          existing.baseRef !== input.baseRef ||
          existing.baseSha !== input.baseSha ||
          existing.summary !== input.summary ||
          (requestedBudget !== undefined &&
            (requestedBudget.maxIterations !== existingBudget?.maxIterations ||
              requestedBudget.maxWorkUnits !== existingBudget?.maxWorkUnits ||
              requestedBudget.maxWallTimeMs !== existingBudget?.maxWallTimeMs))
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
      const budget = normalizeMissionBudget(input.budget);
      this.db
        .prepare(
          `INSERT INTO mission_budgets (
            mission_id, max_iterations, max_work_units, max_wall_time_ms, used_iterations, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 0, ?, ?)`
        )
        .run(input.missionId, budget.maxIterations, budget.maxWorkUnits, budget.maxWallTimeMs, input.now, input.now);
      this.event(input.missionId, "coding_mission.created", { state: "PLANNING", budget }, input.now);
      return this.require(input.missionId);
    });
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
         WHERE state NOT IN ('WAITING_FOR_APPROVAL', 'COMPLETED', 'FAILED')
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

  mission(missionId: string, now = new Date().toISOString()): Mission {
    const record = this.require(missionId);
    return {
      missionId: record.missionId,
      kind: "coding",
      goal: record.summary,
      state: record.state,
      version: record.version,
      budget: this.budget(missionId, now),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    };
  }

  budget(missionId: string, now = new Date().toISOString()): MissionBudget {
    const row = this.db
      .prepare(
        `SELECT b.*, m.created_at AS mission_created_at,
                (SELECT COUNT(*) FROM coding_operations o WHERE o.mission_id = b.mission_id) AS work_units
         FROM mission_budgets b
         JOIN coding_missions m ON m.mission_id = b.mission_id
         WHERE b.mission_id = ?`
      )
      .get(missionId) as unknown as (MissionBudgetRow & { mission_created_at: string; work_units: number }) | undefined;
    if (!row) throw new ControlStackError("mission_budget_not_found", "mission budget does not exist");
    const nowMs = Date.parse(now);
    const createdMs = Date.parse(row.mission_created_at);
    if (!Number.isFinite(nowMs) || !Number.isFinite(createdMs)) {
      throw new ControlStackError("mission_budget_clock_invalid", "mission budget timestamps are invalid");
    }
    const wallTimeMs = Math.max(0, nowMs - createdMs);
    const usage: MissionBudgetUsage = {
      iterations: row.used_iterations,
      workUnits: row.work_units,
      wallTimeMs
    };
    const exhausted =
      usage.iterations >= row.max_iterations
        ? "iterations"
        : usage.workUnits > row.max_work_units
          ? "work_units"
          : usage.wallTimeMs >= row.max_wall_time_ms
            ? "wall_time"
            : undefined;
    return {
      limits: {
        maxIterations: row.max_iterations,
        maxWorkUnits: row.max_work_units,
        maxWallTimeMs: row.max_wall_time_ms
      },
      usage,
      ...(exhausted ? { exhausted } : {}),
      updatedAt: row.updated_at
    };
  }

  consumeIteration(missionId: string, now: string): { consumed: boolean; budget: MissionBudget } {
    return this.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE mission_budgets
           SET used_iterations = used_iterations + 1, updated_at = ?
           WHERE mission_id = ? AND used_iterations < max_iterations`
        )
        .run(now, missionId);
      if (result.changes !== 1) {
        const current = this.budget(missionId, now);
        if (current.exhausted === "iterations") return { consumed: false, budget: current };
        throw new ControlStackError("mission_budget_not_found", "mission budget does not exist");
      }
      const budget = this.budget(missionId, now);
      this.event(
        missionId,
        "mission.budget.iteration_consumed",
        {
          iterations: budget.usage.iterations,
          maxIterations: budget.limits.maxIterations
        },
        now
      );
      return { consumed: true, budget };
    });
  }

  workUnits(missionId: string): WorkUnit[] {
    return this.operations(missionId).map((operation) => ({
      workUnitId: operation.operationId,
      missionId,
      kind: "coding",
      dependsOn: [...operation.dependsOn],
      title: operation.title,
      status: operation.status,
      ...(operation.workerId ? { workerId: operation.workerId } : {}),
      ...(operation.resultHash ? { resultHash: operation.resultHash } : {}),
      files: [...operation.files]
    }));
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
    return this.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE coding_operations
           SET status = 'running', claim_token = ?, claimed_at = ?, worker_id = ?, route_json = ?
           WHERE mission_id = ? AND operation_id = ? AND status = 'pending'`
        )
        .run(claim.token, claim.claimedAt, claim.workerId, JSON.stringify(claim.route), missionId, operationId);
      return result.changes === 1;
    });
  }

  resetClaim(missionId: string, operationId: string): void {
    this.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE coding_operations
           SET status = 'pending', claim_token = NULL, worker_id = NULL
           WHERE mission_id = ? AND operation_id = ? AND status IN ('running', 'unknown')`
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
    result: { resultHash: string; files: string[] }
  ): void {
    this.transaction(() => {
      const resultRow = this.db
        .prepare(
          `UPDATE coding_operations
           SET status = 'succeeded', result_hash = ?, files_json = ?
           WHERE mission_id = ? AND operation_id = ? AND status IN ('running', 'unknown') AND claim_token = ?`
        )
        .run(result.resultHash, JSON.stringify(result.files), missionId, operationId, claimToken);
      if (resultRow.changes !== 1) {
        throw new ControlStackError("coding_mission_claim_conflict", "operation completion did not match the claim");
      }
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

  private event(missionId: string, name: string, body: unknown, now: string): void {
    this.db
      .prepare(`INSERT INTO coding_events (mission_id, name, body_json, created_at) VALUES (?, ?, ?, ?)`)
      .run(missionId, name, JSON.stringify(scrub(body)), now);
  }

  private mapMission(row: MissionRow): CodingMissionRecord {
    return {
      missionId: row.mission_id,
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
