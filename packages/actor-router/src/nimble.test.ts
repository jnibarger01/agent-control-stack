import { describe, expect, it } from "vitest";
import type { RegistryAgentDetail } from "@agent-control-stack/work-items";
import { evaluateNimbleCandidate, routeNimbleActor, type NimbleRoutingStateInput } from "./nimble.js";

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
    lastHeartbeatAt: "2026-10-02T12:00:00.000Z",
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

function state(agentId: string): NimbleRoutingStateInput {
  return {
    title: "Update repository",
    intent: "Implement and review a code change",
    requestedActionKinds: ["repository_write"],
    requestedActionDescriptions: ["edit application files"],
    targetServices: [],
    targetRepositories: ["example/repository"],
    candidateAgentId: agentId,
    candidateRole: "IMPLEMENTATION_AGENT",
    candidateDescription: "coding agent",
    candidateCapabilities: ["repository_write"]
  };
}

function options(scores: Record<string, number>, extra: { concurrency?: number; maxCandidates?: number } = {}) {
  return {
    concurrency: extra.concurrency ?? 4,
    maxCandidates: extra.maxCandidates ?? 8,
    fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { state: { candidate_agent_id: string } };
      return new Response(
        JSON.stringify({
          model: "nimble:latest",
          answers: { appropriate: { type: "noul", noul: scores[request.state.candidate_agent_id] } }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
  };
}

describe("routeNimbleActor", () => {
  it("selects the highest Nimble score among hard-eligible agents, independent of heuristic score", async () => {
    const result = await routeNimbleActor(
      {
        agents: [agent("heuristic-winner"), agent("semantic-winner")],
        requiredCapabilities: ["repository_write"],
        taskType: "coding",
        freeCapacity: { "heuristic-winner": 1, "semantic-winner": 1 },
        now: new Date("2026-10-02T12:00:01.000Z"),
        stateForAgent: (candidate) => state(candidate.id)
      },
      options({ "heuristic-winner": 0.81, "semantic-winner": 0.96 })
    );

    expect(result.state).toBe("SELECTED");
    expect(result.selectedAgentId).toBe("semantic-winner");
    expect(result.decision.scores).toEqual({ "heuristic-winner": 8100, "semantic-winner": 9600 });
  });

  it("never sends an ineligible candidate to Nimble and reports the hard exclusion first", async () => {
    const requested: string[] = [];
    const result = await routeNimbleActor(
      {
        agents: [agent("allowed"), agent("forbidden")],
        requiredCapabilities: ["repository_write"],
        now: new Date("2026-10-02T12:00:01.000Z"),
        policyEligible: (candidate) => candidate.id !== "forbidden",
        stateForAgent: (candidate) => state(candidate.id),
        onEligibility: (eligible, excluded) => {
          expect(eligible).toEqual(["allowed"]);
          expect(excluded.forbidden).toContain("policy ineligible");
        }
      },
      {
        ...options({ allowed: 0.9, forbidden: 1 }),
        fetchImpl: async (_url, init) => {
          requested.push(JSON.parse(String(init?.body)).state.candidate_agent_id);
          return new Response(
            JSON.stringify({ model: "nimble:latest", answers: { appropriate: { type: "noul", noul: 0.9 } } })
          );
        }
      }
    );

    expect(result.selectedAgentId).toBe("allowed");
    expect(requested).toEqual(["allowed"]);
  });

  it("fails closed below threshold and when the candidate cap is exceeded", async () => {
    const input = {
      agents: [agent("a"), agent("b")],
      requiredCapabilities: ["repository_write"],
      now: new Date("2026-10-02T12:00:01.000Z"),
      stateForAgent: (candidate: RegistryAgentDetail) => state(candidate.id)
    };
    const below = await routeNimbleActor(input, options({ a: 0.79, b: 0.79 }));
    const boundary = await routeNimbleActor(input, options({ a: 0.8, b: 0.79 }));
    const capped = await routeNimbleActor(input, { ...options({ a: 0.99, b: 0.99 }), maxCandidates: 1 });

    expect(below.state).toBe("NO_SEMANTIC_MATCH");
    expect(below.selectedAgentId).toBeUndefined();
    expect(boundary.selectedAgentId).toBe("a");
    expect(capped.state).toBe("CANDIDATE_LIMIT_EXCEEDED");
    expect(capped.candidates).toEqual([]);
  });

  it.each([
    {
      label: "model mismatch",
      fetchImpl: async () =>
        new Response(JSON.stringify({ model: "other-model", answers: { appropriate: { type: "noul", noul: 1 } } })),
      expected: "MODEL_INVALID_RESPONSE"
    },
    {
      label: "malformed output",
      fetchImpl: async () => new Response("not-json"),
      expected: "MODEL_INVALID_RESPONSE"
    },
    {
      label: "timeout",
      fetchImpl: async () => {
        const error = new Error("timeout");
        error.name = "AbortError";
        throw error;
      },
      expected: "MODEL_TIMEOUT"
    }
  ])("fails closed on $label", async ({ fetchImpl, expected }) => {
    const result = await routeNimbleActor(
      {
        agents: [agent("candidate")],
        requiredCapabilities: ["repository_write"],
        now: new Date("2026-10-02T12:00:01.000Z"),
        stateForAgent: (candidate) => state(candidate.id)
      },
      { fetchImpl }
    );
    expect(result.state).toBe(expected);
    expect(result.selectedAgentId).toBeUndefined();
  });

  it("uses deterministic agent ID tie breaking and fails the whole route on model errors", async () => {
    const input = {
      agents: [agent("zeta"), agent("alpha")],
      requiredCapabilities: ["repository_write"],
      now: new Date("2026-10-02T12:00:01.000Z"),
      stateForAgent: (candidate: RegistryAgentDetail) => state(candidate.id)
    };
    const tied = await routeNimbleActor(input, options({ alpha: 0.9, zeta: 0.9 }));
    const failed = await routeNimbleActor(input, {
      fetchImpl: async () => new Response("offline", { status: 503 })
    });

    expect(tied.selectedAgentId).toBe("alpha");
    expect(failed.state).toBe("MODEL_UNAVAILABLE");
    expect(failed.selectedAgentId).toBeUndefined();
  });

  it("sends only bounded redacted descriptive state and honors the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const requestBodies: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      active += 1;
      peak = Math.max(peak, active);
      requestBodies.push(String(init?.body));
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response(
        JSON.stringify({
          model: "nimble:latest",
          answers: { appropriate: { type: "noul", noul: 0.9 } }
        })
      );
    };
    const result = await routeNimbleActor(
      {
        agents: [agent("a"), agent("b"), agent("c"), agent("d")],
        requiredCapabilities: ["repository_write"],
        now: new Date("2026-10-02T12:00:01.000Z"),
        stateForAgent: (candidate) => ({ ...state(candidate.id), intent: "token=super-secret-value" })
      },
      { concurrency: 2, fetchImpl }
    );
    const candidate = await evaluateNimbleCandidate(
      { ...state("a"), intent: "token=super-secret-value" },
      {
        agentId: "a",
        fetchImpl: async (_url, init) => {
          requestBodies.push(String(init?.body));
          return new Response(
            JSON.stringify({
              model: "nimble:latest",
              answers: { appropriate: { type: "noul", noul: 0.9 } }
            })
          );
        }
      }
    );

    expect(result.state).toBe("SELECTED");
    expect(peak).toBe(2);
    expect(candidate.status).toBe("MATCH");
    expect(requestBodies.join("\n")).not.toContain("super-secret-value");
    const payload = JSON.parse(requestBodies[0]!) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("workItemId");
    expect(payload).not.toHaveProperty("params");
    expect(payload).not.toHaveProperty("env");
    expect(payload).not.toHaveProperty("authorization");
  });
});
