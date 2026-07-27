import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createManagedDatabaseBackup,
  latestManagedBackupManifest,
  readDatabaseBackupKey,
  runManagedDatabaseRestoreDrill,
  verifyManagedDatabaseBackup
} from "./database-backup-policy.js";
import { applyControlPlaneMigrations } from "./migration.js";

describe("managed database backup policy", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates a manifest-bound encrypted backup and verifies a populated database", async () => {
    const root = temporaryDirectory();
    const source = createPopulatedDatabase(root);
    const backups = join(root, "backups");
    const key = randomBytes(32);

    const result = await createManagedDatabaseBackup(source, backups, {
      encryptionKey: key,
      retentionCount: 3,
      now: new Date("2026-07-26T10:00:00.000Z"),
      backupId: "first"
    });
    const encrypted = readFileSync(result.artifactPath);
    const verified = await verifyManagedDatabaseBackup(result.manifestPath, key, root);

    expect(encrypted.subarray(0, 16).toString("utf8")).not.toContain("SQLite format 3");
    expect(result.manifest).toMatchObject({
      version: 1,
      backupId: "first",
      createdAt: "2026-07-26T10:00:00.000Z",
      sourceName: "control.db",
      artifactBytes: encrypted.length,
      encryption: { algorithm: "aes-256-gcm" },
      health: { ok: true },
      authentication: { algorithm: "hmac-sha256" }
    });
    expect(result.manifest.checksums.encryptedSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.manifest.checksums.plaintextSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(verified.health.ok).toBe(true);
    expect(temporaryFiles(backups)).toEqual([]);
  });

  it("rejects a corrupted encrypted copy and leaves no decrypted database", async () => {
    const root = temporaryDirectory();
    const source = createPopulatedDatabase(root);
    const backups = join(root, "backups");
    const key = randomBytes(32);
    const result = await createManagedDatabaseBackup(source, backups, {
      encryptionKey: key,
      retentionCount: 3,
      backupId: "corrupt"
    });
    const corrupted = readFileSync(result.artifactPath);
    corrupted[Math.floor(corrupted.length / 2)] ^= 0xff;
    writeFileSync(result.artifactPath, corrupted);

    await expect(verifyManagedDatabaseBackup(result.manifestPath, key, root)).rejects.toThrow(
      "encrypted backup checksum mismatch"
    );
    expect(readdirSync(root).filter((name) => name.startsWith("acs-backup-verify-"))).toEqual([]);
  });

  it("rejects tampered manifest metadata before using it for recovery objectives", async () => {
    const root = temporaryDirectory();
    const source = createPopulatedDatabase(root);
    const backups = join(root, "backups");
    const key = randomBytes(32);
    const result = await createManagedDatabaseBackup(source, backups, {
      encryptionKey: key,
      retentionCount: 3,
      backupId: "manifest-tamper"
    });
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8")) as { createdAt: string };
    manifest.createdAt = "2026-01-01T00:00:00.000Z";
    writeFileSync(result.manifestPath, JSON.stringify(manifest));

    await expect(verifyManagedDatabaseBackup(result.manifestPath, key, root)).rejects.toThrow(
      "backup manifest authentication failed"
    );
  });

  it("publishes neither artifact nor manifest when atomic publication is interrupted", async () => {
    const root = temporaryDirectory();
    const source = createPopulatedDatabase(root);
    const backups = join(root, "backups");

    await expect(
      createManagedDatabaseBackup(source, backups, {
        encryptionKey: randomBytes(32),
        retentionCount: 3,
        backupId: "interrupted",
        beforePublish: () => {
          throw new Error("simulated interruption");
        }
      })
    ).rejects.toThrow("simulated interruption");

    expect(readdirSync(backups)).toEqual([]);
  });

  it("enforces retention only after a new backup is verified and published", async () => {
    const root = temporaryDirectory();
    const source = createPopulatedDatabase(root);
    const backups = join(root, "backups");
    const key = randomBytes(32);

    for (const [day, backupId] of [
      [1, "one"],
      [2, "two"],
      [3, "three"]
    ] as const) {
      await createManagedDatabaseBackup(source, backups, {
        encryptionKey: key,
        retentionCount: 2,
        now: new Date(`2026-07-0${day}T00:00:00.000Z`),
        backupId
      });
    }

    const manifests = readdirSync(backups).filter((name) => name.endsWith(".manifest.json"));
    const artifacts = readdirSync(backups).filter((name) => name.endsWith(".acsdb"));
    expect(manifests).toHaveLength(2);
    expect(artifacts).toHaveLength(2);
    expect(manifests.some((name) => name.includes("-one."))).toBe(false);
    expect(latestManagedBackupManifest(backups)).toContain("-three.");
  });

  it("proves an isolated restore is ready and reports RPO and RTO targets", async () => {
    const root = temporaryDirectory();
    const source = createPopulatedDatabase(root);
    const backups = join(root, "backups");
    const key = randomBytes(32);
    const createdAt = new Date("2026-07-26T10:00:00.000Z");
    const result = await createManagedDatabaseBackup(source, backups, {
      encryptionKey: key,
      retentionCount: 3,
      now: createdAt,
      backupId: "drill"
    });

    const drill = await runManagedDatabaseRestoreDrill(result.manifestPath, {
      encryptionKey: key,
      maximumBackupAgeMs: 2 * 60 * 60 * 1_000,
      maximumRestoreDurationMs: 60_000,
      now: new Date("2026-07-26T11:00:00.000Z"),
      temporaryRoot: root
    });

    expect(drill).toMatchObject({
      backupId: "drill",
      backupAgeMs: 60 * 60 * 1_000,
      rpoWithinTarget: true,
      rtoWithinTarget: true,
      readiness: { ok: true }
    });
    expect(drill.restoreDurationMs).toBeGreaterThanOrEqual(0);
    expect(readdirSync(root).filter((name) => name.startsWith("acs-restore-drill-"))).toEqual([]);
  });

  it("reports an RPO breach without treating a valid restore as corrupt", async () => {
    const root = temporaryDirectory();
    const source = createPopulatedDatabase(root);
    const backups = join(root, "backups");
    const key = randomBytes(32);
    const result = await createManagedDatabaseBackup(source, backups, {
      encryptionKey: key,
      retentionCount: 3,
      now: new Date("2026-07-24T10:00:00.000Z"),
      backupId: "stale"
    });

    const drill = await runManagedDatabaseRestoreDrill(result.manifestPath, {
      encryptionKey: key,
      maximumBackupAgeMs: 24 * 60 * 60 * 1_000,
      maximumRestoreDurationMs: 60_000,
      now: new Date("2026-07-26T10:00:00.000Z"),
      temporaryRoot: root
    });

    expect(drill.readiness.ok).toBe(true);
    expect(drill.rpoWithinTarget).toBe(false);
  });

  it("requires a locked-down regular key file", () => {
    const root = temporaryDirectory();
    const keyFile = join(root, "backup.key");
    const key = randomBytes(32);
    writeFileSync(keyFile, key, { mode: 0o600 });

    expect(readDatabaseBackupKey(keyFile)).toEqual(key);
    chmodSync(keyFile, 0o640);
    expect(() => readDatabaseBackupKey(keyFile)).toThrow("must not be accessible by group or others");
  });

  it("runs backup, verification, and isolated drill through the operator CLI", async () => {
    const root = temporaryDirectory();
    const source = createPopulatedDatabase(root);
    const backups = join(root, "backups");
    const keyFile = join(root, "backup.key");
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });

    const backup = await runPolicyCli([
      "backup",
      source,
      "--destination",
      backups,
      "--key-file",
      keyFile,
      "--retain",
      "2"
    ]);
    const verified = await runPolicyCli(["verify-latest", backups, "--key-file", keyFile]);
    const drill = await runPolicyCli([
      "drill-latest",
      backups,
      "--key-file",
      keyFile,
      "--max-age-hours",
      "2",
      "--max-rto-seconds",
      "60"
    ]);

    expect(backup).toMatchObject({ ok: true, operation: "managed-backup", retainedBackups: 1 });
    expect(verified).toMatchObject({ ok: true, operation: "managed-backup-verify", readiness: { ok: true } });
    expect(drill).toMatchObject({
      ok: true,
      operation: "managed-restore-drill",
      rpoWithinTarget: true,
      rtoWithinTarget: true,
      readiness: { ok: true }
    });
  });

  function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "acs-database-backup-policy-"));
    temporaryDirectories.push(directory);
    return directory;
  }
});

const execFileAsync = promisify(execFile);

async function runPolicyCli(args: string[]): Promise<Record<string, unknown>> {
  const result = await execFileAsync(process.execPath, [join(process.cwd(), "scripts/db-backup-policy.mjs"), ...args], {
    cwd: process.cwd()
  });
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function createPopulatedDatabase(directory: string): string {
  const path = join(directory, "control.db");
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    applyControlPlaneMigrations(db);
    db.prepare(
      `INSERT INTO actors (id, actor_type, display_name, external_ref, created_at)
       VALUES (?, 'SYSTEM', ?, NULL, ?)`
    ).run("backup-fixture", "Backup fixture", "2026-07-26T00:00:00.000Z");
  } finally {
    db.close();
  }
  return path;
}

function temporaryFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.startsWith(".") && name.endsWith(".tmp"));
}
