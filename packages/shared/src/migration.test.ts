import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { applyControlPlaneMigrations, controlPlaneMigrations } from "./migration.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function database(lastVersion?: number): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "acs-migrations-"));
  directories.push(directory);
  const db = new DatabaseSync(join(directory, "control.db"));
  if (lastVersion === undefined) applyControlPlaneMigrations(db);
  else {
    // Construct the historical fixture atomically. The test below still runs
    // the real upgrade/repair path; fixture setup need not fsync every statement.
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, filename TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)"
      );
      for (const migration of controlPlaneMigrations().filter((entry) => entry.version <= lastVersion)) {
        db.exec(migration.sql);
        db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?, ?)").run(
          migration.version,
          migration.name,
          migration.filename,
          migration.checksum,
          new Date().toISOString()
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      db.close();
      throw error;
    }
  }
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
  it("converges concurrent process startups to one canonical pristine database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-migration-concurrency-"));
    directories.push(directory);
    const dbPath = join(directory, "control.db");
    const script = `
      import { DatabaseSync } from 'node:sqlite';
      import { applyControlPlaneMigrations } from ${JSON.stringify(new URL("./migration.ts", import.meta.url).href)};
      const db = new DatabaseSync(${JSON.stringify(dbPath)});
      try {
        db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
        applyControlPlaneMigrations(db);
        console.log(JSON.stringify(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()));
      } finally { db.close(); }
    `;
    const children = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script])
      )
    );
    for (const child of children) {
      expect(child.status, child.status === "rejected" ? String(child.reason) : child.value.stderr).toBe("fulfilled");
      if (child.status === "fulfilled")
        expect(JSON.parse(child.value.stdout)).toEqual({ count: controlPlaneMigrations().length });
    }
    const db = new DatabaseSync(dbPath);
    try {
      expect(
        db.prepare("SELECT version, name, filename, checksum FROM schema_migrations ORDER BY version").all()
      ).toEqual(
        controlPlaneMigrations().map(({ version, name, filename, checksum }) => ({ version, name, filename, checksum }))
      );
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("initializes pristine schema and canonical metadata in one transaction", () => {
    const db = database(0);
    const statements: string[] = [];
    try {
      applyControlPlaneMigrations({
        exec(sql) {
          statements.push(sql);
          db.exec(sql);
        },
        prepare(sql) {
          return db.prepare(sql);
        }
      });
      expect(statements.filter((sql) => sql === "BEGIN IMMEDIATE")).toHaveLength(1);
      expect(statements.filter((sql) => sql === "COMMIT")).toHaveLength(1);
      expect(
        db.prepare("SELECT version, name, filename, checksum FROM schema_migrations ORDER BY version").all()
      ).toEqual(
        controlPlaneMigrations().map(({ version, name, filename, checksum }) => ({ version, name, filename, checksum }))
      );
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rolls back all pristine schema and metadata on a late migration failure", () => {
    const db = database(0);
    const lastSql = controlPlaneMigrations().at(-1)!.sql;
    try {
      expect(() =>
        applyControlPlaneMigrations({
          exec(sql) {
            if (sql === lastSql) throw new Error("fixture late migration failure");
            db.exec(sql);
          },
          prepare(sql) {
            return db.prepare(sql);
          }
        })
      ).toThrow("fixture late migration failure");
      expect(db.prepare("SELECT version FROM schema_migrations").all()).toEqual([]);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*'").all()
      ).toEqual([{ name: "schema_migrations" }]);
      applyControlPlaneMigrations(db);
      expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({
        count: controlPlaneMigrations().length
      });
    } finally {
      db.close();
    }
  });

  it("migrates a fresh database and leaves canonical metadata unchanged", () => {
    const db = database();
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({
      count: controlPlaneMigrations().length
    });
    db.close();
  });

  it("transactionally remaps only the exact alternate deployed layout and is idempotent", () => {
    const db = database(22);
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
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({
      count: controlPlaneMigrations().length
    });
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

    const mismatched = database(22);
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
    const db = database(22);
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
    const db = database(22);
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
    const db = database(24);
    applyPreLeaseRenewalMetadata(db);
    applyControlPlaneMigrations(db);
    const rows = db
      .prepare("SELECT version, name, filename, checksum FROM schema_migrations WHERE version >= 20 ORDER BY version")
      .all();
    const canonical = controlPlaneMigrations()
      .filter((migration) => migration.version >= 20)
      .map(({ version, name, filename, checksum }) => ({ version, name, filename, checksum }));
    expect(rows).toEqual(canonical);
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({
      count: controlPlaneMigrations().length
    });
    applyControlPlaneMigrations(db);
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({
      count: controlPlaneMigrations().length
    });
    db.close();
  });

  it("rejects a checksum mismatch without shifting or applying lease renewal", () => {
    const db = database(24);
    applyPreLeaseRenewalMetadata(db);
    db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 22").run("0".repeat(64));
    const before = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    expect(() => applyControlPlaneMigrations(db)).toThrow("migration metadata mismatch for version 20");
    expect(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(before);
    db.close();
  });
});

describe("recovery migration 37-38 lineage", () => {
  function recoveryDatabase(): DatabaseSync {
    const db = database(36);
    for (const [version, name, filename, checksum] of [
      [
        37,
        "execution_results_idempotency_unique",
        "037_execution_results_idempotency_unique.sql",
        "956ee37aed0a4466fb5a128123398e3ecb8cad3a202224205cbaa83ef7ed8545"
      ],
      [
        38,
        "admission_permits",
        "038_admission_permits.sql",
        "11dbde427fe5d3b3fad1fc1fb1d735bc29b18eb59a3b04cb9c1ee82b6e3e2de5"
      ]
    ] as const) {
      db.exec(readFileSync(new URL(`../../../storage/migrations/${filename}`, import.meta.url), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?, ?)").run(
        version,
        name,
        filename,
        checksum,
        "2026-10-01T00:00:00.000Z"
      );
    }
    return db;
  }

  it("preserves admission rows, repairs exact numbering and adds current schema once", () => {
    const db = recoveryDatabase();
    try {
      db.exec(
        "INSERT INTO admission_permits (attempt_id, work_item_id, lease_id, worker_id, action_hash, plan_hash, input_hash, lane) VALUES ('attempt', 'mission', 'lease', 'worker', 'a', 'p', 'i', 'dc')"
      );
      applyControlPlaneMigrations(db);
      expect(db.prepare("SELECT attempt_id, execution_class FROM admission_permits").all()).toEqual([
        { attempt_id: "attempt", execution_class: "execution" }
      ]);
      expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 37").get()).toEqual({
        name: "jc_reusable_work_item_index"
      });
      expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 39").get()).toEqual({
        name: "admission_permits"
      });
      applyControlPlaneMigrations(db);
      expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 47 });
    } finally {
      db.close();
    }
  });

  it.each(["checksum", "schema", "later", "predecessor", "rollback"])(
    "refuses %s drift without rewriting recovery metadata",
    (kind) => {
      const db = recoveryDatabase();
      try {
        if (kind === "checksum") db.exec("UPDATE schema_migrations SET checksum = 'bad' WHERE version = 38");
        if (kind === "schema") db.exec("DROP INDEX idx_execution_results_idempotency_key");
        if (kind === "predecessor") db.exec("UPDATE schema_migrations SET checksum = 'bad' WHERE version = 36");
        if (kind === "rollback")
          db.exec(
            "CREATE TRIGGER reject_jc_migration BEFORE INSERT ON schema_migrations WHEN NEW.version = 37 BEGIN SELECT RAISE(ABORT, 'recovery migration layout insertion rejected'); END"
          );
        if (kind === "later")
          db.exec("INSERT INTO schema_migrations VALUES (39, 'unexpected', 'unknown.sql', 'bad', 'now')");
        const before = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
        expect(() => applyControlPlaneMigrations(db)).toThrow(/recovery migration layout/);
        expect(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(before);
      } finally {
        db.close();
      }
    }
  );

  it("migrates the deployed JC-index lineage without recovery remapping", () => {
    const db = database(37);
    try {
      const before = db.prepare("SELECT * FROM schema_migrations WHERE version = 37").get();
      applyControlPlaneMigrations(db);
      expect(db.prepare("SELECT * FROM schema_migrations WHERE version = 37").get()).toEqual(before);
    } finally {
      db.close();
    }
  });

  it("converges the isolated duplicate-admission lineage and preserves its migration record", () => {
    const db = database(36);
    try {
      const historical = [
        [
          37,
          "execution_results_idempotency_unique",
          "037_execution_results_idempotency_unique.sql",
          "956ee37aed0a4466fb5a128123398e3ecb8cad3a202224205cbaa83ef7ed8545"
        ],
        [
          38,
          "admission_permits",
          "038_admission_permits.sql",
          "11dbde427fe5d3b3fad1fc1fb1d735bc29b18eb59a3b04cb9c1ee82b6e3e2de5"
        ],
        [
          39,
          "admission_permits_reconciled",
          "039_admission_permits.sql",
          "11dbde427fe5d3b3fad1fc1fb1d735bc29b18eb59a3b04cb9c1ee82b6e3e2de5"
        ]
      ] as const;
      const appliedAt = "2026-10-01T00:00:00.000Z";
      for (const [version, name, filename, checksum] of historical) {
        db.exec(readFileSync(new URL(`../../../storage/migrations/${filename}`, import.meta.url), "utf8"));
        db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?, ?)").run(
          version,
          name,
          filename,
          checksum,
          appliedAt
        );
      }
      for (const migration of controlPlaneMigrations().filter((entry) => entry.version >= 40 && entry.version <= 42)) {
        db.exec(migration.sql);
        db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?, ?)").run(
          migration.version,
          migration.name,
          migration.filename,
          migration.checksum,
          appliedAt
        );
      }
      db.exec(
        "INSERT INTO admission_permits (attempt_id, work_item_id, lease_id, worker_id, action_hash, plan_hash, input_hash, lane) VALUES ('attempt', 'mission', 'lease', 'worker', 'a', 'p', 'i', 'dc')"
      );

      applyControlPlaneMigrations(db);
      const canonical = controlPlaneMigrations().map(({ version, name, filename, checksum }) => ({
        version,
        name,
        filename,
        checksum
      }));
      expect(
        db.prepare("SELECT version, name, filename, checksum FROM schema_migrations ORDER BY version").all()
      ).toEqual(canonical);
      expect(db.prepare("SELECT attempt_id FROM admission_permits").all()).toEqual([{ attempt_id: "attempt" }]);
      expect(db.prepare("SELECT applied_at FROM schema_migrations WHERE version = 43").get()).toEqual({
        applied_at: appliedAt
      });
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'work_item_assignments'"
          )
          .get()
      ).toEqual({ count: 1 });
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'work_item_assignments_worker_idx'"
          )
          .get()
      ).toEqual({ count: 1 });
      expect(
        (db.prepare("PRAGMA foreign_key_list(work_item_assignments)").all() as Array<{ table: string }>).map(
          (row) => row.table
        )
      ).toContain("work_items");

      applyControlPlaneMigrations(db);
      expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 47 });
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'work_item_assignments'"
          )
          .get()
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it("registers each migration version once in deterministic order", () => {
    const versions = controlPlaneMigrations().map((migration) => migration.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions).toEqual([...versions].sort((left, right) => left - right));
    expect(
      controlPlaneMigrations().filter((migration) => migration.filename === "042_work_item_assignments.sql")
    ).toHaveLength(1);
  });
});
