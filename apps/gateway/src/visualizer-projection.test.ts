import type { WorkItem } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import {
  VisualizerProjectionClient,
  visualizerBaseUrl,
  visualizerExecutionIdForAcsWorkItem
} from "./visualizer-projection.js";

function workItem(
  id = "wrk_test",
  updatedAt = "2026-09-23T14:00:00.000Z"
): WorkItem {
  return {
    id,
    title: "Project into Visualizer",
    requester: "user",
    status: "needs_approval",
    intent: "verify canonical projection",
    target: {},
    requestedActions: [],
    risk: "medium",
    createdAt: "2026-09-23T13:00:00.000Z",
    updatedAt
  };
}

function graph(executionId: string) {
  const root = "22222222-2222-5222-8222-222222222222";
  const approval = "33333333-3333-5333-8333-333333333333";
  return {
    schemaVersion: 2,
    revision: 4,
    eventPosition: 7,
    execution: {
      id: executionId,
      sourceRuntime: "codex",
      status: "waiting_approval",
      rootNodeId: root,
      finalOutputNodeId: null
    },
    nodes: [
      {
        id: root,
        nodeType: "user_request",
        status: "waiting_approval",
        label: "user request attempt 1",
        parentNodeId: null,
        summary: "must-not-cross-projection-boundary",
        metadata: { hidden: "must-not-cross-projection-boundary" }
      },
      {
        id: approval,
        nodeType: "approval_gate",
        status: "waiting_approval",
        label: "approval gate attempt 1",
        parentNodeId: root
      }
    ],
    edges: [{
      id: "44444444-4444-5444-8444-444444444444",
      fromNodeId: root,
      toNodeId: approval,
      edgeType: "approval",
      status: "active"
    }]
  };
}
describe("Visualizer projection boundary", () => {
  it("accepts only an explicit credential-free IPv4 loopback origin", () => {
    expect(visualizerBaseUrl("http://127.0.0.1:4174")).toBe(
      "http://127.0.0.1:4174"
    );
    for (const invalid of [
      "http://localhost:4174",
      "http://127.0.0.1",
      "https://127.0.0.1:4174",
      "http://127.0.0.1:4174/api",
      "http://user:pass@127.0.0.1:4174",
      "http://100.73.187.107:4174"
    ]) {
      expect(() => visualizerBaseUrl(invalid)).toThrow(
        "credential-free http://127.0.0.1:<port>"
      );
    }
  });

  it("pins the deterministic ACS to Visualizer execution identity contract", () => {
    expect(visualizerExecutionIdForAcsWorkItem("wrk_test")).toBe(
      "eeb1e8bf-4ed6-58b1-b84a-428f4541d5f3"
    );
    expect(visualizerExecutionIdForAcsWorkItem("wrk_test")).toBe(
      visualizerExecutionIdForAcsWorkItem("wrk_test")
    );
  });
  it("redacts ACS display text before it crosses the JSON projection boundary", async () => {
    const secret = "Bearer abcdefghijklmnop";
    const item = { ...workItem(), title: `Review ${secret}` };
    const client = new VisualizerProjectionClient({
      baseUrl: "http://127.0.0.1:4174",
      fetchImpl: (async () => new Response("{}", { status: 404 })) as typeof fetch
    });

    const result = await client.read([item]);

    expect(result.items[0]?.title).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("abcdefghijklmnop");
  });

  it("reads a narrow operational status without exposing unrelated Visualizer fields", async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    const client = new VisualizerProjectionClient({
      baseUrl: "http://127.0.0.1:4317",
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method });
        return new Response(JSON.stringify({
          schemaVersion: 1,
          generatedAt: "2026-09-23T16:20:00.000Z",
          status: "degraded",
          eventStreams: { activeClients: 2 },
          executions: { activeCount: 3, queueDepth: 1 },
          runtimes: [
            { runtime: "codex", status: "healthy", latencyMs: 4, checkedAt: "2026-09-23T16:19:59.000Z" },
            { runtime: "hermes", status: "healthy", latencyMs: 5, checkedAt: "2026-09-23T16:19:59.000Z" },
            { runtime: "openclaw", status: "degraded", latencyMs: 8, checkedAt: "2026-09-23T16:19:59.000Z" },
            { runtime: "opencode", status: "unknown", latencyMs: null, checkedAt: null },
            { runtime: "claude", status: "healthy", latencyMs: 7, checkedAt: "2026-09-23T16:19:59.000Z" },
            { runtime: "pi", status: "unavailable", latencyMs: null, checkedAt: "2026-09-23T16:19:59.000Z" }
          ],
          database: { availability: "available", secret: "must-not-cross" },
          approvals: { pendingCount: 2, oldestPendingWaitMs: 10 },
          api: { requestCount: 99 },
          hidden: "must-not-cross"
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch
    });

    const status = await client.status();

    expect(calls).toEqual([{
      url: "http://127.0.0.1:4317/api/v1/system-status",
      method: "GET"
    }]);
    expect(status).toMatchObject({
      configured: true,
      reachable: true,
      state: "degraded",
      sourceGeneratedAt: "2026-09-23T16:20:00.000Z",
      database: "available",
      activeExecutions: 3,
      queueDepth: 1,
      pendingApprovals: 2,
      eventStreamClients: 2
    });
    expect(status.runtimes).toHaveLength(6);
    expect(JSON.stringify(status)).not.toContain("must-not-cross");
  });

  it("fails closed on contradictory Visualizer health evidence", async () => {
    const client = new VisualizerProjectionClient({
      baseUrl: "http://127.0.0.1:4317",
      fetchImpl: (async () =>
        new Response(JSON.stringify({
          schemaVersion: 1,
          generatedAt: "2026-09-23T16:20:00.000Z",
          status: "healthy",
          eventStreams: { activeClients: 0 },
          executions: { activeCount: 0, queueDepth: 0 },
          runtimes: [
            { runtime: "codex", status: "unhealthy" },
            { runtime: "hermes", status: "healthy" },
            { runtime: "openclaw", status: "healthy" },
            { runtime: "opencode", status: "healthy" },
            { runtime: "claude", status: "healthy" },
            { runtime: "pi", status: "healthy" }
          ],
          database: { availability: "available" },
          approvals: { pendingCount: 0 }
        }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch
    });

    expect(await client.status()).toMatchObject({
      configured: true,
      reachable: true,
      state: "unavailable"
    });
  });

  it("distinguishes a reachable bad status response from a transport failure", async () => {
    const denied = new VisualizerProjectionClient({
      baseUrl: "http://127.0.0.1:4317",
      fetchImpl: (async () => new Response("{}", { status: 403 })) as typeof fetch
    });
    const offline = new VisualizerProjectionClient({
      baseUrl: "http://127.0.0.1:4317",
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as typeof fetch
    });

    expect(await denied.status()).toMatchObject({
      configured: true,
      reachable: true,
      state: "unavailable"
    });
    expect(await offline.status()).toMatchObject({
      configured: true,
      reachable: false,
      state: "unavailable"
    });
  });

  it("reads only the canonical Visualizer graph endpoint and sanitizes the response", async () => {
    const item = workItem();
    const executionId = visualizerExecutionIdForAcsWorkItem(item.id);
    const calls: Array<{ url: string; method: string | undefined }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method });
      return new Response(JSON.stringify(graph(executionId)), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;
    const client = new VisualizerProjectionClient({
      baseUrl: "http://127.0.0.1:4174",
      fetchImpl
    });

    const result = await client.read([item]);

    expect(calls).toEqual([{
      url: `http://127.0.0.1:4174/api/v1/executions/${executionId}/graph`,
      method: "GET"
    }]);
    expect(JSON.stringify(result)).not.toContain(
      "must-not-cross-projection-boundary"
    );
    expect(result.items[0]).toMatchObject({
      workItemId: "wrk_test",
      executionId,
      state: "available",
      projection: {
        revision: 4,
        sourceRuntime: "codex",
        status: "waiting_approval"
      }
    });
  });
  it("fails closed on noncanonical Visualizer graph categories", async () => {
    const item = workItem();
    const executionId = visualizerExecutionIdForAcsWorkItem(item.id);
    const invalid = graph(executionId);
    invalid.execution.sourceRuntime = "muse";

    const client = new VisualizerProjectionClient({
      baseUrl: "http://127.0.0.1:4317",
      fetchImpl: (async () =>
        new Response(JSON.stringify(invalid), {
          status: 200,
          headers: { "content-type": "application/json" }
        })) as typeof fetch
    });

    expect((await client.read([item])).items[0]?.state).toBe("unavailable");
  });

  it("fails closed when canonical graph edges reference missing nodes", async () => {
    const item = workItem();
    const executionId = visualizerExecutionIdForAcsWorkItem(item.id);
    const invalid = graph(executionId);
    invalid.edges[0]!.toNodeId = "55555555-5555-5555-8555-555555555555";

    const client = new VisualizerProjectionClient({
      baseUrl: "http://127.0.0.1:4317",
      fetchImpl: (async () =>
        new Response(JSON.stringify(invalid), {
          status: 200,
          headers: { "content-type": "application/json" }
        })) as typeof fetch
    });

    expect((await client.read([item])).items[0]?.state).toBe("unavailable");
  });

  it("distinguishes a missing canonical projection from Visualizer failure", async () => {
    const item = workItem();
    const missing = new VisualizerProjectionClient({
      baseUrl: "http://127.0.0.1:4174",
      fetchImpl: (async () => new Response("{}", { status: 404 })) as typeof fetch
    });
    const failing = new VisualizerProjectionClient({
      baseUrl: "http://127.0.0.1:4174",
      fetchImpl: (async () => new Response("{}", { status: 503 })) as typeof fetch
    });

    expect((await missing.read([item])).items[0]?.state).toBe(
      "not_projected"
    );
    expect((await failing.read([item])).items[0]?.state).toBe("unavailable");
  });

  it("caps one projection read to the newest twenty ACS work items", async () => {
    let calls = 0;
    const client = new VisualizerProjectionClient({
      baseUrl: "http://127.0.0.1:4174",
      fetchImpl: (async () => {
        calls += 1;
        return new Response("{}", { status: 404 });
      }) as typeof fetch
    });
    const items = Array.from({ length: 25 }, (_, index) =>
      workItem(
        `wrk_${index}`,
        new Date(Date.parse("2026-09-23T14:00:00.000Z") + index * 1000)
          .toISOString()
      )
    );

    const result = await client.read(items, 100);

    expect(result.items).toHaveLength(20);
    expect(calls).toBe(20);
    expect(result.items[0]?.workItemId).toBe("wrk_24");
    expect(result.items.at(-1)?.workItemId).toBe("wrk_5");
  });
});
