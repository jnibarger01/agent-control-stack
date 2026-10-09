import { DatabaseSync } from "node:sqlite";
import { controlPlaneMigrations } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";

function migrated(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const migration of controlPlaneMigrations().filter((entry) => entry.version <= 59)) db.exec(migration.sql);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    INSERT INTO coding_missions (mission_id, repository, base_ref, base_sha, summary, state, version, branch, deployment_required, deployment_action, deployment_impact, created_at, updated_at, mission_kind)
    VALUES ('m1', '', '', '', 's', 'CREATED', 1, '', 0, '', '', '2026-10-09T00:00:00Z', '2026-10-09T00:00:00Z', 'general');
    INSERT INTO coding_operations (mission_id, operation_id, depends_on, title, status) VALUES ('m1', 'u1', '[]', 't', 'pending');
  `);
  const migration = controlPlaneMigrations().find((entry) => entry.version === 60);
  if (!migration) throw new Error("migration 060 is not registered");
  db.exec("BEGIN IMMEDIATE");
  db.exec(migration.sql);
  db.exec("COMMIT");
  return db;
}

describe("migration 060: mission authority and child work", () => {
  it("applies on top of a populated 059 database without touching existing rows", () => {
    const db = migrated();
    expect(db.prepare("SELECT COUNT(*) AS n FROM coding_missions").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM coding_operations").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM mission_authority").get()).toEqual({ n: 0 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("keeps all three tables append-only and foreign-keyed", () => {
    const db = migrated();
    db.exec(
      `INSERT INTO mission_authority (mission_id, envelope_json, envelope_hash, policy_json, policy_hash, approver_id, reason, grant_id, grant_hash, created_at) VALUES ('m1', '{}', '${"a".repeat(64)}', '{}', '${"p".repeat(64)}', 'h', 'r', 'g1', '${"e".repeat(64)}', 't')`
    );
    db.exec(
      `INSERT INTO work_unit_authority (mission_id, unit_id, envelope_json, envelope_hash, derived_from_hash, grant_id, parent_attempt, parent_claim_fence, created_at) VALUES ('m1', 'u1', '{}', '${"b".repeat(64)}', '${"a".repeat(64)}', 'g1', 1, 'fence-0001', 't')`
    );
    db.exec(
      `INSERT INTO work_unit_reductions (mission_id, parent_unit_id, strategy, outcome, children_json, reduction_hash, created_at) VALUES ('m1', 'u1', 'all_succeeded', 'reduced', '[]', '${"r".repeat(64)}', 't')`
    );
    for (const table of ["mission_authority", "work_unit_authority", "work_unit_reductions"]) {
      expect(() => db.exec(`UPDATE ${table} SET created_at = 'x'`)).toThrow(/append-only/);
      expect(() => db.exec(`DELETE FROM ${table}`)).toThrow(/append-only/);
    }
    expect(() =>
      db.exec(
        `INSERT INTO mission_authority (mission_id, envelope_json, envelope_hash, policy_json, policy_hash, approver_id, reason, grant_id, grant_hash, created_at) VALUES ('ghost', '{}', '${"a".repeat(64)}', '{}', '${"p".repeat(64)}', 'h', 'r', 'g1', '${"e".repeat(64)}', 't')`
      )
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      db.exec(
        `INSERT INTO work_unit_authority (mission_id, unit_id, envelope_json, envelope_hash, derived_from_hash, grant_id, parent_attempt, parent_claim_fence, created_at) VALUES ('m1', 'ghost', '{}', '${"b".repeat(64)}', '${"a".repeat(64)}', 'g1', 1, 'fence-0001', 't')`
      )
    ).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it("blocks INSERT OR REPLACE, which would otherwise swap a row without firing the DELETE trigger", () => {
    const db = migrated();
    db.exec(
      `INSERT INTO mission_authority (mission_id, envelope_json, envelope_hash, policy_json, policy_hash, approver_id, reason, grant_id, grant_hash, created_at) VALUES ('m1', '{"v":1}', '${"a".repeat(64)}', '{}', '${"p".repeat(64)}', 'h', 'r', 'g1', '${"e".repeat(64)}', 't')`
    );
    db.exec(
      `INSERT INTO work_unit_authority (mission_id, unit_id, envelope_json, envelope_hash, derived_from_hash, grant_id, parent_attempt, parent_claim_fence, created_at) VALUES ('m1', 'u1', '{"v":1}', '${"b".repeat(64)}', '${"a".repeat(64)}', 'g1', 1, 'fence-0001', 't')`
    );
    db.exec(
      `INSERT INTO work_unit_reductions (mission_id, parent_unit_id, strategy, outcome, children_json, reduction_hash, created_at) VALUES ('m1', 'u1', 'all_succeeded', 'reduced', '[]', '${"r".repeat(64)}', 't')`
    );
    expect(() =>
      db.exec(
        `INSERT OR REPLACE INTO mission_authority (mission_id, envelope_json, envelope_hash, policy_json, policy_hash, approver_id, reason, grant_id, grant_hash, created_at) VALUES ('m1', '{"v":2}', '${"c".repeat(64)}', '{}', '${"p".repeat(64)}', 'h', 'r', 'g1', '${"e".repeat(64)}', 't')`
      )
    ).toThrow(/append-only/);
    expect(() =>
      db.exec(
        `INSERT OR REPLACE INTO work_unit_authority (mission_id, unit_id, envelope_json, envelope_hash, derived_from_hash, grant_id, parent_attempt, parent_claim_fence, created_at) VALUES ('m1', 'u1', '{"v":2}', '${"c".repeat(64)}', '${"a".repeat(64)}', 'g1', 1, 'fence-0001', 't')`
      )
    ).toThrow(/append-only/);
    expect(() =>
      db.exec(
        `INSERT OR REPLACE INTO work_unit_reductions (mission_id, parent_unit_id, strategy, outcome, children_json, reduction_hash, created_at) VALUES ('m1', 'u1', 'select', 'failed', '[]', '${"r".repeat(64)}', 't')`
      )
    ).toThrow(/append-only/);
    expect(() =>
      db.exec(
        `INSERT OR IGNORE INTO mission_authority (mission_id, envelope_json, envelope_hash, policy_json, policy_hash, approver_id, reason, grant_id, grant_hash, created_at) VALUES ('m1', '{"v":3}', '${"d".repeat(64)}', '{}', '${"p".repeat(64)}', 'h', 'r', 'g1', '${"e".repeat(64)}', 't')`
      )
    ).toThrow(/append-only/);
    expect(db.prepare("SELECT envelope_json FROM mission_authority").get()).toEqual({ envelope_json: '{"v":1}' });
    expect(db.prepare("SELECT outcome FROM work_unit_reductions").get()).toEqual({ outcome: "reduced" });
    db.close();
  });

  it("requires an approver and a reason, and constrains the reduction vocabulary", () => {
    const db = migrated();
    expect(() =>
      db.exec(
        `INSERT INTO mission_authority (mission_id, envelope_json, envelope_hash, policy_json, policy_hash, approver_id, reason, grant_id, grant_hash, created_at) VALUES ('m1', '{}', '${"a".repeat(64)}', '{}', '${"p".repeat(64)}', '', 'r', 'g1', '${"e".repeat(64)}', 't')`
      )
    ).toThrow(/CHECK/);
    expect(() =>
      db.exec(
        `INSERT INTO mission_authority (mission_id, envelope_json, envelope_hash, policy_json, policy_hash, approver_id, reason, grant_id, grant_hash, created_at) VALUES ('m1', '{}', '${"a".repeat(64)}', '{}', '${"p".repeat(64)}', 'h', '', 'g1', '${"e".repeat(64)}', 't')`
      )
    ).toThrow(/CHECK/);
    expect(() =>
      db.exec(
        `INSERT INTO work_unit_reductions (mission_id, parent_unit_id, strategy, outcome, children_json, reduction_hash, created_at) VALUES ('m1', 'u1', 'last_writer_wins', 'reduced', '[]', '${"r".repeat(64)}', 't')`
      )
    ).toThrow(/CHECK/);
    db.close();
  });
});
