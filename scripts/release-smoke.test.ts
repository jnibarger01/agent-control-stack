import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyEngine, createWorkItemTools } from "../packages/policy-gate/src/index.js";
import { SqliteWorkItemStore } from "../packages/work-items/src/index.js";
import { buildGateway } from "../apps/gateway/src/server.js";
import { describe, expect, it } from "vitest";

describe("release smoke", () => {
  it("proves auth, policy, exact approval, lease claim, and result completion on a temporary DB", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-release-smoke-"));
    const dbPath = join(dir, "control.db");
    const auth = { token: "release-smoke-token", actor: "user", actorId: "user" } as const;
    const app = buildGateway({ dbPath, logger: false, auth });
    let appClosed = false;

    try {
      await app.ready();
      const unauthorized = await app.inject({
        method: "POST",
        url: "/work-items",
        payload: {
          title: "unauthorized",
          intent: "should fail",
          requestedActions: [{ kind: "fs.read", description: "read" }]
        }
      });
      expect(unauthorized.statusCode).toBe(401);

      const created = await app.inject({
        method: "POST",
        url: "/work-items",
        headers: { authorization: `Bearer ${auth.token}` },
        payload: {
          title: "Release smoke write",
          requester: "user",
          intent: "verify exact approval and lease result",
          target: { cwd: "/repo" },
          requestedActions: [
            { kind: "fs.write", description: "write smoke file", params: { paths: ["src/smoke.ts"] } }
          ],
          risk: "medium"
        }
      });
      expect(created.statusCode).toBe(201);
      const workItem = created.json();
      expect(workItem.status).toBe("needs_approval");

      const actionHash = createPolicyEngine().evaluateWorkItem(workItem, auth.actorId, "approve")[0]?.actionHash;
      expect(actionHash).toEqual(expect.any(String));
      const approved = await app.inject({
        method: "POST",
        url: `/work-items/${workItem.id}/approve`,
        headers: { authorization: `Bearer ${auth.token}` },
        payload: { reason: "release smoke exact approval", actionHash }
      });
      const mismatchedApproval = await app.inject({
        method: "POST",
        url: `/work-items/${workItem.id}/approve`,
        headers: { authorization: `Bearer ${auth.token}` },
        payload: { reason: "release smoke mismatch", actionHash: "0".repeat(64) }
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json().workItem.status).toBe("approved");
      expect(mismatchedApproval.statusCode).toBe(409);

      await app.close();
      appClosed = true;
      const store = new SqliteWorkItemStore(dbPath);
      try {
        const tools = createWorkItemTools(store, createPolicyEngine());
        const claimed = tools.claim_next_approved_work_item({ workerId: "release-smoke-worker" });
        expect(claimed?.leaseToken).toEqual(expect.any(String));
        expect(() =>
          tools.submit_work_result({
            id: workItem.id,
            workerId: "release-smoke-worker",
            leaseToken: "invalid-lease",
            status: "succeeded",
            result: { execution_mode: "dry_run", summary: "must reject" }
          })
        ).toThrow(/lease/);
        const completed = tools.submit_work_result({
          id: workItem.id,
          workerId: "release-smoke-worker",
          leaseToken: claimed!.leaseToken,
          status: "succeeded",
          result: { execution_mode: "dry_run", summary: "release smoke completed" }
        });
        expect(completed.status).toBe("succeeded");
        expect(() =>
          tools.submit_work_result({
            id: workItem.id,
            workerId: "release-smoke-worker",
            leaseToken: claimed!.leaseToken,
            status: "succeeded",
            result: { execution_mode: "dry_run", summary: "duplicate must reject" }
          })
        ).toThrow(/not running/);

        const stale = tools.create_work_item({
          title: "Release smoke stale lease",
          requester: "user",
          intent: "verify stale lease rejection",
          target: { cwd: "/repo" },
          requestedActions: [
            { kind: "fs.read", description: "read smoke source", params: { paths: ["src/index.ts"] } }
          ],
          risk: "low"
        });
        const staleClaim = tools.claim_next_approved_work_item({ workerId: "release-smoke-stale", leaseMs: 1 });
        expect(staleClaim?.id).toBe(stale.id);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(() =>
          tools.submit_work_result({
            id: stale.id,
            workerId: "release-smoke-stale",
            leaseToken: staleClaim!.leaseToken,
            status: "succeeded",
            result: { execution_mode: "dry_run", summary: "stale must reject" }
          })
        ).toThrow(/expired/);
        expect(store.readEvents().map((event) => event.name)).toEqual(
          expect.arrayContaining(["policy.decided", "approval.granted", "approval.consumed", "work_item.succeeded"])
        );
      } finally {
        store.close();
      }
    } finally {
      if (!appClosed) {
        try {
          await app.close();
        } catch {
          // The test may already have closed the app before entering this cleanup.
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
