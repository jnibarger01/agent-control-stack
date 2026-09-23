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
