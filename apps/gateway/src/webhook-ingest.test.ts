import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildGateway } from "./server.js";

const testAuth = { token: "t", actor: "user", actorId: "user" } as const;

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function testGateway() {
  const dir = mkdtempSync(join(tmpdir(), "acs-webhook-"));
  directories.push(dir);
  const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false, auth: testAuth });
  // Auto-inject the bearer token so unauthenticated tests can omit it explicitly.
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization === undefined) {
      request.headers.authorization = `Bearer ${testAuth.token}`;
    }
  });
  return app;
}

const validBody = {
  title: "Pull Xtime daily board",
  intent: "Extract today's service appointments via the dealer control plane.",
  risk: "medium"
};

describe("webhook ingest receiver", () => {
  it("rejects an unauthenticated webhook with 401 (fail closed)", async () => {
    const app = testGateway();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/hermes",
      headers: { authorization: "" },
      payload: validBody
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("ingests a valid webhook into a governed work item (201)", async () => {
    const app = testGateway();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/hermes",
      headers: { "idempotency-key": "evt-1" },
      payload: validBody
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { workItemId: string; status: string; approvalRequired: boolean };
    expect(body.workItemId).toMatch(/^wrk_/);
    expect(typeof body.status).toBe("string");

    const created = await app.inject({ method: "GET", url: `/work-items/${body.workItemId}` });
    expect(created.statusCode).toBe(200);
    const item = created.json() as { workItem: { requester: string; requesterSubject: string } };
    expect(item.workItem.requester).toBe("agent");
    expect(item.workItem.requesterSubject).toBe("hermes:user");
    await app.close();
  });

  it("persists the caller-supplied correlationId and webhook source on the created work item", async () => {
    const app = testGateway();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/hermes",
      headers: { "idempotency-key": "evt-correlation" },
      payload: { ...validBody, correlationId: "hermes-evt-abc123" }
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { workItemId: string };

    const created = await app.inject({ method: "GET", url: `/work-items/${body.workItemId}` });
    const item = created.json() as {
      workItem: { metadata?: { webhookSource?: string; correlationId?: string } };
    };
    expect(item.workItem.metadata).toEqual({ webhookSource: "hermes", correlationId: "hermes-evt-abc123" });
    await app.close();
  });

  it("omits metadata entirely when the caller supplies no correlationId", async () => {
    const app = testGateway();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/hermes",
      headers: { "idempotency-key": "evt-no-correlation" },
      payload: validBody
    });
    const body = res.json() as { workItemId: string };

    const created = await app.inject({ method: "GET", url: `/work-items/${body.workItemId}` });
    const item = created.json() as { workItem: { metadata?: unknown } };
    expect(item.workItem.metadata).toBeUndefined();
    await app.close();
  });

  it("replays an idempotent webhook without creating a duplicate (200)", async () => {
    const app = testGateway();
    const first = await app.inject({
      method: "POST",
      url: "/webhooks/hermes",
      headers: { "idempotency-key": "evt-2" },
      payload: validBody
    });
    const second = await app.inject({
      method: "POST",
      url: "/webhooks/hermes",
      headers: { "idempotency-key": "evt-2" },
      payload: validBody
    });
    expect(second.statusCode).toBe(200);
    const a = first.json() as { workItemId: string };
    const b = second.json() as { workItemId: string; replayed: boolean };
    expect(b.replayed).toBe(true);
    expect(b.workItemId).toBe(a.workItemId);

    const listed = await app.inject({ method: "GET", url: "/work-items" });
    const items = (listed.json() as { workItems: unknown[] }).workItems;
    const matching = items.filter(
      (candidate) => (candidate as { id: string }).id === a.workItemId
    );
    expect(matching).toHaveLength(1);
    await app.close();
  });

  it("rejects a webhook body with unknown fields (strict schema)", async () => {
    const app = testGateway();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/hermes",
      headers: { "idempotency-key": "evt-3" },
      payload: { ...validBody, requester: "user", smuggled: true }
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects an invalid webhook source segment with 400", async () => {
    const app = testGateway();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/BAD SOURCE!",
      headers: { "idempotency-key": "evt-4" },
      payload: validBody
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("handles simultaneous concurrent requests with the same idempotency key safely without duplicates", async () => {
    const app = testGateway();
    const [res1, res2] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/webhooks/hermes",
        headers: { "idempotency-key": "evt-concurrent" },
        payload: validBody
      }),
      app.inject({
        method: "POST",
        url: "/webhooks/hermes",
        headers: { "idempotency-key": "evt-concurrent" },
        payload: validBody
      })
    ]);

    // One must succeed with 201 Created (or 200 replayed if polled) and the other returns 200 replayed or 409 conflict
    expect([200, 201]).toContain(res1.statusCode);
    expect([200, 201, 409]).toContain(res2.statusCode);

    const body1 = res1.json() as { workItemId?: string };
    const body2 = res2.json() as { workItemId?: string };
    if (body1.workItemId && body2.workItemId) {
      expect(body1.workItemId).toBe(body2.workItemId);
    }

    const listed = await app.inject({ method: "GET", url: "/work-items" });
    const items = (listed.json() as { workItems: { id: string }[] }).workItems;
    const matching = items.filter((item) => item.id === (body1.workItemId || body2.workItemId));
    expect(matching).toHaveLength(1);
    await app.close();
  });
});
