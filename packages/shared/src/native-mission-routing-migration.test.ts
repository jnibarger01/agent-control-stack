import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyControlPlaneMigrations } from "./migration.js";

describe("native mission routing evidence migration", () => {
  it("installs version 23 with append-only evidence and foreign-key enforcement", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      applyControlPlaneMigrations(db);
      expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 27").get()).toEqual({
        name: "native_mission_routing_evidence"
      });

      const intakeHash = "a".repeat(64);
      db.prepare(
        "INSERT INTO mission_intake_records (intake_hash, schema_version, canonical_json, created_at) VALUES (?, ?, ?, ?)"
      ).run(intakeHash, "acs.mission-intake.v1", "{}", "2026-09-04T12:00:00.000Z");
      expect(() =>
        db
          .prepare("UPDATE mission_intake_records SET created_at = ? WHERE intake_hash = ?")
          .run("2026-09-04T12:00:01.000Z", intakeHash)
      ).toThrow(/append-only/);
      expect(() =>
        db
          .prepare(
            "INSERT INTO mission_classifier_evidence_records (evidence_hash, intake_hash, schema_version, canonical_json, created_at) VALUES (?, ?, ?, ?, ?)"
          )
          .run("b".repeat(64), "c".repeat(64), "acs.classifier-evidence.v1", "{}", "2026-09-04T12:00:00.000Z")
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
