import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WORK_ITEM_LIST_LIMIT,
  MAX_WORK_ITEM_LIST_LIMIT,
  SqliteWorkItemStore,
  clampWorkItemListLimit,
  listWorkItemsSchema
} from "./index.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function openStore(): SqliteWorkItemStore {
  const dir = mkdtempSync(join(tmpdir(), "acs-list-limit-"));
  dirs.push(dir);
  return new SqliteWorkItemStore(join(dir, "control.db"));
}

function seed(store: SqliteWorkItemStore, count: number): void {
  for (let index = 0; index < count; index += 1) {
    store.create({
      title: `Item ${index}`,
      requester: "user",
      intent: `seed item ${index}`,
      target: {},
      requestedActions: [{ kind: "manual", description: "seed" }],
      risk: "low"
    });
  }
}

type StoreDb = {
  prepare: (sql: string) => { run: (...args: unknown[]) => unknown };
  exec: (sql: string) => void;
};

/**
 * Bulk-insert rows past the list cap without per-row create()+audit.
 * Keeps the oversize-limit acceptance test cheap under CI load.
 */
function seedPastCap(store: SqliteWorkItemStore, count: number): void {
  const db = (store as unknown as { db: StoreDb }).db;
  const insert = db.prepare(
    `INSERT INTO work_items
     (id, title, requester, requester_subject, status, intent, target_json, requested_actions_json, risk, result_json, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
  );
  const now = new Date().toISOString();
  const targetJson = "{}";
  const actionsJson = JSON.stringify([{ kind: "manual", description: "seed" }]);
  db.exec("BEGIN");
  try {
    for (let index = 0; index < count; index += 1) {
      insert.run(
        `wrk_seed_${String(index).padStart(4, "0")}`,
        `Item ${index}`,
        "user",
        null,
        "pending_policy",
        `seed item ${index}`,
        targetJson,
        actionsJson,
        "low",
        null,
        now,
        now
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

describe("list work-item page-size cap", () => {
  it("documents DEFAULT and MAX constants for the public contract", () => {
    expect(DEFAULT_WORK_ITEM_LIST_LIMIT).toBe(100);
    expect(MAX_WORK_ITEM_LIST_LIMIT).toBe(500);
    expect(DEFAULT_WORK_ITEM_LIST_LIMIT).toBeLessThanOrEqual(MAX_WORK_ITEM_LIST_LIMIT);
  });

  it("clamps oversize positive integers and leaves invalid values for Zod", () => {
    expect(clampWorkItemListLimit(MAX_WORK_ITEM_LIST_LIMIT + 50)).toBe(MAX_WORK_ITEM_LIST_LIMIT);
    expect(clampWorkItemListLimit(String(MAX_WORK_ITEM_LIST_LIMIT + 1))).toBe(MAX_WORK_ITEM_LIST_LIMIT);
    expect(clampWorkItemListLimit(10)).toBe(10);
    expect(clampWorkItemListLimit(undefined)).toBeUndefined();
    expect(clampWorkItemListLimit("abc")).toBe("abc");
    expect(clampWorkItemListLimit(0)).toBe(0);
  });

  it("parses oversize limit by clamping without throwing", () => {
    expect(listWorkItemsSchema.parse({ limit: MAX_WORK_ITEM_LIST_LIMIT + 999 })).toEqual({
      limit: MAX_WORK_ITEM_LIST_LIMIT
    });
    expect(listWorkItemsSchema.parse({ limit: "9000" })).toEqual({ limit: MAX_WORK_ITEM_LIST_LIMIT });
    expect(() => listWorkItemsSchema.parse({ limit: 0 })).toThrow();
    expect(() => listWorkItemsSchema.parse({ limit: -1 })).toThrow();
    expect(() => listWorkItemsSchema.parse({ limit: "nope" })).toThrow();
  });

  it(
    "never returns more than the cap when limit is oversize",
    () => {
      const store = openStore();
      try {
        // One past the cap is enough to prove clamping; bulk seed avoids
        // 500+ create()+audit round-trips that flake under CI within 5s.
        seedPastCap(store, MAX_WORK_ITEM_LIST_LIMIT + 1);
        const listed = store.list({ limit: MAX_WORK_ITEM_LIST_LIMIT + 1000 });
        expect(listed).toHaveLength(MAX_WORK_ITEM_LIST_LIMIT);
      } finally {
        store.close();
      }
    },
    20_000
  );

  it("omitted limit still returns the full set for internal callers", () => {
    const store = openStore();
    try {
      seed(store, 3);
      expect(store.list()).toHaveLength(3);
      expect(store.list({})).toHaveLength(3);
    } finally {
      store.close();
    }
  });
});
