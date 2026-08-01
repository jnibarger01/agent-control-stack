import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyControlPlaneMigrations, stableHash } from "@agent-control-stack/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  invalidateMemory,
  searchMemory,
  verifyMemorySource,
  writeMemory,
  type MemoryRecord
} from "./index.js";

describe("source-backed temporal memory", () => {
  const paths: string[] = [];
  afterEach(() => paths.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

  function db(): DatabaseSync {
    const directory = mkdtempSync(join(tmpdir(), "acs-memory-"));
    paths.push(directory);
    const database = new DatabaseSync(join(directory, "memory.db"));
    applyControlPlaneMigrations(database);
    return database;
  }

  function input(overrides: Partial<MemoryRecord> = {}) {
    return {
      claim: "gateway runs on loopback",
      sourceType: "file" as const,
      sourceId: "README.md:1",
      sourceHash: stableHash("gateway runs on loopback"),
      validFrom: "2026-01-01T00:00:00.000Z",
      confidence: 0.9,
      tags: ["gateway", "network"],
      ...overrides
    };
  }

  it("requires a source and persists immutable, cited records", () => {
    const database = db();
    const record = writeMemory(database, input());
    expect(record.sourceId).toBe("README.md:1");
    expect(verifyMemorySource(record, "gateway runs on loopback")).toBe(true);
    expect(verifyMemorySource(record, "tampered source")).toBe(false);
    expect(() => writeMemory(database, { ...input(), sourceHash: "0".repeat(63) })).toThrow();
  });

  it("searches current records, flags conflicting sources, and expires records", () => {
    const database = db();
    writeMemory(database, input());
    writeMemory(database, input({ sourceId: "audit-2", sourceHash: stableHash("different evidence") }));
    writeMemory(database, input({ claim: "old claim", validUntil: "2025-01-01T00:00:00.000Z" }));
    const results = searchMemory(database, "gateway", { asOf: "2026-02-01T00:00:00.000Z" });
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.conflicted)).toBe(true);
    expect(searchMemory(database, "old claim", { asOf: "2026-02-01T00:00:00.000Z" })).toHaveLength(0);
    expect(searchMemory(database, "gateway", { asOf: "2026-02-01T00:00:00.000Z", tags: ["network"] })).toHaveLength(2);
  });

  it("invalidates without deleting history", () => {
    const database = db();
    const record = writeMemory(database, input());
    const invalidated = invalidateMemory(database, record.id, "2026-01-10T00:00:00.000Z");
    expect(invalidated.invalidatedAt).toBe("2026-01-10T00:00:00.000Z");
    expect(searchMemory(database, "gateway", { asOf: "2026-01-11T00:00:00.000Z" })).toHaveLength(0);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM memory_records WHERE id = ?`).get(record.id)).toEqual({ count: 1 });
  });
});
