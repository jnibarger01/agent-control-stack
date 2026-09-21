import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import {
  SqliteWorkItemStore,
  defaultExecutionPlanForWorkItem,
  type ClaimedWorkItem
} from "@agent-control-stack/work-items";
import {
  GATEWAY_SHUTTING_DOWN_CODE,
  ShutdownController,
  guardWorkItemClaimTools,
  installGracefulShutdown,
  type GatewayProcess
} from "./lifecycle.js";
import { buildGateway, type GatewayAuthOptions } from "./server.js";

const transition = { via: "domain_service" as const };
const workerAuth: GatewayAuthOptions = { token: "worker-token", actor: "agent", actorId: "worker-a" };

let directory: string | undefined;

afterEach(() => {
  if (directory) {
    rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

function hex(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function seedAuthoritativeClaim(dbPath: string, leaseMs = 60_000): ClaimedWorkItem {
  const store = new SqliteWorkItemStore(dbPath, { leaseMs });
  try {
    const workItem = store.create({
      title: "Drain claim target",
      requester: "agent",
      intent: "verify shutdown claim drain",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["README.md"], write: false } }],
      risk: "low"
    });
    const plan = store.createExecutionPlan({
      workItemId: workItem.id,
      definition: defaultExecutionPlanForWorkItem(workItem),
      createdByActorId: "agent"
    });
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
    store.approveWorkItem(workItem.id, transition);
    const claimed = store.claimNextApprovedWorkItem("worker-a", {
      leaseMs,
      attemptAuthority: {
        planHash: plan.planHash,
        admissionId: admission.admissionId,
        policyVersion: admission.policyVersion,
        policyDecisionHash: admission.policyDecisionHash
      }
    });
    if (!claimed?.attemptId || claimed.fencingEpoch === undefined) {
      throw new Error("expected authoritative claim");
    }
    return claimed;
  } finally {
    store.close();
  }
}

describe("shutdown claim drain integration", () => {
  it("rejects new claims during drain while renew and result submit still succeed", async () => {
    directory = mkdtempSync(join(tmpdir(), "acs-shutdown-drain-"));
    const dbPath = join(directory, "control.db");
    const claimed = seedAuthoritativeClaim(dbPath);
    const controller = new ShutdownController();
    const app = buildGateway({ dbPath, logger: false, auth: workerAuth, shutdownController: controller });

    const store = new SqliteWorkItemStore(dbPath, { leaseMs: 60_000 });
    const tools = guardWorkItemClaimTools(createWorkItemTools(store, createPolicyEngine()), controller);
    try {
      expect(store.countActiveAttemptLeases()).toBe(1);

      const second = store.create({
        title: "Second drain target",
        requester: "agent",
        intent: "should not be claimable during drain",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["README.md"], write: false } }],
        risk: "low"
      });
      store.approveWorkItem(second.id, transition);

      controller.beginShutdown();
      expect(() => tools.claim_next_approved_work_item({ workerId: "worker-b" })).toThrow(ControlStackError);
      try {
        tools.claim_next_approved_work_item({ workerId: "worker-b" });
      } catch (error) {
        expect((error as ControlStackError).code).toBe(GATEWAY_SHUTTING_DOWN_CODE);
      }
      expect(store.get(second.id)?.status).toBe("approved");

      const renewed = store.renewAttemptLease({
        leaseId: claimed.leaseId,
        attemptId: claimed.attemptId!,
        workItemId: claimed.id,
        workerId: claimed.workerId,
        leaseToken: claimed.leaseToken,
        fencingEpoch: claimed.fencingEpoch!,
        ttlMs: 60_000
      });
      expect(renewed.leaseId).toBe(claimed.leaseId);

      const response = await app.inject({
        method: "POST",
        url: `/work-items/${claimed.id}/results`,
        headers: { authorization: "Bearer worker-token" },
        payload: {
          workItemId: claimed.id,
          attemptId: claimed.attemptId,
          leaseId: claimed.leaseId,
          workerId: claimed.workerId,
          actionHash: claimed.actionHash,
          planHash: claimed.planHash,
          inputHash: claimed.inputHash,
          fencingEpoch: claimed.fencingEpoch,
          idempotencyKey: stableHash({ domain: "acs.attempt-result.v1", attemptId: claimed.attemptId }),
          outcome: "succeeded",
          startedAt: claimed.startedAt,
          finishedAt: new Date(Date.parse(claimed.startedAt) + 20).toISOString(),
          exitCode: 0,
          summary: "drain-window result",
          stdout: "ok",
          stderr: "",
          structuredOutput: { simulated: true },
          artifacts: [],
          simulationMetadata: { executionMode: "dry_run", simulated: true }
        }
      });
      expect([200, 201]).toContain(response.statusCode);
      expect(store.countActiveAttemptLeases()).toBe(0);
    } finally {
      store.close();
      await app.close();
    }
  });

  it("records drain audit/metrics and force-closes after the configured drain timeout", async () => {
    directory = mkdtempSync(join(tmpdir(), "acs-shutdown-force-"));
    const dbPath = join(directory, "control.db");
    seedAuthoritativeClaim(dbPath);

    const runtime = new EventEmitter() as EventEmitter & GatewayProcess;
    runtime.exit = vi.fn(() => {
      throw new Error("unexpected forced exit");
    }) as never;
    const controller = new ShutdownController();
    const close = vi.fn(async () => undefined);
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const app = buildGateway({ dbPath, logger: false, auth: workerAuth, shutdownController: controller });
    const hooks = app.acsShutdown!;
    let now = 0;
    const finishPhases: Array<"finish" | "timeout"> = [];

    installGracefulShutdown({ close, log } as never, {
      runtime,
      timeoutMs: 250,
      drainTimeoutMs: 40,
      drainPollMs: 5,
      shutdownController: controller,
      countActiveLeases: hooks.countActiveLeases,
      failExpiredLeases: hooks.failExpiredLeases,
      onDrainStart: (info) => hooks.recordDrainStart(info),
      onDrainFinish: (info) => {
        finishPhases.push(info.timedOut ? "timeout" : "finish");
        hooks.recordDrainFinish(info);
      },
      sleep: async () => undefined,
      now: () => {
        const current = now;
        now += 10;
        return current;
      }
    });

    expect(hooks.countActiveLeases()).toBeGreaterThan(0);
    runtime.emit("SIGTERM");
    expect(controller.isShuttingDown()).toBe(true);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(finishPhases).toEqual(["timeout"]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ signal: "SIGTERM" }),
      "gateway shutdown drain timed out; force-closing"
    );
    expect(runtime.exitCode).toBe(0);

    const events = new SqliteWorkItemStore(dbPath).readEvents({ limit: 100 }).map((event) => event.name);
    expect(events).toContain("gateway.shutdown_drain.started");
    expect(events).toContain("gateway.shutdown_drain.finished");

    await app.close();
  });
});
