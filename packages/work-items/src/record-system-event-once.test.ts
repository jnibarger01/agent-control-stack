import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteWorkItemStore } from "./store.js";

let dir: string;
let path: string;
let store: SqliteWorkItemStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "acs-event-once-"));
  path = join(dir, "control.db");
  store = new SqliteWorkItemStore(path);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("recordSystemEventOnce", () => {
  it("appends the first event for a key and returns the stored one for every later claim, across connections", () => {
    const first = store.recordSystemEventOnce({
      name: "test.slot",
      uniqueAttribute: "test.slot_key",
      body: { n: 1 },
      attributes: { "test.slot_key": "a#1" }
    });
    expect(first.recorded).toBe(true);

    const other = new SqliteWorkItemStore(path);
    try {
      const second = other.recordSystemEventOnce({
        name: "test.slot",
        uniqueAttribute: "test.slot_key",
        body: { n: 2 },
        attributes: { "test.slot_key": "a#1" }
      });
      expect(second.recorded).toBe(false);
      expect(second.event.id).toBe(first.event.id);
      expect(second.event.body).toEqual({ n: 1 });
    } finally {
      other.close();
    }

    const otherKey = store.recordSystemEventOnce({
      name: "test.slot",
      uniqueAttribute: "test.slot_key",
      attributes: { "test.slot_key": "a#2" }
    });
    expect(otherKey.recorded).toBe(true);
    expect(store.readEvents({ name: "test.slot" })).toHaveLength(2);
    expect(store.verifyAuditChain().ok).toBe(true);
  });

  it("refuses a missing or malformed unique attribute", () => {
    expect(() => store.recordSystemEventOnce({ name: "test.slot", uniqueAttribute: "k", attributes: {} })).toThrow(
      /unique attribute/u
    );
    expect(() =>
      store.recordSystemEventOnce({ name: "test.slot", uniqueAttribute: 'k"]', attributes: { 'k"]': "x" } })
    ).toThrow(/dotted identifier/u);
  });
});
