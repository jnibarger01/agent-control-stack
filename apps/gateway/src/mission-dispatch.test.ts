import { describe, expect, it, vi } from "vitest";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import {
  advanceMissionDispatch,
  readMissionDispatches,
  MISSION_DISPATCH_REQUESTED
} from "@agent-control-stack/policy-gate";

import { missionDispatchFixture as fixture } from "./mission-dispatch.test-support.js";

describe("governed mission dispatch", () => {
  it("rejects unauthenticated, service and read-only operators; disabled dispatch is inert", async () => {
    const ctx = await fixture(false);
    try {
      for (const token of ["", "planner-fixture", "reader-fixture"]) {
        const response = await ctx.post("/api/mission-dispatch/preview", ctx.input, token);
        expect(response.statusCode).toBeGreaterThanOrEqual(401);
      }
      expect((await ctx.post("/api/mission-dispatch/preview", ctx.input)).statusCode).toBe(503);
      expect(readMissionDispatches(ctx.store)).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
  it("persists one scheduling receipt across duplicate submissions and database reopen, without claiming execution", async () => {
    const ctx = await fixture();
    try {
      const preview = await ctx.post("/api/mission-dispatch/preview", ctx.input);
      expect(preview.statusCode, preview.body).toBe(200);
      const confirmed = { ...ctx.input, confirmationHash: preview.json().preview.confirmationHash };
      const mismatch = await ctx.post("/api/mission-dispatch", { ...confirmed, confirmationHash: "b".repeat(64) });
      expect(mismatch.json().code).toBe("mission_dispatch_confirmation_mismatch");
      const receipts = await Promise.all([
        ctx.post("/api/mission-dispatch", confirmed),
        ctx.post("/api/mission-dispatch", confirmed)
      ]);
      expect(receipts.map((receipt) => receipt.statusCode)).toEqual([202, 202]);
      expect(receipts[0]!.json()).toEqual(receipts[1]!.json());
      const reopened = new SqliteWorkItemStore(ctx.dbPath);
      try {
        const requests = readMissionDispatches(reopened);
        expect(requests).toHaveLength(1);
        expect(reopened.readEvents({ name: MISSION_DISPATCH_REQUESTED })).toHaveLength(1);
        expect(reopened.list()).toHaveLength(1);
        const invoke = vi.fn();
        await expect(
          advanceMissionDispatch(reopened, { request: vi.fn(), invoke }, requests[0]!, "wrong-executor")
        ).rejects.toMatchObject({ code: "mission_dispatch_executor_mismatch" });
        expect(invoke).not.toHaveBeenCalled();
      } finally {
        reopened.close();
      }
    } finally {
      await ctx.close();
    }
  });
  it("rejects revoked approvals and stale snapshots and still lists the failed binding", async () => {
    const ctx = await fixture();
    try {
      const preview = await ctx.post("/api/mission-dispatch/preview", ctx.input);
      const confirmed = { ...ctx.input, confirmationHash: preview.json().preview.confirmationHash };
      expect((await ctx.post("/api/mission-dispatch", confirmed)).statusCode).toBe(202);
      const revoke = await ctx.post(
        `/work-items/${ctx.input.missionId}/change-set-approvals/${ctx.input.approvalId}/revoke`,
        { reason: "stop dispatch" }
      );
      expect(revoke.statusCode, revoke.body).toBe(200);
      expect((await ctx.post("/api/mission-dispatch", confirmed)).json().code).toBe("change_set_approval_revoked");
      const invoke = vi.fn();
      const [request] = readMissionDispatches(ctx.store);
      await expect(
        advanceMissionDispatch(
          ctx.store,
          {
            request: async (method, path, body) => {
              const response = await ctx.app.inject({
                method,
                url: path,
                headers: { authorization: "Bearer planner-fixture" },
                ...(body === undefined
                  ? {}
                  : {
                      payload: JSON.stringify(body),
                      headers: { authorization: "Bearer planner-fixture", "content-type": "application/json" }
                    })
              });
              return { status: response.statusCode, body: response.json() };
            },
            invoke
          },
          request!,
          "planner"
        )
      ).rejects.toMatchObject({ code: "mission_gateway_rejected" });
      expect(invoke).not.toHaveBeenCalled();
      const listed = await ctx.app.inject({
        method: "GET",
        url: "/api/mission-dispatch",
        headers: { authorization: "Bearer operator-fixture" }
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().dispatches[0].code).toBe("change_set_approval_revoked");
      ctx.store.submitChangeSet({
        definition: { ...ctx.definition, objective: "amended objective" },
        submissionId: "amendment",
        expectedHeadHash: ctx.input.expectedManifestHash,
        createdByActorId: "planner"
      });
      expect((await ctx.post("/api/mission-dispatch/preview", ctx.input)).json().code).toBe(
        "mission_dispatch_snapshot_mismatch"
      );
      const staleList = await ctx.app.inject({
        method: "GET",
        url: "/api/mission-dispatch",
        headers: { authorization: "Bearer operator-fixture" }
      });
      expect(staleList.statusCode).toBe(200);
      expect(staleList.json().dispatches).toHaveLength(1);
    } finally {
      await ctx.close();
    }
  });
});
