import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ControlStackError, applyControlPlaneMigrations, createId } from "@agent-control-stack/shared";
import { executionPlanApprovalRequestHash } from "@agent-control-stack/work-items";
import {
  JM_RUNTIME_BOOTSTRAP_SCHEMA_VERSION,
  jaceMemNonceHash,
  jaceMemSubjectHash,
  validateJaceMemRuntimeIdentity,
  validateJaceMemSubject,
  type JaceMemRuntimeBootstrap,
  type JaceMemSubject
} from "./issuer.js";
import { jmToolContract } from "./manifest.js";

/** The approver identity ACS records for admin-mode auto-approval (policy-gate ACS_ADMIN_APPROVER). */
const ACS_ADMIN_APPROVER = "acs:admin";
const HASH = /^[a-f0-9]{64}$/u;

export interface JaceMemIssuanceBinding {
  /** Required by the gateway; omitted only by the standalone issuer/vector path. */
  readonly launchId?: string;
  /** Required with launchId: ACS's own verification-config fingerprint, which the launch must have attested. */
  readonly configFingerprint?: string;
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
  readonly subject: JaceMemSubject;
  /** Attested requester of the work item; must equal subject.agent and can never approve its own call. */
  readonly requesterSubject: string;
  readonly approvalId?: string;
  readonly keyId: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/**
 * Durable acs.jm.v1 issuance gate. Must commit BEFORE the capability is
 * signed. Inside one IMMEDIATE transaction it re-derives the lease, fencing
 * epoch and plan binding from ACS state; for memory.delete and memory.share
 * tools it requires the lease-bound approval to be consumed, bound to this
 * exact plan and action, unexpired for the capability's lifetime, and granted
 * by a human who is neither the requester nor the ACS admin-mode approver.
 * One capability per lease+invocation and per approval; nonce hashes are
 * unique. The table is append-only and its CHECK constraints repeat the
 * scope and approval rules, so a bug here cannot persist an illegal row.
 */
export class SqliteJaceMemIssuanceRegistry {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    applyControlPlaneMigrations(this.db);
  }

  close(): void {
    this.db.close();
  }

  /** Trusted boot API only. Existing launch IDs can never acquire a different identity. */
  registerLaunch(launchId: string, runtimeId: string, subject: JaceMemSubject): void {
    if (![launchId, runtimeId].every((id) => /^[A-Za-z0-9._:-]{1,128}$/u.test(id))) {
      throw new ControlStackError("jace_mem_launch_invalid", "launch or runtime ID is invalid");
    }
    const hash = jaceMemSubjectHash(validateJaceMemSubject(subject));
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO jace_mem_launches (launch_id, runtime_id, subject_hash, registered_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(launch_id) DO NOTHING`
        )
        .run(launchId, runtimeId, hash, new Date().toISOString());
      this.assertLaunch(launchId, runtimeId, hash);
    });
  }

  /**
   * Starts a runtime identity exchange for a registered launch: stores only the hash of a fresh 32-byte
   * challenge (single use, at most 120 s) and returns the exact bootstrap object the bridge must deliver to the
   * Jace-Mem process in MCP initialize.
   */
  issueLaunchChallenge(
    launchId: string,
    subject: JaceMemSubject,
    configFingerprint: string,
    now = new Date(),
    ttlMs = 60_000
  ): JaceMemRuntimeBootstrap & { expiresAt: string } {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > 120_000) {
      throw new ControlStackError("jace_mem_runtime_challenge_invalid", "challenge lifetime must be 1..120000 ms");
    }
    if (!HASH.test(configFingerprint))
      throw new ControlStackError("jace_mem_runtime_invalid", "config fingerprint is invalid");
    const validSubject = validateJaceMemSubject(subject);
    const challenge = randomBytes(32).toString("base64url");
    const issuedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const runtimeId = this.transaction(() => {
      const row = this.db
        .prepare("SELECT runtime_id, subject_hash FROM jace_mem_launches WHERE launch_id = ?")
        .get(launchId) as { runtime_id: string; subject_hash: string } | undefined;
      if (!row) throw new ControlStackError("jace_mem_launch_unknown", "trusted launch is not registered");
      if (row.subject_hash !== jaceMemSubjectHash(validSubject)) {
        throw new ControlStackError("jace_mem_launch_binding_mismatch", "launch identity cannot be rebound");
      }
      this.db
        .prepare(
          "INSERT INTO jace_mem_launch_challenges (challenge_hash, launch_id, issued_at, expires_at) VALUES (?, ?, ?, ?)"
        )
        .run(challengeHash(challenge), launchId, issuedAt, expiresAt);
      return row.runtime_id;
    });
    return Object.freeze({
      schemaVersion: JM_RUNTIME_BOOTSTRAP_SCHEMA_VERSION,
      runtimeId,
      launchId,
      challenge,
      subject: validSubject,
      configFingerprint,
      expiresAt
    });
  }

  /**
   * Completes the exchange with the identity the Jace-Mem process echoed. Every field must equal what ACS
   * registered and issued: the unexpired, unconsumed challenge for this launch, the launch's runtime and subject,
   * and ACS's own verification-config fingerprint. The challenge is consumed and an attestation is appended in
   * one transaction. Any mismatch leaves the launch unattested.
   */
  completeLaunchAttestation(
    launchId: string,
    echoed: unknown,
    expectedConfigFingerprint: string,
    now = new Date()
  ): { attestationId: string; attestedAt: string } {
    const identity = validateJaceMemRuntimeIdentity(echoed);
    const reject = (message: string): never => {
      throw new ControlStackError("jace_mem_runtime_attestation_rejected", message);
    };
    if (identity.launchId !== launchId) reject("runtime identity names another launch");
    if (identity.configFingerprint !== expectedConfigFingerprint)
      reject("runtime verification config does not match ACS");
    const hash = challengeHash(identity.challenge);
    const attestedAt = now.toISOString();
    return this.transaction(() => {
      const launch = this.db
        .prepare("SELECT runtime_id, subject_hash FROM jace_mem_launches WHERE launch_id = ?")
        .get(launchId) as { runtime_id: string; subject_hash: string } | undefined;
      if (!launch) throw new ControlStackError("jace_mem_launch_unknown", "trusted launch is not registered");
      if (launch.runtime_id !== identity.runtimeId) reject("runtime identity names another runtime");
      if (launch.subject_hash !== jaceMemSubjectHash(identity.subject))
        reject("runtime identity names another subject");
      const challenge = this.db
        .prepare("SELECT launch_id, expires_at, consumed_at FROM jace_mem_launch_challenges WHERE challenge_hash = ?")
        .get(hash) as { launch_id: string; expires_at: string; consumed_at: string | null } | undefined;
      if (!challenge || challenge.launch_id !== launchId) reject("challenge was not issued for this launch");
      if (challenge!.consumed_at !== null) reject("challenge was already used");
      if (Date.parse(challenge!.expires_at) <= now.getTime()) reject("challenge expired");
      this.db
        .prepare("UPDATE jace_mem_launch_challenges SET consumed_at = ? WHERE challenge_hash = ?")
        .run(attestedAt, hash);
      const attestationId = createId("jm_attestation");
      this.db
        .prepare(
          "INSERT INTO jace_mem_launch_attestations (attestation_id, launch_id, challenge_hash, config_fingerprint, attested_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(attestationId, launchId, hash, identity.configFingerprint, attestedAt);
      return { attestationId, attestedAt };
    });
  }

  /** True when the launch has attested with this verification-config fingerprint. */
  isLaunchAttested(launchId: string, configFingerprint: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM jace_mem_launch_attestations WHERE launch_id = ? AND config_fingerprint = ? LIMIT 1")
        .get(launchId, configFingerprint) !== undefined
    );
  }

  private assertLaunch(launchId: string, runtimeId: string, subjectHash: string): void {
    const row = this.db
      .prepare("SELECT runtime_id, subject_hash FROM jace_mem_launches WHERE launch_id = ?")
      .get(launchId);
    if (!row || row.runtime_id !== runtimeId || row.subject_hash !== subjectHash) {
      throw new ControlStackError("jace_mem_launch_binding_mismatch", "launch identity cannot be rebound");
    }
  }

  recordIssuance(input: JaceMemIssuanceBinding): { requestHash: string; approvalId?: string } {
    const policy = jmToolContract(input.toolName);
    if (!policy) throw new ControlStackError("jace_mem_tool_not_allowlisted", "unknown tool");
    for (const [value, label] of [
      [input.planHash, "planHash"],
      [input.actionHash, "actionHash"],
      [input.invocationHash, "invocationHash"]
    ] as const) {
      if (!HASH.test(value)) throw new ControlStackError("jace_mem_capability_invalid", `${label} is invalid`);
    }
    const subject = validateJaceMemSubject(input.subject);
    if (typeof input.requesterSubject !== "string" || input.requesterSubject.length === 0) {
      throw new ControlStackError("jace_mem_requester_unknown", "a known requester is required");
    }
    if (subject.agent !== input.requesterSubject) {
      throw new ControlStackError("jace_mem_subject_agent_mismatch", "subject.agent is not the attested requester");
    }
    const issuedMs = Date.parse(input.issuedAt);
    const expiresMs = Date.parse(input.expiresAt);
    if (!(expiresMs > issuedMs) || expiresMs - issuedMs > 30_000) {
      throw new ControlStackError("jace_mem_capability_invalid", "capability expiration is invalid");
    }

    return this.transaction(() => {
      if (input.launchId !== undefined) {
        this.assertLaunch(input.launchId, input.runtimeId, jaceMemSubjectHash(subject));
        // JM-ACS-02: no capability for a launch whose Jace-Mem process has not proven its identity and config.
        if (input.configFingerprint === undefined || !this.isLaunchAttested(input.launchId, input.configFingerprint)) {
          throw new ControlStackError(
            "jace_mem_launch_unattested",
            "the launch has not completed runtime identity attestation"
          );
        }
      }
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
        throw new ControlStackError("jace_mem_capability_lease_rejected", "lease fencing or plan binding is invalid");
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
          throw new ControlStackError("jace_mem_approval_rejected", "approval does not match the lease-bound approval");
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
          throw new ControlStackError("jace_mem_approval_rejected", "approval is missing, expired, or mismatched");
        }
        if (approval.approved_by_actor_id === input.requesterSubject) {
          throw new ControlStackError("jace_mem_self_approval_denied", `${input.toolName} cannot be self-approved`);
        }
        if (approval.approved_by_actor_id === ACS_ADMIN_APPROVER) {
          throw new ControlStackError(
            "jace_mem_human_approval_required",
            `${input.toolName} requires a human approval; admin-mode auto-approval does not apply`
          );
        }
        approvalId = approval.approval_id;
        approvedBy = approval.approved_by_actor_id;
      } else if (lease.approval_id || input.approvalId !== undefined) {
        throw new ControlStackError("jace_mem_approval_rejected", "approval is not permitted for this tool");
      }

      try {
        this.db
          .prepare(
            `INSERT INTO jace_mem_capability_issuances
            (capability_issuance_id, lease_id, attempt_id, work_item_id, runtime_id, tool_name, scope, subject_hash,
             requester_subject, action_hash, request_hash, invocation_hash, approval_id, approved_by_actor_id, key_id,
             nonce_hash, issued_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            createId("jm_capability"),
            input.leaseId,
            input.attemptId,
            input.workItemId,
            input.runtimeId,
            input.toolName,
            policy.scopes[0]!,
            jaceMemSubjectHash(subject),
            input.requesterSubject,
            input.actionHash,
            requestHash,
            input.invocationHash,
            approvalId ?? null,
            approvedBy ?? null,
            input.keyId,
            jaceMemNonceHash(input.nonce),
            input.issuedAt,
            input.expiresAt
          );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/UNIQUE constraint failed: jace_mem_capability_issuances/u.test(message)) {
          throw new ControlStackError(
            "jace_mem_capability_already_issued",
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

function challengeHash(challenge: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(challenge)) {
    throw new ControlStackError("jace_mem_runtime_challenge_invalid", "bootstrap challenge is invalid");
  }
  return createHash("sha256").update(Buffer.from(challenge, "base64url")).digest("hex");
}
