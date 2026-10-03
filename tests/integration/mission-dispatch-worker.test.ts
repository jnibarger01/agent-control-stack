import { describe, expect, it } from "vitest";
import { resumeDispatchedMissions } from "../../apps/worker/src/mission-dispatch.js";
import { missionDispatchFixture } from "../../apps/gateway/src/mission-dispatch.test-support.js";

describe("governed dispatch worker preflight", () => {
  it("preflights missing worker runtimes before permits and records a stable blocked observation once", async () => {
    const ctx = await missionDispatchFixture();
    try {
      const preview = await ctx.post("/api/mission-dispatch/preview", ctx.input);
      expect(
        (
          await ctx.post("/api/mission-dispatch", {
            ...ctx.input,
            confirmationHash: preview.json().preview.confirmationHash
          })
        ).statusCode
      ).toBe(202);
      const env = {
        ACS_MISSION_DISPATCH_ENABLED: "1",
        ACS_MISSION_EXECUTING_ACTOR_ID: "planner",
        ACS_MISSION_GATEWAY_URL: "http://127.0.0.1:1",
        ACS_MISSION_GATEWAY_TOKEN: "planner-fixture"
      };
      for (let i = 0; i < 2; i++) {
        expect(await resumeDispatchedMissions(ctx.dbPath, env)).toEqual([
          { missionId: ctx.input.missionId, status: "blocked", code: "mission_runtime_unconfigured" }
        ]);
      }
      expect(ctx.store.list()).toHaveLength(1);
      expect(
        ctx.store.getChangeSetOperationPermitForOperation(
          ctx.input.missionId,
          ctx.input.expectedManifestHash,
          "inspect"
        )
      ).toBeUndefined();
      expect(ctx.store.readEvents({ name: "mission.dispatch.observed" })).toHaveLength(1);
      const listed = await ctx.app.inject({
        method: "GET",
        url: "/api/mission-dispatch",
        headers: { authorization: "Bearer operator-fixture" }
      });
      expect(listed.json().dispatches[0].observation).toEqual({
        status: "blocked",
        code: "mission_runtime_unconfigured"
      });
      await expect(resumeDispatchedMissions(ctx.dbPath, { ACS_MISSION_DISPATCH_ENABLED: "1" })).rejects.toMatchObject({
        code: "mission_dispatch_executor_missing"
      });
      expect(await resumeDispatchedMissions("/nonexistent/control.db", {})).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});
