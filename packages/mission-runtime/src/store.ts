import { DatabaseSync } from "node:sqlite";
import {
  applyControlPlaneMigrations,
  ControlStackError,
  createId,
  domainHash,
  redactValue
} from "@agent-control-stack/shared";
import { assertReadyToComplete } from "./completion.js";
import { assertMissionTransition } from "./types.js";
import type {
  ApplicationRecord,
  ApprovalBinding,
  ChangeSetRecord,
  ClaimResult,
  CreateMissionInput,
  DeploymentRecord,
  DeploymentOperation,
  DeploymentOperationStatus,
  MissionEventRecord,
  MissionRecord,
  MissionSnapshot,
  MissionStatus,
  OperationRecord,
  VerificationRecord
} from "./types.js";

interface MissionRow {
  mission_id: string;
  work_item_id: string;
  intent: string;
  status: MissionStatus;
  plan_json: string;
  plan_hash: string;
  target_json: string;
  base_revision: string;
  proposed_mutation_json: string | null;
  requires_mutation: number;
  requires_deployment: number;
  deployment_target: string | null;
  requires_production_verification: number;
  production_verification_json: string;
  change_set_id: string | null;
  evidence_seal_hash: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface OperationRow {
  operation_id: string;
  mission_id: string;
  operation_key: string;
  operation_type: "execute" | "validate";
  lane: OperationRecord["lane"];
  required_capabilities_json: string;
  dependencies_json: string;
  mutation_class: OperationRecord["mutationClass"];
  retry_policy: OperationRecord["retryPolicy"];
  max_attempts: number;
  verification_json: string;
  status: OperationRecord["status"];
  execution_id: string | null;
  execution_dispatched: number;
  attempt_count: number;
  claim_worker_id: string | null;
  claim_token: string | null;
  claim_epoch: number;
  claim_expires_at: string | null;
  route_decision_json: string | null;
  admission_permit_id: string | null;
  result_json: string | null;
  result_hash: string | null;
  observations_json: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export function missionPlanHash(input: CreateMissionInput): string {
  return domainHash("acs:mission-plan:v1", {
    intent: input.intent,
    target: input.target,
    baseRevision: input.baseRevision,
    requiresMutation: input.requiresMutation,
    proposedMutation: input.proposedMutation ?? null,
    requiresDeployment: input.requiresDeployment,
    deploymentTarget: input.deploymentTarget ?? null,
    requiresProductionVerification: input.requiresProductionVerification,
    productionVerification: input.productionVerification ?? [],
    operations: input.operations.map((operation) => ({
      key: operation.key,
      type: operation.type,
      lane: operation.lane,
      dependencies: [...operation.dependencies].sort(),
      requiredCapabilities: [...operation.requiredCapabilities].sort(),
      mutationClass: operation.mutationClass,
      retryPolicy: operation.retryPolicy,
      maxAttempts: operation.maxAttempts ?? 3,
      verification: operation.verification
    }))
  });
}

export function executionIdentity(missionId: string, operationId: string): string {
  return domainHash("acs:mission-execution:v1", { missionId, operationId });
}

export function deploymentOperationIdentity(missionId: string, changeSetHash: string, releaseId: string): string {
  return domainHash("acs:mission-deployment:v1", { missionId, changeSetHash, releaseId });
}

export function resultHash(payload: Record<string, unknown>): string {
  return domainHash("acs:mission-operation-result:v1", redactValue(payload));
}

export function changeSetDigest(input: {
  missionId: string;
  baseRevision: string;
  target: CreateMissionInput["target"];
  proposedMutation: Record<string, unknown>;
  derivedFrom: Array<{ operationId: string; resultHash: string }>;
  artifactHashes: string[];
}): string {
  return domainHash("acs:mission-change-set:v1", {
    ...input,
    derivedFrom: [...input.derivedFrom].sort((left, right) => left.operationId.localeCompare(right.operationId)),
    artifactHashes: [...input.artifactHashes].sort()
  });
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function missionFromRow(row: MissionRow): MissionRecord {
  return {
    missionId: row.mission_id,
    workItemId: row.work_item_id,
    intent: row.intent,
    status: row.status,
    planHash: row.plan_hash,
    plan: parseJson(row.plan_json),
    target: parseJson(row.target_json),
    baseRevision: row.base_revision,
    ...(row.proposed_mutation_json ? { proposedMutation: parseJson(row.proposed_mutation_json) } : {}),
    requiresMutation: row.requires_mutation === 1,
    requiresDeployment: row.requires_deployment === 1,
    ...(row.deployment_target ? { deploymentTarget: row.deployment_target } : {}),
    requiresProductionVerification: row.requires_production_verification === 1,
    productionVerification: parseJson(row.production_verification_json),
    ...(row.change_set_id ? { changeSetId: row.change_set_id } : {}),
    ...(row.evidence_seal_hash ? { evidenceSealHash: row.evidence_seal_hash } : {}),
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function operationFromRow(row: OperationRow): OperationRecord {
  return {
    operationId: row.operation_id,
    missionId: row.mission_id,
    operationKey: row.operation_key,
    operationType: row.operation_type,
    lane: row.lane,
    requiredCapabilities: parseJson(row.required_capabilities_json),
    dependencies: parseJson(row.dependencies_json),
    mutationClass: row.mutation_class,
    retryPolicy: row.retry_policy,
    maxAttempts: row.max_attempts,
    verification: parseJson(row.verification_json),
    status: row.status,
    ...(row.execution_id ? { executionId: row.execution_id } : {}),
    executionDispatched: row.execution_dispatched === 1,
    attemptCount: row.attempt_count,
    ...(row.claim_worker_id ? { claimWorkerId: row.claim_worker_id } : {}),
    ...(row.claim_token ? { claimToken: row.claim_token } : {}),
    claimEpoch: row.claim_epoch,
    ...(row.claim_expires_at ? { claimExpiresAt: row.claim_expires_at } : {}),
    ...(row.route_decision_json ? { routeDecision: parseJson(row.route_decision_json) } : {}),
    ...(row.admission_permit_id ? { admissionPermitId: row.admission_permit_id } : {}),
    ...(row.result_json ? { result: parseJson(row.result_json) } : {}),
    ...(row.result_hash ? { resultHash: row.result_hash } : {}),
    ...(row.observations_json ? { observations: parseJson(row.observations_json) } : {}),
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class MissionStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    applyControlPlaneMigrations(this.db);
  }

  close(): void {
    this.db.close();
  }

  /** Exposed for migration and immutability tests. */
  database(): DatabaseSync {
    return this.db;
  }

  insertMission(input: CreateMissionInput, workItemId: string, now: string): MissionSnapshot {
    const planHash = missionPlanHash(input);
    const missionId = createId("mission");
    const ids = new Map(input.operations.map((operation) => [operation.key, createId("mop")]));
    return this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO missions (
            mission_id, work_item_id, intent, status, plan_json, plan_hash, target_json, base_revision,
            proposed_mutation_json, requires_mutation, requires_deployment, deployment_target,
            requires_production_verification, production_verification_json, created_at, updated_at
          ) VALUES (?, ?, ?, 'PLANNED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          missionId,
          workItemId,
          input.intent,
          JSON.stringify(input),
          planHash,
          JSON.stringify(input.target),
          input.baseRevision,
          input.proposedMutation ? JSON.stringify(redactValue(input.proposedMutation)) : null,
          input.requiresMutation ? 1 : 0,
          input.requiresDeployment ? 1 : 0,
          input.deploymentTarget ?? null,
          input.requiresProductionVerification ? 1 : 0,
          JSON.stringify(input.productionVerification ?? []),
          now,
          now
        );
      const insertOperation = this.db.prepare(
        `INSERT INTO mission_operations (
          operation_id, mission_id, operation_key, operation_type, lane, required_capabilities_json,
          dependencies_json, mutation_class, retry_policy, max_attempts, verification_json, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`
      );
      for (const operation of input.operations) {
        const operationId = ids.get(operation.key);
        if (!operationId) throw new ControlStackError("mission_plan_invalid", `missing operation ${operation.key}`);
        insertOperation.run(
          operationId,
          missionId,
          operation.key,
          operation.type,
          operation.lane,
          JSON.stringify(operation.requiredCapabilities),
          JSON.stringify(operation.dependencies.map((key) => ids.get(key))),
          operation.mutationClass,
          operation.retryPolicy,
          operation.maxAttempts ?? 3,
          JSON.stringify(operation.verification),
          now,
          now
        );
      }
      this.appendEvent(missionId, "mission.created", `mission.created:${missionId}`, { planHash, workItemId }, now);
      return this.readSnapshot(missionId);
    });
  }

  snapshot(missionId: string): MissionSnapshot {
    return this.readSnapshot(missionId);
  }

  listResumableMissionIds(): string[] {
    const rows = this.db
      .prepare(
        `SELECT mission_id FROM missions
         WHERE status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
         ORDER BY created_at ASC`
      )
      .all() as Array<{ mission_id: string }>;
    return rows.map((row) => row.mission_id);
  }

  transition(
    missionId: string,
    to: MissionStatus,
    evidence: Record<string, unknown>,
    now: string,
    idempotencyKey: string
  ): MissionRecord {
    return this.transaction(() => {
      const current = this.requireMission(missionId);
      assertMissionTransition(current.status, to);
      if (current.status !== to) {
        const failureCode = typeof evidence.failureCode === "string" ? evidence.failureCode : null;
        const failureReason = typeof evidence.failureReason === "string" ? evidence.failureReason : null;
        const changed = this.db
          .prepare(
            `UPDATE missions
             SET status = ?, updated_at = ?, failure_code = COALESCE(?, failure_code), failure_reason = COALESCE(?, failure_reason)
             WHERE mission_id = ? AND status = ?`
          )
          .run(to, now, failureCode, failureReason, missionId, current.status);
        if (changed.changes !== 1) {
          throw new ControlStackError("mission_conflict", `mission ${missionId} changed during transition`);
        }
      }
      this.appendEvent(missionId, "mission.transition", idempotencyKey, { from: current.status, to, ...evidence }, now);
      return this.requireMission(missionId);
    });
  }

  markRouted(operationId: string, decision: Record<string, unknown>, now: string): void {
    this.transaction(() => {
      const operation = this.requireOperation(operationId);
      if (operation.status === "SUCCEEDED" || operation.resultHash) return;
      this.db
        .prepare(
          `UPDATE mission_operations
           SET status = CASE WHEN status IN ('PENDING', 'READY') THEN 'ROUTED' ELSE status END,
               route_decision_json = ?, updated_at = ?
           WHERE operation_id = ? AND status IN ('PENDING', 'READY', 'ROUTED', 'ADMITTED')`
        )
        .run(JSON.stringify(redactValue(decision)), now, operationId);
      this.appendEvent(
        operation.missionId,
        "route.chosen",
        `route.chosen:${operationId}:${String(decision.selected ?? "none")}`,
        { operationId, selected: decision.selected ?? null },
        now,
        operationId
      );
    });
  }

  markAdmitted(operationId: string, permitId: string, granted: boolean, now: string): void {
    this.transaction(() => {
      const operation = this.requireOperation(operationId);
      if (!granted) {
        this.appendEvent(
          operation.missionId,
          "admission.rejected",
          `admission.rejected:${operationId}:${permitId}`,
          { operationId, permitId },
          now,
          operationId
        );
        return;
      }
      this.db
        .prepare(
          `UPDATE mission_operations
           SET status = CASE WHEN status IN ('READY', 'ROUTED') THEN 'ADMITTED' ELSE status END,
               admission_permit_id = ?, updated_at = ?
           WHERE operation_id = ? AND result_hash IS NULL`
        )
        .run(permitId, now, operationId);
      this.appendEvent(
        operation.missionId,
        "admission.granted",
        `admission.granted:${operationId}:${permitId}`,
        { operationId, permitId },
        now,
        operationId
      );
    });
  }

  claim(operationId: string, workerId: string, expiresAt: string, now: string): ClaimResult {
    return this.transaction(() => {
      const token = createId("claim");
      const changed = this.db
        .prepare(
          `UPDATE mission_operations
           SET status = 'CLAIMED', claim_worker_id = ?, claim_token = ?, claim_epoch = claim_epoch + 1,
               claim_expires_at = ?, updated_at = ?
           WHERE operation_id = ?
             AND status IN ('READY', 'ROUTED', 'ADMITTED')
             AND result_hash IS NULL`
        )
        .run(workerId, token, expiresAt, now, operationId);
      const operation = this.requireOperation(operationId);
      return { claimed: changed.changes === 1 && operation.claimToken === token, operation };
    });
  }

  markDispatched(
    operationId: string,
    claimToken: string,
    workerId: string,
    executionId: string,
    now: string
  ): OperationRecord {
    return this.transaction(() => {
      const changed = this.db
        .prepare(
          `UPDATE mission_operations
           SET status = 'DISPATCHED', execution_id = ?, execution_dispatched = 1,
               attempt_count = attempt_count + 1, updated_at = ?
           WHERE operation_id = ? AND status = 'CLAIMED' AND claim_token = ? AND claim_worker_id = ?
             AND (execution_id IS NULL OR execution_id = ?)`
        )
        .run(executionId, now, operationId, claimToken, workerId, executionId);
      if (changed.changes !== 1) {
        throw new ControlStackError("mission_claim_lost", `dispatch fence rejected for ${operationId}`);
      }
      const operation = this.requireOperation(operationId);
      this.appendEvent(
        operation.missionId,
        "operation.dispatched",
        `operation.dispatched:${executionId}:${operation.attemptCount}`,
        { operationId, executionId, attempt: operation.attemptCount },
        now,
        operationId
      );
      return operation;
    });
  }

  markUnknown(operationId: string, claimToken: string, reason: string, now: string): void {
    this.transaction(() => {
      const operation = this.requireOperation(operationId);
      const changed = this.db
        .prepare(
          `UPDATE mission_operations
           SET status = 'UNKNOWN', failure_code = 'reconciliation_required', failure_reason = ?, updated_at = ?
           WHERE operation_id = ? AND status = 'DISPATCHED' AND claim_token = ? AND result_hash IS NULL`
        )
        .run(reason, now, operationId, claimToken);
      if (changed.changes !== 1 && operation.status !== "UNKNOWN") {
        throw new ControlStackError(
          "mission_result_conflict",
          `cannot mark ${operationId} unknown from ${operation.status}`
        );
      }
      this.appendEvent(
        operation.missionId,
        "unknown_outcome.detected",
        `unknown:${operation.executionId ?? operationId}:${reason}`,
        { operationId, reason },
        now,
        operationId
      );
    });
  }

  recoverExpired(missionId: string, now: string): void {
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE mission_operations
           SET status = 'UNKNOWN', failure_code = 'reconciliation_required',
               failure_reason = 'lease expired after dispatch', updated_at = ?
           WHERE mission_id = ? AND execution_dispatched = 1 AND result_hash IS NULL
             AND status IN ('CLAIMED', 'DISPATCHED')
             AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?`
        )
        .run(now, missionId, now);
      this.db
        .prepare(
          `UPDATE mission_operations
           SET status = 'READY', claim_worker_id = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = ?
           WHERE mission_id = ? AND execution_dispatched = 0 AND status = 'CLAIMED'
             AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?`
        )
        .run(now, missionId, now);
    });
  }

  prepareRetry(operationId: string, now: string): void {
    this.transaction(() => {
      const operation = this.requireOperation(operationId);
      if (operation.status !== "UNKNOWN" && operation.status !== "DISPATCHED") {
        throw new ControlStackError("invalid_operation_transition", `${operationId} is ${operation.status}`);
      }
      this.db
        .prepare(
          `UPDATE mission_operations
           SET status = 'READY', claim_worker_id = NULL, claim_token = NULL, claim_expires_at = NULL,
               failure_code = NULL, failure_reason = NULL, updated_at = ?
           WHERE operation_id = ? AND result_hash IS NULL AND status IN ('UNKNOWN', 'DISPATCHED')`
        )
        .run(now, operationId);
      this.appendEvent(
        operation.missionId,
        "reconciliation.result",
        `reconcile:not_started:${operation.executionId ?? operationId}:${operation.attemptCount}`,
        { operationId, outcome: "not_started" },
        now,
        operationId
      );
    });
  }

  noteReconciliation(operationId: string, outcome: string, now: string): void {
    const operation = this.requireOperation(operationId);
    this.transaction(() => {
      this.appendEvent(
        operation.missionId,
        "reconciliation.result",
        `reconcile:${outcome}:${operation.executionId ?? operationId}:${operation.attemptCount}`,
        { operationId, outcome },
        now,
        operationId
      );
    });
  }

  persistResult(
    operationId: string,
    claimToken: string,
    payload: Record<string, unknown>,
    now: string,
    observations: Record<string, string> = {}
  ): OperationRecord {
    const redacted = redactValue(payload) as Record<string, unknown>;
    const hash = resultHash(redacted);
    const observed = redactValue(observations) as Record<string, string>;
    return this.transaction(() => {
      const changed = this.db
        .prepare(
          `UPDATE mission_operations
           SET result_json = ?, result_hash = ?, observations_json = ?, status = 'VERIFYING', updated_at = ?
           WHERE operation_id = ? AND status IN ('DISPATCHED', 'UNKNOWN', 'VERIFYING')
             AND (result_hash IS NULL OR result_hash = ?)
             AND (status = 'UNKNOWN' OR status = 'VERIFYING' OR claim_token = ?)`
        )
        .run(JSON.stringify(redacted), hash, JSON.stringify(observed), now, operationId, hash, claimToken);
      if (changed.changes !== 1) {
        const existing = this.requireOperation(operationId);
        if (existing.resultHash === hash && existing.status === "VERIFYING") return existing;
        throw new ControlStackError("mission_result_conflict", `result for ${operationId} was not persisted`);
      }
      const operation = this.requireOperation(operationId);
      this.appendEvent(
        operation.missionId,
        "result.received",
        `result.received:${operation.executionId ?? operationId}`,
        { operationId, resultHash: hash },
        now,
        operationId
      );
      return operation;
    });
  }

  recordVerification(
    missionId: string,
    operationId: string,
    stage: "operation" | "production",
    outcome: {
      kind: string;
      expected: string;
      observed: string;
      outcome: "passed" | "failed" | "unsupported";
      evidenceRef: string;
    },
    now: string
  ): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO mission_verifications (
            verification_id, mission_id, operation_id, stage, kind, expected_condition, observed_result,
            evidence_ref, outcome, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (mission_id, operation_id, stage, kind) DO UPDATE SET
            observed_result = excluded.observed_result,
            evidence_ref = excluded.evidence_ref,
            outcome = excluded.outcome,
            created_at = excluded.created_at`
        )
        .run(
          createId("mv"),
          missionId,
          operationId,
          stage,
          outcome.kind,
          outcome.expected,
          outcome.observed,
          outcome.evidenceRef,
          outcome.outcome,
          now
        );
      this.appendEvent(
        missionId,
        stage === "production" ? "production.verification" : "verification.completed",
        `verification:${stage}:${operationId}:${outcome.kind}`,
        { operationId, kind: outcome.kind, outcome: outcome.outcome },
        now,
        operationId || undefined
      );
    });
  }

  markOperationTerminal(
    operationId: string,
    status: "SUCCEEDED" | "FAILED" | "BLOCKED",
    code: string | null,
    reason: string | null,
    now: string
  ): void {
    this.transaction(() => {
      const operation = this.requireOperation(operationId);
      if (operation.status === status) return;
      if (operation.status === "SUCCEEDED") return;
      const changed = this.db
        .prepare(
          `UPDATE mission_operations
           SET status = ?, failure_code = ?, failure_reason = ?, updated_at = ?
           WHERE operation_id = ? AND status != 'SUCCEEDED'`
        )
        .run(status, code, reason, now, operationId);
      if (changed.changes !== 1) {
        throw new ControlStackError("mission_result_conflict", `operation ${operationId} was not marked ${status}`);
      }
      this.appendEvent(
        operation.missionId,
        "operation.ready",
        `operation.terminal:${operationId}:${status}`,
        { operationId, status, code, reason },
        now,
        operationId
      );
    });
  }

  markReady(operationId: string, now: string): void {
    this.transaction(() => {
      const operation = this.requireOperation(operationId);
      const changed = this.db
        .prepare(
          `UPDATE mission_operations SET status = 'READY', updated_at = ?
           WHERE operation_id = ? AND status = 'PENDING' AND result_hash IS NULL`
        )
        .run(now, operationId);
      if (changed.changes === 1) {
        this.appendEvent(
          operation.missionId,
          "operation.ready",
          `operation.ready:${operationId}`,
          { operationId },
          now,
          operationId
        );
      }
    });
  }

  insertChangeSet(record: Omit<ChangeSetRecord, "changeSetId" | "createdAt">, now: string): ChangeSetRecord {
    return this.transaction(() => {
      const existing = this.db
        .prepare(`SELECT * FROM mission_change_sets WHERE mission_id = ? AND change_set_hash = ?`)
        .get(record.missionId, record.changeSetHash) as
        | {
            change_set_id: string;
            mission_id: string;
            generation: number;
            change_set_hash: string;
            derived_from_json: string;
            target_json: string;
            base_revision: string;
            proposed_mutation_json: string;
            validation_evidence_json: string;
            artifact_hashes_json: string;
            approval_required: number;
            status: string;
            created_at: string;
          }
        | undefined;
      if (existing) {
        if (existing.status === "invalidated") {
          this.db
            .prepare(`UPDATE mission_change_sets SET status = 'waiting_approval' WHERE change_set_id = ?`)
            .run(existing.change_set_id);
          existing.status = "waiting_approval";
        }
        this.db
          .prepare(`UPDATE missions SET change_set_id = ?, updated_at = ? WHERE mission_id = ?`)
          .run(existing.change_set_id, now, record.missionId);
        return this.mapChangeSet(existing);
      }
      const changeSetId = createId("chs");
      this.db
        .prepare(
          `INSERT INTO mission_change_sets (
            change_set_id, mission_id, generation, change_set_hash, derived_from_json, target_json, base_revision,
            proposed_mutation_json, validation_evidence_json, artifact_hashes_json, approval_required, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          changeSetId,
          record.missionId,
          record.generation,
          record.changeSetHash,
          JSON.stringify(record.derivedFrom),
          JSON.stringify(record.target),
          record.baseRevision,
          JSON.stringify(redactValue(record.proposedMutation)),
          JSON.stringify(record.validationEvidence),
          JSON.stringify(record.artifactHashes),
          record.approvalRequired ? 1 : 0,
          record.status,
          now
        );
      this.db
        .prepare(`UPDATE missions SET change_set_id = ?, updated_at = ? WHERE mission_id = ?`)
        .run(changeSetId, now, record.missionId);
      this.appendEvent(
        record.missionId,
        "change_set.created",
        `change_set.created:${record.changeSetHash}`,
        { changeSetId, changeSetHash: record.changeSetHash, generation: record.generation },
        now
      );
      return this.requireChangeSet(changeSetId);
    });
  }

  invalidateHeadChangeSet(missionId: string, now: string): void {
    this.transaction(() => {
      const mission = this.requireMission(missionId);
      if (!mission.changeSetId) return;
      this.db
        .prepare(
          `UPDATE mission_change_sets SET status = 'invalidated' WHERE change_set_id = ? AND status != 'applied'`
        )
        .run(mission.changeSetId);
      this.appendEvent(
        missionId,
        "change_set.invalidated",
        `change_set.invalidated:${mission.changeSetId}:${now}`,
        { changeSetId: mission.changeSetId },
        now
      );
    });
  }

  nextChangeSetGeneration(missionId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(generation), 0) AS generation FROM mission_change_sets WHERE mission_id = ?`)
      .get(missionId) as {
      generation: number;
    };
    return row.generation + 1;
  }

  recordApproval(binding: Omit<ApprovalBinding, "approvalId" | "createdAt">, now: string): ApprovalBinding {
    return this.transaction(() => {
      const existing = this.db
        .prepare(`SELECT * FROM mission_approvals WHERE change_set_hash = ? AND approver_id = ? AND decision = ?`)
        .get(binding.changeSetHash, binding.approverId, binding.decision) as
        | {
            approval_id: string;
            mission_id: string;
            work_item_id: string;
            change_set_id: string;
            change_set_hash: string;
            decision: "approved" | "rejected";
            approver_id: string;
            request_hash: string | null;
            created_at: string;
          }
        | undefined;
      if (existing) return this.mapApproval(existing);
      const approvalId = createId("mappr");
      this.db
        .prepare(
          `INSERT INTO mission_approvals (
            approval_id, mission_id, work_item_id, change_set_id, change_set_hash, decision, approver_id, request_hash, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          approvalId,
          binding.missionId,
          binding.workItemId,
          binding.changeSetId,
          binding.changeSetHash,
          binding.decision,
          binding.approverId,
          binding.requestHash ?? null,
          now
        );
      if (binding.decision === "approved") {
        this.db
          .prepare(`UPDATE mission_change_sets SET status = 'approved' WHERE change_set_id = ?`)
          .run(binding.changeSetId);
      } else {
        this.db
          .prepare(`UPDATE mission_change_sets SET status = 'rejected' WHERE change_set_id = ?`)
          .run(binding.changeSetId);
      }
      this.appendEvent(
        binding.missionId,
        "approval.recorded",
        `approval.recorded:${binding.changeSetHash}:${binding.decision}:${binding.approverId}`,
        { changeSetHash: binding.changeSetHash, decision: binding.decision, approverId: binding.approverId },
        now
      );
      return this.mapApproval(
        this.db.prepare(`SELECT * FROM mission_approvals WHERE approval_id = ?`).get(approvalId) as {
          approval_id: string;
          mission_id: string;
          work_item_id: string;
          change_set_id: string;
          change_set_hash: string;
          decision: "approved" | "rejected";
          approver_id: string;
          request_hash: string | null;
          created_at: string;
        }
      );
    });
  }

  startApplication(
    missionId: string,
    changeSetId: string,
    changeSetHash: string,
    expectedBaseRevision: string,
    idempotencyKey: string,
    now: string
  ): ApplicationRecord {
    return this.transaction(() => {
      const existing = this.readApplication(missionId);
      if (existing?.status === "succeeded") return existing;
      if (existing && existing.changeSetHash !== changeSetHash) {
        throw new ControlStackError("change_set_mismatch", "application is bound to a different change set");
      }
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO mission_applications (
              mission_id, change_set_id, change_set_hash, status, idempotency_key, expected_base_revision, started_at
            ) VALUES (?, ?, ?, 'started', ?, ?, ?)`
          )
          .run(missionId, changeSetId, changeSetHash, idempotencyKey, expectedBaseRevision, now);
      } else if (existing.status === "not_started" || existing.status === "failed") {
        this.db
          .prepare(
            `UPDATE mission_applications SET status = 'started', started_at = ? WHERE mission_id = ? AND status IN ('not_started', 'failed')`
          )
          .run(now, missionId);
      }
      this.appendEvent(missionId, "apply.started", `apply.started:${changeSetHash}`, { changeSetHash }, now);
      const application = this.readApplication(missionId);
      if (!application) throw new ControlStackError("mission_state_missing", "application row missing");
      return application;
    });
  }

  finishApplication(
    missionId: string,
    status: ApplicationRecord["status"],
    observedRevision: string | null,
    reason: string | null,
    now: string
  ): void {
    this.transaction(() => {
      const current = this.readApplication(missionId);
      if (current?.status === "succeeded" && status !== "succeeded") {
        throw new ControlStackError("mutation_already_applied", "a succeeded mutation cannot be reapplied");
      }
      if (current?.status === "succeeded" && status === "succeeded") return;
      this.db
        .prepare(
          `UPDATE mission_applications
           SET status = ?, observed_revision = COALESCE(?, observed_revision), reason = ?, completed_at = ?
           WHERE mission_id = ? AND status != 'succeeded'`
        )
        .run(status, observedRevision, reason, now, missionId);
      if (status === "succeeded" && current) {
        this.db
          .prepare(`UPDATE mission_change_sets SET status = 'applied' WHERE change_set_id = ?`)
          .run(current.changeSetId);
      }
      this.appendEvent(
        missionId,
        "apply.completed",
        `apply.completed:${current?.changeSetHash ?? missionId}:${status}`,
        { status, observedRevision, reason },
        now
      );
    });
  }

  startDeployment(missionId: string, target: string, expectedRevision: string, now: string): DeploymentRecord {
    return this.transaction(() => {
      const existing = this.readDeployment(missionId);
      if (existing?.status === "succeeded") return existing;
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO mission_deployments (mission_id, target, expected_revision, status, attempt_count, started_at)
             VALUES (?, ?, ?, 'started', 1, ?)`
          )
          .run(missionId, target, expectedRevision, now);
      } else if (existing.status !== "started") {
        this.db
          .prepare(
            `UPDATE mission_deployments
             SET status = 'started', attempt_count = attempt_count + 1, started_at = ?
             WHERE mission_id = ? AND status != 'succeeded'`
          )
          .run(now, missionId);
      }
      this.appendEvent(
        missionId,
        "deployment.started",
        `deployment.started:${missionId}:${existing?.attemptCount ?? 1}`,
        { target, expectedRevision },
        now
      );
      const deployment = this.readDeployment(missionId);
      if (!deployment) throw new ControlStackError("mission_state_missing", "deployment row missing");
      return deployment;
    });
  }

  createDeploymentOperation(
    input: Omit<DeploymentOperation, "status" | "createdAt" | "updatedAt" | "observedReleaseId" | "observedAt">,
    now: string
  ): DeploymentOperation {
    return this.transaction(() => {
      if (input.id !== deploymentOperationIdentity(input.missionId, input.changeSetHash, input.releaseId)) {
        throw new ControlStackError(
          "deployment_operation_id_invalid",
          "deployment operation ID does not match its binding"
        );
      }
      const authorized = this.db
        .prepare(
          `SELECT 1 AS authorized
           FROM missions AS m
           JOIN mission_change_sets AS cs ON cs.change_set_id = m.change_set_id
           JOIN mission_applications AS app ON app.mission_id = m.mission_id
           JOIN mission_approvals AS approval
             ON approval.mission_id = m.mission_id
            AND approval.change_set_id = cs.change_set_id
            AND approval.change_set_hash = cs.change_set_hash
           WHERE m.mission_id = ?
             AND cs.change_set_hash = ?
             AND cs.status = 'applied'
             AND app.status = 'succeeded'
             AND app.change_set_hash = cs.change_set_hash
             AND app.observed_revision = ?
             AND approval.approver_id = ?
             AND approval.decision = 'approved'
           LIMIT 1`
        )
        .get(input.missionId, input.changeSetHash, input.releaseId, input.requestedBy);
      if (!authorized) {
        throw new ControlStackError(
          "deployment_authority_invalid",
          "deployment intent is not bound to the current approved and applied Change Set"
        );
      }
      const existing = this.readDeploymentOperation(input.missionId);
      if (existing) {
        if (
          existing.id !== input.id ||
          existing.changeSetHash !== input.changeSetHash ||
          existing.releaseId !== input.releaseId ||
          existing.requestedBy !== input.requestedBy ||
          existing.permitId !== input.permitId
        ) {
          throw new ControlStackError(
            "deployment_operation_conflict",
            "mission already has a different deployment operation"
          );
        }
        return existing;
      }
      this.db
        .prepare(
          `INSERT INTO mission_deployment_operations
            (id, mission_id, change_set_hash, release_id, requested_by, permit_id, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`
        )
        .run(
          input.id,
          input.missionId,
          input.changeSetHash,
          input.releaseId,
          input.requestedBy,
          input.permitId,
          now,
          now
        );
      this.appendEvent(
        input.missionId,
        "deployment.operation.pending",
        `deployment.operation.pending:${input.id}`,
        { ...input, status: "PENDING" },
        now
      );
      const created = this.readDeploymentOperation(input.missionId);
      if (!created) throw new ControlStackError("mission_state_missing", "deployment operation was not persisted");
      return created;
    });
  }

  getDeploymentOperation(missionId: string): DeploymentOperation | undefined {
    return this.readDeploymentOperation(missionId);
  }

  setDeploymentOperationStatus(
    missionId: string,
    status: DeploymentOperationStatus,
    observedReleaseId: string | null,
    observedAt: string | null,
    now: string
  ): DeploymentOperation {
    return this.transaction(() => {
      const current = this.readDeploymentOperation(missionId);
      if (!current) throw new ControlStackError("mission_state_missing", "deployment operation was not found");
      if (current.status === "SUCCEEDED" || current.status === "FAILED") {
        if (current.status !== status) {
          throw new ControlStackError("deployment_operation_terminal", "terminal deployment operation is immutable");
        }
        return current;
      }
      const allowed: Record<DeploymentOperationStatus, DeploymentOperationStatus[]> = {
        PENDING: ["EXECUTING", "SUCCEEDED", "FAILED", "UNKNOWN"],
        EXECUTING: ["SUCCEEDED", "FAILED", "UNKNOWN"],
        UNKNOWN: ["SUCCEEDED", "UNKNOWN"],
        SUCCEEDED: ["SUCCEEDED"],
        FAILED: ["FAILED"]
      };
      if (!allowed[current.status].includes(status)) {
        throw new ControlStackError(
          "deployment_operation_transition_invalid",
          `cannot transition deployment operation from ${current.status} to ${status}`
        );
      }
      if (status === "SUCCEEDED" && observedReleaseId !== current.releaseId) {
        throw new ControlStackError(
          "deployment_release_mismatch",
          "deployment cannot succeed without observing the requested release identity"
        );
      }
      if (observedAt !== null && Number.isNaN(Date.parse(observedAt))) {
        throw new ControlStackError("deployment_observation_invalid", "release observation timestamp is invalid");
      }
      if (status === "SUCCEEDED" && !observedAt) {
        throw new ControlStackError(
          "deployment_observation_missing",
          "deployment success requires an observation timestamp"
        );
      }
      this.db
        .prepare(
          `UPDATE mission_deployment_operations
           SET status = ?,
               observed_release_id = CASE WHEN ? IS NOT NULL THEN ? ELSE observed_release_id END,
               observed_at = COALESCE(?, observed_at), updated_at = ?
           WHERE mission_id = ?`
        )
        .run(status, observedAt, observedReleaseId, observedAt, now, missionId);
      this.appendEvent(
        missionId,
        "deployment.operation.updated",
        `deployment.operation.updated:${current.id}:${status}:${observedReleaseId ?? "none"}:${observedAt ?? "none"}`,
        { operationId: current.id, status, observedReleaseId, observedAt },
        now
      );
      const updated = this.readDeploymentOperation(missionId);
      if (!updated) throw new ControlStackError("mission_state_missing", "deployment operation disappeared");
      return updated;
    });
  }

  finishDeployment(
    missionId: string,
    status: DeploymentRecord["status"],
    fields: { observedVersion?: string; restartStatus?: string; healthStatus?: string; reason?: string },
    now: string
  ): void {
    this.transaction(() => {
      const current = this.readDeployment(missionId);
      if (current?.status === "succeeded") return;
      this.db
        .prepare(
          `UPDATE mission_deployments
           SET status = ?, observed_version = ?, restart_status = ?, health_status = ?, reason = ?, completed_at = ?
           WHERE mission_id = ? AND status != 'succeeded'`
        )
        .run(
          status,
          fields.observedVersion ?? null,
          fields.restartStatus ?? null,
          fields.healthStatus ?? null,
          fields.reason ?? null,
          now,
          missionId
        );
      this.appendEvent(
        missionId,
        "deployment.completed",
        `deployment.completed:${missionId}:${status}:${fields.observedVersion ?? "none"}`,
        { status, ...fields },
        now
      );
    });
  }

  requeue(operationId: string, claimToken: string, now: string): void {
    this.transaction(() => {
      const operation = this.requireOperation(operationId);
      const changed = this.db
        .prepare(
          `UPDATE mission_operations
           SET status = 'READY', claim_worker_id = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = ?
           WHERE operation_id = ? AND claim_token = ? AND status = 'DISPATCHED' AND result_hash IS NULL`
        )
        .run(now, operationId, claimToken);
      if (changed.changes !== 1) {
        throw new ControlStackError(
          "invalid_operation_transition",
          `cannot requeue ${operationId} from ${operation.status}`
        );
      }
    });
  }

  replaceProposedMutation(missionId: string, mutation: Record<string, unknown>, now: string): void {
    this.transaction(() => {
      const application = this.readApplication(missionId);
      if (application && application.status !== "failed" && application.status !== "not_started") {
        throw new ControlStackError("change_set_immutable", "cannot change a mutation after application has started");
      }
      this.db
        .prepare(`UPDATE missions SET proposed_mutation_json = ?, updated_at = ? WHERE mission_id = ?`)
        .run(JSON.stringify(redactValue(mutation)), now, missionId);
      const mission = this.requireMission(missionId);
      if (mission.changeSetId) {
        this.db
          .prepare(
            `UPDATE mission_change_sets SET status = 'invalidated' WHERE change_set_id = ? AND status != 'applied'`
          )
          .run(mission.changeSetId);
      }
      this.appendEvent(
        missionId,
        "change_set.invalidated",
        `change_set.superseded:${now}`,
        { reason: "proposed mutation changed" },
        now
      );
    });
  }

  noteAwaitingResult(missionId: string, now: string): void {
    this.transaction(() => {
      const changed = this.db
        .prepare(
          `UPDATE missions SET status = 'WAITING_FOR_RESULT', updated_at = ?
           WHERE mission_id = ? AND status IN ('RUNNING', 'WAITING_FOR_RECONCILIATION')
             AND EXISTS (
               SELECT 1 FROM mission_operations
               WHERE mission_id = ? AND status IN ('CLAIMED', 'DISPATCHED', 'VERIFYING', 'ROUTED', 'ADMITTED')
             )`
        )
        .run(now, missionId, missionId);
      if (changed.changes !== 1) return;
      this.appendEvent(
        missionId,
        "mission.transition",
        `mission.inflight:${missionId}:${now}`,
        { to: "WAITING_FOR_RESULT", reason: "in flight" },
        now
      );
    });
  }

  complete(missionId: string, seal: string, now: string): MissionRecord {
    return this.transaction(() => {
      let current = this.requireMission(missionId);
      if (current.status === "COMPLETED") return current;
      const snapshot = this.readSnapshot(missionId);
      const computed = assertReadyToComplete(snapshot);
      if (computed !== seal) {
        throw new ControlStackError("evidence_seal_mismatch", "completion seal does not match the durable evidence");
      }
      if (current.status === "WAITING_FOR_RESULT" || current.status === "WAITING_FOR_RECONCILIATION") {
        assertMissionTransition(current.status, "RUNNING");
        const promoted = this.db
          .prepare(`UPDATE missions SET status = 'RUNNING', updated_at = ? WHERE mission_id = ? AND status = ?`)
          .run(now, missionId, current.status);
        if (promoted.changes !== 1) {
          throw new ControlStackError("mission_conflict", "mission changed before completion");
        }
        this.appendEvent(
          missionId,
          "mission.transition",
          `mission.running:settled:${missionId}`,
          { from: current.status, to: "RUNNING", reason: "operations settled" },
          now
        );
        current = this.requireMission(missionId);
      }
      assertMissionTransition(current.status, "COMPLETED");
      const changed = this.db
        .prepare(
          `UPDATE missions SET status = 'COMPLETED', evidence_seal_hash = ?, updated_at = ? WHERE mission_id = ? AND status = ?`
        )
        .run(seal, now, missionId, current.status);
      if (changed.changes !== 1) {
        throw new ControlStackError("mission_conflict", "mission changed before completion");
      }
      this.appendEvent(missionId, "mission.completed", "mission.completed", { evidenceSealHash: seal }, now);
      return this.requireMission(missionId);
    });
  }

  fail(missionId: string, code: string, reason: string, now: string): void {
    const current = this.requireMission(missionId);
    if (current.status === "FAILED" || current.status === "COMPLETED" || current.status === "CANCELLED") return;
    this.transition(missionId, "FAILED", { failureCode: code, failureReason: reason }, now, `mission.failed:${code}`);
    this.transaction(() => {
      this.appendEvent(missionId, "mission.failed", `mission.failed.event:${code}`, { code, reason }, now);
    });
  }

  block(missionId: string, code: string, reason: string, now: string): void {
    const current = this.requireMission(missionId);
    if (TERMINAL.has(current.status) || current.status === "BLOCKED") {
      if (current.status !== "BLOCKED") return;
      this.transaction(() => {
        this.db
          .prepare(`UPDATE missions SET failure_code = ?, failure_reason = ?, updated_at = ? WHERE mission_id = ?`)
          .run(code, reason, now, missionId);
      });
      return;
    }
    this.transition(missionId, "BLOCKED", { failureCode: code, failureReason: reason }, now, `mission.blocked:${code}`);
  }

  private readSnapshot(missionId: string): MissionSnapshot {
    const mission = this.requireMission(missionId);
    const operations = (
      this.db
        .prepare(`SELECT * FROM mission_operations WHERE mission_id = ? ORDER BY created_at ASC, operation_id ASC`)
        .all(missionId) as unknown as OperationRow[]
    ).map(operationFromRow);
    const events = (
      this.db
        .prepare(`SELECT * FROM mission_events WHERE mission_id = ? ORDER BY rowid ASC`)
        .all(missionId) as unknown as Array<{
        event_id: string;
        mission_id: string;
        operation_id: string | null;
        name: string;
        payload_json: string;
        idempotency_key: string;
        previous_hash: string;
        event_hash: string;
        created_at: string;
      }>
    ).map((row): MissionEventRecord => ({
      eventId: row.event_id,
      missionId: row.mission_id,
      ...(row.operation_id ? { operationId: row.operation_id } : {}),
      name: row.name,
      payload: parseJson(row.payload_json),
      idempotencyKey: row.idempotency_key,
      previousHash: row.previous_hash,
      eventHash: row.event_hash,
      createdAt: row.created_at
    }));
    const changeSets = (
      this.db
        .prepare(`SELECT * FROM mission_change_sets WHERE mission_id = ? ORDER BY generation ASC`)
        .all(missionId) as unknown as Array<{
        change_set_id: string;
        mission_id: string;
        generation: number;
        change_set_hash: string;
        derived_from_json: string;
        target_json: string;
        base_revision: string;
        proposed_mutation_json: string;
        validation_evidence_json: string;
        artifact_hashes_json: string;
        approval_required: number;
        status: string;
        created_at: string;
      }>
    ).map((row) => this.mapChangeSet(row));
    const approvals = (
      this.db
        .prepare(`SELECT * FROM mission_approvals WHERE mission_id = ? ORDER BY created_at ASC`)
        .all(missionId) as unknown as Array<{
        approval_id: string;
        mission_id: string;
        work_item_id: string;
        change_set_id: string;
        change_set_hash: string;
        decision: "approved" | "rejected";
        approver_id: string;
        request_hash: string | null;
        created_at: string;
      }>
    ).map((row) => this.mapApproval(row));
    const verifications = (
      this.db
        .prepare(`SELECT * FROM mission_verifications WHERE mission_id = ? ORDER BY created_at ASC`)
        .all(missionId) as unknown as Array<{
        verification_id: string;
        mission_id: string;
        operation_id: string;
        stage: "operation" | "production";
        kind: string;
        expected_condition: string;
        observed_result: string | null;
        evidence_ref: string | null;
        outcome: "passed" | "failed" | "unsupported";
        created_at: string;
      }>
    ).map((row): VerificationRecord => ({
      verificationId: row.verification_id,
      missionId: row.mission_id,
      operationId: row.operation_id,
      stage: row.stage,
      kind: row.kind,
      expectedCondition: row.expected_condition,
      ...(row.observed_result !== null ? { observedResult: row.observed_result } : {}),
      ...(row.evidence_ref ? { evidenceRef: row.evidence_ref } : {}),
      outcome: row.outcome,
      createdAt: row.created_at
    }));
    return {
      mission,
      operations,
      events,
      changeSets,
      approvals,
      ...(this.readApplication(missionId) ? { application: this.readApplication(missionId) } : {}),
      ...(this.readDeployment(missionId) ? { deployment: this.readDeployment(missionId) } : {}),
      ...(this.readDeploymentOperation(missionId)
        ? { deploymentOperation: this.readDeploymentOperation(missionId) }
        : {}),
      verifications
    };
  }

  private readApplication(missionId: string): ApplicationRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM mission_applications WHERE mission_id = ?`).get(missionId) as
      | {
          mission_id: string;
          change_set_id: string;
          change_set_hash: string;
          status: ApplicationRecord["status"];
          idempotency_key: string;
          expected_base_revision: string;
          observed_revision: string | null;
          reason: string | null;
          started_at: string | null;
          completed_at: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      missionId: row.mission_id,
      changeSetId: row.change_set_id,
      changeSetHash: row.change_set_hash,
      status: row.status,
      idempotencyKey: row.idempotency_key,
      expectedBaseRevision: row.expected_base_revision,
      ...(row.observed_revision ? { observedRevision: row.observed_revision } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.completed_at ? { completedAt: row.completed_at } : {})
    };
  }

  private readDeployment(missionId: string): DeploymentRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM mission_deployments WHERE mission_id = ?`).get(missionId) as
      | {
          mission_id: string;
          target: string;
          expected_revision: string;
          status: DeploymentRecord["status"];
          attempt_count: number;
          observed_version: string | null;
          restart_status: string | null;
          health_status: string | null;
          reason: string | null;
          started_at: string | null;
          completed_at: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      missionId: row.mission_id,
      target: row.target,
      expectedRevision: row.expected_revision,
      status: row.status,
      attemptCount: row.attempt_count,
      ...(row.observed_version ? { observedVersion: row.observed_version } : {}),
      ...(row.restart_status ? { restartStatus: row.restart_status } : {}),
      ...(row.health_status ? { healthStatus: row.health_status } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.completed_at ? { completedAt: row.completed_at } : {})
    };
  }

  private readDeploymentOperation(missionId: string): DeploymentOperation | undefined {
    const row = this.db.prepare(`SELECT * FROM mission_deployment_operations WHERE mission_id = ?`).get(missionId) as
      | {
          id: string;
          mission_id: string;
          change_set_hash: string;
          release_id: string;
          requested_by: string;
          permit_id: string;
          status: DeploymentOperationStatus;
          observed_release_id: string | null;
          observed_at: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      missionId: row.mission_id,
      changeSetHash: row.change_set_hash,
      releaseId: row.release_id,
      requestedBy: row.requested_by,
      permitId: row.permit_id,
      status: row.status,
      ...(row.observed_release_id ? { observedReleaseId: row.observed_release_id } : {}),
      ...(row.observed_at ? { observedAt: row.observed_at } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private mapChangeSet(row: {
    change_set_id: string;
    mission_id: string;
    generation: number;
    change_set_hash: string;
    derived_from_json: string;
    target_json: string;
    base_revision: string;
    proposed_mutation_json: string;
    validation_evidence_json: string;
    artifact_hashes_json: string;
    approval_required: number;
    status: string;
    created_at: string;
  }): ChangeSetRecord {
    return {
      changeSetId: row.change_set_id,
      missionId: row.mission_id,
      generation: row.generation,
      changeSetHash: row.change_set_hash,
      derivedFrom: parseJson(row.derived_from_json),
      target: parseJson(row.target_json),
      baseRevision: row.base_revision,
      proposedMutation: parseJson(row.proposed_mutation_json),
      validationEvidence: parseJson(row.validation_evidence_json),
      artifactHashes: parseJson(row.artifact_hashes_json),
      approvalRequired: row.approval_required === 1,
      status: row.status,
      createdAt: row.created_at
    };
  }

  private mapApproval(row: {
    approval_id: string;
    mission_id: string;
    work_item_id: string;
    change_set_id: string;
    change_set_hash: string;
    decision: "approved" | "rejected";
    approver_id: string;
    request_hash: string | null;
    created_at: string;
  }): ApprovalBinding {
    return {
      approvalId: row.approval_id,
      missionId: row.mission_id,
      workItemId: row.work_item_id,
      changeSetId: row.change_set_id,
      changeSetHash: row.change_set_hash,
      decision: row.decision,
      approverId: row.approver_id,
      ...(row.request_hash ? { requestHash: row.request_hash } : {}),
      createdAt: row.created_at
    };
  }

  private requireMission(missionId: string): MissionRecord {
    const row = this.db.prepare(`SELECT * FROM missions WHERE mission_id = ?`).get(missionId) as MissionRow | undefined;
    if (!row) throw new ControlStackError("mission_not_found", `mission ${missionId} does not exist`);
    return missionFromRow(row);
  }

  private requireOperation(operationId: string): OperationRecord {
    const row = this.db.prepare(`SELECT * FROM mission_operations WHERE operation_id = ?`).get(operationId) as
      OperationRow | undefined;
    if (!row) throw new ControlStackError("operation_not_found", `operation ${operationId} does not exist`);
    return operationFromRow(row);
  }

  private requireChangeSet(changeSetId: string): ChangeSetRecord {
    const row = this.db.prepare(`SELECT * FROM mission_change_sets WHERE change_set_id = ?`).get(changeSetId) as {
      change_set_id: string;
      mission_id: string;
      generation: number;
      change_set_hash: string;
      derived_from_json: string;
      target_json: string;
      base_revision: string;
      proposed_mutation_json: string;
      validation_evidence_json: string;
      artifact_hashes_json: string;
      approval_required: number;
      status: string;
      created_at: string;
    };
    return this.mapChangeSet(row);
  }

  private appendEvent(
    missionId: string,
    name: string,
    idempotencyKey: string,
    payload: Record<string, unknown>,
    now: string,
    operationId?: string
  ): void {
    const existing = this.db
      .prepare(`SELECT event_id FROM mission_events WHERE mission_id = ? AND idempotency_key = ?`)
      .get(missionId, idempotencyKey);
    if (existing) return;
    const previous = this.db
      .prepare(`SELECT event_hash FROM mission_events WHERE mission_id = ? ORDER BY rowid DESC LIMIT 1`)
      .get(missionId) as { event_hash: string } | undefined;
    const previousHash = previous?.event_hash ?? "";
    const body = redactValue(payload) as Record<string, unknown>;
    const eventHash = domainHash("acs:mission-event:v1", {
      missionId,
      name,
      idempotencyKey,
      previousHash,
      payload: body
    });
    this.db
      .prepare(
        `INSERT INTO mission_events (
          event_id, mission_id, operation_id, name, payload_json, idempotency_key, previous_hash, event_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        createId("mevt"),
        missionId,
        operationId ?? null,
        name,
        JSON.stringify(body),
        idempotencyKey,
        previousHash,
        eventHash,
        now
      );
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

const TERMINAL = new Set<MissionStatus>(["COMPLETED", "FAILED", "CANCELLED"]);
