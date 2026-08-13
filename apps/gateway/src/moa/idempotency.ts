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
      if (!row || row.response_json === "PENDING") {
        return undefined;
      }
      return JSON.parse(row.response_json);
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
           ON CONFLICT(key) DO UPDATE SET response_json = excluded.response_json`
        )
        .run(key, JSON.stringify(value), new Date().toISOString());
    } finally {
      db.close();
    }
  }

  async tryReserve(key: string): Promise<{ reserved: boolean; existing?: unknown }> {
    const db = this.open();
    try {
      const row = db.prepare(`SELECT response_json FROM moa_idempotency WHERE key = ?`).get(key) as
        | { response_json: string }
        | undefined;

      if (row) {
        if (row.response_json === "PENDING") {
          // Another request reserved this key and is processing.
          // Poll briefly for the pending creation to complete.
          db.close();
          for (let i = 0; i < 30; i++) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            const freshDb = this.open();
            try {
              const freshRow = freshDb.prepare(`SELECT response_json FROM moa_idempotency WHERE key = ?`).get(key) as
                | { response_json: string }
                | undefined;
              if (freshRow && freshRow.response_json !== "PENDING") {
                return { reserved: false, existing: JSON.parse(freshRow.response_json) };
              }
            } finally {
              freshDb.close();
            }
          }
          return { reserved: false };
        }
        return { reserved: false, existing: JSON.parse(row.response_json) };
      }

      // Try atomic insert of PENDING reservation
      try {
        db.prepare(
          `INSERT INTO moa_idempotency (key, response_json, created_at)
           VALUES (?, 'PENDING', ?)`
        ).run(key, new Date().toISOString());
        return { reserved: true };
      } catch {
        // Unique constraint failed - another request inserted first
        const retryRow = db.prepare(`SELECT response_json FROM moa_idempotency WHERE key = ?`).get(key) as
          | { response_json: string }
          | undefined;
        if (retryRow && retryRow.response_json !== "PENDING") {
          return { reserved: false, existing: JSON.parse(retryRow.response_json) };
        }
        return { reserved: false };
      }
    } finally {
      db.close();
    }
  }

  async remove(key: string): Promise<void> {
    const db = this.open();
    try {
      db.prepare(`DELETE FROM moa_idempotency WHERE key = ?`).run(key);
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
