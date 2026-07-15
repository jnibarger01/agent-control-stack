#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const [command, sourceArg, destinationArg, confirmation] = process.argv.slice(2);

if (command === "verify" && sourceArg) {
  verifyDatabase(resolve(sourceArg));
  console.log(JSON.stringify({ ok: true, operation: "verify", database: resolve(sourceArg) }));
} else if (command === "backup" && sourceArg && destinationArg) {
  const source = resolve(sourceArg);
  const destination = resolve(destinationArg);
  verifyDatabase(source);
  if (existsSync(destination)) throw new Error(`backup destination already exists: ${destination}`);
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(db, destination);
  } finally {
    db.close();
  }
  chmodSync(destination, 0o600);
  verifyDatabase(destination);
  console.log(JSON.stringify({ ok: true, operation: "backup", source, destination }));
} else if (command === "restore" && sourceArg && destinationArg && confirmation === "--replace") {
  const source = resolve(sourceArg);
  const destination = resolve(destinationArg);
  verifyDatabase(source);
  const safetyBackup = `${destination}.pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  if (existsSync(destination)) {
    const db = new DatabaseSync(destination, { readOnly: true });
    try {
      await backup(db, safetyBackup);
    } finally {
      db.close();
    }
    chmodSync(safetyBackup, 0o600);
  }
  copyFileSync(source, destination);
  chmodSync(destination, 0o600);
  verifyDatabase(destination);
  console.log(JSON.stringify({ ok: true, operation: "restore", source, destination, safetyBackup }));
} else {
  console.error("usage: db-ops.mjs verify <db> | backup <db> <backup> | restore <backup> <db> --replace");
  process.exitCode = 2;
}

function verifyDatabase(path) {
  if (!existsSync(path)) throw new Error(`database does not exist: ${path}`);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("PRAGMA integrity_check").get();
    if (Object.values(row ?? {})[0] !== "ok") throw new Error(`database integrity check failed: ${path}`);
  } finally {
    db.close();
  }
}
