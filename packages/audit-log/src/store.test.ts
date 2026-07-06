import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createEvent } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import { SqliteAuditLog } from "./store.js";

describe("sqlite audit log", () => {
  it("hash-chains events and detects tampering", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-audit-log-"));
    const dbPath = join(dir, "audit.db");
    const log = new SqliteAuditLog(dbPath);

    try {
      log.append(createEvent("test.one", { value: "one" }));
      log.append(createEvent("test.two", { value: "two" }));

      expect(log.verifyChain()).toMatchObject({ ok: true, eventCount: 2 });
      log.close();

      const db = new DatabaseSync(dbPath);
      try {
        db.prepare(`UPDATE audit_events SET body = ? WHERE sequence = 1`).run(JSON.stringify({ value: "changed" }));
      } finally {
        db.close();
      }

      const reopened = new SqliteAuditLog(dbPath);
      try {
        expect(reopened.verifyChain()).toMatchObject({
          ok: false,
          failure: { sequence: 1, reason: "event_hash_mismatch" }
        });
      } finally {
        reopened.close();
      }
    } finally {
      try {
        log.close();
      } catch {
        // already closed for the tamper check
      }
    }
  });
});
