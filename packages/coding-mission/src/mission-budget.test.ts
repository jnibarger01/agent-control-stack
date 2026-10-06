import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NIMBLE_ROUTING_ALGORITHM_VERSION } from "@agent-control-stack/actor-router";
import { afterEach, describe, expect, it } from "vitest";
import { CodingMissionController, CodingMissionStore, type CodingMissionPorts } from "./index.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const MERGE = "c".repeat(40);
const START = "2026-10-06T12:00:00.000Z";

function ports(
  now: () => string,
  workUnits = [{ operationId: "unit-1", dependsOn: [] as string[], title: "unit one" }]
): CodingMissionPorts {
  return {
    now,
    deploymentPolicy: {
      requirement: () => ({ required: false, action: "none", impact: "no runtime mutation" })
    },
    planner: { decompose: () => workUnits },
    router: {
      route: async () => ({
        workerId: "worker-1",
        algorithm: NIMBLE_ROUTING_ALGORITHM_VERSION,
        decision: { selected: "worker-1" }
      })
    },
    coder: {
      execute: async ({ operationId }) => ({
        status: "succeeded",
        value: { resultHash: `result-${operationId}`, files: [`${operationId}.ts`] }
      }),
      observe: async () => ({ status: "absent" })
    },
    reconciler: {
      reconcile: async () => ({ status: "succeeded", value: { headSha: HEAD, conflicts: [] } })
    },
    validator: {
      validate: async () => ({
        status: "succeeded",
        value: {
          checks: {
            tests: "PASS",
            typecheck: "PASS",
            lint: "PASS",
            format: "PASS",
            repository: "PASS",
            review: "PASS"
          },
          risks: []
        }
      })
    },
    publisher: {
      publish: async () => ({
        status: "succeeded",
        value: { prNumber: 1, prUrl: "https://example.test/pull/1", headSha: HEAD }
      }),
      observe: async () => ({ status: "absent" })
    },
    baseObserver: { currentBaseSha: async () => BASE },
    admission: { acquire: async () => ({ permitId: "permit-1" }) },
    merger: {
      merge: async () => ({ status: "succeeded", value: { mergeSha: MERGE } }),
      observe: async () => ({ status: "absent" })
    },
    deployer: {
      deploy: async () => ({ status: "succeeded", value: { deploymentId: "deploy-1" } }),
      observe: async () => ({ status: "absent" })
    },
    verifier: { verify: async () => ({ passed: true, checks: { merge: "PASS" } }) }
  };
}

describe("generic mission/work-unit semantics and durable budgets", () => {
  let root = "";
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
  });

  it("projects the existing coding runtime as typed Mission and WorkUnit records and keeps usage across restart", async () => {
    root = mkdtempSync(join(tmpdir(), "acs-mission-budget-"));
    const dbPath = join(root, "control.db");
    const controller = new CodingMissionController(
      dbPath,
      ports(() => START)
    );
    controller.create({
      missionId: "mission-generic",
      repository: "example/repo",
      baseRef: "main",
      baseSha: BASE,
      summary: "Generic mission view",
      budget: { maxIterations: 8, maxWorkUnits: 2, maxWallTimeMs: 60_000 }
    });

    expect(controller.store.mission("mission-generic", START)).toMatchObject({
      missionId: "mission-generic",
      kind: "coding",
      state: "PLANNING",
      budget: {
        limits: { maxIterations: 8, maxWorkUnits: 2, maxWallTimeMs: 60_000 },
        usage: { iterations: 0, workUnits: 0, wallTimeMs: 0 }
      }
    });

    const planned = await controller.advance("mission-generic");
    expect(planned.state).toBe("RUNNING");
    expect(controller.store.workUnits("mission-generic")).toEqual([
      {
        workUnitId: "unit-1",
        missionId: "mission-generic",
        kind: "coding",
        dependsOn: [],
        title: "unit one",
        status: "pending",
        files: []
      }
    ]);
    controller.close();

    const reopened = new CodingMissionStore(dbPath);
    expect(reopened.mission("mission-generic", START).budget.usage).toEqual({
      iterations: 1,
      workUnits: 1,
      wallTimeMs: 0
    });
    reopened.close();
  });

  it("fails before execution when the durable work-unit budget is exceeded", async () => {
    root = mkdtempSync(join(tmpdir(), "acs-mission-budget-"));
    const controller = new CodingMissionController(
      join(root, "control.db"),
      ports(
        () => START,
        [
          { operationId: "unit-1", dependsOn: [], title: "one" },
          { operationId: "unit-2", dependsOn: ["unit-1"], title: "two" }
        ]
      )
    );
    controller.create({
      missionId: "mission-work-limit",
      repository: "example/repo",
      baseRef: "main",
      baseSha: BASE,
      summary: "Bound work units",
      budget: { maxWorkUnits: 1 }
    });

    const result = await controller.advance("mission-work-limit");
    expect(result).toMatchObject({ state: "FAILED", code: "mission_budget_work_units_exhausted" });
    expect(controller.store.operations("mission-work-limit")).toEqual([]);
    controller.close();
  });

  it("persists iteration consumption and refuses the next controller cycle after exhaustion", async () => {
    root = mkdtempSync(join(tmpdir(), "acs-mission-budget-"));
    const dbPath = join(root, "control.db");
    const controller = new CodingMissionController(
      dbPath,
      ports(() => START)
    );
    controller.create({
      missionId: "mission-iteration-limit",
      repository: "example/repo",
      baseRef: "main",
      baseSha: BASE,
      summary: "Bound iterations",
      budget: { maxIterations: 1 }
    });

    expect((await controller.advance("mission-iteration-limit")).state).toBe("RUNNING");
    const stopped = await controller.advance("mission-iteration-limit");
    expect(stopped).toMatchObject({ state: "FAILED", code: "mission_budget_iterations_exhausted" });
    expect(controller.store.budget("mission-iteration-limit", START).usage.iterations).toBe(1);
    controller.close();
  });

  it("uses persisted creation time to enforce the wall-time budget", async () => {
    root = mkdtempSync(join(tmpdir(), "acs-mission-budget-"));
    let clock = START;
    const controller = new CodingMissionController(
      join(root, "control.db"),
      ports(() => clock)
    );
    controller.create({
      missionId: "mission-wall-limit",
      repository: "example/repo",
      baseRef: "main",
      baseSha: BASE,
      summary: "Bound wall time",
      budget: { maxWallTimeMs: 1_000 }
    });
    clock = "2026-10-06T12:00:02.000Z";

    const stopped = await controller.advance("mission-wall-limit");
    expect(stopped).toMatchObject({ state: "FAILED", code: "mission_budget_wall_time_exhausted" });
    expect(controller.store.budget("mission-wall-limit", clock).usage.wallTimeMs).toBe(2_000);
    controller.close();
  });

  it("lets only one store consume the final durable iteration", () => {
    root = mkdtempSync(join(tmpdir(), "acs-mission-budget-"));
    const dbPath = join(root, "control.db");
    const controller = new CodingMissionController(
      dbPath,
      ports(() => START)
    );
    controller.create({
      missionId: "mission-final-iteration",
      repository: "example/repo",
      baseRef: "main",
      baseSha: BASE,
      summary: "Serialize final iteration",
      budget: { maxIterations: 1 }
    });
    const second = new CodingMissionStore(dbPath);

    const firstClaim = controller.store.consumeIteration("mission-final-iteration", START);
    const secondClaim = second.consumeIteration("mission-final-iteration", START);

    expect(firstClaim.consumed).toBe(true);
    expect(secondClaim.consumed).toBe(false);
    expect(secondClaim.budget.usage.iterations).toBe(1);
    second.close();
    controller.close();
  });

  it("rejects invalid budget limits at the persistence boundary", () => {
    root = mkdtempSync(join(tmpdir(), "acs-mission-budget-"));
    const controller = new CodingMissionController(
      join(root, "control.db"),
      ports(() => START)
    );
    expect(() =>
      controller.create({
        missionId: "mission-invalid-budget",
        repository: "example/repo",
        baseRef: "main",
        baseSha: BASE,
        summary: "Invalid budget",
        budget: { maxIterations: 0 }
      })
    ).toThrow(/maxIterations/u);
    controller.close();
  });
});
