import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  SqliteWorkItemStore,
  executionPlanSubjectInputHash,
  type ChangeSetDefinition,
  type ChangeSetProgress
} from "@agent-control-stack/work-items";
import { runMission, runMissionOnce, type MissionRunnerPorts } from "./mission-runner.js";

function fixture(status: ChangeSetProgress["operations"][number]["status"] = "not_permitted") {
  const root = mkdtempSync(join(tmpdir(), "acs-mission-runner-"));
  const store = new SqliteWorkItemStore(join(root, "control.db"));
  const mission = store.create({
    title: "mission runner",
    intent: "inspect",
    requester: "agent",
    requesterSubject: "planner",
    target: { cwd: root },
    risk: "low",
    requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: [root] } }]
  });
  const definition: ChangeSetDefinition = {
    schemaVersion: "acs.change-set.v1",
    missionId: mission.id,
    subjectInputHash: executionPlanSubjectInputHash(mission),
    executingActorId: "planner",
    objective: "inspect",
    scope: [{ kind: "path", id: root }],
    maximumPrivileges: ["fs.read"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    constraints: { maxRuntimeMs: 10_000, maxParallelOperations: 1, failureBehavior: "stop" },
    verification: [],
    operations: [
      {
        operationId: "inspect",
        runtime: "desktop_commander",
        toolName: "read_file",
        action: { kind: "fs.read", description: "inspect", params: { path: root } },
        resources: [{ kind: "path", id: root }],
        requestedPrivileges: ["fs.read"],
        effect: "read_only",
        expectedSideEffects: [],
        dependsOn: [],
        retry: { maxAttempts: 1, idempotencyKey: "inspect" }
      }
    ]
  };
  const record = store.submitChangeSet({
    definition,
    submissionId: "fixture-proposal",
    expectedHeadHash: null,
    createdByActorId: "planner"
  });
  const progress: ChangeSetProgress = {
    schemaVersion: "acs.change-set.progress.v1",
    missionId: mission.id,
    manifestHash: record.manifestHash,
    revision: 1,
    operations: [{ operationId: "inspect", dependsOn: [], status }]
  };
  const permit = {
    schemaVersion: "acs.change-set.operation-permit.v1",
    permitId: "fixture-permit",
    missionId: mission.id,
    manifestHash: record.manifestHash,
    revision: 1,
    operationId: "inspect",
    approvalId: "human-approval",
    policyHash: "a".repeat(64),
    executionWorkItemId: "fixture-child",
    executionInputHash: "a".repeat(64),
    executingActorId: "planner",
    workerId: "acs-dc-bridge",
    runtime: "desktop_commander",
    toolName: "read_file",
    invocationHash: "a".repeat(64),
    createdAt: new Date().toISOString(),
    expiresAt: definition.expiresAt,
    permitHash: "a".repeat(64),
    auditEventId: "fixture-audit"
  };
  const ports: MissionRunnerPorts = {
    request: vi.fn(async (method, path) => {
      if (path.endsWith("/change-sets")) return { status: 200, body: record };
      if (path.includes("/progress?")) return { status: 200, body: progress };
      if (path.endsWith("/permit")) {
        progress.operations[0]!.status = "not_started";
        return { status: 201, body: permit };
      }
      if (path.endsWith("/authorize")) return { status: 201, body: { authorizationId: "fixture-authorization" } };
      if (method === "GET") return { status: 200, body: { workItem: mission } };
      throw new Error("unexpected runner route");
    }),
    invoke: vi.fn(async () => undefined)
  };
  return {
    root,
    mission,
    store,
    record,
    progress,
    permit,
    definition,
    ports,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

describe("mission runner authority and recovery", () => {
  it("waits for an existing human authority without invoking an approval endpoint", async () => {
    const ctx = fixture();
    try {
      expect((await runMissionOnce(ctx.ports, { missionId: ctx.mission.id })).status).toBe("awaiting_approval");
      expect(ctx.ports.invoke).not.toHaveBeenCalled();
      expect(vi.mocked(ctx.ports.request).mock.calls.every(([method]) => method === "GET")).toBe(true);
    } finally {
      ctx.close();
    }
  });

  it.each(["running", "needs_reconciliation", "failed", "blocked"] as const)(
    "never replays %s execution after recreation",
    async (status) => {
      const ctx = fixture(status);
      try {
        const options = { missionId: ctx.mission.id, authority: { approvalId: "human-approval" } };
        for (let attempt = 0; attempt < 2; attempt++) await runMissionOnce({ ...ctx.ports }, options);
        expect(ctx.ports.invoke).not.toHaveBeenCalled();
        expect(vi.mocked(ctx.ports.request).mock.calls.every(([method]) => method === "GET")).toBe(true);
      } finally {
        ctx.close();
      }
    }
  );

  it("submits a planner proposal once and reuses the immutable ACS snapshot on resume", async () => {
    const ctx = fixture();
    try {
      let submitted = false;
      const original = ctx.ports.request;
      ctx.ports.request = vi.fn(async (method, path, body) => {
        if (path.endsWith("/change-sets")) {
          if (method === "GET" && !submitted) return { status: 404, body: {} };
          if (method === "POST") {
            submitted = true;
            expect(body).toMatchObject({ definition: ctx.definition, expectedHeadHash: null });
          }
        }
        return original(method, path, body);
      });
      const plan = vi.fn(async () => ctx.definition);
      await runMissionOnce(ctx.ports, { missionId: ctx.mission.id, plan });
      await runMissionOnce(ctx.ports, { missionId: ctx.mission.id, plan });
      expect(plan).toHaveBeenCalledTimes(1);
      expect(ctx.ports.invoke).not.toHaveBeenCalled();
    } finally {
      ctx.close();
    }
  });

  it("rejects a changed snapshot, wrong permit and rejected ACS request before dispatch", async () => {
    const ctx = fixture();
    try {
      const options = { missionId: ctx.mission.id, authority: { approvalId: "human-approval" } };
      await expect(runMissionOnce(ctx.ports, { ...options, expectedManifestHash: "0".repeat(64) })).rejects.toThrow(
        "snapshot changed"
      );
      ctx.permit.executingActorId = "different-actor";
      await expect(runMissionOnce(ctx.ports, options)).rejects.toThrow("permit does not bind");
      const original = ctx.ports.request;
      ctx.ports.request = vi.fn(async (method, path, body) =>
        path.endsWith("/permit") ? { status: 403, body: {} } : original(method, path, body)
      );
      await expect(runMissionOnce(ctx.ports, options)).rejects.toThrow("ACS rejected");
      expect(ctx.ports.invoke).not.toHaveBeenCalled();
    } finally {
      ctx.close();
    }
  });

  it("does not retry the runtime on a transport failure with an unobserved outcome", async () => {
    const ctx = fixture();
    try {
      ctx.ports.invoke = vi.fn(async () => {
        ctx.progress.operations[0]!.status = "running";
        throw new Error("lost response after dispatch");
      });
      const options = { missionId: ctx.mission.id, authority: { approvalId: "human-approval" } };
      const first = await runMission(ctx.ports, { ...options, maxRuntimeMs: 1000, pollIntervalMs: 10 });
      expect(first.code).toBe("mission_runtime_outcome_unobserved");
      await runMissionOnce({ ...ctx.ports }, options);
      expect(ctx.ports.invoke).toHaveBeenCalledTimes(1);
    } finally {
      ctx.close();
    }
  });

  it("does not mark a mission complete from a successful tool response", async () => {
    const ctx = fixture();
    try {
      const current = await runMissionOnce(ctx.ports, {
        missionId: ctx.mission.id,
        authority: { approvalId: "human-approval" }
      });
      expect(current.status).toBe("progressed");
      expect(current.completion).toBeUndefined();
      expect(vi.mocked(ctx.ports.request).mock.calls.some(([, path]) => path.endsWith("/complete"))).toBe(false);
    } finally {
      ctx.close();
    }
  });

  it("stops pending independent review without dispatch or completion after resume", async () => {
    const ctx = fixture("awaiting_verification");
    try {
      for (let restart = 0; restart < 2; restart++) {
        const result = await runMission(
          { ...ctx.ports },
          { missionId: ctx.mission.id, authority: { approvalId: "human-approval" }, maxRuntimeMs: 1000 }
        );
        expect(result.status).toBe("awaiting_verification");
      }
      expect(ctx.ports.invoke).not.toHaveBeenCalled();
      expect(vi.mocked(ctx.ports.request).mock.calls.some(([, path]) => path.endsWith("/complete"))).toBe(false);
    } finally {
      ctx.close();
    }
  });

  it("returns bounded waiting rather than replaying a slow operation", async () => {
    const ctx = fixture("running");
    try {
      await expect(runMission(ctx.ports, { missionId: ctx.mission.id, maxRuntimeMs: -1 })).rejects.toThrow(
        "polling budget"
      );
      const result = await runMission(ctx.ports, {
        missionId: ctx.mission.id,
        authority: { approvalId: "human-approval" },
        maxRuntimeMs: 25,
        pollIntervalMs: 10
      });
      expect(result.code).toBe("mission_runner_time_budget_exhausted");
      expect(ctx.ports.invoke).not.toHaveBeenCalled();
    } finally {
      ctx.close();
    }
  });
});
