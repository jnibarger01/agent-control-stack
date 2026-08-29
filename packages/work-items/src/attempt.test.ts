import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
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
        attemptId: attempt.attemptId,
        leaseId: lease.leaseId,
        workerId: lease.workerId,
        fencingEpoch: lease.fencingEpoch,
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
    const fixture = leasedFixture();
    directory = fixture.directory;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(fixture.lease.expiresAt) + 1));
    const authority = fixture.store.getCommandAuthority({
      workItemId: fixture.workItem.id,
      attemptId: fixture.attempt.attemptId,
      leaseId: fixture.lease.leaseId,
      workerId: "worker-1",
      fencingToken: 1,
      workspaceAllocationId: "workspace_1"
    });
    vi.useRealTimers();
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

describe("getWorkspaceCleanupAuthority", () => {
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
    fixture.store.recordWorkspaceAllocation(
      {
        allocationId: "workspace_1",
        workItemId: fixture.workItem.id,
        attemptId: attempt.attemptId,
        leaseId: lease.leaseId,
        workerId: lease.workerId,
        fencingEpoch: lease.fencingEpoch,
        hostPath: "/repo/wrk_1",
        branch: "acs/job/wrk_1",
        baseRef: "main"
      },
      { via: "domain_service" }
    );
    return { ...fixture, attempt, lease };
  }

  it("authorizes cleanup for the still-live attempt's own active, unexpired lease", () => {
    const fixture = leasedFixture();
    directory = fixture.directory;

    const authorized = fixture.store.getWorkspaceCleanupAuthority({
      workItemId: fixture.workItem.id,
      attemptId: fixture.attempt.attemptId,
      leaseId: fixture.lease.leaseId,
      workerId: "worker-1",
      fencingEpoch: fixture.lease.fencingEpoch,
      workspaceAllocationId: "workspace_1"
    });

    expect(authorized).toBe(true);
  });

  it("refuses cleanup once the presented lease has expired, even though worker/epoch still match", () => {
    const fixture = leasedFixture({ ttlMs: 50 });
    directory = fixture.directory;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(fixture.lease.expiresAt) + 1));

    const authorized = fixture.store.getWorkspaceCleanupAuthority({
      workItemId: fixture.workItem.id,
      attemptId: fixture.attempt.attemptId,
      leaseId: fixture.lease.leaseId,
      workerId: "worker-1",
      fencingEpoch: fixture.lease.fencingEpoch,
      workspaceAllocationId: "workspace_1"
    });

    vi.useRealTimers();
    expect(authorized).toBe(false);
  });

  it("authorizes cleanup after the attempt has reached a terminal status, without requiring a still-active lease", () => {
    const fixture = leasedFixture();
    directory = fixture.directory;
    fixture.store.transitionAttempt(
      {
        attemptId: fixture.attempt.attemptId,
        workItemId: fixture.workItem.id,
        workerId: "worker-1",
        fencingEpoch: fixture.lease.fencingEpoch,
        status: "running"
      },
      { via: "domain_service" }
    );
    fixture.store.transitionAttempt(
      {
        attemptId: fixture.attempt.attemptId,
        workItemId: fixture.workItem.id,
        workerId: "worker-1",
        fencingEpoch: fixture.lease.fencingEpoch,
        status: "succeeded"
      },
      { via: "domain_service" }
    );

    const authorized = fixture.store.getWorkspaceCleanupAuthority({
      workItemId: fixture.workItem.id,
      attemptId: fixture.attempt.attemptId,
      leaseId: fixture.lease.leaseId,
      workerId: "worker-1",
      fencingEpoch: fixture.lease.fencingEpoch,
      workspaceAllocationId: "workspace_1"
    });

    expect(authorized).toBe(true);
  });

  it("refuses cleanup for a worker/epoch that no longer matches the attempt's current fencing state", () => {
    const fixture = leasedFixture();
    directory = fixture.directory;

    const authorized = fixture.store.getWorkspaceCleanupAuthority({
      workItemId: fixture.workItem.id,
      attemptId: fixture.attempt.attemptId,
      leaseId: fixture.lease.leaseId,
      workerId: "attacker-worker",
      fencingEpoch: fixture.lease.fencingEpoch,
      workspaceAllocationId: "workspace_1"
    });

    expect(authorized).toBe(false);
  });

  it("returns false for an allocation id that does not belong to this work item/attempt", () => {
    const fixture = leasedFixture();
    directory = fixture.directory;

    const authorized = fixture.store.getWorkspaceCleanupAuthority({
      workItemId: fixture.workItem.id,
      attemptId: fixture.attempt.attemptId,
      leaseId: fixture.lease.leaseId,
      workerId: "worker-1",
      fencingEpoch: fixture.lease.fencingEpoch,
      workspaceAllocationId: "workspace_attacker_controlled"
    });

    expect(authorized).toBe(false);
  });
});

describe("leaseAttempt consumes an execution-plan approval atomically (R3)", () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  function createApprovalRequiredFixture() {
    const fixture = createFixture();
    // Replace the no-approval-required admission from createFixture with a
    // requires-approval one bound to the same current plan.
    const admission = fixture.store.admitExecutionPlan(
      {
        workItemId: fixture.workItem.id,
        planHash: fixture.plan.planHash,
        policyVersion: "acs.policy.v2",
        policyDecisionHash: hex("2"),
        requiresApproval: true,
        admittedByActorId: "policy-gate"
      },
      { via: "policy_gate" }
    );
    const approval = fixture.store.grantExecutionPlanApproval(
      {
        workItemId: fixture.workItem.id,
        planHash: fixture.plan.planHash,
        actionHash: hex("3"),
        approvedByActorId: "human-approver"
      },
      { via: "domain_service" }
    );
    return { ...fixture, admission, approval };
  }

  it("consumes the granted approval in the same transaction that issues the lease", () => {
    const fixture = createApprovalRequiredFixture();
    directory = fixture.directory;
    const attempt = fixture.store.createAttempt(
      { workItemId: fixture.workItem.id, planHash: fixture.plan.planHash, inputHash: hex("a") },
      { via: "domain_service" }
    );

    expect(fixture.approval.status).toBe("granted");

    fixture.store.leaseAttempt(
      {
        attemptId: attempt.attemptId,
        workItemId: fixture.workItem.id,
        admissionId: fixture.admission.admissionId,
        approvalId: fixture.approval.approvalId,
        workerId: "worker-1",
        leaseToken: "a".repeat(32),
        policyVersion: "acs.policy.v2",
        policyDecisionHash: hex("2"),
        ttlMs: 60_000
      },
      { via: "domain_service" }
    );

    const dbAny = fixture.store as unknown as {
      db: { prepare: (sql: string) => { get: (...a: unknown[]) => { status: string } } };
    };
    const row = dbAny.db
      .prepare(`SELECT status FROM execution_plan_approvals WHERE approval_id = ?`)
      .get(fixture.approval.approvalId);
    expect(row.status).toBe("consumed");
  });

  it("refuses to lease a requires-approval attempt without an approval id at all", () => {
    const fixture = createApprovalRequiredFixture();
    directory = fixture.directory;
    const attempt = fixture.store.createAttempt(
      { workItemId: fixture.workItem.id, planHash: fixture.plan.planHash, inputHash: hex("a") },
      { via: "domain_service" }
    );

    expect(() =>
      fixture.store.leaseAttempt(
        {
          attemptId: attempt.attemptId,
          workItemId: fixture.workItem.id,
          admissionId: fixture.admission.admissionId,
          workerId: "worker-1",
          leaseToken: "a".repeat(32),
          policyVersion: "acs.policy.v2",
          policyDecisionHash: hex("2"),
          ttlMs: 60_000
        },
        { via: "domain_service" }
      )
    ).toThrow();
  });

  it("refuses to reuse an already-consumed approval for a second attempt (replay rejection)", () => {
    const fixture = createApprovalRequiredFixture();
    directory = fixture.directory;
    const firstAttempt = fixture.store.createAttempt(
      { workItemId: fixture.workItem.id, planHash: fixture.plan.planHash, inputHash: hex("a") },
      { via: "domain_service" }
    );
    fixture.store.leaseAttempt(
      {
        attemptId: firstAttempt.attemptId,
        workItemId: fixture.workItem.id,
        admissionId: fixture.admission.admissionId,
        approvalId: fixture.approval.approvalId,
        workerId: "worker-1",
        leaseToken: "a".repeat(32),
        policyVersion: "acs.policy.v2",
        policyDecisionHash: hex("2"),
        ttlMs: 60_000
      },
      { via: "domain_service" }
    );

    // Free the "one active attempt per work item" slot so a second attempt
    // can even be created, isolating the assertion to approval reuse.
    const dbAny = fixture.store as unknown as {
      db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } };
    };
    dbAny.db
      .prepare(
        `UPDATE execution_attempts SET status = 'cancelled', terminal_at = ?, outcome_code = ? WHERE attempt_id = ?`
      )
      .run(new Date().toISOString(), "cancelled", firstAttempt.attemptId);

    const secondAttempt = fixture.store.createAttempt(
      { workItemId: fixture.workItem.id, planHash: fixture.plan.planHash, inputHash: hex("b") },
      { via: "domain_service" }
    );

    expect(() =>
      fixture.store.leaseAttempt(
        {
          attemptId: secondAttempt.attemptId,
          workItemId: fixture.workItem.id,
          admissionId: fixture.admission.admissionId,
          approvalId: fixture.approval.approvalId,
          workerId: "worker-2",
          leaseToken: "b".repeat(32),
          policyVersion: "acs.policy.v2",
          policyDecisionHash: hex("2"),
          ttlMs: 60_000
        },
        { via: "domain_service" }
      )
    ).toThrow();
  });

  it("never lets an allow-classified admission attach an approval id that was not requested", () => {
    const fixture = createFixture();
    directory = fixture.directory;
    const attempt = fixture.store.createAttempt(
      { workItemId: fixture.workItem.id, planHash: fixture.plan.planHash, inputHash: hex("a") },
      { via: "domain_service" }
    );
    const strayApproval = fixture.store.grantExecutionPlanApproval(
      {
        workItemId: fixture.workItem.id,
        planHash: fixture.plan.planHash,
        actionHash: hex("9"),
        approvedByActorId: "human-approver"
      },
      { via: "domain_service" }
    );

    expect(() =>
      fixture.store.leaseAttempt(
        {
          attemptId: attempt.attemptId,
          workItemId: fixture.workItem.id,
          admissionId: fixture.admission.admissionId,
          approvalId: strayApproval.approvalId,
          workerId: "worker-1",
          leaseToken: "a".repeat(32),
          policyVersion: "acs.policy.v1",
          policyDecisionHash: hex("1"),
          ttlMs: 60_000
        },
        { via: "domain_service" }
      )
    ).toThrow();
  });

  it("binds and atomically consumes every required approval for a multi-action plan, not just the first", () => {
    const fixture = createApprovalRequiredFixture();
    directory = fixture.directory;
    const secondApproval = fixture.store.grantExecutionPlanApproval(
      {
        workItemId: fixture.workItem.id,
        planHash: fixture.plan.planHash,
        actionHash: hex("4"),
        approvedByActorId: "human-approver"
      },
      { via: "domain_service" }
    );
    const attempt = fixture.store.createAttempt(
      { workItemId: fixture.workItem.id, planHash: fixture.plan.planHash, inputHash: hex("a") },
      { via: "domain_service" }
    );

    const lease = fixture.store.leaseAttempt(
      {
        attemptId: attempt.attemptId,
        workItemId: fixture.workItem.id,
        admissionId: fixture.admission.admissionId,
        approvalId: fixture.approval.approvalId,
        additionalApprovals: [{ approvalId: secondApproval.approvalId, actionHash: secondApproval.actionHash }],
        workerId: "worker-1",
        leaseToken: "a".repeat(32),
        policyVersion: "acs.policy.v2",
        policyDecisionHash: hex("2"),
        ttlMs: 60_000
      },
      { via: "domain_service" }
    );

    expect(lease.additionalApprovalIds).toEqual([secondApproval.approvalId]);

    const dbAny = fixture.store as unknown as {
      db: { prepare: (sql: string) => { all: (...a: unknown[]) => Array<{ approval_id: string; status: string }> } };
    };
    const rows = dbAny.db
      .prepare(`SELECT approval_id, status FROM execution_plan_approvals WHERE work_item_id = ? ORDER BY approval_id`)
      .all(fixture.workItem.id);
    expect(rows).toHaveLength(2);
    // Both the first (single-column) approval and every additional approval
    // are consumed transactionally with lease issuance - none stay granted.
    for (const row of rows) {
      expect(row.status).toBe("consumed");
    }
  });

  it("rejects a lease that claims an additional approval for the wrong action hash", () => {
    const fixture = createApprovalRequiredFixture();
    directory = fixture.directory;
    const secondApproval = fixture.store.grantExecutionPlanApproval(
      {
        workItemId: fixture.workItem.id,
        planHash: fixture.plan.planHash,
        actionHash: hex("4"),
        approvedByActorId: "human-approver"
      },
      { via: "domain_service" }
    );
    const attempt = fixture.store.createAttempt(
      { workItemId: fixture.workItem.id, planHash: fixture.plan.planHash, inputHash: hex("a") },
      { via: "domain_service" }
    );

    expect(() =>
      fixture.store.leaseAttempt(
        {
          attemptId: attempt.attemptId,
          workItemId: fixture.workItem.id,
          admissionId: fixture.admission.admissionId,
          approvalId: fixture.approval.approvalId,
          // claims the second approval under an action hash it was never granted for
          additionalApprovals: [{ approvalId: secondApproval.approvalId, actionHash: hex("5") }],
          workerId: "worker-1",
          leaseToken: "a".repeat(32),
          policyVersion: "acs.policy.v2",
          policyDecisionHash: hex("2"),
          ttlMs: 60_000
        },
        { via: "domain_service" }
      )
    ).toThrow();

    const dbAny = fixture.store as unknown as {
      db: { prepare: (sql: string) => { get: (...a: unknown[]) => { status: string } } };
    };
    // The whole lease transaction rolled back - even the primary approval
    // stays granted, not partially consumed.
    const primary = dbAny.db
      .prepare(`SELECT status FROM execution_plan_approvals WHERE approval_id = ?`)
      .get(fixture.approval.approvalId);
    expect(primary.status).toBe("granted");
  });
});

describe("authoritative worker attempt lifecycle", () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  function claim() {
    const fixture = createFixture();
    directory = fixture.directory;
    fixture.store.approveWorkItem(fixture.workItem.id, { via: "domain_service" });
    const claimed = fixture.store.claimNextApprovedWorkItem("worker-1", {
      attemptAuthority: {
        planHash: fixture.plan.planHash,
        admissionId: fixture.admission.admissionId,
        policyVersion: fixture.admission.policyVersion,
        policyDecisionHash: fixture.admission.policyDecisionHash
      }
    });
    if (!claimed?.attemptId || !claimed.planHash || !claimed.inputHash || claimed.fencingEpoch === undefined) {
      throw new Error("expected authoritative claim");
    }
    return { ...fixture, claimed };
  }

  function resultInput(claimed: ReturnType<typeof claim>["claimed"]) {
    return {
      workItemId: claimed.id,
      attemptId: claimed.attemptId!,
      leaseId: claimed.leaseId,
      workerId: claimed.workerId,
      actionHash: claimed.actionHash,
      planHash: claimed.planHash!,
      inputHash: claimed.inputHash!,
      fencingEpoch: claimed.fencingEpoch!,
      idempotencyKey: stableHash({ domain: "acs.attempt-result.v1", attemptId: claimed.attemptId! }),
      outcome: "succeeded" as const,
      startedAt: claimed.startedAt,
      finishedAt: new Date(Date.parse(claimed.startedAt) + 10).toISOString(),
      exitCode: 0,
      summary: "authoritative dry-run result",
      structuredOutput: { simulated: true },
      artifacts: [],
      simulationMetadata: { executionMode: "dry_run" as const, simulated: true as const }
    };
  }

  it("creates exactly one running attempt with immutable claim bindings", () => {
    const fixture = claim();
    expect(fixture.claimed).toMatchObject({
      planHash: fixture.plan.planHash,
      fencingEpoch: 1,
      workspaceHash: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    expect(fixture.store.getAttempt(fixture.claimed.attemptId!)).toMatchObject({
      status: "running",
      currentFencingEpoch: 1,
      claimedByWorkerId: "worker-1",
      inputHash: fixture.claimed.inputHash
    });
    expect(fixture.store.claimNextApprovedWorkItem("worker-1")).toBeUndefined();
  });

  it("refuses a production claim that omits persisted attempt authority", () => {
    const fixture = createFixture();
    directory = fixture.directory;
    fixture.store.approveWorkItem(fixture.workItem.id, { via: "domain_service" });
    expect(() => fixture.store.claimNextApprovedWorkItem("worker-1")).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "attempt_authority_required" })
    );
    expect(fixture.store.get(fixture.workItem.id)?.status).toBe("approved");
  });

  it("rejects legacy fallback, stale fencing, plan tampering, and input tampering", () => {
    const fixture = claim();
    const input = resultInput(fixture.claimed);
    const legacy: Partial<typeof input> = { ...input };
    delete legacy.attemptId;
    delete legacy.planHash;
    delete legacy.inputHash;
    delete legacy.fencingEpoch;

    expect(() => fixture.store.submitWorkResult(legacy)).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "attempt_binding_required" })
    );
    expect(() => fixture.store.submitWorkResult({ ...input, fencingEpoch: input.fencingEpoch + 1 })).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "attempt_fence_mismatch" })
    );
    expect(() => fixture.store.submitWorkResult({ ...input, planHash: hex("f") })).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "attempt_plan_mismatch" })
    );
    expect(() => fixture.store.submitWorkResult({ ...input, inputHash: hex("e") })).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "attempt_input_mismatch" })
    );
    expect(() => fixture.store.submitWorkResult({ ...input, idempotencyKey: hex("d") })).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "attempt_idempotency_mismatch" })
    );
    expect(fixture.store.get(fixture.workItem.id)?.status).toBe("running");
  });

  it("accepts one result, closes both leases, and replays without another audit event", () => {
    const fixture = claim();
    const input = resultInput(fixture.claimed);
    const accepted = fixture.store.submitWorkResult(input);
    const eventCount = fixture.store.readEvents().length;
    expect(fixture.store.submitWorkResult(input)).toEqual(accepted);
    expect(fixture.store.readEvents()).toHaveLength(eventCount);
    expect(fixture.store.getAttempt(input.attemptId)?.status).toBe("succeeded");

    const dbAny = fixture.store as unknown as {
      db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } };
    };
    expect(dbAny.db.prepare(`SELECT status FROM attempt_leases`).get()).toEqual({ status: "consumed" });
    expect(dbAny.db.prepare(`SELECT status FROM leases`).get()).toEqual({ status: "consumed" });
    expect(dbAny.db.prepare(`SELECT COUNT(*) AS count FROM attempt_results`).get()).toEqual({ count: 1 });
    expect(fixture.store.readEvents().map((event) => event.name)).toContain("execution_attempt.result_accepted");
  });

  it("rolls back every attempt and compatibility mutation when terminal fencing fails", () => {
    const fixture = claim();
    const dbAny = fixture.store as unknown as {
      db: {
        exec: (sql: string) => void;
        prepare: (sql: string) => { get: (...args: unknown[]) => unknown };
      };
    };
    dbAny.db.exec(`
      CREATE TRIGGER fail_authoritative_attempt_terminal
      BEFORE UPDATE ON execution_attempts
      WHEN NEW.status IN ('succeeded', 'failed', 'cancelled')
      BEGIN
        SELECT RAISE(ABORT, 'attempt terminal failure');
      END;
    `);
    expect(() => fixture.store.submitWorkResult(resultInput(fixture.claimed))).toThrow("attempt terminal failure");
    expect(fixture.store.get(fixture.workItem.id)?.status).toBe("running");
    expect(dbAny.db.prepare(`SELECT COUNT(*) AS count FROM attempt_results`).get()).toEqual({ count: 0 });
    expect(dbAny.db.prepare(`SELECT COUNT(*) AS count FROM execution_results`).get()).toEqual({ count: 0 });
    expect(dbAny.db.prepare(`SELECT status FROM attempt_leases`).get()).toEqual({ status: "active" });
  });

  it("expires a crashed attempt with both lease projections in one transaction", () => {
    const fixture = createFixture();
    directory = fixture.directory;
    fixture.store.approveWorkItem(fixture.workItem.id, { via: "domain_service" });
    const claimed = fixture.store.claimNextApprovedWorkItem("worker-1", {
      leaseMs: 1,
      attemptAuthority: {
        planHash: fixture.plan.planHash,
        admissionId: fixture.admission.admissionId,
        policyVersion: fixture.admission.policyVersion,
        policyDecisionHash: fixture.admission.policyDecisionHash
      }
    });
    if (!claimed?.attemptId) throw new Error("expected authoritative claim");
    expect(fixture.store.failExpiredLeases(new Date(Date.parse(claimed.leaseExpiresAt) + 1))).toHaveLength(1);
    expect(fixture.store.getAttempt(claimed.attemptId)?.status).toBe("unknown");
    expect(fixture.store.get(fixture.workItem.id)?.status).toBe("failed");
  });
});

describe("transitionAttempt", () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("transitions a leased attempt to running with the matching worker fence", () => {
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

    const transitioned = fixture.store.transitionAttempt(
      {
        attemptId: attempt.attemptId,
        workItemId: fixture.workItem.id,
        workerId: "worker-1",
        fencingEpoch: lease.fencingEpoch,
        status: "running"
      },
      { via: "domain_service" }
    );

    expect(transitioned.status).toBe("running");
    expect(transitioned.claimedByWorkerId).toBe("worker-1");
    expect(fixture.store.readEvents().map((event) => event.name)).toContain("execution_attempt.transitioned");
  });

  it("rejects a stale fencing transition without mutating the attempt", () => {
    const fixture = createFixture();
    directory = fixture.directory;
    const attempt = fixture.store.createAttempt(
      { workItemId: fixture.workItem.id, planHash: fixture.plan.planHash, inputHash: hex("a") },
      { via: "domain_service" }
    );
    fixture.store.leaseAttempt(
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

    expect(() => fixture.store.transitionAttempt(
      {
        attemptId: attempt.attemptId,
        workItemId: fixture.workItem.id,
        workerId: "stale-worker",
        fencingEpoch: 1,
        status: "running"
      },
      { via: "domain_service" }
    )).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "attempt_transition_fence_stale" }));
    expect(fixture.store.getAttempt(attempt.attemptId)?.status).toBe("leased");
  });

  it("rejects a transition once the lease has expired, even though the worker id and fencing epoch still match and no one has yet marked the lease expired", () => {
    const fixture = createFixture();
    directory = fixture.directory;
    const attempt = fixture.store.createAttempt(
      { workItemId: fixture.workItem.id, planHash: fixture.plan.planHash, inputHash: hex("a") },
      { via: "domain_service" }
    );
    const issuedAt = new Date("2026-01-01T00:00:00.000Z");
    const lease = fixture.store.leaseAttempt(
      {
        attemptId: attempt.attemptId,
        workItemId: fixture.workItem.id,
        admissionId: fixture.admission.admissionId,
        workerId: "worker-1",
        leaseToken: "a".repeat(32),
        policyVersion: "acs.policy.v1",
        policyDecisionHash: hex("1"),
        ttlMs: 60_000,
        now: issuedAt
      },
      { via: "domain_service" }
    );

    // The lease row is still "active" in storage (failExpiredLeases has not run),
    // and the worker id + fencing epoch copied onto the attempt row still match
    // exactly what the stale worker presents. Only the authoritative lease's
    // expiry has actually passed.
    const afterExpiry = new Date(issuedAt.getTime() + 60_001);
    expect(() =>
      fixture.store.transitionAttempt(
        {
          attemptId: attempt.attemptId,
          workItemId: fixture.workItem.id,
          workerId: "worker-1",
          fencingEpoch: lease.fencingEpoch,
          status: "succeeded",
          now: afterExpiry
        },
        { via: "domain_service" }
      )
    ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "attempt_transition_fence_stale" }));
    expect(fixture.store.getAttempt(attempt.attemptId)?.status).toBe("leased");

    // A transition before expiry, with the exact same identifiers, succeeds -
    // proving the rejection above is specifically about lease expiry.
    const beforeExpiry = new Date(issuedAt.getTime() + 1_000);
    const transitioned = fixture.store.transitionAttempt(
      {
        attemptId: attempt.attemptId,
        workItemId: fixture.workItem.id,
        workerId: "worker-1",
        fencingEpoch: lease.fencingEpoch,
        status: "running",
        now: beforeExpiry
      },
      { via: "domain_service" }
    );
    expect(transitioned.status).toBe("running");
  });

  it("rejects a transition once the attempt's active lease has been marked expired by failExpiredLeases, even if the caller still presents the matching worker id and fencing epoch", () => {
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

    // Directly simulate a reaper marking the underlying attempt lease
    // expired (mirrors failExpiredLeases's effect on attempt_leases) without
    // touching execution_attempts.claimed_by_worker_id/current_fencing_epoch,
    // reproducing the exact scenario the finding describes: the copied
    // authority fields on the attempt row are untouched, only the lease
    // itself has lost authority.
    const db = (fixture.store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db;
    db.prepare(`UPDATE attempt_leases SET status = 'expired', closed_at = ? WHERE lease_id = ?`).run(
      new Date().toISOString(),
      lease.leaseId
    );

    expect(() =>
      fixture.store.transitionAttempt(
        {
          attemptId: attempt.attemptId,
          workItemId: fixture.workItem.id,
          workerId: "worker-1",
          fencingEpoch: lease.fencingEpoch,
          status: "succeeded"
        },
        { via: "domain_service" }
      )
    ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "attempt_transition_fence_stale" }));
    expect(fixture.store.getAttempt(attempt.attemptId)?.status).toBe("leased");
  });
});
