import { DatabaseSync } from "node:sqlite";
import { statfsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { verifyAuditChain, type AuditChainEvent } from "./audit-chain.js";
import { controlPlaneMigrations } from "./migration.js";

export type DatabaseHealthCheck = { ok: true } | { ok: false; code: string };

export interface DatabaseStoragePolicy {
  /** Warn/read-only threshold. Defaults to 256 MiB. */
  warnFreeBytes?: number;
  /** Admission rejection threshold. Defaults to 64 MiB. */
  rejectFreeBytes?: number;
  /** Space at which a rejected store may recover. Defaults to 2x rejectFreeBytes. */
  recoveryFreeBytes?: number;
  /** WAL size at which writers attempt a passive checkpoint. Defaults to 64 MiB. */
  walCheckpointBytes?: number;
  /** WAL size that makes mutation admission fail closed. Defaults to 256 MiB. */
  walRejectBytes?: number;
}

export interface DatabaseStorageDiagnostics {
  freeBytes: number;
  walBytes: number;
  walGrowthBytes: number;
  mode: "normal" | "warning" | "read_only";
}

export type DatabaseStorageHealth = DatabaseHealthCheck & {
  diagnostics?: DatabaseStorageDiagnostics;
};

export interface ControlPlaneDatabaseHealth {
  ok: boolean;
  checks: {
    integrity: DatabaseHealthCheck;
    foreignKeys: DatabaseHealthCheck;
    migrations: DatabaseHealthCheck;
    auditChain: DatabaseHealthCheck;
    storage?: DatabaseStorageHealth;
  };
}

const mib = 1024 * 1024;

export function inspectDatabaseStorage(
  databasePath: string,
  policy: DatabaseStoragePolicy = {},
  previousMode: DatabaseStorageDiagnostics["mode"] = "normal"
): DatabaseStorageHealth {
  const warn = policy.warnFreeBytes ?? 256 * mib;
  const reject = policy.rejectFreeBytes ?? 64 * mib;
  const recovery = policy.recoveryFreeBytes ?? Math.max(warn, reject * 2);
  const walCheckpoint = policy.walCheckpointBytes ?? 64 * mib;
  const walReject = policy.walRejectBytes ?? 256 * mib;
  try {
    const stats = statfsSync(dirname(databasePath));
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const walBytes = readSidecarBytes(`${databasePath}-wal`);
    const recovered = previousMode === "read_only" && freeBytes >= recovery;
    const mode = recovered
      ? freeBytes <= warn || walBytes >= walCheckpoint
        ? "warning"
        : "normal"
      : freeBytes <= reject || walBytes >= walReject
        ? "read_only"
        : freeBytes <= warn || walBytes >= walCheckpoint
          ? "warning"
          : "normal";
    const diagnostics: DatabaseStorageDiagnostics = { freeBytes, walBytes, walGrowthBytes: 0, mode };
    return mode === "read_only"
      ? { ok: false, code: freeBytes <= reject ? "disk_space_low" : "wal_growth_excessive", diagnostics }
      : { ok: true, diagnostics };
  } catch {
    return { ok: false, code: "storage_probe_failed" };
  }
}

function readSidecarBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

interface AuditEventRow {
  sequence: number;
  id: string;
  name: string;
  time_unix_nano: string;
  attributes: string;
  body: string;
  previous_hash: string;
  event_hash: string;
}

export function inspectControlPlaneDatabase(db: DatabaseSync): ControlPlaneDatabaseHealth {
  const checks = {
    integrity: integrityHealth(db),
    foreignKeys: foreignKeyHealth(db),
    migrations: migrationHealth(db),
    auditChain: auditChainHealth(db)
  };
  return { ok: Object.values(checks).every((check) => check.ok), checks };
}

export function inspectControlPlaneDatabaseFile(path: string): ControlPlaneDatabaseHealth {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    return failedDatabaseHealth("db_open_failed");
  }
  try {
    return inspectControlPlaneDatabase(db);
  } finally {
    db.close();
  }
}

function integrityHealth(db: DatabaseSync): DatabaseHealthCheck {
  try {
    const rows = db.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
    if (rows.length === 0 || rows.some((row) => Object.values(row)[0] !== "ok")) {
      return failed("integrity_check_failed");
    }
    return healthy();
  } catch {
    return failed("integrity_probe_failed");
  }
}

function foreignKeyHealth(db: DatabaseSync): DatabaseHealthCheck {
  try {
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    return violations.length === 0 ? healthy() : failed("foreign_key_violation");
  } catch {
    return failed("foreign_key_probe_failed");
  }
}

function migrationHealth(db: DatabaseSync): DatabaseHealthCheck {
  try {
    const expected = controlPlaneMigrations();
    const rows = db
      .prepare("SELECT version, name, filename, checksum FROM schema_migrations ORDER BY version ASC")
      .all() as Array<{ version: number; name: string; filename: string; checksum: string }>;
    if (rows.length !== expected.length) {
      return failed(rows.length < expected.length ? "migration_missing" : "migration_mismatch");
    }
    for (let index = 0; index < expected.length; index += 1) {
      const actual = rows[index];
      const migration = expected[index];
      if (
        !actual ||
        !migration ||
        actual.version !== migration.version ||
        actual.name !== migration.name ||
        actual.filename !== migration.filename ||
        actual.checksum !== migration.checksum
      ) {
        return failed("migration_mismatch");
      }
    }
    return healthy();
  } catch {
    return failed("migration_probe_failed");
  }
}

function auditChainHealth(db: DatabaseSync): DatabaseHealthCheck {
  try {
    const rows = db.prepare("SELECT * FROM audit_events ORDER BY sequence ASC").all() as unknown as AuditEventRow[];
    const verification = verifyAuditChain(rows.map(rowToAuditEvent));
    return verification.ok ? healthy() : failed(`audit_chain_${verification.failure.reason}`);
  } catch {
    return failed("audit_chain_probe_failed");
  }
}

function rowToAuditEvent(row: AuditEventRow): AuditChainEvent {
  return {
    sequence: row.sequence,
    id: row.id,
    name: row.name,
    timeUnixNano: row.time_unix_nano,
    attributes: JSON.parse(row.attributes) as AuditChainEvent["attributes"],
    body: JSON.parse(row.body) as AuditChainEvent["body"],
    previousHash: row.previous_hash,
    eventHash: row.event_hash
  };
}

function failedDatabaseHealth(code: string): ControlPlaneDatabaseHealth {
  return {
    ok: false,
    checks: {
      integrity: failed(code),
      foreignKeys: failed(code),
      migrations: failed(code),
      auditChain: failed(code)
    }
  };
}

function healthy(): DatabaseHealthCheck {
  return { ok: true };
}

function failed(code: string): DatabaseHealthCheck {
  return { ok: false, code };
}
