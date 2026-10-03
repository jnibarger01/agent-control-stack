import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteWorkItemStore, WorkerIdentityRegistry } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it } from "vitest";
import { buildGateway } from "./server.js";

describe("authenticated worker claims", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("derives worker identity from credentials and enforces assignment before claim", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-worker-claim-"));
    directories.push(directory);
    const dbPath = join(directory, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    const item = store.create({
      title: "Assigned claim fixture",
      requester: "user",
      requesterSubject: "operator",
      intent: "claim only under the assigned worker identity",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["README.md"] } }],
      risk: "low"
    });
    store.approveWorkItem(item.id, { via: "domain_service" });
    store.assignWorkItem(
      {
        workItemId: item.id,
        selectedWorkerId: "worker-b",
        assignedByActorId: "operator"
      },
      { via: "domain_service", actorId: "operator" }
    );
    store.close();

    const identities = new WorkerIdentityRegistry();
    const workerA = identities.issue({
      workerId: "worker-a",
      ttlMs: 60_000,
      token: "worker-a-token-012345678901234567890123"
    });
    const workerB = identities.issue({
      workerId: "worker-b",
      ttlMs: 60_000,
      token: "worker-b-token-012345678901234567890123"
    });
    const app = buildGateway({
      dbPath,
      logger: false,
      auth: { token: "unused-static-token", actor: "user", workerIdentities: identities }
    });

    try {
      await app.ready();
      const spoofed = await app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: `Bearer ${workerA.token}` },
        payload: { workerId: "worker-b" }
      });
      expect(spoofed.statusCode).toBe(400);

      const wrongWorker = await app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: `Bearer ${workerA.token}` },
        payload: {}
      });
      expect(wrongWorker.statusCode).toBe(200);
      expect(wrongWorker.json()).toEqual({ claimed: false });

      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(db.prepare("SELECT status FROM work_items WHERE id = ?").get(item.id)).toEqual({ status: "approved" });
        expect(db.prepare("SELECT COUNT(*) AS count FROM attempt_leases WHERE work_item_id = ?").get(item.id)).toEqual({
          count: 0
        });
        expect(
          db.prepare("SELECT COUNT(*) AS count FROM execution_attempts WHERE work_item_id = ?").get(item.id)
        ).toEqual({ count: 0 });
      } finally {
        db.close();
      }

      const matchingWorker = await app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: `Bearer ${workerB.token}` },
        payload: {}
      });
      expect(matchingWorker.statusCode).toBe(200);
      expect(matchingWorker.json()).toMatchObject({
        claimed: true,
        workItem: { id: item.id, workerId: "worker-b", status: "running" }
      });

      const unknown = await app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: "Bearer unregistered-worker-token-012345678901234567890" },
        payload: {}
      });
      expect(unknown.statusCode).toBe(401);

      identities.revoke({ workerId: "worker-a", token: workerA.token });
      const disabled = await app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: `Bearer ${workerA.token}` },
        payload: {}
      });
      expect(disabled.statusCode).toBe(401);

      const check = new SqliteWorkItemStore(dbPath);
      try {
        expect(check.get(item.id)?.status).toBe("running");
        expect(check.getWorkItemAssignment(item.id)?.selectedWorkerId).toBe("worker-b");
        expect(() =>
          check.assignWorkItem(
            {
              workItemId: item.id,
              selectedWorkerId: "worker-a",
              assignedByActorId: "operator"
            },
            { via: "domain_service", actorId: "operator" }
          )
        ).toThrow(/current state/);
        expect(check.getWorkItemAssignment(item.id)?.selectedWorkerId).toBe("worker-b");
        expect(check.verifyAuditChain()).toMatchObject({ ok: true });
      } finally {
        check.close();
      }
    } finally {
      await app.close();
    }
  });

  it("routes authenticated production claims through Nimble before issuing a lease", async () => {
    const priorEnabled = process.env.ACS_NIMBLE_ROUTING_ENABLED;
    const priorFetch = globalThis.fetch;
    process.env.ACS_NIMBLE_ROUTING_ENABLED = "1";
    const directory = mkdtempSync(join(tmpdir(), "acs-worker-claim-nimble-"));
    directories.push(directory);
    const dbPath = join(directory, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    const actorId = "actor_system_bootstrap";
    const observedAt = new Date();
    try {
      for (const id of ["alpha", "beta"]) {
        store.createRegistryAgent({
          id,
          name: id,
          kind: "repository_read",
          acpRole: "IMPLEMENTATION_AGENT",
          provider: "local",
          model: `${id}-model`,
          status: "AVAILABLE",
          actorId
        });
        store.replaceAgentCapabilities(id, [{ name: "fs.read" }], actorId);
        store.recordAgentHeartbeat(id, { status: "AVAILABLE", actorId, now: observedAt });
      }
      const item = store.create({
        title: "Routed claim fixture",
        requester: "user",
        requesterSubject: "operator",
        intent: "claim only after the authoritative Nimble decision",
        target: { cwd: "/repo", services: ["alpha", "beta"] },
        requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["README.md"] } }],
        risk: "low"
      });
      store.approveWorkItem(item.id, { via: "domain_service" });
      store.close();

      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        return new Response(
          JSON.stringify({
            model: "nimble:latest",
            answers: {
              executor: {
                type: "choice",
                choice: "beta",
                confidence: 0.95,
                probabilities: { alpha: 0.05, beta: 0.95 }
              }
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      };

      const identities = new WorkerIdentityRegistry();
      const alpha = identities.issue({
        workerId: "alpha",
        ttlMs: 60_000,
        token: "alpha-worker-token-012345678901234567890123"
      });
      const beta = identities.issue({
        workerId: "beta",
        ttlMs: 60_000,
        token: "beta-worker-token-0123456789012345678901234"
      });
      const app = buildGateway({
        dbPath,
        logger: false,
        auth: { token: "unused-static-token", actor: "user", workerIdentities: identities }
      });
      try {
        await app.ready();
        const wrongWorker = await app.inject({
          method: "POST",
          url: "/worker/claim",
          headers: { authorization: `Bearer ${alpha.token}` },
          payload: { leaseMs: 10_000 }
        });
        expect(wrongWorker.statusCode).toBe(200);
        expect(wrongWorker.json()).toEqual({ claimed: false });

        const afterRoute = new SqliteWorkItemStore(dbPath);
        try {
          expect(afterRoute.getLatestAuthoritativeRoutingEvidence(item.id)).toMatchObject({
            decision: "route",
            source: "nimble",
            selectedActorId: "beta"
          });
          expect(afterRoute.get(item.id)?.status).toBe("approved");
        } finally {
          afterRoute.close();
        }

        const selected = await app.inject({
          method: "POST",
          url: "/worker/claim",
          headers: { authorization: `Bearer ${beta.token}` },
          payload: { leaseMs: 10_000 }
        });
        expect(selected.statusCode).toBe(200);
        expect(selected.json()).toMatchObject({
          claimed: true,
          workItem: { id: item.id, workerId: "beta", status: "running" }
        });
        expect(calls).toBe(1);
      } finally {
        await app.close();
      }
    } finally {
      globalThis.fetch = priorFetch;
      if (priorEnabled === undefined) delete process.env.ACS_NIMBLE_ROUTING_ENABLED;
      else process.env.ACS_NIMBLE_ROUTING_ENABLED = priorEnabled;
    }
  });

  it("serializes concurrent authenticated polls to one claim and one attempt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-worker-claim-race-"));
    directories.push(directory);
    const dbPath = join(directory, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    const item = store.create({
      title: "Concurrent worker claim fixture",
      requester: "user",
      requesterSubject: "operator",
      intent: "only one poll may win the atomic claim",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["README.md"] } }],
      risk: "low"
    });
    store.approveWorkItem(item.id, { via: "domain_service" });
    store.close();

    const identities = new WorkerIdentityRegistry();
    const issued = identities.issue({
      workerId: "worker-race",
      ttlMs: 60_000,
      token: "worker-race-token-01234567890123456789012"
    });
    const app = buildGateway({
      dbPath,
      logger: false,
      auth: { token: "unused-static-token", actor: "user", workerIdentities: identities }
    });
    try {
      await app.ready();
      const responses = await Promise.all(
        [1, 2].map(() =>
          app.inject({
            method: "POST",
            url: "/worker/claim",
            headers: { authorization: `Bearer ${issued.token}` },
            payload: {}
          })
        )
      );
      expect(responses.filter((response) => response.json().claimed === true)).toHaveLength(1);
      expect(responses.filter((response) => response.json().claimed === false)).toHaveLength(1);
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(db.prepare("SELECT status, worker_id FROM work_items WHERE id = ?").get(item.id)).toEqual({
          status: "running",
          worker_id: "worker-race"
        });
        expect(db.prepare("SELECT COUNT(*) AS count FROM attempt_leases WHERE work_item_id = ?").get(item.id)).toEqual({
          count: 1
        });
        expect(
          db.prepare("SELECT COUNT(*) AS count FROM execution_attempts WHERE work_item_id = ?").get(item.id)
        ).toEqual({ count: 1 });
      } finally {
        db.close();
      }
    } finally {
      await app.close();
    }
  });

  it("rate limits claim polling per credential while keeping normal polling available", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-worker-claim-rate-"));
    directories.push(directory);
    const dbPath = join(directory, "control.db");
    const identities = new WorkerIdentityRegistry();
    const issued = identities.issue({
      workerId: "worker-rate",
      ttlMs: 60_000,
      token: "worker-rate-token-0123456789012345678901"
    });
    // A deliberately small budget makes the limit observable deterministically.
    const app = buildGateway({
      dbPath,
      logger: false,
      rateLimit: { windowMs: 60_000, maxRequests: 5 },
      auth: { token: "unused-static-token", actor: "user", workerIdentities: identities }
    });
    try {
      await app.ready();
      const claim = () =>
        app.inject({
          method: "POST",
          url: "/worker/claim",
          headers: { authorization: `Bearer ${issued.token}` },
          payload: {}
        });

      // Normal idle polling is unaffected: no work available, still a clean answer.
      for (let poll = 0; poll < 5; poll++) {
        const response = await claim();
        expect(response.statusCode, `poll ${poll}`).toBe(200);
        expect(response.json()).toEqual({ claimed: false });
        expect(response.headers["x-ratelimit-remaining"]).toBeDefined();
      }
      expect(Number((await claim()).headers["x-ratelimit-remaining"])).toBe(0);

      // Beyond the budget the route is refused with retry semantics, not a crash.
      const limited = await claim();
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ code: "rate_limited" });
      expect(limited.json().retry_after_seconds).toBeGreaterThan(0);
      expect(limited.headers["retry-after"]).toBeDefined();

      // A different credential keeps its own budget: limits are per principal.
      const other = identities.issue({
        workerId: "worker-rate-other",
        ttlMs: 60_000,
        token: "worker-rate-other-token-0123456789012345"
      });
      const otherClaim = await app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: `Bearer ${other.token}` },
        payload: {}
      });
      expect(otherClaim.statusCode).toBe(200);
      expect(otherClaim.json()).toEqual({ claimed: false });
    } finally {
      await app.close();
    }
  });
});
