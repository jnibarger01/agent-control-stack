import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NIMBLE_ROUTING_ALGORITHM_VERSION } from "@agent-control-stack/actor-router";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodingMissionController,
  CodingMissionStore,
  DEFAULT_RECOVERY_POLICY,
  readMissionFlightRecord,
  recoveryBackoffMs,
  resolveRecoveryPolicy,
  type CodingMissionPorts,
  type ExternalOutcome
} from "./index.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const T0 = Date.parse("2026-10-11T00:00:00.000Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();

function ok<T>(value: T): ExternalOutcome<T> {
  return { status: "succeeded", value };
}

interface World {
  clock: { ms: number };
  observe: { value: ExternalOutcome<{ resultHash: string; files: string[] }> };
  executed: string[];
  ports: CodingMissionPorts;
}

function world(extra: Partial<CodingMissionPorts> = {}): World {
  const w: World = {
    clock: { ms: 0 },
    observe: { value: { status: "absent" } },
    executed: [],
    ports: undefined as unknown as CodingMissionPorts
  };
  w.ports = {
    now: () => iso(w.clock.ms),
    deploymentPolicy: { requirement: () => ({ required: false, action: "none", impact: "none" }) },
    planner: { decompose: () => [{ operationId: "edit-api", dependsOn: [], title: "edit api" }] },
    router: {
      route: async () => ({
        workerId: "semantic-winner",
        algorithm: NIMBLE_ROUTING_ALGORITHM_VERSION,
        decision: { selected: "semantic-winner" }
      })
    },
    coder: {
      execute: async ({ operationId }) => {
        w.executed.push(operationId);
        return ok({ resultHash: "result-1", files: ["api.ts"] });
      },
      observe: async () => w.observe.value
    },
    reconciler: { reconcile: async () => ok({ headSha: HEAD, conflicts: [] }) },
    validator: {
      validate: async () =>
        ok({
          checks: {
            tests: "PASS",
            typecheck: "PASS",
            lint: "PASS",
            format: "PASS",
            repository: "PASS",
            review: "PASS"
          },
          risks: []
        })
    },
    publisher: {
      publish: async () => ok({ prNumber: 1, prUrl: "https://example.test/pull/1", headSha: HEAD }),
      observe: async () => ({ status: "absent" })
    },
    baseObserver: { currentBaseSha: async () => BASE },
    admission: { acquire: async () => ({ permitId: "permit-1" }) },
    merger: { merge: async () => ok({ mergeSha: "c".repeat(40) }), observe: async () => ({ status: "absent" }) },
    deployer: { deploy: async () => ok({ deploymentId: "d" }), observe: async () => ({ status: "absent" }) },
    verifier: { verify: async () => ({ passed: true, checks: { health: "PASS" } }) },
    ...extra
  };
  return w;
}

let directory: string | undefined;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

/** A mission that has been planned (RUNNING) with one pending operation, `edit-api`. */
async function planned(w: World, dbPath = ":memory:") {
  const controller = new CodingMissionController(dbPath, w.ports);
  controller.create({
    missionId: "m1",
    repository: "example/repo",
    baseRef: "main",
    baseSha: BASE,
    summary: "recover"
  });
  await controller.advance("m1");
  expect(controller.store.operations("m1")[0]).toMatchObject({ operationId: "edit-api", status: "pending" });
  return controller;
}

/** A worker took the claim and then vanished: running, with a claim older than the TTL. */
function vanishedWorker(controller: CodingMissionController, w: World, token: string) {
  const claimed = controller.store.claim("m1", "edit-api", {
    token,
    workerId: "w-crash",
    route: {},
    claimedAt: iso(w.clock.ms)
  });
  expect(claimed).toBe(true);
  w.clock.ms += 60_000;
}

describe("recovery policy", () => {
  it("backs off exponentially and caps", () => {
    const policy = { maxRecoveries: 5, baseBackoffMs: 1_000, maxBackoffMs: 10_000 };
    expect([1, 2, 3, 4, 5, 6].map((n) => recoveryBackoffMs(n, policy))).toEqual([
      1_000, 2_000, 4_000, 8_000, 10_000, 10_000
    ]);
    expect(recoveryBackoffMs(1_000, policy)).toBe(10_000);
  });

  it("rejects unbounded or inconsistent policies", () => {
    for (const bad of [
      { maxRecoveries: 11 },
      { maxRecoveries: -1 },
      { maxRecoveries: 1.5 },
      { baseBackoffMs: -1 },
      { baseBackoffMs: 5_000, maxBackoffMs: 1_000 },
      { maxBackoffMs: 3_600_001 }
    ]) {
      expect(() => resolveRecoveryPolicy(bad), JSON.stringify(bad)).toThrowError(
        expect.objectContaining({ code: "recovery_policy_invalid" })
      );
    }
    expect(resolveRecoveryPolicy(undefined)).toEqual(DEFAULT_RECOVERY_POLICY);
  });
});

describe("self-healing: stale claim recovery", () => {
  it("fences a vanished worker, waits out the backoff without degrading, then resumes exactly once", async () => {
    const w = world();
    const controller = await planned(w);
    vanishedWorker(controller, w, "tok-stale");

    const recovered = await controller.advance("m1");
    expect(recovered).toMatchObject({ progressed: true, code: "operation_absent" });
    const op = controller.store.operations("m1")[0]!;
    expect(op).toMatchObject({ status: "pending", retryNotBefore: iso(w.clock.ms + 2_000) });
    expect(op.claimToken).toBeUndefined();
    // The replay shows the unit back to pending, not stuck in its last claimed state.
    expect(readMissionFlightRecord(controller.store.db, "m1").reconstruction.units["edit-api"]).toBe("pending");

    // The stale worker's late completion is refused: its fence no longer matches anything.
    expect(() =>
      controller.store.completeOperation("m1", "edit-api", "tok-stale", { resultHash: "late", files: [] })
    ).toThrowError(expect.objectContaining({ code: "coding_mission_claim_conflict" }));

    // During the backoff nothing runs and the mission is not degraded just because a unit is waiting.
    const waiting = await controller.advance("m1");
    expect(waiting).toMatchObject({ progressed: false, code: "recovery_backoff", state: "RUNNING" });
    expect(w.executed).toEqual([]);

    // After the backoff the unit is claimed by a new fence and executed once.
    w.clock.ms += 2_000;
    await controller.advance("m1");
    expect(w.executed).toEqual(["edit-api"]);
    expect(controller.store.operations("m1")[0]).toMatchObject({ status: "succeeded", resultHash: "result-1" });
    expect(controller.store.escalations("m1")).toEqual([]);
  });

  it("stops repeated vanishing as poison work, escalates it, and degrades instead of retrying forever", async () => {
    const w = world({ recoveryPolicy: { maxRecoveries: 3, baseBackoffMs: 1_000, maxBackoffMs: 60_000 } });
    const controller = await planned(w);
    const seen: string[] = [];
    for (let crash = 1; crash <= 3; crash += 1) {
      vanishedWorker(controller, w, `tok-${crash}`);
      await controller.advance("m1");
      seen.push(controller.store.operations("m1")[0]!.retryNotBefore!);
      w.clock.ms += 600_000;
    }
    expect(seen.map((value, index) => Date.parse(value) - (T0 + 60_000 * (index + 1) + 600_000 * index))).toEqual([
      1_000, 2_000, 4_000
    ]);

    vanishedWorker(controller, w, "tok-4");
    const stopped = await controller.advance("m1");
    expect(stopped).toMatchObject({ state: "DEGRADED", code: "poison_work" });
    expect(controller.store.operations("m1")[0]).toMatchObject({ status: "failed" });
    expect(controller.store.workUnits("m1")[0]).toMatchObject({ failureCategory: "retry_budget_exhausted" });
    expect(controller.store.escalations("m1")).toEqual([
      expect.objectContaining({
        unitId: "edit-api",
        kind: "poison_work",
        detail: expect.objectContaining({ recoveries: 3 })
      })
    ]);

    // Nothing can claim it again, and the executor never ran.
    expect(
      controller.store.claimUnit("m1", "edit-api", { token: "t", workerId: "w", route: {}, claimedAt: iso(w.clock.ms) })
    ).toMatchObject({ ok: false });
    expect(w.executed).toEqual([]);
    const replay = readMissionFlightRecord(controller.store.db, "m1");
    expect(replay.reconstruction.units["edit-api"]).toBe("failed");
    expect(replay.verification.verdict).toBe("verified");
    expect(replay.records.map((r) => r.kind)).toEqual(
      expect.arrayContaining(["work_unit.recovered", "work_unit.poisoned", "recovery.escalated"])
    );
  });

  it("with maxRecoveries 0 the first stale claim is poison", async () => {
    const w = world({ recoveryPolicy: { maxRecoveries: 0 } });
    const controller = await planned(w);
    vanishedWorker(controller, w, "tok-1");
    expect(await controller.advance("m1")).toMatchObject({ state: "DEGRADED", code: "poison_work" });
  });

  it("is idempotent for the same released claim and refuses a claim that is not current", async () => {
    const w = world();
    const controller = await planned(w);
    vanishedWorker(controller, w, "tok-1");
    const now = iso(w.clock.ms);
    const first = controller.store.releaseStaleClaim("m1", "edit-api", "tok-1", now);
    expect(first).toMatchObject({ outcome: "rescheduled", sequence: 1, replayed: false });
    const again = controller.store.releaseStaleClaim("m1", "edit-api", "tok-1", iso(w.clock.ms + 99_000));
    expect(again).toMatchObject({ outcome: "rescheduled", sequence: 1, replayed: true });
    expect(again.retryNotBefore).toBe(first.retryNotBefore);
    expect(controller.store.db.prepare("SELECT COUNT(*) AS n FROM work_unit_recoveries").get()).toEqual({ n: 1 });
    // A token that never held the claim cannot release it.
    expect(() => controller.store.releaseStaleClaim("m1", "edit-api", "tok-never", now)).toThrowError(
      expect.objectContaining({ code: "coding_mission_claim_conflict" })
    );
  });

  it("does not let a stale holder release or complete a newer claim", async () => {
    const w = world();
    const controller = await planned(w);
    vanishedWorker(controller, w, "tok-old");
    controller.store.releaseStaleClaim("m1", "edit-api", "tok-old", iso(w.clock.ms));
    w.clock.ms += 5_000;
    expect(
      controller.store.claim("m1", "edit-api", {
        token: "tok-new",
        workerId: "w2",
        route: {},
        claimedAt: iso(w.clock.ms)
      })
    ).toBe(true);
    // The old holder cannot complete the new claim, and re-releasing its own old fence only replays history.
    expect(() =>
      controller.store.completeOperation("m1", "edit-api", "tok-old", { resultHash: "x", files: [] })
    ).toThrowError(expect.objectContaining({ code: "coding_mission_claim_conflict" }));
    expect(controller.store.releaseStaleClaim("m1", "edit-api", "tok-old", iso(w.clock.ms))).toMatchObject({
      replayed: true
    });
    expect(controller.store.operations("m1")[0]).toMatchObject({ status: "running", claimToken: "tok-new" });
    // The fence itself: a token that never held this unit cannot release the live claim, and the live claim is untouched.
    expect(() => controller.store.releaseStaleClaim("m1", "edit-api", "tok-other", iso(w.clock.ms))).toThrowError(
      expect.objectContaining({ code: "coding_mission_claim_conflict" })
    );
    expect(controller.store.operations("m1")[0]).toMatchObject({ status: "running", claimToken: "tok-new" });
    expect(controller.store.db.prepare("SELECT COUNT(*) AS n FROM work_unit_recoveries").get()).toEqual({ n: 1 });
  });
});

describe("self-healing: recovery that cannot be proven safe", () => {
  it("never retries when the executor cannot say whether the operation ran, and escalates once", async () => {
    const w = world();
    w.observe.value = { status: "unknown" };
    const controller = await planned(w);
    vanishedWorker(controller, w, "tok-1");
    for (let i = 0; i < 3; i += 1) {
      expect(await controller.advance("m1")).toMatchObject({ progressed: false, code: "unknown_operation" });
    }
    expect(controller.store.operations("m1")[0]).toMatchObject({ status: "running", claimToken: "tok-1" });
    expect(controller.store.escalations("m1")).toEqual([
      expect.objectContaining({ kind: "recovery_unsafe", unitId: "edit-api" })
    ]);
    expect(controller.store.db.prepare("SELECT COUNT(*) AS n FROM work_unit_recoveries").get()).toEqual({ n: 0 });
    expect(w.executed).toEqual([]);
  });

  it("fails closed when a stale claim has no fence to release", async () => {
    const w = world();
    const controller = await planned(w);
    vanishedWorker(controller, w, "tok-1");
    controller.store.db.exec("UPDATE coding_operations SET claim_token = NULL WHERE operation_id = 'edit-api'");
    expect(await controller.advance("m1")).toMatchObject({ state: "DEGRADED", code: "recovery_unsafe" });
    expect(controller.store.escalations("m1")).toEqual([
      expect.objectContaining({ kind: "recovery_unsafe", detail: { reason: "claim_has_no_fence" } })
    ]);
    expect(w.executed).toEqual([]);
  });
});

describe("self-healing: backoff is enforced at the claim boundary", () => {
  it("refuses a claim before retry_not_before and allows it after, whoever asks", async () => {
    const w = world();
    const controller = await planned(w);
    vanishedWorker(controller, w, "tok-1");
    const decision = controller.store.releaseStaleClaim("m1", "edit-api", "tok-1", iso(w.clock.ms));
    const notBefore = Date.parse(decision.retryNotBefore!);
    const claim = (token: string, at: number) =>
      controller.store.claimUnit("m1", "edit-api", {
        token,
        workerId: "w",
        route: {},
        claimedAt: new Date(at).toISOString()
      });
    expect(claim("early", notBefore - 1)).toEqual({ ok: false, outcome: "recovery_backoff" });
    expect(claim("on-time", notBefore)).toMatchObject({ ok: true });
  });

  it("keeps recovery counts, backoff and escalations across a restart", async () => {
    directory = mkdtempSync(join(tmpdir(), "acs-recovery-"));
    const dbPath = join(directory, "control.db");
    const w = world();
    const controller = await planned(w, dbPath);
    vanishedWorker(controller, w, "tok-1");
    const decision = controller.store.releaseStaleClaim("m1", "edit-api", "tok-1", iso(w.clock.ms));
    controller.close();

    const reopened = new CodingMissionStore(dbPath);
    expect(reopened.operations("m1")[0]).toMatchObject({ status: "pending", retryNotBefore: decision.retryNotBefore });
    expect(reopened.releaseStaleClaim("m1", "edit-api", "tok-1", iso(w.clock.ms + 1))).toMatchObject({
      sequence: 1,
      replayed: true
    });
    expect(
      reopened.claimUnit("m1", "edit-api", { token: "t", workerId: "w", route: {}, claimedAt: iso(w.clock.ms) })
    ).toEqual({ ok: false, outcome: "recovery_backoff" });
    reopened.close();
  });
});

describe("self-healing: recovery records are append-only", () => {
  it("refuses to update, delete or replace recoveries and escalations", async () => {
    const w = world({ recoveryPolicy: { maxRecoveries: 0 } });
    const controller = await planned(w);
    vanishedWorker(controller, w, "tok-1");
    await controller.advance("m1");
    const db = controller.store.db;
    expect(() => db.exec("UPDATE work_unit_recoveries SET outcome = 'rescheduled'")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM work_unit_recoveries")).toThrow(/append-only/);
    expect(() => db.exec("UPDATE work_unit_escalations SET kind = 'recovery_unsafe'")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM work_unit_escalations")).toThrow(/append-only/);
    const row = db.prepare("SELECT * FROM work_unit_recoveries").get() as Record<string, string | number | null>;
    expect(() =>
      db
        .prepare(
          `INSERT OR REPLACE INTO work_unit_recoveries
             (mission_id, unit_id, seq, claim_fence_hash, claim_attempt, worker_id, reason, outcome, retry_not_before, decided_at)
           VALUES (?, ?, ?, ?, 0, NULL, 'x', 'rescheduled', NULL, ?)`
        )
        .run(
          row.mission_id as string,
          row.unit_id as string,
          row.seq as number,
          "f".repeat(64),
          "2026-10-11T00:00:00.000Z"
        )
    ).toThrow(/append-only/);
    expect(() =>
      db.exec(
        `INSERT OR REPLACE INTO work_unit_escalations (mission_id, unit_id, kind, detail_json, created_at)
         VALUES ('m1', 'edit-api', 'poison_work', '{}', '2026-10-11T00:00:00.000Z')`
      )
    ).toThrow(/append-only/);
  });
});
