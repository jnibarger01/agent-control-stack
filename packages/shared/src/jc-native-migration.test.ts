import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
describe("native JC forward migration", () => {
  it("preserves seeded issuances, foreign keys, replay indexes and append-only triggers", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "PRAGMA foreign_keys=OFF; CREATE TABLE jace_commander_tools(tool_name TEXT PRIMARY KEY, added_in_migration INTEGER);"
      );
      db.exec("INSERT INTO jace_commander_tools VALUES ('ping',31),('write_file',31)");
      const previous = readFileSync(
        new URL("../../../storage/migrations/051_jace_commander_universal_admin.sql", import.meta.url),
        "utf8"
      );
      const start = previous.indexOf("CREATE TABLE jace_commander_capability_issuances");
      const end = previous.indexOf("INSERT INTO jace_commander_capability_issuances");
      db.exec(previous.slice(start, end));
      const fields = [
        "capability_issuance_id",
        "lease_id",
        "attempt_id",
        "work_item_id",
        "runtime_id",
        "tool_name",
        "action_hash",
        "request_hash",
        "invocation_hash",
        "approval_id",
        "approved_by_actor_id",
        "key_id",
        "nonce_hash",
        "issued_at",
        "expires_at"
      ];
      const row: Array<string | null> = [
        "cap-old",
        "lease-old",
        "att-old",
        "wi-old",
        "runtime-old",
        "write_file",
        "a".repeat(64),
        "b".repeat(64),
        "c".repeat(64),
        "approval-old",
        "operator-old",
        "key-old",
        "d".repeat(64),
        "2026-11-03T00:00:00.000Z",
        "2026-11-03T00:00:20.000Z"
      ];
      db.prepare(
        "INSERT INTO jace_commander_capability_issuances(" +
          fields.join(",") +
          ") VALUES(" +
          fields.map(() => "?").join(",") +
          ")"
      ).run(...row);
      const before = db.prepare("SELECT * FROM jace_commander_capability_issuances").all();
      db.exec(
        readFileSync(
          new URL("../../../storage/migrations/076_jace_commander_native_tools.sql", import.meta.url),
          "utf8"
        )
      );
      expect(db.prepare("SELECT * FROM jace_commander_capability_issuances").all()).toEqual(before);
      expect(db.prepare("SELECT tool_name FROM jace_commander_tools WHERE added_in_migration=76").all()).toHaveLength(
        4
      );
      expect(() => db.exec("UPDATE jace_commander_capability_issuances SET runtime_id='changed'")).toThrow(
        /append-only/
      );
      expect(() => db.exec("DELETE FROM jace_commander_capability_issuances")).toThrow(/append-only/);
      const insert = db.prepare(
        "INSERT INTO jace_commander_capability_issuances(" +
          fields.join(",") +
          ") VALUES(" +
          fields.map(() => "?").join(",") +
          ")"
      );
      for (const tool of ["run_command", "start_terminal_session", "interact_with_process", "delete_file"]) {
        const next = [...row];
        next[0] = "cap-" + tool;
        next[5] = tool;
        next[8] = Buffer.from(tool).toString("hex").padEnd(64, "0");
        next[9] = "appr-" + tool;
        next[12] = next[8];
        expect(() => insert.run(...next)).not.toThrow();
        next[0] += "-no-approval";
        next[9] = null;
        next[10] = null;
        next[12] = "e".repeat(64);
        expect(() => insert.run(...next)).toThrow(/CHECK constraint/);
      }
      expect(db.prepare("PRAGMA foreign_key_list('jace_commander_capability_issuances')").all()).toHaveLength(6);
    } finally {
      db.close();
    }
  });
});
