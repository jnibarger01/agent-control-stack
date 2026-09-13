#!/usr/bin/env node
// Timestamped snapshot + restore dry-run + sample fixture + WAL checkpoint / VACUUM
// for docs/runbooks/sqlite-backup-restore.md
import {
  applyControlPlaneMigrations,
  backupControlPlaneDatabase,
  restoreControlPlaneDatabase,
  verifyControlPlaneDatabaseFile
} from "@agent-control-stack/shared";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const WAL_CHECKPOINT_MODES = new Set(["PASSIVE", "FULL", "RESTART", "TRUNCATE"]);

const [command, primaryArg, ...rest] = process.argv.slice(2);

try {
  if (command === "create-fixture" && primaryArg) {
    const path = resolve(primaryArg);
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      applyControlPlaneMigrations(db);
      db.prepare(
        `INSERT INTO actors (id, actor_type, display_name, external_ref, created_at)
         VALUES (?, 'SYSTEM', ?, NULL, ?)`
      ).run("fixture-operator", "fixture-operator", "2026-09-08T00:00:00.000Z");
    } finally {
      db.close();
    }
    const health = verifyControlPlaneDatabaseFile(path);
    report({ ok: true, operation: "create-fixture", database: path, health });
  } else if (command === "snapshot" && primaryArg) {
    const source = resolve(primaryArg);
    const destinationDir = resolve(optionalFlag(rest, "--destination-dir") ?? join(dirname(source), "backups"));
    mkdirSync(destinationDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = join(destinationDir, `${basename(source, ".db")}-${stamp}.db`);
    const result = await backupControlPlaneDatabase(source, destination);
    report({ ok: true, operation: "snapshot", ...result, destinationDir });
  } else if (command === "restore-dry-run" && primaryArg) {
    const backupPath = resolve(primaryArg);
    const into = optionalFlag(rest, "--into");
    const temporaryRoot = into ? null : mkdtempSync(join(tmpdir(), "acs-restore-dry-run-"));
    const destination = resolve(into ?? join(temporaryRoot, "restored.db"));
    if (into) mkdirSync(dirname(destination), { recursive: true });
    try {
      const healthBefore = verifyControlPlaneDatabaseFile(backupPath);
      const result = await restoreControlPlaneDatabase(backupPath, destination, { writersStopped: true });
      report({
        ok: true,
        operation: "restore-dry-run",
        backup: backupPath,
        restoredTo: destination,
        replacedLiveDatabase: false,
        healthBefore,
        health: result.health,
        safetyBackup: result.safetyBackup ?? null,
        note: into
          ? "Restored to --into path only; live ACS_DB_PATH was not touched."
          : "Restored into a temporary directory; cleaned up after verification."
      });
    } finally {
      if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
    }
  } else if (command === "verify" && primaryArg) {
    const database = resolve(primaryArg);
    const health = verifyControlPlaneDatabaseFile(database);
    report({ ok: true, operation: "verify", database, health });
  } else if (command === "wal-checkpoint" && primaryArg) {
    const database = resolve(primaryArg);
    const modeRaw = optionalFlag(rest, "--mode") ?? "TRUNCATE";
    const mode = modeRaw.toUpperCase();
    if (!WAL_CHECKPOINT_MODES.has(mode)) {
      throw new Error(`unsupported wal-checkpoint mode: ${modeRaw} (use PASSIVE|FULL|RESTART|TRUNCATE)`);
    }
    if (!existsSync(database)) throw new Error(`database not found: ${database}`);
    const sizeBefore = sidecarSizes(database);
    const db = new DatabaseSync(database);
    let checkpoint;
    try {
      checkpoint = db.prepare(`PRAGMA wal_checkpoint(${mode})`).get();
    } finally {
      db.close();
    }
    const health = verifyControlPlaneDatabaseFile(database);
    report({
      ok: true,
      operation: "wal-checkpoint",
      database,
      mode,
      checkpoint,
      sizeBefore,
      sizeAfter: sidecarSizes(database),
      health,
      warning:
        mode === "PASSIVE"
          ? "PASSIVE may leave pages uncheckpointed while writers are active; prefer FULL/TRUNCATE in a quiet window."
          : "FULL/RESTART/TRUNCATE can stall or fail if gateway/worker still hold the WAL; stop writers for a guaranteed shrink."
    });
  } else if (command === "vacuum" && primaryArg) {
    const database = resolve(primaryArg);
    if (!rest.includes("--writers-stopped")) {
      throw new Error(
        "VACUUM requires --writers-stopped (stop every gateway, worker, and scheduler that opens this DB first)"
      );
    }
    if (!existsSync(database)) throw new Error(`database not found: ${database}`);
    assertNoActiveWriter(database);
    const healthBefore = verifyControlPlaneDatabaseFile(database);
    const sizeBefore = statSync(database).size;
    const db = new DatabaseSync(database);
    try {
      db.exec("PRAGMA busy_timeout = 0");
      // Checkpoint first so VACUUM sees a fully merged main file and can drop -wal/-shm.
      db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      db.exec("VACUUM");
    } finally {
      db.close();
    }
    chmodSync(database, 0o600);
    const health = verifyControlPlaneDatabaseFile(database);
    report({
      ok: true,
      operation: "vacuum",
      database,
      sizeBefore,
      sizeAfter: statSync(database).size,
      healthBefore,
      health,
      note: "VACUUM completed with writers attested stopped; audit chain re-verified."
    });
  } else {
    usage();
  }
} catch (error) {
  report({
    ok: false,
    operation: command ?? "unknown",
    error: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
}

function optionalFlag(args, name) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === undefined || value.startsWith("--")) return undefined;
  return value;
}

function sidecarSizes(database) {
  const sizes = { database: existsSync(database) ? statSync(database).size : 0 };
  for (const suffix of ["-wal", "-shm"]) {
    const path = `${database}${suffix}`;
    sizes[suffix.slice(1)] = existsSync(path) ? statSync(path).size : 0;
  }
  return sizes;
}

function assertNoActiveWriter(destination) {
  const db = new DatabaseSync(destination);
  let began = false;
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN EXCLUSIVE");
    began = true;
    db.exec("ROLLBACK");
    began = false;
  } catch (error) {
    if (began) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original lock error.
      }
    }
    throw new Error(`active database writer or lock prevents vacuum: ${destination}`, { cause: error });
  } finally {
    db.close();
  }
}

function report(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function usage() {
  process.stderr.write(
    "usage: sqlite-backup-restore.mjs create-fixture <path> | " +
      "snapshot <db> [--destination-dir <dir>] | " +
      "restore-dry-run <backup> [--into <path>] | " +
      "verify <db> | " +
      "wal-checkpoint <db> [--mode PASSIVE|FULL|RESTART|TRUNCATE] | " +
      "vacuum <db> --writers-stopped\n"
  );
  process.exitCode = 2;
}
