import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteWorkItemStore } from "./store.js";
import { enqueueWorkItemLifecycleTraceEvent } from "./trace-outbox.js";
import type { CanonicalTraceEvent } from "./trace-event.js";

const dirs: string[] = [];
const transition = { via: "domain_service" as const };

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "acs-trace-lifecycle-"));
  dirs.push(directory);
  const dbPath = join(directory, "control.db");
  const store = new SqliteWorkItemStore(dbPath, {
    traceInstance: "acs-lifecycle-test",
    releaseSha: "unreleased"
  });
  return { directory, dbPath, store };
}

function createItem(store: SqliteWorkItemStore) {
  return store.create({
    title: "secret-free title",
    requester: "agent",
    intent: "sensitive mission text must never enter lifecycle payloads",
    target: { cwd: "/repo" },
    requestedActions: [{ kind: "manual", description: "test" }],
    risk: "medium"
  });
}

function traceRows(dbPath: string, workItemId: string): CanonicalTraceEvent[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (
      db
        .prepare("SELECT canonical_json FROM trace_outbox WHERE work_item_id = ? ORDER BY seq")
        .all(workItemId) as Array<{ canonical_json: string }>
    ).map((row) => JSON.parse(row.canonical_json) as CanonicalTraceEvent);
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Phase 2 canonical work-item lifecycle trace", () => {
  it("records run.received when the authoritative work item is created", () => {
    const { dbPath, store } = fixture();
    try {
      const item = createItem(store);
      const events = traceRows(dbPath, item.id);
      expect(events.map((event) => event.kind)).toEqual(["run.received"]);
      expect(events[0]).toMatchObject({
        class: "authority",
        source: { system: "acs", component: "work-items" },
        subject: { work_item_id: item.id },
        payload: { status: item.status, risk: "medium" }
      });
      expect(JSON.stringify(events[0]?.payload)).not.toContain(item.intent);
    } finally {
      store.close();
    }
  });

  it("reconstructs approval request and grant on one ordered hash chain", () => {
    const { dbPath, store } = fixture();
    try {
      const item = createItem(store);
      store.transition(item.id, "needs_approval", transition);
      store.recordApproval({ workItemId: item.id, actionHash: "hash_phase2", approvedBy: "jace@example.com" });

      const events = traceRows(dbPath, item.id);
      expect(events.map((event) => event.kind)).toEqual([
        "run.received",
        "approval.requested",
        "acs.approval.granted",
        "approval.decided"
      ]);
      expect(events.at(-1)?.payload).toMatchObject({ decision: "approved", status: "granted" });
      const traceIds = new Set(events.map((event) => event.trace_id));
      expect(traceIds.size).toBe(1);
      for (let index = 1; index < events.length; index += 1) {
        const previousCanonical = JSON.stringify(
          Object.fromEntries(Object.entries(events[index - 1]!).sort(([a], [b]) => a.localeCompare(b)))
        );
        void previousCanonical;
        const db = new DatabaseSync(dbPath);
        try {
          const rows = db
            .prepare("SELECT canonical_json FROM trace_outbox WHERE work_item_id = ? ORDER BY seq")
            .all(item.id) as Array<{ canonical_json: string }>;
          expect(events[index]?.prev_hash).toBe(
            createHash("sha256")
              .update(rows[index - 1]!.canonical_json)
              .digest("hex")
          );
        } finally {
          db.close();
        }
      }
    } finally {
      store.close();
    }
  });

  it("records a human rejection as approval.decided without fabricating an approval grant", () => {
    const { dbPath, store } = fixture();
    try {
      const item = createItem(store);
      store.transition(item.id, "needs_approval", transition);
      const rejected = store.rejectWorkItem(item.id, { actor: "human-reviewer", reason: "not approved" }, transition);
      expect(rejected.status).toBe("rejected");

      const events = traceRows(dbPath, item.id);
      expect(events.map((event) => event.kind)).toEqual(["run.received", "approval.requested", "approval.decided"]);
      expect(events.at(-1)?.actor).toEqual({ id: "human-reviewer", type: "human" });
      expect(events.at(-1)?.payload).toMatchObject({ decision: "rejected", status: "rejected" });
      expect(events.some((event) => event.kind === "acs.approval.granted")).toBe(false);
    } finally {
      store.close();
    }
  });

  it("records cancellation as a terminal run.failed lifecycle fact", () => {
    const { dbPath, store } = fixture();
    try {
      const item = createItem(store);
      const cancelled = store.cancelWorkItem(item.id, { actor: "operator", reason: "stop" }, transition);
      expect(cancelled.status).toBe("cancelled");
      const events = traceRows(dbPath, item.id);
      expect(events.map((event) => event.kind)).toEqual(["run.received", "run.failed"]);
      expect(events.at(-1)?.payload).toMatchObject({ outcome: "cancelled", status: "cancelled" });
    } finally {
      store.close();
    }
  });

  it("starts a fresh correlated trace for retry lineage without copying source authority", () => {
    const { dbPath, store } = fixture();
    try {
      const source = createItem(store);
      store.cancelWorkItem(source.id, { actor: "operator", reason: "retry fixture" }, transition);
      const retry = store.retryWorkItem(source.id, { actor: "operator", reason: "try again" });
      const retryEvents = traceRows(dbPath, retry.id);
      expect(retryEvents.map((event) => event.kind)).toEqual(["run.received"]);
      expect(retryEvents[0]?.payload).toMatchObject({
        status: retry.status,
        lineage_type: "retry",
        source_work_item_id: source.id
      });
      expect(retryEvents[0]?.trace_id).not.toBe(traceRows(dbPath, source.id)[0]?.trace_id);
    } finally {
      store.close();
    }
  });

  it("requires a canonical capability id for capability.issued", () => {
    const { dbPath, store } = fixture();
    try {
      const item = createItem(store);
      const db = new DatabaseSync(dbPath);
      try {
        expect(() =>
          enqueueWorkItemLifecycleTraceEvent(db, {
            instance: "acs-lifecycle-test",
            releaseSha: "unreleased",
            workItemId: item.id,
            kind: "capability.issued",
            actorId: "worker_1",
            actorType: "agent",
            payload: { contract: "acs.dc.v1" }
          })
        ).toThrow(/requires a capability id/);
      } finally {
        db.close();
      }
      expect(traceRows(dbPath, item.id).map((event) => event.kind)).toEqual(["run.received"]);
    } finally {
      store.close();
    }
  });

  it("redacts secret-bearing payloads at the generic lifecycle emitter boundary", () => {
    const { dbPath, store } = fixture();
    try {
      const item = createItem(store);
      const db = new DatabaseSync(dbPath);
      try {
        enqueueWorkItemLifecycleTraceEvent(db, {
          instance: "acs-lifecycle-test",
          releaseSha: "unreleased",
          workItemId: item.id,
          kind: "approval.decided",
          actorId: "acs",
          actorType: "system",
          payload: {
            decision: "test",
            token: "secret-token",
            note: "Authorization: Bearer abcdefghijklmnop"
          }
        });
      } finally {
        db.close();
      }
      const serialized = JSON.stringify(traceRows(dbPath, item.id).at(-1));
      expect(serialized).not.toContain("secret-token");
      expect(serialized).not.toContain("abcdefghijklmnop");
      expect(JSON.parse(serialized).payload).toMatchObject({
        decision: "test",
        token: "[redacted]",
        note: "[redacted]"
      });
    } finally {
      store.close();
    }
  });

  it("keeps authoritative creation committed when lifecycle trace enqueue fails", () => {
    const { dbPath, store } = fixture();
    try {
      const db = new DatabaseSync(dbPath);
      try {
        db.exec(`CREATE TRIGGER lifecycle_trace_boom BEFORE INSERT ON trace_outbox
                 BEGIN SELECT RAISE(ABORT, 'trace unavailable'); END`);
      } finally {
        db.close();
      }

      const item = createItem(store);
      expect(store.get(item.id)?.id).toBe(item.id);
      expect(store.readEvents({ workItemId: item.id }).map((event) => event.name)).toContain("work_item.created");
      expect(store.getTraceEnqueueFailureCount()).toBe(1);
      expect(traceRows(dbPath, item.id)).toEqual([]);
    } finally {
      store.close();
    }
  });
});
