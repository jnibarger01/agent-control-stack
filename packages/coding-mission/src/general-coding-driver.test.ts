import { DEFAULT_DELEGATION_BUDGET } from "./budget.js";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_UNITS_PER_PASS, runGeneralCodingUnits } from "./general-coding-driver.js";
import { cleanupWorlds, SHA, world } from "./general-coding-fixture.js";

afterEach(cleanupWorlds);

function task(repository: string) {
  return {
    kind: "coding",
    repository,
    baseSha: SHA,
    instructions: "edit",
    files: ["src/a.ts"],
    maxRuntimeMs: 60_000,
    maxFiles: 3
  };
}

function setup(extra: number = 0) {
  const w = world();
  const adapter = w.adapter(w.executor(() => ({ ...w.good(), files: ["src/a.ts"] })));
  const runner = w.runnerFor([adapter]);
  const add = (units: Array<{ unitId: string; kind: string; payload: unknown; dependsOn?: string[] }>) =>
    w.exec.missions.addWorkUnits(w.item.id, units.map((unit) => ({ title: unit.unitId, ...unit })) as never, w.iso(0));
  if (extra > 0) {
    add(
      Array.from({ length: extra }, (_, i) => ({
        unitId: `x${String(i).padStart(2, "0")}`,
        kind: "coding",
        payload: task(w.repository)
      }))
    );
  }
  const status = (unitId: string) => w.exec.missions.workUnits(w.item.id).find((u) => u.unitId === unitId)!.status;
  return { w, runner, add, status };
}

describe("runGeneralCodingUnits", () => {
  it("starts one eligible unit per pass by default", async () => {
    const { w, runner, status } = setup(2);
    const summary = await runGeneralCodingUnits(runner, w.exec.missions, { workerId: "coder-worker" });
    expect(summary.results.filter((r) => r.status === "executed")).toHaveLength(1);
    expect(status("u1")).toBe("succeeded");
    expect(status("x00")).toBe("pending");
  });

  it("honours maxUnits and keeps going after one unit fails", async () => {
    const { w, runner, status } = setup(2);
    const summary = await runGeneralCodingUnits(runner, w.exec.missions, { workerId: "coder-worker", maxUnits: 2 });
    expect(summary.results).toHaveLength(2);
    expect(status("x01")).toBe("pending");
  });

  it("never starts more than the per-pass ceiling", async () => {
    const { w, runner } = setup(MAX_UNITS_PER_PASS + 1);
    const summary = await runGeneralCodingUnits(runner, w.exec.missions, { workerId: "coder-worker", maxUnits: 1000 });
    expect(summary.results.filter((r) => r.status !== "skipped")).toHaveLength(MAX_UNITS_PER_PASS);
  });

  it("starts nothing for a zero or negative cap", async () => {
    const { w, runner, status } = setup();
    for (const maxUnits of [0, -3]) {
      const summary = await runGeneralCodingUnits(runner, w.exec.missions, { workerId: "coder-worker", maxUnits });
      expect(summary.results).toHaveLength(0);
    }
    expect(status("u1")).toBe("pending");
  });

  it("skips a unit without a complete task contract and does not claim it", async () => {
    const w = world({ payload: { repository: undefined, baseSha: undefined } });
    const runner = w.runnerFor([w.adapter(w.executor(() => w.good()))]);
    const summary = await runGeneralCodingUnits(runner, w.exec.missions, { workerId: "coder-worker" });
    expect(summary.results).toEqual([
      { status: "skipped", reason: "task_contract_invalid", missionId: w.item.id, unitId: "u1" }
    ]);
    expect(w.unit().status).toBe("pending");
    expect(w.requests).toHaveLength(0);
  });

  it("does not count a skipped unit against the cap", async () => {
    const { w, runner, add, status } = setup();
    add([{ unitId: "a-bad", kind: "coding", payload: { kind: "coding", instructions: "x", files: ["a"] } }]);
    const summary = await runGeneralCodingUnits(runner, w.exec.missions, { workerId: "coder-worker" });
    expect(summary.results.map((r) => r.status)).toEqual(["skipped", "executed"]);
    expect(status("u1")).toBe("succeeded");
  });

  it("leaves units of other kinds alone", async () => {
    const { w, runner, add, status } = setup();
    add([{ unitId: "a-desktop", kind: "desktop", payload: { kind: "desktop", objective: "click" } }]);
    await runGeneralCodingUnits(runner, w.exec.missions, { workerId: "coder-worker", maxUnits: 5 });
    expect(status("a-desktop")).toBe("pending");
  });

  it("waits for dependencies to succeed", async () => {
    const { w, runner, add, status } = setup();
    add([{ unitId: "a-child", kind: "coding", payload: task(w.repository), dependsOn: ["u1"] }]);
    const first = await runGeneralCodingUnits(runner, w.exec.missions, { workerId: "coder-worker", maxUnits: 5 });
    expect(first.results.map((r) => r.unitId)).toEqual(["u1"]);
    const second = await runGeneralCodingUnits(runner, w.exec.missions, { workerId: "coder-worker", maxUnits: 5 });
    expect(second.results.map((r) => r.unitId)).toEqual(["a-child"]);
    expect(status("a-child")).toBe("succeeded");
  });

  it("ignores a mission with no authority binding", async () => {
    const w = world();
    w.exec.missions.createGeneral({
      missionId: "ungoverned",
      summary: "m",
      budget: { ...DEFAULT_DELEGATION_BUDGET },
      now: w.iso(0)
    });
    w.exec.missions.addWorkUnits(
      "ungoverned",
      [{ unitId: "u1", kind: "coding", title: "edit", payload: task(w.repository) }] as never,
      w.iso(0)
    );
    const runner = w.runnerFor([w.adapter(w.executor(() => w.good()))]);
    const summary = await runGeneralCodingUnits(runner, w.exec.missions, { workerId: "coder-worker", maxUnits: 5 });
    expect(summary.results.map((r) => r.missionId)).toEqual([w.item.id]);
    const ungoverned = w.exec.missions.workUnits("ungoverned")[0]!;
    expect(ungoverned.status).toBe("pending");
  });

  it("ignores a terminal mission", async () => {
    const w = world();
    w.exec.missions.db.prepare("UPDATE coding_missions SET state = 'CANCELLED' WHERE mission_id = ?").run(w.item.id);
    const runner = w.runnerFor([w.adapter(w.executor(() => w.good()))]);
    const summary = await runGeneralCodingUnits(runner, w.exec.missions, { workerId: "coder-worker" });
    expect(summary.results).toHaveLength(0);
  });

  it("ignores a coding-kind mission", async () => {
    const w = world();
    w.exec.missions.db
      .prepare("UPDATE coding_missions SET mission_kind = 'coding' WHERE mission_id = ?")
      .run(w.item.id);
    const runner = w.runnerFor([w.adapter(w.executor(() => w.good()))]);
    const summary = await runGeneralCodingUnits(runner, w.exec.missions, { workerId: "coder-worker" });
    expect(summary.results).toHaveLength(0);
  });
});
