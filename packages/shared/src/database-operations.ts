import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  statSync
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { inspectControlPlaneDatabaseFile, type ControlPlaneDatabaseHealth } from "./database-health.js";

export interface DatabaseBackupResult {
  source: string;
  destination: string;
  health: ControlPlaneDatabaseHealth;
}

export interface DatabaseRestoreOptions {
  writersStopped: boolean;
  beforeRename?: (temporaryPath: string) => void | Promise<void>;
}

export interface DatabaseRestoreResult {
  source: string;
  destination: string;
  safetyBackup?: string;
  health: ControlPlaneDatabaseHealth;
}

export function verifyControlPlaneDatabaseFile(path: string): ControlPlaneDatabaseHealth {
  const health = inspectControlPlaneDatabaseFile(path);
  if (!health.ok) {
    throw new Error(`database health check failed: ${databaseHealthFailureCodes(health).join(",")}`);
  }
  return health;
}

export async function backupControlPlaneDatabase(
  sourcePath: string,
  destinationPath: string
): Promise<DatabaseBackupResult> {
  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  assertDifferentFiles(source, destination, "backup");
  if (existsSync(destination)) throw new Error(`backup destination already exists: ${destination}`);
  verifyControlPlaneDatabaseFile(source);

  const db = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(db, destination);
    chmodSync(destination, 0o600);
    const health = verifyControlPlaneDatabaseFile(destination);
    return { source, destination, health };
  } catch (error) {
    removeTemporaryFile(destination);
    throw error;
  } finally {
    db.close();
  }
}

export async function restoreControlPlaneDatabase(
  sourcePath: string,
  destinationPath: string,
  options: DatabaseRestoreOptions
): Promise<DatabaseRestoreResult> {
  if (options.writersStopped !== true) {
    throw new Error("all database writers must be stopped before restore");
  }

  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  assertDifferentFiles(source, destination, "restore");
  assertNoDatabaseSidecars(source);
  verifyControlPlaneDatabaseFile(source);
  assertNoDatabaseSidecars(source);
  const destinationExists = existsSync(destination);
  let safetyBackup: string | undefined;

  if (destinationExists) {
    assertNoDatabaseSidecars(destination);
    assertNoActiveWriter(destination);
    assertNoDatabaseSidecars(destination);
    safetyBackup = await createSafetyBackup(destination);
  }

  const temporary = `${destination}.restore-${process.pid}-${randomUUID()}.tmp`;
  let renamed = false;
  try {
    copyFileSync(source, temporary, fsConstants.COPYFILE_EXCL);
    chmodSync(temporary, 0o600);
    await options.beforeRename?.(temporary);
    assertNoDatabaseSidecars(source);
    const health = verifyControlPlaneDatabaseFile(temporary);
    syncFile(temporary);
    renameSync(temporary, destination);
    renamed = true;
    syncDirectory(dirname(destination));
    return {
      source,
      destination,
      ...(safetyBackup ? { safetyBackup } : {}),
      health
    };
  } finally {
    if (!renamed) removeTemporaryFile(temporary);
  }
}

async function createSafetyBackup(destination: string): Promise<string> {
  const safetyBackup = `${destination}.pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const db = new DatabaseSync(destination, { readOnly: true });
  try {
    await backup(db, safetyBackup);
    chmodSync(safetyBackup, 0o600);
    syncFile(safetyBackup);
    syncDirectory(dirname(safetyBackup));
    return safetyBackup;
  } catch (error) {
    removeTemporaryFile(safetyBackup);
    throw error;
  } finally {
    db.close();
  }
}

function assertDifferentFiles(source: string, destination: string, operation: string): void {
  if (source === destination) throw new Error(`${operation} source and destination must differ`);
  if (!existsSync(source) || !existsSync(destination)) return;
  const sourceStat = statSync(source);
  const destinationStat = statSync(destination);
  if (sourceStat.dev === destinationStat.dev && sourceStat.ino === destinationStat.ino) {
    throw new Error(`${operation} source and destination must differ`);
  }
}

function assertNoDatabaseSidecars(destination: string): void {
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    const sidecar = `${destination}${suffix}`;
    if (existsSync(sidecar)) {
      throw new Error(`database sidecar exists; stop all writers and checkpoint before restore: ${sidecar}`);
    }
  }
}

function assertNoActiveWriter(destination: string): void {
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
    throw new Error(`active database writer or lock prevents restore: ${destination}`, { cause: error });
  } finally {
    db.close();
  }
}

function syncFile(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(path: string): void {
  let descriptor: number;
  try {
    descriptor = openSync(path, "r");
  } catch (error) {
    if (isUnsupportedDirectorySync(error)) return;
    throw error;
  }
  try {
    try {
      fsyncSync(descriptor);
    } catch (error) {
      if (!isUnsupportedDirectorySync(error)) throw error;
    }
  } finally {
    closeSync(descriptor);
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return hasErrorCode(error) && ["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(error.code);
}

function hasErrorCode(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}

function removeTemporaryFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Cleanup must not mask the primary verification or restore failure.
  }
}

function databaseHealthFailureCodes(health: ControlPlaneDatabaseHealth): string[] {
  return Object.values(health.checks).flatMap((check) => (check.ok ? [] : [check.code]));
}
