import { readdirSync, readlinkSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ACTOR, WORKER, setupGovernedWorld } from "./governed-fixture.js";
import { readGovernedWorkerConfig, resumeGovernedUnits } from "./governed-worker.js";
import type { CodingMissionPorts } from "./controller.js";

/** Open file descriptors of this process that point at the database (or its WAL/SHM). Linux only; elsewhere returns 0. */
function openHandlesOn(dbPath: string): number {
  try {
    return readdirSync("/proc/self/fd").filter((fd) => {
      try {
        return readlinkSync(`/proc/self/fd/${fd}`).startsWith(dbPath);
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
}

const goodEnv = (over: Record<string, string | undefined> = {}) => ({
  ACS_GOVERNED_WORKER_ACTORS: JSON.stringify({ [WORKER]: ACTOR }),
  ACS_GOVERNED_WORKER_ID: WORKER,
  ...over
});

function stubPorts(now: () => string) {
  const execute = vi.fn(async () => ({
    status: "succeeded" as const,
    value: { resultHash: "coder-result", files: ["a.ts"] }
  }));
  const ports = { now, coder: { execute } } as unknown as Pick<CodingMissionPorts, "now" | "coder">;
  return { ports, execute };
}

describe("governed worker configuration", () => {
  it("is disabled unless the actor map is set", () => {
    expect(readGovernedWorkerConfig({})).toBeUndefined();
    expect(readGovernedWorkerConfig({ ACS_GOVERNED_WORKER_ID: WORKER })).toBeUndefined();
  });

  it("reads a valid map, defaults to one unit per pass and resolves only configured workers", () => {
    const config = readGovernedWorkerConfig(goodEnv())!;
    expect(config.workerId).toBe(WORKER);
    expect(config.maxUnits).toBe(1);
    expect(config.actors.get(WORKER)).toBe(ACTOR);
    // A plain object would resolve these through the prototype chain.
    expect(config.actors.get("constructor")).toBeUndefined();
    expect(config.actors.get("__proto__")).toBeUndefined();
  });

  it.each([
    ["unparseable JSON", { ACS_GOVERNED_WORKER_ACTORS: "{nope" }],
    ["an array", { ACS_GOVERNED_WORKER_ACTORS: '["a"]' }],
    ["an empty map", { ACS_GOVERNED_WORKER_ACTORS: "{}" }],
    ["a non-string actor", { ACS_GOVERNED_WORKER_ACTORS: JSON.stringify({ [WORKER]: 7 }) }],
    ["an empty actor", { ACS_GOVERNED_WORKER_ACTORS: JSON.stringify({ [WORKER]: "" }) }],
    ["no worker id", { ACS_GOVERNED_WORKER_ID: undefined }],
    ["a worker id outside the map", { ACS_GOVERNED_WORKER_ID: "someone-else" }],
    ["a zero unit cap", { ACS_GOVERNED_MAX_UNITS: "0" }],
    ["an oversized unit cap", { ACS_GOVERNED_MAX_UNITS: "11" }],
    ["a fractional unit cap", { ACS_GOVERNED_MAX_UNITS: "1.5" }]
  ])("fails loud rather than silently running ungoverned on %s", (_name, over) => {
    expect(() => readGovernedWorkerConfig(goodEnv(over))).toThrow(/governed_worker_config_invalid|governed worker/u);
  });
});

describe("resumeGovernedUnits", () => {
  it("does nothing when not configured, without opening the database", async () => {
    const w = setupGovernedWorld();
    const { ports, execute } = stubPorts(() => w.state.now);
    w.exec.close();
    expect(await resumeGovernedUnits(w.dbPath, {}, { ports })).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it("does nothing when no coder executor is configured", async () => {
    const w = setupGovernedWorld();
    w.mission(true, [{ id: "a" }]);
    w.exec.close();
    expect(await resumeGovernedUnits(w.dbPath, goodEnv(), {})).toBeUndefined();
  });

  it("runs a governed coding unit through the coder lane and releases the database", async () => {
    const w = setupGovernedWorld();
    const id = w.mission(true, [{ id: "a" }]);
    w.exec.close();
    const { ports, execute } = stubPorts(() => w.state.now);
    const handlesBefore = openHandlesOn(w.dbPath);

    const summary = await resumeGovernedUnits(w.dbPath, goodEnv(), { ports });
    expect(summary?.results).toHaveLength(1);
    expect(summary?.results[0]).toMatchObject({ status: "executed", applied: { applied: "completed" } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ operationId: "a", workerId: WORKER }));

    // The pass left no connection to the database open.
    expect(openHandlesOn(w.dbPath)).toBe(handlesBefore);
    // Nothing left to run.
    const again = await resumeGovernedUnits(w.dbPath, goodEnv(), { ports });
    expect(again?.results).toHaveLength(0);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(id).toBeTruthy();
  });

  it("will not run a governed unit for a worker the map does not authorize", async () => {
    const w = setupGovernedWorld();
    w.mission(true, [{ id: "a" }]);
    w.exec.close();
    const { ports, execute } = stubPorts(() => w.state.now);
    // The grant was issued to ACTOR, but this deployment maps its worker to a different actor.
    const env = goodEnv({ ACS_GOVERNED_WORKER_ACTORS: JSON.stringify({ [WORKER]: "actor:someone-else" }) });
    const summary = await resumeGovernedUnits(w.dbPath, env, { ports });
    expect(summary?.results[0]).toMatchObject({ status: "denied" });
    expect(execute).not.toHaveBeenCalled();
  });
});
