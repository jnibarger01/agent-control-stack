import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  auditEventHash,
  auditEventSchema,
  verifyAuditChain,
  type AuditChainVerification,
  type AuditEvent
} from "@agent-control-stack/shared";
import { type EventRow, type StoredAuditEvent, rowToEvent } from "./event.js";

export class SqliteAuditLog {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        time_unix_nano TEXT NOT NULL,
        attributes TEXT NOT NULL,
        body TEXT NOT NULL,
        previous_hash TEXT NOT NULL DEFAULT '',
        event_hash TEXT NOT NULL DEFAULT ''
      );
    `);
    this.ensureAuditColumn("previous_hash", "previous_hash TEXT NOT NULL DEFAULT ''");
    this.ensureAuditColumn("event_hash", "event_hash TEXT NOT NULL DEFAULT ''");
    this.backfillAuditChain();
  }

  append(event: AuditEvent): StoredAuditEvent {
    const parsed = auditEventSchema.parse(event);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previousHash = this.latestAuditHash();
      this.db
        .prepare(
          `INSERT INTO audit_events (id, name, time_unix_nano, attributes, body, previous_hash, event_hash)
           VALUES (?, ?, ?, ?, ?, ?, '')`
        )
        .run(
          parsed.id,
          parsed.name,
          parsed.timeUnixNano,
          JSON.stringify(parsed.attributes),
          JSON.stringify(parsed.body),
          previousHash
        );
      const inserted = this.findById(parsed.id);
      this.db
        .prepare(`UPDATE audit_events SET event_hash = ? WHERE sequence = ?`)
        .run(auditEventHash(inserted), inserted.sequence);
      this.db.exec("COMMIT");
      return this.findById(parsed.id);
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // best effort; SQLite may have already closed the transaction.
      }
      throw error;
    }
  }

  readEvents(): StoredAuditEvent[] {
    return (this.db.prepare(`SELECT * FROM audit_events ORDER BY sequence ASC`).all() as unknown as EventRow[]).map(
      rowToEvent
    );
  }

  verifyChain(): AuditChainVerification {
    return verifyAuditChain(this.readEvents());
  }

  close(): void {
    this.db.close();
  }

  private findById(id: string): StoredAuditEvent {
    const row = this.db.prepare(`SELECT * FROM audit_events WHERE id = ?`).get(id) as unknown as EventRow | undefined;
    if (!row) {
      throw new Error(`audit event not found: ${id}`);
    }
    return rowToEvent(row);
  }

  private latestAuditHash(): string {
    const row = this.db
      .prepare(`SELECT event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1`)
      .get() as { event_hash: string } | undefined;
    return row?.event_hash ?? "";
  }

  private backfillAuditChain(): void {
    const rows = this.db.prepare(`SELECT * FROM audit_events ORDER BY sequence ASC`).all() as unknown as EventRow[];
    let previousHash = "";
    for (const row of rows) {
      const eventHash = row.event_hash || auditEventHash(rowToEvent({ ...row, previous_hash: previousHash }));
      if (!row.event_hash) {
        this.db
          .prepare(`UPDATE audit_events SET previous_hash = ?, event_hash = ? WHERE sequence = ?`)
          .run(previousHash, eventHash, row.sequence);
      }
      previousHash = eventHash;
    }
  }

  private ensureAuditColumn(name: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(audit_events)`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      this.db.exec(`ALTER TABLE audit_events ADD COLUMN ${definition}`);
    }
  }
}
