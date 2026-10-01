import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore, WorkerIdentityRegistry } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGateway } from "./server.js";
import { dispatchApprovedWorkItem, parseAgentWorkerBindings } from "./semantic-dispatch.js";
import { createPolicyEngine } from "@agent-control-stack/policy-gate";

const roots: string[] = [];
const OP_TOKEN = "routing-dispatch-operator-token-0123456789";
const WORKER_TOKEN = "routing-worker-token-012345678901234567890";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "acs-semantic-routing-"));
  roots.push(root);
  const dbPath = join(root, "control.db");
  const store = new SqliteWorkItemStore(dbPath);
  store.registerActor({ id: "dispatcher", actorType: "SERVICE", displayName: "Routing dispatcher" });
  store.createRegistryAgent({
    id: "infra-platform",
    name: "Infrastructure platform",
    kind: "repository_write",
    acpRole: "IMPLEMENTATION_AGENT",
    status: "AVAILABLE",
    actorId: "dispatcher"
  });
  store.replaceAgentCapabilities("infra-platform", [{ name: "fs.read" }], "dispatcher");
  store.recordAgentHeartbeat("infra-platform", { status: "AVAILABLE", actorId: "dispatcher" });
  const item = store.create({
    title: "Investigate failing agent route",
    requester: "user",
    requesterSubject: "operator",
    intent: "Inspect ACS runtime, routing, service health, logs, and worker state.",
    target: { cwd: root, services: ["acs-gateway"] },
    requestedActions: [{ kind: "fs.read", description: "inspect ACS routing files", params: { paths: ["README.md"] } }],
    risk: "low"
  });
  store.approveWorkItem(item.id, { via: "domain_service" });
  store.close();
  const identities = new WorkerIdentityRegistry();
  identities.issue({ workerId: "worker-infra-7", ttlMs: 60_000, token: WORKER_TOKEN });
  return { root, dbPath, item, identities };
}

function appFor(
  state: ReturnType<typeof fixture>,
  fetchImpl: typeof fetch,
  bindings: Readonly<Record<string, string>> = { "infra-platform": "worker-infra-7" }
) {
  return buildGateway({
    dbPath: state.dbPath,
    logger: false,
    auth: {
      token: "unused-gateway-token-0123456789",
      actor: "system",
      credentials: [
        {
          id: "dispatcher",
          token: OP_TOKEN,
          actor: "system",
          actorId: "dispatcher",
          roles: ["service"],
          scopes: ["acs:write", "acs:read"]
        }
      ],
      workerIdentities: state.identities
    },
    nimbleRouting: { agentWorkerBindings: bindings, fetchImpl, timeoutMs: 100 }
  });
}

function noul(score: number): Response {
  return new Response(
    JSON.stringify({ model: "nimble:test", answers: { appropriate: { type: "noul", noul: score } } }),
    {
      status: 200,
      headers: { "content-type": "application/json" }
    }
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Nimble pre-claim dispatch", () => {
  it("routes through actor-router, persists the agent-worker binding, then allows only that worker to claim", async () => {
    const state = fixture();
    let sent: Record<string, unknown> | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return noul(0.94);
    };
    const app = appFor(state, fetchImpl);
    try {
      const routed = await app.inject({
        method: "POST",
        url: "/routing/dispatch",
        headers: { authorization: `Bearer ${OP_TOKEN}` },
        payload: { workItemId: state.item.id }
      });
      expect(routed.statusCode).toBe(200);
      expect(routed.json()).toMatchObject({
        state: "SELECTED",
        workItemId: state.item.id,
        selectedAgentId: "infra-platform",
        selectedWorkerId: "worker-infra-7"
      });
      expect(JSON.stringify(sent)).not.toContain("authorization");
      expect(sent).toMatchObject({ model: "nimble:latest", questions: { appropriate: { type: "noul" } } });

      const wrongWorker = await app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: "Bearer other-worker-token-012345678901234567" },
        payload: {}
      });
      expect(wrongWorker.statusCode).toBe(401);
      const otherIdentity = state.identities.issue({
        workerId: "worker-other",
        ttlMs: 60_000,
        token: "other-worker-token-012345678901234567"
      });
      expect(otherIdentity.workerId).toBe("worker-other");
      const denied = await app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: `Bearer ${otherIdentity.token}` },
        payload: {}
      });
      expect(denied.statusCode).toBe(200);
      expect(denied.json()).toEqual({ claimed: false });

      const claimed = await app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        payload: {}
      });
      expect(claimed.statusCode).toBe(200);
      expect(claimed.json()).toMatchObject({
        claimed: true,
        workItem: { id: state.item.id, workerId: "worker-infra-7", status: "running" }
      });
      const persisted = new SqliteWorkItemStore(state.dbPath);
      try {
        const assignment = persisted.getWorkItemAssignment(state.item.id);
        expect(assignment).toMatchObject({ selectedAgentId: "infra-platform", selectedWorkerId: "worker-infra-7" });
        expect(persisted.getActorRoutingDecision(assignment!.routingDecisionId!)?.selectedActorId).toBe(
          "infra-platform"
        );
        expect(persisted.countActiveAttemptLeases(new Date())).toBe(1);
        const claimedAttemptId = (claimed.json() as { workItem: { attemptId: string } }).workItem.attemptId;
        expect(persisted.getAttempt(claimedAttemptId)?.status).toBe("running");
        expect(persisted.readEvents({ workItemId: state.item.id }).map((event) => event.name)).toEqual(
          expect.arrayContaining([
            "agent.routing.started",
            "agent.routing.candidate_evaluated",
            "agent.routing.selected",
            "work_item.worker_assigned",
            "work_item.running",
            "execution_attempt.created"
          ])
        );
      } finally {
        persisted.close();
      }
      const duplicate = await app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        payload: {}
      });
      expect(duplicate.json()).toEqual({ claimed: false });
    } finally {
      await app.close();
    }
  });

  it("does not assign or claim when no candidate reaches the threshold", async () => {
    const state = fixture();
    const app = appFor(state, async () => noul(0.799));
    try {
      const routed = await app.inject({
        method: "POST",
        url: "/routing/dispatch",
        headers: { authorization: `Bearer ${OP_TOKEN}` },
        payload: { workItemId: state.item.id }
      });
      expect(routed.json()).toMatchObject({ state: "NO_SEMANTIC_MATCH" });
      const claim = await app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        payload: {}
      });
      expect(claim.json()).toEqual({ claimed: false });
      const store = new SqliteWorkItemStore(state.dbPath);
      try {
        expect(store.getWorkItemAssignment(state.item.id)).toBeUndefined();
        expect(store.get(state.item.id)?.status).toBe("approved");
        expect(store.countActiveAttemptLeases()).toBe(0);
      } finally {
        store.close();
      }
    } finally {
      await app.close();
    }
  });

  it("does not ask Nimble about an agent without a valid authenticated worker path", async () => {
    const state = fixture();
    const fetchImpl = vi.fn(async () => noul(0.99));
    const app = appFor(state, fetchImpl, { "infra-platform": "unregistered-worker" });
    try {
      const routed = await app.inject({
        method: "POST",
        url: "/routing/dispatch",
        headers: { authorization: `Bearer ${OP_TOKEN}` },
        payload: { workItemId: state.item.id }
      });
      expect(routed.json()).toMatchObject({ state: "NO_ELIGIBLE_AGENTS" });
      expect(fetchImpl).not.toHaveBeenCalled();
      const claim = await app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        payload: {}
      });
      expect(claim.json()).toEqual({ claimed: false });
    } finally {
      await app.close();
    }
  });

  it("rejects routing requests without operator or service authority", async () => {
    const state = fixture();
    const app = appFor(state, async () => noul(0.99));
    try {
      const result = await app.inject({
        method: "POST",
        url: "/routing/dispatch",
        headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        payload: { workItemId: state.item.id }
      });
      expect(result.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("validates explicit agent-to-worker mappings", () => {
    expect(parseAgentWorkerBindings('{"agent-a":"worker-7"}')).toEqual({ "agent-a": "worker-7" });
    expect(() => parseAgentWorkerBindings('{"agent-a":"bad worker"}')).toThrow(/invalid agent or worker ID/);
    expect(() => parseAgentWorkerBindings("[]")).toThrow(/JSON object/);
  });

  it("does not route policy-ineligible candidates and leaves the item retryable", async () => {
    const state = fixture();
    const store = new SqliteWorkItemStore(state.dbPath);
    const item = store.get(state.item.id)!;
    const fetchImpl = vi.fn(async () => noul(0.99));
    try {
      // A destructive action remains governed by the normal policy evaluator even when semantic fit is high.
      const result = await dispatchApprovedWorkItem({
        store,
        policy: createPolicyEngine(),
        workItem: {
          ...item,
          risk: "critical",
          requestedActions: [
            { kind: "fs.read", description: "read", params: { destructive: true, paths: ["README.md"] } }
          ]
        },
        actorId: "dispatcher",
        options: { agentWorkerBindings: { "infra-platform": "worker-infra-7" }, fetchImpl, timeoutMs: 50 },
        isWorkerDispatchable: () => true
      });
      expect(result.state).toBe("NO_ELIGIBLE_AGENTS");
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(store.getWorkItemAssignment(item.id)).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
