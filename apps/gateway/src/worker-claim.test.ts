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
    let app = buildGateway({
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
      expect(spoofed.headers["cache-control"]).toBe("no-store");

      const excessiveLease = await app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: `Bearer ${workerA.token}` },
        payload: { leaseMs: 3_600_001 }
      });
      expect(excessiveLease.statusCode).toBe(400);
      expect(excessiveLease.headers["cache-control"]).toBe("no-store");

      const wrongWorker = await app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: `Bearer ${workerA.token}` },
        payload: {}
      });
      expect(wrongWorker.statusCode).toBe(200);
      expect(wrongWorker.json()).toEqual({ claimed: false });
      expect(wrongWorker.headers["cache-control"]).toBe("no-store");

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
      expect(matchingWorker.headers["cache-control"]).toBe("no-store");
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

      const check = new SqliteWorkItemStore(dbPath);
      try {
        expect(check.get(item.id)?.status).toBe("running");
        expect(check.getWorkItemAssignment(item.id)?.selectedWorkerId).toBe("worker-b");
        expect(check.verifyAuditChain()).toMatchObject({ ok: true });
      } finally {
        check.close();
      }

      await app.close();
      app = buildGateway({
        dbPath,
        logger: false,
        auth: { token: "unused-static-token", actor: "user", workerIdentities: identities }
      });
      await app.ready();
      const retry = await app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: `Bearer ${workerB.token}` },
        payload: {}
      });
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toEqual({ claimed: false });
      const postRestartMismatch = await app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: `Bearer ${workerA.token}` },
        payload: {}
      });
      expect(postRestartMismatch.statusCode).toBe(200);
      expect(postRestartMismatch.json()).toEqual({ claimed: false });

      identities.revoke({ workerId: "worker-a", token: workerA.token });
      const disabled = await app.inject({
        method: "POST",
        url: "/worker/claim",
        headers: { authorization: `Bearer ${workerA.token}` },
        payload: {}
      });
      expect(disabled.statusCode).toBe(401);

      const reopened = new SqliteWorkItemStore(dbPath);
      try {
        expect(reopened.getWorkItemAssignment(item.id)?.selectedWorkerId).toBe("worker-b");
        expect(reopened.get(item.id)?.status).toBe("running");
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
          expect(db.prepare("SELECT status, worker_id FROM work_items WHERE id = ?").get(item.id)).toEqual({
            status: "running",
            worker_id: "worker-b"
          });
          expect(
            db.prepare("SELECT COUNT(*) AS count FROM attempt_leases WHERE work_item_id = ?").get(item.id)
          ).toEqual({ count: 1 });
          expect(
            db.prepare("SELECT COUNT(*) AS count FROM execution_attempts WHERE work_item_id = ?").get(item.id)
          ).toEqual({ count: 1 });
        } finally {
          db.close();
        }
      } finally {
        reopened.close();
      }
    } finally {
      await app.close();
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
    store.assignWorkItem(
      { workItemId: item.id, selectedWorkerId: "worker-race", assignedByActorId: "operator" },
      { via: "domain_service", actorId: "operator" }
    );
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
});
