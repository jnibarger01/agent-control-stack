import { DatabaseSync } from "node:sqlite";
import { ACS_ADMIN_APPROVER } from "@agent-control-stack/policy-gate";
import { ControlStackError, applyControlPlaneMigrations, createId } from "@agent-control-stack/shared";
import { executionPlanApprovalRequestHash } from "@agent-control-stack/work-items";
import {
  jaceCommanderCapabilityNonceHash,
  jaceCommanderToolPolicy,
  type JaceCommanderCapabilityPayload
} from "./jace-commander-capability.js";

/**
 * Durable acs.jc.v1 issuance gate. Must commit BEFORE the payload is signed.
 *
 * In one BEGIN IMMEDIATE transaction it re-reads the live lease, attempt
 * fencing and plan head, and — for privileged_exec — requires that the
 * lease-bound execution-plan approval is `consumed`, unexpired, and bound to
 * the exact plan/action/request hashes in the payload. The insert then trips
 * a unique index if that approval (or lease) has already minted a capability,
 * so an approval is single-use at the database level.
 */
export class SqliteJaceCommanderIssuanceRegistry {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    applyControlPlaneMigrations(this.db);
  }

  close(): void {
    this.db.close();
  }

  recordIssuance(input: { payload: JaceCommanderCapabilityPayload; workerId: string; keyId: string }): void {
    const { payload, workerId } = input;
    const policy = jaceCommanderToolPolicy(payload.toolName);
    if (
      !policy ||
      policy.scopes.length !== 1 ||
      payload.scopes.length !== 1 ||
      payload.scopes[0] !== policy.scopes[0]
    ) {
      throw new ControlStackError("jace_commander_capability_invalid", "tool scope binding is invalid");
    }
    if (Date.parse(payload.expiresAt) <= Date.parse(payload.issuedAt)) {
      throw new ControlStackError("jace_commander_capability_invalid", "capability expiration is invalid");
    }
    const requestHash = executionPlanApprovalRequestHash({
      workItemId: payload.workItemId,
      planHash: payload.planHash,
      actionHash: payload.actionHash
    });
    if (requestHash !== payload.requestHash) {
      throw new ControlStackError(
        "jace_commander_capability_invalid",
        "request hash does not match the payload binding"
      );
    }
    this.transaction(() => {
      const lease = this.db
        .prepare(
          `SELECT leases.plan_hash, leases.approval_id, attempts.current_fencing_epoch, attempts.claimed_by_worker_id, heads.current_plan_hash
        FROM attempt_leases leases JOIN execution_attempts attempts ON attempts.attempt_id = leases.attempt_id AND attempts.work_item_id = leases.work_item_id
        JOIN execution_plan_heads heads ON heads.work_item_id = leases.work_item_id
        WHERE leases.lease_id = ? AND leases.attempt_id = ? AND leases.work_item_id = ? AND leases.worker_id = ? AND leases.status = 'active' AND leases.expires_at > ?`
        )
        .get(payload.leaseId, payload.attemptId, payload.workItemId, workerId, payload.issuedAt) as
        | {
            plan_hash: string;
            approval_id: string | null;
            current_fencing_epoch: number;
            claimed_by_worker_id: string | null;
            current_plan_hash: string;
          }
        | undefined;
      if (
        !lease ||
        lease.plan_hash !== payload.planHash ||
        lease.current_plan_hash !== payload.planHash ||
        lease.current_fencing_epoch !== payload.leaseEpoch ||
        lease.claimed_by_worker_id !== workerId
      ) {
        throw new ControlStackError(
          "jace_commander_capability_lease_rejected",
          "current lease fencing or plan binding is invalid"
        );
      }
      if (policy.requiresApproval) {
        if (!payload.approvalId || lease.approval_id !== payload.approvalId) {
          throw new ControlStackError(
            "jace_commander_approval_rejected",
            "capability approval does not match the lease-bound approval"
          );
        }
        const approval = this.db
          .prepare(
            `SELECT status, request_hash, plan_hash, action_hash, expires_at, consumed_at, approved_by_actor_id
          FROM execution_plan_approvals WHERE work_item_id = ? AND approval_id = ?`
          )
          .get(payload.workItemId, payload.approvalId) as
          | {
              status: string;
              request_hash: string;
              plan_hash: string;
              action_hash: string;
              expires_at: string;
              consumed_at: string | null;
              approved_by_actor_id: string;
            }
          | undefined;
        if (
          !approval ||
          approval.status !== "consumed" ||
          !approval.consumed_at ||
          approval.plan_hash !== payload.planHash ||
          approval.action_hash !== payload.actionHash ||
          approval.request_hash !== requestHash ||
          approval.expires_at < payload.expiresAt ||
          // Root execution needs a human: admin-mode auto-approval never counts.
          approval.approved_by_actor_id === ACS_ADMIN_APPROVER
        ) {
          throw new ControlStackError(
            "jace_commander_approval_rejected",
            "lease-bound approval is missing, expired, or mismatched"
          );
        }
      } else if (lease.approval_id || payload.approvalId !== undefined) {
        throw new ControlStackError("jace_commander_approval_rejected", "approval is not permitted for this tool");
      }
      try {
        this.db
          .prepare(
            `INSERT INTO jace_commander_capability_issuances (capability_issuance_id, lease_id, attempt_id, work_item_id, runtime_id, tool_name, scope_name, action_hash, request_hash, invocation_hash, approval_id, key_id, nonce_hash, issued_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            createId("jc_capability"),
            payload.leaseId,
            payload.attemptId,
            payload.workItemId,
            payload.runtimeId,
            payload.toolName,
            policy.scopes[0]!,
            payload.actionHash,
            requestHash,
            payload.invocationHash,
            payload.approvalId ?? null,
            input.keyId,
            jaceCommanderCapabilityNonceHash(payload.nonce),
            payload.issuedAt,
            payload.expiresAt
          );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/UNIQUE constraint failed: jace_commander_capability_issuances\.approval_id/u.test(message)) {
          throw new ControlStackError("jace_commander_approval_reused", "approval has already minted a capability");
        }
        if (/UNIQUE constraint failed: jace_commander_capability_issuances\./u.test(message)) {
          throw new ControlStackError(
            "jace_commander_capability_already_issued",
            "a capability was already issued for this lease"
          );
        }
        throw error;
      }
    });
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* no active transaction */
      }
      throw error;
    }
  }
}
