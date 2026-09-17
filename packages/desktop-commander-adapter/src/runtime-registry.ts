import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ControlStackError, applyControlPlaneMigrations, createId } from "@agent-control-stack/shared";
import { executionPlanApprovalRequestHash } from "@agent-control-stack/work-items";
import { desktopCommanderCapabilityNonceHash } from "./capability.js";

const ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const SCOPES = new Set(["fs.read", "fs.write", "process.exec", "process.spawn", "network.read", "network.write"]);

export interface RuntimeAttestation {
  readonly runtimeId: string;
  readonly identityConfigFingerprint: string;
  readonly scopes: readonly string[];
}

export interface RuntimeBootstrapChallenge extends RuntimeAttestation {
  readonly challenge: string;
  readonly expiresAt: string;
}

export interface RuntimeBootstrapRegistry {
  issueBootstrap(
    input: Omit<RuntimeAttestation, "scopes"> & { scopes: readonly string[]; ttlMs?: number },
    now?: Date
  ): RuntimeBootstrapChallenge;
  completeBootstrap(input: RuntimeAttestation & { challenge: string }, now?: Date): void;
}

export interface CapabilityIssuanceBinding {
  readonly runtimeId: string;
  /** Current expected DC identity/config fingerprint; rechecked at issuance. */
  readonly identityConfigFingerprint: string;
  readonly leaseId: string;
  readonly attemptId: string;
  readonly workItemId: string;
  readonly workerId: string;
  readonly fencingEpoch: number;
  readonly planHash: string;
  readonly actionHash: string;
  readonly invocationHash: string;
  readonly requiredScopes: readonly string[];
  readonly approvalRequired: boolean;
  /** Signed capability claim; must exactly match the approval consumed by the lease. */
  readonly approvalId?: string;
  readonly keyId: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

function stableScopes(scopes: readonly string[]): string[] {
  if (scopes.length === 0 || new Set(scopes).size !== scopes.length || scopes.some((scope) => !SCOPES.has(scope))) {
    throw new ControlStackError("desktop_commander_runtime_scope_invalid", "runtime scopes are invalid");
  }
  const sorted = [...scopes].sort();
  if (sorted.some((scope, index) => scope !== scopes[index])) {
    throw new ControlStackError("desktop_commander_runtime_scope_invalid", "runtime scopes must be sorted and unique");
  }
  return sorted;
}

function requireId(value: string, label: string): void {
  if (!ID.test(value)) throw new ControlStackError("desktop_commander_runtime_invalid", `${label} is invalid`);
}
function requireHash(value: string, label: string): void {
  if (!HASH.test(value)) throw new ControlStackError("desktop_commander_runtime_invalid", `${label} is invalid`);
}
function challengeHash(challenge: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(challenge)) {
    throw new ControlStackError("desktop_commander_runtime_challenge_invalid", "bootstrap challenge is invalid");
  }
  return createHash("sha256").update(Buffer.from(challenge, "base64url")).digest("hex");
}

/**
 * Durable ACS-side identity, attestation, and issuance gate. It shares the
 * authoritative control-plane SQLite database; raw challenges/nonces never
 * enter persisted rows. Call `recordIssuance` before signing a capability.
 */
export class SqliteDesktopCommanderRuntimeRegistry {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    applyControlPlaneMigrations(this.db);
  }

  close(): void {
    this.db.close();
  }

  issueBootstrap(
    input: Omit<RuntimeAttestation, "scopes"> & { scopes: readonly string[]; ttlMs?: number },
    now = new Date()
  ): RuntimeBootstrapChallenge {
    requireId(input.runtimeId, "runtimeId");
    requireHash(input.identityConfigFingerprint, "identityConfigFingerprint");
    const scopes = stableScopes(input.scopes);
    const ttlMs = input.ttlMs ?? 30_000;
    if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > 30_000)
      throw new ControlStackError("desktop_commander_runtime_challenge_invalid", "challenge ttl is invalid");
    const challenge = randomBytes(32).toString("base64url");
    const issuedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    this.transaction(() => {
      this.db
        .prepare(
          "UPDATE desktop_commander_bootstrap_challenges SET status = 'expired' WHERE runtime_id = ? AND status = 'pending' AND expires_at <= ?"
        )
        .run(input.runtimeId, issuedAt);
      this.db
        .prepare(
          `INSERT INTO desktop_commander_bootstrap_challenges
        (challenge_id, runtime_id, challenge_hash, expected_identity_config_fingerprint, status, issued_at, expires_at, consumed_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL)`
        )
        .run(
          createId("dc_challenge"),
          input.runtimeId,
          challengeHash(challenge),
          input.identityConfigFingerprint,
          issuedAt,
          expiresAt
        );
      const row = this.db
        .prepare("SELECT challenge_id FROM desktop_commander_bootstrap_challenges WHERE challenge_hash = ?")
        .get(challengeHash(challenge)) as { challenge_id: string };
      const insert = this.db.prepare(
        "INSERT INTO desktop_commander_bootstrap_challenge_scopes (challenge_id, scope_name) VALUES (?, ?)"
      );
      for (const scope of scopes) insert.run(row.challenge_id, scope);
    });
    return {
      runtimeId: input.runtimeId,
      identityConfigFingerprint: input.identityConfigFingerprint,
      scopes,
      challenge,
      expiresAt
    };
  }

  completeBootstrap(input: RuntimeAttestation & { challenge: string }, now = new Date()): void {
    requireId(input.runtimeId, "runtimeId");
    requireHash(input.identityConfigFingerprint, "identityConfigFingerprint");
    const scopes = stableScopes(input.scopes);
    this.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT challenge_id, expected_identity_config_fingerprint FROM desktop_commander_bootstrap_challenges
        WHERE runtime_id = ? AND challenge_hash = ? AND status = 'pending' AND expires_at > ?`
        )
        .get(input.runtimeId, challengeHash(input.challenge), now.toISOString()) as
        { challenge_id: string; expected_identity_config_fingerprint: string } | undefined;
      if (!row || row.expected_identity_config_fingerprint !== input.identityConfigFingerprint)
        throw new ControlStackError(
          "desktop_commander_runtime_attestation_rejected",
          "runtime challenge or identity does not match"
        );
      const expected = (
        this.db
          .prepare(
            "SELECT scope_name FROM desktop_commander_bootstrap_challenge_scopes WHERE challenge_id = ? ORDER BY scope_name"
          )
          .all(row.challenge_id) as Array<{ scope_name: string }>
      ).map((value) => value.scope_name);
      if (expected.length !== scopes.length || expected.some((scope, index) => scope !== scopes[index]))
        throw new ControlStackError(
          "desktop_commander_runtime_attestation_rejected",
          "runtime scopes do not match the challenge"
        );
      const runtime = this.db
        .prepare("SELECT identity_config_fingerprint, status FROM desktop_commander_runtimes WHERE runtime_id = ?")
        .get(input.runtimeId) as { identity_config_fingerprint: string; status: string } | undefined;
      if (
        runtime?.status === "revoked" ||
        (runtime && runtime.identity_config_fingerprint !== input.identityConfigFingerprint)
      )
        throw new ControlStackError(
          "desktop_commander_runtime_attestation_rejected",
          "runtime registration drift or revocation detected"
        );
      if (!runtime) {
        this.db
          .prepare(
            `INSERT INTO desktop_commander_runtimes (runtime_id, identity_config_fingerprint, status, registered_at, attested_at, revoked_at, revocation_reason)
          VALUES (?, ?, 'active', ?, ?, NULL, NULL)`
          )
          .run(input.runtimeId, input.identityConfigFingerprint, now.toISOString(), now.toISOString());
        const insert = this.db.prepare(
          "INSERT INTO desktop_commander_runtime_scopes (runtime_id, scope_name) VALUES (?, ?)"
        );
        for (const scope of scopes) insert.run(input.runtimeId, scope);
      } else {
        const existing = (
          this.db
            .prepare("SELECT scope_name FROM desktop_commander_runtime_scopes WHERE runtime_id = ? ORDER BY scope_name")
            .all(input.runtimeId) as Array<{ scope_name: string }>
        ).map((value) => value.scope_name);
        if (existing.length !== scopes.length || existing.some((scope, index) => scope !== scopes[index]))
          throw new ControlStackError("desktop_commander_runtime_attestation_rejected", "runtime scope drift detected");
        this.db
          .prepare("UPDATE desktop_commander_runtimes SET attested_at = ? WHERE runtime_id = ? AND status = 'active'")
          .run(now.toISOString(), input.runtimeId);
      }
      const consumed = this.db
        .prepare(
          "UPDATE desktop_commander_bootstrap_challenges SET status = 'consumed', consumed_at = ? WHERE challenge_id = ? AND status = 'pending'"
        )
        .run(now.toISOString(), row.challenge_id) as { changes: number };
      if (consumed.changes !== 1)
        throw new ControlStackError(
          "desktop_commander_runtime_attestation_rejected",
          "bootstrap challenge was already consumed"
        );
    });
  }

  revoke(runtimeId: string, reason: string, now = new Date()): void {
    requireId(runtimeId, "runtimeId");
    if (reason.trim().length === 0)
      throw new ControlStackError("desktop_commander_runtime_invalid", "revocation reason is required");
    this.transaction(() => {
      const result = this.db
        .prepare(
          "UPDATE desktop_commander_runtimes SET status = 'revoked', revoked_at = ?, revocation_reason = ? WHERE runtime_id = ? AND status = 'active'"
        )
        .run(now.toISOString(), reason, runtimeId) as { changes: number };
      if (result.changes !== 1)
        throw new ControlStackError(
          "desktop_commander_runtime_revocation_rejected",
          "runtime is missing or already revoked"
        );
    });
  }

  recordIssuance(input: CapabilityIssuanceBinding): { requestHash: string; approvalId?: string } {
    requireId(input.runtimeId, "runtimeId");
    requireHash(input.identityConfigFingerprint, "identityConfigFingerprint");
    for (const [value, label] of [
      [input.leaseId, "leaseId"],
      [input.attemptId, "attemptId"],
      [input.workItemId, "workItemId"],
      [input.workerId, "workerId"]
    ] as const)
      requireId(value, label);
    for (const [value, label] of [
      [input.planHash, "planHash"],
      [input.actionHash, "actionHash"],
      [input.invocationHash, "invocationHash"]
    ] as const)
      requireHash(value, label);
    if (input.approvalId !== undefined) requireId(input.approvalId, "approvalId");
    const scopes = stableScopes(input.requiredScopes);
    const now = input.issuedAt;
    if (Date.parse(input.expiresAt) <= Date.parse(now) || Date.parse(input.expiresAt) - Date.parse(now) > 30_000)
      throw new ControlStackError("desktop_commander_capability_invalid", "capability expiration is invalid");
    return this.transaction(() => {
      const lease = this.db
        .prepare(
          `SELECT leases.plan_hash, leases.input_hash, leases.approval_id, attempts.current_fencing_epoch, attempts.claimed_by_worker_id, heads.current_plan_hash
        FROM attempt_leases leases JOIN execution_attempts attempts ON attempts.attempt_id = leases.attempt_id AND attempts.work_item_id = leases.work_item_id
        JOIN execution_plan_heads heads ON heads.work_item_id = leases.work_item_id
        WHERE leases.lease_id = ? AND leases.attempt_id = ? AND leases.work_item_id = ? AND leases.worker_id = ? AND leases.status = 'active' AND leases.expires_at > ?`
        )
        .get(input.leaseId, input.attemptId, input.workItemId, input.workerId, now) as
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
      )
        throw new ControlStackError(
          "desktop_commander_capability_lease_rejected",
          "current lease fencing or plan binding is invalid"
        );
      const runtime = this.db
        .prepare("SELECT status, identity_config_fingerprint FROM desktop_commander_runtimes WHERE runtime_id = ?")
        .get(input.runtimeId) as { status: string; identity_config_fingerprint: string } | undefined;
      if (
        !runtime ||
        runtime.status !== "active" ||
        runtime.identity_config_fingerprint !== input.identityConfigFingerprint
      ) {
        throw new ControlStackError(
          "desktop_commander_runtime_not_active",
          "runtime identity is missing, drifted, or revoked"
        );
      }
      const granted = (
        this.db
          .prepare("SELECT scope_name FROM desktop_commander_runtime_scopes WHERE runtime_id = ? ORDER BY scope_name")
          .all(input.runtimeId) as Array<{ scope_name: string }>
      ).map((row) => row.scope_name);
      if (scopes.some((scope) => !granted.includes(scope)))
        throw new ControlStackError(
          "desktop_commander_runtime_scope_rejected",
          "runtime lacks a required capability scope"
        );
      const requestHash = executionPlanApprovalRequestHash({
        workItemId: input.workItemId,
        planHash: input.planHash,
        actionHash: input.actionHash
      });
      let approvalId: string | undefined;
      if (input.approvalRequired) {
        if (!input.approvalId || lease.approval_id !== input.approvalId) {
          throw new ControlStackError(
            "desktop_commander_approval_rejected",
            "capability approval does not match the lease-bound approval"
          );
        }
        const approval = this.db
          .prepare(
            `SELECT approvals.approval_id, approvals.status, approvals.request_hash, approvals.plan_hash, approvals.action_hash, approvals.expires_at, approvals.consumed_at
          FROM execution_plan_approvals approvals WHERE approvals.work_item_id = ? AND approvals.approval_id = ?`
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
        )
          throw new ControlStackError(
            "desktop_commander_approval_rejected",
            "lease-bound approval is missing, expired, or mismatched"
          );
        approvalId = approval.approval_id;
      } else if (lease.approval_id || input.approvalId !== undefined) {
        throw new ControlStackError("desktop_commander_approval_rejected", "approval is not permitted for this tool");
      }
      const issuanceId = createId("dc_capability");
      this.db
        .prepare(
          `INSERT INTO desktop_commander_capability_issuances (capability_issuance_id, lease_id, attempt_id, work_item_id, runtime_id, action_hash, request_hash, invocation_hash, approval_id, key_id, nonce_hash, issued_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          issuanceId,
          input.leaseId,
          input.attemptId,
          input.workItemId,
          input.runtimeId,
          input.actionHash,
          requestHash,
          input.invocationHash,
          approvalId ?? null,
          input.keyId,
          desktopCommanderCapabilityNonceHash(input.nonce),
          now,
          input.expiresAt
        );
      const insertScope = this.db.prepare(
        "INSERT INTO desktop_commander_capability_issuance_scopes (capability_issuance_id, scope_name) VALUES (?, ?)"
      );
      for (const scope of scopes) insertScope.run(issuanceId, scope);
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
