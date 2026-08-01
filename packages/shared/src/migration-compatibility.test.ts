import { DatabaseSync } from "node:sqlite";
import { applyControlPlaneMigrations, controlPlaneMigrations } from "./migration.js";
import { describe, expect, it } from "vitest";

describe("control-plane migration compatibility matrix", () => {
  it.each(controlPlaneMigrations().map((migration) => migration.version))(
    "upgrades the v%d fixture to the canonical current schema",
    (fixtureVersion) => {
      const fresh = new DatabaseSync(":memory:");
      const upgraded = new DatabaseSync(":memory:");

      try {
        applyControlPlaneMigrations(fresh);
        seedRepresentativeData(fresh);

        createFixtureAtVersion(upgraded, fixtureVersion);
        seedRepresentativeData(upgraded);
        applyControlPlaneMigrations(upgraded);

        expect(schemaDigest(upgraded)).toEqual(schemaDigest(fresh));
        expect(representativeData(upgraded)).toEqual(representativeData(fresh));
        expect(appliedVersions(upgraded)).toEqual(controlPlaneMigrations().map(({ version }) => version));
      } finally {
        fresh.close();
        upgraded.close();
      }
    }
  );

  it("upgrades an empty pre-release database through the same path as a fresh install", () => {
    const fresh = new DatabaseSync(":memory:");
    const preRelease = new DatabaseSync(":memory:");

    try {
      applyControlPlaneMigrations(fresh);
      applyControlPlaneMigrations(preRelease);
      expect(schemaDigest(preRelease)).toEqual(schemaDigest(fresh));
    } finally {
      fresh.close();
      preRelease.close();
    }
  });

  it("rejects tampered migration history before changing the schema", () => {
    const db = new DatabaseSync(":memory:");

    try {
      applyControlPlaneMigrations(db);
      const before = schemaDigest(db);
      db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run("0".repeat(64));

      expect(() => applyControlPlaneMigrations(db)).toThrow("migration checksum mismatch for version 1");
      expect(schemaDigest(db)).toEqual(before);
    } finally {
      db.close();
    }
  });

  it.each([
    "before_schema_metadata",
    "after_schema_metadata",
    "before_migration",
    "after_migration_sql",
    "after_migration_metadata",
    "before_migration_commit",
    "after_migration_commit"
  ] as const)("recovers after an injected %s interruption", (phase) => {
    const db = new DatabaseSync(":memory:");
    let injected = false;
    try {
      expect(() =>
        applyControlPlaneMigrations(db, {
          faultInjector: (observedPhase) => {
            if (observedPhase === phase && !injected) {
              injected = true;
              throw new Error(`injected ${phase}`);
            }
          }
        })
      ).toThrow(`injected ${phase}`);
      applyControlPlaneMigrations(db);
      expect(appliedVersions(db)).toEqual(controlPlaneMigrations().map(({ version }) => version));
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      db.close();
    }
  });
});

function createFixtureAtVersion(db: DatabaseSync, version: number): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      filename TEXT NOT NULL,
      checksum TEXT NOT NULL DEFAULT '',
      applied_at TEXT NOT NULL
    );
  `);

  for (const migration of controlPlaneMigrations().slice(0, version)) {
    db.exec(migration.sql);
    db.prepare(
      `INSERT INTO schema_migrations (version, name, filename, checksum, applied_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(migration.version, migration.name, migration.filename, migration.checksum, "2026-07-20T00:00:00.000Z");
  }
}

function seedRepresentativeData(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO audit_events
      (id, name, time_unix_nano, attributes, body, previous_hash, event_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run("fixture-event", "fixture.created", "1780000000000000000", "{}", "{}", "", "");
  db.prepare(
    `INSERT INTO work_items
      (id, title, requester, status, intent, target_json, requested_actions_json, risk, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "fixture-work-item",
    "Migration fixture",
    "fixture-user",
    "draft",
    "verify migration compatibility",
    "{}",
    "[]",
    "low",
    "2026-07-20T00:00:00.000Z",
    "2026-07-20T00:00:00.000Z"
  );
}

function schemaDigest(db: DatabaseSync): Array<{ type: string; name: string; objectName: string; sql: string | null }> {
  return db
    .prepare(
      `SELECT type, name, tbl_name AS objectName, sql
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`
    )
    .all() as Array<{ type: string; name: string; objectName: string; sql: string | null }>;
}

function representativeData(db: DatabaseSync): { events: unknown[]; workItems: unknown[] } {
  return {
    events: db.prepare("SELECT id, name, attributes, body FROM audit_events WHERE id = 'fixture-event'").all(),
    workItems: db
      .prepare(
        "SELECT id, title, requester, status, intent, target_json, requested_actions_json, risk FROM work_items WHERE id = 'fixture-work-item'"
      )
      .all()
  };
}

function appliedVersions(db: DatabaseSync): number[] {
  return (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>).map(
    (row) => row.version
  );
}
