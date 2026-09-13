import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { auditEventHash } from "./audit-chain.js";
import {
  exportAuditChainJsonlFromDatabaseFile,
  formatAuditChainJsonl,
  parseAuditChainJsonl,
  verifyAuditChainFromDatabaseFile,
  verifyAuditChainJsonl
} from "./audit-export.js";
import { applyControlPlaneMigrations } from "./migration.js";

describe("audit-chain JSONL export", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("round-trips export + verify on a fixture database", () => {
    const path = createFixtureDatabase();
    const jsonl = exportAuditChainJsonlFromDatabaseFile(path);

    expect(jsonl.split("\n").filter((line) => line.length > 0)).toHaveLength(2);
    expect(verifyAuditChainFromDatabaseFile(path)).toMatchObject({ ok: true, eventCount: 2 });
    expect(verifyAuditChainJsonl(jsonl)).toMatchObject({
      ok: true,
      eventCount: 2,
      headHash: expect.stringMatching(/^[a-f0-9]{64}$/)
    });

    const parsed = parseAuditChainJsonl(jsonl);
    expect(parsed.map((event) => event.sequence)).toEqual([1, 2]);
    expect(parsed[0]?.previousHash).toBe("");
    expect(parsed[1]?.previousHash).toBe(parsed[0]?.eventHash);
    expect(formatAuditChainJsonl(parsed)).toBe(jsonl);
  });

  it("detects tampering in exported JSONL", () => {
    const path = createFixtureDatabase();
    const jsonl = exportAuditChainJsonlFromDatabaseFile(path);
    const lines = jsonl.trimEnd().split("\n");
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    first.body = { sequence: 1, tampered: true };
    const tampered = `${JSON.stringify(first)}\n${lines[1]}\n`;

    expect(verifyAuditChainJsonl(tampered)).toMatchObject({
      ok: false,
      failure: { sequence: 1, reason: "event_hash_mismatch" }
    });
  });

  it("rejects malformed JSONL", () => {
    expect(() => parseAuditChainJsonl("{not-json\n")).toThrow(/not JSON/);
    expect(() => parseAuditChainJsonl('{"sequence":0,"id":"x"}\n')).toThrow(/sequence/);
  });

  function createFixtureDatabase(): string {
    const directory = mkdtempSync(join(tmpdir(), "acs-audit-export-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "fixture.db");
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      applyControlPlaneMigrations(db);
      const first = auditFixture(1, "");
      const second = auditFixture(2, first.eventHash);
      insertAuditEvent(db, first);
      insertAuditEvent(db, second);
    } finally {
      db.close();
    }
    return path;
  }
});

function auditFixture(sequence: number, previousHash: string) {
  const event = {
    sequence,
    id: `evt_${sequence}`,
    name: "test.event",
    timeUnixNano: String(1_000_000_000 + sequence),
    attributes: { "work_item.id": `wi_${sequence}` },
    body: { sequence, note: "fixture" },
    previousHash
  };
  return { ...event, eventHash: auditEventHash(event) };
}

function insertAuditEvent(db: DatabaseSync, event: ReturnType<typeof auditFixture>): void {
  db.prepare(
    `INSERT INTO audit_events
     (sequence, id, name, time_unix_nano, attributes, body, previous_hash, event_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event.sequence,
    event.id,
    event.name,
    event.timeUnixNano,
    JSON.stringify(event.attributes),
    JSON.stringify(event.body),
    event.previousHash,
    event.eventHash
  );
}
