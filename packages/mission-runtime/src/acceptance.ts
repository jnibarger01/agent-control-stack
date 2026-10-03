import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegistryAgentDetail } from "@agent-control-stack/work-items";
import { MissionRuntime } from "./runner.js";
import type { DispatchOutcome, DispatchRequest } from "./ports.js";
import type { MissionRouter } from "./ports.js";

export interface AcceptanceCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface AcceptanceReport {
  verdict: "PASS" | "FAIL";
  checks: AcceptanceCheck[];
}

function agent(now: string): RegistryAgentDetail {
  return {
    id: "agent-jc",
    name: "agent-jc",
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
        id: "agent-jc-cap",
        agentId: "agent-jc",
        name: "repository_read",
        createdAt: now,
        updatedAt: now,
        createdByActorId: "system",
        updatedByActorId: "system"
      }
    ]
  };
}

function acceptanceRouter(agents: RegistryAgentDetail[]): MissionRouter {
  return {
    async assign(request) {
      const selected = agents.find((candidate) =>
        request.requiredCapabilities.every((required) => candidate.capabilities.some((item) => item.name === required))
      );
      if (!selected) return { kind: "rejected", reason: "no eligible acceptance worker", evidence: { fixture: true } };
      return {
        kind: "assigned",
        decisionId: `acceptance-routing:${request.workItemId}`,
        selectedAgentId: selected.id,
        selectedWorkerId: "acceptance-assigned-worker",
        source: "nimble",
        model: "acceptance-nimble",
        confidence: 1,
        threshold: 0.8,
        evidence: { fixture: true, operationId: request.operationId }
      };
    }
  };
}

function check(checks: AcceptanceCheck[], name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
}

class Lane {
  readonly calls: string[] = [];
  readonly started = new Map<string, Record<string, string>>();
  applyCount = 0;
  readonly applied = new Map<string, string>();
  mode: "result" | "unknown" = "result";

  async dispatch(request: DispatchRequest): Promise<DispatchOutcome> {
    this.calls.push(request.executionId);
    const observations = { command_exit: "0", unit_tests: "pass" };
    this.started.set(request.executionId, observations);
    if (this.mode === "unknown") return { kind: "unknown", reason: "lost contact" };
    return { kind: "result", payload: { ok: true, artifactHashes: ["b".repeat(64)] }, observations };
  }

  async inspect(executionId: string) {
    const observations = this.started.get(executionId);
    if (!observations) return { kind: "not_started" as const };
    return { kind: "completed" as const, payload: { ok: true, artifactHashes: ["b".repeat(64)] }, observations };
  }
}

export async function runMissionAcceptance(): Promise<AcceptanceReport> {
  const checks: AcceptanceCheck[] = [];
  const directory = mkdtempSync(join(tmpdir(), "acs-mission-acceptance-"));
  const dbPath = join(directory, "control.db");
  const now = new Date().toISOString();
  const lane = new Lane();
  let deployCount = 0;
  let liveReleaseId: string | null = null;
  const deploymentPorts = {
    deploymentAuthorization: {
      async authorize(input: { requestedBy: string }) {
        return { requestedBy: input.requestedBy, permitId: "acceptance-deploy-permit" };
      }
    },
    deploymentController: {
      async deploy(input: { releaseId: string }) {
        deployCount += 1;
        liveReleaseId = input.releaseId;
        return { status: "succeeded" as const };
      }
    },
    liveReleaseObserver: {
      async observe() {
        return { releaseId: liveReleaseId, observedAt: new Date().toISOString() };
      }
    }
  };
  const runtime = new MissionRuntime({
    dbPath,
    workerId: "acceptance-worker",
    router: acceptanceRouter([agent(now)]),
    executor: lane,
    reconciler: lane,
    observer: {
      async observe(input: { kind: string; expected: string }) {
        if (input.kind === "health_endpoint" || input.kind === "service_health") return { observed: "pass" };
        return { observed: liveReleaseId ?? input.expected };
      }
    },
    applier: {
      async apply(input) {
        lane.applyCount += 1;
        lane.applied.set(input.idempotencyKey, "rev-2");
        return { kind: "succeeded", observedRevision: "rev-2" };
      },
      async inspect(idempotencyKey) {
        const observedRevision = lane.applied.get(idempotencyKey);
        return observedRevision ? { kind: "succeeded", observedRevision } : { kind: "not_started" };
      }
    },
    ...deploymentPorts
  });

  try {
    const created = runtime.createMission({
      intent: "acceptance mission",
      target: { repo: "example/repo", system: "api" },
      baseRevision: "rev-1",
      requiresMutation: true,
      proposedMutation: { summary: "acceptance" },
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
      ]
    });
    const missionId = created.mission.missionId;
    const waiting = await runtime.advance(missionId);
    const routed = runtime.store.snapshot(missionId);
    check(
      checks,
      "routing",
      routed.events.some((event) => event.name === "route.chosen"),
      "route.chosen recorded"
    );
    check(
      checks,
      "admission",
      routed.events.some((event) => event.name === "admission.granted"),
      "admission.granted recorded"
    );
    check(
      checks,
      "dispatch",
      routed.events.some((event) => event.name === "operation.dispatched"),
      "operation.dispatched recorded"
    );
    check(
      checks,
      "result durability",
      routed.operations.every((operation) => operation.resultHash),
      "both operation results are stored"
    );
    check(
      checks,
      "verification",
      routed.verifications.filter((item) => item.outcome === "passed").length >= 2,
      "operation verification passed"
    );
    check(
      checks,
      "Change Set",
      waiting.status === "WAITING_FOR_APPROVAL" && routed.changeSets.length === 1,
      waiting.status
    );
    check(checks, "approval boundary", lane.applyCount === 0, "no mutation before approval");
    runtime.recordHumanDecision(missionId, "human-operator", "approved", "acceptance");
    const completed = await runtime.advance(missionId);
    const done = runtime.store.snapshot(missionId);
    check(
      checks,
      "apply",
      done.application?.status === "succeeded" && lane.applyCount === 1,
      done.application?.status ?? "missing"
    );
    check(
      checks,
      "deployment",
      done.deploymentOperation?.status === "SUCCEEDED" &&
        done.deploymentOperation.observedReleaseId === "rev-2" &&
        deployCount === 1,
      done.deploymentOperation?.status ?? "missing"
    );
    check(
      checks,
      "production verification",
      done.verifications.some((item) => item.stage === "production" && item.outcome === "passed"),
      "production checks passed"
    );
    check(checks, "completion", completed.status === "COMPLETED", completed.status);

    runtime.close();
    const resumed = new MissionRuntime({
      dbPath,
      workerId: "acceptance-restart",
      router: acceptanceRouter([agent(new Date().toISOString())]),
      executor: lane,
      reconciler: lane,
      observer: {
        async observe(input: { kind: string; expected: string }) {
          if (input.kind === "health_endpoint" || input.kind === "service_health") return { observed: "pass" };
          return { observed: liveReleaseId ?? input.expected };
        }
      },
      applier: {
        async apply() {
          lane.applyCount += 1;
          return { kind: "succeeded", observedRevision: "rev-2" };
        },
        async inspect(idempotencyKey) {
          const observedRevision = lane.applied.get(idempotencyKey);
          return observedRevision ? { kind: "succeeded", observedRevision } : { kind: "not_started" };
        }
      },
      ...deploymentPorts
    });
    const callsBefore = lane.calls.length;
    const applyBefore = lane.applyCount;
    const afterRestart = await resumed.advance(missionId);
    check(
      checks,
      "restart recovery",
      afterRestart.status === "COMPLETED" && lane.calls.length === callsBefore && lane.applyCount === applyBefore,
      "restart did not duplicate execution or mutation"
    );
    resumed.close();

    const unknownDir = mkdtempSync(join(tmpdir(), "acs-mission-acceptance-unknown-"));
    const unknownLane = new Lane();
    unknownLane.mode = "unknown";
    const unknownRuntime = new MissionRuntime({
      dbPath: join(unknownDir, "control.db"),
      workerId: "acceptance-unknown",
      router: acceptanceRouter([agent(new Date().toISOString())]),
      executor: unknownLane,
      reconciler: unknownLane,
      applier: {
        async apply() {
          return { kind: "failed", reason: "should not apply" };
        },
        async inspect() {
          return { kind: "not_started" };
        }
      }
    });
    const unknownMission = unknownRuntime.createMission({
      intent: "unknown outcome",
      target: { repo: "example/repo" },
      baseRevision: "rev-1",
      requiresMutation: false,
      requiresDeployment: false,
      requiresProductionVerification: false,
      operations: [
        {
          key: "inspect",
          type: "execute",
          lane: "jc",
          dependencies: [],
          requiredCapabilities: ["repository_read"],
          mutationClass: "none",
          retryPolicy: "fail_closed",
          verification: [{ kind: "command_exit", expected: "0" }]
        }
      ]
    });
    const unknownProgress = await unknownRuntime.advance(unknownMission.mission.missionId);
    unknownLane.mode = "result";
    const reconciled = await unknownRuntime.advance(unknownMission.mission.missionId);
    check(
      checks,
      "unknown outcome",
      unknownProgress.status === "WAITING_FOR_RECONCILIATION" &&
        unknownLane.calls.length === 1 &&
        reconciled.complete.length === 1,
      `${unknownProgress.status} then ${reconciled.status} with ${unknownLane.calls.length} dispatch`
    );
    unknownRuntime.close();
    rmSync(unknownDir, { recursive: true, force: true });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  return { verdict: checks.every((item) => item.passed) ? "PASS" : "FAIL", checks };
}
