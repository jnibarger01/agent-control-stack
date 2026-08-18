import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineAdapter, EngineOutcome, EngineTask } from "@agent-control-stack/engine-adapter";
import { defaultExecutionPlanForWorkItem, SqliteWorkItemStore } from "@agent-control-stack/work-items";
import type { Workspace } from "@agent-control-stack/workspace-manager";
import type { ResultValidator } from "@agent-control-stack/result-validation";
import { ExecutionController, type ExecutionControllerStore } from "./index.js";

const attempt = {
  attemptId: "attempt-1",
  workItemId: "work-1",
  planId: "plan-1",
  planHash: "a".repeat(64),
  attemptNumber: 1,
  protocolVersion: "acs.worker.v2" as const,
  inputHash: "b".repeat(64),
  status: "pending" as const,
  currentFencingEpoch: 0,
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z"
};
const lease = {
  leaseId: "lease-1",
  attemptId: "attempt-1",
  workItemId: "work-1",
  admissionId: "admission-1",
  workerId: "worker-1",
  tokenHash: "c".repeat(64),
  planHash: "a".repeat(64),
  inputHash: "b".repeat(64),
  fencingEpoch: 1,
  protocolVersion: "acs.worker.v2" as const,
  policyVersion: "policy-1",
  policyDecisionHash: "d".repeat(64),
  issuedAt: "2026-08-18T00:00:00.000Z",
  expiresAt: "2099-08-18T00:00:00.000Z",
  maxExpiresAt: "2099-08-18T00:00:00.000Z",
  lastRenewedAt: "2026-08-18T00:00:00.000Z",
  status: "active" as const
};
const workspace: Workspace = {
  allocationId: "workspace-1",
  workItemId: "work-1",
  attemptId: "attempt-1",
  leaseId: "lease-1",
  workerId: "worker-1",
  fencingEpoch: 1,
  hostPath: "/tmp/acs-workspace-1",
  branch: "acs/attempt/attempt-1",
  baseRef: "HEAD",
  createdAt: "2026-08-18T00:00:00.000Z"
};

function makeStore(): ExecutionControllerStore {
  return {
    getCurrentExecutionPlan: vi.fn(() => ({ planId: "plan-1", planHash: attempt.planHash })),
    getExecutionPlanAdmission: vi.fn(() => ({
      admissionId: "admission-1",
      policyVersion: "policy-1",
      policyDecisionHash: lease.policyDecisionHash,
      requiresApproval: false
    })),
    createAttempt: vi.fn(() => attempt),
    leaseAttempt: vi.fn(() => lease),
    transitionAttempt: vi.fn((input) => ({ ...attempt, ...input })),
    recordValidationRun: vi.fn(),
    getAttempt: vi.fn(() => attempt)
  } as unknown as ExecutionControllerStore;
}

const outcome: EngineOutcome = {
  status: "completed",
  exitCode: 0,
  stdout: "agent output",
  stderr: "",
  durationMs: 10,
  stdoutTruncated: false,
  stderrTruncated: false
};

const engine: EngineAdapter = { id: "codex", invoke: vi.fn(async (_task: EngineTask) => outcome) };

describe("ExecutionController", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates and leases an attempt, provisions an owned workspace, and invokes the engine with the exact fence", async () => {
    const store = makeStore();
    const workspaceManager = { provision: vi.fn(async () => workspace) };
    const validator = { validate: vi.fn(async () => ({ passed: true, changedPaths: [], checks: [] })) } as unknown as ResultValidator;
    const controller = new ExecutionController({
      store,
      workspaceManager,
      engine,
      validator,
      buildValidationInput: ({ outcome: engineOutcome, workspace: ownedWorkspace }) => ({ workspacePath: ownedWorkspace.hostPath, outcome: engineOutcome }),
      input: {
        leaseToken: "lease-token-which-is-long-enough",
        admissionId: "admission-1",
        workerId: "worker-1",
        inputHash: "b".repeat(64),
        buildTask: ({ workspace: ownedWorkspace }) => ({
        workItemId: "work-1",
        attemptId: "attempt-1",
        leaseId: "lease-1",
        workerId: "worker-1",
        fencingToken: 1,
        authorization: { kind: "plan", hash: attempt.planHash },
        policyVersion: "policy-1",
        auditCorrelationId: "audit-1",
        idempotencyKey: "idempotency-1",
        workspace: { allocationId: ownedWorkspace.allocationId, hostPath: ownedWorkspace.hostPath },
        prompt: "Implement the approved task",
        egressAllowlist: [],
        limits: {
          wallClockMs: 60_000,
          terminationGraceMs: 100,
          cpuQuotaPercent: 100,
          memoryBytes: 64 * 1024 * 1024,
          pids: 16,
          outputBytes: 100_000,
          tmpfsBytes: 16 * 1024 * 1024
        }
        })
      }
    });

    const result = await controller.execute("work-1");

    expect(result.outcome).toEqual(outcome);
    expect(workspaceManager.provision).toHaveBeenCalledWith("work-1", {
      attemptId: "attempt-1",
      leaseId: "lease-1",
      workerId: "worker-1",
      fencingEpoch: 1
    });
    expect(engine.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: "attempt-1",
        leaseId: "lease-1",
        fencingToken: 1,
        workspace: { allocationId: "workspace-1", hostPath: "/tmp/acs-workspace-1" }
      }),
      expect.any(AbortSignal)
    );
    expect(validator.validate).toHaveBeenCalledTimes(1);
    expect(result.validation?.passed).toBe(true);
  });

  it("fails closed and never invokes the engine or validator when workspace provisioning fails", async () => {
    const store = makeStore();
    const validate = vi.fn(async () => { throw new Error("validator must not run when workspace provisioning fails"); });
    const controller = new ExecutionController({
      store,
      workspaceManager: { provision: vi.fn(async () => { throw new Error("workspace authority unavailable"); }) },
      engine,
      validator: { validate } as unknown as ResultValidator,
      buildValidationInput: () => { throw new Error("must not build a validation input"); },
      input: {
        leaseToken: "lease-token-which-is-long-enough",
        admissionId: "admission-1",
        workerId: "worker-1",
        inputHash: "b".repeat(64),
        buildTask: () => { throw new Error("must not build a task"); }
      }
    });

    await expect(controller.execute("work-1")).rejects.toThrow("workspace authority unavailable");
    expect(engine.invoke).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
  });

  it("runs against the authoritative SQLite attempt and lease store", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-controller-"));
    const store = new SqliteWorkItemStore(join(directory, "control.db"));
    try {
      const workItem = store.create({
        title: "controller fixture",
        requester: "user",
        requesterSubject: "actor-user",
        intent: "execute an approved repository task",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["README.md"], write: false } }],
        risk: "low"
      });
      const plan = store.createExecutionPlan({
        workItemId: workItem.id,
        definition: defaultExecutionPlanForWorkItem(workItem),
        createdByActorId: "actor-user"
      });
      const admission = store.admitExecutionPlan({
        workItemId: workItem.id,
        planHash: plan.planHash,
        policyVersion: "acs.policy.v1",
        policyDecisionHash: "e".repeat(64),
        requiresApproval: false,
        admittedByActorId: "policy-gate"
      }, { via: "policy_gate" });
      const actualEngine: EngineAdapter = { id: "codex", invoke: vi.fn(async () => outcome) };
      const actualWorkspaceManager = {
        provision: vi.fn(async (_id: string, options: { attemptId?: string; leaseId?: string; workerId?: string; fencingEpoch?: number }) => {
          if (!options.attemptId || !options.leaseId || !options.workerId || options.fencingEpoch === undefined) {
            throw new Error("missing workspace authority");
          }
          store.recordWorkspaceAllocation({
            allocationId: "workspace-actual",
            workItemId: workItem.id,
            attemptId: options.attemptId,
            leaseId: options.leaseId,
            workerId: options.workerId,
            fencingEpoch: options.fencingEpoch,
            hostPath: "/tmp/acs-controller-workspace",
            branch: `acs/attempt/${options.attemptId}`,
            baseRef: "HEAD"
          }, { via: "domain_service", actorId: options.workerId });
          return { ...workspace, allocationId: "workspace-actual", attemptId: options.attemptId, leaseId: options.leaseId, workerId: options.workerId, fencingEpoch: options.fencingEpoch };
        })
      };
      const validator = { validate: vi.fn(async () => ({ passed: true, changedPaths: [], checks: [] })) } as unknown as ResultValidator;
      const controller = new ExecutionController({
        store,
        workspaceManager: actualWorkspaceManager,
        engine: actualEngine,
        validator,
        buildValidationInput: ({ outcome: engineOutcome, workspace: ownedWorkspace }) => ({ workspacePath: ownedWorkspace.hostPath, outcome: engineOutcome }),
        input: {
          workerId: "worker-actual",
          leaseToken: "actual-lease-token-long-enough",
          admissionId: admission.admissionId,
          inputHash: "f".repeat(64),
          buildTask: ({ attempt: running, lease: actualLease, workspace: actualWorkspace }) => ({
            workItemId: workItem.id,
            attemptId: running.attemptId,
            leaseId: actualLease.leaseId,
            workerId: "worker-actual",
            fencingToken: actualLease.fencingEpoch,
            authorization: { kind: "plan", hash: plan.planHash },
            policyVersion: admission.policyVersion,
            auditCorrelationId: "audit-actual",
            idempotencyKey: "idempotency-actual",
            workspace: { allocationId: actualWorkspace.allocationId, hostPath: actualWorkspace.hostPath },
            prompt: "approved task",
            egressAllowlist: [],
            limits: { wallClockMs: 60_000, terminationGraceMs: 100, cpuQuotaPercent: 100, memoryBytes: 64 * 1024 * 1024, pids: 16, outputBytes: 100_000, tmpfsBytes: 16 * 1024 * 1024 }
          })
        }
      });

      const result = await controller.execute(workItem.id);

      expect(result.outcome).toEqual(outcome);
      // A completed engine run must never leave the attempt dangling in
      // "running" - independent validation is mandatory, so a passing
      // validation must reach the terminal "succeeded" status here.
      expect(result.validation?.passed).toBe(true);
      expect(store.getAttempt(result.attempt.attemptId)?.status).toBe("succeeded");
      expect(store.getActiveWorkspaceAllocationForAttempt(result.attempt.attemptId)?.status).toBe("active");
      expect(store.readEvents().map((event) => event.name)).toEqual(expect.arrayContaining([
        "execution_attempt.created",
        "attempt_lease.issued",
        "execution_attempt.transitioned"
      ]));
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not accept engine success when independent validation fails", async () => {
    const store = makeStore();
    const recordValidationRun = vi.fn();
    (store as unknown as { recordValidationRun: typeof recordValidationRun }).recordValidationRun = recordValidationRun;
    const transitionAttempt = store.transitionAttempt as unknown as ReturnType<typeof vi.fn>;
    const validator = { validate: vi.fn(async () => ({ passed: false, changedPaths: [".env"], checks: [{ name: "forbidden_paths", passed: false, detail: "forbidden path" }] })) } as unknown as ResultValidator;
    const controller = new ExecutionController({
      store,
      workspaceManager: { provision: vi.fn(async () => workspace) },
      engine,
      validator,
      buildValidationInput: ({ outcome: engineOutcome, workspace: ownedWorkspace }) => ({ workspacePath: ownedWorkspace.hostPath, outcome: engineOutcome }),
      input: {
        workerId: "worker-1",
        leaseToken: "lease-token-which-is-long-enough",
        admissionId: "admission-1",
        inputHash: "b".repeat(64),
        buildTask: () => ({
          workItemId: "work-1", attemptId: "attempt-1", leaseId: "lease-1", workerId: "worker-1", fencingToken: 1,
          authorization: { kind: "plan", hash: attempt.planHash }, policyVersion: "policy-1", auditCorrelationId: "audit-1", idempotencyKey: "idempotency-1",
          workspace: { allocationId: workspace.allocationId, hostPath: workspace.hostPath }, prompt: "work", egressAllowlist: [{ host: "api.openai.com", port: 443 }],
          limits: { wallClockMs: 60_000, terminationGraceMs: 100, cpuQuotaPercent: 100, memoryBytes: 64 * 1024 * 1024, pids: 16, outputBytes: 100_000, tmpfsBytes: 16 * 1024 * 1024 }
        })
      }
    });

    const result = await controller.execute("work-1");

    expect(result.validation?.passed).toBe(false);
    expect(recordValidationRun).toHaveBeenCalledWith(expect.objectContaining({ passed: false }), expect.any(Object));
    expect(transitionAttempt).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", outcomeCode: "validation_failed" }), expect.any(Object));
  });

  it("never leaves a completed attempt dangling in \"running\" - validation always resolves it to a terminal status", async () => {
    const store = makeStore();
    const transitionAttempt = store.transitionAttempt as unknown as ReturnType<typeof vi.fn>;
    const validator = { validate: vi.fn(async () => ({ passed: true, changedPaths: [], checks: [] })) } as unknown as ResultValidator;
    const controller = new ExecutionController({
      store,
      workspaceManager: { provision: vi.fn(async () => workspace) },
      engine,
      validator,
      buildValidationInput: ({ outcome: engineOutcome, workspace: ownedWorkspace }) => ({ workspacePath: ownedWorkspace.hostPath, outcome: engineOutcome }),
      input: {
        workerId: "worker-1",
        leaseToken: "lease-token-which-is-long-enough",
        admissionId: "admission-1",
        inputHash: "b".repeat(64),
        buildTask: () => ({
          workItemId: "work-1", attemptId: "attempt-1", leaseId: "lease-1", workerId: "worker-1", fencingToken: 1,
          authorization: { kind: "plan", hash: attempt.planHash }, policyVersion: "policy-1", auditCorrelationId: "audit-1", idempotencyKey: "idempotency-1",
          workspace: { allocationId: workspace.allocationId, hostPath: workspace.hostPath }, prompt: "work", egressAllowlist: [{ host: "api.openai.com", port: 443 }],
          limits: { wallClockMs: 60_000, terminationGraceMs: 100, cpuQuotaPercent: 100, memoryBytes: 64 * 1024 * 1024, pids: 16, outputBytes: 100_000, tmpfsBytes: 16 * 1024 * 1024 }
        })
      }
    });

    await controller.execute("work-1");

    expect(validator.validate).toHaveBeenCalledTimes(1);
    const terminalCalls = transitionAttempt.mock.calls.filter(([input]) => input.status !== "running");
    expect(terminalCalls).toHaveLength(1);
    expect(terminalCalls[0]?.[0]).toEqual(expect.objectContaining({ status: "succeeded", outcomeCode: "validated" }));
  });
});
