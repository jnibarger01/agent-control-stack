import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ControlStackError,
  applyControlPlaneMigrations,
  controlPlaneMigrations,
  stableHash
} from "@agent-control-stack/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORKER_PROTOCOL_VERSION,
  defaultExecutionPlanForWorkItem,
  executionAttemptInputHash,
  executionPlanHash,
  executionPlanSubjectInputHash,
  type ClaimExecutionAttemptInput,
  type ExecutionPlanAdmission,
  type ExecutionPlanRecord
} from "./execution-plan.js";
import { SqliteWorkItemStore } from "./store.js";
import { executionActionHash, type WorkItem } from "./work-item.js";

const temporaryDirectories: string[] = [];
const fixedNow = new Date("2026-07-23T20:00:00.000Z");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("schema v6 migration custody", () => {
  it("refuses a v5 database with an active legacy lease and rolls back schema and audit changes", () => {
    const dbPath = temporaryDatabasePath("active-legacy");
    const db = createV5Database(dbPath);
    seedV5WorkItem(db, {
      id: "wrk_active_legacy",
      status: "running",
      workerId: "legacy-worker",
      leaseTokenHash: "a".repeat(64),
      startedAt: "2026-07-23T19:00:00.000Z",
      leaseExpiresAt: "2026-07-23T21:00:00.000Z"
    });
    db.prepare(
      `INSERT INTO leases
       (lease_id, work_item_id, worker_id, token_hash, action_hash, issued_at, expires_at, status, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL)`
    ).run(
      "legacy_active_lease",
      "wrk_active_legacy",
      "legacy-worker",
      "b".repeat(64),
      "c".repeat(64),
      "2026-07-23T19:00:00.000Z",
      "2026-07-23T21:00:00.000Z"
    );
    const auditCount = countRows(db, "audit_events");
    const migrationRows = migrationVersions(db);

    expect(() => applyControlPlaneMigrations(db)).toThrow("execution plan migration refused active legacy lease state");
    expect(migrationVersions(db)).toEqual(migrationRows);
    expect(countRows(db, "audit_events")).toBe(auditCount);
    expect(tableExists(db, "execution_plans")).toBe(false);
    expect(db.prepare(`SELECT status FROM leases WHERE lease_id = 'legacy_active_lease'`).get()).toEqual({
      status: "active"
    });
    db.close();
  });

  it("succeeds from a clean v5 database and records the migration checksum", () => {
    const db = createV5Database(":memory:");
    seedV5WorkItem(db, { id: "wrk_clean_upgrade", status: "approved" });

    applyControlPlaneMigrations(db);

    expect(migrationVersions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(tableExists(db, "execution_plans")).toBe(true);
    expect(tableExists(db, "execution_attempts")).toBe(true);
    expect(db.prepare(`SELECT checksum FROM schema_migrations WHERE version = 8`).get()).toEqual({
      checksum: controlPlaneMigrations().at(-1)?.checksum
    });
    db.close();
  });

  it("rejects new legacy lease and result writes after v6 at the database boundary", () => {
    const dbPath = temporaryDatabasePath("legacy-guards");
    const db = createV5Database(dbPath);
    seedHistoricalLegacyResult(db, "wrk_historical_guard");
    seedV5WorkItem(db, { id: "wrk_new_legacy_write", status: "approved" });
    applyControlPlaneMigrations(db);

    expect(() =>
      db
        .prepare(
          `INSERT INTO leases
           (lease_id, work_item_id, worker_id, token_hash, action_hash, issued_at, expires_at, status, closed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL)`
        )
        .run(
          "legacy_forbidden_lease",
          "wrk_new_legacy_write",
          "legacy-worker",
          "d".repeat(64),
          "e".repeat(64),
          "2026-07-23T20:00:00.000Z",
          "2026-07-23T20:05:00.000Z"
        )
    ).toThrow("leases: legacy worker protocol disabled after schema v6");

    expect(() =>
      insertLegacyResult(db, {
        resultId: "legacy_forbidden_result",
        workItemId: "wrk_historical_guard",
        leaseId: "legacy_historical_lease",
        workerId: "legacy-worker",
        idempotencyKey: "legacy-forbidden-key"
      })
    ).toThrow("execution_results: legacy worker protocol disabled after schema v6");

    expect(() =>
      db
        .prepare(
          `UPDATE work_items
           SET status = 'running', worker_id = ?, lease_token_hash = ?,
               started_at = ?, lease_expires_at = ?
           WHERE id = ?`
        )
        .run(
          "legacy-worker",
          "f".repeat(64),
          "2026-07-23T20:00:00.000Z",
          "2026-07-23T20:05:00.000Z",
          "wrk_new_legacy_write"
        )
    ).toThrow("work_items: legacy lease state disabled after schema v6");

    expect(() =>
      db
        .prepare(
          `UPDATE work_items
           SET status = 'succeeded', result_json = ?
           WHERE id = ?`
        )
        .run(JSON.stringify({ outcome: "succeeded", fabricated: true }), "wrk_new_legacy_write")
    ).toThrow("work_items: legacy result state disabled after schema v6");
    expect(db.prepare(`SELECT status, result_json FROM work_items WHERE id = ?`).get("wrk_new_legacy_write")).toEqual({
      status: "approved",
      result_json: null
    });
    db.close();
  });

  it("keeps historical legacy rows readable without fabricating approvals or success evidence", () => {
    const dbPath = temporaryDatabasePath("legacy-history");
    const db = createV5Database(dbPath);
    seedHistoricalLegacyResult(db, "wrk_historical_read");
    db.prepare(
      `INSERT INTO approval_records
       (work_item_id, action_hash, request_hash, approval_token_hash, approved_by, reason,
        status, created_at, expires_at, consumed_at)
       VALUES (?, ?, ?, '', ?, ?, 'consumed', ?, ?, ?)`
    ).run(
      "wrk_historical_read",
      "f".repeat(64),
      "1".repeat(64),
      "human-reviewer",
      "historical approval",
      "2026-07-23T18:00:00.000Z",
      "2026-07-23T19:00:00.000Z",
      "2026-07-23T18:30:00.000Z"
    );
    const before = {
      leases: countRows(db, "leases"),
      results: countRows(db, "execution_results"),
      approvals: countRows(db, "approval_records")
    };

    applyControlPlaneMigrations(db);

    expect(countRows(db, "leases")).toBe(before.leases);
    expect(countRows(db, "execution_results")).toBe(before.results);
    expect(countRows(db, "approval_records")).toBe(before.approvals);
    expect(
      db
        .prepare(
          `SELECT outcome, summary FROM execution_results
           WHERE result_id = 'legacy_historical_result'`
        )
        .get()
    ).toEqual({ outcome: "succeeded", summary: "historical dry-run result" });
    expect(
      db
        .prepare(
          `SELECT approval_token_hash FROM approval_records
           WHERE work_item_id = 'wrk_historical_read'`
        )
        .get()
    ).toEqual({ approval_token_hash: "" });
    expect(countRows(db, "execution_plan_approvals")).toBe(0);
    expect(countRows(db, "execution_attempts")).toBe(0);
    db.close();

    const store = new SqliteWorkItemStore(dbPath);
    try {
      expect(store.getExecutionResult("legacy_historical_result")).toMatchObject({
        outcome: "succeeded",
        summary: "historical dry-run result"
      });
      expect(store.getExecutionResultForIdempotency("legacy-worker", "legacy-historical-key")?.resultId).toBe(
        "legacy_historical_result"
      );
    } finally {
      store.close();
    }
  });
});

describe("immutable execution plans and admissions", () => {
  it("creates deterministic immutable plans and verifies persisted integrity on every read", () => {
    const context = createStoreContext("plan-integrity");
    try {
      const workItem = createApprovedWorkItem(context.store);
      const definition = defaultExecutionPlanForWorkItem(workItem);
      expect(executionPlanHash(definition)).toBe(executionPlanHash(structuredClone(definition)));

      const plan = context.store.createExecutionPlan({
        workItemId: workItem.id,
        definition,
        createdByActorId: "planner",
        now: fixedNow
      });
      expect(
        context.store.createExecutionPlan({
          workItemId: workItem.id,
          definition,
          createdByActorId: "planner",
          now: fixedNow
        })
      ).toEqual(plan);
      expect(context.store.getExecutionPlan(plan.planId)).toEqual(plan);
      expect(context.store.getCurrentExecutionPlan(workItem.id)).toEqual(plan);
      expect(context.store.listExecutionPlans(workItem.id)).toEqual([plan]);
      expect(eventNames(context.store)).toContain("execution_plan.created");

      const db = new DatabaseSync(context.dbPath);
      expect(() =>
        db.prepare(`UPDATE execution_plans SET definition_json = '{}' WHERE plan_id = ?`).run(plan.planId)
      ).toThrow("execution_plans: immutable");
      expect(() => db.prepare(`DELETE FROM execution_plans WHERE plan_id = ?`).run(plan.planId)).toThrow(
        "execution_plans: immutable"
      );
      db.exec(`DROP TRIGGER execution_plans_immutable_update`);
      db.prepare(
        `UPDATE execution_plans
         SET definition_json = json_set(definition_json, '$.objective', 'tampered objective')
         WHERE plan_id = ?`
      ).run(plan.planId);
      db.close();

      expectControlError(() => context.store.getExecutionPlan(plan.planId), "execution_plan_integrity_failed");
    } finally {
      context.close();
    }
  });

  it("recomputes admission hashes and fails closed on persisted admission tampering", () => {
    const context = createStoreContext("admission-integrity");
    try {
      const { admission } = createAllowAdmission(context.store);
      expect(context.store.getExecutionPlanAdmission(admission.admissionId)).toEqual(admission);

      const db = new DatabaseSync(context.dbPath);
      db.exec(`DROP TRIGGER execution_plan_admissions_immutable_update`);
      db.prepare(
        `UPDATE execution_plan_admissions
         SET policy_decision_hash = ?
         WHERE admission_id = ?`
      ).run("2".repeat(64), admission.admissionId);
      db.close();

      expectControlError(
        () => context.store.getExecutionPlanAdmission(admission.admissionId),
        "execution_plan_integrity_failed"
      );
    } finally {
      context.close();
    }
  });

  it("admits only the current plan through the policy-gate authority and is idempotent", () => {
    const context = createStoreContext("admission-authority");
    try {
      const workItem = createApprovedWorkItem(context.store);
      const plan = createPlan(context.store, workItem);
      const input = {
        workItemId: workItem.id,
        planHash: plan.planHash,
        policyVersion: "acs.policy.v1",
        policyDecisionHash: stableHash({ decision: "allow", planHash: plan.planHash }),
        decision: "allow" as const,
        requiredApprovalActionHashes: [],
        admittedByActorId: "policy-gate",
        now: fixedNow
      };

      expectControlError(
        () => context.store.admitExecutionPlan(input, { via: "domain_service" }),
        "policy_gate_required"
      );
      const admission = context.store.admitExecutionPlan(input, { via: "policy_gate" });
      expect(context.store.admitExecutionPlan(input, { via: "policy_gate" })).toEqual(admission);
      expect(context.store.getCurrentExecutionPlanAdmission(workItem.id)).toEqual(admission);
      expect(eventNames(context.store).filter((name) => name === "execution_plan.admitted")).toHaveLength(1);
    } finally {
      context.close();
    }
  });

  it("rolls back plan and admission records when their required audit event fails", () => {
    const context = createStoreContext("authority-audit-rollback");
    try {
      const workItem = createApprovedWorkItem(context.store);
      const definition = defaultExecutionPlanForWorkItem(workItem);
      const db = new DatabaseSync(context.dbPath);
      db.exec(`
        CREATE TRIGGER reject_execution_plan_audit
        BEFORE INSERT ON audit_events
        WHEN NEW.name = 'execution_plan.created'
        BEGIN
          SELECT RAISE(ABORT, 'test plan audit failure');
        END;
      `);
      db.close();

      expect(() =>
        context.store.createExecutionPlan({
          workItemId: workItem.id,
          definition,
          createdByActorId: "planner",
          now: fixedNow
        })
      ).toThrow("test plan audit failure");
      expect(context.store.getCurrentExecutionPlan(workItem.id)).toBeUndefined();
      expect(countRawRows(context.dbPath, "execution_plans")).toBe(0);

      const reopen = new DatabaseSync(context.dbPath);
      reopen.exec(`
        DROP TRIGGER reject_execution_plan_audit;
        CREATE TRIGGER reject_execution_plan_admission_audit
        BEFORE INSERT ON audit_events
        WHEN NEW.name = 'execution_plan.admitted'
        BEGIN
          SELECT RAISE(ABORT, 'test admission audit failure');
        END;
      `);
      reopen.close();
      const plan = createPlan(context.store, workItem);

      expect(() =>
        context.store.admitExecutionPlan(
          {
            workItemId: workItem.id,
            planHash: plan.planHash,
            policyVersion: "acs.policy.v1",
            policyDecisionHash: stableHash({ decision: "allow", planHash: plan.planHash }),
            decision: "allow",
            requiredApprovalActionHashes: [],
            admittedByActorId: "policy-gate",
            now: fixedNow
          },
          { via: "policy_gate" }
        )
      ).toThrow("test admission audit failure");
      expect(context.store.getCurrentExecutionPlanAdmission(workItem.id)).toBeUndefined();
      expect(countRawRows(context.dbPath, "execution_plan_admissions")).toBe(0);
      expect(context.store.verifyAuditChain()).toMatchObject({ ok: true });
    } finally {
      context.close();
    }
  });

  it("invalidates an admission and its approval when the current plan changes", () => {
    const context = createStoreContext("plan-mutation");
    try {
      const { workItem, plan, admission } = createApprovalRequiredAdmission(context.store);
      const approval = grantRequiredApproval(context.store, workItem, plan, admission);
      const changedDefinition = {
        ...plan.definition,
        objective: `${plan.definition.objective} with reviewed correction`
      };
      const changed = context.store.createExecutionPlan({
        workItemId: workItem.id,
        definition: changedDefinition,
        createdByActorId: "planner",
        expectedCurrentPlanHash: plan.planHash,
        now: new Date(fixedNow.getTime() + 1_000)
      });

      expect(changed.planHash).not.toBe(plan.planHash);
      expect(context.store.getCurrentExecutionPlanAdmission(workItem.id)).toBeUndefined();
      expect(context.store.getExecutionPlanApproval(approval.approvalId)?.status).toBe("granted");
      expectControlError(
        () =>
          context.store.recordExecutionPlanApproval(
            {
              workItemId: workItem.id,
              planHash: plan.planHash,
              admissionHash: admission.admissionHash,
              policyVersion: admission.policyVersion,
              actionHash: executionActionHash(workItem),
              approvedByActorId: "reviewer",
              reason: "stale approval",
              expiresAt: "2026-07-23T21:00:00.000Z",
              now: new Date("2026-07-23T20:10:00.000Z")
            },
            { via: "policy_gate" }
          ),
        "execution_plan_not_current"
      );
    } finally {
      context.close();
    }
  });

  it("does not let an approval authorize a different plan or policy version", () => {
    const context = createStoreContext("approval-binding");
    try {
      const { workItem, plan, admission } = createApprovalRequiredAdmission(context.store);
      const actionHash = executionActionHash(workItem);

      expectControlError(
        () =>
          context.store.recordExecutionPlanApproval(
            {
              workItemId: workItem.id,
              planHash: "3".repeat(64),
              admissionHash: admission.admissionHash,
              policyVersion: admission.policyVersion,
              actionHash,
              approvedByActorId: "reviewer",
              reason: "wrong plan",
              expiresAt: "2026-07-23T21:00:00.000Z",
              now: fixedNow
            },
            { via: "policy_gate" }
          ),
        "execution_plan_not_current"
      );
      expectControlError(
        () =>
          context.store.recordExecutionPlanApproval(
            {
              workItemId: workItem.id,
              planHash: plan.planHash,
              admissionHash: admission.admissionHash,
              policyVersion: "acs.policy.v2",
              actionHash,
              approvedByActorId: "reviewer",
              reason: "wrong policy",
              expiresAt: "2026-07-23T21:00:00.000Z",
              now: fixedNow
            },
            { via: "policy_gate" }
          ),
        "execution_plan_approval_binding_mismatch"
      );
      expect(countRawRows(context.dbPath, "execution_plan_approvals")).toBe(0);
    } finally {
      context.close();
    }
  });
});

describe("V2 attempt claims and mixed-version rejection", () => {
  it("denies workers without acs.worker.v2 and leaves the work item unclaimed", () => {
    const context = createStoreContext("protocol-denial");
    try {
      const { workItem, plan, admission } = createAllowAdmission(context.store);
      const claimInput = attemptClaimInput(workItem, plan, admission, "worker-v1");

      expectControlError(
        () =>
          context.store.claimExecutionAttempt({
            ...claimInput,
            protocolVersion: "acs.worker.v1"
          }),
        "worker_protocol_unsupported"
      );
      expectControlError(() => context.store.claimNextApprovedWorkItem("legacy-worker"), "worker_protocol_unsupported");
      expect(context.store.get(workItem.id)?.status).toBe("approved");
      expect(countRawRows(context.dbPath, "execution_attempts")).toBe(0);
      expect(countRawRows(context.dbPath, "leases")).toBe(0);
    } finally {
      context.close();
    }
  });

  it("rejects malformed and mismatched deterministic attempt input hashes", () => {
    const context = createStoreContext("input-hash");
    try {
      const { workItem, plan, admission } = createAllowAdmission(context.store);
      const input = attemptClaimInput(workItem, plan, admission, "worker-input");

      expect(() => context.store.claimExecutionAttempt({ ...input, inputHash: "not-a-hash" })).toThrow();
      expectControlError(
        () =>
          context.store.claimExecutionAttempt({
            ...input,
            inputHash: "4".repeat(64)
          }),
        "execution_attempt_input_mismatch"
      );
      expect(countRawRows(context.dbPath, "execution_attempts")).toBe(0);
    } finally {
      context.close();
    }
  });

  it("binds claims to plan, admission, worker, lease token, fencing epoch, and current inputs", () => {
    const context = createStoreContext("claim-binding");
    try {
      const { workItem, plan, admission } = createAllowAdmission(context.store);
      const claim = context.store.claimExecutionAttempt(attemptClaimInput(workItem, plan, admission, "worker-current"));

      expect(claim).toMatchObject({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        attemptNumber: 1,
        workItemId: workItem.id,
        planId: plan.planId,
        planHash: plan.planHash,
        admissionId: admission.admissionId,
        admissionHash: admission.admissionHash,
        workerId: "worker-current",
        fencingEpoch: 1
      });
      expect(context.store.verifyExecutionAttemptClaim({ ...claim, now: fixedNow })).toEqual(claim);
      const persisted = readRawAttemptLease(context.dbPath, claim.leaseId);
      expect(persisted.token_hash).not.toBe(claim.leaseToken);
      expect(persisted.protocol_version).toBe(WORKER_PROTOCOL_VERSION);

      for (const stale of [
        { workerId: "worker-stale" },
        { leaseId: "alease_stale" },
        { fencingEpoch: claim.fencingEpoch + 1 },
        { planHash: "5".repeat(64) },
        { admissionHash: "6".repeat(64) },
        { inputHash: "7".repeat(64) },
        { leaseToken: `${claim.leaseToken}stale` }
      ]) {
        expect(() => context.store.verifyExecutionAttemptClaim({ ...claim, ...stale })).toThrow(ControlStackError);
      }
      expectControlError(
        () =>
          context.store.verifyExecutionAttemptClaim({
            ...claim,
            now: new Date("2026-07-23T20:10:00.000Z")
          }),
        "execution_attempt_lease_expired"
      );
    } finally {
      context.close();
    }
  });

  it("serializes competing claims so exactly one worker owns the attempt", () => {
    const context = createStoreContext("competing-claims");
    const competing = new SqliteWorkItemStore(context.dbPath);
    try {
      const { workItem, plan, admission } = createAllowAdmission(context.store);
      const first = context.store.claimExecutionAttempt(attemptClaimInput(workItem, plan, admission, "worker-a"));
      expect(first.workerId).toBe("worker-a");
      expectControlError(
        () => competing.claimExecutionAttempt(attemptClaimInput(workItem, plan, admission, "worker-b")),
        "execution_attempt_claim_conflict"
      );
      expect(countRawRows(context.dbPath, "execution_attempts")).toBe(1);
      expect(countRawRows(context.dbPath, "attempt_leases")).toBe(1);
    } finally {
      competing.close();
      context.close();
    }
  });

  it("atomically consumes every exact approval when a require-approval attempt is leased", () => {
    const context = createStoreContext("approval-consumption");
    try {
      const { workItem, plan, admission } = createApprovalRequiredAdmission(context.store);
      const approval = grantRequiredApproval(context.store, workItem, plan, admission);
      const claim = context.store.claimExecutionAttempt(
        attemptClaimInput(workItem, plan, admission, "worker-approved", [approval.approvalBindingHash])
      );

      expect(context.store.getExecutionPlanApproval(approval.approvalId)).toMatchObject({
        status: "consumed",
        consumedAt: claim.issuedAt
      });
      expect(eventNames(context.store)).toEqual(
        expect.arrayContaining([
          "execution_plan.approval_consumed",
          "execution_attempt.created",
          "attempt_lease.granted"
        ])
      );
      expect(() =>
        context.store.claimExecutionAttempt(
          attemptClaimInput(workItem, plan, admission, "worker-replay", [approval.approvalBindingHash])
        )
      ).toThrow(ControlStackError);
    } finally {
      context.close();
    }
  });

  it("rejects a persisted approval whose binding hash no longer verifies", () => {
    const context = createStoreContext("approval-integrity");
    try {
      const { workItem, plan, admission } = createApprovalRequiredAdmission(context.store);
      const approval = grantRequiredApproval(context.store, workItem, plan, admission);
      const db = new DatabaseSync(context.dbPath);
      db.exec(`DROP TRIGGER execution_plan_approvals_transition_guard`);
      db.prepare(
        `UPDATE execution_plan_approvals
         SET approval_binding_hash = ?
         WHERE approval_id = ?`
      ).run("f".repeat(64), approval.approvalId);
      db.close();

      expectControlError(
        () =>
          context.store.claimExecutionAttempt(attemptClaimInput(workItem, plan, admission, "worker-tampered-approval")),
        "execution_plan_integrity_failed"
      );
      expect(countRawRows(context.dbPath, "execution_attempts")).toBe(0);
      expect(countRawRows(context.dbPath, "attempt_leases")).toBe(0);
    } finally {
      context.close();
    }
  });

  it("denies a worker that tries to claim using its own approval", () => {
    const context = createStoreContext("self-approval");
    try {
      const { workItem, plan, admission } = createApprovalRequiredAdmission(context.store);
      const approval = context.store.recordExecutionPlanApproval(
        {
          workItemId: workItem.id,
          planHash: plan.planHash,
          admissionHash: admission.admissionHash,
          policyVersion: admission.policyVersion,
          actionHash: executionActionHash(workItem),
          approvedByActorId: "worker-self",
          reason: "worker attempted self approval",
          expiresAt: "2026-07-23T21:00:00.000Z",
          now: fixedNow
        },
        { via: "policy_gate" }
      );

      expectControlError(
        () =>
          context.store.claimExecutionAttempt(
            attemptClaimInput(workItem, plan, admission, "worker-self", [approval.approvalBindingHash])
          ),
        "execution_attempt_self_approval"
      );
      expect(countRawRows(context.dbPath, "execution_attempts")).toBe(0);
      expect(countRawRows(context.dbPath, "attempt_leases")).toBe(0);
    } finally {
      context.close();
    }
  });

  it("rolls back attempt, lease, approval consumption, and audit when lease audit fails", () => {
    const context = createStoreContext("claim-audit-rollback");
    try {
      const { workItem, plan, admission } = createApprovalRequiredAdmission(context.store);
      const approval = grantRequiredApproval(context.store, workItem, plan, admission);
      const auditCount = eventNames(context.store).length;
      const db = new DatabaseSync(context.dbPath);
      db.exec(`
        CREATE TRIGGER reject_attempt_lease_audit
        BEFORE INSERT ON audit_events
        WHEN NEW.name = 'attempt_lease.granted'
        BEGIN
          SELECT RAISE(ABORT, 'test attempt audit failure');
        END;
      `);
      db.close();

      expect(() =>
        context.store.claimExecutionAttempt(
          attemptClaimInput(workItem, plan, admission, "worker-audit", [approval.approvalBindingHash])
        )
      ).toThrow("test attempt audit failure");
      expect(countRawRows(context.dbPath, "execution_attempts")).toBe(0);
      expect(countRawRows(context.dbPath, "attempt_leases")).toBe(0);
      expect(context.store.getExecutionPlanApproval(approval.approvalId)?.status).toBe("granted");
      expect(eventNames(context.store)).toHaveLength(auditCount);
      expect(context.store.verifyAuditChain()).toMatchObject({ ok: true });
    } finally {
      context.close();
    }
  });
});

function createStoreContext(label: string): {
  store: SqliteWorkItemStore;
  dbPath: string;
  close: () => void;
} {
  const dbPath = temporaryDatabasePath(label);
  const store = new SqliteWorkItemStore(dbPath, { leaseMs: 5 * 60 * 1_000 });
  return {
    store,
    dbPath,
    close: () => store.close()
  };
}

function createApprovedWorkItem(store: SqliteWorkItemStore): WorkItem {
  const created = store.create({
    title: "Phase 2 attempt foundation",
    requester: "user",
    requesterSubject: "operator:jace",
    intent: "apply a reviewed local code change",
    target: { cwd: "/workspace/repository" },
    requestedActions: [
      {
        kind: "shell",
        description: "run the allowlisted repository check",
        params: { command: ["npm", "run", "check"] }
      }
    ],
    risk: "low"
  });
  return store.transition(created.id, "approved", { via: "policy_gate" });
}

function createPlan(store: SqliteWorkItemStore, workItem: WorkItem): ExecutionPlanRecord {
  return store.createExecutionPlan({
    workItemId: workItem.id,
    definition: defaultExecutionPlanForWorkItem(workItem),
    createdByActorId: "planner",
    now: fixedNow
  });
}

function createAllowAdmission(store: SqliteWorkItemStore): {
  workItem: WorkItem;
  plan: ExecutionPlanRecord;
  admission: ExecutionPlanAdmission;
} {
  const workItem = createApprovedWorkItem(store);
  const plan = createPlan(store, workItem);
  const admission = store.admitExecutionPlan(
    {
      workItemId: workItem.id,
      planHash: plan.planHash,
      policyVersion: "acs.policy.v1",
      policyDecisionHash: stableHash({ decision: "allow", planHash: plan.planHash }),
      decision: "allow",
      requiredApprovalActionHashes: [],
      admittedByActorId: "policy-gate",
      now: fixedNow
    },
    { via: "policy_gate" }
  );
  return { workItem, plan, admission };
}

function createApprovalRequiredAdmission(store: SqliteWorkItemStore): {
  workItem: WorkItem;
  plan: ExecutionPlanRecord;
  admission: ExecutionPlanAdmission;
} {
  const workItem = createApprovedWorkItem(store);
  const plan = createPlan(store, workItem);
  const actionHash = executionActionHash(workItem);
  const admission = store.admitExecutionPlan(
    {
      workItemId: workItem.id,
      planHash: plan.planHash,
      policyVersion: "acs.policy.v1",
      policyDecisionHash: stableHash({
        decision: "require_approval",
        planHash: plan.planHash,
        actionHash
      }),
      decision: "require_approval",
      requiredApprovalActionHashes: [actionHash],
      admittedByActorId: "policy-gate",
      now: fixedNow
    },
    { via: "policy_gate" }
  );
  return { workItem, plan, admission };
}

function grantRequiredApproval(
  store: SqliteWorkItemStore,
  workItem: WorkItem,
  plan: ExecutionPlanRecord,
  admission: ExecutionPlanAdmission
) {
  return store.recordExecutionPlanApproval(
    {
      workItemId: workItem.id,
      planHash: plan.planHash,
      admissionHash: admission.admissionHash,
      policyVersion: admission.policyVersion,
      actionHash: executionActionHash(workItem),
      approvedByActorId: "independent-reviewer",
      reason: "exact reviewed plan approved",
      expiresAt: "2026-07-23T21:00:00.000Z",
      now: fixedNow
    },
    { via: "policy_gate" }
  );
}

function attemptClaimInput(
  workItem: WorkItem,
  plan: ExecutionPlanRecord,
  admission: ExecutionPlanAdmission,
  workerId: string,
  approvalBindingHashes: string[] = []
): ClaimExecutionAttemptInput {
  return {
    protocolVersion: WORKER_PROTOCOL_VERSION,
    workItemId: workItem.id,
    planId: plan.planId,
    planHash: plan.planHash,
    admissionId: admission.admissionId,
    admissionHash: admission.admissionHash,
    inputHash: executionAttemptInputHash({
      workItemId: workItem.id,
      planId: plan.planId,
      planHash: plan.planHash,
      admissionId: admission.admissionId,
      admissionHash: admission.admissionHash,
      subjectInputHash: executionPlanSubjectInputHash(workItem),
      policyVersion: admission.policyVersion,
      policyDecisionHash: admission.policyDecisionHash,
      approvalBindingHashes
    }),
    workerId,
    leaseMs: 5 * 60 * 1_000,
    now: fixedNow
  };
}

function expectControlError(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ControlStackError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected ControlStackError with code ${code}`);
}

function eventNames(store: SqliteWorkItemStore): string[] {
  return store.readEvents({ limit: 500 }).map((event) => event.name);
}

function temporaryDatabasePath(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `acs-phase2-${label}-`));
  temporaryDirectories.push(directory);
  return join(directory, "control.db");
}

function createV5Database(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      filename TEXT NOT NULL,
      checksum TEXT NOT NULL DEFAULT '',
      applied_at TEXT NOT NULL
    );
  `);
  for (const migration of controlPlaneMigrations().slice(0, 5)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.prepare(
        `INSERT INTO schema_migrations (version, name, filename, checksum, applied_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(migration.version, migration.name, migration.filename, migration.checksum, "2026-07-23T18:00:00.000Z");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      db.close();
      throw error;
    }
  }
  return db;
}

function seedV5WorkItem(
  db: DatabaseSync,
  input: {
    id: string;
    status: string;
    workerId?: string;
    leaseTokenHash?: string;
    startedAt?: string;
    leaseExpiresAt?: string;
  }
): void {
  db.prepare(
    `INSERT INTO work_items
     (id, title, requester, requester_subject, status, intent, target_json,
      requested_actions_json, risk, result_json, worker_id, lease_token_hash,
      started_at, lease_expires_at, created_at, updated_at)
     VALUES (?, ?, 'user', 'operator:jace', ?, ?, '{}', '[]', 'low', NULL, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.id,
    input.status,
    "migration fixture",
    input.workerId ?? null,
    input.leaseTokenHash ?? null,
    input.startedAt ?? null,
    input.leaseExpiresAt ?? null,
    "2026-07-23T18:00:00.000Z",
    "2026-07-23T18:00:00.000Z"
  );
}

function seedHistoricalLegacyResult(db: DatabaseSync, workItemId: string): void {
  seedV5WorkItem(db, {
    id: workItemId,
    status: "running",
    workerId: "legacy-worker",
    leaseTokenHash: "8".repeat(64),
    startedAt: "2026-07-23T18:00:00.000Z",
    leaseExpiresAt: "2026-07-23T19:00:00.000Z"
  });
  db.prepare(
    `INSERT INTO leases
     (lease_id, work_item_id, worker_id, token_hash, action_hash, issued_at, expires_at, status, closed_at)
     VALUES ('legacy_historical_lease', ?, 'legacy-worker', ?, ?, ?, ?, 'active', NULL)`
  ).run(workItemId, "8".repeat(64), "9".repeat(64), "2026-07-23T18:00:00.000Z", "2026-07-23T19:00:00.000Z");
  insertLegacyResult(db, {
    resultId: "legacy_historical_result",
    workItemId,
    leaseId: "legacy_historical_lease",
    workerId: "legacy-worker",
    idempotencyKey: "legacy-historical-key"
  });
  db.prepare(`UPDATE leases SET status = 'consumed', closed_at = ? WHERE lease_id = 'legacy_historical_lease'`).run(
    "2026-07-23T18:30:00.000Z"
  );
  db.prepare(
    `UPDATE work_items
     SET status = 'succeeded', result_json = ?, lease_token_hash = NULL,
         lease_expires_at = NULL, updated_at = ?
     WHERE id = ?`
  ).run(JSON.stringify({ outcome: "succeeded", historical: true }), "2026-07-23T18:30:00.000Z", workItemId);
}

function insertLegacyResult(
  db: DatabaseSync,
  input: {
    resultId: string;
    workItemId: string;
    leaseId: string;
    workerId: string;
    idempotencyKey: string;
  }
): void {
  db.prepare(
    `INSERT INTO execution_results
     (result_id, work_item_id, lease_id, worker_id, idempotency_key, action_hash, outcome,
      started_at, finished_at, exit_code, summary, stdout, stderr, structured_output_json,
      artifacts_json, error, resource_usage_json, simulation_metadata_json, payload_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, 0, ?, NULL, NULL, '{}', '[]', NULL, NULL,
             '{"executionMode":"dry_run","simulated":true}', ?, ?)`
  ).run(
    input.resultId,
    input.workItemId,
    input.leaseId,
    input.workerId,
    input.idempotencyKey,
    "9".repeat(64),
    "2026-07-23T18:00:00.000Z",
    "2026-07-23T18:30:00.000Z",
    "historical dry-run result",
    "a".repeat(64),
    "2026-07-23T18:30:00.000Z"
  );
}

function migrationVersions(db: DatabaseSync): number[] {
  return (
    db.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all() as Array<{
      version: number;
    }>
  ).map((row) => row.version);
}

function countRows(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function countRawRows(dbPath: string, table: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    return countRows(db, table);
  } finally {
    db.close();
  }
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?`).get(table));
}

function readRawAttemptLease(dbPath: string, leaseId: string): { token_hash: string; protocol_version: string } {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(`SELECT token_hash, protocol_version FROM attempt_leases WHERE lease_id = ?`).get(leaseId) as {
      token_hash: string;
      protocol_version: string;
    };
  } finally {
    db.close();
  }
}
