#!/usr/bin/env node
// Timestamped snapshot (latest.db only after integrity_check) + restore dry-run +
// sample fixture + WAL checkpoint / VACUUM for docs/runbooks/sqlite-backup-restore.md
import {
  applyControlPlaneMigrations,
  backupControlPlaneDatabase,
  restoreControlPlaneDatabase,
  verifyControlPlaneDatabaseFile
} from "@agent-control-stack/shared";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const WAL_CHECKPOINT_MODES = new Set(["PASSIVE", "FULL", "RESTART", "TRUNCATE"]);
const LATEST_NAME = "latest.db";

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
    const latestPath = join(destinationDir, LATEST_NAME);
    const previousLatest = readLatestPointer(latestPath);
    try {
      const result = await backupControlPlaneDatabase(source, destination);
      // Retain gate: refuse to replace latest unless the artifact passes integrity_check
      // (and foreign_key_check via the shared health contract) after the snapshot copy.
      let retainHealth;
      try {
        retainHealth = verifyControlPlaneDatabaseFile(destination);
      } catch (verifyError) {
        removeFileQuiet(destination);
        const detail = verifyError instanceof Error ? verifyError.message : String(verifyError);
        throw new Error(`backup retain refused after integrity_check: ${detail}`, { cause: verifyError });
      }
      publishLatestPointer(destinationDir, destination);
      report({
        ok: true,
        operation: "snapshot",
        ...result,
        destinationDir,
        latest: latestPath,
        previousLatest,
        retainHealth
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report({
        ok: false,
        operation: "snapshot",
        error: message,
        destinationDir,
        latest: latestPointerPresent(latestPath) ? latestPath : null,
        previousLatest,
        note: "Previous good latest pointer left in place; corrupt or unverified artifact was not retained as latest."
      });
      process.exitCode = 1;
    }
  } else if (command === "restore-dry-run" && primaryArg) {
    const backupPath = resolve(primaryArg);
    const into = optionalFlag(rest, "--into");
    const temporaryRoot = into ? null : mkdtempSync(join(tmpdir(), "acs-restore-dry-run-"));
    const destination = resolve(into ?? join(temporaryRoot, "restored.db"));
    if (into) {
      // The dry-run must stay a rehearsal: refuse --into targets that resolve to
      // the live control-plane database instead of silently replacing it.
      assertNotLiveControlPlaneDatabase(destination);
      mkdirSync(dirname(destination), { recursive: true });
    }
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
          ? "Restored to --into path only; the live ACS_DB_PATH control-plane database was not used as the destination."
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
    // PASSIVE is allowed with live writers by design; FULL/RESTART/TRUNCATE need a
    // quiet window, so fail closed like `vacuum` when a writer still holds the DB.
    if (mode !== "PASSIVE") {
      assertNoActiveWriter(database);
    }
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

// Restore dry-runs are rehearsals: they must never replace the live
// control-plane database. Real replacement belongs to db-ops restore with its
// explicit --replace and --writers-stopped attestations.
function liveControlPlaneDatabasePaths() {
  const paths = new Set();
  const configured = process.env.ACS_DB_PATH;
  if (configured && configured.trim() !== "") paths.add(resolve(configured.trim()));
  paths.add(resolve("storage/local.db"));
  return paths;
}

function assertNotLiveControlPlaneDatabase(destination) {
  const resolved = canonicalPath(destination);
  for (const livePath of liveControlPlaneDatabasePaths()) {
    const canonicalLive = canonicalPath(livePath);
    if (resolved === canonicalLive) {
      throw new Error(
        `restore-dry-run --into refuses to overwrite the live control-plane database: ${canonicalLive} ` +
          "(rehearse into a scratch path, or use db-ops.mjs restore with --replace --writers-stopped to replace it deliberately)"
      );
    }
  }
}

// Canonicalize through symlinks so an alias cannot sneak a --into destination
// past the live-database guard; fall back to the lexical path when the file or
// one of its parents does not exist yet.
function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
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
    throw new Error(`active database writer or lock prevents the operation: ${destination}`, { cause: error });
  } finally {
    db.close();
  }
}

function readLatestPointer(latestPath) {
  try {
    if (!existsSync(latestPath) && !isSymlink(latestPath)) return null;
    if (isSymlink(latestPath)) {
      return resolve(dirname(latestPath), readlinkSync(latestPath));
    }
    return resolve(latestPath);
  } catch {
    return null;
  }
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function latestPointerPresent(latestPath) {
  return existsSync(latestPath) || isSymlink(latestPath);
}

function publishLatestPointer(destinationDir, artifactPath) {
  const latestPath = join(destinationDir, LATEST_NAME);
  const targetName = basename(artifactPath);
  if (dirname(resolve(artifactPath)) !== resolve(destinationDir)) {
    throw new Error(`backup artifact must live in destination dir to publish latest: ${artifactPath}`);
  }
  const temporary = join(destinationDir, `.${LATEST_NAME}.${process.pid}.tmp`);
  removeFileQuiet(temporary);
  try {
    symlinkSync(targetName, temporary);
    renameSync(temporary, latestPath);
  } catch (error) {
    removeFileQuiet(temporary);
    throw new Error(`failed to publish latest backup pointer: ${latestPath}`, { cause: error });
  }
}

function removeFileQuiet(path) {
  try {
    unlinkSync(path);
  } catch {
    // Best-effort cleanup must not mask the primary failure.
  }
}

function report(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function usage() {
  process.stderr.write(
    "usage: sqlite-backup-restore.mjs create-fixture <path> | " +
      "snapshot <db> [--destination-dir <dir>] (updates latest.db only after integrity_check) | " +
      "restore-dry-run <backup> [--into <path>] | " +
      "verify <db> | " +
      "wal-checkpoint <db> [--mode PASSIVE|FULL|RESTART|TRUNCATE] | " +
      "vacuum <db> --writers-stopped\n"
  );
  process.exitCode = 2;
}
