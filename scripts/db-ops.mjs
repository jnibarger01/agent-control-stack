#!/usr/bin/env node
import {
  backupControlPlaneDatabase,
  restoreControlPlaneDatabase,
  verifyControlPlaneDatabaseFile
} from "@agent-control-stack/shared";
import { resolve } from "node:path";

const [command, sourceArg, destinationArg, ...flags] = process.argv.slice(2);

if (command === "verify" && sourceArg) {
  const database = resolve(sourceArg);
  const health = verifyControlPlaneDatabaseFile(database);
  console.log(JSON.stringify({ ok: true, operation: "verify", database, health }));
} else if (command === "backup" && sourceArg && destinationArg) {
  const result = await backupControlPlaneDatabase(sourceArg, destinationArg);
  console.log(JSON.stringify({ ok: true, operation: "backup", ...result }));
} else if (
  command === "restore" &&
  sourceArg &&
  destinationArg &&
  flags.includes("--replace") &&
  flags.includes("--writers-stopped")
) {
  const result = await restoreControlPlaneDatabase(sourceArg, destinationArg, { writersStopped: true });
  console.log(JSON.stringify({ ok: true, operation: "restore", ...result }));
} else {
  console.error(
    "usage: db-ops.mjs verify <db> | backup <db> <backup> | " + "restore <backup> <db> --replace --writers-stopped"
  );
  process.exitCode = 2;
}
