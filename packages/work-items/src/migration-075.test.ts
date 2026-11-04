import { DatabaseSync } from "node:sqlite";
import { controlPlaneMigrations } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";

/**
 * Migration 075 rebuilds execution_results and attempt_results (SQLite cannot alter a CHECK). It must keep every
 * existing row byte for byte, recreate the indexes and the append-only / binding guards unchanged, leave no trace of
 * the temporary tables, break no foreign key, and accept the new 'ares' mode without loosening anything else.
 * Synthetic rows only; seeded through the real v74 schema.
 */
const RESULT_TABLES = ["execution_results", "attempt_results"] as const;
const PARENTS = ["work_items", "leases", "execution_attempts", "attempt_leases"] as const;
const H = (c: string) => c.repeat(64);
const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-01T00:00:05.000Z";
const norm = (sql: string | null) =>
  (sql ?? "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .trim();

type Row = Record<string, string | number | null>;
function put(db: DatabaseSync, table: string, row: Row) {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(
    ...Object.values(row)
  );
}
const meta = (mode: string) =>
  mode === "dry_run"
    ? JSON.stringify({ executionMode: "dry_run", simulated: true })
    : mode === "desktop_commander"
      ? JSON.stringify({ executionMode: "desktop_commander", simulated: false, backend: "desktop-commander-mcp" })
      : mode === "jace_commander"
        ? JSON.stringify({ executionMode: "jace_commander", simulated: false, backend: "jace-commander-mcp" })
        : JSON.stringify({ executionMode: mode, simulated: false, backend: "ares-studio" });
// json_extract(... '$.simulated') = 1 needs a JSON true; SQLite stores true as 1.

function guards(db: DatabaseSync, tables: readonly string[]) {
  const marks = tables.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT name, tbl_name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN (${marks}) ORDER BY name`
    )
    .all(...tables) as { name: string; tbl_name: string; sql: string }[];
}

function seeded() {
  const db = new DatabaseSync(":memory:");
  for (const migration of controlPlaneMigrations().filter((entry) => entry.version <= 74)) db.exec(migration.sql);
  db.exec("PRAGMA foreign_keys = OFF");
  const all = [...PARENTS, ...RESULT_TABLES];
  const saved = guards(db, all);
  for (const trigger of saved) db.exec(`DROP TRIGGER ${trigger.name}`);

  const workItem = (id: string): Row => ({
    id,
    title: "t",
    requester: "user",
    status: "succeeded",
    intent: "i",
    target_json: "{}",
    requested_actions_json: "[]",
    risk: "medium",
    created_at: T0,
    updated_at: T1
  });
  for (const id of ["w1", "w2", "w3", "w4"]) put(db, "work_items", workItem(id));

  const lease = (id: string, wi: string, worker: string, action: string): Row => ({
    lease_id: id,
    work_item_id: wi,
    worker_id: worker,
    token_hash: H("a"),
    action_hash: action,
    issued_at: T0,
    expires_at: "2026-10-01T01:00:00.000Z",
    status: "consumed",
    closed_at: T1
  });
  put(db, "leases", lease("l1", "w1", "worker-a", H("1")));
  put(db, "leases", lease("l2", "w2", "worker-b", H("2")));

  const execution = (
    id: string,
    wi: string,
    lease_id: string,
    worker: string,
    mode: string,
    outcome: string,
    exit: number | null
  ): Row => ({
    result_id: id,
    work_item_id: wi,
    lease_id,
    worker_id: worker,
    idempotency_key: `idem-${id}`,
    action_hash: wi === "w1" ? H("1") : H("2"),
    outcome,
    started_at: T0,
    finished_at: T1,
    exit_code: exit,
    summary: `summary ${id}`,
    stdout: `out ${id}`,
    stderr: null,
    structured_output_json: '{"k":[1,2,3]}',
    artifacts_json: "[]",
    error: null,
    resource_usage_json: '{"ms":5}',
    simulation_metadata_json: meta(mode),
    payload_hash: H("b"),
    created_at: T1
  });
  put(db, "execution_results", execution("er1", "w1", "l1", "worker-a", "dry_run", "succeeded", 0));
  put(db, "execution_results", execution("er2", "w2", "l2", "worker-b", "desktop_commander", "failed", 3));

  const attempt = (id: string, wi: string): Row => ({
    attempt_id: id,
    work_item_id: wi,
    plan_id: `plan-${id}`,
    plan_hash: H("c"),
    attempt_number: 1,
    protocol_version: "acs.worker.v2",
    input_hash: H("d"),
    status: "succeeded",
    current_fencing_epoch: 1,
    claimed_by_worker_id: "worker-c",
    created_at: T0,
    updated_at: T1
  });
  put(db, "execution_attempts", attempt("at1", "w3"));
  put(db, "execution_attempts", attempt("at2", "w4"));
  const attemptLease = (id: string, at: string, wi: string): Row => ({
    lease_id: id,
    attempt_id: at,
    work_item_id: wi,
    admission_id: `adm-${id}`,
    worker_id: "worker-c",
    token_hash: H("e"),
    plan_hash: H("c"),
    input_hash: H("d"),
    fencing_epoch: 1,
    protocol_version: "acs.worker.v2",
    policy_version: "p1",
    policy_decision_hash: H("f"),
    issued_at: T0,
    expires_at: "2026-10-01T01:00:00.000Z",
    max_expires_at: "2026-10-01T02:00:00.000Z",
    last_renewed_at: T0,
    status: "consumed",
    closed_at: T1
  });
  put(db, "attempt_leases", attemptLease("al1", "at1", "w3"));
  put(db, "attempt_leases", attemptLease("al2", "at2", "w4"));
  const attemptResult = (id: string, at: string, wi: string, lease_id: string, mode: string, outcome: string): Row => ({
    result_id: id,
    attempt_id: at,
    work_item_id: wi,
    lease_id,
    worker_id: "worker-c",
    fencing_epoch: 1,
    protocol_version: "acs.worker.v2",
    idempotency_key: `idem-${id}`,
    plan_hash: H("c"),
    input_hash: H("d"),
    outcome,
    outcome_certainty: "observed",
    started_at: T0,
    finished_at: T1,
    exit_code: outcome === "succeeded" ? 0 : 2,
    summary: `summary ${id}`,
    stdout: `out ${id}`,
    stderr: "err",
    structured_output_json: '{"ok":true}',
    error: null,
    resource_usage_json: null,
    simulation_metadata_json: meta(mode),
    payload_hash: H("9"),
    created_at: T1
  });
  put(db, "attempt_results", attemptResult("ar1", "at1", "w3", "al1", "dry_run", "succeeded"));
  put(db, "attempt_results", attemptResult("ar2", "at2", "w4", "al2", "jace_commander", "failed"));

  for (const trigger of saved) db.exec(trigger.sql);
  db.exec("PRAGMA foreign_keys = ON");
  return { db, saved };
}

const dump = (db: DatabaseSync, table: string, key: string) =>
  db.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).all();
const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const indexes = (db: DatabaseSync, table: string) =>
  (
    db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name"
      )
      .all(table) as { name: string; sql: string }[]
  ).map((i) => ({
    name: i.name,
    sql: norm(i.sql)
  }));

function apply075(db: DatabaseSync) {
  const migration = controlPlaneMigrations().find((entry) => entry.version === 75);
  if (!migration) throw new Error("migration 075 is not registered");
  db.exec("BEGIN IMMEDIATE");
  db.exec(migration.sql);
  db.exec("COMMIT");
}

describe("migration 075: ares execution results", () => {
  it("keeps every existing row, column order, index, trigger and parent table exactly as it was", () => {
    const { db, saved } = seeded();
    const before = {
      exec: dump(db, "execution_results", "result_id"),
      attempt: dump(db, "attempt_results", "result_id"),
      execCols: columns(db, "execution_results"),
      attemptCols: columns(db, "attempt_results"),
      execIdx: indexes(db, "execution_results"),
      attemptIdx: indexes(db, "attempt_results"),
      parentRows: PARENTS.map((t) =>
        dump(
          db,
          t,
          PARENTS.indexOf(t) === 1 || PARENTS.indexOf(t) === 3
            ? "lease_id"
            : PARENTS.indexOf(t) === 2
              ? "attempt_id"
              : "id"
        )
      )
    };
    expect(before.exec).toHaveLength(2);
    expect(before.attempt).toHaveLength(2);

    apply075(db);

    expect(dump(db, "execution_results", "result_id")).toEqual(before.exec);
    expect(dump(db, "attempt_results", "result_id")).toEqual(before.attempt);
    expect(columns(db, "execution_results")).toEqual(before.execCols);
    expect(columns(db, "attempt_results")).toEqual(before.attemptCols);
    expect(indexes(db, "execution_results")).toEqual(before.execIdx);
    expect(indexes(db, "attempt_results")).toEqual(before.attemptIdx);
    expect(
      PARENTS.map((t) =>
        dump(
          db,
          t,
          PARENTS.indexOf(t) === 1 || PARENTS.indexOf(t) === 3
            ? "lease_id"
            : PARENTS.indexOf(t) === 2
              ? "attempt_id"
              : "id"
        )
      )
    ).toEqual(before.parentRows);

    const after = guards(db, [...PARENTS, ...RESULT_TABLES]);
    expect(after.map((t) => t.name)).toEqual(saved.map((t) => t.name));
    for (const trigger of saved) {
      expect(norm(after.find((t) => t.name === trigger.name)?.sql ?? null), trigger.name).toEqual(norm(trigger.sql));
    }
  });

  it("leaves no temporary table, introduces no foreign-key violation and keeps the database healthy", () => {
    const { db } = seeded();
    // The seed deliberately skips unrelated parents (plans, admissions), so some violations exist BEFORE the migration;
    // the migration must add none, and its own two tables must have none.
    const violations = () => JSON.stringify(db.prepare("PRAGMA foreign_key_check").all());
    const before = violations();
    apply075(db);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE sql LIKE '%pre075%' OR name LIKE '%pre075%'").all()
    ).toEqual([]);
    expect(violations()).toEqual(before);
    for (const table of RESULT_TABLES)
      expect(db.prepare(`PRAGMA foreign_key_check(${table})`).all(), table).toEqual([]);
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("keeps both tables append-only: UPDATE and DELETE still abort and change nothing", () => {
    const { db } = seeded();
    apply075(db);
    const before = [dump(db, "execution_results", "result_id"), dump(db, "attempt_results", "result_id")];
    for (const table of RESULT_TABLES) {
      expect(() => db.exec(`UPDATE ${table} SET summary = 'rewritten'`), `${table} update`).toThrow(/append-only/);
      expect(() => db.exec(`DELETE FROM ${table}`), `${table} delete`).toThrow(/append-only/);
    }
    expect([dump(db, "execution_results", "result_id"), dump(db, "attempt_results", "result_id")]).toEqual(before);
  });

  it("still enforces the active-lease binding on insert (an unbound ares result is refused)", () => {
    const { db } = seeded();
    apply075(db);
    expect(() =>
      put(db, "execution_results", {
        result_id: "er-unbound",
        work_item_id: "w1",
        lease_id: "l1",
        worker_id: "worker-a",
        idempotency_key: "idem-unbound",
        action_hash: H("1"),
        outcome: "succeeded",
        started_at: T0,
        finished_at: T1,
        exit_code: 0,
        summary: "s",
        structured_output_json: "{}",
        artifacts_json: "[]",
        simulation_metadata_json: meta("ares"),
        payload_hash: H("b"),
        created_at: T1
      })
    ).toThrow(/active lease binding is required/);
  });

  it("accepts the 'ares' mode (with its exact backend) and rejects any other mode or a mismatched backend", () => {
    const { db } = seeded();
    apply075(db);
    // Constraint check only: drop the insert guards in this throwaway copy so the CHECK is what decides.
    for (const trigger of guards(db, RESULT_TABLES).filter((t) => /binding_guard|cancel_race_guard/.test(t.name)))
      db.exec(`DROP TRIGGER ${trigger.name}`);
    const exec = (id: string, simulation: string): Row => ({
      result_id: id,
      work_item_id: "w1",
      lease_id: "l1",
      worker_id: `w-${id}`,
      idempotency_key: `k-${id}`,
      action_hash: H("1"),
      outcome: "succeeded",
      started_at: T0,
      finished_at: T1,
      exit_code: 0,
      summary: "s",
      structured_output_json: "{}",
      artifacts_json: "[]",
      simulation_metadata_json: simulation,
      payload_hash: H("b"),
      created_at: T1
    });
    // work_item_id is UNIQUE in execution_results, so give each accepted row its own work item and lease.
    for (const id of ["x1", "x2"]) {
      put(db, "work_items", {
        id: `wx-${id}`,
        title: "t",
        requester: "user",
        status: "succeeded",
        intent: "i",
        target_json: "{}",
        requested_actions_json: "[]",
        risk: "medium",
        created_at: T0,
        updated_at: T1
      });
      put(db, "leases", {
        lease_id: `lx-${id}`,
        work_item_id: `wx-${id}`,
        worker_id: `w-${id}`,
        token_hash: H("a"),
        action_hash: H("1"),
        issued_at: T0,
        expires_at: T1,
        status: "consumed",
        closed_at: T1
      });
    }
    const ok = { ...exec("e-ares", meta("ares")), work_item_id: "wx-x1", lease_id: "lx-x1", worker_id: "w-x1" };
    expect(() => put(db, "execution_results", ok)).not.toThrow();
    const wrongMode = {
      ...exec("e-bogus", meta("bogus")),
      work_item_id: "wx-x2",
      lease_id: "lx-x2",
      worker_id: "w-x2"
    };
    expect(() => put(db, "execution_results", wrongMode)).toThrow(/CHECK constraint/);
    const wrongBackend = {
      ...wrongMode,
      result_id: "e-wb",
      idempotency_key: "k-wb",
      simulation_metadata_json: JSON.stringify({
        executionMode: "ares",
        simulated: false,
        backend: "desktop-commander-mcp"
      })
    };
    expect(() => put(db, "execution_results", wrongBackend)).toThrow(/CHECK constraint/);
    const simulatedAres = {
      ...wrongMode,
      result_id: "e-sim",
      idempotency_key: "k-sim",
      simulation_metadata_json: JSON.stringify({ executionMode: "ares", simulated: true, backend: "ares-studio" })
    };
    expect(() => put(db, "execution_results", simulatedAres)).toThrow(/CHECK constraint/);
  });
});
