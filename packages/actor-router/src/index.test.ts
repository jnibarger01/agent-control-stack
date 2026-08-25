import { describe, expect, it } from "vitest";
import type { RegistryAgentDetail } from "@agent-control-stack/work-items";
import { routeActor } from "./index.js";

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
    capabilities: [{ id: `${id}-cap`, agentId: id, name: "repository_write", createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z", createdByActorId: "system", updatedByActorId: "system" }],
    ...overrides
  };
}

describe("routeActor", () => {
  it("applies hard gates and returns explicit exclusion reasons", () => {
    const decision = routeActor([
      agent("good"),
      agent("stale", { lastHeartbeatAt: "2020-01-01T00:00:00.000Z" }),
      agent("wrong-cap", { capabilities: [] }),
      agent("busy", { status: "BUSY" })
    ], {
      requiredCapabilities: ["repository_write"],
      now: new Date("2026-08-18T00:01:00.000Z")
    });

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
});
