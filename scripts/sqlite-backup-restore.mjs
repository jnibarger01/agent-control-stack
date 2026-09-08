#!/usr/bin/env node
// Timestamped snapshot + restore dry-run + sample fixture for docs/runbooks/sqlite-backup-restore.md
import {
  applyControlPlaneMigrations,
  backupControlPlaneDatabase,
  restoreControlPlaneDatabase,
  verifyControlPlaneDatabaseFile
} from "@agent-control-stack/shared";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

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

function report(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function usage() {
  process.stderr.write(
    "usage: sqlite-backup-restore.mjs create-fixture <path> | " +
      "snapshot <db> [--destination-dir <dir>] | " +
      "restore-dry-run <backup> [--into <path>] | " +
      "verify <db>\n"
  );
  process.exitCode = 2;
}
