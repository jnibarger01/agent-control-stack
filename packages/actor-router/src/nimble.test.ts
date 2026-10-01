import type {
  ActorRoutingDecision as PersistedActorRoutingDecision,
  RecordActorRoutingDecisionInput,
  RegistryAgentDetail
} from "@agent-control-stack/work-items";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NIMBLE_ROUTING_THRESHOLD,
  evaluateNimbleCandidate,
  routeNimbleActor,
  type NimbleRoutingState
} from "./nimble.js";

const now = new Date("2026-10-01T12:00:00.000Z");

function agent(id: string, overrides: Partial<RegistryAgentDetail> = {}): RegistryAgentDetail {
  return {
    id,
    name: id,
    kind: "repository_write",
    acpRole: "IMPLEMENTATION_AGENT",
    status: "AVAILABLE",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    createdByActorId: "system",
    updatedByActorId: "system",
    lastHeartbeatAt: now.toISOString(),
    capabilities: [
      {
        id: `${id}-cap`,
        agentId: id,
        name: "repository_write",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        createdByActorId: "system",
        updatedByActorId: "system"
      }
    ],
    ...overrides
  };
}

function state(candidateAgent: string, instructions = "inspect ACS routing"): NimbleRoutingState {
  return {
    work_item_id: "work-1",
    title: "Investigate failing agent route",
    instructions,
    requested_action_kind: "repository_write",
    requested_action_description: "inspect runtime and add a regression test",
    target_service: "acs",
    candidate_agent: candidateAgent,
    candidate_role: "IMPLEMENTATION_AGENT",
    candidate_capabilities: ["repository_write"]
  };
}

function response(score: number, model = "nimble:latest"): Response {
  return new Response(JSON.stringify({ model, answers: { appropriate: { type: "noul", noul: score } } }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function persistence() {
  return {
    recordActorRoutingDecision: vi.fn((input: RecordActorRoutingDecisionInput): PersistedActorRoutingDecision => ({
      ...input,
      decisionId: "routing-1",
      createdAt: now.toISOString()
    }))
  };
}

describe("Nimble semantic actor routing", () => {
  it("uses the local TypeSafe Noul contract, redacts secrets, and compares unrounded scores", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return response(0.8);
    };
    const matched = await evaluateNimbleCandidate(state("platform", "Inspect ACS; API_KEY=secret-value-123"), {
      agentId: "platform",
      fetchImpl,
      timeoutMs: 100
    });
    const request = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(calls[0]?.url).toBe("http://127.0.0.1:11434/v1/systemone");
    expect(request).toMatchObject({
      model: "nimble:latest",
      questions: { appropriate: { type: "noul", instructions: expect.any(String) } }
    });
    expect(JSON.stringify(request)).not.toContain("secret-value-123");
    expect(matched).toMatchObject({ agentId: "platform", score: 0.8, status: "MATCH", model: "nimble:latest" });

    const below = await evaluateNimbleCandidate(state("backend"), {
      agentId: "backend",
      fetchImpl: async () => response(0.799999999),
      timeoutMs: 100
    });
    expect(below).toMatchObject({ score: 0.799999999, status: "NO_MATCH" });
    expect(DEFAULT_NIMBLE_ROUTING_THRESHOLD).toBe(0.8);
  });

  it.each([
    ["malformed answer", async () => new Response(JSON.stringify({ model: "nimble:latest", answers: {} }))],
    [
      "missing score",
      async () => new Response(JSON.stringify({ model: "nimble:latest", answers: { appropriate: { type: "noul" } } }))
    ],
    ["out of range", async () => response(1.1)],
    [
      "unavailable endpoint",
      async () => {
        throw new Error("network failure");
      }
    ]
  ])("fails closed for %s", async (_name, fetchImpl) => {
    const result = await evaluateNimbleCandidate(state("platform"), {
      agentId: "platform",
      fetchImpl: fetchImpl as typeof fetch,
      timeoutMs: 50
    });
    expect(result.status).toBe("DEGRADED");
    expect(result.score).toBeUndefined();
  });

  it("marks an aborted request degraded with a timeout reason", async () => {
    const result = await evaluateNimbleCandidate(state("platform"), {
      agentId: "platform",
      timeoutMs: 5,
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
            once: true
          });
        })
    });
    expect(result).toMatchObject({ status: "DEGRADED", failureReason: "timeout" });
  });

  it("sends only hard-eligible agents to Nimble and never promotes unavailable agents", async () => {
    const calls: string[] = [];
    const store = persistence();
    const result = await routeNimbleActor(
      {
        agents: [
          agent("available"),
          agent("offline", { status: "OFFLINE" }),
          agent("missing-capability", { capabilities: [] }),
          agent("no-worker-path")
        ],
        workItemId: "work-1",
        idempotencyKey: "route-test-1",
        requiredCapabilities: ["repository_write"],
        now,
        freeCapacity: { available: 1, offline: 1, "missing-capability": 1, "no-worker-path": 0 },
        stateForAgent: (candidate) => {
          calls.push(candidate.id);
          return state(candidate.id);
        }
      },
      { fetchImpl: async () => response(0.95) },
      store,
      { via: "domain_service", actorId: "dispatcher" }
    );
    expect(calls).toEqual(["available"]);
    expect(result.selectedAgentId).toBe("available");
    expect(result.decision.excluded.offline).toContain("availability: OFFLINE");
    expect(result.decision.excluded["missing-capability"]).toContain("missing capability: repository_write");
  });

  it("keeps model failures candidate-local and uses stable ACS tie-breaking among matches", async () => {
    const store = persistence();
    const scores: Record<string, number> = { beta: 0.99, alpha: 0.81, failed: 0 };
    const run = () =>
      routeNimbleActor(
        {
          agents: [agent("beta"), agent("alpha"), agent("failed")],
          workItemId: "work-1",
          idempotencyKey: createKey(),
          requiredCapabilities: ["repository_write"],
          now,
          stateForAgent: (candidate) => state(candidate.id)
        },
        {
          fetchImpl: async (_input, init) => {
            const body = JSON.parse(String(init?.body ?? "{}"));
            const id = (body.state as { candidate_agent: string }).candidate_agent;
            if (id === "failed") throw new Error("offline");
            return response(scores[id] ?? 0);
          }
        },
        store,
        { via: "domain_service", actorId: "dispatcher" }
      );
    const first = await run();
    const second = await run();
    expect(first.candidates.find((candidate) => candidate.agentId === "failed")?.status).toBe("DEGRADED");
    expect(first.selectedAgentId).toBe("alpha");
    expect(second.selectedAgentId).toBe("alpha");
    expect(first.persisted?.selectedActorId).toBe("alpha");
    expect(first.state).toBe("SELECTED");
  });

  it("persists explicit no-match and degraded decisions without selecting anyone", async () => {
    const store = persistence();
    const noMatch = await routeNimbleActor(
      {
        agents: [agent("alpha")],
        workItemId: "work-1",
        idempotencyKey: "no-match",
        requiredCapabilities: ["repository_write"],
        now,
        stateForAgent: (candidate) => state(candidate.id)
      },
      { fetchImpl: async () => response(0.3) },
      store,
      { via: "domain_service", actorId: "dispatcher" }
    );
    expect(noMatch.state).toBe("NO_SEMANTIC_MATCH");
    expect(noMatch.selectedAgentId).toBeUndefined();
    expect(noMatch.persisted?.selectedActorId).toBeUndefined();

    const degraded = await routeNimbleActor(
      {
        agents: [agent("alpha")],
        workItemId: "work-2",
        idempotencyKey: "degraded",
        requiredCapabilities: ["repository_write"],
        now,
        stateForAgent: (candidate) => state(candidate.id)
      },
      {
        fetchImpl: async () => {
          throw new Error("unavailable");
        }
      },
      store,
      { via: "domain_service", actorId: "dispatcher" }
    );
    expect(degraded.state).toBe("DEGRADED");
    expect(degraded.selectedAgentId).toBeUndefined();
  });
});

let keyCounter = 0;
function createKey(): string {
  keyCounter += 1;
  return `route-test-${keyCounter}`;
}
