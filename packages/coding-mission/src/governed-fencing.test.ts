import { describe, expect, it, vi } from "vitest";
import { WORKER, setupGovernedWorld } from "./governed-fixture.js";
import { GovernedUnitRunner } from "./unit-runner.js";
import { CoderExecutionAdapter, type DispatchEnvelope, type WorkUnitExecutorAdapter } from "./worker-execution.js";

/**
 * The legacy coding path hands the claim token to the executor, so a fencing executor can refuse a claim it has revoked.
 * The governed path must too: otherwise a worker holding a stale claim could still commit through the coder lane.
 */
function setup() {
  const w = setupGovernedWorld();
  const id = w.mission(true, [{ id: "a" }]);
  const input = { missionId: id, unitId: "a", workerId: WORKER, lane: "coder" as const };
  const runnerFor = (adapter: WorkUnitExecutorAdapter, token: string) =>
    new GovernedUnitRunner({
      execution: w.exec,
      adapters: [adapter],
      now: () => w.state.now,
      newClaimToken: () => token
    });
  const adapterFor = (execute: (input: Record<string, unknown>) => Promise<unknown>) =>
    new CoderExecutionAdapter(w.exec.missions, { execute } as never, () => w.state.now);
  return { ...w, id, input, runnerFor, adapterFor };
}

const succeeded = () => ({ status: "succeeded" as const, value: { resultHash: "h", files: [] as string[] } });

describe("claim fencing on the governed coder lane", () => {
  it("hands the live claim token to the coder port so the executor can fence it", async () => {
    const w = setup();
    const execute = vi.fn(async (_input: Record<string, unknown>) => succeeded());
    const result = await w.runnerFor(w.adapterFor(execute), "tok-live").runUnit(w.input);
    expect(result).toMatchObject({ status: "executed", applied: { applied: "completed" } });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ operationId: "a", claimToken: "tok-live" }));
    // The token handed over is the one the store holds for the live claim.
    expect(w.exec.missions.workUnits(w.id).find((u) => u.unitId === "a")?.claimToken).toBe("tok-live");
  });

  it("fails the unit instead of committing when the executor has revoked that token", async () => {
    const w = setup();
    const execute = vi.fn(async (input: Record<string, unknown>) =>
      input.claimToken === "tok-revoked" ? { status: "rejected" as const, code: "claim_revoked" } : succeeded()
    );
    const result = await w.runnerFor(w.adapterFor(execute), "tok-revoked").runUnit(w.input);
    expect(result).toMatchObject({ status: "executed", applied: { applied: "failed" } });
    expect(w.exec.missions.workUnits(w.id).find((u) => u.unitId === "a")?.status).toBe("failed");
  });

  it("leaves the adapter's behavior unchanged for a caller that supplies no claim", async () => {
    const w = setup();
    const execute = vi.fn(async (_input: Record<string, unknown>) => succeeded());
    const adapter = w.adapterFor(execute);
    let seen: DispatchEnvelope | undefined;
    await w
      .runnerFor(
        {
          lane: "coder",
          execute: async (dispatch: DispatchEnvelope, signal?: AbortSignal) => {
            seen = dispatch;
            return adapter.execute(dispatch, signal);
          }
        },
        "tok-x"
      )
      .runUnit(w.input);
    expect(seen).toBeDefined();
    expect(execute.mock.calls[0]![0]).not.toHaveProperty("claimToken");
  });
});
