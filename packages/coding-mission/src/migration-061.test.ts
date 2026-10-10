import { DatabaseSync } from "node:sqlite";
import { controlPlaneMigrations } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import { CodingMissionStore } from "./store.js";
import { WorkUnitExecutionLedger } from "./worker-execution.js";

function applyThrough(last: number): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of controlPlaneMigrations().filter((entry) => entry.version <= last)) {
    db.exec("BEGIN IMMEDIATE");
    db.exec(migration.sql);
    db.exec("COMMIT");
  }
  return db;
}

describe("migration 061: cua executor lane", () => {
  it("accepts executor_lane cua on a fresh database", () => {
    const db = applyThrough(61);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.exec(`
      INSERT INTO coding_missions (
        mission_id, repository, base_ref, base_sha, summary, state, version, branch,
        deployment_required, deployment_action, deployment_impact, created_at, updated_at, mission_kind
      ) VALUES ('m1', '', '', '', 's', 'CREATED', 1, '', 0, '', '', 't', 't', 'general');
      INSERT INTO coding_operations (mission_id, operation_id, depends_on, title, status)
      VALUES ('m1', 'u1', '[]', 't', 'pending');
    `);
    db.exec(`
      INSERT INTO work_unit_execution_attempts (
        attempt_id, mission_id, unit_id, unit_attempt, worker_id, implementer_engine_id, executor_lane,
        claim_token_hash, dispatch_hash, dispatch_json, authority_json, state, started_at
      ) VALUES (
        'attempt01', 'm1', 'u1', 1, 'worker-1', 'browser', 'cua', 'h', 'd', '{}', '{}', 'started', 't'
      );
    `);
    expect(db.prepare("SELECT executor_lane FROM work_unit_execution_attempts").get()).toEqual({
      executor_lane: "cua"
    });
    expect(() =>
      db.exec(`
        INSERT INTO work_unit_execution_attempts (
          attempt_id, mission_id, unit_id, unit_attempt, worker_id, executor_lane,
          claim_token_hash, dispatch_hash, dispatch_json, authority_json, state, started_at
        ) VALUES ('attempt02', 'm1', 'u1', 2, 'worker-1', 'nope', 'h', 'd', '{}', '{}', 'started', 't')
      `)
    ).toThrow(/CHECK/);
    const store = new CodingMissionStore(":memory:");
    store.createGeneral({ missionId: "m1", summary: "cua", now: "2026-10-10T00:00:00.000Z" });
    store.addWorkUnits(
      "m1",
      [{ unitId: "u1", kind: "cua", title: "browse", payload: { kind: "cua", objective: "look" } }],
      "2026-10-10T00:00:00.000Z"
    );
    store.releaseReadyUnits("m1", "2026-10-10T00:00:00.000Z");
    const claim = {
      token: "claim-token",
      workerId: "worker-1",
      route: { lane: "cua" as const, implementerEngineId: "browser" },
      claimedAt: "2026-10-10T00:00:01.000Z"
    };
    expect(store.claimUnit("m1", "u1", claim)).toMatchObject({ ok: true });
    const dispatch = new WorkUnitExecutionLedger(store).beginDispatch({
      missionId: "m1",
      unitId: "u1",
      claimToken: claim.token,
      workerId: claim.workerId,
      lane: "cua",
      now: "2026-10-10T00:00:01.000Z"
    });
    expect(dispatch.lane).toBe("cua");
    expect(
      store.db
        .prepare("SELECT executor_lane FROM work_unit_execution_attempts WHERE attempt_id = ?")
        .get(dispatch.attemptId)
    ).toEqual({ executor_lane: "cua" });
    store.close();
    db.close();
  });

  it("upgrades a populated 060 database without dropping child rows", () => {
    const db = applyThrough(60);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'cua_action_checkpoints'").get()).toBeUndefined();
    db.exec(`
      INSERT INTO coding_missions (
        mission_id, repository, base_ref, base_sha, summary, state, version, branch,
        deployment_required, deployment_action, deployment_impact, created_at, updated_at, mission_kind
      ) VALUES ('m1', '', '', '', 's', 'CREATED', 1, '', 0, '', '', 't', 't', 'general');
      INSERT INTO coding_operations (mission_id, operation_id, depends_on, title, status)
      VALUES ('m1', 'u1', '[]', 't', 'running');
      INSERT INTO work_unit_execution_attempts (
        attempt_id, mission_id, unit_id, unit_attempt, worker_id, implementer_engine_id, executor_lane,
        claim_token_hash, dispatch_hash, dispatch_json, authority_json, state, started_at, result_hash
      ) VALUES (
        'attempt01', 'm1', 'u1', 1, 'worker-1', 'codex', 'coder', 'h', 'd', '{}', '{}', 'succeeded', 't', 'rh'
      );
      INSERT INTO work_unit_execution_receipts (attempt_id, receipt_index, kind, hash, created_at)
      VALUES ('attempt01', 0, 'coder_result', 'receipt', 't');
      INSERT INTO work_unit_verification_runs (
        run_id, execution_attempt_id, mission_id, unit_id, unit_attempt, state, started_at
      ) VALUES ('run000001', 'attempt01', 'm1', 'u1', 1, 'settled', 't');
      INSERT INTO work_unit_verification_usage_reservations (
        reservation_id, run_id, mission_id, execution_attempt_id, verifier_engine_id,
        tool_calls, model_tokens, spend_micro_usd, state, created_at
      ) VALUES ('reserve001', 'run000001', 'm1', 'attempt01', 'verifier', 1, 2, 3, 'settled', 't');
      INSERT INTO work_unit_verification_decisions (
        decision_id, run_id, mission_id, unit_id, unit_attempt, execution_attempt_id, execution_report_hash,
        result_hash, criteria_hash, verification_policy, outcome, verdict, implementer_worker_id,
        implementer_engine_id, verifier_engine_ids_json, evidence_hash, evidence_json, created_at
      ) VALUES (
        'decision01', 'run000001', 'm1', 'u1', 1, 'attempt01', 'er', 'rh', 'ch', 'independent',
        'succeeded', 'pass', 'worker-1', 'codex', '[]', 'eh', '{}', 't'
      );
    `);
    const migration = controlPlaneMigrations().find((entry) => entry.version === 61);
    if (!migration) throw new Error("migration 061 is not registered");
    db.exec("BEGIN IMMEDIATE");
    db.exec(migration.sql);
    db.exec("COMMIT");

    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("SELECT executor_lane, implementer_engine_id FROM work_unit_execution_attempts").get()).toEqual({
      executor_lane: "coder",
      implementer_engine_id: "codex"
    });
    expect(db.prepare("SELECT kind, hash FROM work_unit_execution_receipts").get()).toEqual({
      kind: "coder_result",
      hash: "receipt"
    });
    expect(db.prepare("SELECT state FROM work_unit_verification_runs").get()).toEqual({ state: "settled" });
    expect(db.prepare("SELECT tool_calls FROM work_unit_verification_usage_reservations").get()).toEqual({
      tool_calls: 1
    });
    expect(db.prepare("SELECT outcome FROM work_unit_verification_decisions").get()).toEqual({ outcome: "succeeded" });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%__061'").all()).toEqual([]);
    db.exec(`
      INSERT INTO work_unit_execution_attempts (
        attempt_id, mission_id, unit_id, unit_attempt, worker_id, executor_lane,
        claim_token_hash, dispatch_hash, dispatch_json, authority_json, state, started_at
      ) VALUES ('attempt02', 'm1', 'u1', 2, 'worker-1', 'cua', 'h', 'd', '{}', '{}', 'started', 't')
    `);
    expect(() =>
      db.exec(`
        INSERT INTO work_unit_verification_runs (
          run_id, execution_attempt_id, mission_id, unit_id, unit_attempt, state, started_at
        ) VALUES ('run000002', 'attempt01', 'm1', 'u1', 1, 'active', 't')
      `)
    ).not.toThrow();
    expect(() =>
      db.exec(`
        INSERT INTO work_unit_verification_runs (
          run_id, execution_attempt_id, mission_id, unit_id, unit_attempt, state, started_at
        ) VALUES ('run000003', 'attempt01', 'm1', 'u1', 1, 'active', 't2')
      `)
    ).toThrow(/UNIQUE/);
    expect(() => db.exec(`INSERT INTO work_unit_execution_receipts VALUES ('missing001', 0, 'k', 'h', 't')`)).toThrow(
      /FOREIGN KEY/
    );
    db.close();
  });
});
