#!/usr/bin/env node
import {
  createManagedDatabaseBackup,
  latestManagedBackupManifest,
  readDatabaseBackupKey,
  runManagedDatabaseRestoreDrill,
  verifyManagedDatabaseBackup
} from "@agent-control-stack/shared";

const [command, target, ...args] = process.argv.slice(2);

try {
  if (command === "backup" && target) {
    const key = readDatabaseBackupKey(requiredFlag(args, "--key-file"));
    const result = await createManagedDatabaseBackup(target, requiredFlag(args, "--destination"), {
      encryptionKey: key,
      retentionCount: positiveIntegerFlag(args, "--retain")
    });
    report({
      ok: true,
      operation: "managed-backup",
      backupId: result.manifest.backupId,
      manifest: result.manifestPath,
      artifact: result.artifactPath,
      retainedBackups: result.retainedBackups
    });
  } else if ((command === "verify" || command === "verify-latest") && target) {
    const key = readDatabaseBackupKey(requiredFlag(args, "--key-file"));
    const manifest = command === "verify" ? target : latestManagedBackupManifest(target);
    const result = await verifyManagedDatabaseBackup(manifest, key);
    report({
      ok: true,
      operation: "managed-backup-verify",
      backupId: result.manifest.backupId,
      manifest,
      readiness: result.health
    });
  } else if ((command === "drill" || command === "drill-latest") && target) {
    const key = readDatabaseBackupKey(requiredFlag(args, "--key-file"));
    const manifest = command === "drill" ? target : latestManagedBackupManifest(target);
    const result = await runManagedDatabaseRestoreDrill(manifest, {
      encryptionKey: key,
      maximumBackupAgeMs: positiveNumberFlag(args, "--max-age-hours") * 60 * 60 * 1_000,
      maximumRestoreDurationMs: positiveNumberFlag(args, "--max-rto-seconds") * 1_000
    });
    report({ ok: result.rpoWithinTarget && result.rtoWithinTarget, operation: "managed-restore-drill", ...result });
    if (!result.rpoWithinTarget || !result.rtoWithinTarget) process.exitCode = 1;
  } else {
    usage();
  }
} catch (error) {
  report({
    ok: false,
    operation: command ?? "unknown",
    errorCode: classifyError(error)
  });
  process.exitCode = 1;
}

function requiredFlag(args, name) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`missing required flag: ${name}`);
  return value;
}

function positiveIntegerFlag(args, name) {
  const value = Number(requiredFlag(args, name));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function positiveNumberFlag(args, name) {
  const value = Number(requiredFlag(args, name));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function classifyError(error) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("checksum")) return "backup_checksum_invalid";
  if (message.includes("decryption") || message.includes("encryption key")) return "backup_decryption_failed";
  if (message.includes("manifest")) return "backup_manifest_invalid";
  if (message.includes("health check")) return "backup_database_invalid";
  if (message.includes("key file")) return "backup_key_file_invalid";
  if (message.includes("destination already exists")) return "backup_destination_exists";
  return "backup_operation_failed";
}

function report(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function usage() {
  process.stderr.write(
    "usage: db-backup-policy.mjs backup <db> --destination <dir> --key-file <file> --retain <count> | " +
      "verify <manifest> --key-file <file> | verify-latest <dir> --key-file <file> | " +
      "drill <manifest> --key-file <file> --max-age-hours <hours> --max-rto-seconds <seconds> | " +
      "drill-latest <dir> --key-file <file> --max-age-hours <hours> --max-rto-seconds <seconds>\n"
  );
  process.exitCode = 2;
}
