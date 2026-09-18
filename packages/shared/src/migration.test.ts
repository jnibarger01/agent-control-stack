import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { applyControlPlaneMigrations, controlPlaneMigrations } from "./migration.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function database(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "acs-migrations-"));
  directories.push(directory);
  const db = new DatabaseSync(join(directory, "control.db"));
  applyControlPlaneMigrations(db);
  return db;
}

const alternate = [
  [
    17,
    "desktop_commander_execution_mode",
    "017_desktop_commander_execution_mode.sql",
    "aedd1140975cd1a9197df06f1dbd9906b8b3ab143b4025bcc2e4ba0e758f5d43"
  ],
  [
    18,
    "advisory_evidence_and_verification",
    "018_advisory_evidence_and_verification.sql",
    "456755abba99bae8a282b1f0544b4f0e798f57a27d4e717ec4b28ba79d4a9f7d"
  ],
  [
    19,
    "scheduler_firing_callback_pending",
    "019_scheduler_firing_callback_pending.sql",
    "51bc791cc466b83d6e80dccd10ab077dd37118899d860e2e53cf6d187fec9124"
  ],
  [
    20,
    "attempt_lease_approvals",
    "020_attempt_lease_approvals.sql",
    "dc9481337e06d8c6a118883d6e8f656be6e8c0321b44a952936d81e18a552f7c"
  ],
  [
    21,
    "work_item_metadata",
    "021_work_item_metadata.sql",
    "65b2abe0bd8b6bd15723b656fa0ddd62359adf02d65d0239742a950f1c37da9e"
  ]
] as const;

function applyAlternateMetadata(db: DatabaseSync): void {
  db.prepare("DELETE FROM schema_migrations WHERE version >= 17").run();
  for (const [version, name, filename, checksum] of alternate) {
    db.prepare(
      "INSERT INTO schema_migrations (version, name, filename, checksum, applied_at) VALUES (?, ?, ?, ?, ?)"
    ).run(version, name, filename, checksum, new Date().toISOString());
  }
}

const preLeaseRenewal = [
  [
    20,
    "desktop_commander_execution_mode",
    "020_desktop_commander_execution_mode.sql",
    "23c5d1ce662f032aa88df3ccf6a810fe0c08ef4ead22787365401befd39109fe"
  ],
  [
    21,
    "advisory_evidence_and_verification",
    "021_advisory_evidence_and_verification.sql",
    "0a530ca728bda97f7aedfa1ff89e2ae9a70cc0313d5208a5e7ca1089d7fc80a2"
  ],
  [22, "device_auth", "022_device_auth.sql", "a6527d63c1a6c3549c6c2a69b6b255be0dea751b70c3a4227f67e1deab1883e3"],
  [
    23,
    "desktop_commander_runtime_capabilities",
    "023_desktop_commander_runtime_capabilities.sql",
    "5aae973d05b6bca6e0f6157eaa739a570c8e6dd19116f89a8e7fbfc82470059a"
  ]
] as const;

function applyPreLeaseRenewalMetadata(db: DatabaseSync): void {
  db.prepare("DELETE FROM schema_migrations WHERE version >= 20").run();
  for (const [version, name, filename, checksum] of preLeaseRenewal) {
    db.prepare(
      "INSERT INTO schema_migrations (version, name, filename, checksum, applied_at) VALUES (?, ?, ?, ?, ?)"
    ).run(version, name, filename, checksum, new Date().toISOString());
  }
}

describe("control-plane migration alternate 17-21 repair", () => {
  it("migrates a fresh database and leaves canonical metadata unchanged", () => {
    const db = database();
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 25 });
    db.close();
  });

  it("transactionally remaps only the exact alternate deployed layout and is idempotent", () => {
    const db = database();
    applyAlternateMetadata(db);
    applyControlPlaneMigrations(db);
    const rows = db
      .prepare(
        "SELECT version, name, filename, checksum FROM schema_migrations WHERE version BETWEEN 17 AND 21 ORDER BY version"
      )
      .all();
    const canonical = controlPlaneMigrations()
      .filter((migration) => migration.version >= 17 && migration.version <= 21)
      .map(({ version, name, filename, checksum }) => ({ version, name, filename, checksum }));
    expect(rows).toEqual(canonical);
    applyControlPlaneMigrations(db);
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 25 });
    db.close();
  });

  it("rejects partial or checksum-mismatched alternate metadata without remapping", () => {
    const partial = database();
    const [version, name, filename, checksum] = alternate[0];
    partial
      .prepare("UPDATE schema_migrations SET name = ?, filename = ?, checksum = ? WHERE version = ?")
      .run(name, filename, checksum, version);
    expect(() => applyControlPlaneMigrations(partial)).toThrow("migration metadata mismatch for version 17");
    expect(partial.prepare("SELECT name FROM schema_migrations WHERE version = 17").get()).toEqual({ name });
    partial.close();

    const mismatched = database();
    applyAlternateMetadata(mismatched);
    mismatched.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 18").run("0".repeat(64));
    expect(() => applyControlPlaneMigrations(mismatched)).toThrow("migration metadata mismatch for version 17");
    expect(mismatched.prepare("SELECT checksum FROM schema_migrations WHERE version = 18").get()).toEqual({
      checksum: "0".repeat(64)
    });
    mismatched.close();
  });

  it.each([
    ["name", "UPDATE schema_migrations SET name = ? WHERE version = ?", ["wrong_name", 18]],
    ["filename", "UPDATE schema_migrations SET filename = ? WHERE version = ?", ["018_wrong.sql", 19]],
    ["checksum", "UPDATE schema_migrations SET checksum = ? WHERE version = ?", ["0".repeat(64), 20]]
  ])("fails closed and preserves rows for a %s mismatch in an otherwise alternate layout", (_kind, sql, params) => {
    const db = database();
    applyAlternateMetadata(db);
    db.prepare(sql).run(...params);
    const before = db
      .prepare(
        "SELECT version, name, filename, checksum FROM schema_migrations WHERE version BETWEEN 17 AND 21 ORDER BY version"
      )
      .all();
    expect(() => applyControlPlaneMigrations(db)).toThrow("migration metadata mismatch for version 17");
    expect(
      db
        .prepare(
          "SELECT version, name, filename, checksum FROM schema_migrations WHERE version BETWEEN 17 AND 21 ORDER BY version"
        )
        .all()
    ).toEqual(before);
    db.close();
  });

  it("fails schema validation before remapping and leaves the exact alternate metadata intact", () => {
    const db = database();
    applyAlternateMetadata(db);
    db.exec("DROP TABLE evidence_manifests");
    const before = db
      .prepare(
        "SELECT version, name, filename, checksum FROM schema_migrations WHERE version BETWEEN 17 AND 21 ORDER BY version"
      )
      .all();
    expect(() => applyControlPlaneMigrations(db)).toThrow("alternate migration layout schema validation failed");
    expect(
      db
        .prepare(
          "SELECT version, name, filename, checksum FROM schema_migrations WHERE version BETWEEN 17 AND 21 ORDER BY version"
        )
        .all()
    ).toEqual(before);
    db.close();
  });
});

describe("control-plane migration pre-lease-renewal 20-23 repair", () => {
  it("transactionally inserts lease renewal and shifts the exact deployed layout to 21-24", () => {
    const db = database();
    applyPreLeaseRenewalMetadata(db);
    applyControlPlaneMigrations(db);
    const rows = db
      .prepare("SELECT version, name, filename, checksum FROM schema_migrations WHERE version >= 20 ORDER BY version")
      .all();
    const canonical = controlPlaneMigrations()
      .filter((migration) => migration.version >= 20)
      .map(({ version, name, filename, checksum }) => ({ version, name, filename, checksum }));
    expect(rows).toEqual(canonical);
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 25 });
    applyControlPlaneMigrations(db);
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 25 });
    db.close();
  });

  it("rejects a checksum mismatch without shifting or applying lease renewal", () => {
    const db = database();
    applyPreLeaseRenewalMetadata(db);
    db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 22").run("0".repeat(64));
    const before = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    expect(() => applyControlPlaneMigrations(db)).toThrow("migration metadata mismatch for version 20");
    expect(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(before);
    db.close();
  });
});
