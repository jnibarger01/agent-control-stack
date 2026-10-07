import { DatabaseSync } from "node:sqlite";
import { controlPlaneMigrations } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";

/** Schema 055 with one pre-existing decision, evidence row and outcome, then migration 056 applied the way the runner does. */
function migrated(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const migration of controlPlaneMigrations().filter((entry) => entry.version <= 55)) db.exec(migration.sql);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    INSERT INTO actor_routing_decisions (decision_id, work_item_id, attempt_id, selected_actor_id, eligible_json, excluded_json, scores_json, idempotency_key, created_at)
    VALUES ('d-old', 'w-old', NULL, 'alpha', '["alpha","beta"]', '{"gamma":["unhealthy executor"]}', '{}', 'route.w-old.0', '2026-09-01T00:00:00Z');
    INSERT INTO actor_routing_evidence (decision_id, mission_id, operation_id, decision, source, reason_code, router_version, prompt_version, candidate_json, constraints_json, normalized_decision_json, created_at)
    VALUES ('d-old', NULL, 'w-old', 'route', 'nimble', 'nimble_choice', 'r1', 'p1', '["alpha","beta"]', '{}', '{}', '2026-09-01T00:00:00Z');
    INSERT INTO routing_execution_outcomes (outcome_id, decision_id, executor_id, latency_ms, success, timed_out, retry_count, idempotency_key, created_at)
    VALUES ('o-old', 'd-old', 'alpha', 120, 1, 0, 0, 'idem-old', '2026-09-01T00:01:00Z');
  `);
  db.exec("PRAGMA foreign_keys = ON");
  const migration = controlPlaneMigrations().find((entry) => entry.version === 56);
  if (!migration) throw new Error("migration 056 is not registered");
  db.exec("BEGIN IMMEDIATE");
  db.exec(migration.sql);
  db.exec("COMMIT");
  return db;
}

describe("migration 056: route decision enrichment", () => {
  it("keeps pre-existing routes and outcomes intact with every new column NULL", () => {
    const db = migrated();
    expect(
      db
        .prepare(
          "SELECT executor_class, strategy, strategy_source, parallelism, verification_required, reasons_json, enrichment_version FROM actor_routing_evidence WHERE decision_id = 'd-old'"
        )
        .get()
    ).toEqual({
      executor_class: null,
      strategy: null,
      strategy_source: null,
      parallelism: null,
      verification_required: null,
      reasons_json: null,
      enrichment_version: null
    });
    expect(
      db
        .prepare(
          "SELECT success, latency_ms, tool_calls, model_tokens, cost_micro_usd, actual_strategy FROM routing_execution_outcomes"
        )
        .get()
    ).toEqual({
      success: 1,
      latency_ms: 120,
      tool_calls: null,
      model_tokens: null,
      cost_micro_usd: null,
      actual_strategy: null
    });
    db.close();
  });

  it("leaves both tables append-only", () => {
    const db = migrated();
    expect(() => db.exec("UPDATE actor_routing_evidence SET strategy = 'single'")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM actor_routing_evidence")).toThrow(/append-only/);
    expect(() => db.exec("UPDATE routing_execution_outcomes SET tool_calls = 1")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM routing_execution_outcomes")).toThrow(/append-only/);
    db.close();
  });

  it("constrains the new vocabularies at the schema level", () => {
    const db = migrated();
    const insert = (columns: string, values: string) => () =>
      db.exec(
        `INSERT INTO actor_routing_evidence (decision_id, decision, source, reason_code, router_version, prompt_version, candidate_json, constraints_json, normalized_decision_json, created_at, ${columns})
         VALUES ('d-${Math.random()}', 'route', 'nimble', 'x', 'r', 'p', '[]', '{}', '{}', '2026-10-06T00:00:00Z', ${values})`
      );
    db.exec("PRAGMA foreign_keys = OFF");
    expect(insert("strategy", "'single'")).not.toThrow();
    expect(insert("strategy", "'recursive_spawn'")).toThrow(/CHECK/);
    expect(insert("executor_class", "'root_shell'")).toThrow(/CHECK/);
    expect(insert("strategy_source", "'jev'")).toThrow(/CHECK/);
    expect(insert("parallelism", "0")).toThrow(/CHECK/);
    expect(insert("parallelism", "65")).toThrow(/CHECK/);
    expect(insert("verification_required", "2")).toThrow(/CHECK/);
    expect(insert("reasons_json", "'not json'")).toThrow(/CHECK/);
    db.close();
  });

  it("exposes the comparison view for old rows, with the latest outcome and no Jev data", () => {
    const db = migrated();
    expect(
      db
        .prepare(
          "SELECT decision_id, executor_id, strategy, jev_status, actual_executor, success, wall_ms FROM routing_comparison_v"
        )
        .all()
    ).toEqual([
      {
        decision_id: "d-old",
        executor_id: "alpha",
        strategy: null,
        jev_status: null,
        actual_executor: "alpha",
        success: 1,
        wall_ms: 120
      }
    ]);
    db.close();
  });
});
