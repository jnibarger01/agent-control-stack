import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ControlStackError } from "@agent-control-stack/shared";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteWorkItemStore, defaultExecutionPlanForWorkItem } from "./index.js";

function hex(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "acs-pr30-authority-"));
  const dbPath = join(directory, "control.db");
  const store = new SqliteWorkItemStore(dbPath);
  const workItem = store.create({
    title: "PR30 authority fixture",
    requester: "user",
    intent: "verify persisted authority",
    target: { cwd: "/repo" },
    requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["src/index.ts"] } }],
    risk: "low"
  });
  const plan = store.createExecutionPlan({
    workItemId: workItem.id,
    definition: defaultExecutionPlanForWorkItem(workItem),
    createdByActorId: "user"
  });
  const admission = store.admitExecutionPlan(
    {
      workItemId: workItem.id,
      planHash: plan.planHash,
      policyVersion: "acs.policy.v1",
      policyDecisionHash: hex("1"),
      requiresApproval: false,
      admittedByActorId: "policy"
    },
    { via: "policy_gate" }
  );
  return { directory, dbPath, store, workItem, plan, admission };
}
function leaseAttempt(f: ReturnType<typeof fixture>, workerId: string, inputHash: string, now?: Date, ttlMs = 60_000) {
  const attempt = f.store.createAttempt(
    { workItemId: f.workItem.id, planHash: f.plan.planHash, inputHash },
    { via: "domain_service" }
  );
  const lease = f.store.leaseAttempt(
    {
      attemptId: attempt.attemptId,
      workItemId: f.workItem.id,
      admissionId: f.admission.admissionId,
      workerId,
      leaseToken: workerId.repeat(16),
      policyVersion: "acs.policy.v1",
      policyDecisionHash: hex("1"),
      ttlMs,
      now
    },
    { via: "domain_service" }
  );
  const db = f.store as unknown as {
    db: { prepare: (sql: string) => { run: (...args: unknown[]) => { changes: number } } };
  };
  db.db
    .prepare("UPDATE execution_attempts SET status = 'running', started_at = ?, updated_at = ? WHERE attempt_id = ?")
    .run(new Date().toISOString(), new Date().toISOString(), attempt.attemptId);
  return { attempt, lease };
}

describe("PR30 authority review regressions", () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("refuses to persist an attempt-scoped workspace for an expired lease", () => {
    const f = fixture();
    directory = f.directory;
    const { attempt, lease } = leaseAttempt(f, "worker-expired", hex("a"), new Date(Date.now() - 120_000), 1_000);
    expect(() =>
      f.store.recordWorkspaceAllocation(
        {
          allocationId: "workspace_expired",
          workItemId: f.workItem.id,
          attemptId: attempt.attemptId,
          leaseId: lease.leaseId,
          workerId: lease.workerId,
          fencingEpoch: lease.fencingEpoch,
          hostPath: "/repo/expired",
          branch: "acs/expired",
          baseRef: "HEAD"
        },
        { via: "domain_service" }
      )
    ).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "workspace_allocation_authority_invalid" })
    );
    f.store.close();
  });

  it("does not authorize a newer attempt against an older active workspace allocation", () => {
    const f = fixture();
    directory = f.directory;
    const first = leaseAttempt(f, "worker-one", hex("a"));
    f.store.recordWorkspaceAllocation(
      {
        allocationId: "workspace_old",
        workItemId: f.workItem.id,
        attemptId: first.attempt.attemptId,
        leaseId: first.lease.leaseId,
        workerId: first.lease.workerId,
        fencingEpoch: first.lease.fencingEpoch,
        hostPath: "/repo/old",
        branch: "acs/old",
        baseRef: "HEAD"
      },
      { via: "domain_service" }
    );
    const raw = new DatabaseSync(f.dbPath);
    raw
      .prepare("UPDATE attempt_leases SET status = 'revoked', closed_at = ? WHERE lease_id = ?")
      .run(new Date().toISOString(), first.lease.leaseId);
    raw
      .prepare(
        "UPDATE execution_attempts SET status = 'cancelled', terminal_at = ?, outcome_code = 'cancelled', updated_at = ? WHERE attempt_id = ?"
      )
      .run(new Date().toISOString(), new Date().toISOString(), first.attempt.attemptId);
    raw.close();
    const second = leaseAttempt(f, "worker-two", hex("b"));
    expect(
      f.store.getCommandAuthority({
        workItemId: f.workItem.id,
        attemptId: second.attempt.attemptId,
        leaseId: second.lease.leaseId,
        workerId: second.lease.workerId,
        fencingToken: second.lease.fencingEpoch,
        workspaceAllocationId: "workspace_old"
      })
    ).toBeUndefined();
    f.store.close();
  });

  it("expires a stale execution-plan approval so a replacement can be granted", () => {
    const f = fixture();
    directory = f.directory;
    const old = f.store.grantExecutionPlanApproval(
      {
        workItemId: f.workItem.id,
        planHash: f.plan.planHash,
        actionHash: hex("c"),
        approvedByActorId: "approver",
        now: new Date(Date.now() - 120_000),
        expiresInMs: 1_000
      },
      { via: "domain_service" }
    );
    const replacement = f.store.grantExecutionPlanApproval(
      { workItemId: f.workItem.id, planHash: f.plan.planHash, actionHash: hex("c"), approvedByActorId: "approver" },
      { via: "domain_service" }
    );
    expect(replacement.approvalId).not.toBe(old.approvalId);
    const db = new DatabaseSync(f.dbPath, { readOnly: true });
    expect(db.prepare("SELECT status FROM execution_plan_approvals WHERE approval_id = ?").get(old.approvalId)).toEqual(
      { status: "expired" }
    );
    db.close();
    f.store.close();
  });
});
