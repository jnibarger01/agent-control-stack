import { describe, expect, it, vi } from "vitest";
import type { RecordActorRoutingDecisionInput, RegistryAgentDetail } from "@agent-control-stack/work-items";
import { routeActor, routeAndPersistActor } from "./index.js";

function agent(id: string, overrides: Partial<RegistryAgentDetail> = {}): RegistryAgentDetail {
  return {
    id,
    name: id,
    kind: "coding",
    acpRole: "IMPLEMENTATION_AGENT",
    status: "AVAILABLE",
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    createdByActorId: "system",
    updatedByActorId: "system",
    lastHeartbeatAt: "2026-08-18T00:00:00.000Z",
    capabilities: [
      {
        id: `${id}-cap`,
        agentId: id,
        name: "repository_write",
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:00.000Z",
        createdByActorId: "system",
        updatedByActorId: "system"
      }
    ],
    ...overrides
  };
}

describe("routeActor", () => {
  it("applies hard gates and returns explicit exclusion reasons", () => {
    const decision = routeActor(
      [
        agent("good"),
        agent("stale", { lastHeartbeatAt: "2020-01-01T00:00:00.000Z" }),
        agent("wrong-cap", { capabilities: [] }),
        agent("busy", { status: "BUSY" })
      ],
      {
        requiredCapabilities: ["repository_write"],
        now: new Date("2026-08-18T00:01:00.000Z")
      }
    );

    expect(decision.selected).toBe("good");
    expect(decision.eligible).toEqual(["good"]);
    expect(decision.excluded.stale).toContain("stale heartbeat");
    expect(decision.excluded["wrong-cap"]).toContain("missing capability: repository_write");
    expect(decision.excluded.busy).toContain("availability: BUSY");
  });

  it("uses deterministic scoring and id tie-breaking", () => {
    const decision = routeActor([agent("zeta"), agent("alpha")], {
      requiredCapabilities: ["repository_write"],
      requiredRole: "IMPLEMENTATION_AGENT",
      taskType: "coding",
      freeCapacity: { alpha: 1, zeta: 1 },
      successRate: { alpha: 1, zeta: 1 },
      now: new Date("2026-08-18T00:01:00.000Z")
    });

    expect(decision.selected).toBe("alpha");
    expect(decision.scores.alpha).toBe(decision.scores.zeta);
  });

  it("penalizes recent and same-task failures without bypassing hard gates", () => {
    const decision = routeActor([agent("preferred"), agent("fallback")], {
      requiredCapabilities: ["repository_write"],
      recentFailures: new Set(["preferred"]),
      sameTaskFailures: new Set(["preferred"]),
      now: new Date("2026-08-18T00:01:00.000Z")
    });

    expect(decision.selected).toBe("fallback");
    expect(decision.candidates.find((candidate) => candidate.id === "preferred")?.reasons).toEqual(
      expect.arrayContaining(["recent failure -20", "same-task failure -30"])
    );
  });

  it("records semantic shadow evidence without changing the deterministic route", async () => {
    const observations: Array<Record<string, unknown>> = [];
    let release!: () => void;
    const observed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const persistence = {
      recordActorRoutingDecision(input: RecordActorRoutingDecisionInput) {
        return { decisionId: "routing_test_1", ...input, createdAt: "2026-09-29T20:00:00.000Z" };
      },
      recordActorRoutingShadowObservation(input: Record<string, unknown>) {
        observations.push(input);
        release();
      }
    };
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { state: { goal: string } };
      expect(body.state.goal).not.toContain("sk-secret");
      expect(body.state).not.toHaveProperty("deterministicSelectedActorId");
      return new Response(
        JSON.stringify({
          model: "jev-test",
          answers: {
            route: {
              type: "choice",
              choice: "candidate_02",
              probabilities: { candidate_01: 0.15, candidate_02: 0.85 },
              confidence: 0.85
            }
          }
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const routed = routeAndPersistActor(
      [agent("zeta"), agent("alpha")],
      {
        requiredCapabilities: ["repository_write"],
        now: new Date("2026-08-18T00:01:00.000Z"),
        workItemId: "wrk_route_shadow",
        idempotencyKey: "route-shadow",
        jevShadow: {
          goal: "Implement the feature using sk-secret-value",
          options: {
            enabled: true,
            capabilityProfile: {
              promptVersion: "test-v1",
              supportsNoul: true,
              supportsChoice: true,
              supportsScore: true,
              fingerprint: "test"
            },
            fetchImpl,
            sink: () => undefined
          }
        }
      },
      persistence,
      { via: "domain_service" }
    );

    expect(routed.decision.selected).toBe("alpha");
    expect(routed.persisted.selectedActorId).toBe("alpha");
    await observed;
    expect(observations[0]).toMatchObject({
      deterministicSelectedActorId: "alpha",
      semanticSelectedActorId: "zeta",
      eligible: ["alpha", "zeta"],
      semanticProbabilities: { alpha: 0.15, zeta: 0.85 },
      degraded: false
    });
  });

  it("fails open when the deployed JEV profile cannot perform Choice", async () => {
    const observations: Array<Record<string, unknown>> = [];
    let release!: () => void;
    const observed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn();
    const persistence = {
      recordActorRoutingDecision(input: RecordActorRoutingDecisionInput) {
        return { decisionId: "routing_test_2", ...input, createdAt: "2026-09-29T20:00:00.000Z" };
      },
      recordActorRoutingShadowObservation(input: Record<string, unknown>) {
        observations.push(input);
        release();
      }
    };

    const routed = routeAndPersistActor(
      [agent("zeta"), agent("alpha")],
      {
        requiredCapabilities: ["repository_write"],
        now: new Date("2026-08-18T00:01:00.000Z"),
        workItemId: "wrk_route_shadow_degraded",
        idempotencyKey: "route-shadow-degraded",
        jevShadow: {
          goal: "Implement the feature",
          options: {
            enabled: true,
            capabilityProfile: {
              promptVersion: "binary",
              supportsNoul: true,
              supportsChoice: false,
              supportsScore: false,
              fingerprint: ""
            },
            fetchImpl: fetchImpl as typeof fetch,
            sink: () => undefined
          }
        }
      },
      persistence,
      { via: "domain_service" }
    );

    expect(routed.decision.selected).toBe("alpha");
    await observed;
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(observations[0]).toMatchObject({
      deterministicSelectedActorId: "alpha",
      degraded: true,
      failureReason: "INCOMPATIBLE_MODEL"
    });
    expect(observations[0]).not.toHaveProperty("semanticSelectedActorId");
  });
});
