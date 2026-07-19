import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { auditEventHash } from "./audit-chain.js";
import { backupControlPlaneDatabase, restoreControlPlaneDatabase } from "./database-operations.js";
import { inspectControlPlaneDatabaseFile } from "./database-health.js";
import { applyControlPlaneMigrations } from "./migration.js";

describe("control-plane database health", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts a clean database using the full readiness contract", () => {
    const path = createHealthyDatabase();

    expect(inspectControlPlaneDatabaseFile(path)).toEqual({
      ok: true,
      checks: {
        integrity: { ok: true },
        foreignKeys: { ok: true },
        migrations: { ok: true },
        auditChain: { ok: true }
      }
    });
  });

  it("rejects a physically corrupted database", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "corrupted.db");
    writeFileSync(path, Buffer.alloc(4_096, 0x61));

    const health = inspectControlPlaneDatabaseFile(path);

    expect(health.ok).toBe(false);
    expect(health.checks.integrity).toMatchObject({ ok: false });
  });

  it("rejects migration identity or checksum drift", () => {
    const path = createHealthyDatabase();
    withDatabase(path, (db) => {
      db.prepare(`UPDATE schema_migrations SET checksum = ? WHERE version = 1`).run("0".repeat(64));
    });

    expect(inspectControlPlaneDatabaseFile(path).checks.migrations).toEqual({
      ok: false,
      code: "migration_mismatch"
    });
  });

  it("rejects foreign-key violations even when SQLite enforcement was disabled during insertion", () => {
    const path = createHealthyDatabase();
    withDatabase(path, (db) => {
      db.exec("PRAGMA foreign_keys = OFF");
      db.prepare(
        `INSERT INTO approval_records
         (work_item_id, action_hash, request_hash, approval_token_hash, approved_by, reason, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "missing-work-item",
        "action-hash",
        "request-hash",
        "",
        "user",
        "fixture",
        "granted",
        "2026-07-19T00:00:00.000Z",
        "2026-07-20T00:00:00.000Z"
      );
    });

    expect(inspectControlPlaneDatabaseFile(path).checks.foreignKeys).toEqual({
      ok: false,
      code: "foreign_key_violation"
    });
  });

  it("rejects a tampered event anywhere in the complete audit chain", () => {
    const path = createHealthyDatabase();
    withDatabase(path, (db) => {
      const first = auditFixture(1, "");
      const second = auditFixture(2, first.eventHash);
      insertAuditEvent(db, first);
      insertAuditEvent(db, second);
      db.prepare(`UPDATE audit_events SET body = ? WHERE sequence = 1`).run(JSON.stringify({ tampered: true }));
    });

    expect(inspectControlPlaneDatabaseFile(path).checks.auditChain).toEqual({
      ok: false,
      code: "audit_chain_event_hash_mismatch"
    });
  });

  it("creates only backups that pass the complete database-health contract", async () => {
    const source = createHealthyDatabase();
    const destination = join(temporaryDirectory(), "backup.db");

    await backupControlPlaneDatabase(source, destination);

    expect(inspectControlPlaneDatabaseFile(destination).ok).toBe(true);
  });

  it("refuses a physically corrupted backup source without leaving a destination", async () => {
    const source = join(temporaryDirectory(), "corrupted.db");
    const destination = join(temporaryDirectory(), "backup.db");
    writeFileSync(source, Buffer.alloc(4_096, 0x61));

    await expect(backupControlPlaneDatabase(source, destination)).rejects.toThrow("database health check failed");
    expect(existsSync(destination)).toBe(false);
  });

  it("refuses a migration-mismatched backup source without leaving a destination", async () => {
    const source = createHealthyDatabase();
    const destination = join(temporaryDirectory(), "backup.db");
    withDatabase(source, (db) => {
      db.prepare(`UPDATE schema_migrations SET checksum = ? WHERE version = 1`).run("0".repeat(64));
    });

    await expect(backupControlPlaneDatabase(source, destination)).rejects.toThrow("migration_mismatch");
    expect(existsSync(destination)).toBe(false);
  });

  it("refuses a foreign-key-invalid backup source without leaving a destination", async () => {
    const source = createHealthyDatabase();
    const destination = join(temporaryDirectory(), "backup.db");
    withDatabase(source, (db) => {
      db.exec("PRAGMA foreign_keys = OFF");
      db.prepare(
        `INSERT INTO approval_records
         (work_item_id, action_hash, request_hash, approval_token_hash, approved_by, reason, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "missing-work-item",
        "action-hash",
        "request-hash",
        "",
        "user",
        "fixture",
        "granted",
        "2026-07-19T00:00:00.000Z",
        "2026-07-20T00:00:00.000Z"
      );
    });

    await expect(backupControlPlaneDatabase(source, destination)).rejects.toThrow("foreign_key_violation");
    expect(existsSync(destination)).toBe(false);
  });

  it("refuses an audit-tampered backup source without leaving a destination", async () => {
    const source = createHealthyDatabase();
    const destination = join(temporaryDirectory(), "backup.db");
    withDatabase(source, (db) => {
      const event = auditFixture(1, "");
      insertAuditEvent(db, event);
      db.prepare(`UPDATE audit_events SET body = ? WHERE sequence = 1`).run(JSON.stringify({ tampered: true }));
    });

    await expect(backupControlPlaneDatabase(source, destination)).rejects.toThrow("audit_chain_event_hash_mismatch");
    expect(existsSync(destination)).toBe(false);
  });

  it("requires explicit confirmation that every writer is stopped before restore", async () => {
    const source = createHealthyDatabase();
    const destination = createHealthyDatabase();

    await expect(restoreControlPlaneDatabase(source, destination, { writersStopped: false })).rejects.toThrow(
      "writers must be stopped"
    );
  });

  it("atomically restores a verified backup and preserves a safety backup", async () => {
    const source = createHealthyDatabase();
    const destination = createHealthyDatabase();
    insertActor(source, "source-only");
    insertActor(destination, "destination-only");

    const result = await restoreControlPlaneDatabase(source, destination, { writersStopped: true });

    expect(readActorIds(destination)).toContain("source-only");
    expect(readActorIds(destination)).not.toContain("destination-only");
    expect(result.safetyBackup).toBeDefined();
    expect(readActorIds(result.safetyBackup!)).toContain("destination-only");
    expect(inspectControlPlaneDatabaseFile(destination).ok).toBe(true);
  });

  it("preserves the destination and removes the sibling temporary file on pre-rename interruption", async () => {
    const source = createHealthyDatabase();
    const destination = createHealthyDatabase();
    insertActor(source, "source-only");
    insertActor(destination, "destination-only");
    const before = readFileSync(destination);

    await expect(
      restoreControlPlaneDatabase(source, destination, {
        writersStopped: true,
        beforeRename: () => {
          throw new Error("simulated interruption");
        }
      })
    ).rejects.toThrow("simulated interruption");

    expect(readFileSync(destination)).toEqual(before);
    expect(readActorIds(destination)).toContain("destination-only");
    expect(restoreTemporaryFiles(destination)).toEqual([]);
  });

  it("re-verifies the sibling temporary file after the pre-rename hook", async () => {
    const source = createHealthyDatabase();
    const destination = createHealthyDatabase();
    insertActor(destination, "destination-only");
    const before = readFileSync(destination);

    await expect(
      restoreControlPlaneDatabase(source, destination, {
        writersStopped: true,
        beforeRename: (temporary) => writeFileSync(temporary, Buffer.alloc(4_096, 0x61))
      })
    ).rejects.toThrow("database health check failed");

    expect(readFileSync(destination)).toEqual(before);
    expect(readActorIds(destination)).toContain("destination-only");
    expect(restoreTemporaryFiles(destination)).toEqual([]);
  });

  it("preserves the destination when the backup fails full verification", async () => {
    const source = createHealthyDatabase();
    const destination = createHealthyDatabase();
    insertActor(destination, "destination-only");
    withDatabase(source, (db) => {
      db.prepare(`UPDATE schema_migrations SET checksum = ? WHERE version = 1`).run("0".repeat(64));
    });
    const before = readFileSync(destination);

    await expect(restoreControlPlaneDatabase(source, destination, { writersStopped: true })).rejects.toThrow(
      "migration_mismatch"
    );

    expect(readFileSync(destination)).toEqual(before);
    expect(restoreTemporaryFiles(destination)).toEqual([]);
  });

  it("fails closed while another connection holds the destination writer lock", async () => {
    const source = createHealthyDatabase();
    const destination = createHealthyDatabase();
    const writer = new DatabaseSync(destination);
    writer.exec("BEGIN IMMEDIATE");
    try {
      await expect(restoreControlPlaneDatabase(source, destination, { writersStopped: true })).rejects.toThrow(
        "active database writer"
      );
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });

  it.each(["-journal", "-wal", "-shm"])(
    "fails closed when a stale %s sidecar makes stopped-writer state ambiguous",
    async (suffix) => {
      const source = createHealthyDatabase();
      const destination = createHealthyDatabase();
      writeFileSync(`${destination}${suffix}`, "stale");

      await expect(restoreControlPlaneDatabase(source, destination, { writersStopped: true })).rejects.toThrow(
        "database sidecar exists"
      );
    }
  );

  it("rejects a WAL-backed source before a raw copy can omit uncheckpointed commits", async () => {
    const source = createHealthyDatabase();
    const destination = createHealthyDatabase();
    insertActor(destination, "destination-only");
    const sourceWriter = new DatabaseSync(source);
    sourceWriter.exec("PRAGMA journal_mode = WAL");
    sourceWriter.exec("PRAGMA wal_autocheckpoint = 0");
    sourceWriter
      .prepare(
        `INSERT INTO actors (id, actor_type, display_name, external_ref, created_at)
         VALUES ('source-uncheckpointed', 'SYSTEM', 'source-uncheckpointed', NULL, '2026-07-19T00:00:00.000Z')`
      )
      .run();

    try {
      await expect(restoreControlPlaneDatabase(source, destination, { writersStopped: true })).rejects.toThrow(
        "database sidecar exists"
      );
      expect(readActorIds(destination)).toContain("destination-only");
    } finally {
      sourceWriter.close();
    }
  });

  it("requires the stopped-writers acknowledgement at the db-ops CLI boundary", async () => {
    const source = createHealthyDatabase();
    const destination = createHealthyDatabase();
    insertActor(source, "source-only");
    insertActor(destination, "destination-only");

    const result = await runDbOps(["restore", source, destination, "--replace"]);

    expect(result.exitCode).toBe(2);
    expect(readActorIds(destination)).toContain("destination-only");
  });

  it("routes an acknowledged db-ops restore through the atomic restore primitive", async () => {
    const source = createHealthyDatabase();
    const destination = createHealthyDatabase();
    insertActor(source, "source-only");
    insertActor(destination, "destination-only");

    const result = await runDbOps(["restore", source, destination, "--replace", "--writers-stopped"]);

    expect(result.exitCode).toBe(0);
    expect(readActorIds(destination)).toContain("source-only");
    expect(readActorIds(destination)).not.toContain("destination-only");
  });

  function createHealthyDatabase(): string {
    const path = join(temporaryDirectory(), "control.db");
    withDatabase(path, (db) => {
      db.exec("PRAGMA foreign_keys = ON");
      applyControlPlaneMigrations(db);
    });
    return path;
  }

  function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "acs-database-health-"));
    temporaryDirectories.push(directory);
    return directory;
  }
});

function insertActor(path: string, id: string): void {
  withDatabase(path, (db) => {
    db.prepare(
      `INSERT INTO actors (id, actor_type, display_name, external_ref, created_at)
       VALUES (?, 'SYSTEM', ?, NULL, '2026-07-19T00:00:00.000Z')`
    ).run(id, id);
  });
}

function readActorIds(path: string): string[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare(`SELECT id FROM actors ORDER BY id`).all() as Array<{ id: string }>).map((row) => row.id);
  } finally {
    db.close();
  }
}

function restoreTemporaryFiles(destination: string): string[] {
  const prefix = `${basename(destination)}.restore-`;
  return readdirSync(dirname(destination)).filter((name) => name.startsWith(prefix));
}

const execFileAsync = promisify(execFile);

async function runDbOps(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, [join(process.cwd(), "scripts/db-ops.mjs"), ...args], {
      cwd: process.cwd()
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message
    };
  }
}

function withDatabase(path: string, operation: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path);
  try {
    operation(db);
  } finally {
    db.close();
  }
}

function auditFixture(sequence: number, previousHash: string) {
  const event = {
    sequence,
    id: `evt_${sequence}`,
    name: "test.event",
    timeUnixNano: String(1_000_000_000 + sequence),
    attributes: {},
    body: { sequence },
    previousHash
  };
  return { ...event, eventHash: auditEventHash(event) };
}

function insertAuditEvent(db: DatabaseSync, event: ReturnType<typeof auditFixture>): void {
  db.prepare(
    `INSERT INTO audit_events
     (sequence, id, name, time_unix_nano, attributes, body, previous_hash, event_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event.sequence,
    event.id,
    event.name,
    event.timeUnixNano,
    JSON.stringify(event.attributes),
    JSON.stringify(event.body),
    event.previousHash,
    event.eventHash
  );
}
