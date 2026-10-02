import { mkdtempSync, rmSync } from "node:fs";
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
    const canonical = new Map(controlPlaneMigrations().map((migration) => [migration.version, migration]));
    for (const [version, name, filename, checksum, canonicalVersion] of [
      [
        37,
        "execution_results_idempotency_unique",
        "037_execution_results_idempotency_unique.sql",
        "956ee37aed0a4466fb5a128123398e3ecb8cad3a202224205cbaa83ef7ed8545",
        38
      ],
      [
        38,
        "admission_permits",
        "038_admission_permits.sql",
        "11dbde427fe5d3b3fad1fc1fb1d735bc29b18eb59a3b04cb9c1ee82b6e3e2de5",
        40
      ]
    ] as const) {
      db.exec(canonical.get(canonicalVersion)!.sql);
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
        name: "jace_commander_admin_approvals"
      });
      expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 40").get()).toEqual({
        name: "admission_permits"
      });
      applyControlPlaneMigrations(db);
      expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 49 });
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
      const canonicalMigrations = new Map(controlPlaneMigrations().map((migration) => [migration.version, migration]));
      for (const [version, name, filename, checksum] of historical) {
        const schemaVersion = version === 37 ? 38 : 40;
        db.exec(canonicalMigrations.get(schemaVersion)!.sql);
        db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?, ?)").run(
          version,
          name,
          filename,
          checksum,
          appliedAt
        );
      }
      for (const [legacyVersion, canonicalVersion] of [
        [40, 41],
        [41, 42],
        [42, 43]
      ] as const) {
        const migration = controlPlaneMigrations().find((entry) => entry.version === canonicalVersion)!;
        const legacyFilename = `${String(legacyVersion).padStart(3, "0")}_${migration.filename.slice(4)}`;
        db.exec(migration.sql);
        db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?, ?)").run(
          legacyVersion,
          migration.name,
          legacyFilename,
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
      expect(db.prepare("SELECT applied_at FROM schema_migrations WHERE version = 44").get()).toEqual({
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
      expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 49 });
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
      controlPlaneMigrations().filter((migration) => migration.filename === "043_work_item_assignments.sql")
    ).toHaveLength(1);
  });
});

describe("production release migration lineage", () => {
  const deployedRows = [
    [
      39,
      "admission_permits",
      "039_admission_permits.sql",
      40,
      "11dbde427fe5d3b3fad1fc1fb1d735bc29b18eb59a3b04cb9c1ee82b6e3e2de5"
    ],
    [
      40,
      "admission_permit_execution_class",
      "040_admission_permit_execution_class.sql",
      41,
      "17ec50b1dfcc92b34ecfd7875ac8193f89d0b71e607cc18bad34c3998b4f88ed"
    ],
    [41, "change_sets", "041_change_sets.sql", 42, "8eb803fffe827c9d89c53af28000fa6eebafba272f6645af29ad20a8b6ce1bba"],
    [
      42,
      "work_item_assignments",
      "042_work_item_assignments.sql",
      43,
      "880096512404a496ae718f734b7eda223bbf638e1976a4ddb0f4d8465f9320fd"
    ],
    [
      43,
      "migration_lineage_reconciliation",
      "043_migration_lineage_reconciliation.sql",
      44,
      "17d881e7033b4cbd33e1f2b55aefe4e1ae91a0314e8b4b8724a7d46a1fce3c2c"
    ],
    [
      44,
      "change_set_approvals",
      "044_change_set_approvals.sql",
      45,
      "45ebcd8f20e4b4adbbd60b66dc3e439c75cd86a7de3c33acadeed6fcbd1b8895"
    ],
    [
      45,
      "change_set_operation_permits",
      "045_change_set_operation_permits.sql",
      46,
      "045abe6497d38f2d868a950efc9e6fffac57d0f8dd0a1b22ff38cb583853f3a9"
    ],
    [
      46,
      "autonomous_authority",
      "046_autonomous_authority.sql",
      47,
      "babdbc51897b6f79a1a9770b9e3f7a8cfa020e4ab6c5279fd1c88130e19ea344"
    ],
    [
      47,
      "operation_permit_grant_authority",
      "047_operation_permit_grant_authority.sql",
      48,
      "61b3235e649c6736ad44f16743e8cda669ddf7ee7ba344a63990f174f2c4a9aa"
    ]
  ] as const;

  function deployedDatabase(): DatabaseSync {
    const db = database(38);
    const appliedAt = "2026-10-02T00:00:00.000Z";
    const canonical = new Map(controlPlaneMigrations().map((migration) => [migration.version, migration]));
    for (const [version, name, filename, canonicalVersion, checksum] of deployedRows) {
      db.exec(canonical.get(canonicalVersion)!.sql);
      db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?, ?)").run(
        version,
        name,
        filename,
        checksum,
        appliedAt
      );
    }
    return db;
  }

  it("maps only the exact deployed v39-v47 schema to main's v40-v48 slots, then applies main's v39 and Nimble v49", () => {
    const db = deployedDatabase();
    try {
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
      expect(db.prepare("SELECT attempt_id, execution_class FROM admission_permits").all()).toEqual([
        { attempt_id: "attempt", execution_class: "execution" }
      ]);
      expect(db.prepare("SELECT applied_at FROM schema_migrations WHERE version = 44").get()).toEqual({
        applied_at: "2026-10-02T00:00:00.000Z"
      });
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get("nimble_routing_decision_details")
      ).toEqual({ count: 1 });
      applyControlPlaneMigrations(db);
      expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 49 });
    } finally {
      db.close();
    }
  });

  it("rejects production lineage checksum drift without changing any migration record", () => {
    const db = deployedDatabase();
    try {
      db.prepare("UPDATE schema_migrations SET checksum = 'bad' WHERE version = 42").run();
      const before = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      expect(() => applyControlPlaneMigrations(db)).toThrow("production migration lineage metadata mismatch");
      expect(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(before);
    } finally {
      db.close();
    }
  });
});
