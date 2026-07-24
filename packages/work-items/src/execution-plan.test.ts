import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ControlStackError } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import {
  SqliteWorkItemStore,
  defaultExecutionPlanForWorkItem,
  executionAttemptInputHash,
  executionPlanHash,
  executionPlanSubjectInputHash
} from "./index.js";

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "acs-execution-plan-"));
  const dbPath = join(directory, "control.db");
  const store = new SqliteWorkItemStore(dbPath);
  const workItem = store.create({
    title: "Immutable plan fixture",
    requester: "user",
    requesterSubject: "actor-user",
    intent: "prove immutable deterministic execution plans",
    target: { cwd: "/repo", files: ["src/index.ts"] },
    requestedActions: [
      {
        kind: "fs.read",
        description: "inspect the source",
        params: { paths: ["src/index.ts"], write: false }
      }
    ],
    risk: "low"
  });
  return { directory, dbPath, store, workItem };
}

function hex(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

/** Builds a work item -> current plan -> policy-admitted plan chain via the real store API. */
function createAdmittedFixture(overrides: { requiresApproval?: boolean } = {}) {
  const fixture = createFixture();
  const definition = defaultExecutionPlanForWorkItem(fixture.workItem);
  const plan = fixture.store.createExecutionPlan({
    workItemId: fixture.workItem.id,
    definition,
    createdByActorId: "actor-user"
  });
  const admission = fixture.store.admitExecutionPlan(
    {
      workItemId: fixture.workItem.id,
      planHash: plan.planHash,
      policyVersion: "acs.policy.v1",
      policyDecisionHash: hex("1"),
      requiresApproval: overrides.requiresApproval ?? false,
      admittedByActorId: "policy-gate"
    },
    { via: "policy_gate" }
  );
  return { ...fixture, plan, admission };
}

/** Inserts a 'leased' execution_attempts row via raw SQL - no TS store API exists for this table yet. */
function insertLeasedAttempt(
  db: DatabaseSync,
  input: { workItemId: string; planId: string; planHash: string; workerId: string }
): { attemptId: string } {
  const attemptId = `attempt_${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO execution_attempts
     (attempt_id, work_item_id, plan_id, plan_hash, attempt_number, protocol_version, input_hash,
      status, current_fencing_epoch, claimed_by_worker_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 'acs.worker.v2', ?, 'pending', 0, NULL, ?, ?)`
  ).run(attemptId, input.workItemId, input.planId, input.planHash, hex("a"), now, now);
  db.prepare(
    `UPDATE execution_attempts
     SET status = 'leased', current_fencing_epoch = 1, claimed_by_worker_id = ?, updated_at = ?
     WHERE attempt_id = ?`
  ).run(input.workerId, now, attemptId);
  return { attemptId };
}

function insertApproval(
  db: DatabaseSync,
  input: { workItemId: string; planId: string; planHash: string; expiresAt: string; createdAt?: string }
): { approvalId: string } {
  const approvalId = `approval_${Math.random().toString(36).slice(2)}`;
  const createdAt = input.createdAt ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO execution_plan_approvals
     (approval_id, work_item_id, plan_id, plan_hash, action_hash, request_hash, approved_by_actor_id,
      reason, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'approver-user', 'looks safe', 'granted', ?, ?)`
  ).run(approvalId, input.workItemId, input.planId, input.planHash, hex("b"), hex("c"), createdAt, input.expiresAt);
  return { approvalId };
}

function insertLease(
  db: DatabaseSync,
  input: {
    attemptId: string;
    workItemId: string;
    admissionId: string;
    approvalId: string | null;
    planHash: string;
    workerId: string;
    expiresAt?: string;
    issuedAt?: string;
  }
): { leaseId: string } {
  const leaseId = `lease_${Math.random().toString(36).slice(2)}`;
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const expiresAt = input.expiresAt ?? new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const maxExpiresAt = new Date(Math.max(Date.parse(expiresAt), Date.now() + 10 * 60 * 1000)).toISOString();
  db.prepare(
    `INSERT INTO attempt_leases
     (lease_id, attempt_id, work_item_id, admission_id, approval_id, worker_id, token_hash, plan_hash,
      input_hash, fencing_epoch, protocol_version, policy_version, policy_decision_hash,
      issued_at, expires_at, max_expires_at, last_renewed_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'acs.worker.v2', 'acs.policy.v1', ?, ?, ?, ?, ?, 'active')`
  ).run(
    leaseId,
    input.attemptId,
    input.workItemId,
    input.admissionId,
    input.approvalId,
    input.workerId,
    hex("d"),
    input.planHash,
    hex("a"),
    hex("1"),
    issuedAt,
    expiresAt,
    maxExpiresAt,
    issuedAt
  );
  return { leaseId };
}

describe("execution attempts, leases, and approvals (schema-level invariants)", () => {
  it("rejects a lease for a requires-approval admission with no approval attached", () => {
    const { directory, dbPath, store, workItem, plan, admission } = createAdmittedFixture({ requiresApproval: true });
    try {
      const db = new DatabaseSync(dbPath);
      try {
        const { attemptId } = insertLeasedAttempt(db, {
          workItemId: workItem.id,
          planId: plan.planId,
          planHash: plan.planHash,
          workerId: "worker-1"
        });
        expect(() =>
          insertLease(db, {
            attemptId,
            workItemId: workItem.id,
            admissionId: admission.admissionId,
            approvalId: null,
            planHash: plan.planHash,
            workerId: "worker-1"
          })
        ).toThrow("attempt_leases: attempt, admission, fence, or approval binding is invalid");
      } finally {
        db.close();
      }
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("issues a lease for a requires-approval admission with a valid approval and consumes it atomically", () => {
    const { directory, dbPath, store, workItem, plan, admission } = createAdmittedFixture({ requiresApproval: true });
    try {
      const db = new DatabaseSync(dbPath);
      try {
        const { attemptId } = insertLeasedAttempt(db, {
          workItemId: workItem.id,
          planId: plan.planId,
          planHash: plan.planHash,
          workerId: "worker-1"
        });
        const { approvalId } = insertApproval(db, {
          workItemId: workItem.id,
          planId: plan.planId,
          planHash: plan.planHash,
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        });
        insertLease(db, {
          attemptId,
          workItemId: workItem.id,
          admissionId: admission.admissionId,
          approvalId,
          planHash: plan.planHash,
          workerId: "worker-1"
        });
        const approvalRow = db
          .prepare(`SELECT status, consumed_at FROM execution_plan_approvals WHERE approval_id = ?`)
          .get(approvalId) as { status: string; consumed_at: string | null };
        expect(approvalRow.status).toBe("consumed");
        expect(approvalRow.consumed_at).not.toBeNull();
      } finally {
        db.close();
      }
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a lease that attaches an approval to an admission that never required one", () => {
    const { directory, dbPath, store, workItem, plan, admission } = createAdmittedFixture({ requiresApproval: false });
    try {
      const db = new DatabaseSync(dbPath);
      try {
        const { attemptId } = insertLeasedAttempt(db, {
          workItemId: workItem.id,
          planId: plan.planId,
          planHash: plan.planHash,
          workerId: "worker-1"
        });
        const { approvalId } = insertApproval(db, {
          workItemId: workItem.id,
          planId: plan.planId,
          planHash: plan.planHash,
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        });
        expect(() =>
          insertLease(db, {
            attemptId,
            workItemId: workItem.id,
            admissionId: admission.admissionId,
            approvalId,
            planHash: plan.planHash,
            workerId: "worker-1"
          })
        ).toThrow("attempt_leases: attempt, admission, fence, or approval binding is invalid");
      } finally {
        db.close();
      }
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a lease referencing an already-expired approval", () => {
    const { directory, dbPath, store, workItem, plan, admission } = createAdmittedFixture({ requiresApproval: true });
    try {
      const db = new DatabaseSync(dbPath);
      try {
        const { attemptId } = insertLeasedAttempt(db, {
          workItemId: workItem.id,
          planId: plan.planId,
          planHash: plan.planHash,
          workerId: "worker-1"
        });
        const { approvalId } = insertApproval(db, {
          workItemId: workItem.id,
          planId: plan.planId,
          planHash: plan.planHash,
          createdAt: new Date(Date.now() - 120_000).toISOString(),
          expiresAt: new Date(Date.now() - 60_000).toISOString()
        });
        expect(() =>
          insertLease(db, {
            attemptId,
            workItemId: workItem.id,
            admissionId: admission.admissionId,
            approvalId,
            planHash: plan.planHash,
            workerId: "worker-1"
          })
        ).toThrow("attempt_leases: attempt, admission, fence, or approval binding is invalid");
      } finally {
        db.close();
      }
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects consuming an approval after its expiry even if it is still marked granted", () => {
    const { directory, dbPath, store, workItem, plan } = createAdmittedFixture({ requiresApproval: true });
    try {
      const db = new DatabaseSync(dbPath);
      try {
        const { approvalId } = insertApproval(db, {
          workItemId: workItem.id,
          planId: plan.planId,
          planHash: plan.planHash,
          createdAt: new Date(Date.now() - 120_000).toISOString(),
          expiresAt: new Date(Date.now() - 60_000).toISOString()
        });
        expect(() =>
          db
            .prepare(`UPDATE execution_plan_approvals SET status = 'consumed', consumed_at = ? WHERE approval_id = ?`)
            .run(new Date().toISOString(), approvalId)
        ).toThrow("execution_plan_approvals: immutable binding or invalid transition");
      } finally {
        db.close();
      }
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an attempt bound to a plan that has been superseded", () => {
    const { directory, dbPath, store, workItem, plan } = createAdmittedFixture();
    try {
      store.createExecutionPlan({
        workItemId: workItem.id,
        definition: { ...defaultExecutionPlanForWorkItem(workItem), objective: "a revised objective" },
        createdByActorId: "actor-user",
        expectedCurrentPlanHash: plan.planHash
      });
      const db = new DatabaseSync(dbPath);
      try {
        expect(() =>
          insertLeasedAttempt(db, {
            workItemId: workItem.id,
            planId: plan.planId,
            planHash: plan.planHash,
            workerId: "worker-1"
          })
        ).toThrow("execution_attempts: plan binding is invalid or superseded");
      } finally {
        db.close();
      }
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a result submitted after the lease's wall-clock expiry even while status is still active", () => {
    const { directory, dbPath, store, workItem, plan, admission } = createAdmittedFixture();
    try {
      const db = new DatabaseSync(dbPath);
      try {
        const { attemptId } = insertLeasedAttempt(db, {
          workItemId: workItem.id,
          planId: plan.planId,
          planHash: plan.planHash,
          workerId: "worker-1"
        });
        // The lease binding guard requires the attempt to still be 'leased' at
        // lease-insert time; only after that does the attempt move to 'running'.
        const { leaseId } = insertLease(db, {
          attemptId,
          workItemId: workItem.id,
          admissionId: admission.admissionId,
          approvalId: null,
          planHash: plan.planHash,
          workerId: "worker-1",
          issuedAt: new Date(Date.now() - 120_000).toISOString(),
          expiresAt: new Date(Date.now() - 60_000).toISOString()
        });
        db.prepare(`UPDATE execution_attempts SET status = 'running', started_at = ? WHERE attempt_id = ?`).run(
          new Date().toISOString(),
          attemptId
        );
        const now = new Date().toISOString();
        expect(() =>
          db
            .prepare(
              `INSERT INTO attempt_results
               (result_id, attempt_id, work_item_id, lease_id, worker_id, fencing_epoch, protocol_version,
                idempotency_key, plan_hash, input_hash, outcome, outcome_certainty, started_at, finished_at,
                exit_code, summary, structured_output_json, simulation_metadata_json, payload_hash, created_at)
               VALUES (?, ?, ?, ?, ?, 1, 'acs.worker.v2', ?, ?, ?, 'succeeded', 'observed', ?, ?, 0, 'ok', '{}',
                       '{"executionMode":"dry_run","simulated":1}', ?, ?)`
            )
            .run(
              `result_${Math.random().toString(36).slice(2)}`,
              attemptId,
              workItem.id,
              leaseId,
              "worker-1",
              `idem_${Math.random().toString(36).slice(2)}`,
              plan.planHash,
              hex("a"),
              now,
              now,
              hex("e"),
              now
            )
        ).toThrow("attempt_results: active attempt lease and fence binding is required");
      } finally {
        db.close();
      }
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("immutable execution plans", () => {
  it("derives deterministic hashes and safe dry-run constraints", () => {
    const { directory, store, workItem } = createFixture();
    try {
      const first = defaultExecutionPlanForWorkItem(workItem);
      const second = defaultExecutionPlanForWorkItem(workItem);

      expect(first).toMatchObject({
        schemaVersion: "acs.execution-plan.v1",
        workItemId: workItem.id,
        constraints: {
          executionMode: "dry_run",
          network: "none",
          localGitOnly: true,
          allowPush: false,
          allowDeployment: false,
          allowedCommands: []
        }
      });
      expect(executionPlanHash(first)).toBe(executionPlanHash(second));
      expect(first.subjectInputHash).toBe(executionPlanSubjectInputHash(workItem));
      expect(
        executionAttemptInputHash({
          workItemId: workItem.id,
          planHash: executionPlanHash(first),
          subjectInputHash: first.subjectInputHash
        })
      ).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates, versions, and reads immutable plan records atomically", () => {
    const { directory, dbPath, store, workItem } = createFixture();
    try {
      const initialDefinition = defaultExecutionPlanForWorkItem(workItem);
      const initial = store.createExecutionPlan({
        workItemId: workItem.id,
        definition: initialDefinition,
        createdByActorId: "actor-user"
      });
      const replay = store.createExecutionPlan({
        workItemId: workItem.id,
        definition: initialDefinition,
        createdByActorId: "actor-user"
      });

      expect(replay).toEqual(initial);
      expect(store.listExecutionPlans(workItem.id)).toEqual([initial]);
      expect(store.getCurrentExecutionPlan(workItem.id)).toEqual(initial);

      const changedDefinition = { ...initialDefinition, objective: `${initialDefinition.objective} safely` };
      expect(() =>
        store.createExecutionPlan({
          workItemId: workItem.id,
          definition: changedDefinition,
          createdByActorId: "actor-user"
        })
      ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "execution_plan_conflict" }));

      const changed = store.createExecutionPlan({
        workItemId: workItem.id,
        definition: changedDefinition,
        createdByActorId: "actor-user",
        expectedCurrentPlanHash: initial.planHash
      });
      expect(changed).toMatchObject({ planNumber: 2, workItemId: workItem.id });
      expect(changed.planHash).not.toBe(initial.planHash);
      expect(store.listExecutionPlans(workItem.id)).toEqual([initial, changed]);
      expect(store.getCurrentExecutionPlan(workItem.id)).toEqual(changed);

      const check = new DatabaseSync(dbPath);
      try {
        expect(() =>
          check.prepare(`UPDATE execution_plans SET definition_json = '{}' WHERE plan_id = ?`).run(initial.planId)
        ).toThrow("execution_plans: immutable");
        expect(() => check.prepare(`DELETE FROM execution_plans WHERE plan_id = ?`).run(initial.planId)).toThrow(
          "execution_plans: append-only"
        );
      } finally {
        check.close();
      }

      expect(store.readEvents().filter((event) => event.name === "execution_plan.created")).toHaveLength(2);
      expect(store.verifyAuditChain()).toMatchObject({ ok: true });
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects definitions that are not bound to the current work-item inputs", () => {
    const { directory, store, workItem } = createFixture();
    try {
      const definition = {
        ...defaultExecutionPlanForWorkItem(workItem),
        subjectInputHash: "0".repeat(64)
      };
      expect(() =>
        store.createExecutionPlan({
          workItemId: workItem.id,
          definition,
          createdByActorId: "actor-user"
        })
      ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "execution_plan_input_mismatch" }));
      expect(store.getCurrentExecutionPlan(workItem.id)).toBeUndefined();
      expect(store.readEvents().some((event) => event.name === "execution_plan.created")).toBe(false);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("admits only the current plan through the policy-gate authority", () => {
    const { directory, dbPath, store, workItem } = createFixture();
    try {
      const plan = store.createExecutionPlan({
        workItemId: workItem.id,
        definition: defaultExecutionPlanForWorkItem(workItem),
        createdByActorId: "actor-user"
      });
      const input = {
        workItemId: workItem.id,
        planHash: plan.planHash,
        policyVersion: "acs.policy.v1",
        policyDecisionHash: "1".repeat(64),
        requiresApproval: false,
        admittedByActorId: "policy-gate"
      };

      expect(() => store.admitExecutionPlan(input, { via: "domain_service" })).toThrowError(
        expect.objectContaining<Partial<ControlStackError>>({ code: "policy_gate_required" })
      );
      const admission = store.admitExecutionPlan(input, { via: "policy_gate" });
      expect(store.admitExecutionPlan(input, { via: "policy_gate" })).toEqual(admission);
      expect(store.getExecutionPlanAdmission(admission.admissionId)).toEqual(admission);

      const check = new DatabaseSync(dbPath);
      try {
        expect(() =>
          check
            .prepare(`UPDATE execution_plan_admissions SET policy_version = 'other' WHERE admission_id = ?`)
            .run(admission.admissionId)
        ).toThrow("execution_plan_admissions: immutable");
      } finally {
        check.close();
      }

      expect(store.readEvents().filter((event) => event.name === "execution_plan.admitted")).toHaveLength(1);
      expect(store.verifyAuditChain()).toMatchObject({ ok: true });
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back the plan, head, and event together when audit persistence fails", () => {
    const { directory, dbPath, store, workItem } = createFixture();
    try {
      const check = new DatabaseSync(dbPath);
      try {
        check.exec(`
          CREATE TRIGGER reject_execution_plan_audit
          BEFORE INSERT ON audit_events
          WHEN NEW.name = 'execution_plan.created'
          BEGIN
            SELECT RAISE(ABORT, 'test audit failure');
          END;
        `);
      } finally {
        check.close();
      }

      expect(() =>
        store.createExecutionPlan({
          workItemId: workItem.id,
          definition: defaultExecutionPlanForWorkItem(workItem),
          createdByActorId: "actor-user"
        })
      ).toThrow("test audit failure");
      expect(store.getCurrentExecutionPlan(workItem.id)).toBeUndefined();
      expect(store.listExecutionPlans(workItem.id)).toEqual([]);
      expect(store.verifyAuditChain()).toMatchObject({ ok: true });
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("throws a clear error for a work item with no requested actions instead of a schema crash", () => {
    const { directory, store, workItem } = createFixture();
    try {
      const noActionItem = { ...workItem, requestedActions: [] };
      expect(() => defaultExecutionPlanForWorkItem(noActionItem)).toThrowError(
        expect.objectContaining<Partial<ControlStackError>>({ code: "execution_plan_no_actions" })
      );
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when a persisted plan's definition no longer reproduces its recorded hash", () => {
    const { directory, dbPath, store, workItem } = createFixture();
    try {
      const definition = defaultExecutionPlanForWorkItem(workItem);

      // execution_plans is immutable (BEFORE UPDATE always aborts), so a real
      // tampered/mismatched row can only arrive via a fresh INSERT - this is
      // the same shape a restored backup or an out-of-band write would take.
      const db = new DatabaseSync(dbPath);
      const badPlanId = `plan_${Math.random().toString(36).slice(2)}`;
      try {
        db.prepare(
          `INSERT INTO execution_plans
           (plan_id, work_item_id, plan_number, schema_version, definition_json, plan_hash,
            subject_input_hash, created_by_actor_id, created_at)
           VALUES (?, ?, 1, 'acs.execution-plan.v1', ?, ?, ?, 'actor-user', ?)`
        ).run(
          badPlanId,
          workItem.id,
          JSON.stringify(definition),
          hex("f"), // does not reproduce executionPlanHash(definition)
          definition.subjectInputHash,
          new Date().toISOString()
        );
      } finally {
        db.close();
      }

      expect(() => store.getExecutionPlan(badPlanId)).toThrowError(
        expect.objectContaining<Partial<ControlStackError>>({ code: "execution_plan_hash_mismatch" })
      );
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("round-trips work items through the crash-recovery and retry states without a schema mismatch", () => {
    const { directory, store, workItem } = createFixture();
    try {
      // store.create() already leaves the item in pending_policy.
      store.transition(workItem.id, "approved", { via: "policy_gate" });
      // transition() itself refuses bare entry into "running" (it must be
      // claimed by a worker) - use the real claim path via the test escape hatch.
      const running = store.startWorkItem(workItem.id, "worker-1", { allowDirectStartForTests: true });
      expect(running.status).toBe("running");

      const unknown = store.transition(workItem.id, "unknown", { via: "policy_gate" });
      expect(unknown.status).toBe("unknown");
      expect(store.get(workItem.id)?.status).toBe("unknown");

      const quarantined = store.transition(workItem.id, "quarantined", { via: "policy_gate" });
      expect(quarantined.status).toBe("quarantined");
      expect(store.get(workItem.id)?.status).toBe("quarantined");

      expect(() => store.transition(workItem.id, "succeeded", { via: "policy_gate" })).toThrow(
        "cannot transition work item from quarantined to succeeded"
      );

      const retried = store.transition(workItem.id, "pending_policy", { via: "policy_gate" });
      expect(retried.status).toBe("pending_policy");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
