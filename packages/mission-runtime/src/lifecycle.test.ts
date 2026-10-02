import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EXECUTION_ADMISSION_CONFIG,
  ExecutionAdmissionScheduler
} from "@agent-control-stack/execution-admission";
import { ControlStackError } from "@agent-control-stack/shared";
import type { RegistryAgentDetail } from "@agent-control-stack/work-items";
import { assertMissionTransition, assertReadyToComplete, MissionRuntime } from "./index.js";
import type { CreateMissionInput, DispatchRequest, OperationExecutor } from "./index.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function agent(id: string, capability: string, now: string): RegistryAgentDetail {
  return {
    id,
    name: id,
    kind: "coding",
    acpRole: "IMPLEMENTATION_AGENT",
    status: "AVAILABLE",
    createdAt: now,
    updatedAt: now,
    createdByActorId: "system",
    updatedByActorId: "system",
    lastHeartbeatAt: now,
    capabilities: [
      {
        id: `${id}-cap`,
        agentId: id,
        name: capability,
        createdAt: now,
        updatedAt: now,
        createdByActorId: "system",
        updatedByActorId: "system"
      }
    ]
  };
}

interface WorldOptions {
  clock?: () => Date;
  leaseTtlMs?: number;
  onStage?: (stage: string) => void;
  admission?: ExecutionAdmissionScheduler;
  workerId?: string;
  agents?: RegistryAgentDetail[];
  unknown?: boolean;
  recordBeforeUnknown?: boolean;
  fatal?: boolean;
  verificationObserved?: string;
  apply?: "ok" | "diverged" | "throw-after-record";
  deploy?: "healthy" | "exit-without-health" | "down";
  productionObserved?: string;
}

function world(options: WorldOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "acs-mission-"));
  directories.push(directory);
  const dbPath = join(directory, "control.db");
  const now = new Date().toISOString();
  const calls: DispatchRequest[] = [];
  const started = new Map<string, { payload: Record<string, unknown>; observations: Record<string, string> }>();
  let inflight = 0;
  let maxInflight = 0;
  let applyCalls = 0;
  let deployCalls = 0;
  const applied = new Map<string, string>();
  const executor: OperationExecutor = {
    async dispatch(request: DispatchRequest) {
      calls.push(request);
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inflight -= 1;
      const payload = { ok: true, artifactHashes: ["a".repeat(64)] };
      const observations = {
        command_exit: options.verificationObserved ?? "0",
        unit_tests: options.verificationObserved === "1" ? "fail" : "pass"
      };
      if (options.unknown) {
        if (options.recordBeforeUnknown !== false) started.set(request.executionId, { payload, observations });
        return { kind: "unknown" as const, reason: "transport timeout" };
      }
      if (options.fatal) return { kind: "fatal_failure" as const, reason: "compiler exploded" };
      started.set(request.executionId, { payload, observations });
      return { kind: "result" as const, payload, observations };
    }
  };
  const reconciler = {
    async inspect(executionId: string) {
      const found = started.get(executionId);
      if (!found) return { kind: "not_started" as const };
      return { kind: "completed" as const, payload: found.payload, observations: found.observations };
    }
  };
  const applier = {
    async apply(input: { idempotencyKey: string; expectedBaseRevision: string }) {
      applyCalls += 1;
      if (options.apply === "diverged") return { kind: "diverged" as const, reason: "base revision moved" };
      applied.set(input.idempotencyKey, "rev-2");
      if (options.apply === "throw-after-record") throw new Error("process lost during apply");
      if (input.expectedBaseRevision !== "rev-1") return { kind: "diverged" as const, reason: "unexpected base" };
      return { kind: "succeeded" as const, observedRevision: "rev-2" };
    },
    async inspect(idempotencyKey: string) {
      const revision = applied.get(idempotencyKey);
      return revision ? { kind: "succeeded" as const, observedRevision: revision } : { kind: "not_started" as const };
    }
  };
  let rememberedDeployment:
    | {
        kind: "observed";
        exitCode: number;
        observedVersion: string;
        restartStatus: string;
        health: "pass";
        healthDetail: string;
      }
    | undefined;
  const deployer = {
    async deploy() {
      deployCalls += 1;
      if (options.deploy === "down")
        return { kind: "failed" as const, reason: "unit inactive", health: "fail" as const, exitCode: 1 };
      if (options.deploy === "exit-without-health") {
        return {
          kind: "observed" as const,
          exitCode: 0,
          observedVersion: "rev-2",
          restartStatus: "restarted",
          health: "fail" as const,
          healthDetail: "unready"
        };
      }
      rememberedDeployment = {
        kind: "observed",
        exitCode: 0,
        observedVersion: "rev-2",
        restartStatus: "restarted",
        health: "pass",
        healthDetail: "ok"
      };
      return rememberedDeployment;
    },
    async inspect() {
      return rememberedDeployment ?? { kind: "not_started" as const };
    }
  };
  const runtime = new MissionRuntime({
    dbPath,
    workerId: options.workerId ?? "worker-a",
    agents: options.agents ?? [agent("agent-jc", "repository_read", now), agent("agent-dc", "host_exec", now)],
    executor,
    reconciler,
    applier,
    deployer,
    ...(options.productionObserved
      ? {
          observer: {
            async observe() {
              return { observed: options.productionObserved ?? "" };
            }
          }
        }
      : {}),
    ...(options.admission ? { admission: options.admission } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.leaseTtlMs ? { leaseTtlMs: options.leaseTtlMs } : {}),
    ...(options.onStage ? { onStage: options.onStage } : {})
  });
  return {
    runtime,
    dbPath,
    calls,
    started,
    executor,
    applier,
    deployer,
    applied,
    get applyCalls() {
      return applyCalls;
    },
    get deployCalls() {
      return deployCalls;
    },
    get maxInflight() {
      return maxInflight;
    }
  };
}

function plan(overrides: Partial<CreateMissionInput> = {}): CreateMissionInput {
  return {
    intent: "ship the governed change",
    target: { repo: "example/repo", cwd: "/work", system: "api" },
    baseRevision: "rev-1",
    requiresMutation: true,
    proposedMutation: { summary: "update service" },
    requiresDeployment: true,
    deploymentTarget: "svc-api",
    requiresProductionVerification: true,
    productionVerification: [
      { kind: "git_revision", expected: "rev-2" },
      { kind: "health_endpoint", expected: "pass" }
    ],
    operations: [
      {
        key: "inspect",
        type: "execute",
        lane: "jc",
        dependencies: [],
        requiredCapabilities: ["repository_read"],
        mutationClass: "none",
        retryPolicy: "safe_retry",
        verification: [{ kind: "command_exit", expected: "0" }]
      },
      {
        key: "test",
        type: "validate",
        lane: "coding_agent",
        dependencies: ["inspect"],
        requiredCapabilities: ["repository_read"],
        mutationClass: "none",
        retryPolicy: "safe_retry",
        verification: [{ kind: "unit_tests", expected: "pass" }]
      }
    ],
    ...overrides
  };
}

async function runToApproval(runtime: MissionRuntime, missionId: string) {
  const progress = await runtime.advance(missionId);
  expect(progress.status).toBe("WAITING_FOR_APPROVAL");
  return progress;
}

describe("mission lifecycle", () => {
  it("rejects illegal mission transitions and keeps completion idempotent at the state table", () => {
    expect(() => assertMissionTransition("COMPLETED", "RUNNING")).toThrow(ControlStackError);
    expect(() => assertMissionTransition("APPLYING", "APPROVED")).toThrow(ControlStackError);
    expect(() => assertMissionTransition("RUNNING", "WAITING_FOR_RESULT")).not.toThrow();
  });

  it("runs a linear mission through approval, apply, deploy, and idempotent completion", async () => {
    const fixture = world();
    const created = fixture.runtime.createMission(
      plan({
        operations: plan().operations.slice(0, 1),
        productionVerification: [
          { kind: "health_endpoint", expected: "pass" },
          { kind: "git_revision", expected: "rev-2" }
        ]
      })
    );
    await runToApproval(fixture.runtime, created.mission.missionId);
    expect(fixture.applyCalls).toBe(0);
    fixture.runtime.recordHumanDecision(created.mission.missionId, "human-operator", "approved", "looks right");
    const completed = await fixture.runtime.advance(created.mission.missionId);
    expect(completed.status).toBe("COMPLETED");
    const again = await fixture.runtime.advance(created.mission.missionId);
    expect(again.status).toBe("COMPLETED");
    const snapshot = fixture.runtime.store.snapshot(created.mission.missionId);
    expect(snapshot.events.filter((event) => event.name === "mission.completed")).toHaveLength(1);
    expect(snapshot.changeSets).toHaveLength(1);
    expect(snapshot.application?.status).toBe("succeeded");
    expect(snapshot.deployment).toMatchObject({
      status: "succeeded",
      healthStatus: "pass",
      restartStatus: "restarted"
    });
    expect(fixture.applyCalls).toBe(1);
    fixture.runtime.close();
  });

  it("respects a dependency DAG and skips completed work after restart", async () => {
    const fixture = world();
    const created = fixture.runtime.createMission(
      plan({ requiresDeployment: false, requiresProductionVerification: false, productionVerification: [] })
    );
    const keyById = new Map(created.operations.map((operation) => [operation.operationId, operation.operationKey]));
    await runToApproval(fixture.runtime, created.mission.missionId);
    expect(fixture.calls.map((call) => keyById.get(call.operationId))).toEqual(["inspect", "test"]);
    const callsBefore = fixture.calls.length;
    const restarted = new MissionRuntime({
      dbPath: fixture.dbPath,
      workerId: "worker-b",
      agents: [agent("agent-jc", "repository_read", new Date().toISOString())],
      executor: {
        async dispatch(request) {
          fixture.calls.push(request);
          return { kind: "fatal_failure" as const, reason: "should not run" };
        }
      },
      reconciler: {
        async inspect() {
          return { kind: "not_started" };
        }
      },
      applier: fixture.applier,
      deployer: fixture.deployer
    });
    const progress = await restarted.advance(created.mission.missionId);
    expect(progress.status).toBe("WAITING_FOR_APPROVAL");
    expect(fixture.calls).toHaveLength(callsBefore);
    restarted.close();
    fixture.runtime.close();
  });

  it("lets parallel-ready operations run without exceeding admission", async () => {
    const admission = new ExecutionAdmissionScheduler({
      config: {
        ...DEFAULT_EXECUTION_ADMISSION_CONFIG,
        executionMaxInflight: 1,
        executorMaxInflight: 1,
        queueTimeoutMs: 5_000
      }
    });
    const shared = world({ admission, workerId: "shared-worker" });
    const other = new MissionRuntime({
      dbPath: shared.dbPath,
      workerId: "shared-worker",
      agents: [agent("agent-jc", "repository_read", new Date().toISOString())],
      executor: shared.executor,
      reconciler: {
        async inspect(id: string) {
          return shared.started.has(id)
            ? {
                kind: "completed",
                payload: shared.started.get(id)!.payload,
                observations: shared.started.get(id)!.observations
              }
            : { kind: "not_started" };
        }
      },
      applier: shared.applier,
      deployer: shared.deployer,
      admission
    });
    const created = shared.runtime.createMission(
      plan({
        requiresMutation: false,
        requiresDeployment: false,
        requiresProductionVerification: false,
        proposedMutation: undefined,
        operations: [
          {
            key: "left",
            type: "execute",
            lane: "jc",
            dependencies: [],
            requiredCapabilities: ["repository_read"],
            mutationClass: "none",
            retryPolicy: "safe_retry",
            verification: [{ kind: "command_exit", expected: "0" }]
          },
          {
            key: "right",
            type: "execute",
            lane: "dc",
            dependencies: [],
            requiredCapabilities: ["repository_read"],
            mutationClass: "none",
            retryPolicy: "safe_retry",
            verification: [{ kind: "command_exit", expected: "0" }]
          }
        ]
      })
    );
    await Promise.all([shared.runtime.advance(created.mission.missionId), other.advance(created.mission.missionId)]);
    const snapshot = shared.runtime.store.snapshot(created.mission.missionId);
    expect(snapshot.operations.every((operation) => operation.status === "SUCCEEDED")).toBe(true);
    expect(shared.maxInflight).toBeLessThanOrEqual(1);
    expect(shared.calls).toHaveLength(2);
    other.close();
    shared.runtime.close();
    admission.shutdown();
  });

  it("does not let two workers execute the same operation", async () => {
    const admission = new ExecutionAdmissionScheduler({
      config: {
        ...DEFAULT_EXECUTION_ADMISSION_CONFIG,
        executionMaxInflight: 2,
        executorMaxInflight: 2,
        queueTimeoutMs: 5_000
      }
    });
    const first = world({ admission, workerId: "worker-a" });
    const second = new MissionRuntime({
      dbPath: first.dbPath,
      workerId: "worker-b",
      agents: [agent("agent-jc", "repository_read", new Date().toISOString())],
      executor: first.executor,
      reconciler: {
        async inspect() {
          return { kind: "not_started" };
        }
      },
      applier: first.applier,
      deployer: first.deployer,
      admission
    });
    const created = first.runtime.createMission(
      plan({
        requiresMutation: false,
        requiresDeployment: false,
        requiresProductionVerification: false,
        operations: [
          {
            key: "only",
            type: "execute",
            lane: "jc",
            dependencies: [],
            requiredCapabilities: ["repository_read"],
            mutationClass: "none",
            retryPolicy: "safe_retry",
            verification: [{ kind: "command_exit", expected: "0" }]
          }
        ]
      })
    );
    await Promise.all([first.runtime.advance(created.mission.missionId), second.advance(created.mission.missionId)]);
    expect(first.calls).toHaveLength(1);
    expect(first.runtime.store.snapshot(created.mission.missionId).mission.status).toBe("COMPLETED");
    second.close();
    first.runtime.close();
    admission.shutdown();
  });

  it("recovers an expired claim and refuses to reopen a completed operation", async () => {
    let now = Date.now();
    const clock = () => new Date(now);
    let halted = false;
    const fixture = world({
      clock,
      leaseTtlMs: 25,
      onStage(stage) {
        if (stage === "after_claim" && !halted) {
          halted = true;
          throw new Error("worker died after claim");
        }
      }
    });
    const created = fixture.runtime.createMission(
      plan({
        requiresMutation: false,
        requiresDeployment: false,
        requiresProductionVerification: false,
        operations: plan().operations.slice(0, 1)
      })
    );
    await expect(fixture.runtime.advance(created.mission.missionId)).rejects.toThrow("worker died after claim");
    expect(fixture.calls).toHaveLength(0);
    now += 1_000;
    const resumed = new MissionRuntime({
      dbPath: fixture.dbPath,
      workerId: "worker-recovered",
      agents: [agent("agent-jc", "repository_read", new Date(now).toISOString())],
      executor: fixture.executor,
      reconciler: {
        async inspect(id: string) {
          return fixture.started.has(id)
            ? { kind: "completed", payload: { ok: true }, observations: { command_exit: "0" } }
            : { kind: "not_started" };
        }
      },
      applier: fixture.applier,
      deployer: fixture.deployer,
      clock
    });
    const progress = await resumed.advance(created.mission.missionId);
    expect(progress.status).toBe("COMPLETED");
    expect(fixture.calls).toHaveLength(1);
    const operation = resumed.store.snapshot(created.mission.missionId).operations[0]!;
    expect(
      resumed.store.claim(
        operation.operationId,
        "worker-late",
        new Date(now + 10_000).toISOString(),
        new Date(now).toISOString()
      ).claimed
    ).toBe(false);
    expect(() =>
      resumed.store
        .database()
        .prepare(`UPDATE mission_operations SET status = 'READY' WHERE operation_id = ?`)
        .run(operation.operationId)
    ).toThrow(/completed operation/);
    resumed.close();
    fixture.runtime.close();
  });

  it("does not replay an unknown outcome until reconciliation proves the prior execution", async () => {
    const lost = world({ unknown: true, recordBeforeUnknown: true });
    const created = lost.runtime.createMission(
      plan({
        requiresMutation: false,
        requiresDeployment: false,
        requiresProductionVerification: false,
        operations: plan().operations.slice(0, 1)
      })
    );
    const waiting = await lost.runtime.advance(created.mission.missionId);
    expect(waiting.status).toBe("WAITING_FOR_RECONCILIATION");
    expect(lost.calls).toHaveLength(1);
    const executionId = lost.calls[0]?.executionId;
    const recovered = await lost.runtime.advance(created.mission.missionId);
    expect(recovered.complete).toHaveLength(1);
    expect(lost.calls).toHaveLength(1);
    expect(lost.runtime.store.snapshot(created.mission.missionId).operations[0]?.executionId).toBe(executionId);
    lost.runtime.close();

    const absent = world({ unknown: true, recordBeforeUnknown: false });
    const mission = absent.runtime.createMission(
      plan({
        requiresMutation: false,
        requiresDeployment: false,
        requiresProductionVerification: false,
        operations: plan().operations.slice(0, 1)
      })
    );
    await absent.runtime.advance(mission.mission.missionId);
    expect(absent.calls).toHaveLength(1);
    absent.executor.dispatch = async (request: DispatchRequest) => {
      absent.calls.push(request);
      absent.started.set(request.executionId, { payload: { ok: true }, observations: { command_exit: "0" } });
      return { kind: "result" as const, payload: { ok: true }, observations: { command_exit: "0" } };
    };
    await absent.runtime.advance(mission.mission.missionId);
    expect(absent.calls).toHaveLength(2);
    expect(absent.calls[0]?.executionId).toBe(absent.calls[1]?.executionId);
    expect(absent.runtime.store.snapshot(mission.mission.missionId).mission.status).toBe("COMPLETED");
    absent.runtime.close();
  });

  it("stops the mission when verification fails and when a required kind is unsupported", async () => {
    const fixture = world({ verificationObserved: "1" });
    const created = fixture.runtime.createMission(
      plan({ requiresMutation: false, requiresDeployment: false, requiresProductionVerification: false })
    );
    const progress = await fixture.runtime.advance(created.mission.missionId);
    expect(progress.status).toBe("FAILED");
    expect(progress.failureCode).toBe("verification_failure");
    expect(fixture.calls.map((call) => call.operationType)).toEqual(["execute"]);
    expect(() =>
      fixture.runtime.createMission(
        plan({ operations: [{ ...plan().operations[0]!, verification: [{ kind: "crystal_ball", expected: "yes" }] }] })
      )
    ).toThrow(/unsupported verification/);
    fixture.runtime.close();
  });

  it("creates one change set, binds approval to that hash, and drops the binding when the mutation changes", async () => {
    const fixture = world();
    const created = fixture.runtime.createMission(
      plan({ requiresDeployment: false, requiresProductionVerification: false })
    );
    await runToApproval(fixture.runtime, created.mission.missionId);
    await fixture.runtime.advance(created.mission.missionId);
    const waiting = fixture.runtime.store.snapshot(created.mission.missionId);
    expect(waiting.changeSets).toHaveLength(1);
    const hash = waiting.changeSets[0]!.changeSetHash;
    fixture.runtime.recordHumanDecision(created.mission.missionId, "human-operator", "approved", "approved");
    fixture.runtime.supersedeMutation(created.mission.missionId, { summary: "a different mutation" });
    const superseded = fixture.runtime.store.snapshot(created.mission.missionId);
    expect(superseded.mission.status).toBe("WAITING_FOR_APPROVAL");
    await fixture.runtime.advance(created.mission.missionId);
    const next = fixture.runtime.store.snapshot(created.mission.missionId);
    expect(next.mission.changeSetId).not.toBe(waiting.mission.changeSetId);
    const head = next.changeSets.find((changeSet) => changeSet.changeSetId === next.mission.changeSetId);
    expect(head?.changeSetHash).not.toBe(hash);
    expect(
      next.approvals.some(
        (approval) => approval.changeSetHash === head?.changeSetHash && approval.decision === "approved"
      )
    ).toBe(false);
    expect(fixture.applyCalls).toBe(0);
    expect(() => fixture.runtime.recordHumanDecision(created.mission.missionId, "worker-a", "approved", "no")).toThrow(
      /human approver/
    );
    fixture.runtime.close();
  });

  it("does not reapply a succeeded mutation and fails closed on deploy or production checks", async () => {
    const fixture = world({ apply: "throw-after-record" });
    const created = fixture.runtime.createMission(
      plan({
        requiresDeployment: false,
        requiresProductionVerification: false,
        operations: plan().operations.slice(0, 1)
      })
    );
    await runToApproval(fixture.runtime, created.mission.missionId);
    fixture.runtime.recordHumanDecision(created.mission.missionId, "human-operator", "approved", "ship");
    await expect(fixture.runtime.advance(created.mission.missionId)).rejects.toThrow(/process lost during apply/);
    expect(fixture.applyCalls).toBe(1);
    const resumed = new MissionRuntime({
      dbPath: fixture.dbPath,
      workerId: "worker-resume",
      agents: [agent("agent-jc", "repository_read", new Date().toISOString())],
      executor: {
        async dispatch() {
          throw new Error("duplicate execution");
        }
      },
      reconciler: {
        async inspect() {
          return { kind: "not_started" };
        }
      },
      applier: fixture.applier,
      deployer: fixture.deployer
    });
    const progress = await resumed.advance(created.mission.missionId);
    expect(progress.status).toBe("COMPLETED");
    expect(fixture.applyCalls).toBe(1);
    resumed.close();
    fixture.runtime.close();

    const diverged = world({ apply: "diverged" });
    const divergedMission = diverged.runtime.createMission(
      plan({
        requiresDeployment: false,
        requiresProductionVerification: false,
        operations: plan().operations.slice(0, 1)
      })
    );
    await runToApproval(diverged.runtime, divergedMission.mission.missionId);
    diverged.runtime.recordHumanDecision(divergedMission.mission.missionId, "human-operator", "approved", "ship");
    expect((await diverged.runtime.advance(divergedMission.mission.missionId)).status).toBe("FAILED");
    diverged.runtime.close();

    const unhealthy = world({ deploy: "exit-without-health" });
    const deployMission = unhealthy.runtime.createMission(plan({ operations: plan().operations.slice(0, 1) }));
    await runToApproval(unhealthy.runtime, deployMission.mission.missionId);
    unhealthy.runtime.recordHumanDecision(deployMission.mission.missionId, "human-operator", "approved", "ship");
    const deployProgress = await unhealthy.runtime.advance(deployMission.mission.missionId);
    expect(deployProgress.status).toBe("FAILED");
    expect(deployProgress.failureCode).toBe("deployment_failure");
    unhealthy.runtime.close();

    const production = world({ productionObserved: "wrong" });
    const productionMission = production.runtime.createMission(plan({ operations: plan().operations.slice(0, 1) }));
    await runToApproval(production.runtime, productionMission.mission.missionId);
    production.runtime.recordHumanDecision(productionMission.mission.missionId, "human-operator", "approved", "ship");
    const productionProgress = await production.runtime.advance(productionMission.mission.missionId);
    expect(productionProgress.status).toBe("FAILED");
    expect(productionProgress.failureCode).toBe("production_verification_failure");
    production.runtime.close();
  });

  it("rejects completion without evidence and keeps routing and admission fail-closed", async () => {
    const fixture = world();
    const created = fixture.runtime.createMission(
      plan({
        requiresMutation: false,
        requiresDeployment: false,
        requiresProductionVerification: false,
        operations: plan().operations.slice(0, 1)
      })
    );
    expect(() => assertReadyToComplete(fixture.runtime.store.snapshot(created.mission.missionId))).toThrow(
      ControlStackError
    );
    await fixture.runtime.advance(created.mission.missionId);
    const sealed = fixture.runtime.store.snapshot(created.mission.missionId);
    expect(sealed.mission.status).toBe("COMPLETED");
    fixture.runtime.store
      .database()
      .prepare(`DELETE FROM mission_verifications WHERE mission_id = ?`)
      .run(created.mission.missionId);
    expect(() => assertReadyToComplete(fixture.runtime.store.snapshot(created.mission.missionId))).toThrow(
      /verification/
    );
    expect(fixture.runtime.store.snapshot(created.mission.missionId).mission.status).toBe("COMPLETED");
    fixture.runtime.close();

    const blocked = world({ agents: [] });
    const blockedMission = blocked.runtime.createMission(
      plan({
        requiresMutation: false,
        requiresDeployment: false,
        requiresProductionVerification: false,
        operations: plan().operations.slice(0, 1)
      })
    );
    expect((await blocked.runtime.advance(blockedMission.mission.missionId)).status).toBe("BLOCKED");
    expect(blocked.calls).toHaveLength(0);
    blocked.runtime.close();

    const admission = new ExecutionAdmissionScheduler();
    admission.shutdown();
    const rejected = world({ admission });
    const rejectedMission = rejected.runtime.createMission(
      plan({
        requiresMutation: false,
        requiresDeployment: false,
        requiresProductionVerification: false,
        operations: plan().operations.slice(0, 1)
      })
    );
    const rejectedProgress = await rejected.runtime.advance(rejectedMission.mission.missionId);
    expect(rejected.calls).toHaveLength(0);
    expect(rejectedProgress.status).not.toBe("COMPLETED");
    expect(
      rejected.runtime.store
        .snapshot(rejectedMission.mission.missionId)
        .events.some((event) => event.name === "admission.rejected")
    ).toBe(true);
    rejected.runtime.close();
  });

  it.each([
    "before_route",
    "after_route",
    "before_dispatch",
    "after_claim",
    "after_dispatch",
    "after_result",
    "after_validation",
    "after_change_set",
    "after_approval",
    "after_apply_started",
    "after_apply",
    "after_deploy_started",
    "after_deploy",
    "before_complete"
  ])("resumes after a crash at %s without a second execution or mutation", async (stage) => {
    let now = Date.now();
    let thrown = false;
    const fixture = world({
      clock: () => new Date(now),
      leaseTtlMs: 1_000,
      onStage(seen) {
        if (seen === stage && !thrown) {
          thrown = true;
          throw new Error(`crash at ${stage}`);
        }
      }
    });
    const created = fixture.runtime.createMission(plan({ operations: plan().operations.slice(0, 1) }));
    const missionId = created.mission.missionId;
    const crash = async () => {
      try {
        await fixture.runtime.advance(missionId);
      } catch (error) {
        if (!thrown) throw error;
      }
    };
    await crash();
    if (!thrown) {
      try {
        fixture.runtime.recordHumanDecision(missionId, "human-operator", "approved", "ship");
      } catch (error) {
        if (!thrown) throw error;
      }
    }
    if (!thrown) await crash();
    expect(thrown).toBe(true);
    now += 5_000;
    const resumed = new MissionRuntime({
      dbPath: fixture.dbPath,
      workerId: "worker-resume",
      agents: [agent("agent-jc", "repository_read", new Date(now).toISOString())],
      executor: fixture.executor,
      reconciler: {
        async inspect(executionId: string) {
          const found = fixture.started.get(executionId);
          return found
            ? { kind: "completed" as const, payload: found.payload, observations: found.observations }
            : { kind: "not_started" as const };
        }
      },
      applier: fixture.applier,
      deployer: fixture.deployer,
      clock: () => new Date(now)
    });
    let progress = await resumed.advance(missionId);
    if (progress.status === "WAITING_FOR_APPROVAL") {
      resumed.recordHumanDecision(missionId, "human-operator", "approved", "ship");
      progress = await resumed.advance(missionId);
    }
    expect(progress.status).toBe("COMPLETED");
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.applyCalls).toBe(1);
    expect(fixture.deployCalls).toBe(1);
    resumed.close();
    fixture.runtime.close();
  });

  it("upgrades an existing control-plane database with mission tables", async () => {
    const { MissionStore } = await import("./store.js");
    const directory = mkdtempSync(join(tmpdir(), "acs-mission-migrate-"));
    directories.push(directory);
    const store = new MissionStore(join(directory, "control.db"));
    const versions = store.database().prepare(`SELECT version FROM schema_migrations ORDER BY version`).all() as Array<{
      version: number;
    }>;
    expect(versions.map((row) => row.version)).toContain(40);
    expect(versions.some((row) => row.version === 39)).toBe(true);
    expect(
      store.database().prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'missions'`).get()
    ).toBeTruthy();
    store.close();
  });
});
