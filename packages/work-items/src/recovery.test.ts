import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { defaultExecutionPlanForWorkItem, SqliteWorkItemStore } from "./index.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "acs-recovery-record-"));
  const store = new SqliteWorkItemStore(join(directory, "control.db"));
  const workItem = store.create({
    title: "recovery",
    requester: "user",
    requesterSubject: "actor-user",
    intent: "recover",
    target: { cwd: "/repo" },
    requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: [], write: false } }],
    risk: "low"
  });
  const plan = store.createExecutionPlan({
    workItemId: workItem.id,
    definition: defaultExecutionPlanForWorkItem(workItem),
    createdByActorId: "actor-user"
  });
  const attempt = store.createAttempt(
    { workItemId: workItem.id, planHash: plan.planHash, inputHash: "a".repeat(64) },
    { via: "domain_service" }
  );
  return { directory, store, workItem, attempt };
}

describe("recovery persistence", () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("records a bounded recovery decision idempotently", () => {
    const f = fixture();
    directory = f.directory;
    const input = {
      attemptId: f.attempt.attemptId,
      workItemId: f.workItem.id,
      decision: "retryable" as const,
      retryAllowed: true,
      reason: "process disappeared",
      retryAfterMs: 1000,
      idempotencyKey: "recovery-1"
    };
    const first = f.store.recordRecoveryDecision(input, { via: "domain_service" });
    expect(f.store.recordRecoveryDecision(input, { via: "domain_service" })).toEqual(first);
    expect(f.store.getRecoveryDecisionForAttempt(f.attempt.attemptId)).toEqual(first);
    expect(f.store.readEvents().filter((event) => event.name === "attempt.recovery_decision.recorded")).toHaveLength(1);
    expect(() => f.store.recordRecoveryDecision({ ...input, reason: "changed" }, { via: "domain_service" })).toThrow(
      /different evidence/u
    );
    expect(() => f.store.recordRecoveryDecision({ ...input, workItemId: "other" }, { via: "domain_service" })).toThrow(
      /different evidence/u
    );
    expect(() =>
      f.store.recordRecoveryDecision(
        { ...input, idempotencyKey: "other-key", workItemId: "other" },
        { via: "domain_service" }
      )
    ).toThrow(/another work item/u);
    expect(() =>
      f.store.recordRecoveryDecision(
        { ...input, idempotencyKey: "conflict-key", retryAllowed: false },
        { via: "domain_service" }
      )
    ).toThrow(/must match/u);
    expect(
      f.store.recordRecoveryDecision(
        { ...input, idempotencyKey: "clock-key", now: new Date("2026-01-01T00:00:00Z") },
        { via: "domain_service" }
      ).createdAt
    ).toBe("2026-01-01T00:00:00.000Z");
  });

  it("checks append-only recovery records against their hash-verified audit evidence", () => {
    const f = fixture();
    directory = f.directory;
    const input = {
      attemptId: f.attempt.attemptId,
      workItemId: f.workItem.id,
      decision: "validation_pending" as const,
      retryAllowed: false,
      reason: "unknown effect",
      idempotencyKey: "uncertain-1"
    };
    f.store.recordRecoveryDecision(input, { via: "domain_service" });
    const db = new DatabaseSync(join(f.directory, "control.db"));
    try {
      expect(() => db.prepare("UPDATE recovery_records SET reason = 'tampered'").run()).toThrow(/append-only/u);
      // Simulate tampering only in this disposable database. Runtime protections
      // remain enabled; the read must detect damage even if custody was lost.
      db.exec("DROP TRIGGER recovery_records_no_update");
      db.prepare("UPDATE recovery_records SET reason = 'tampered'").run();
      expect(() => f.store.getRecoveryDecisionForAttempt(f.attempt.attemptId)).toThrow(/persisted recovery evidence/u);
      expect(() => f.store.recordRecoveryDecision({ ...input, reason: "tampered" }, { via: "domain_service" })).toThrow(
        /persisted recovery evidence/u
      );
    } finally {
      db.close();
      f.store.close();
    }
  });

  it("returns undefined for getActiveLeaseForAttempt when no lease has ever been issued", () => {
    const f = fixture();
    directory = f.directory;
    expect(f.store.getActiveLeaseForAttempt(f.attempt.attemptId)).toBeUndefined();
  });

  it("returns the real lease for getActiveLeaseForAttempt, so startup reconciliation never has to assume its status", () => {
    const f = fixture();
    directory = f.directory;
    const admission = f.store.admitExecutionPlan(
      {
        workItemId: f.workItem.id,
        planHash: f.attempt.planHash,
        policyVersion: "acs.policy.v1",
        policyDecisionHash: "e".repeat(64),
        requiresApproval: false,
        admittedByActorId: "policy-gate"
      },
      { via: "policy_gate" }
    );
    const lease = f.store.leaseAttempt(
      {
        attemptId: f.attempt.attemptId,
        workItemId: f.workItem.id,
        admissionId: admission.admissionId,
        workerId: "worker-1",
        leaseToken: "lease-token-which-is-long-enough",
        policyVersion: admission.policyVersion,
        policyDecisionHash: admission.policyDecisionHash,
        ttlMs: 5 * 60_000
      },
      { via: "domain_service", actorId: "worker-1" }
    );

    const observed = f.store.getActiveLeaseForAttempt(f.attempt.attemptId);
    expect(observed).toMatchObject({ leaseId: lease.leaseId, status: "active", expiresAt: lease.expiresAt });
    expect(() =>
      f.store.recordRecoveryDecision(
        {
          attemptId: f.attempt.attemptId,
          workItemId: f.workItem.id,
          decision: "retryable",
          retryAllowed: true,
          reason: "process disappeared",
          idempotencyKey: "leased-retry"
        },
        { via: "domain_service" }
      )
    ).toThrow(/unleased, unstarted/u);
  });
});
