import { describe, expect, it } from "vitest";
import { runGovernedUnits } from "./governed-driver.js";
import { WORKER, setupGovernedWorld } from "./governed-fixture.js";

/** The driver picks which units to hand the runner. It must never widen what the runner and the gate allow. */
function setup() {
  const w = setupGovernedWorld();
  const drive = (over: Partial<Parameters<typeof runGovernedUnits>[2]> = {}) =>
    runGovernedUnits(w.runner, w.exec.missions, {
      workerId: WORKER,
      lane: "coder",
      unitKinds: ["coding"],
      ...over
    });
  return { ...w, drive };
}

describe("governed driver", () => {
  it("runs a ready coding unit of a governed mission and nothing else", async () => {
    const w = setup();
    // The desktop unit sorts first and the cap is generous, so only the kind filter can keep it out.
    const id = w.mission(true, [{ id: "a-desktop", kind: "desktop" }, { id: "b-coding" }]);
    const summary = await w.drive({ maxUnits: 5 });
    expect(w.ran).toEqual([`${id}:b-coding`]);
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0]).toMatchObject({ status: "executed", applied: { applied: "completed" } });
  });

  it("skips missions with no authority binding by default, and runs them only when asked", async () => {
    const w = setup();
    const id = w.mission(false, [{ id: "a" }]);
    expect((await w.drive()).results).toHaveLength(0);
    expect(w.ran).toEqual([]);
    await w.drive({ requireGovernance: false });
    expect(w.ran).toEqual([`${id}:a`]);
  });

  it("never starts a unit whose dependencies are unmet, and runs it once they succeed", async () => {
    const w = setup();
    const id = w.mission(true, [{ id: "a" }, { id: "b", dependsOn: ["a"] }]);
    // The blocked unit is not even attempted, so it cannot spend one of the pass's maxUnits.
    const first = await w.drive({ maxUnits: 5 });
    expect(first.results.map((r) => r.unitId)).toEqual(["a"]);
    expect(w.ran).toEqual([`${id}:a`]);
    w.exec.missions.releaseReadyUnits(id, new Date().toISOString());
    const second = await w.drive({ maxUnits: 5 });
    expect(second.results.map((r) => r.unitId)).toEqual(["b"]);
    expect(w.ran).toEqual([`${id}:a`, `${id}:b`]);
  });

  it("skips cancelled missions", async () => {
    const w = setup();
    w.mission(true, [{ id: "a" }], "cancel");
    expect((await w.drive()).results).toHaveLength(0);
    expect(w.ran).toEqual([]);
  });

  it("is bounded by maxUnits across missions", async () => {
    const w = setup();
    w.mission(true, [{ id: "a" }, { id: "b" }]);
    w.mission(true, [{ id: "c" }]);
    const summary = await w.drive({ maxUnits: 2 });
    expect(summary.results).toHaveLength(2);
    expect(w.ran).toHaveLength(2);
  });

  it("reports an authority refusal and keeps going instead of aborting the pass", async () => {
    const w = setup();
    w.mission(true, [{ id: "a" }]);
    const stranger = await w.drive({ workerId: "not-mapped" });
    expect(stranger.results[0]).toMatchObject({ status: "denied" });
    expect(w.ran).toEqual([]);
  });
});
