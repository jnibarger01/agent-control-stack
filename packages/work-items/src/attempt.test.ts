import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStackError } from "@agent-control-stack/shared";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteWorkItemStore, defaultExecutionPlanForWorkItem } from "./index.js";

function hex(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "acs-attempt-"));
  const dbPath = join(directory, "control.db");
  const store = new SqliteWorkItemStore(dbPath);
  const workItem = store.create({
    title: "Attempt/lease fixture",
    requester: "user",
    requesterSubject: "actor-user",
    intent: "prove attempt/lease/workspace-allocation authority binding",
    target: { cwd: "/repo", files: ["src/index.ts"] },
    requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["src/index.ts"], write: false } }],
    risk: "low"
  });
  const definition = defaultExecutionPlanForWorkItem(workItem);
  const plan = store.createExecutionPlan({ workItemId: workItem.id, definition, createdByActorId: "actor-user" });
  const admission = store.admitExecutionPlan(
    {
      workItemId: workItem.id,
      planHash: plan.planHash,
      policyVersion: "acs.policy.v1",
      policyDecisionHash: hex("1"),
      requiresApproval: false,
      admittedByActorId: "policy-gate"
    },
    { via: "policy_gate" }
  );
  return { directory, dbPath, store, workItem, plan, admission };
}

describe("createAttempt", () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("creates a pending attempt bound to the current execution plan", () => {
    const fixture = createFixture();
    directory = fixture.directory;

    const attempt = fixture.store.createAttempt(
      { workItemId: fixture.workItem.id, planHash: fixture.plan.planHash, inputHash: hex("a") },
      { via: "domain_service" }
    );

    expect(attempt).toMatchObject({
      workItemId: fixture.workItem.id,
      planId: fixture.plan.planId,
      planHash: fixture.plan.planHash,
      attemptNumber: 1,
      status: "pending",
      currentFencingEpoch: 0
    });
    expect(fixture.store.getAttempt(attempt.attemptId)).toEqual(attempt);
  });

  it("refuses to bind an attempt to a stale (non-current) plan hash", () => {
    const fixture = createFixture();
    directory = fixture.directory;

    expect(() =>
      fixture.store.createAttempt(
        { workItemId: fixture.workItem.id, planHash: hex("f"), inputHash: hex("a") },
        { via: "domain_service" }
      )
    ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "execution_plan_not_current" }));
  });

  it("refuses without a privileged transition option", () => {
    const fixture = createFixture();
    directory = fixture.directory;

    expect(() =>
      fixture.store.createAttempt(
        { workItemId: fixture.workItem.id, planHash: fixture.plan.planHash, inputHash: hex("a") },
        undefined as never
      )
    ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "policy_gate_required" }));
  });

  it("increments attempt_number across repeated attempts on the same work item", () => {
    const fixture = createFixture();
    directory = fixture.directory;

    const first = fixture.store.createAttempt(
      { workItemId: fixture.workItem.id, planHash: fixture.plan.planHash, inputHash: hex("a") },
      { via: "domain_service" }
    );
    fixture.store.leaseAttempt(
      {
        attemptId: first.attemptId,
        workItemId: fixture.workItem.id,
        admissionId: fixture.admission.admissionId,
        workerId: "worker-1",
        leaseToken: "a".repeat(32),
        policyVersion: "acs.policy.v1",
        policyDecisionHash: hex("1"),
        ttlMs: 60_000
      },
      { via: "domain_service" }
    );
    // Move the first attempt to a terminal status directly (no public store
    // API yet covers that transition - it's Phase 8 worker-lifecycle scope)
    // so it frees the "one active attempt per work item" slot and a second
    // attempt can be created against the same current plan.
    const dbAny = fixture.store as unknown as {
      db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } };
    };
    dbAny.db
      .prepare(
        `UPDATE execution_attempts SET status = 'cancelled', terminal_at = ?, outcome_code = ? WHERE attempt_id = ?`
      )
      .run(new Date().toISOString(), "cancelled", first.attemptId);

    const second = fixture.store.createAttempt(
      { workItemId: fixture.workItem.id, planHash: fixture.plan.planHash, inputHash: hex("b") },
      { via: "domain_service" }
    );
    expect(second.attemptNumber).toBe(2);
  });
});

describe("leaseAttempt", () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("transitions a pending attempt to leased with fencing epoch 1", () => {
    const fixture = createFixture();
    directory = fixture.directory;
    const attempt = fixture.store.createAttempt(
      { workItemId: fixture.workItem.id, planHash: fixture.plan.planHash, inputHash: hex("a") },
      { via: "domain_service" }
    );

    const lease = fixture.store.leaseAttempt(
      {
        attemptId: attempt.attemptId,
        workItemId: fixture.workItem.id,
        admissionId: fixture.admission.admissionId,
        workerId: "worker-1",
        leaseToken: "a".repeat(32),
        policyVersion: "acs.policy.v1",
        policyDecisionHash: hex("1"),
        ttlMs: 60_000
      },
      { via: "domain_service" }
    );

    expect(lease).toMatchObject({
      attemptId: attempt.attemptId,
      workerId: "worker-1",
      fencingEpoch: 1,
      status: "active"
    });
    expect(fixture.store.getAttempt(attempt.attemptId)).toMatchObject({
      status: "leased",
      currentFencingEpoch: 1,
      claimedByWorkerId: "worker-1"
    });
  });

  it("refuses to lease an attempt that is already leased", () => {
    const fixture = createFixture();
    directory = fixture.directory;
    const attempt = fixture.store.createAttempt(
      { workItemId: fixture.workItem.id, planHash: fixture.plan.planHash, inputHash: hex("a") },
      { via: "domain_service" }
    );
    const leaseInput = {
      attemptId: attempt.attemptId,
      workItemId: fixture.workItem.id,
      admissionId: fixture.admission.admissionId,
      workerId: "worker-1",
      leaseToken: "a".repeat(32),
      policyVersion: "acs.policy.v1",
      policyDecisionHash: hex("1"),
      ttlMs: 60_000
    };
    fixture.store.leaseAttempt(leaseInput, { via: "domain_service" });

    expect(() =>
      fixture.store.leaseAttempt({ ...leaseInput, leaseToken: "b".repeat(32) }, { via: "domain_service" })
    ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "attempt_not_leasable" }));
  });
});

describe("recordWorkspaceAllocation / getWorkspaceAllocation", () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("records a workspace allocation and is idempotent for the same binding", () => {
    const fixture = createFixture();
    directory = fixture.directory;

    const first = fixture.store.recordWorkspaceAllocation(
      {
        allocationId: "workspace_1",
        workItemId: fixture.workItem.id,
        hostPath: "/repo/wrk_1",
        branch: "acs/job/wrk_1",
        baseRef: "main"
      },
      { via: "domain_service" }
    );
    const second = fixture.store.recordWorkspaceAllocation(
      {
        allocationId: "workspace_1",
        workItemId: fixture.workItem.id,
        hostPath: "/repo/wrk_1",
        branch: "acs/job/wrk_1",
        baseRef: "main"
      },
      { via: "domain_service" }
    );

    expect(first).toEqual(second);
    expect(fixture.store.getWorkspaceAllocation("workspace_1")).toEqual(first);
  });

  it("refuses to reuse an allocation id with a different host path (substitution attempt)", () => {
    const fixture = createFixture();
    directory = fixture.directory;
    fixture.store.recordWorkspaceAllocation(
      {
        allocationId: "workspace_1",
        workItemId: fixture.workItem.id,
        hostPath: "/repo/wrk_1",
        branch: "acs/job/wrk_1",
        baseRef: "main"
      },
      { via: "domain_service" }
    );

    expect(() =>
      fixture.store.recordWorkspaceAllocation(
        {
          allocationId: "workspace_1",
          workItemId: fixture.workItem.id,
          hostPath: "/tmp/attacker-controlled-path",
          branch: "acs/job/wrk_1",
          baseRef: "main"
        },
        { via: "domain_service" }
      )
    ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "workspace_allocation_conflict" }));
  });
});

describe("getCommandAuthority", () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  function leasedFixture(overrides: { ttlMs?: number; now?: Date } = {}) {
    const fixture = createFixture();
    const attempt = fixture.store.createAttempt(
      { workItemId: fixture.workItem.id, planHash: fixture.plan.planHash, inputHash: hex("a") },
      { via: "domain_service" }
    );
    const lease = fixture.store.leaseAttempt(
      {
        attemptId: attempt.attemptId,
        workItemId: fixture.workItem.id,
        admissionId: fixture.admission.admissionId,
        workerId: "worker-1",
        leaseToken: "a".repeat(32),
        policyVersion: "acs.policy.v1",
        policyDecisionHash: hex("1"),
        ttlMs: overrides.ttlMs ?? 60_000,
        now: overrides.now
      },
      { via: "domain_service" }
    );
    const allocation = fixture.store.recordWorkspaceAllocation(
      {
        allocationId: "workspace_1",
        workItemId: fixture.workItem.id,
        hostPath: "/repo/wrk_1",
        branch: "acs/job/wrk_1",
        baseRef: "main"
      },
      { via: "domain_service" }
    );
    const dbAny = fixture.store as unknown as {
      db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } };
    };
    dbAny.db
      .prepare(`UPDATE execution_attempts SET status = 'running', started_at = ? WHERE attempt_id = ?`)
      .run(new Date().toISOString(), attempt.attemptId);
    return { ...fixture, attempt, lease, allocation };
  }

  it("returns full authority for a valid, matching, unexpired lease/attempt/allocation triple", () => {
    const fixture = leasedFixture();
    directory = fixture.directory;

    const authority = fixture.store.getCommandAuthority({
      workItemId: fixture.workItem.id,
      attemptId: fixture.attempt.attemptId,
      leaseId: fixture.lease.leaseId,
      workerId: "worker-1",
      fencingToken: 1,
      workspaceAllocationId: "workspace_1"
    });

    expect(authority).toBeDefined();
    expect(authority?.attempt.status).toBe("running");
    expect(authority?.lease.status).toBe("active");
    expect(authority?.workspaceAllocation.hostPath).toBe("/repo/wrk_1");
  });

  it("rejects a wrong fencing token (stale caller)", () => {
    const fixture = leasedFixture();
    directory = fixture.directory;

    const authority = fixture.store.getCommandAuthority({
      workItemId: fixture.workItem.id,
      attemptId: fixture.attempt.attemptId,
      leaseId: fixture.lease.leaseId,
      workerId: "worker-1",
      fencingToken: 999,
      workspaceAllocationId: "workspace_1"
    });
    expect(authority).toBeUndefined();
  });

  it("rejects a wrong worker id (identity substitution)", () => {
    const fixture = leasedFixture();
    directory = fixture.directory;

    const authority = fixture.store.getCommandAuthority({
      workItemId: fixture.workItem.id,
      attemptId: fixture.attempt.attemptId,
      leaseId: fixture.lease.leaseId,
      workerId: "attacker-worker",
      fencingToken: 1,
      workspaceAllocationId: "workspace_1"
    });
    expect(authority).toBeUndefined();
  });

  it("rejects a workspace allocation id that does not belong to this work item's real allocation", () => {
    const fixture = leasedFixture();
    directory = fixture.directory;

    const authority = fixture.store.getCommandAuthority({
      workItemId: fixture.workItem.id,
      attemptId: fixture.attempt.attemptId,
      leaseId: fixture.lease.leaseId,
      workerId: "worker-1",
      fencingToken: 1,
      workspaceAllocationId: "workspace_attacker_controlled"
    });
    expect(authority).toBeUndefined();
  });

  it("rejects an expired lease even though every identifier otherwise matches", () => {
    const past = new Date(Date.now() - 60 * 60 * 1_000);
    const fixture = leasedFixture({ ttlMs: 1_000, now: past });
    directory = fixture.directory;

    const authority = fixture.store.getCommandAuthority({
      workItemId: fixture.workItem.id,
      attemptId: fixture.attempt.attemptId,
      leaseId: fixture.lease.leaseId,
      workerId: "worker-1",
      fencingToken: 1,
      workspaceAllocationId: "workspace_1"
    });
    expect(authority).toBeUndefined();
  });

  it("rejects a lease/attempt pair from an entirely different work item", () => {
    const fixture = leasedFixture();
    directory = fixture.directory;
    const other = createFixture();
    try {
      const authority = fixture.store.getCommandAuthority({
        workItemId: other.workItem.id,
        attemptId: fixture.attempt.attemptId,
        leaseId: fixture.lease.leaseId,
        workerId: "worker-1",
        fencingToken: 1,
        workspaceAllocationId: "workspace_1"
      });
      expect(authority).toBeUndefined();
    } finally {
      rmSync(other.directory, { recursive: true, force: true });
    }
  });
});
