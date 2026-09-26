import { DatabaseSync } from "node:sqlite";
import { ControlStackError, applyControlPlaneMigrations, createId } from "@agent-control-stack/shared";
import { executionPlanApprovalRequestHash } from "@agent-control-stack/work-items";
import { ACS_ADMIN_APPROVER } from "@agent-control-stack/policy-gate";
import { JACE_COMMANDER_PRIVILEGED_TOOL, jaceCommanderNonceHash, jaceCommanderToolPolicy } from "./jace-commander.js";

export interface JaceCommanderIssuanceBinding {
  readonly runtimeId: string;
  readonly toolName: string;
  readonly leaseId: string;
  readonly attemptId: string;
  readonly workItemId: string;
  readonly workerId: string;
  readonly fencingEpoch: number;
  readonly planHash: string;
  readonly actionHash: string;
  readonly invocationHash: string;
  readonly approvalId?: string;
  /** requesterSubject of the work item; a privileged approval by this actor is self-approval. */
  readonly requesterSubject: string;
  readonly keyId: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

const HASH = /^[a-f0-9]{64}$/u;

/**
 * Durable acs.jc.v1 issuance gate. Must commit BEFORE the capability is
 * signed. Re-derives lease/fencing/plan binding and, for privileged_exec,
 * requires a consumed approval bound to this exact plan+action that was
 * granted by a human: never `acs:admin`, never the requesting actor.
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

  recordIssuance(input: JaceCommanderIssuanceBinding): { requestHash: string; approvalId?: string } {
    const policy = jaceCommanderToolPolicy(input.toolName);
    if (!policy) throw new ControlStackError("jace_commander_tool_not_allowlisted", "unknown tool");
    for (const [value, label] of [
      [input.planHash, "planHash"],
      [input.actionHash, "actionHash"],
      [input.invocationHash, "invocationHash"]
    ] as const) {
      if (!HASH.test(value)) throw new ControlStackError("jace_commander_capability_invalid", `${label} is invalid`);
    }
    const issuedMs = Date.parse(input.issuedAt);
    const expiresMs = Date.parse(input.expiresAt);
    if (!(expiresMs > issuedMs) || expiresMs - issuedMs > 30_000) {
      throw new ControlStackError("jace_commander_capability_invalid", "capability expiration is invalid");
    }

    return this.transaction(() => {
      const lease = this.db
        .prepare(
          `SELECT leases.plan_hash, leases.approval_id, attempts.current_fencing_epoch, attempts.claimed_by_worker_id, heads.current_plan_hash
          FROM attempt_leases leases
          JOIN execution_attempts attempts ON attempts.attempt_id = leases.attempt_id AND attempts.work_item_id = leases.work_item_id
          JOIN execution_plan_heads heads ON heads.work_item_id = leases.work_item_id
          WHERE leases.lease_id = ? AND leases.attempt_id = ? AND leases.work_item_id = ? AND leases.worker_id = ?
            AND leases.status = 'active' AND leases.expires_at > ?`
        )
        .get(input.leaseId, input.attemptId, input.workItemId, input.workerId, input.issuedAt) as
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
        lease.plan_hash !== input.planHash ||
        lease.current_plan_hash !== input.planHash ||
        lease.current_fencing_epoch !== input.fencingEpoch ||
        lease.claimed_by_worker_id !== input.workerId
      ) {
        throw new ControlStackError(
          "jace_commander_capability_lease_rejected",
          "lease fencing or plan binding is invalid"
        );
      }

      const requestHash = executionPlanApprovalRequestHash({
        workItemId: input.workItemId,
        planHash: input.planHash,
        actionHash: input.actionHash
      });

      let approvalId: string | undefined;
      let approvedBy: string | undefined;
      if (policy.requiresApproval) {
        if (!input.approvalId || lease.approval_id !== input.approvalId) {
          throw new ControlStackError(
            "jace_commander_approval_rejected",
            "approval does not match the lease-bound approval"
          );
        }
        const approval = this.db
          .prepare(
            `SELECT approval_id, status, request_hash, plan_hash, action_hash, expires_at, consumed_at, approved_by_actor_id
            FROM execution_plan_approvals WHERE work_item_id = ? AND approval_id = ?`
          )
          .get(input.workItemId, lease.approval_id) as
          | {
              approval_id: string;
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
          approval.plan_hash !== input.planHash ||
          approval.action_hash !== input.actionHash ||
          approval.request_hash !== requestHash ||
          approval.expires_at < input.expiresAt
        ) {
          throw new ControlStackError(
            "jace_commander_approval_rejected",
            "approval is missing, expired, or mismatched"
          );
        }
        if (input.toolName === JACE_COMMANDER_PRIVILEGED_TOOL) {
          if (approval.approved_by_actor_id === ACS_ADMIN_APPROVER) {
            throw new ControlStackError(
              "jace_commander_human_approval_required",
              "privileged_exec requires a human approval; admin auto-approval is not accepted"
            );
          }
          if (approval.approved_by_actor_id === input.requesterSubject) {
            throw new ControlStackError(
              "jace_commander_self_approval_denied",
              "privileged_exec cannot be self-approved"
            );
          }
        }
        approvalId = approval.approval_id;
        approvedBy = approval.approved_by_actor_id;
      } else if (lease.approval_id || input.approvalId !== undefined) {
        throw new ControlStackError("jace_commander_approval_rejected", "approval is not permitted for this tool");
      }

      try {
        this.db
          .prepare(
            `INSERT INTO jace_commander_capability_issuances
            (capability_issuance_id, lease_id, attempt_id, work_item_id, runtime_id, tool_name, action_hash, request_hash,
             invocation_hash, approval_id, approved_by_actor_id, key_id, nonce_hash, issued_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            createId("jc_capability"),
            input.leaseId,
            input.attemptId,
            input.workItemId,
            input.runtimeId,
            input.toolName,
            input.actionHash,
            requestHash,
            input.invocationHash,
            approvalId ?? null,
            approvedBy ?? null,
            input.keyId,
            jaceCommanderNonceHash(input.nonce),
            input.issuedAt,
            input.expiresAt
          );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/UNIQUE constraint failed: jace_commander_capability_issuances/u.test(message)) {
          throw new ControlStackError(
            "jace_commander_capability_already_issued",
            "a capability was already issued for this lease/invocation or approval"
          );
        }
        throw error;
      }
      return approvalId ? { requestHash, approvalId } : { requestHash };
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
