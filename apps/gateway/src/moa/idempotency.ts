import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { IdempotencyStore } from "@agent-control-stack/moa-orchestrator";

export class SqliteMoaIdempotencyStore implements IdempotencyStore {
  constructor(private readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  async get(key: string): Promise<unknown | undefined> {
    const db = this.open();
    try {
      const row = db.prepare(`SELECT response_json FROM moa_idempotency WHERE key = ?`).get(key) as
        | { response_json: string }
        | undefined;
      return row ? JSON.parse(row.response_json) : undefined;
    } finally {
      db.close();
    }
  }

  async put(key: string, value: unknown): Promise<void> {
    const db = this.open();
    try {
      db
        .prepare(
          `INSERT INTO moa_idempotency (key, response_json, created_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO NOTHING`
        )
        .run(key, JSON.stringify(value), new Date().toISOString());
    } finally {
      db.close();
    }
  }

  private open(): DatabaseSync {
    const db = new DatabaseSync(this.dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS moa_idempotency (
        key TEXT PRIMARY KEY,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    return db;
  }
}
