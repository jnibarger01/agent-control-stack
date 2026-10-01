import { describe, expect, it, vi } from "vitest";
import {
  EngineAdapterRegistry,
  type EngineAdapter,
  type EngineOutcome,
  type EngineTask
} from "@agent-control-stack/engine-adapter";
import type {
  ActorReliability,
  ActorRoutingDecision as PersistedActorRoutingDecision,
  ActorRoutingShadowObservation,
  RecordActorRoutingDecisionInput,
  RecordActorRoutingShadowObservationInput,
  RegistryAgentDetail,
  WorkItem
} from "@agent-control-stack/work-items";
import type { ResultValidator } from "@agent-control-stack/result-validation";
import type { Workspace } from "@agent-control-stack/workspace-manager";
import {
  RoutedExecutionController,
  executionControllerRoutingIdempotencyKey,
  type RoutedExecutionControllerStore
} from "./index.js";

const planHash = "a".repeat(64);
const inputHash = "b".repeat(64);

const workItem: WorkItem = {
  id: "work-route-1",
  title: "Implement routing",
  requester: "user",
  requesterSubject: "actor-user",
  intent: "implement the approved repository change",
  target: { cwd: "/repo" },
  requestedActions: [
    { kind: "fs.write", description: "modify source", params: { paths: ["src/index.ts"], write: true } }
  ],
  risk: "low",
  status: "approved",
  createdAt: "2026-09-29T20:00:00.000Z",
  updatedAt: "2026-09-29T20:00:00.000Z"
};

function agent(id: string): RegistryAgentDetail {
  return {
    id,
    name: id,
    kind: "coding",
    acpRole: "IMPLEMENTATION_AGENT",
    status: "AVAILABLE",
    lastHeartbeatAt: "2026-09-29T20:00:00.000Z",
    createdAt: "2026-09-29T19:00:00.000Z",
    updatedAt: "2026-09-29T20:00:00.000Z",
    createdByActorId: "system",
    updatedByActorId: "system",
    capabilities: []
  };
}

function fixture(agents: RegistryAgentDetail[]) {
  const routeInputs: RecordActorRoutingDecisionInput[] = [];
  const shadowInputs: RecordActorRoutingShadowObservationInput[] = [];
  const attempt = {
    attemptId: "attempt-route-1",
    workItemId: workItem.id,
    planId: "plan-route-1",
    planHash,
    attemptNumber: 1,
    protocolVersion: "acs.worker.v2" as const,
    inputHash,
    status: "pending" as const,
    currentFencingEpoch: 0,
    createdAt: "2026-09-29T20:00:00.000Z",
    updatedAt: "2026-09-29T20:00:00.000Z"
  };
  const lease = {
    leaseId: "lease-route-1",
    attemptId: attempt.attemptId,
    workItemId: workItem.id,
    admissionId: "admission-route-1",
    workerId: "worker-route-1",
    tokenHash: "c".repeat(64),
    planHash,
    inputHash,
    fencingEpoch: 1,
    protocolVersion: "acs.worker.v2" as const,
    policyVersion: "acs.policy.v1",
    policyDecisionHash: "d".repeat(64),
    issuedAt: "2026-09-29T20:00:00.000Z",
    expiresAt: "2099-09-29T20:00:00.000Z",
    maxExpiresAt: "2099-09-29T20:00:00.000Z",
    lastRenewedAt: "2026-09-29T20:00:00.000Z",
    status: "active" as const
  };
  const store = {
    get: vi.fn((id: string) => (id === workItem.id ? workItem : undefined)),
    listRegistryAgents: vi.fn(() => agents),
    getActorReliability: vi.fn((_id: string): ActorReliability | undefined => undefined),
    recordActorRoutingDecision: vi.fn((input: RecordActorRoutingDecisionInput): PersistedActorRoutingDecision => {
      routeInputs.push(input);
      return {
        decisionId: "routing-route-1",
        workItemId: input.workItemId,
        ...(input.attemptId ? { attemptId: input.attemptId } : {}),
        ...(input.selectedActorId ? { selectedActorId: input.selectedActorId } : {}),
        eligible: input.eligible,
        excluded: input.excluded,
        scores: input.scores,
        idempotencyKey: input.idempotencyKey,
        createdAt: "2026-09-29T20:00:00.000Z"
      };
    }),
    recordActorRoutingShadowObservation: vi.fn(
      (input: RecordActorRoutingShadowObservationInput): ActorRoutingShadowObservation => {
        shadowInputs.push(input);
        return { ...input, createdAt: "2026-09-29T20:00:00.000Z" };
      }
    ),
    getCurrentExecutionPlan: vi.fn(() => ({
      planId: "plan-route-1",
      workItemId: workItem.id,
      planHash,
      definition: {
        steps: [
          {
            stepId: "step-001",
            sequence: 1,
            action: {
              kind: "fs.write",
              description: "modify source",
              params: { paths: ["src/index.ts"], write: true }
            }
          }
        ]
      }
    })),
    getExecutionPlanAdmission: vi.fn(() => ({
      admissionId: "admission-route-1",
      workItemId: workItem.id,
      planId: "plan-route-1",
      planHash,
      policyVersion: "acs.policy.v1",
      policyDecisionHash: lease.policyDecisionHash,
      requiresApproval: false
    })),
    getExecutionPlanApproval: vi.fn(() => undefined),
    createAttempt: vi.fn(() => attempt),
    leaseAttempt: vi.fn(() => lease),
    transitionAttempt: vi.fn((transition) => ({ ...attempt, ...transition })),
    recordValidationRun: vi.fn(),
    getAttempt: vi.fn(() => attempt)
  } as unknown as RoutedExecutionControllerStore;

  const workspace: Workspace = {
    allocationId: "workspace-route-1",
    workItemId: workItem.id,
    attemptId: attempt.attemptId,
    leaseId: lease.leaseId,
    workerId: lease.workerId,
    fencingEpoch: lease.fencingEpoch,
    hostPath: "/tmp/acs-route-workspace",
    branch: "acs/attempt/attempt-route-1",
    baseRef: "HEAD",
    createdAt: "2026-09-29T20:00:00.000Z"
  };

  return { store, routeInputs, shadowInputs, attempt, lease, workspace };
}

const completed: EngineOutcome = {
  status: "completed",
  exitCode: 0,
  stdout: "ok",
  stderr: "",
  durationMs: 1,
  stdoutTruncated: false,
  stderrTruncated: false
};

describe("RoutedExecutionController", () => {
  it("uses the deterministic actor route to select the registered engine adapter", async () => {
    const f = fixture([agent("actor-b"), agent("actor-a")]);
    const engineA: EngineAdapter = {
      id: "engine-a",
      invoke: vi.fn(async (_task: EngineTask) => completed)
    };
    const engineB: EngineAdapter = {
      id: "engine-b",
      invoke: vi.fn(async (_task: EngineTask) => completed)
    };
    const registry = new EngineAdapterRegistry([engineA, engineB]);
    const controller = new RoutedExecutionController({
      store: f.store,
      engineRegistry: registry,
      routing: {
        requiredCapabilities: [],
        requiredRole: "IMPLEMENTATION_AGENT",
        actorToEngineAdapterId: { "actor-a": "engine-a", "actor-b": "engine-b" },
        jevShadow: { enabled: false }
      },
      workspaceManager: { provision: vi.fn(async () => f.workspace) },
      validator: {
        validate: vi.fn(async () => ({ passed: true, changedPaths: [], checks: [] }))
      } as unknown as ResultValidator,
      buildValidationInput: ({ outcome, workspace }) => ({ workspacePath: workspace.hostPath, outcome }),
      input: {
        workerId: f.lease.workerId,
        leaseToken: "route-controller-lease-token",
        admissionId: f.lease.admissionId,
        inputHash,
        buildTask: ({ attempt, lease, workspace }) => ({
          workItemId: workItem.id,
          attemptId: attempt.attemptId,
          leaseId: lease.leaseId,
          workerId: lease.workerId,
          fencingToken: lease.fencingEpoch,
          authorization: { kind: "plan", hash: planHash },
          policyVersion: lease.policyVersion,
          auditCorrelationId: "audit-route-1",
          idempotencyKey: "execute-route-1",
          workspace: { allocationId: workspace.allocationId, hostPath: workspace.hostPath },
          prompt: "implement",
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
      },
      now: () => new Date("2026-09-29T20:01:00.000Z")
    });

    const result = await controller.execute(workItem.id);

    expect(result.routing).toMatchObject({
      decisionId: "routing-route-1",
      actorId: "actor-a",
      engineId: "engine-a"
    });
    expect(engineA.invoke).toHaveBeenCalledTimes(1);
    expect(engineB.invoke).not.toHaveBeenCalled();
    expect(f.routeInputs[0]).toMatchObject({
      workItemId: workItem.id,
      selectedActorId: "actor-a",
      eligible: ["actor-a", "actor-b"]
    });
  });

  it("excludes actors without a registered engine adapter and fails before attempt creation when none remain", async () => {
    const f = fixture([agent("actor-unbound")]);
    const controller = new RoutedExecutionController({
      store: f.store,
      engineRegistry: new EngineAdapterRegistry(),
      routing: {
        requiredCapabilities: [],
        actorToEngineAdapterId: { "actor-unbound": "missing-engine" },
        jevShadow: { enabled: false }
      },
      workspaceManager: { provision: vi.fn(async () => f.workspace) },
      validator: { validate: vi.fn() } as unknown as ResultValidator,
      buildValidationInput: () => {
        throw new Error("must not validate");
      },
      input: {
        workerId: f.lease.workerId,
        leaseToken: "route-controller-lease-token",
        admissionId: f.lease.admissionId,
        inputHash,
        buildTask: () => {
          throw new Error("must not build task");
        }
      },
      now: () => new Date("2026-09-29T20:01:00.000Z")
    });

    await expect(controller.execute(workItem.id)).rejects.toThrow("no eligible execution actor");
    expect(f.store.createAttempt).not.toHaveBeenCalled();
    expect(f.routeInputs[0]?.eligible).toEqual([]);
    expect(f.routeInputs[0]?.excluded["actor-unbound"]).toContain("policy ineligible");
  });

  it("binds routing idempotency to both work item and current plan", () => {
    expect(executionControllerRoutingIdempotencyKey("work-a", "a".repeat(64))).toHaveLength(64);
    expect(executionControllerRoutingIdempotencyKey("work-a", "a".repeat(64))).not.toBe(
      executionControllerRoutingIdempotencyKey("work-a", "b".repeat(64))
    );
  });
});
