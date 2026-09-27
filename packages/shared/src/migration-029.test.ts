import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { applyControlPlaneMigrations } from "./migration.js";

/**
 * 029 moves the Jace Commander issuance tool allowlist from a CHECK into an
 * FK-referenced lookup table. The audit table is rebuilt, so these tests pin
 * that nothing the 028 table enforced was lost and no row was dropped.
 */
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function migrated(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "acs-migration-029-"));
  directories.push(directory);
  const db = new DatabaseSync(join(directory, "control.db"));
  applyControlPlaneMigrations(db);
  return db;
}

const hash = (c: string) => c.repeat(64);
let sequence = 0;
const uniqueHash = () => (++sequence).toString(16).padStart(64, "0");

function row(overrides: Record<string, unknown> = {}) {
  return {
    capability_issuance_id: `cap-${Math.random().toString(36).slice(2)}`,
    lease_id: "lease-1",
    attempt_id: "att-1",
    work_item_id: "wi-1",
    runtime_id: "jc-runtime",
    tool_name: "read_file",
    action_hash: hash("a"),
    request_hash: hash("b"),
    invocation_hash: uniqueHash(),
    approval_id: null,
    approved_by_actor_id: null,
    key_id: "k1",
    nonce_hash: hash("e"),
    issued_at: "2026-09-27T00:00:00.000Z",
    expires_at: "2026-09-27T00:00:20.000Z",
    ...overrides
  };
}

function insert(db: DatabaseSync, values: Record<string, unknown>): void {
  const columns = Object.keys(values);
  db.prepare(
    `INSERT INTO jace_commander_capability_issuances (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
  ).run(...(Object.values(values) as Array<string | null>));
}

describe("migration 029: jace_commander tool allowlist", () => {
  it("seeds the 12 known tools and makes the allowlist append-only", () => {
    const db = migrated();
    const tools = (db.prepare("SELECT tool_name FROM jace_commander_tools ORDER BY tool_name").all() as Array<{
      tool_name: string;
    }>).map((entry) => entry.tool_name);
    expect(tools).toHaveLength(12);
    expect(tools).toContain("privileged_exec");
    expect(tools).toContain("read_multiple_files");
    expect(() => db.prepare("DELETE FROM jace_commander_tools WHERE tool_name = 'read_file'").run()).toThrow(
      /append-only/
    );
    expect(() => db.prepare("UPDATE jace_commander_tools SET added_in_migration = 1").run()).toThrow(/append-only/);
    db.close();
  });

  it("refuses an issuance row for a tool the database does not know (FK)", () => {
    const db = migrated();
    db.exec("PRAGMA foreign_keys = OFF");
    insert(db, row({ nonce_hash: hash("1") }));
    db.exec("PRAGMA foreign_keys = ON");
    const violations = db.prepare("PRAGMA foreign_key_check(jace_commander_capability_issuances)").all() as Array<{
      parent: string;
    }>;
    // Only the lease/attempt FK is unsatisfied for this synthetic row; the tool FK is.
    expect(violations.some((violation) => violation.parent === "jace_commander_tools")).toBe(false);
    expect(() => insert(db, row({ tool_name: "run_command", nonce_hash: hash("2") }))).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it("keeps the privileged_exec human-approval CHECK and the append-only triggers", () => {
    const db = migrated();
    db.exec("PRAGMA foreign_keys = OFF");
    expect(() => insert(db, row({ tool_name: "privileged_exec", nonce_hash: hash("3") }))).toThrow(/CHECK/);
    expect(() =>
      insert(db, row({ tool_name: "read_file", approval_id: "ap-1", approved_by_actor_id: "u", nonce_hash: hash("4") }))
    ).toThrow(/CHECK/);
    insert(db, row({ nonce_hash: hash("5") }));
    expect(() => db.prepare("DELETE FROM jace_commander_capability_issuances").run()).toThrow(/append-only/);
    expect(() => db.prepare("UPDATE jace_commander_capability_issuances SET key_id = 'x'").run()).toThrow(
      /append-only/
    );
    db.close();
  });

  it("preserves every 028-era row across the table rebuild (re-applying 029 from the 028 layout)", () => {
    const db = migrated();
    db.exec("PRAGMA foreign_keys = OFF");
    insert(db, row({ tool_name: "acs_read", nonce_hash: hash("6") }));
    insert(db, row({ tool_name: "jc_status", nonce_hash: hash("7") }));
    // Re-run 029 exactly as a database coming from the 028 layout would.
    db.prepare("DELETE FROM schema_migrations WHERE version = 29").run();
    applyControlPlaneMigrations(db);
    const tools = (
      db.prepare("SELECT tool_name FROM jace_commander_capability_issuances ORDER BY tool_name").all() as Array<{
        tool_name: string;
      }>
    ).map((entry) => entry.tool_name);
    expect(tools).toEqual(["acs_read", "jc_status"]);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'jace_commander_capability_issuances__pre029'").get()
    ).toEqual({ n: 0 });
    db.close();
  });
});
