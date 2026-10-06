import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStackError } from "@agent-control-stack/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DELEGATION_BUDGET,
  FAILURE_CATEGORIES,
  MISSION_STATES,
  WORK_UNIT_STATUSES,
  assertMissionTransition,
  assertWorkUnitTransition,
  evaluateBudget,
  missionTransitionAllowed,
  parseWorkUnitPayload,
  workUnitTransitionAllowed,
  type MissionBudget
} from "./index.js";
import { CodingMissionStore } from "./store.js";

const T0 = "2026-10-06T00:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
let tick = 0;
const claim = (workerId = "w1") => ({
  token: `tok-${(tick += 1)}`,
  workerId,
  route: { workerId },
  claimedAt: at(1000)
});

function general(budget?: MissionBudget, store = new CodingMissionStore(":memory:")) {
  const mission = store.createGeneral({
    missionId: "m1",
    summary: "do a thing",
    initiatorId: "user-1",
    ...(budget ? { budget } : {}),
    now: T0
  });
  return { store, mission };
}

function advanceTo(store: CodingMissionStore, states: Array<(typeof MISSION_STATES)[number]>) {
  let mission = store.require("m1");
  for (const state of states) mission = store.transition(mission, state, T0, { event: "mission.state_changed" });
  return mission;
}

describe("mission state model", () => {
  it("defines the generalized states and lets terminal states stick", () => {
    for (const state of [
      "CREATED",
      "PLANNING",
      "READY",
      "RUNNING",
      "WAITING_FOR_DEPENDENCY",
      "WAITING_FOR_APPROVAL",
      "VERIFYING",
      "RECOVERING",
      "COMPLETED",
      "FAILED",
      "CANCELLED"
    ] as const) {
      expect(MISSION_STATES).toContain(state);
    }
    for (const terminal of ["COMPLETED", "FAILED", "CANCELLED"] as const) {
      for (const to of MISSION_STATES) {
        expect(missionTransitionAllowed("general", terminal, to)).toBe(false);
        expect(missionTransitionAllowed("coding", terminal, to)).toBe(false);
      }
    }
  });

  it("accepts the legal general path and rejects skipping or reversing it", () => {
    expect(missionTransitionAllowed("general", "CREATED", "PLANNING")).toBe(true);
    expect(missionTransitionAllowed("general", "PLANNING", "READY")).toBe(true);
    expect(missionTransitionAllowed("general", "READY", "RUNNING")).toBe(true);
    expect(missionTransitionAllowed("general", "RUNNING", "VERIFYING")).toBe(true);
    expect(missionTransitionAllowed("general", "VERIFYING", "COMPLETED")).toBe(true);
    expect(missionTransitionAllowed("general", "VERIFYING", "RECOVERING")).toBe(true);
    expect(missionTransitionAllowed("general", "CREATED", "COMPLETED")).toBe(false);
    expect(missionTransitionAllowed("general", "CREATED", "RUNNING")).toBe(false);
    expect(missionTransitionAllowed("general", "RUNNING", "CREATED")).toBe(false);
    expect(missionTransitionAllowed("general", "READY", "VERIFYING")).toBe(false);
    expect(() => assertMissionTransition("general", "CREATED", "COMPLETED")).toThrow(/cannot move/);
  });

  it("allows cancellation from every non-terminal state", () => {
    for (const from of MISSION_STATES) {
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(from)) continue;
      expect(missionTransitionAllowed("general", from, "CANCELLED")).toBe(true);
    }
  });

  it("covers every status in the work-unit table and keeps succeeded and cancelled terminal", () => {
    for (const status of WORK_UNIT_STATUSES) {
      if (status === "succeeded" || status === "cancelled") {
        for (const to of WORK_UNIT_STATUSES) expect(workUnitTransitionAllowed(status, to)).toBe(false);
      }
    }
    expect(workUnitTransitionAllowed("pending", "ready")).toBe(true);
    expect(workUnitTransitionAllowed("ready", "claimed")).toBe(true);
    expect(workUnitTransitionAllowed("running", "checkpointed")).toBe(true);
    expect(workUnitTransitionAllowed("verifying", "succeeded")).toBe(true);
    expect(workUnitTransitionAllowed("pending", "succeeded")).toBe(false);
    expect(workUnitTransitionAllowed("ready", "succeeded")).toBe(false);
    expect(workUnitTransitionAllowed("conflict", "running")).toBe(false);
    expect(() => assertWorkUnitTransition("succeeded", "running")).toThrow(/cannot move/);
  });
});

describe("mission store: generalized missions", () => {
  it("creates a general mission in CREATED and is idempotent on its id", () => {
    const { store, mission } = general();
    expect(mission).toMatchObject({ kind: "general", state: "CREATED", version: 1, initiatorId: "user-1" });
    expect(store.createGeneral({ missionId: "m1", summary: "do a thing", now: T0 }).version).toBe(1);
    expect(() => store.createGeneral({ missionId: "m1", summary: "something else", now: T0 })).toThrow(
      /another proposal/
    );
  });

  it("refuses an illegal transition and leaves the mission untouched", () => {
    const { store, mission } = general();
    expect(() => store.transition(mission, "COMPLETED", T0, { event: "x" })).toThrow(/cannot move/);
    expect(store.require("m1")).toMatchObject({ state: "CREATED", version: 1 });
  });

  it("guards transitions with the version, so only one racing writer wins", () => {
    const { store, mission } = general();
    const first = store.transition(mission, "PLANNING", T0, { event: "a" });
    expect(first.version).toBe(2);
    expect(() => store.transition(mission, "READY", T0, { event: "b" })).toThrow(
      expect.objectContaining({ code: "coding_mission_version_conflict" })
    );
    expect(store.require("m1").state).toBe("PLANNING");
  });

  it("never leaves a terminal state, even for coding missions", () => {
    const { store } = general();
    const done = advanceTo(store, ["READY", "RUNNING", "COMPLETED"]);
    expect(() => store.transition(done, "RUNNING", T0, { event: "x" })).toThrow(/cannot move/);
    const coding = store.create({
      missionId: "c1",
      repository: "o/r",
      baseRef: "main",
      baseSha: "a".repeat(40),
      summary: "s",
      branch: "b",
      deploymentRequired: false,
      deploymentAction: "none",
      deploymentImpact: "none",
      now: T0
    });
    const failed = store.transition(coding, "FAILED", T0, { event: "x" });
    expect(() => store.transition(failed, "RUNNING", T0, { event: "x" })).toThrow(/cannot move/);
  });

  it("keeps general missions out of the coding resume list, and cancelled coding missions too", () => {
    const { store } = general();
    const coding = store.create({
      missionId: "c1",
      repository: "o/r",
      baseRef: "main",
      baseSha: "a".repeat(40),
      summary: "s",
      branch: "b",
      deploymentRequired: false,
      deploymentAction: "none",
      deploymentImpact: "none",
      now: T0
    });
    expect(store.listResumable().map((mission) => mission.missionId)).toEqual(["c1"]);
    store.cancelMission("c1", { reason: "operator", now: T0 });
    expect(store.listResumable()).toEqual([]);
    expect(coding.kind).toBe("coding");
  });
});

describe("work units", () => {
  it("validates typed payloads and rejects unknown fields and mismatched kinds", () => {
    expect(parseWorkUnitPayload("shell", { argv: ["ls", "-la"], cwd: "/repo" })).toEqual({
      kind: "shell",
      argv: ["ls", "-la"],
      cwd: "/repo"
    });
    expect(parseWorkUnitPayload("swarm", { strategy: "parallel_candidates", fanOut: 3 })).toMatchObject({ fanOut: 3 });
    expect(() => parseWorkUnitPayload("shell", { argv: [] })).toThrow(/requires argv/);
    expect(() => parseWorkUnitPayload("shell", { argv: ["ls"], grant: "admin" })).toThrow(/unknown field grant/);
    expect(() => parseWorkUnitPayload("cua", { objective: "x", kind: "shell" })).toThrow(/does not match/);
    expect(() => parseWorkUnitPayload("swarm", { strategy: "recursive_spawn", fanOut: 3 })).toThrow(/bad strategy/);
    expect(() => parseWorkUnitPayload("recovery", { failedUnitId: "u", category: "made_up" })).toThrow(/bad category/);
    expect(() => parseWorkUnitPayload("tool", "nope")).toThrow(/must be an object/);
  });

  it("adds units with dependencies, derives depth, and rejects cycles, strangers and duplicates", () => {
    const { store } = general();
    const result = store.addWorkUnits(
      "m1",
      [
        { unitId: "plan", kind: "planning", title: "plan", payload: { goal: "g" } },
        { unitId: "code", kind: "coding", title: "code", dependsOn: ["plan"] },
        { unitId: "child", kind: "agent", title: "child", parentUnitId: "code", payload: { role: "r", prompt: "p" } }
      ],
      T0
    );
    expect(result).toMatchObject({ ok: true, created: ["plan", "code", "child"] });
    expect(store.workUnits("m1").map((unit) => [unit.unitId, unit.depth, unit.status])).toEqual([
      ["child", 1, "pending"],
      ["code", 0, "pending"],
      ["plan", 0, "pending"]
    ]);
    expect(() => store.addWorkUnits("m1", [{ unitId: "plan", kind: "planning", title: "x" }], T0)).toThrow(
      /already exists/
    );
    expect(() =>
      store.addWorkUnits("m1", [{ unitId: "z", kind: "coding", title: "x", dependsOn: ["ghost"] }], T0)
    ).toThrow(/missing or cyclic/);
    expect(() =>
      store.addWorkUnits(
        "m1",
        [
          { unitId: "a", kind: "coding", title: "a", dependsOn: ["b"] },
          { unitId: "b", kind: "coding", title: "b", dependsOn: ["a"] }
        ],
        T0
      )
    ).toThrow(/missing or cyclic/);
    expect(() =>
      store.addWorkUnits("m1", [{ unitId: "s", kind: "shell", title: "s", payload: { argv: ["x"], admin: true } }], T0)
    ).toThrow(/unknown field/);
    expect(store.workUnits("m1")).toHaveLength(3);
  });

  it("releases dependents only after every dependency has succeeded", () => {
    const { store } = general();
    store.addWorkUnits(
      "m1",
      [
        { unitId: "a", kind: "coding", title: "a" },
        { unitId: "b", kind: "coding", title: "b" },
        { unitId: "c", kind: "coding", title: "c", dependsOn: ["a", "b"] }
      ],
      T0
    );
    expect(store.releaseReadyUnits("m1", T0).sort()).toEqual(["a", "b"]);
    const a = claim();
    expect(store.claimUnit("m1", "a", a)).toMatchObject({ ok: true, attempt: 1 });
    store.completeOperation("m1", "a", a.token, { resultHash: "h", files: [] });
    expect(store.releaseReadyUnits("m1", T0)).toEqual([]);
    expect(store.claimUnit("m1", "c", claim())).toEqual({ ok: false, outcome: "dependencies_unmet" });
    const b = claim();
    store.claimUnit("m1", "b", b);
    store.completeOperation("m1", "b", b.token, { resultHash: "h2", files: [] });
    expect(store.releaseReadyUnits("m1", T0)).toEqual(["c"]);
    expect(store.claimUnit("m1", "c", claim())).toMatchObject({ ok: true });
  });

  it("refuses to add or release units on a terminal mission", () => {
    const { store } = general();
    store.addWorkUnits("m1", [{ unitId: "a", kind: "coding", title: "a" }], T0);
    store.cancelMission("m1", { reason: "stop", now: T0 });
    expect(() => store.addWorkUnits("m1", [{ unitId: "b", kind: "coding", title: "b" }], T0)).toThrow(
      /not_active|mission is/
    );
    expect(store.releaseReadyUnits("m1", T0)).toEqual([]);
  });
});

describe("claim fencing and concurrency", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function twoConnections() {
    const dir = mkdtempSync(join(tmpdir(), "acs-mission-"));
    dirs.push(dir);
    const path = join(dir, "db.sqlite");
    return [new CodingMissionStore(path), new CodingMissionStore(path)] as const;
  }

  it("lets exactly one of two workers win the same claim", () => {
    const [one, two] = twoConnections();
    one.createGeneral({ missionId: "m1", summary: "s", now: T0 });
    one.addWorkUnits("m1", [{ unitId: "u", kind: "coding", title: "u" }], T0);
    const results = [one.claimUnit("m1", "u", claim("w1")), two.claimUnit("m1", "u", claim("w2"))];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toEqual({ ok: false, outcome: "claim_conflict" });
    expect(one.workUnits("m1")[0]).toMatchObject({ status: "running", attempt: 1 });
  });

  it("rejects a result from a worker that does not hold the claim token", () => {
    const { store } = general();
    store.addWorkUnits("m1", [{ unitId: "u", kind: "coding", title: "u" }], T0);
    const mine = claim("w1");
    store.claimUnit("m1", "u", mine);
    expect(() => store.completeOperation("m1", "u", "someone-elses-token", { resultHash: "h", files: [] })).toThrow(
      expect.objectContaining({ code: "coding_mission_claim_conflict" })
    );
    expect(() =>
      store.failUnit("m1", "u", "someone-elses-token", { category: "timeout", retryable: true, now: T0 })
    ).toThrow(expect.objectContaining({ code: "coding_mission_claim_conflict" }));
    store.completeOperation("m1", "u", mine.token, { resultHash: "h", files: [] });
    expect(store.workUnits("m1")[0]?.status).toBe("succeeded");
    // A replayed or stale completion cannot overwrite an accepted result.
    expect(() => store.completeOperation("m1", "u", mine.token, { resultHash: "evil", files: [] })).toThrow();
    expect(store.workUnits("m1")[0]?.resultHash).toBe("h");
  });

  it("rejects a stale worker's result after the mission was cancelled mid-flight", () => {
    const { store } = general();
    store.addWorkUnits("m1", [{ unitId: "u", kind: "coding", title: "u" }], T0);
    const active = claim("w1");
    store.claimUnit("m1", "u", active);
    const cancelled = store.cancelMission("m1", { reason: "operator_cancel", now: at(10) });
    expect(cancelled).toMatchObject({ ok: true, cancelled: ["u"], uncertain: ["u"], alreadyCancelled: false });
    expect(() => store.completeOperation("m1", "u", active.token, { resultHash: "late", files: [] })).toThrow(
      expect.objectContaining({ code: "coding_mission_claim_conflict" })
    );
    expect(store.workUnits("m1")[0]).toMatchObject({ status: "cancelled", cancelExternalState: "uncertain" });
    expect(store.workUnits("m1")[0]?.resultHash).toBeUndefined();
  });

  it("does not let a retry race the original attempt", () => {
    const { store } = general({ maxRetriesPerWorkUnit: 3 });
    store.addWorkUnits("m1", [{ unitId: "u", kind: "coding", title: "u" }], T0);
    const original = claim("w1");
    store.claimUnit("m1", "u", original);
    // The original is still running, so a retry must refuse rather than start a second concurrent attempt.
    expect(store.retryUnit("m1", "u", at(5))).toEqual({ ok: false, outcome: "not_retryable" });
    expect(store.claimUnit("m1", "u", claim("w2"))).toEqual({ ok: false, outcome: "claim_conflict" });
    expect(store.workUnits("m1")[0]).toMatchObject({ status: "running", workerId: "w1" });
  });

  it("lets two simultaneous child-work requests succeed only up to the durable child cap", () => {
    const [one, two] = twoConnections();
    one.createGeneral({ missionId: "m1", summary: "s", budget: { maxChildWorkUnits: 1 }, now: T0 });
    one.addWorkUnits("m1", [{ unitId: "root", kind: "agent", title: "r", payload: { role: "r", prompt: "p" } }], T0);
    const outcomes = [
      one.addWorkUnits(
        "m1",
        [{ unitId: "c1", kind: "agent", title: "c", parentUnitId: "root", payload: { role: "r", prompt: "p" } }],
        T0
      ),
      two.addWorkUnits(
        "m1",
        [{ unitId: "c2", kind: "agent", title: "c", parentUnitId: "root", payload: { role: "r", prompt: "p" } }],
        T0
      )
    ];
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.find((outcome) => !outcome.ok)).toMatchObject({
      outcome: "budget_exhausted",
      decision: { exhausted: [expect.objectContaining({ metric: "child_work_units" })] }
    });
    expect(one.workUnits("m1")).toHaveLength(2);
  });

  it("holds the parallel cap under concurrent claims and across a reopened connection", () => {
    const [one, two] = twoConnections();
    one.createGeneral({ missionId: "m1", summary: "s", budget: { maxParallelWorkUnits: 1 }, now: T0 });
    one.addWorkUnits(
      "m1",
      [
        { unitId: "a", kind: "coding", title: "a" },
        { unitId: "b", kind: "coding", title: "b" }
      ],
      T0
    );
    const results = [one.claimUnit("m1", "a", claim("w1")), two.claimUnit("m1", "b", claim("w2"))];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({
      outcome: "budget_exhausted",
      decision: { exhausted: [expect.objectContaining({ metric: "parallel_work_units", limit: 1, projected: 2 })] }
    });
    // A restart does not reset the cap: a fresh connection sees the same durable in-flight unit.
    const reopened = new CodingMissionStore(one.db);
    expect(reopened.claimUnit("m1", results[0]?.ok ? "b" : "a", claim("w3"))).toMatchObject({
      outcome: "budget_exhausted"
    });
  });
});

describe("budgets", () => {
  it("applies the documented delegation defaults only when asked, and lets policy override them", () => {
    expect(DEFAULT_DELEGATION_BUDGET).toEqual({
      maxChildDepth: 2,
      maxParallelWorkUnits: 4,
      maxChildWorkUnits: 8,
      maxRetriesPerWorkUnit: 2
    });
    const { store } = general({ ...DEFAULT_DELEGATION_BUDGET, maxChildDepth: 1 });
    expect(store.budget("m1")?.limits).toEqual({
      child_depth: 1,
      parallel_work_units: 4,
      child_work_units: 8,
      retries_per_work_unit: 2
    });
    const bare = general(undefined, new CodingMissionStore(":memory:"));
    expect(bare.store.budget("m1")).toBeUndefined();
  });

  it("rejects malformed budgets rather than storing a nonsense cap", () => {
    expect(() => general({ maxWorkUnits: -1 })).toThrow(/non-negative/);
    expect(() => general({ maxParallelWorkUnits: 0 })).toThrow(/at least 1/);
    expect(() => general({ maxWorkUnits: 1.5 })).toThrow(/integer/);
  });

  it("caps the number of work units and reports the refusal as an explicit outcome with durable evidence", () => {
    const { store } = general({ maxWorkUnits: 2 });
    expect(
      store.addWorkUnits(
        "m1",
        [
          { unitId: "a", kind: "coding", title: "a" },
          { unitId: "b", kind: "coding", title: "b" }
        ],
        T0
      )
    ).toMatchObject({ ok: true });
    const refused = store.addWorkUnits("m1", [{ unitId: "c", kind: "coding", title: "c" }], T0);
    expect(refused).toEqual({
      ok: false,
      outcome: "budget_exhausted",
      decision: {
        allowed: false,
        exhausted: [{ metric: "work_units", limit: 2, projected: 3 }],
        unaccounted: []
      }
    });
    expect(store.events("m1").map((event) => event.name)).toContain("budget.exhausted");
    expect(store.workUnits("m1")).toHaveLength(2);
  });

  it("caps child depth", () => {
    const { store } = general({ maxChildDepth: 1 });
    store.addWorkUnits("m1", [{ unitId: "root", kind: "agent", title: "r", payload: { role: "r", prompt: "p" } }], T0);
    const payload = { role: "r", prompt: "p" };
    expect(
      store.addWorkUnits("m1", [{ unitId: "d1", kind: "agent", title: "d", parentUnitId: "root", payload }], T0)
    ).toMatchObject({ ok: true });
    expect(
      store.addWorkUnits("m1", [{ unitId: "d2", kind: "agent", title: "d", parentUnitId: "d1", payload }], T0)
    ).toMatchObject({
      ok: false,
      decision: { exhausted: [expect.objectContaining({ metric: "child_depth", limit: 1, projected: 2 })] }
    });
  });

  it("caps retries from the durable attempt counter and marks the unit with retry_budget_exhausted", () => {
    const { store } = general({ maxRetriesPerWorkUnit: 1 });
    store.addWorkUnits("m1", [{ unitId: "u", kind: "coding", title: "u" }], T0);
    const first = claim();
    store.claimUnit("m1", "u", first);
    expect(store.failUnit("m1", "u", first.token, { category: "timeout", retryable: true, now: at(1) })).toBe(
      "retryable"
    );
    expect(store.retryUnit("m1", "u", at(2))).toEqual({ ok: true, attempt: 1 });
    const second = claim();
    expect(store.claimUnit("m1", "u", second)).toMatchObject({ ok: true, attempt: 2 });
    store.failUnit("m1", "u", second.token, { category: "tool_failure", retryable: true, now: at(3) });
    const refused = store.retryUnit("m1", "u", at(4));
    expect(refused).toMatchObject({
      ok: false,
      outcome: "budget_exhausted",
      decision: { exhausted: [expect.objectContaining({ metric: "retries_per_work_unit", limit: 1, projected: 2 })] }
    });
    expect(store.workUnits("m1")[0]).toMatchObject({ status: "failed", failureCategory: "retry_budget_exhausted" });
    expect(store.retryUnit("m1", "u", at(5))).toEqual({ ok: false, outcome: "not_retryable" });
  });

  it("enforces the wall-clock cap before admission", () => {
    const { store } = general({ maxWallClockMs: 1000 });
    store.addWorkUnits("m1", [{ unitId: "u", kind: "coding", title: "u" }], T0);
    const late = { ...claim(), claimedAt: at(5000) };
    expect(store.claimUnit("m1", "u", late)).toMatchObject({
      ok: false,
      outcome: "budget_exhausted",
      decision: { exhausted: [expect.objectContaining({ metric: "wall_clock_ms", limit: 1000, projected: 5000 })] }
    });
    expect(store.workUnits("m1")[0]?.status).toBe("pending");
  });

  it("reports capped worker-reported metrics as unaccounted until reported, never as zero", () => {
    const { store } = general({ maxToolCalls: 5, maxWorkUnits: 10 });
    const result = store.addWorkUnits("m1", [{ unitId: "u", kind: "coding", title: "u" }], T0);
    expect(result).toMatchObject({ ok: true, decision: { allowed: true, unaccounted: ["tool_calls"] } });
    expect(evaluateBudget({ tool_calls: 5 }, {}, new Set())).toMatchObject({ unaccounted: ["tool_calls"] });
    expect(evaluateBudget({ tool_calls: 5 }, {}, new Set(["tool_calls"]))).toMatchObject({ unaccounted: [] });
    expect(evaluateBudget({}, { tool_calls: 99 }, new Set())).toMatchObject({ allowed: true, unaccounted: [] });
  });

  it("ingests reported usage monotonically and flags threshold and exhaustion", () => {
    const { store } = general({ maxToolCalls: 10 });
    expect(store.recordUsage("m1", "tool_calls", 7, T0).decision.allowed).toBe(true);
    expect(store.recordUsage("m1", "tool_calls", 1, T0).used).toBe(8);
    expect(store.events("m1").filter((event) => event.name === "budget.threshold_reached")).toHaveLength(1);
    const over = store.recordUsage("m1", "tool_calls", 5, T0);
    expect(over).toMatchObject({
      used: 13,
      decision: { allowed: false, exhausted: [{ metric: "tool_calls", limit: 10, projected: 13 }] }
    });
    expect(store.events("m1").map((event) => event.name)).toContain("budget.exhausted");
    expect(() => store.recordUsage("m1", "tool_calls", -1, T0)).toThrow(/non-negative/);
    expect(() => store.recordUsage("m1", "work_units" as never, 1, T0)).toThrow(/reported metric/);
    expect(store.budget("m1")?.usage).toEqual({ tool_calls: 13 });
  });

  it("makes budget limits immutable once written", () => {
    const { store } = general({ maxWorkUnits: 2 });
    expect(() => store.db.exec("UPDATE mission_budgets SET max_work_units = 999")).toThrow(/written once/);
  });
});

describe("failure handling and recovery safety", () => {
  it("covers the normalized failure taxonomy", () => {
    expect(FAILURE_CATEGORIES).toEqual(
      expect.arrayContaining([
        "policy_denied",
        "authority_expired",
        "lease_lost",
        "worker_unavailable",
        "tool_failure",
        "timeout",
        "invalid_output",
        "dependency_failure",
        "verification_failure",
        "environment_changed",
        "retry_budget_exhausted",
        "cancelled",
        "unknown"
      ])
    );
  });

  it("never parks a policy or authority failure as retryable", () => {
    const { store } = general();
    store.addWorkUnits("m1", [{ unitId: "u", kind: "coding", title: "u" }], T0);
    const token = claim();
    store.claimUnit("m1", "u", token);
    expect(store.failUnit("m1", "u", token.token, { category: "policy_denied", retryable: true, now: T0 })).toBe(
      "failed"
    );
    expect(store.retryUnit("m1", "u", T0)).toEqual({ ok: false, outcome: "not_retryable" });
  });

  it("fails closed on retrying units whose external effect is unproven", () => {
    const { store } = general();
    store.addWorkUnits(
      "m1",
      [
        { unitId: "u", kind: "coding", title: "u" },
        { unitId: "v", kind: "coding", title: "v" }
      ],
      T0
    );
    store.claimUnit("m1", "u", claim());
    store.markOperation("m1", "u", "unknown");
    expect(store.retryUnit("m1", "u", T0)).toEqual({ ok: false, outcome: "retry_unsafe" });
    store.claimUnit("m1", "v", claim());
    store.markOperation("m1", "v", "conflict");
    expect(store.retryUnit("m1", "v", T0)).toEqual({ ok: false, outcome: "retry_unsafe" });
  });

  it("retries a retryable unit with a fresh claim fence", () => {
    const { store } = general({ maxRetriesPerWorkUnit: 2 });
    store.addWorkUnits("m1", [{ unitId: "u", kind: "coding", title: "u" }], T0);
    const first = claim("w1");
    store.claimUnit("m1", "u", first);
    store.failUnit("m1", "u", first.token, { category: "worker_unavailable", retryable: true, now: T0 });
    expect(store.retryUnit("m1", "u", T0)).toMatchObject({ ok: true });
    expect(store.workUnits("m1")[0]).toMatchObject({ status: "pending", attempt: 1 });
    expect(store.workUnits("m1")[0]?.claimToken).toBeUndefined();
    // The first worker's old token is dead.
    expect(() => store.completeOperation("m1", "u", first.token, { resultHash: "h", files: [] })).toThrow();
    const second = claim("w2");
    expect(store.claimUnit("m1", "u", second)).toMatchObject({ ok: true, attempt: 2 });
    store.completeOperation("m1", "u", second.token, { resultHash: "ok", files: [] });
  });
});

describe("cancellation", () => {
  it("cancels the mission and every unfinished unit, and reports uncertain external state explicitly", () => {
    const { store } = general();
    store.addWorkUnits(
      "m1",
      [
        { unitId: "done", kind: "coding", title: "d" },
        { unitId: "active", kind: "coding", title: "a" },
        { unitId: "waiting", kind: "coding", title: "w", dependsOn: ["done"] },
        { unitId: "blocked", kind: "coding", title: "b", dependsOn: ["active"] }
      ],
      T0
    );
    const done = claim();
    store.claimUnit("m1", "done", done);
    store.completeOperation("m1", "done", done.token, { resultHash: "h", files: [] });
    store.releaseReadyUnits("m1", T0);
    store.claimUnit("m1", "active", claim());
    const result = store.cancelMission("m1", { reason: "operator_cancel", now: at(50) });
    expect(result).toMatchObject({ ok: true, alreadyCancelled: false });
    if (!result.ok) throw new Error("expected cancellation");
    expect(result.mission).toMatchObject({ state: "CANCELLED", failureCode: "operator_cancel" });
    expect(result.cancelled.sort()).toEqual(["active", "blocked", "waiting"]);
    expect(result.uncertain).toEqual(["active"]);
    const units = Object.fromEntries(store.workUnits("m1").map((unit) => [unit.unitId, unit]));
    expect(units.done?.status).toBe("succeeded");
    expect(units.active).toMatchObject({ status: "cancelled", cancelExternalState: "uncertain" });
    expect(units.waiting).toMatchObject({ status: "cancelled", cancelExternalState: "none" });
    expect(store.events("m1").filter((event) => event.name === "work_unit.cancelled")).toHaveLength(3);
  });

  it("stops admitting work, is idempotent, and refuses to cancel a finished mission", () => {
    const { store } = general();
    store.addWorkUnits("m1", [{ unitId: "u", kind: "coding", title: "u" }], T0);
    store.cancelMission("m1", { reason: "x", now: T0 });
    expect(store.claimUnit("m1", "u", claim())).toEqual({ ok: false, outcome: "mission_not_active" });
    expect(store.retryUnit("m1", "u", T0)).toEqual({ ok: false, outcome: "mission_not_active" });
    expect(store.cancelMission("m1", { reason: "again", now: T0 })).toMatchObject({ ok: true, alreadyCancelled: true });

    const second = general(undefined, new CodingMissionStore(":memory:"));
    advanceTo(second.store, ["READY", "RUNNING", "COMPLETED"]);
    expect(second.store.cancelMission("m1", { reason: "late", now: T0 })).toEqual({
      ok: false,
      outcome: "already_terminal",
      state: "COMPLETED"
    });
  });

  it("honors the expected version when cancelling", () => {
    const { store, mission } = general();
    store.transition(mission, "PLANNING", T0, { event: "x" });
    expect(() => store.cancelMission("m1", { reason: "x", now: T0, expectedVersion: 1 })).toThrow(
      expect.objectContaining({ code: "coding_mission_version_conflict" })
    );
    expect(store.require("m1").state).toBe("PLANNING");
  });
});

describe("compatibility with the coding mission flow", () => {
  it("still plans, claims and completes through the legacy operation API and exposes work-unit views", () => {
    const store = new CodingMissionStore(":memory:");
    const mission = store.create({
      missionId: "c1",
      repository: "o/r",
      baseRef: "main",
      baseSha: "a".repeat(40),
      summary: "s",
      branch: "acs/mission/c1",
      deploymentRequired: false,
      deploymentAction: "none",
      deploymentImpact: "none",
      now: T0
    });
    const running = store.replaceOperations(
      mission,
      [
        { operationId: "op-1", dependsOn: [], title: "first" },
        { operationId: "op-2", dependsOn: ["op-1"], title: "second" }
      ],
      T0
    );
    expect(running.state).toBe("RUNNING");
    const token = claim();
    expect(store.claim("c1", "op-1", token)).toBe(true);
    expect(store.claim("c1", "op-1", claim())).toBe(false);
    store.completeOperation("c1", "op-1", token.token, { resultHash: "h", files: ["a.ts"] });
    expect(store.operations("c1").map((operation) => [operation.operationId, operation.status])).toEqual([
      ["op-1", "succeeded"],
      ["op-2", "pending"]
    ]);
    expect(store.workUnits("c1").map((unit) => [unit.unitId, unit.kind, unit.status, unit.attempt])).toEqual([
      ["op-1", "coding", "succeeded", 1],
      ["op-2", "coding", "pending", 0]
    ]);
    expect(store.require("c1")).toMatchObject({ kind: "coding", state: "RUNNING" });
  });

  it("does not count a released claim as an attempt", () => {
    const store = new CodingMissionStore(":memory:");
    const mission = store.create({
      missionId: "c1",
      repository: "o/r",
      baseRef: "main",
      baseSha: "a".repeat(40),
      summary: "s",
      branch: "b",
      deploymentRequired: false,
      deploymentAction: "none",
      deploymentImpact: "none",
      now: T0
    });
    store.replaceOperations(mission, [{ operationId: "op-1", dependsOn: [], title: "first" }], T0);
    store.claim("c1", "op-1", claim());
    store.resetClaim("c1", "op-1");
    expect(store.workUnits("c1")[0]).toMatchObject({ status: "pending", attempt: 0 });
  });

  it("surfaces ControlStackError codes, not opaque errors, on misuse", () => {
    const { store } = general();
    expect(() => store.addWorkUnits("nope", [], T0)).toThrow(ControlStackError);
  });
});
