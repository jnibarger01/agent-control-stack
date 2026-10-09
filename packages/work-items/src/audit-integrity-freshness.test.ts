import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { SqliteWorkItemStore } from "./store.js";

function createSeed(store: SqliteWorkItemStore, title: string) {
  return store.create({ title, requester: "user", intent: "audit freshness test", requestedActions: [], risk: "low" });
}

function tamperFirstAuditEvent(db: DatabaseSync): void {
  const row = db.prepare("SELECT sequence FROM audit_events ORDER BY sequence ASC LIMIT 1").get() as
    { sequence: number } | undefined;
  if (!row) throw new Error("missing audit event to tamper");
  db.prepare("UPDATE audit_events SET body = ? WHERE sequence = ?").run('{"tampered":true}', row.sequence);
}

describe("audit-chain freshness before store writes", () => {
  it("rejects a sensitive write after post-startup audit-history tampering from another SQLite connection", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-audit-freshness-corrupt-"));
    const path = join(dir, "control.db");
    const store = new SqliteWorkItemStore(path);
    try {
      createSeed(store, "before corruption");
      const connection = new DatabaseSync(path);
      try {
        tamperFirstAuditEvent(connection);
        const before = connection.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number };

        // The old cache still says OK, which must never authorize a new write.
        expect(store.readinessHealth().checks.auditChain.ok).toBe(true);
        expect(() => createSeed(store, "must never commit")).toThrowError(/audit integrity is stale or invalid/);
        expect(store.readinessHealth().checks.auditChain).toEqual({ ok: false, code: "audit_chain_invalid" });
        const after = connection.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number };
        const rejected = connection
          .prepare("SELECT COUNT(*) AS count FROM work_items WHERE title = ?")
          .get("must never commit") as { count: number };
        expect(after.count).toBe(before.count);
        expect(rejected.count).toBe(0);
        expect(() => createSeed(store, "still blocked")).toThrowError(/audit chain is invalid/);
      } finally {
        connection.close();
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects policy-authorized approval after post-startup corruption without changing state or audit events", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-audit-freshness-approval-"));
    const path = join(dir, "control.db");
    const store = new SqliteWorkItemStore(path);
    try {
      const workItem = createSeed(store, "pending approval before corruption");
      expect(store.get(workItem.id)?.status).toBe("pending_policy");
      const connection = new DatabaseSync(path);
      try {
        tamperFirstAuditEvent(connection);
        const before = connection.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number };
        expect(() => store.approveWorkItem(workItem.id, { via: "domain_service" })).toThrowError(
          /audit integrity is stale or invalid/
        );
        expect(store.get(workItem.id)?.status).toBe("pending_policy");
        const after = connection.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number };
        expect(after.count).toBe(before.count);
        expect(store.readinessHealth().checks.auditChain.ok).toBe(false);
      } finally {
        connection.close();
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts legitimate commits from other connections after verifying their audit chain", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-audit-freshness-concurrent-"));
    const path = join(dir, "control.db");
    const first = new SqliteWorkItemStore(path);
    try {
      createSeed(first, "initial");
      const second = new SqliteWorkItemStore(path);
      try {
        createSeed(second, "second connection");
        expect(() => createSeed(first, "first connection again")).not.toThrow();
        expect(first.verifyAuditChain().ok).toBe(true);
        expect(first.readinessHealth().checks.auditChain.ok).toBe(true);
      } finally {
        second.close();
      }
    } finally {
      first.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces bounded freshness even when the same connection changes audit history", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-audit-freshness-age-"));
    const path = join(dir, "control.db");
    const store = new SqliteWorkItemStore(path);
    try {
      createSeed(store, "before same-connection tampering");
      // A same-connection write does not increment PRAGMA data_version.
      // A bounded verification age is therefore a second necessary guard.
      const rawDb = (store as unknown as { db: DatabaseSync }).db;
      tamperFirstAuditEvent(rawDb);
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now + 31_000);
      try {
        expect(() => createSeed(store, "expired-integrity-check")).toThrowError(/audit integrity is stale or invalid/);
      } finally {
        clock.mockRestore();
      }
      expect(store.verifyAuditChain().ok).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
