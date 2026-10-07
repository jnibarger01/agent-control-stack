import { DatabaseSync } from "node:sqlite";
import { controlPlaneMigrations } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";

function databaseAt056(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of controlPlaneMigrations().filter((entry) => entry.version <= 56)) db.exec(migration.sql);
  return db;
}

function apply057(db: DatabaseSync): void {
  const migration = controlPlaneMigrations().find((entry) => entry.version === 57);
  if (!migration) throw new Error("migration 057 is not registered");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(migration.sql);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

describe("migration 057: work-unit verification authority", () => {
  it("quarantines an in-flight verified unit that predates durable verification authority", () => {
    const db = databaseAt056();
    db.exec(`
      INSERT INTO coding_missions (
        mission_id, repository, base_ref, base_sha, summary, state, version, branch,
        deployment_required, deployment_action, deployment_impact, created_at, updated_at, mission_kind
      ) VALUES (
        'm1', 'org/repo', 'main', '${"a".repeat(40)}', 'verify', 'RUNNING', 1, 'acs/m1',
        0, 'none', 'none', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', 'general'
      );
      INSERT INTO coding_operations (
        mission_id, operation_id, depends_on, title, status, claim_token, claimed_at, worker_id,
        route_json, result_hash, files_json, unit_kind, attempt, depth, verification_policy
      ) VALUES (
        'm1', 'u1', '[]', 'unit', 'verifying', 'claim', '2026-10-01T00:01:00Z', 'worker-1',
        '{}', 'result-1', '["a.ts"]', 'coding', 1, 0, 'independent'
      );
      INSERT INTO work_unit_execution_attempts (
        attempt_id, mission_id, unit_id, unit_attempt, worker_id, executor_lane, claim_token_hash,
        dispatch_hash, dispatch_json, authority_json, state, started_at, finished_at,
        result_hash, report_hash, report_json
      ) VALUES (
        'wua_legacy', 'm1', 'u1', 1, 'worker-1', 'coder', 'claim-hash',
        'dispatch-hash', '{}', '{}', 'succeeded', '2026-10-01T00:01:00Z', '2026-10-01T00:02:00Z',
        'result-1', 'report-hash', '{}'
      );
    `);

    apply057(db);

    expect(
      db.prepare(
        "SELECT reason FROM work_unit_verification_quarantine WHERE mission_id = 'm1' AND unit_id = 'u1'"
      ).get()
    ).toEqual({ reason: "migration_057_missing_verification_authority" });
    expect(
      db.prepare(
        "SELECT status, failure_category FROM coding_operations WHERE mission_id = 'm1' AND operation_id = 'u1'"
      ).get()
    ).toEqual({ status: "failed", failure_category: "verification_failure" });
    expect(
      db.prepare(
        "SELECT implementer_engine_id FROM work_unit_execution_attempts WHERE attempt_id = 'wua_legacy'"
      ).get()
    ).toEqual({ implementer_engine_id: null });
    db.close();
  });

  it("does not quarantine a verified unit that has never started", () => {
    const db = databaseAt056();
    db.exec(`
      INSERT INTO coding_missions (
        mission_id, repository, base_ref, base_sha, summary, state, version, branch,
        deployment_required, deployment_action, deployment_impact, created_at, updated_at, mission_kind
      ) VALUES (
        'm1', 'org/repo', 'main', '${"a".repeat(40)}', 'verify', 'READY', 1, 'acs/m1',
        0, 'none', 'none', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', 'general'
      );
      INSERT INTO coding_operations (
        mission_id, operation_id, depends_on, title, status, files_json, unit_kind, attempt, depth, verification_policy
      ) VALUES ('m1', 'u1', '[]', 'unit', 'ready', '[]', 'coding', 0, 0, 'independent');
    `);

    apply057(db);

    expect(db.prepare("SELECT COUNT(*) AS n FROM work_unit_verification_quarantine").get()).toEqual({ n: 0 });
    expect(
      db.prepare("SELECT status, attempt FROM coding_operations WHERE mission_id = 'm1' AND operation_id = 'u1'").get()
    ).toEqual({ status: "ready", attempt: 0 });
    db.close();
  });
});
