import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteWorkItemStore } from "./store.js";

let dir: string;
let dbPath: string;
let store: SqliteWorkItemStore;
let workItemId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "acs-exec-audit-"));
  dbPath = join(dir, "control.db");
  store = new SqliteWorkItemStore(dbPath);
  workItemId = store.create({
    title: "audit fixture",
    requester: "user",
    intent: "record execution audit evidence",
    requestedActions: [{ kind: "fs.read", description: "inspect" }],
    risk: "low"
  }).id;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("recordExecutionEvent", () => {
  it("appends a namespaced execution event to the canonical hash chain", () => {
    const event = store.recordExecutionEvent({
      name: "desktop_commander.tool_called",
      workItemId,
      body: { toolName: "read_file", invocationFingerprint: "f".repeat(64) },
      attributes: { "desktop_commander.tool": "read_file" }
    });
    expect(event.name).toBe("desktop_commander.tool_called");
    expect(event.attributes["work_item.id"]).toBe(workItemId);
    expect(event.body.toolName).toBe("read_file");

    const names = store.readEvents({ limit: 100, workItemId }).map((e) => e.name);
    expect(names).toContain("desktop_commander.tool_called");
    expect(store.verifyAuditChain().ok).toBe(true);
  });

  it("fails closed on an event name outside the execution.* / desktop_commander.* namespace", () => {
    expect(() => store.recordExecutionEvent({ name: "work_item.succeeded", workItemId, body: {} })).toThrow(
      /only accepts execution\.\* \/ desktop_commander\.\* events/
    );
    expect(() => store.recordExecutionEvent({ name: "arbitrary.event", workItemId })).toThrow(/only accepts/);
  });

  it("requires a work item id", () => {
    expect(() => store.recordExecutionEvent({ name: "execution.completed", workItemId: "  " })).toThrow();
  });
});
