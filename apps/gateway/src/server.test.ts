import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { buildGateway } from "./server.js";

const auth = { token: "test-token", actor: "user" };
const authHeaders = { authorization: `Bearer ${auth.token}` };

describe("gateway work-item routes", () => {
  it("returns 400 for malformed list filters", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false });

    try {
      const response = await app.inject({ method: "GET", url: "/work-items?status=bogus" });

      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("requires mutation auth", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false, auth });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/work-items",
        payload: { title: "Denied", intent: "missing auth", requestedActions: [{ kind: "read", description: "inspect" }] }
      });

      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("requires approval for writes and records exact action approval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-"));
    const dbPath = join(dir, "control.db");
    const app = buildGateway({ dbPath, logger: false, auth });
    let appClosed = false;

    try {
      const created = await app.inject({
        method: "POST",
        url: "/work-items",
        headers: authHeaders,
        payload: {
          title: "Write work",
          requester: "user",
          intent: "verify approval path",
          target: { cwd: "/repo" },
          requestedActions: [
            { kind: "edit", description: "write file", params: { write: true, paths: ["src/index.ts"] } }
          ],
          risk: "medium"
        }
      });
      const workItem = created.json();

      expect(workItem.status).toBe("needs_approval");

      const approved = await app.inject({
        method: "POST",
        url: `/work-items/${workItem.id}/approve`,
        headers: authHeaders,
        payload: { reason: "approve exact write" }
      });

      expect(approved.statusCode).toBe(200);
      expect(approved.json().workItem.status).toBe("approved");
      expect(approved.json().decision.decision).toBe("require_approval");

      await app.close();
      appClosed = true;
      const store = new SqliteWorkItemStore(dbPath);
      try {
        const approvals = store.readEvents().filter((event) => event.name === "approval.recorded");
        expect(approvals).toHaveLength(1);
        expect(approvals[0]?.body).toMatchObject({ workItemId: workItem.id });
        expect(typeof approvals[0]?.body.actionHash).toBe("string");
      } finally {
        store.close();
      }
    } finally {
      if (!appClosed) {
        await app.close();
      }
    }
  });

  it("blocks denied work on create", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false, auth });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/work-items",
        headers: authHeaders,
        payload: {
          title: "Denied work",
          requester: "user",
          intent: "verify deny path",
          requestedActions: [{ kind: "command", description: "sudo", params: { command: ["sudo", "whoami"] } }],
          risk: "low"
        }
      });

      expect(created.statusCode).toBe(201);
      expect(created.json().status).toBe("blocked");
    } finally {
      await app.close();
    }
  });

  it("does not mutate state when approval policy denies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-"));
    const dbPath = join(dir, "control.db");
    const setup = new SqliteWorkItemStore(dbPath);
    const workItem = setup.create({
      title: "Pending manual work",
      requester: "user",
      intent: "deny approval without blocking",
      requestedActions: [{ kind: "manual", description: "ambiguous" }],
      risk: "low"
    });
    setup.close();
    const app = buildGateway({ dbPath, logger: false, auth });

    try {
      const denied = await app.inject({
        method: "POST",
        url: `/work-items/${workItem.id}/approve`,
        headers: authHeaders,
        payload: { reason: "policy should deny" }
      });

      expect(denied.statusCode).toBe(403);
      expect(denied.json().workItem.status).toBe("pending_policy");
      const check = new SqliteWorkItemStore(dbPath);
      try {
        expect(check.get(workItem.id)?.status).toBe("pending_policy");
      } finally {
        check.close();
      }
    } finally {
      await app.close();
    }
  });

  it("re-denies blocked work on unblock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-gateway-"));
    const app = buildGateway({ dbPath: join(dir, "control.db"), logger: false, auth });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/work-items",
        headers: authHeaders,
        payload: {
          title: "Denied work",
          requester: "user",
          intent: "verify unblock",
          requestedActions: [{ kind: "command", description: "sudo", params: { command: ["sudo", "whoami"] } }],
          risk: "low"
        }
      });

      const unblocked = await app.inject({
        method: "POST",
        url: `/work-items/${created.json().id}/unblock`,
        headers: authHeaders
      });

      expect(unblocked.statusCode).toBe(403);
      expect(unblocked.json().workItem.status).toBe("blocked");
    } finally {
      await app.close();
    }
  });
});
