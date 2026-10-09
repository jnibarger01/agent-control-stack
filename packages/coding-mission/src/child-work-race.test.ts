import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { MissionBudget } from "./budget.js";
import { MISSION, childItem, openLedger, seedMission } from "./child-work-race-fixture.js";

/**
 * The in-process "race" tests in child-work.test.ts run two requests one after the other on a single thread, so they
 * prove the durable guard but never contend. These tests start real OS processes against one SQLite file, release them
 * together, and check that the caps hold under genuine contention.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDb(budget?: MissionBudget): string {
  const dir = mkdtempSync(join(tmpdir(), "acs-child-race-"));
  dirs.push(dir);
  const dbPath = join(dir, "control.db");
  seedMission(dbPath, budget);
  return dbPath;
}

type Job = { kind: "request"; unitId: string } | { kind: "claim"; unitId: string; token: string; workerId: string };

async function race(dbPath: string, jobs: Job[]): Promise<Array<Record<string, unknown>>> {
  const worker = new URL("child-work-race-worker.ts", import.meta.url).pathname;
  const procs = jobs.map((job) => {
    const child = spawn(process.execPath, ["--import", "tsx", worker, dbPath, JSON.stringify(job)], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const ready = new Promise<void>((resolve, reject) => {
      const poll = setInterval(() => {
        if (stdout.includes("ready\n")) {
          clearInterval(poll);
          resolve();
        }
      }, 10);
      child.once("error", reject);
      child.once("exit", (code) => {
        if (!stdout.includes("ready\n")) {
          clearInterval(poll);
          reject(new Error(`worker exited ${code} before ready: ${stderr.slice(0, 500)}`));
        }
      });
    });
    const done = new Promise<Record<string, unknown>>((resolve, reject) => {
      child.once("exit", () => {
        const line = stdout
          .split("\n")
          .filter((l) => l.startsWith("{"))
          .pop();
        if (line) resolve(JSON.parse(line));
        else reject(new Error(`no result: ${stderr.slice(0, 500)}`));
      });
    });
    return { child, ready, done };
  });
  await Promise.all(procs.map((p) => p.ready));
  for (const { child } of procs) child.stdin.write("go\n");
  return Promise.all(procs.map((p) => p.done));
}

const rows = (dbPath: string, sql: string) => {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(sql).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
};

describe("request_child_work under real process contention", () => {
  it("six processes racing for three child slots admit exactly three, with no lock errors", async () => {
    const dbPath = freshDb({ maxChildWorkUnits: 3, maxChildDepth: 2, maxParallelWorkUnits: 8 });
    const results = await race(
      dbPath,
      Array.from({ length: 6 }, (_, i) => ({ kind: "request" as const, unitId: `racer-${i}` }))
    );
    expect(results.filter((r) => "threw" in r)).toEqual([]);
    expect(results.filter((r) => r.ok === true)).toHaveLength(3);
    expect(results.filter((r) => r.outcome === "budget_exhausted")).toHaveLength(3);
    expect(rows(dbPath, "SELECT 1 FROM coding_operations WHERE parent_unit_id = 'root'")).toHaveLength(3);
    expect(rows(dbPath, "SELECT 1 FROM work_unit_authority WHERE parent_unit_id = 'root'")).toHaveLength(3);
  }, 60_000);

  it("the same child requested by four processes is created once", async () => {
    const dbPath = freshDb();
    const results = await race(
      dbPath,
      Array.from({ length: 4 }, () => ({ kind: "request" as const, unitId: "only-one" }))
    );
    expect(results.filter((r) => "threw" in r)).toEqual([]);
    expect(results.filter((r) => r.ok === true)).toHaveLength(1);
    expect(rows(dbPath, "SELECT 1 FROM coding_operations WHERE operation_id = 'only-one'")).toHaveLength(1);
    expect(rows(dbPath, "SELECT 1 FROM work_unit_authority WHERE unit_id = 'only-one'")).toHaveLength(1);
  }, 60_000);

  it("four processes claiming four ready children under a parallel cap of two let exactly two start", async () => {
    const dbPath = freshDb({ maxParallelWorkUnits: 2, maxChildWorkUnits: 8, maxChildDepth: 2 });
    const { store, ledger } = openLedger(dbPath);
    try {
      for (let i = 0; i < 4; i += 1) {
        expect(
          ledger.requestChildWork({
            missionId: MISSION,
            parentUnitId: "root",
            workerId: "lead-worker",
            claimToken: "tok-parent-race",
            children: [childItem(`claimable-${i}`)]
          })
        ).toMatchObject({ ok: true });
      }
      // The parent already counts as in flight, so a cap of two leaves room for exactly one child claim.
      expect(store.workUnits(MISSION).filter((u) => u.status === "running")).toHaveLength(1);
    } finally {
      store.close();
    }
    const results = await race(
      dbPath,
      Array.from({ length: 4 }, (_, i) => ({
        kind: "claim" as const,
        unitId: `claimable-${i}`,
        token: `tok-c-${i}`,
        workerId: `worker-${i}`
      }))
    );
    expect(results.filter((r) => "threw" in r)).toEqual([]);
    const started = results.filter((r) => r.ok === true).length;
    const running = rows(dbPath, "SELECT 1 FROM coding_operations WHERE status = 'running'").length;
    expect(started).toBe(running - 1);
    expect(running).toBeLessThanOrEqual(2);
    expect(started).toBe(1);
    expect(results.filter((r) => r.outcome === "budget_exhausted")).toHaveLength(3);
  }, 60_000);
});
