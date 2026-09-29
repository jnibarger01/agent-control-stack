#!/usr/bin/env node
// Timestamped snapshot (latest.db only after integrity_check) + restore dry-run +
// sample fixture + WAL checkpoint / VACUUM for docs/runbooks/sqlite-backup-restore.md
import {
  applyControlPlaneMigrations,
  backupControlPlaneDatabase,
  restoreControlPlaneDatabase,
  verifyControlPlaneDatabaseFile
} from "@agent-control-stack/shared";
import { parseConfigText } from "@agent-control-stack/machine-controller";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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
      // A kept dry-run is rehearsal only. Require the stopped service's live
      // database identity explicitly, then cross-check service env/config aliases.
      // The guard runs before mkdir/copy so a missing live DB cannot be created here.
      const runtimeDir = resolveRuntimeDir(rest);
      const explicitLiveDatabase = optionalFlag(rest, "--live-db");
      assertNotLiveControlPlaneDatabase(destination, runtimeDir, explicitLiveDatabase);
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
          ? "Restored to --into path only; no configured live control-plane database was used as the destination."
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

// Return every absolute filesystem path that may name the live database. --live-db
// is mandatory for a kept rehearsal because a stopped service may have had an
// ACS_DB_PATH visible only to its service manager. Any ACS_DB_PATH/runtime config
// visible here is treated as an additional alias to protect.
//
// Relative live paths and relative runtime-config paths are resolved against the
// runtime's own working directory, never against this command's cwd. When a relative
// value cannot be anchored, --into is refused instead of being compared against a guess.
function liveControlPlaneDatabasePaths(runtimeDir, explicitLiveDatabase) {
  if (typeof explicitLiveDatabase !== "string" || explicitLiveDatabase.trim() === "") {
    throw new Error(
      "restore-dry-run --into refused: --live-db <path> is required to identify the stopped service's authoritative live database"
    );
  }

  const paths = new Set();
  const explicit = anchorLivePath(explicitLiveDatabase, runtimeDir, "--live-db");
  if (explicit === null) {
    throw new Error("restore-dry-run --into refused: --live-db must identify a filesystem database");
  }
  paths.add(explicit);

  const configured = process.env.ACS_DB_PATH;
  if (typeof configured === "string" && configured !== "") {
    const variants = [configured];
    if (configured.trim() !== "" && configured.trim() !== configured) variants.push(configured.trim());
    for (const variant of variants) {
      const anchored = anchorLivePath(variant, runtimeDir, "ACS_DB_PATH");
      if (anchored !== null) paths.add(anchored);
    }
  }

  const configPath = resolveRuntimeConfigPath(runtimeDir);
  if (configPath !== null && existsSync(configPath)) {
    const parsed = parseConfigText(readFileSync(configPath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`cannot determine live database from invalid runtime config: ${configPath}`);
    }
    const runtime = parsed.runtime;
    if (runtime !== undefined) {
      if (runtime === null || typeof runtime !== "object" || Array.isArray(runtime)) {
        throw new Error(`cannot determine live database from invalid runtime config: ${configPath}`);
      }
      const dbPath = runtime.db_path;
      if (dbPath !== undefined) {
        if (typeof dbPath !== "string" || dbPath.trim() === "") {
          throw new Error(`cannot determine live database from invalid runtime.db_path: ${configPath}`);
        }
        const anchored = anchorLivePath(dbPath, runtimeDir, `runtime.db_path in ${configPath}`);
        if (anchored !== null) paths.add(anchored);
      }
    }
  }

  // Defense in depth for the managed runtime default when its working directory is
  // known. --live-db remains mandatory because a stopped standalone service can have
  // service-local ACS_DB_PATH state that is absent from the later operator shell.
  if (runtimeDir !== null) {
    const defaultAnchored = anchorLivePath("storage/local.db", runtimeDir, "default live database path");
    if (defaultAnchored !== null) paths.add(defaultAnchored);
  }
  return paths;
}

function resolveRuntimeConfigPath(runtimeDir) {
  const configured = process.env.ACS_RUNTIME_CONFIG?.trim();
  if (configured) {
    if (isAbsolute(configured)) return resolve(configured);
    if (runtimeDir === null) {
      throw new Error(
        "restore-dry-run --into refused: ACS_RUNTIME_CONFIG is relative and the runtime working directory is unknown " +
          "(pass --runtime-dir <dir> or set ACS_RUNTIME_DIR)"
      );
    }
    return resolve(runtimeDir, configured);
  }
  return runtimeDir === null ? null : resolve(runtimeDir, "acs.config.yaml");
}

// Resolve one configured live database value to an absolute filesystem path, or null
// when it cannot name a file on disk (e.g. :memory:). SQLite file: URIs are parsed to
// the path the runtime actually opens. Relative values are anchored to the runtime's
// working directory; without one, --into is refused (fail closed).
function anchorLivePath(value, runtimeDir, origin) {
  const filesystemPath = sqliteFileUriToPath(value, origin);
  if (filesystemPath === ":memory:") return null;
  if (isAbsolute(filesystemPath)) return resolve(filesystemPath);
  if (runtimeDir === null) {
    throw new Error(
      "restore-dry-run --into refused: cannot locate the live control-plane database: " +
        `${origin} is relative ("${value}") and the runtime working directory is unknown ` +
        "(pass --runtime-dir <dir> or set ACS_RUNTIME_DIR to the runtime's working directory)"
    );
  }
  return resolve(runtimeDir, filesystemPath);
}

// Parse a SQLite file: URI (file:/var/lib/acs/control.db,
// file:///var/lib/acs/control.db?mode=ro) to the filesystem path the runtime opens
// when it passes the value verbatim to the database driver. Values without a file:
// scheme pass through unchanged. URIs that cannot be mapped to a local filesystem
// path refuse --into instead of being compared lexically, which would never match
// the real database file.
function sqliteFileUriToPath(value, origin) {
  const match = /^file:(.*)$/is.exec(value);
  if (!match) return value;
  let decoded;
  try {
    decoded = decodeURIComponent(match[1].split(/[?#]/, 1)[0]);
  } catch {
    throw new Error(
      `restore-dry-run --into refused: cannot parse SQLite file URI in ${origin}: ` +
        `"${value}" (invalid percent-encoding)`
    );
  }
  if (decoded.startsWith("//")) {
    const withoutSlashes = decoded.slice(2);
    const slash = withoutSlashes.indexOf("/");
    const host = slash < 0 ? withoutSlashes : withoutSlashes.slice(0, slash);
    const pathPart = slash < 0 ? "" : withoutSlashes.slice(slash);
    if (host !== "" && host.toLowerCase() !== "localhost") {
      throw new Error(
        `restore-dry-run --into refused: cannot parse SQLite file URI in ${origin}: ` +
          `"${value}" (remote host "${host}" has no local filesystem path)`
      );
    }
    return pathPart === "" ? "/" : pathPart;
  }
  return decoded;
}

// The runtime's working directory is the only authoritative anchor for relative live
// database paths. It comes from --runtime-dir (preferred) or ACS_RUNTIME_DIR.
function resolveRuntimeDir(args) {
  const fromFlag = optionalFlag(args, "--runtime-dir");
  const raw = fromFlag ?? process.env.ACS_RUNTIME_DIR;
  if (raw === undefined || raw.trim() === "") return null;
  const absolute = resolve(raw);
  let stat;
  try {
    stat = statSync(absolute);
  } catch {
    throw new Error(
      "restore-dry-run --into refused: runtime directory does not exist: " +
        `${absolute} (pass --runtime-dir <dir> or set ACS_RUNTIME_DIR to the runtime's working directory)`
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(`restore-dry-run --into refused: runtime directory is not a directory: ${absolute}`);
  }
  return absolute;
}

function assertNotLiveControlPlaneDatabase(destination, runtimeDir, explicitLiveDatabase) {
  const canonicalDestination = canonicalPath(destination);
  for (const livePath of liveControlPlaneDatabasePaths(runtimeDir, explicitLiveDatabase)) {
    const canonicalLive = canonicalPath(livePath);
    if (canonicalDestination === canonicalLive || sameFilesystemPathIdentity(destination, livePath)) {
      throw new Error(
        `restore-dry-run --into refuses to overwrite the live control-plane database: ${canonicalLive} ` +
          "(rehearse into a scratch path, or use db-ops.mjs restore with --replace --writers-stopped to replace it deliberately)"
      );
    }
  }
}

// Resolve symlinks in the deepest existing ancestor, then append missing path
// components. This protects a live path that does not exist yet but is reachable
// through a symlinked directory. Resolution errors fail closed.
function canonicalPath(path) {
  const identity = filesystemPathIdentity(path);
  return resolve(identity.realPath, ...identity.missing);
}

// Canonical strings do not collapse bind mounts or hard links. Compare the deepest
// existing filesystem object's device/inode plus the same remaining missing suffix.
// That protects a not-yet-created live leaf reached through a bind-mount alias too.
function sameFilesystemPathIdentity(left, right) {
  const a = filesystemPathIdentity(left);
  const b = filesystemPathIdentity(right);
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.missing.length === b.missing.length &&
    a.missing.every((component, index) => component === b.missing[index])
  );
}

function filesystemPathIdentity(path) {
  const absolute = resolve(path);
  let existing = absolute;
  const missing = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(basename(existing));
    existing = parent;
  }
  const realPath = realpathSync(existing);
  const stat = statSync(realPath);
  return { realPath, dev: stat.dev, ino: stat.ino, missing };
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
      "restore-dry-run <backup> [--into <path> --live-db <path>] [--runtime-dir <dir>] | " +
      "verify <db> | " +
      "wal-checkpoint <db> [--mode PASSIVE|FULL|RESTART|TRUNCATE] | " +
      "vacuum <db> --writers-stopped\n"
  );
  process.exitCode = 2;
}
