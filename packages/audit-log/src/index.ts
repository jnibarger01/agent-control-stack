import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { auditEventSchema, type AuditEvent } from "@agent-control-stack/shared";

export interface StoredAuditEvent extends AuditEvent {
  sequence: number;
}

interface EventRow {
  sequence: number;
  id: string;
  name: string;
  time_unix_nano: string;
  attributes: string;
  body: string;
}

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
        body TEXT NOT NULL
      );
    `);
  }

  append(event: AuditEvent): StoredAuditEvent {
    const parsed = auditEventSchema.parse(event);
    this.db
      .prepare(
        `INSERT INTO audit_events (id, name, time_unix_nano, attributes, body)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        parsed.id,
        parsed.name,
        parsed.timeUnixNano,
        JSON.stringify(parsed.attributes),
        JSON.stringify(parsed.body)
      );

    return this.findById(parsed.id);
  }

  readEvents(): StoredAuditEvent[] {
    return (this.db.prepare(`SELECT * FROM audit_events ORDER BY sequence ASC`).all() as unknown as EventRow[]).map(
      rowToEvent
    );
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
}

function rowToEvent(row: EventRow): StoredAuditEvent {
  return {
    sequence: row.sequence,
    id: row.id,
    name: row.name,
    timeUnixNano: row.time_unix_nano,
    attributes: JSON.parse(row.attributes) as StoredAuditEvent["attributes"],
    body: JSON.parse(row.body) as StoredAuditEvent["body"]
  };
}
