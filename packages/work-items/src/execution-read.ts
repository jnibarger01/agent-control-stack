import { ControlStackError } from "@agent-control-stack/shared";
import { executionPlanAdmissionSchema, type ExecutionPlanAdmission } from "./execution-plan.js";
import { DatabaseSync } from "node:sqlite";
import { attemptLeaseSchema, executionAttemptSchema, type AttemptLease, type ExecutionAttempt } from "./attempt.js";

interface ExecutionAttemptRow {
  attempt_id: string;
  work_item_id: string;
  plan_id: string;
  plan_hash: string;
  attempt_number: number;
  protocol_version: string;
  input_hash: string;
  status: string;
  current_fencing_epoch: number;
  claimed_by_worker_id: string | null;
  started_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AttemptLeaseRow {
  lease_id: string;
  attempt_id: string;
  work_item_id: string;
  admission_id: string;
  approval_id: string | null;
  worker_id: string;
  token_hash: string;
  plan_hash: string;
  input_hash: string;
  fencing_epoch: number;
  protocol_version: string;
  policy_version: string;
  policy_decision_hash: string;
  issued_at: string;
  expires_at: string;
  max_expires_at: string;
  last_renewed_at: string;
  status: string;
  closed_at: string | null;
}

export interface ExecutionTelemetry {
  windowStart: string;
  windowEnd: string;
  succeeded: number;
  failed: number;
  averageRunMs: number | null;
  averageQueueMs: number | null;
  approvalsGranted?: number;
  averageApprovalMs?: number | null;
  throughput: Array<{ at: string; started: number; completed: number; failed: number }>;
}

/**
 * Read-only projection over persisted execution authority state.
 *
 * This deliberately opens the same SQLite database in query-only mode so
 * operator surfaces can inspect attempts and leases without acquiring write
 * authority or duplicating lifecycle transitions in an application package.
 */
export class SqliteExecutionReadStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA query_only = ON");
  }

  listExecutionAttempts(workItemId: string): ExecutionAttempt[] {
    return (
      this.db
        .prepare(`SELECT * FROM execution_attempts WHERE work_item_id = ? ORDER BY attempt_number ASC`)
        .all(workItemId) as unknown as ExecutionAttemptRow[]
    ).map(rowToExecutionAttempt);
  }

  listAttemptLeases(workItemId: string): AttemptLease[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM attempt_leases
           WHERE work_item_id = ?
           ORDER BY issued_at ASC, fencing_epoch ASC`
        )
        .all(workItemId) as unknown as AttemptLeaseRow[]
    ).map(rowToAttemptLease);
  }

  /** Attempts for many work items in bounded `IN (...)` batches, instead of one query per item. */
  listExecutionAttemptsForWorkItems(workItemIds: readonly string[]): Map<string, ExecutionAttempt[]> {
    return this.groupByWorkItem(
      workItemIds,
      (placeholders) =>
        `SELECT * FROM execution_attempts WHERE work_item_id IN (${placeholders}) ORDER BY attempt_number ASC`,
      (row: ExecutionAttemptRow) => rowToExecutionAttempt(row)
    );
  }

  /** Leases for many work items in bounded `IN (...)` batches, instead of one query per item. */
  listAttemptLeasesForWorkItems(workItemIds: readonly string[]): Map<string, AttemptLease[]> {
    return this.groupByWorkItem(
      workItemIds,
      (placeholders) =>
        `SELECT * FROM attempt_leases WHERE work_item_id IN (${placeholders}) ORDER BY issued_at ASC, fencing_epoch ASC`,
      (row: AttemptLeaseRow) => rowToAttemptLease(row)
    );
  }

  /** Latest admission for each current plan, in the same bounded batches as attempts. */
  listCurrentPlanAdmissionsForWorkItems(workItemIds: readonly string[]): Map<string, ExecutionPlanAdmission> {
    type Row = {
      work_item_id: string;
      admission_id: string;
      plan_id: string;
      plan_hash: string;
      policy_version: string;
      policy_decision_hash: string;
      requires_approval: number;
      admitted_by_actor_id: string;
      admitted_at: string;
    };
    const groups = this.groupByWorkItem(
      workItemIds,
      (placeholders) => `
      SELECT admission.* FROM execution_plan_admissions admission
      JOIN execution_plan_heads head ON head.work_item_id = admission.work_item_id
        AND head.current_plan_id = admission.plan_id AND head.current_plan_hash = admission.plan_hash
      WHERE admission.work_item_id IN (${placeholders}) ORDER BY admission.admitted_at, admission.admission_id`,
      (row: Row) => {
        if (row.requires_approval !== 0 && row.requires_approval !== 1) {
          throw new ControlStackError("execution_plan_admission_invalid", "stored approval requirement is invalid");
        }
        return executionPlanAdmissionSchema.parse({
          admissionId: row.admission_id,
          workItemId: row.work_item_id,
          planId: row.plan_id,
          planHash: row.plan_hash,
          policyVersion: row.policy_version,
          policyDecisionHash: row.policy_decision_hash,
          requiresApproval: row.requires_approval === 1,
          admittedByActorId: row.admitted_by_actor_id,
          admittedAt: row.admitted_at
        });
      }
    );
    return new Map(
      [...groups].flatMap(([id, admissions]) => {
        const admission = admissions.at(-1);
        return admission ? [[id, admission] as const] : [];
      })
    );
  }

  /** Full-store rolling 24-hour telemetry; independent of dashboard pagination.
   * Completion is a terminal attempt transition, never a fabricated tool stage.
   * Only attempts with a persisted start contribute to run/queue latency.
   */
  telemetry(now: Date = new Date()): ExecutionTelemetry {
    const end = now.toISOString();
    const start = new Date(now.getTime() - 86_400_000).toISOString();
    const row = this.db
      .prepare(
        `
      SELECT
        COALESCE(SUM(status = 'succeeded'), 0) AS succeeded,
        COALESCE(SUM(status = 'failed'), 0) AS failed,
        AVG(CASE WHEN started_at IS NOT NULL AND status IN ('succeeded', 'failed')
          AND julianday(updated_at) >= julianday(started_at)
          THEN (julianday(updated_at) - julianday(started_at)) * 86400000 END) AS run_ms,
        AVG(CASE WHEN started_at IS NOT NULL AND julianday(started_at) >= julianday(created_at)
          THEN (julianday(started_at) - julianday(created_at)) * 86400000 END) AS queue_ms
      FROM execution_attempts WHERE updated_at >= ? AND updated_at <= ?
    `
      )
      .get(start, end) as { succeeded: number; failed: number; run_ms: number | null; queue_ms: number | null };
    const throughput: ExecutionTelemetry["throughput"] = Array.from({ length: 24 }, (_, i) => ({
      at: new Date(now.getTime() - 86_400_000 + i * 3_600_000).toISOString(),
      started: 0,
      completed: 0,
      failed: 0
    }));
    const buckets = this.db
      .prepare(
        `
      SELECT CAST((julianday(at) - julianday(?)) * 86400000 + 0.5 AS INTEGER) / 3600000 AS bucket, kind, COUNT(*) AS count
      FROM (
        SELECT started_at AS at, 'started' AS kind FROM execution_attempts WHERE started_at >= ? AND started_at <= ?
        UNION ALL
        SELECT updated_at AS at, 'completed' AS kind FROM execution_attempts WHERE status = 'succeeded' AND updated_at >= ? AND updated_at <= ?
        UNION ALL
        SELECT updated_at AS at, 'failed' AS kind FROM execution_attempts WHERE status = 'failed' AND updated_at >= ? AND updated_at <= ?
      ) GROUP BY bucket, kind
    `
      )
      .all(start, start, end, start, end, start, end) as Array<{
      bucket: number;
      kind: "started" | "completed" | "failed";
      count: number;
    }>;
    for (const bucket of buckets) {
      const target = throughput[Math.min(23, Math.max(0, bucket.bucket))];
      if (target) target[bucket.kind] += bucket.count;
    }
    // Match each recorded grant to its latest preceding approval requirement.
    // Unmatched legacy grants still count, but cannot claim a decision latency.
    const approvals = this.db
      .prepare(
        `
      WITH grants AS (
        SELECT sequence, CAST(time_unix_nano AS REAL) / 1000000 AS granted_ms,
          json_extract(attributes, '$."work_item.id"') AS work_item_id
        FROM audit_events WHERE name = 'approval.granted'
          AND CAST(time_unix_nano AS REAL) / 1000000 BETWEEN ? AND ?
      ), matched AS (
        SELECT granted_ms, (
          SELECT CAST(request.time_unix_nano AS REAL) / 1000000
          FROM audit_events request WHERE (request.name = 'work_item.needs_approval' OR
            (request.name = 'work_item.created' AND json_extract(request.attributes, '$."work_item.status"') = 'needs_approval'))
            AND request.sequence < grants.sequence
            AND json_extract(request.attributes, '$."work_item.id"') = grants.work_item_id
          ORDER BY request.sequence DESC LIMIT 1
        ) AS requested_ms FROM grants
      ) SELECT COUNT(*) AS granted, AVG(CASE WHEN requested_ms <= granted_ms
          THEN granted_ms - requested_ms END) AS latency_ms FROM matched
    `
      )
      .get(now.getTime() - 86_400_000, now.getTime()) as { granted: number; latency_ms: number | null };
    return {
      windowStart: start,
      windowEnd: end,
      approvalsGranted: approvals.granted,
      averageApprovalMs: approvals.latency_ms === null ? null : Math.round(approvals.latency_ms),
      succeeded: row.succeeded,
      failed: row.failed,
      averageRunMs: row.run_ms === null ? null : Math.round(row.run_ms),
      averageQueueMs: row.queue_ms === null ? null : Math.round(row.queue_ms),
      throughput
    };
  }

  private groupByWorkItem<Row extends { work_item_id: string }, T>(
    workItemIds: readonly string[],
    sql: (placeholders: string) => string,
    map: (row: Row) => T
  ): Map<string, T[]> {
    const grouped = new Map<string, T[]>();
    const ids = [...new Set(workItemIds)];
    for (const id of ids) grouped.set(id, []);
    for (let start = 0; start < ids.length; start += EXECUTION_READ_BATCH_SIZE) {
      const batch = ids.slice(start, start + EXECUTION_READ_BATCH_SIZE);
      const rows = this.db.prepare(sql(batch.map(() => "?").join(", "))).all(...batch) as unknown as Row[];
      for (const row of rows) grouped.get(row.work_item_id)?.push(map(row));
    }
    return grouped;
  }

  close(): void {
    this.db.close();
  }
}

/** Keeps each `IN (...)` well under SQLite's bound-parameter limit. */
const EXECUTION_READ_BATCH_SIZE = 500;

function rowToExecutionAttempt(row: ExecutionAttemptRow): ExecutionAttempt {
  return executionAttemptSchema.parse({
    attemptId: row.attempt_id,
    workItemId: row.work_item_id,
    planId: row.plan_id,
    planHash: row.plan_hash,
    attemptNumber: row.attempt_number,
    protocolVersion: row.protocol_version,
    inputHash: row.input_hash,
    status: row.status,
    currentFencingEpoch: row.current_fencing_epoch,
    ...(row.claimed_by_worker_id === null ? {} : { claimedByWorkerId: row.claimed_by_worker_id }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function rowToAttemptLease(row: AttemptLeaseRow): AttemptLease {
  return attemptLeaseSchema.parse({
    leaseId: row.lease_id,
    attemptId: row.attempt_id,
    workItemId: row.work_item_id,
    admissionId: row.admission_id,
    ...(row.approval_id === null ? {} : { approvalId: row.approval_id }),
    workerId: row.worker_id,
    tokenHash: row.token_hash,
    planHash: row.plan_hash,
    inputHash: row.input_hash,
    fencingEpoch: row.fencing_epoch,
    protocolVersion: row.protocol_version,
    policyVersion: row.policy_version,
    policyDecisionHash: row.policy_decision_hash,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    maxExpiresAt: row.max_expires_at,
    lastRenewedAt: row.last_renewed_at,
    status: row.status,
    ...(row.closed_at === null ? {} : { closedAt: row.closed_at })
  });
}
