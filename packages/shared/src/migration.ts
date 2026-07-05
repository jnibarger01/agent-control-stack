import { readFileSync } from "node:fs";

export function controlPlaneMigrationSql(): string {
  return readFileSync(new URL("../../../storage/migrations/001_audit_log.sql", import.meta.url), "utf8");
}
