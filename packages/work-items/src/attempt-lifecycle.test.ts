import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ControlStackError } from "@agent-control-stack/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORKER_PROTOCOL_VERSION,
  defaultExecutionPlanForWorkItem,
  executionAttemptInputHash,
  executionPlanSubjectInputHash,
  type ClaimExecutionAttemptInput,
  type ExecutionPlanAdmission,
  type ExecutionPlanRecord
} from "./execution-plan.js";
import { SqliteWorkItemStore } from "./store.js";
import { type WorkItem } from "./work-item.js";

const directories: string[] = [];
const fixedNow = new Date("2026-07-24T00:00:00.000Z");

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("execution attempt lifecycle", () => {
  it("requires privileged authorization for lifecycle transitions", () => {
    const context = createContext("transition-authorization");
    try {
      const claim = context.store.claimExecutionAttempt(claimInput(context, "worker-auth"));
      expect(() =>
        context.store.transitionExecutionAttempt({
          attemptId: claim.attemptId,
          status: "unknown",
          actorId: "untrusted-caller",
          reason: "unauthorized transition",
          now: fixedNow
        })
      ).toThrowError(expect.objectContaining({ code: "policy_gate_required" }));
    } finally {
      context.close();
    }
  });

  it("creates immutable, sequential attempts and preserves historical records", () => {
    const context = createContext("sequential");
    try {
      const first = context.store.claimExecutionAttempt(claimInput(context, "worker-a"));
      const firstRecord = context.store.getExecutionAttempt(first.attemptId);
      expect(firstRecord).toMatchObject({ attemptNumber: 1, status: "leased", attemptId: first.attemptId });

      expect(() =>
        context.store.retryExecutionAttempt({ ...claimInput(context, "worker-b"), attemptId: first.attemptId })
      ).toThrow(ControlStackError);

      context.store.transitionExecutionAttempt(
        {
          attemptId: first.attemptId,
          status: "unknown",
          actorId: "supervisor",
          reason: "worker stopped reporting",
          now: fixedNow
        },
        { via: "domain_service" }
      );
      const second = context.store.retryExecutionAttempt({
        ...claimInput(context, "worker-b"),
        attemptId: first.attemptId
      });

      expect(second.attemptId).not.toBe(first.attemptId);
      expect(second.attemptNumber).toBe(2);
      expect(context.store.listExecutionAttempts(context.workItem.id).map((attempt) => attempt.attemptNumber)).toEqual([
        1, 2
      ]);
      expect(context.store.getExecutionAttempt(first.attemptId)?.status).toBe("unknown");
      expect(context.store.getExecutionAttempt(second.attemptId)?.status).toBe("leased");
    } finally {
      context.close();
    }
  });

  it("allows only leased-to-terminal transitions and keeps terminal attempts immutable", () => {
    for (const status of ["unknown", "quarantined"] as const) {
      const context = createContext(`transition-${status}`);
      try {
        const claim = context.store.claimExecutionAttempt(claimInput(context, `worker-${status}`));
        const before = context.store.readEvents().length;
        const terminal = context.store.transitionExecutionAttempt(
          {
            attemptId: claim.attemptId,
            status,
            actorId: "supervisor",
            reason: `mark ${status}`,
            now: fixedNow
          },
          { via: "domain_service" }
        );
        expect(terminal.status).toBe(status);
        expect(() =>
          context.store.transitionExecutionAttempt(
            {
              attemptId: claim.attemptId,
              status: "unknown",
              actorId: "supervisor",
              reason: "duplicate terminal submission",
              now: fixedNow
            },
            { via: "domain_service" }
          )
        ).toThrow(ControlStackError);
        expect(context.store.readEvents().length).toBe(before + 1);
        expect(() =>
          context.db
            .prepare(`UPDATE execution_attempts SET status = 'leased' WHERE attempt_id = ?`)
            .run(claim.attemptId)
        ).toThrow("execution_attempts: immutable field or invalid lifecycle transition");
      } finally {
        context.close();
      }
    }
  });

  it("rolls back an attempt transition when its audit event fails", () => {
    const context = createContext("transition-audit-rollback");
    try {
      const claim = context.store.claimExecutionAttempt(claimInput(context, "worker-audit"));
      context.db.exec(`
        CREATE TRIGGER reject_attempt_transition_audit
        BEFORE INSERT ON audit_events
        WHEN NEW.name = 'execution_attempt.transitioned'
        BEGIN
          SELECT RAISE(ABORT, 'test attempt transition audit failure');
        END;
      `);
      expect(() =>
        context.store.transitionExecutionAttempt(
          {
            attemptId: claim.attemptId,
            status: "quarantined",
            actorId: "supervisor",
            reason: "audit must be atomic",
            now: fixedNow
          },
          { via: "domain_service" }
        )
      ).toThrow("test attempt transition audit failure");
      expect(context.store.getExecutionAttempt(claim.attemptId)?.status).toBe("leased");
    } finally {
      context.close();
    }
  });

  it("rejects malformed and tampered historical input hashes", () => {
    const context = createContext("input-integrity");
    try {
      const claim = context.store.claimExecutionAttempt(claimInput(context, "worker-integrity"));
      context.db.exec(`DROP TRIGGER execution_attempts_transition_guard`);
      context.db
        .prepare(`UPDATE execution_attempts SET input_hash = ? WHERE attempt_id = ?`)
        .run("f".repeat(64), claim.attemptId);
      expect(() => context.store.getExecutionAttempt(claim.attemptId)).toThrow(ControlStackError);
    } finally {
      context.close();
    }
  });

  it("does not let retry bypass a changed plan or admission authority", () => {
    const context = createContext("changed-authority");
    try {
      const first = context.store.claimExecutionAttempt(claimInput(context, "worker-first"));
      context.store.transitionExecutionAttempt(
        {
          attemptId: first.attemptId,
          status: "quarantined",
          actorId: "supervisor",
          reason: "quarantine before replanning",
          now: fixedNow
        },
        { via: "domain_service" }
      );

      const nextDefinition = {
        ...context.plan.definition,
        objective: "changed objective requires a new authority record"
      };
      const nextPlan = context.store.createExecutionPlan({
        workItemId: context.workItem.id,
        definition: nextDefinition,
        createdByActorId: "planner",
        expectedCurrentPlanHash: context.plan.planHash,
        now: fixedNow
      });
      const nextAdmission = context.store.admitExecutionPlan(
        {
          workItemId: context.workItem.id,
          planHash: nextPlan.planHash,
          policyVersion: "acs.policy.v2",
          policyDecisionHash: "b".repeat(64),
          decision: "allow",
          requiredApprovalActionHashes: [],
          admittedByActorId: "policy",
          now: fixedNow
        },
        { via: "policy_gate" }
      );

      expect(() =>
        context.store.retryExecutionAttempt({
          ...claimInput(context, "worker-old-authority"),
          attemptId: first.attemptId
        })
      ).toThrow(ControlStackError);

      const retry = context.store.retryExecutionAttempt({
        ...claimInput(context, "worker-new-authority", nextPlan, nextAdmission),
        attemptId: first.attemptId
      });
      expect(retry.attemptNumber).toBe(2);
      expect(retry.planHash).toBe(nextPlan.planHash);
      expect(retry.admissionHash).toBe(nextAdmission.admissionHash);
      expect(context.store.listExecutionAttempts(context.workItem.id)).toHaveLength(2);
    } finally {
      context.close();
    }
  });

  it("serializes competing retries and never duplicates an attempt number", () => {
    const context = createContext("competing-retries");
    const competing = new SqliteWorkItemStore(context.dbPath);
    try {
      const first = context.store.claimExecutionAttempt(claimInput(context, "worker-first"));
      context.store.transitionExecutionAttempt(
        {
          attemptId: first.attemptId,
          status: "unknown",
          actorId: "supervisor",
          reason: "retry test",
          now: fixedNow
        },
        { via: "domain_service" }
      );
      const retry = context.store.retryExecutionAttempt({
        ...claimInput(context, "worker-second"),
        attemptId: first.attemptId
      });
      expect(retry.attemptNumber).toBe(2);
      expect(() =>
        competing.retryExecutionAttempt({
          ...claimInput(context, "worker-third"),
          attemptId: first.attemptId
        })
      ).toThrow(ControlStackError);
      expect(context.store.listExecutionAttempts(context.workItem.id).map((attempt) => attempt.attemptNumber)).toEqual([
        1, 2
      ]);
    } finally {
      competing.close();
      context.close();
    }
  });
});

function createContext(label: string, plan = undefined, admission = undefined) {
  const directory = mkdtempSync(join(tmpdir(), `acs-attempt-lifecycle-${label}-`));
  directories.push(directory);
  const dbPath = join(directory, "control.db");
  const store = new SqliteWorkItemStore(dbPath);
  const workItem = store.create({
    title: "Attempt lifecycle",
    requester: "user",
    intent: "exercise attempt lifecycle",
    requestedActions: [{ kind: "manual", description: "dry-run" }],
    risk: "low"
  });
  store.approveWorkItem(workItem.id, { via: "domain_service" });
  const definition = plan ?? defaultExecutionPlanForWorkItem(workItem);
  const createdPlan = store.createExecutionPlan({
    workItemId: workItem.id,
    definition,
    createdByActorId: "planner",
    now: fixedNow
  });
  const createdAdmission =
    admission ??
    store.admitExecutionPlan(
      {
        workItemId: workItem.id,
        planHash: createdPlan.planHash,
        policyVersion: "acs.policy.v1",
        policyDecisionHash: "a".repeat(64),
        decision: "allow",
        requiredApprovalActionHashes: [],
        admittedByActorId: "policy",
        now: fixedNow
      },
      { via: "policy_gate" }
    );
  return {
    dbPath,
    db: new DatabaseSync(dbPath),
    store,
    workItem,
    plan: createdPlan,
    admission: createdAdmission,
    close() {
      this.db.close();
      store.close();
    }
  } as {
    dbPath: string;
    db: DatabaseSync;
    store: SqliteWorkItemStore;
    workItem: WorkItem;
    plan: ExecutionPlanRecord;
    admission: ExecutionPlanAdmission;
    close: () => void;
  };
}

function claimInput(
  context: ReturnType<typeof createContext>,
  workerId: string,
  plan = context.plan,
  admission = context.admission
): ClaimExecutionAttemptInput {
  return {
    protocolVersion: WORKER_PROTOCOL_VERSION,
    workItemId: context.workItem.id,
    planId: plan.planId,
    planHash: plan.planHash,
    admissionId: admission.admissionId,
    admissionHash: admission.admissionHash,
    inputHash: executionAttemptInputHash({
      workItemId: context.workItem.id,
      planId: plan.planId,
      planHash: plan.planHash,
      admissionId: admission.admissionId,
      admissionHash: admission.admissionHash,
      subjectInputHash: executionPlanSubjectInputHash(context.workItem),
      policyVersion: admission.policyVersion,
      policyDecisionHash: admission.policyDecisionHash,
      approvalBindingHashes: []
    }),
    workerId,
    leaseMs: 5 * 60 * 1_000,
    now: fixedNow
  };
}
