import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { auditEventHash } from "@agent-control-stack/shared";
import { SqliteWorkItemStore } from "./store.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "acs-mission-trace-"));
  const path = join(dir, "db.sqlite");
  const store = new SqliteWorkItemStore(path, { traceInstance: "trace-test", releaseSha: "a".repeat(40) });
  const mission = store.create({
    title: "Trace",
    intent: "inspect",
    requester: "agent",
    risk: "low",
    requestedActions: [{ kind: "fs.read", description: "read", params: {} }]
  });
  return {
    dir,
    path,
    store,
    mission,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe("mission audit projection", () => {
  it("pages oldest-first without losing evidence amid unrelated traffic or inventing global verification", () => {
    const ctx = fixture();
    try {
      const unrelated = ctx.store.create({ ...ctx.mission, title: "unrelated" });
      ctx.store.withTransaction(() => {
        for (let index = 0; index < 220; index++) {
          ctx.store.recordSystemEvent({ name: "test.unrelated", attributes: { "work_item.id": unrelated.id } });
          ctx.store.recordSystemEvent({ name: "test.mission", attributes: { "work_item.id": ctx.mission.id } });
        }
      });
      const ids: string[] = [];
      let cursor = 0;
      do {
        const page = ctx.store.getMissionTrace(ctx.mission.id, { afterSequence: cursor, limit: 7 });
        expect(page.globalChainVerified).toBe(false);
        expect(page.events.every((entry) => entry.correlation.missionId === ctx.mission.id)).toBe(true);
        expect(page.events.some((entry) => entry.event.name === "test.unrelated")).toBe(false);
        ids.push(...page.events.map((entry) => entry.event.id));
        cursor = page.nextAfterSequence ?? 0;
      } while (cursor);
      expect(ids).toHaveLength(221);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ctx.store.verifyAuditChain().ok).toBe(true);
    } finally {
      ctx.close();
    }
  });

  it("injects producer identity rather than trusting caller metadata and retains old release attribution on reopen", () => {
    const ctx = fixture();
    try {
      ctx.store.recordSystemEvent({
        name: "test.producer",
        attributes: { "work_item.id": ctx.mission.id, "acs.process.id": "forged", "acs.release_sha": "forged" }
      });
      const before = ctx.store.getMissionTrace(ctx.mission.id).events;
      expect(before[1]!.producer["acs.process.id"]).not.toBe("forged");
      expect(before[1]!.producer["acs.release_sha"]).toBe("a".repeat(40));
      const reopened = new SqliteWorkItemStore(ctx.path, { traceInstance: "new-instance", releaseSha: "b".repeat(40) });
      try {
        reopened.recordSystemEvent({ name: "test.new-release", attributes: { "work_item.id": ctx.mission.id } });
        const events = reopened.getMissionTrace(ctx.mission.id).events;
        expect(events.slice(0, 2)).toEqual(before);
        expect(events[2]!.producer["acs.release_sha"]).toBe("b".repeat(40));
        expect(events[2]!.producer["acs.instance"]).toBe("new-instance");
      } finally {
        reopened.close();
      }
    } finally {
      ctx.close();
    }
  });

  it.each(["selected event", "predecessor"])("fails closed on %s audit tampering", (scenario) => {
    const ctx = fixture();
    try {
      ctx.store.recordSystemEvent({ name: "test.unrelated", attributes: {} });
      ctx.store.recordSystemEvent({ name: "test.mission", attributes: { "work_item.id": ctx.mission.id } });
      const db = new DatabaseSync(ctx.path);
      try {
        db.prepare("UPDATE audit_events SET body = ? WHERE name = ?").run(
          '{"tampered":true}',
          scenario === "selected event" ? "test.mission" : "test.unrelated"
        );
      } finally {
        db.close();
      }
      expect(() => ctx.store.getMissionTrace(ctx.mission.id, { afterSequence: 1 })).toThrow("audit event invalid");
    } finally {
      ctx.close();
    }
  });

  it("reports legacy producer metadata as unknown without rewriting historical events", () => {
    const ctx = fixture();
    try {
      const original = ctx.store.readEvents()[0]!;
      const attributes = { ...original.attributes };
      for (const key of Object.keys(attributes).filter((key) => key.startsWith("acs."))) delete attributes[key];
      const historical = { ...original, attributes };
      const db = new DatabaseSync(ctx.path);
      try {
        db.prepare("UPDATE audit_events SET attributes = ?, event_hash = ? WHERE id = ?").run(
          JSON.stringify(attributes),
          auditEventHash(historical),
          original.id
        );
      } finally {
        db.close();
      }
      const trace = ctx.store.getMissionTrace(ctx.mission.id);
      expect(Object.values(trace.events[0]!.producer)).toEqual(["unknown", "unknown", "unknown", "unknown"]);
      expect(trace.events[0]!.event.attributes).toEqual(attributes);
      expect(ctx.store.verifyAuditChain().ok).toBe(true);
    } finally {
      ctx.close();
    }
  });

  it("bounds input and rejects unknown missions", () => {
    const ctx = fixture();
    try {
      expect(() => ctx.store.getMissionTrace(ctx.mission.id, { limit: 201 })).toThrow();
      expect(() => ctx.store.getMissionTrace(ctx.mission.id, { afterSequence: -1 })).toThrow();
      expect(() => ctx.store.getMissionTrace("missing")).toThrow("mission not found");
    } finally {
      ctx.close();
    }
  });
});
