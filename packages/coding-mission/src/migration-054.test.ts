import { DatabaseSync } from "node:sqlite";
import { controlPlaneMigrations } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";

/** Build a populated database at schema 053, then run migration 054 the way the runner does. */
function populatedAt053(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of controlPlaneMigrations().filter((entry) => entry.version <= 53)) db.exec(migration.sql);
  db.exec(`
    INSERT INTO coding_missions (mission_id, repository, base_ref, base_sha, summary, state, version, branch,
      deployment_required, deployment_action, deployment_impact, grant_id, failure_code, created_at, updated_at)
    VALUES
      ('m-run', 'org/repo', 'main', '${"a".repeat(40)}', 'running mission', 'RUNNING', 7, 'acs/m-run', 1, 'deploy', 'low', 'grant-1', NULL, '2026-10-01T00:00:00Z', '2026-10-01T01:00:00Z'),
      ('m-done', 'org/repo', 'main', '${"b".repeat(40)}', 'finished mission', 'COMPLETED', 12, 'acs/m-done', 0, 'none', 'none', NULL, NULL, '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z');
    INSERT INTO coding_operations (mission_id, operation_id, depends_on, title, status, claim_token, claimed_at, worker_id, route_json, result_hash, files_json)
    VALUES
      ('m-run', 'op-1', '[]', 'first', 'succeeded', 'tok-1', '2026-10-01T00:10:00Z', 'w1', '{"workerId":"w1"}', 'hash-1', '["a.ts"]'),
      ('m-run', 'op-2', '["op-1"]', 'second', 'running', 'tok-2', '2026-10-01T00:20:00Z', 'w2', '{"workerId":"w2"}', NULL, '[]'),
      ('m-run', 'op-3', '["op-2"]', 'third', 'pending', NULL, NULL, NULL, NULL, NULL, '[]'),
      ('m-done', 'op-1', '[]', 'only', 'unknown', 'tok-9', '2026-09-01T00:10:00Z', 'w3', NULL, NULL, '[]');
    INSERT INTO coding_effects (mission_id, effect_kind, outcome, external_id) VALUES ('m-run', 'merge', 'unknown', NULL);
    INSERT INTO coding_evidence (mission_id, evidence_id, kind, payload_hash, payload_json, created_at)
    VALUES ('m-run', 'route:op-2:1', 'route', 'h', '{}', '2026-10-01T00:20:00Z');
    INSERT INTO coding_events (mission_id, name, body_json, created_at) VALUES ('m-run', 'coding_mission.created', '{}', '2026-10-01T00:00:00Z');
  `);
  // Some earlier migrations toggle the pragma; stores always open with enforcement on.
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function apply054(db: DatabaseSync): void {
  const migration = controlPlaneMigrations().find((entry) => entry.version === 54);
  if (!migration) throw new Error("migration 054 is not registered");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(migration.sql);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

describe("migration 054: mission runtime generalization", () => {
  it("preserves every existing mission, operation, effect, evidence and event row", () => {
    const db = populatedAt053();
    const before = {
      missions: db.prepare("SELECT * FROM coding_missions ORDER BY mission_id").all(),
      operations: db
        .prepare(
          `SELECT mission_id, operation_id, depends_on, title, status, claim_token, claimed_at, worker_id, route_json, result_hash, files_json
           FROM coding_operations ORDER BY mission_id, operation_id`
        )
        .all(),
      effects: db.prepare("SELECT * FROM coding_effects").all(),
      evidence: db.prepare("SELECT * FROM coding_evidence").all(),
      events: db.prepare("SELECT * FROM coding_events").all()
    };
    apply054(db);
    expect(
      (db.prepare("SELECT * FROM coding_missions ORDER BY mission_id").all() as Array<Record<string, unknown>>).map(
        ({ mission_kind, initiator_id, ...legacy }) => {
          expect(mission_kind).toBe("coding");
          expect(initiator_id).toBeNull();
          return legacy;
        }
      )
    ).toEqual(before.missions);
    expect(
      db
        .prepare(
          `SELECT mission_id, operation_id, depends_on, title, status, claim_token, claimed_at, worker_id, route_json, result_hash, files_json
           FROM coding_operations ORDER BY mission_id, operation_id`
        )
        .all()
    ).toEqual(before.operations);
    expect(db.prepare("SELECT * FROM coding_effects").all()).toEqual(before.effects);
    expect(db.prepare("SELECT * FROM coding_evidence").all()).toEqual(before.evidence);
    expect(db.prepare("SELECT * FROM coding_events").all()).toEqual(before.events);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("backfills defaults: coding kind, depth 0, no verification, attempt 1 for anything ever claimed", () => {
    const db = populatedAt053();
    apply054(db);
    const rows = db
      .prepare(
        "SELECT mission_id, operation_id, unit_kind, attempt, depth, verification_policy, failure_category FROM coding_operations ORDER BY mission_id, operation_id"
      )
      .all();
    expect(rows).toEqual([
      {
        mission_id: "m-done",
        operation_id: "op-1",
        unit_kind: "coding",
        attempt: 1,
        depth: 0,
        verification_policy: "none",
        failure_category: null
      },
      {
        mission_id: "m-run",
        operation_id: "op-1",
        unit_kind: "coding",
        attempt: 1,
        depth: 0,
        verification_policy: "none",
        failure_category: null
      },
      {
        mission_id: "m-run",
        operation_id: "op-2",
        unit_kind: "coding",
        attempt: 1,
        depth: 0,
        verification_policy: "none",
        failure_category: null
      },
      {
        mission_id: "m-run",
        operation_id: "op-3",
        unit_kind: "coding",
        attempt: 0,
        depth: 0,
        verification_policy: "none",
        failure_category: null
      }
    ]);
    db.close();
  });

  it("keeps child foreign keys enforced after the rebuild", () => {
    const db = populatedAt053();
    apply054(db);
    expect(() =>
      db.exec(
        `INSERT INTO coding_operations (mission_id, operation_id, depends_on, title, status) VALUES ('no-such', 'x', '[]', 't', 'pending')`
      )
    ).toThrow(/FOREIGN KEY/);
    expect(() => db.exec(`DELETE FROM coding_missions WHERE mission_id = 'm-run'`)).toThrow(/FOREIGN KEY/);
    expect(() =>
      db.exec(
        `INSERT INTO coding_operations (mission_id, operation_id, depends_on, title, status, parent_unit_id) VALUES ('m-run', 'child', '[]', 't', 'pending', 'ghost')`
      )
    ).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it("accepts the widened state sets and still rejects unknown ones", () => {
    const db = populatedAt053();
    apply054(db);
    for (const state of ["CREATED", "READY", "WAITING_FOR_DEPENDENCY", "RECOVERING", "CANCELLED"]) {
      db.exec(`UPDATE coding_missions SET state = '${state}' WHERE mission_id = 'm-run'`);
    }
    expect(() => db.exec(`UPDATE coding_missions SET state = 'BOGUS' WHERE mission_id = 'm-run'`)).toThrow(/CHECK/);
    for (const status of ["ready", "claimed", "checkpointed", "verifying", "retryable", "cancelled"]) {
      db.exec(`UPDATE coding_operations SET status = '${status}' WHERE mission_id = 'm-run' AND operation_id = 'op-3'`);
    }
    expect(() =>
      db.exec(`UPDATE coding_operations SET status = 'bogus' WHERE mission_id = 'm-run' AND operation_id = 'op-3'`)
    ).toThrow(/CHECK/);
    expect(() =>
      db.exec(
        `UPDATE coding_operations SET failure_category = 'bogus' WHERE mission_id = 'm-run' AND operation_id = 'op-3'`
      )
    ).toThrow(/CHECK/);
    db.close();
  });

  it("makes budget limits write-once and usage monotonic", () => {
    const db = populatedAt053();
    apply054(db);
    db.exec(
      `INSERT INTO mission_budgets (mission_id, max_work_units, created_at) VALUES ('m-run', 5, '2026-10-01T00:00:00Z')`
    );
    expect(() => db.exec(`UPDATE mission_budgets SET max_work_units = 500`)).toThrow(/written once/);
    expect(() => db.exec(`DELETE FROM mission_budgets`)).toThrow(/written once/);
    db.exec(
      `INSERT INTO mission_budget_usage (mission_id, metric, used, updated_at) VALUES ('m-run', 'tool_calls', 3, 'x')`
    );
    expect(() => db.exec(`UPDATE mission_budget_usage SET used = 1`)).toThrow(/never decreases/);
    expect(() =>
      db.exec(
        `INSERT INTO mission_budget_usage (mission_id, metric, used, updated_at) VALUES ('m-run', 'bogus', 1, 'x')`
      )
    ).toThrow(/CHECK/);
    db.close();
  });

  it("leaves no reference to a temporary table name", () => {
    const db = populatedAt053();
    apply054(db);
    const sql = (
      db.prepare("SELECT name, sql FROM sqlite_master WHERE sql LIKE '%coding_%'").all() as Array<{
        name: string;
        sql: string;
      }>
    )
      .map((row) => row.sql)
      .join("\n");
    expect(sql).not.toMatch(/stash054|__05[34]/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'stash054%'").all()).toEqual([]);
    db.close();
  });

  it("is atomic: a failing migration leaves the 053 schema intact", () => {
    const db = populatedAt053();
    db.exec(`CREATE TABLE mission_budgets (poison INTEGER)`);
    expect(() => apply054(db)).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM coding_missions").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM coding_operations").get()).toEqual({ n: 4 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'coding_missions__054'").all()).toEqual([]);
    db.close();
  });
});
